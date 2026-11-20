import { newId, Permission, serializePermissions } from "@bastion/shared";
import { newSession } from "../auth/sessions.js";
import { FlagReader, regionChain } from "../safety/flags.js";
import { PERSONAS, SEED_SERVER_NAME, type Persona } from "./personas.js";

/** Calls the real server routes. In the Worker this is `handleServers`; in tests, the same with fake objects. */
export type ApiCall = (request: Request) => Promise<Response>;

export interface SeedDeps {
  db: D1Database;
  flags: FlagReader;
  now: () => number;
  api: ApiCall;
}

export interface SeedResult {
  /** False when the accounts were already there and nothing was changed. */
  seeded: boolean;
}

const BAND_ENDS_AFTER_MS = 365 * 24 * 60 * 60_000;

async function userId(db: D1Database, email: string): Promise<string | null> {
  return (await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>())?.id ?? null;
}

/** A session for a seed step. Each call also adds a throwaway device, like a sign-in does. */
export async function devSession(db: D1Database, uid: string, label: string, now: number) {
  const deviceId = newId();
  await db
    .prepare("INSERT INTO devices (id, user_id, name, credential_id, public_key, created_at, last_seen_at) VALUES (?, ?, ?, ?, 'dev-only', ?, ?)")
    .bind(deviceId, uid, label.slice(0, 64), `dev-${deviceId}`, now, now)
    .run();
  const session = await newSession(db, uid, deviceId, now);
  await session.statement.run();
  return session.tokens;
}

async function insertPersona(deps: SeedDeps, p: Persona): Promise<string> {
  const now = deps.now();
  const id = newId();
  const legal = (await deps.flags.get("legal", regionChain(null))).config;
  const until = p.ageBand === "18plus" ? null : now + BAND_ENDS_AFTER_MS;
  await deps.db.batch([
    deps.db.prepare("INSERT INTO users (id, email, recovery_hash, created_at) VALUES (?, ?, NULL, ?)").bind(id, p.email, now),
    deps.db
      .prepare(
        `UPDATE users SET age_band = ?, age_method = ?, age_band_until = ?, age_checked_at = ?, account_state = ?, state_reason = ?, state_changed_at = ? WHERE id = ?`,
      )
      .bind(p.ageBand, p.ageMethod, until, now, p.accountState, p.accountState === "active" ? null : "underage", now, id),
    ...(["terms", "privacy", "aup"] as const).map((document) =>
      deps.db.prepare("INSERT INTO terms_acceptances (user_id, document, version, accepted_at) VALUES (?, ?, ?, ?)").bind(id, document, legal[document], now),
    ),
  ]);
  return id;
}

interface Caller {
  token: string;
}

async function call(deps: SeedDeps, as: Caller, method: string, path: string, body?: unknown, key?: string): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { authorization: `Bearer ${as.token}` };
  if (key) headers["idempotency-key"] = key;
  const res = await deps.api(
    new Request(`http://localhost${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function must<T>(label: string, r: { status: number; body: unknown }): Promise<T> {
  if (r.status >= 300) throw new Error(`dev seed step failed: ${label} (${r.status} ${JSON.stringify(r.body)})`);
  return r.body as T;
}

/**
 * Create the personas, one server with channels, a role and an invite, and
 * put the members in it. Does nothing if the personas already exist, so it is
 * safe to call on every sign-in. To start over, delete the local database
 * (docs/local-testing.md).
 *
 * Direct messages are not seeded: an encrypted conversation only exists once
 * a browser has made its keys, so DMs are started from the app. Everyone in
 * the server can message everyone else straight away.
 */
export async function seedDevData(deps: SeedDeps): Promise<SeedResult> {
  if (await userId(deps.db, PERSONAS[0]!.email)) return { seeded: false };

  const ids = new Map<string, string>();
  for (const p of PERSONAS) ids.set(p.handle, await insertPersona(deps, p));

  const tokens = new Map<string, Caller>();
  for (const p of PERSONAS.filter((x) => x.membership)) {
    const t = await devSession(deps.db, ids.get(p.handle)!, "seed", deps.now());
    tokens.set(p.handle, { token: t.accessToken });
  }
  const alice = tokens.get("alice")!;

  const server = await must<{ server: { id: string } }>(
    "create server",
    await call(deps, alice, "POST", "/servers", { name: SEED_SERVER_NAME }, "dev-seed-server-v1"),
  );
  const base = `/servers/${server.server.id}`;

  const channel = (name: string, kind: "text" | "voice", extra: object = {}) =>
    call(deps, alice, "POST", `${base}/channels`, { name, kind, ...extra }, `dev-seed-channel-${name}`);
  await must("channel dev-chat", await channel("dev-chat", "text"));
  await must("channel off-topic", await channel("off-topic", "text"));
  await must("channel voice-lounge", await channel("voice-lounge", "voice"));
  // Only exists where the region flags allow age restricted channels; fine if refused.
  await channel("adults-only", "text", { ageRestricted: true });

  const modPermissions = Permission.MANAGE_MESSAGES | Permission.MUTE_MEMBERS | Permission.KICK | Permission.TIMEOUT | Permission.VIEW_AUDIT_LOG;
  const role = await must<{ id: string }>(
    "create role",
    await call(deps, alice, "POST", `${base}/roles`, { name: "Moderator", permissions: serializePermissions(modPermissions) }, "dev-seed-role-moderator"),
  );
  const invite = await must<{ code: string }>(
    "create invite",
    await call(deps, alice, "POST", `${base}/invites`, { maxAgeSeconds: 0, maxUses: 0 }, "dev-seed-invite"),
  );

  for (const p of PERSONAS.filter((x) => x.membership === "moderator" || x.membership === "member")) {
    await must(`join ${p.handle}`, await call(deps, tokens.get(p.handle)!, "POST", `/invites/${invite.code}`, undefined, `dev-seed-join-${p.handle}`));
  }
  const bob = ids.get("bob")!;
  await must("make bob moderator", await call(deps, alice, "PUT", `${base}/members/${bob}/roles/${role.id}`, undefined, "dev-seed-bob-role"));

  return { seeded: true };
}
