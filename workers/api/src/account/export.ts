import type { schemas } from "@bastion/shared";
import { getPrivacy } from "./privacy.js";

const NOT_INCLUDED = [
  "Message text. Messages are end-to-end encrypted and the server only holds ciphertext it cannot read. Each device exports the readable history it holds (Settings, Privacy and data).",
  "Sign-in secrets. Passkey private keys never leave your devices, and the server keeps only hashes of tokens and of the recovery code.",
  "Other people's data, such as their email addresses or servers' member lists.",
  "Moderation records about you that a server's moderators keep, such as reports and audit log entries. Ask the server's owner.",
];

/**
 * Everything the server stores about one account, as one JSON document.
 * `serverIds` comes from the user's session object, which is the only place
 * that knows which servers they belong to.
 */
export async function buildExport(db: D1Database, userId: string, serverIds: string[], now: number): Promise<schemas.AccountExport> {
  const user = await db
    .prepare("SELECT id, email, created_at, recovery_hash FROM users WHERE id = ?")
    .bind(userId)
    .first<{ id: string; email: string; created_at: number; recovery_hash: string | null }>();
  if (!user) throw new Error("unknown user");

  const { results: devices } = await db
    .prepare(
      `SELECT d.id, d.name, d.created_at, d.last_seen_at, k.identity_key,
              (SELECT COUNT(*) FROM key_packages p WHERE p.device_id = d.id) AS packages
         FROM devices d LEFT JOIN device_identity_keys k ON k.device_id = d.id
        WHERE d.user_id = ? ORDER BY d.id`,
    )
    .bind(userId)
    .all<{ id: string; name: string; created_at: number; last_seen_at: number | null; identity_key: string | null; packages: number }>();

  const { results: conversations } = await db
    .prepare(
      `SELECT m.conversation_id AS id,
              CASE WHEN p.conversation_id IS NOT NULL THEN 'dm'
                   WHEN c.conversation_id IS NOT NULL THEN 'channel'
                   ELSE 'group_or_call' END AS kind,
              CASE WHEN p.user_a = ?1 THEN p.user_b ELSE p.user_a END AS peer_id
         FROM conversation_members m
         LEFT JOIN dm_pairs p ON p.conversation_id = m.conversation_id
         LEFT JOIN channel_conversations c ON c.conversation_id = m.conversation_id
        WHERE m.user_id = ?1 ORDER BY m.conversation_id`,
    )
    .bind(userId)
    .all<{ id: string; kind: "dm" | "channel" | "group_or_call"; peer_id: string | null }>();

  const { results: files } = await db
    .prepare(
      `SELECT id, visibility, status, size, content_type, created_at, server_id, channel_id, conversation_id
         FROM attachments WHERE uploader_id = ? ORDER BY id`,
    )
    .bind(userId)
    .all<{
      id: string;
      visibility: "public" | "private";
      status: "pending" | "ready" | "blocked";
      size: number;
      content_type: string;
      created_at: number;
      server_id: string | null;
      channel_id: string | null;
      conversation_id: string | null;
    }>();

  return {
    format: "bastion-account-export",
    version: 1,
    exportedAt: now,
    account: { id: user.id, email: user.email, createdAt: user.created_at, recoveryCodeActive: user.recovery_hash !== null },
    privacy: await getPrivacy(db, userId),
    devices: devices.map((d) => ({
      id: d.id,
      name: d.name,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      identityKey: d.identity_key,
      unusedKeyPackages: d.packages,
    })),
    servers: serverIds,
    conversations: conversations.map((c) => ({ id: c.id, kind: c.kind, peerId: c.kind === "dm" ? c.peer_id : null })),
    files: files.map((f) => ({
      id: f.id,
      visibility: f.visibility,
      status: f.status,
      size: f.size,
      contentType: f.content_type,
      createdAt: f.created_at,
      serverId: f.server_id,
      channelId: f.channel_id,
      conversationId: f.conversation_id,
    })),
    notIncluded: NOT_INCLUDED,
  };
}
