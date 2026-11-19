import { newId, schemas } from "@bastion/shared";
import { HttpError } from "../http.js";
import { FlagReader, regionChain } from "./flags.js";

/**
 * Age band, country, account state, age signals and terms acceptance.
 *
 * Children may be present whatever the minimum age says, so the design is:
 * ask once, keep only a band that expires, treat later contradictions and
 * reports as evidence, and move doubtful accounts to age review. Nothing
 * here looks at message content.
 */

const SIGNAL_TTL_MS = 180 * 24 * 60 * 60_000;
const BAND_RANK: Record<schemas.AgeBand, number> = { unknown: 0, "13to15": 1, "16to17": 2, "18plus": 3 };

interface UserRow {
  age_band: schemas.AgeBand;
  age_method: schemas.AgeMethod | null;
  age_band_until: number | null;
  country: string | null;
  account_state: schemas.AccountState;
  state_reason: string | null;
}

const USER_COLUMNS = "age_band, age_method, age_band_until, country, account_state, state_reason";

async function loadUser(db: D1Database, userId: string): Promise<UserRow> {
  const row = await db.prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`).bind(userId).first<UserRow>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

function monthIndex(ms: number): number {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

/**
 * Age in whole years, rounded down and assuming the last day of the birth
 * month, so a child is never counted older than they are. A genuine adult
 * can be a month early being told no; that is the safe direction.
 */
export function ageInYears(birthYear: number, birthMonth: number, now: number): number {
  const diff = monthIndex(now) - (birthYear * 12 + (birthMonth - 1));
  if (diff < 0) throw new HttpError(400, "invalid_birth");
  return Math.max(0, Math.floor((diff - 1) / 12));
}

function bandFor(age: number): schemas.AgeBand | null {
  if (age < 13) return null;
  if (age < 16) return "13to15";
  if (age < 18) return "16to17";
  return "18plus";
}

/** First day of the month the person turns `nextAge`, which is when the band stops being right. */
function bandUntil(birthYear: number, birthMonth: number, band: schemas.AgeBand): number | null {
  if (band === "18plus") return null;
  const nextAge = band === "13to15" ? 16 : 18;
  const idx = (birthYear + nextAge) * 12 + (birthMonth - 1) + 1;
  return Date.UTC(Math.floor(idx / 12), idx % 12, 1);
}

async function ageConfig(flags: FlagReader, country: string | null) {
  return flags.get("age", regionChain(country));
}

// ---------------------------------------------------------------- reading

export async function getSafety(db: D1Database, flags: FlagReader, userId: string): Promise<schemas.AccountSafety> {
  const user = await loadUser(db, userId);
  const age = await ageConfig(flags, user.country);
  const legal = await flags.get("legal", regionChain(user.country));
  const accepted = await db
    .prepare("SELECT document, version FROM terms_acceptances WHERE user_id = ?")
    .bind(userId)
    .all<{ document: string; version: string }>();
  const have = new Set(accepted.results.map((r) => `${r.document}:${r.version}`));
  const termsOutstanding = (["terms", "privacy", "aup"] as const)
    .map((document) => ({ document, version: legal.config[document] }))
    .filter((d) => !have.has(`${d.document}:${d.version}`));
  return {
    ageBand: user.age_band,
    ageMethod: user.age_method,
    ageBandUntil: user.age_band_until,
    accountState: user.account_state,
    country: user.country,
    minAge: age.config.minAge,
    ageDeclarationRequired: age.enabled && age.config.requireDeclaration && user.age_band === "unknown",
    termsOutstanding,
  };
}

/** The region-specific values the client needs. Not the rules for other regions. */
export async function getClientConfig(db: D1Database, flags: FlagReader, userId: string): Promise<schemas.SafetyConfig> {
  const user = await loadUser(db, userId);
  const chain = regionChain(user.country);
  const age = await flags.get("age", chain);
  const modules = {} as Record<schemas.SafetyModule, boolean>;
  for (const m of schemas.SafetyModule.options) modules[m] = (await flags.get(m, chain)).enabled;
  return {
    region: chain[0]!,
    minAge: age.config.minAge,
    assurance: age.config.assurance,
    ageRestrictedChannels: age.enabled && age.config.ageRestrictedChannels,
    modules,
  };
}

// ---------------------------------------------------------------- declaring

/**
 * The person states a birth month and year. Only the band survives.
 *  - Under 13: refused, and the account is marked `underage_removed`.
 *  - Younger than a previous declaration: accepted, and counted as a strong
 *    signal, so retrying until the answer is acceptable does not work.
 *  - Older than or equal to a previous declaration: ignored (409), because
 *    raising an age takes a stronger check than asking again.
 *  - Below the region's minimum age: the account becomes `restricted`.
 */
export async function declareAge(
  db: D1Database,
  flags: FlagReader,
  userId: string,
  request: schemas.DeclareAgeRequest,
  observedCountry: string | null,
  now: number,
): Promise<schemas.AccountSafety> {
  const user = await loadUser(db, userId);
  if (schemas.BLOCKED_STATES.includes(user.account_state)) throw new HttpError(403, "account_blocked");

  const age = ageInYears(request.birthYear, request.birthMonth, now);
  const band = bandFor(age);
  if (band === null) {
    await db
      .prepare("UPDATE users SET account_state = 'underage_removed', state_reason = 'underage', state_changed_at = ?1 WHERE id = ?2")
      .bind(now, userId)
      .run();
    throw new HttpError(403, "underage");
  }

  if (user.age_band !== "unknown" && BAND_RANK[band] >= BAND_RANK[user.age_band]) throw new HttpError(409, "already_declared");
  if (user.age_method === "verified") throw new HttpError(409, "already_declared");

  const country = request.country ?? user.country ?? observedCountry;
  const until = bandUntil(request.birthYear, request.birthMonth, band);
  await db
    .prepare("UPDATE users SET age_band = ?1, age_method = 'declared', age_band_until = ?2, age_checked_at = ?3, country = ?4 WHERE id = ?5")
    .bind(band, until, now, country, userId)
    .run();

  if (user.age_band !== "unknown") await recordAgeSignal(db, flags, userId, "declaration_conflict", now);
  if (request.country && observedCountry && request.country !== observedCountry) {
    await recordAgeSignal(db, flags, userId, "country_mismatch", now);
  }
  await applyMinimumAge(db, flags, userId, age, now);
  return getSafety(db, flags, userId);
}

/** Restrict an account below its region's minimum age, and free one that no longer is. */
async function applyMinimumAge(db: D1Database, flags: FlagReader, userId: string, age: number, now: number): Promise<void> {
  const user = await loadUser(db, userId);
  if (schemas.BLOCKED_STATES.includes(user.account_state)) return;
  const cfg = await ageConfig(flags, user.country);
  const tooYoung = cfg.enabled && age < cfg.config.minAge;
  if (tooYoung && user.account_state === "active") {
    await db.prepare("UPDATE users SET account_state = 'restricted', state_reason = 'underage', state_changed_at = ? WHERE id = ?").bind(now, userId).run();
  } else if (!tooYoung && user.account_state === "restricted" && user.state_reason === "underage") {
    await db.prepare("UPDATE users SET account_state = 'active', state_reason = NULL, state_changed_at = ? WHERE id = ?").bind(now, userId).run();
  }
}

// ---------------------------------------------------------------- signals

/**
 * Record why an age might be wrong. When the live signals reach the region's
 * threshold, an active account goes to `pending_age_review`. A verified age
 * is not overridden by signals.
 */
export async function recordAgeSignal(
  db: D1Database,
  flags: FlagReader,
  userId: string,
  kind: schemas.AgeSignalKind,
  now: number,
): Promise<schemas.AccountState> {
  const weight = schemas.AGE_SIGNAL_WEIGHT[kind];
  await db
    .prepare("INSERT INTO age_signals (id, user_id, kind, weight, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId(), userId, kind, weight, now, now + SIGNAL_TTL_MS)
    .run();
  const user = await loadUser(db, userId);
  if (user.account_state !== "active" || user.age_method === "verified") return user.account_state;
  const total = await db
    .prepare("SELECT COALESCE(SUM(weight), 0) AS total FROM age_signals WHERE user_id = ? AND expires_at > ?")
    .bind(userId, now)
    .first<{ total: number }>();
  const cfg = await ageConfig(flags, user.country);
  if (cfg.enabled && (total?.total ?? 0) >= cfg.config.reviewThreshold) {
    await db.prepare("UPDATE users SET account_state = 'pending_age_review', state_reason = 'underage', state_changed_at = ? WHERE id = ?").bind(now, userId).run();
    return "pending_age_review";
  }
  return user.account_state;
}

/**
 * A stronger check (age estimation, the EU age app, a vendor, an app store
 * signal) states the band. Overrides a declaration in either direction and
 * ends an age review.
 */
export async function applyVerifiedAge(
  db: D1Database,
  flags: FlagReader,
  userId: string,
  band: Exclude<schemas.AgeBand, "unknown">,
  until: number | null,
  method: Exclude<schemas.AgeMethod, "declared">,
  now: number,
): Promise<schemas.AccountSafety> {
  const user = await loadUser(db, userId);
  if (schemas.BLOCKED_STATES.includes(user.account_state)) throw new HttpError(403, "account_blocked");
  if (user.age_method && schemas.AGE_METHOD_STRENGTH[user.age_method] > schemas.AGE_METHOD_STRENGTH[method]) throw new HttpError(409, "weaker_method");
  await db
    .prepare("UPDATE users SET age_band = ?1, age_method = ?2, age_band_until = ?3, age_checked_at = ?4 WHERE id = ?5")
    .bind(band, method, until, now, userId)
    .run();
  const cfg = await ageConfig(flags, user.country);
  const minBand = cfg.config.minAge >= 18 ? "18plus" : cfg.config.minAge >= 16 ? "16to17" : "13to15";
  const ok = BAND_RANK[band] >= BAND_RANK[minBand];
  if (user.account_state === "pending_age_review" || user.account_state === "restricted") {
    if (ok) {
      await db.prepare("UPDATE users SET account_state = 'active', state_reason = NULL, state_changed_at = ?1 WHERE id = ?2").bind(now, userId).run();
    } else {
      await db.prepare("UPDATE users SET account_state = 'restricted', state_reason = 'underage', state_changed_at = ?1 WHERE id = ?2").bind(now, userId).run();
    }
  } else if (!ok && user.account_state === "active") {
    await db.prepare("UPDATE users SET account_state = 'restricted', state_reason = 'underage', state_changed_at = ?1 WHERE id = ?2").bind(now, userId).run();
  }
  return getSafety(db, flags, userId);
}

/** Hourly: move people up a band when the month their band ends has passed, and drop old signals. */
export async function advanceAgeBands(db: D1Database, flags: FlagReader, now: number, onChanged?: (userId: string) => Promise<void>): Promise<number> {
  await db.prepare("DELETE FROM age_signals WHERE expires_at <= ?").bind(now).run();
  const { results } = await db
    .prepare("SELECT id, age_band, age_band_until FROM users WHERE age_band_until IS NOT NULL AND age_band_until <= ?")
    .bind(now)
    .all<{ id: string; age_band: schemas.AgeBand; age_band_until: number }>();
  for (const u of results) {
    if (u.age_band === "13to15") {
      // Same month, two years on: the end of the 16 to 17 band.
      const d = new Date(u.age_band_until);
      const next = Date.UTC(d.getUTCFullYear() + 2, d.getUTCMonth(), 1);
      await db.prepare("UPDATE users SET age_band = '16to17', age_band_until = ? WHERE id = ?").bind(next, u.id).run();
      await applyMinimumAge(db, flags, u.id, 16, now);
    } else if (u.age_band === "16to17") {
      await db.prepare("UPDATE users SET age_band = '18plus', age_band_until = NULL WHERE id = ?").bind(u.id).run();
      await applyMinimumAge(db, flags, u.id, 18, now);
    }
    await onChanged?.(u.id);
  }
  return results.length;
}

// ---------------------------------------------------------------- terms

export async function acceptTerms(db: D1Database, userId: string, request: schemas.AcceptTermsRequest, now: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO terms_acceptances (user_id, document, version, accepted_at) VALUES (?, ?, ?, ?)")
    .bind(userId, request.document, request.version, now)
    .run();
}
