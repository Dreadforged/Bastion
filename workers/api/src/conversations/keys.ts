import { newId, schemas } from "@bastion/shared";
import type { z } from "zod";
import type { Principal } from "../auth/sessions.js";
import { HttpError } from "../http.js";

/**
 * Per-device MLS keys. A device uploads its identity key once and keeps a
 * stock of single-use key packages topped up; adding a device to a group
 * claims (and deletes) one of its packages.
 */

/** Stores the device's identity key and a batch of key packages. */
export async function uploadKeyPackages(
  db: D1Database,
  principal: Principal,
  body: z.output<typeof schemas.UploadKeyPackagesRequest>,
  now: number,
): Promise<{ stored: number }> {
  const existing = await db
    .prepare("SELECT identity_key FROM device_identity_keys WHERE device_id = ?")
    .bind(principal.deviceId)
    .first<{ identity_key: string }>();
  // A device's identity key never changes; a new key means a new device.
  if (existing && existing.identity_key !== body.identityKey) throw new HttpError(409, "identity_key_mismatch");

  const count = await stock(db, principal.deviceId);
  if (count + body.keyPackages.length > schemas.E2EE_LIMITS.maxKeyPackagesPerDevice) throw new HttpError(409, "too_many_key_packages");

  const statements: D1PreparedStatement[] = [];
  if (!existing) {
    statements.push(
      db
        .prepare("INSERT INTO device_identity_keys (device_id, user_id, identity_key, created_at) VALUES (?, ?, ?, ?)")
        .bind(principal.deviceId, principal.userId, body.identityKey, now),
    );
  }
  for (const kp of body.keyPackages) {
    statements.push(
      db
        .prepare("INSERT INTO key_packages (id, device_id, user_id, key_package) VALUES (?, ?, ?, ?)")
        .bind(newId(), principal.deviceId, principal.userId, kp),
    );
  }
  await db.batch(statements);
  return { stored: count + body.keyPackages.length };
}

/** Unclaimed key packages left for a device. */
export async function stock(db: D1Database, deviceId: string): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM key_packages WHERE device_id = ?").bind(deviceId).first<{ n: number }>();
  return row?.n ?? 0;
}

/**
 * Claims one key package for every device of each user, oldest first. The
 * caller's own device is skipped. Devices with none left are reported so the
 * client can retry later.
 */
export async function claimKeyPackages(
  db: D1Database,
  principal: Principal,
  userIds: readonly string[],
): Promise<{ keyPackages: schemas.ClaimedKeyPackage[]; exhausted: schemas.DeviceRef[] }> {
  const unique = [...new Set(userIds)];
  const placeholders = unique.map(() => "?").join(", ");
  const { results: devices } = await db
    .prepare(`SELECT device_id, user_id FROM device_identity_keys WHERE user_id IN (${placeholders}) ORDER BY user_id, device_id`)
    .bind(...unique)
    .all<{ device_id: string; user_id: string }>();

  const keyPackages: schemas.ClaimedKeyPackage[] = [];
  const exhausted: schemas.DeviceRef[] = [];
  for (const d of devices) {
    if (d.device_id === principal.deviceId) continue;
    const row = await db
      .prepare(
        `DELETE FROM key_packages
         WHERE id = (SELECT id FROM key_packages WHERE device_id = ? ORDER BY id LIMIT 1)
         RETURNING key_package`,
      )
      .bind(d.device_id)
      .first<{ key_package: string }>();
    if (row) keyPackages.push({ userId: d.user_id, deviceId: d.device_id, keyPackage: row.key_package });
    else exhausted.push({ userId: d.user_id, deviceId: d.device_id });
  }
  return { keyPackages, exhausted };
}

/** Identity keys of a user's devices, for safety codes. */
export async function identityKeys(db: D1Database, userId: string): Promise<schemas.DeviceKeys[]> {
  const { results } = await db
    .prepare("SELECT device_id, identity_key FROM device_identity_keys WHERE user_id = ? ORDER BY device_id")
    .bind(userId)
    .all<{ device_id: string; identity_key: string }>();
  return results.map((r) => ({ deviceId: r.device_id, identityKey: r.identity_key }));
}

/** Checks that each device exists and belongs to the user named with it. */
export async function devicesBelong(db: D1Database, refs: readonly schemas.DeviceRef[]): Promise<boolean> {
  if (refs.length === 0) return true;
  const ids = [...new Set(refs.map((r) => r.deviceId))];
  const { results } = await db
    .prepare(`SELECT id, user_id FROM devices WHERE id IN (${ids.map(() => "?").join(", ")})`)
    .bind(...ids)
    .all<{ id: string; user_id: string }>();
  const owner = new Map(results.map((r) => [r.id, r.user_id]));
  return refs.every((r) => owner.get(r.deviceId) === r.userId);
}
