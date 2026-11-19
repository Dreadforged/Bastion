import { z } from "zod";
import { Id } from "./ids.js";
import { MODERATION_LIMITS } from "./moderation.js";

/**
 * Servers, channels, roles, members, messages and invites: entity shapes and
 * HTTP request bodies. Entity schemas describe what the API returns and what
 * gateway events carry; request schemas are what clients may send.
 */

export const LIMITS = {
  /** Largest HTTP request body the API will read. */
  maxBodyBytes: 32 * 1024,
  /** Message ciphertext, base64 characters (about 12 KiB of bytes). */
  maxCiphertextChars: 16 * 1024,
  maxChannelsPerServer: 200,
  maxRolesPerServer: 100,
  maxInvitesPerServer: 500,
  /** Longest invite lifetime. 0 means the invite never expires. */
  maxInviteAgeSeconds: 30 * 24 * 60 * 60,
  maxInviteUses: 1000,
  /** Page size cap for message history. */
  maxMessagePage: 100,
} as const;

/** Permission sets travel as decimal strings since JSON has no BigInt. */
const PermissionString = z.string().regex(/^\d{1,20}$/);

const Name = z.string().trim().min(1).max(100);

/** Client generated, scoped per user. Sent as the Idempotency-Key header. */
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/, "invalid idempotency key");

/** Invite codes: 10 base62 characters. */
export const InviteCode = z.string().regex(/^[A-Za-z0-9]{10}$/, "invalid invite code");

export const PresenceStatus = z.enum(["online", "idle", "dnd", "invisible"]);
export type PresenceStatus = z.infer<typeof PresenceStatus>;

/** What other members see. Invisible users show as offline. */
export const VisibleStatus = z.enum(["online", "idle", "dnd", "offline"]);
export type VisibleStatus = z.infer<typeof VisibleStatus>;

export const OverrideKind = z.enum(["role", "member"]);
export type OverrideKind = z.infer<typeof OverrideKind>;

export const ChannelOverride = z.object({
  kind: OverrideKind,
  /** Role id (the server id for @everyone) or user id. */
  targetId: Id,
  allow: PermissionString,
  deny: PermissionString,
});
export type ChannelOverride = z.infer<typeof ChannelOverride>;

export const Server = z.object({
  id: Id,
  name: z.string().min(1).max(100),
  ownerId: Id,
});
export type Server = z.infer<typeof Server>;

export const Role = z.object({
  id: Id,
  serverId: Id,
  name: z.string().min(1).max(100),
  permissions: PermissionString,
  position: z.number().int().nonnegative(),
});
export type Role = z.infer<typeof Role>;

export const ChannelKind = z.enum(["text", "voice"]);

export const Channel = z.object({
  id: Id,
  serverId: Id,
  name: z.string().min(1).max(100),
  kind: ChannelKind,
  position: z.number().int().nonnegative(),
  overrides: z.array(ChannelOverride),
  /** Seconds a member must wait between messages; 0 is off. */
  slowModeSeconds: z.number().int().nonnegative(),
});
export type Channel = z.infer<typeof Channel>;

export const Member = z.object({
  serverId: Id,
  userId: Id,
  nick: z.string().max(32).nullable(),
  /** Role ids, not including @everyone. */
  roles: z.array(Id),
  joinedAt: z.number().int(),
  /** Unix ms the member's timeout ends, or null. Past values mean no timeout. */
  timeoutUntil: z.number().int().nullable(),
});
export type Member = z.infer<typeof Member>;

/**
 * Message content is end-to-end encrypted, so the server stores and relays
 * opaque ciphertext and never sees plaintext.
 */
export const Message = z.object({
  id: Id,
  serverId: Id,
  channelId: Id,
  authorId: Id,
  ciphertext: z.base64().max(LIMITS.maxCiphertextChars),
  epoch: z.number().int().nonnegative(),
  createdAt: z.number().int(),
  editedAt: z.number().int().nullable(),
});
export type Message = z.infer<typeof Message>;

export const Invite = z.object({
  code: InviteCode,
  serverId: Id,
  createdBy: Id,
  maxUses: z.number().int().nonnegative(),
  uses: z.number().int().nonnegative(),
  /** Unix ms, or null for an invite that never expires. */
  expiresAt: z.number().int().nullable(),
  createdAt: z.number().int(),
});
export type Invite = z.infer<typeof Invite>;

export const InvitePreview = z.object({
  code: InviteCode,
  server: z.object({ id: Id, name: z.string() }),
  memberCount: z.number().int(),
  expiresAt: z.number().int().nullable(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;

// ------------------------------------------------------------------ requests

export const CreateServerRequest = z.object({ name: Name });

const SlowModeSeconds = z.number().int().min(0).max(MODERATION_LIMITS.maxSlowModeSeconds);

export const CreateChannelRequest = z.object({
  name: Name,
  kind: z.enum(["text", "voice"]).default("text"),
  position: z.number().int().nonnegative().max(10_000).optional(),
  slowModeSeconds: SlowModeSeconds.default(0),
});

export const UpdateChannelRequest = z
  .object({
    name: Name.optional(),
    position: z.number().int().nonnegative().max(10_000).optional(),
    slowModeSeconds: SlowModeSeconds.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to update");

export const PutOverrideRequest = z.object({ allow: PermissionString, deny: PermissionString });

export const CreateRoleRequest = z.object({
  name: Name,
  permissions: PermissionString.default("0"),
  position: z.number().int().min(1).max(1000).optional(),
});

export const UpdateRoleRequest = z
  .object({
    name: Name.optional(),
    permissions: PermissionString.optional(),
    position: z.number().int().min(1).max(1000).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "nothing to update");

export const CreateMessageRequest = z.object({
  ciphertext: z.base64().min(1).max(LIMITS.maxCiphertextChars),
  epoch: z.number().int().nonnegative(),
});

export const UpdateMessageRequest = CreateMessageRequest;

export const MessageHistoryQuery = z.object({
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxMessagePage).default(50),
});

export const CreateInviteRequest = z.object({
  /** Seconds until expiry; 0 means never. Defaults to one day. */
  maxAgeSeconds: z.number().int().min(0).max(LIMITS.maxInviteAgeSeconds).default(86_400),
  /** 0 means unlimited. */
  maxUses: z.number().int().min(0).max(LIMITS.maxInviteUses).default(0),
});

export const UpdatePresenceRequest = z.object({ status: PresenceStatus });

export const UpdateServerRequest = z.object({ name: Name });
