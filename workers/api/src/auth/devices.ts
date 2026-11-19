import type { schemas } from "@bastion/shared";
import type { AuthDeps } from "./deps.js";
import { AuthError } from "./errors.js";
import type { Principal } from "./sessions.js";

/** Backs Settings, Sign-in and devices. */
export async function listDevices(deps: AuthDeps, principal: Principal): Promise<schemas.Device[]> {
  const { results } = await deps.db
    .prepare("SELECT id, name, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY id")
    .bind(principal.userId)
    .all<{ id: string; name: string; created_at: number; last_seen_at: number | null }>();
  return results.map((d) => ({
    id: d.id,
    name: d.name,
    createdAt: d.created_at,
    lastSeenAt: d.last_seen_at,
    current: d.id === principal.deviceId,
  }));
}

/** Removes the passkey and signs the device out everywhere (sessions cascade). */
export async function revokeDevice(deps: AuthDeps, principal: Principal, deviceId: string): Promise<void> {
  const result = await deps.db
    .prepare("DELETE FROM devices WHERE id = ? AND user_id = ?")
    .bind(deviceId, principal.userId)
    .run();
  if (result.meta.changes !== 1) throw new AuthError(404, "not_found");
}

/** Drops expired enrollments, challenges, sessions and rate limit windows. */
export async function cleanupExpired(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM enrollments WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM challenges WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM sessions WHERE refresh_expires_at <= ?").bind(now),
    db.prepare("DELETE FROM rate_limits WHERE window_end <= ?").bind(now),
  ]);
}
