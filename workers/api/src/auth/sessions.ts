import { newId, schemas } from "@bastion/shared";
import { hashToken, newToken } from "./crypto.js";
import { ACCESS_TTL, REFRESH_TTL } from "./deps.js";
import { AuthError } from "./errors.js";

export interface Principal {
  userId: string;
  deviceId: string;
  sessionId: string;
  accountState: schemas.AccountState;
  ageBand: schemas.AgeBand;
}

interface Issued {
  tokens: schemas.SessionTokens;
  accessHash: string;
  refreshHash: string;
}

async function issue(now: number): Promise<Issued> {
  const accessToken = newToken();
  const refreshToken = newToken();
  return {
    tokens: {
      accessToken,
      accessExpiresAt: now + ACCESS_TTL,
      refreshToken,
      refreshExpiresAt: now + REFRESH_TTL,
    },
    accessHash: await hashToken(accessToken),
    refreshHash: await hashToken(refreshToken),
  };
}

/** Returns the insert statement so callers can batch it with other writes. */
export async function newSession(
  db: D1Database,
  userId: string,
  deviceId: string,
  now: number,
): Promise<{ statement: D1PreparedStatement; tokens: schemas.SessionTokens }> {
  const { tokens, accessHash, refreshHash } = await issue(now);
  const statement = db
    .prepare(
      `INSERT INTO sessions (id, user_id, device_id, access_hash, access_expires_at,
         refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), userId, deviceId, accessHash, tokens.accessExpiresAt, refreshHash, tokens.refreshExpiresAt, now);
  return { statement, tokens };
}

/** Resolve a bearer access token. Throws 401 if missing, unknown or expired. */
export async function authenticate(db: D1Database, request: Request, now: number): Promise<Principal> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer ([A-Za-z0-9_-]{43})$/);
  if (!match) throw new AuthError(401, "unauthorized");
  const row = await db
    .prepare(
      `SELECT s.id, s.user_id, s.device_id, u.account_state, u.age_band FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.access_hash = ? AND s.access_expires_at > ?`,
    )
    .bind(await hashToken(match[1]!), now)
    .first<{ id: string; user_id: string; device_id: string; account_state: schemas.AccountState; age_band: schemas.AgeBand }>();
  if (!row) throw new AuthError(401, "unauthorized");
  // Suspended and removed accounts cannot use the API, even with a token issued earlier.
  if (schemas.BLOCKED_STATES.includes(row.account_state)) throw new AuthError(403, "account_blocked");
  return { userId: row.user_id, deviceId: row.device_id, sessionId: row.id, accountState: row.account_state, ageBand: row.age_band };
}

/**
 * Rotate a refresh token. Each refresh token works once. Presenting one that
 * was already rotated means it leaked, so the whole session is revoked.
 */
export async function refresh(
  db: D1Database,
  refreshToken: string,
  now: number,
  onRevoked?: (ended: { userId: string; sessionId: string }[]) => Promise<void>,
): Promise<schemas.SessionTokens> {
  const oldHash = await hashToken(refreshToken);
  const { tokens, accessHash, refreshHash } = await issue(now);

  const rotated = await db
    .prepare(
      `UPDATE sessions SET access_hash = ?, access_expires_at = ?, refresh_hash = ?,
         previous_refresh_hash = refresh_hash, refresh_expires_at = ?
       WHERE refresh_hash = ? AND refresh_expires_at > ?`,
    )
    .bind(accessHash, tokens.accessExpiresAt, refreshHash, tokens.refreshExpiresAt, oldHash, now)
    .run();
  if (rotated.meta.changes === 1) {
    await db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = (SELECT device_id FROM sessions WHERE refresh_hash = ?)")
      .bind(now, refreshHash)
      .run();
    return tokens;
  }

  // Unknown, expired, or reused. Revoke anything it points at.
  const { results } = await db
    .prepare("DELETE FROM sessions WHERE refresh_hash = ?1 OR previous_refresh_hash = ?1 RETURNING id, user_id")
    .bind(oldHash)
    .all<{ id: string; user_id: string }>();
  if (onRevoked && results.length > 0) await onRevoked(results.map((r) => ({ userId: r.user_id, sessionId: r.id })));
  throw new AuthError(401, "invalid_refresh_token");
}

export async function signOut(db: D1Database, principal: Principal): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(principal.sessionId).run();
}
