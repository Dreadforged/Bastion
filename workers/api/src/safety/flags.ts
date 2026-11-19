import { newId, schemas } from "@bastion/shared";
import { HttpError } from "../http.js";

type SafetyModule = schemas.SafetyModule;

const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"];
const EEA_EXTRA = ["IS", "LI", "NO"];

/**
 * Regions to check for a person, most specific first, ending in `default`.
 * `US-TX` style state codes are accepted when a state is known.
 */
export function regionChain(country: string | null, state?: string | null): string[] {
  const chain: string[] = [];
  if (country && schemas.COUNTRY_CODE.test(country)) {
    if (state && /^[A-Z0-9]{1,3}$/.test(state)) chain.push(`${country}-${state}`);
    chain.push(country);
    if (EU.includes(country)) chain.push("EU");
    if (EU.includes(country) || EEA_EXTRA.includes(country)) chain.push("EEA");
  }
  chain.push("default");
  return chain;
}

interface Row {
  module: string;
  region: string;
  enabled: number;
  config: string;
}

export interface ResolvedFlag<M extends SafetyModule> {
  enabled: boolean;
  config: schemas.ModuleConfig<M>;
  /** The region whose rule applied, or `builtin` when nothing was configured. */
  region: string;
}

/**
 * Reads flags with a short cache, so a change made by staff reaches every
 * Worker within `ttlMs` and a database read is not needed per request.
 * Keep one instance at module level in the Worker.
 */
export class FlagReader {
  private rows: Row[] | null = null;
  private loadedAt = 0;

  constructor(
    private readonly db: D1Database,
    private readonly now: () => number,
    private readonly ttlMs = 60_000,
  ) {}

  /** Drop the cache so the next read sees a change made in this isolate. */
  invalidate(): void {
    this.rows = null;
  }

  private async load(): Promise<Row[]> {
    if (this.rows && this.now() - this.loadedAt < this.ttlMs) return this.rows;
    const { results } = await this.db.prepare("SELECT module, region, enabled, config FROM safety_flags").all<Row>();
    this.rows = results;
    this.loadedAt = this.now();
    return results;
  }

  /** The value for a module in the first region of `chain` that has one, else the built in default (enabled, default config). */
  async get<M extends SafetyModule>(module: M, chain: string[]): Promise<ResolvedFlag<M>> {
    const rows = (await this.load()).filter((r) => r.module === module);
    for (const region of chain) {
      const row = rows.find((r) => r.region === region);
      if (!row) continue;
      const parsed = schemas.MODULE_CONFIG[module].safeParse(JSON.parse(row.config));
      // A bad stored config must not turn a safety module off or crash a request: fall back to defaults.
      const config = parsed.success ? parsed.data : schemas.MODULE_CONFIG[module].parse({});
      return { enabled: row.enabled === 1, config: config as schemas.ModuleConfig<M>, region };
    }
    return { enabled: true, config: schemas.MODULE_CONFIG[module].parse({}) as schemas.ModuleConfig<M>, region: "builtin" };
  }
}

/**
 * Set a module's value in a region. Staff only: callers must have checked
 * staff access. Validates the config against the module's schema, writes the
 * flag, the flag history and the staff log in one batch.
 */
export async function setFlag(
  db: D1Database,
  staffId: string,
  module: SafetyModule,
  region: string,
  value: { enabled: boolean; config?: Record<string, unknown> },
  now: number,
): Promise<void> {
  if (!schemas.SafetyModule.safeParse(module).success) throw new HttpError(400, "unknown_module");
  if (!schemas.Region.safeParse(region).success) throw new HttpError(400, "invalid_region");
  const parsed = schemas.MODULE_CONFIG[module].safeParse(value.config ?? {});
  if (!parsed.success) throw new HttpError(400, "invalid_config");
  const config = JSON.stringify(parsed.data);
  const enabled = value.enabled ? 1 : 0;
  await db.batch([
    db
      .prepare(
        `INSERT INTO safety_flags (module, region, enabled, config, updated_by, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT (module, region) DO UPDATE SET enabled = ?3, config = ?4, updated_by = ?5, updated_at = ?6`,
      )
      .bind(module, region, enabled, config, staffId, now),
    db
      .prepare("INSERT INTO safety_flag_log (id, module, region, enabled, config, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(newId(), module, region, enabled, config, staffId, now),
    db
      .prepare("INSERT INTO staff_access_log (id, staff_id, kind, action, subject_type, subject_id, reason_code, at) VALUES (?, ?, 'change', 'flag.set', 'flag', ?, NULL, ?)")
      .bind(newId(), staffId, `${module}:${region}`, now),
  ]);
}
