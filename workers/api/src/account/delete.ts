import { HttpError } from "../http.js";
import { isHeld } from "../safety/holds.js";

/**
 * Account deletion. A legal hold on the account, or on any of its files,
 * stops it: the person is told `legal_hold` and nothing is touched. Held
 * material must outlive the account until staff release the hold.
 *
 * Message content is end-to-end encrypted and never readable here. What this
 * removes: the account row and everything that cascades from it (passkeys,
 * sessions, keys, privacy settings, terms records, age signals, file records),
 * membership in servers and conversations, and the person's files in R2.
 * What it leaves: ciphertext already delivered to other people's devices,
 * moderation records other servers keep for their retention period, and the
 * staff access log, which holds ids only.
 */

/** Everything deletion needs from the Durable Objects and R2, so tests can supply fakes. */
export interface DeletionPorts {
  db: D1Database;
  now: () => number;
  /** Server ids the person belongs to. */
  serverIds(userId: string): Promise<string[]>;
  /** The server's owner, or null if the server cannot be read. */
  serverOwner(serverId: string, userId: string): Promise<string | null>;
  leaveServer(serverId: string, userId: string): Promise<void>;
  /** Only used when purging a removed account that owns servers. */
  deleteServer(serverId: string, ownerId: string): Promise<void>;
  revokeConversation(conversationId: string, userId: string): Promise<void>;
  /** Close sockets of these auth sessions. */
  endSessions(userId: string, sessionIds: string[]): Promise<void>;
  files?: R2Bucket | undefined;
}

export interface DeleteOptions {
  /** Delete servers the person owns instead of refusing. For purging removed accounts only. */
  deleteOwnedServers?: boolean;
}

export async function deleteAccount(ports: DeletionPorts, userId: string, options: DeleteOptions = {}): Promise<void> {
  const { db } = ports;
  if (await isHeld(db, "account", userId)) throw new HttpError(409, "legal_hold");

  const files = (await db.prepare("SELECT id FROM attachments WHERE uploader_id = ?").bind(userId).all<{ id: string }>()).results.map((r) => r.id);
  for (const fileId of files) {
    if (await isHeld(db, "file", fileId)) throw new HttpError(409, "legal_hold");
  }

  const serverIds = await ports.serverIds(userId);
  const owned: string[] = [];
  for (const serverId of serverIds) {
    if ((await ports.serverOwner(serverId, userId)) === userId) owned.push(serverId);
  }
  if (owned.length > 0 && !options.deleteOwnedServers) throw new HttpError(409, "owns_servers");
  for (const serverId of owned) {
    if (await isHeld(db, "server", serverId)) throw new HttpError(409, "legal_hold");
  }

  // Nothing can stop the deletion from here, so the order is: leave places, remove files, remove the account.
  for (const serverId of serverIds) {
    if (owned.includes(serverId)) await ports.deleteServer(serverId, userId).catch(() => undefined);
    else await ports.leaveServer(serverId, userId).catch(() => undefined);
  }
  const conversations = await db.prepare("SELECT conversation_id FROM conversation_members WHERE user_id = ?").bind(userId).all<{ conversation_id: string }>();
  await Promise.allSettled(conversations.results.map((c) => ports.revokeConversation(c.conversation_id, userId)));

  if (ports.files) {
    for (let i = 0; i < files.length; i += 100) {
      const keys = files.slice(i, i + 100).flatMap((id) => [`pending/${id}`, `files/${id}`]);
      await ports.files.delete(keys);
    }
  }

  const sessions = await db.prepare("SELECT id FROM sessions WHERE user_id = ?").bind(userId).all<{ id: string }>();
  await db.batch([
    db.prepare("DELETE FROM enrollments WHERE user_id = ?").bind(userId),
    db.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
  await ports.endSessions(userId, sessions.results.map((s) => s.id)).catch(() => undefined);
}

/** Days a removed (under 13) account is kept before its data is deleted, so an error can be corrected. For the lawyer to confirm. */
export const REMOVED_ACCOUNT_GRACE_DAYS = 7;

/**
 * Hourly: delete accounts removed as under age once the grace period has
 * passed. Held accounts are skipped and tried again each hour until released.
 * Returns how many were deleted.
 */
export async function purgeRemovedAccounts(ports: DeletionPorts, now: number, graceDays = REMOVED_ACCOUNT_GRACE_DAYS): Promise<number> {
  const { results } = await ports.db
    .prepare("SELECT id FROM users WHERE account_state = 'underage_removed' AND state_changed_at IS NOT NULL AND state_changed_at <= ? LIMIT 50")
    .bind(now - graceDays * 24 * 60 * 60_000)
    .all<{ id: string }>();
  let deleted = 0;
  for (const { id } of results) {
    try {
      await deleteAccount(ports, id, { deleteOwnedServers: true });
      deleted++;
    } catch (err) {
      if (!(err instanceof HttpError)) console.error("purge failed for one account"); // no ids in logs
    }
  }
  return deleted;
}
