import { z } from "zod";
import { Id } from "./ids.js";

/**
 * End-to-end encrypted conversations: DMs, small private groups and
 * members-only channels inside servers. Each is an MLS group. The server is
 * only the delivery service: it orders commits, stores and hands out
 * ciphertext, and never holds keys or sees plaintext.
 *
 * Every MLS leaf is one device. Its credential identity is
 * `<userId>/<deviceId>`, and clients must check that against the device a
 * key package was claimed for.
 */

export const E2EE_LIMITS = {
  /** Private groups. */
  maxGroupMembers: 50,
  /** Encrypted members-only channels. */
  maxChannelMembers: 200,
  /** Unclaimed key packages kept per device. */
  maxKeyPackagesPerDevice: 100,
  maxKeyPackageUpload: 50,
  /** Users whose key packages can be claimed in one request. */
  maxClaimUsers: 50,
  /** One key package, base64. */
  maxKeyPackageChars: 4096,
  /** Commits and welcomes grow with group size, base64. */
  maxHandshakeChars: 384 * 1024,
  /** Application messages: the largest padded size plus MLS overhead, base64. */
  maxMessageChars: 96 * 1024,
  /** Largest request body on conversation routes. */
  maxBodyBytes: 1024 * 1024,
  maxEnvelopePage: 200,
} as const;

/**
 * Conversation ids are 16 random bytes, base64url. Unlike ULIDs they carry
 * no creation time.
 */
export const ConversationId = z.string().regex(/^[A-Za-z0-9_-]{22}$/, "invalid conversation id");
export type ConversationId = z.infer<typeof ConversationId>;

export const ConversationKind = z.enum(["dm", "group", "channel"]);
export type ConversationKind = z.infer<typeof ConversationKind>;

/** Ed25519 public key, 32 bytes. */
export const IdentityKey = z.base64().length(44);

const KeyPackage = z.base64().min(1).max(E2EE_LIMITS.maxKeyPackageChars);

export const DeviceRef = z.object({ userId: Id, deviceId: Id });
export type DeviceRef = z.infer<typeof DeviceRef>;

// ------------------------------------------------------------------ entities

export const ConversationMember = z.object({
  userId: Id,
  role: z.enum(["owner", "member"]),
  /** Lost access; waiting for a member to commit their removal. */
  pendingRemoval: z.boolean(),
});
export type ConversationMember = z.infer<typeof ConversationMember>;

export const Conversation = z.object({
  id: ConversationId,
  kind: ConversationKind,
  /** Set for channel conversations. */
  serverId: Id.nullable(),
  channelId: Id.nullable(),
  epoch: z.number().int().nonnegative(),
  members: z.array(ConversationMember),
  /** Devices in the MLS group. */
  devices: z.array(DeviceRef),
  createdAt: z.number().int(),
});
export type Conversation = z.infer<typeof Conversation>;

/**
 * One item in a conversation's ordered log. A device sees welcomes addressed
 * to it, then every commit and message after it joined.
 */
export const Envelope = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(["commit", "message", "welcome"]),
  senderId: Id,
  senderDeviceId: Id,
  /** The epoch the item was made in. */
  epoch: z.number().int().nonnegative(),
  data: z.base64(),
  createdAt: z.number().int(),
});
export type Envelope = z.infer<typeof Envelope>;

export const DeviceKeys = z.object({ deviceId: Id, identityKey: IdentityKey });
export type DeviceKeys = z.infer<typeof DeviceKeys>;

export const ClaimedKeyPackage = z.object({ userId: Id, deviceId: Id, keyPackage: KeyPackage });
export type ClaimedKeyPackage = z.infer<typeof ClaimedKeyPackage>;

// ------------------------------------------------------------------ requests

/** Upload this device's identity key and a batch of fresh key packages. */
export const UploadKeyPackagesRequest = z.object({
  identityKey: IdentityKey,
  keyPackages: z.array(KeyPackage).min(1).max(E2EE_LIMITS.maxKeyPackageUpload),
});

/** Take one key package for every device of each user. */
export const ClaimKeyPackagesRequest = z.object({
  userIds: z.array(Id).min(1).max(E2EE_LIMITS.maxClaimUsers),
});

export const CreateConversationRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dm"), userId: Id }),
  z.object({ kind: z.literal("group") }),
  z.object({ kind: z.literal("channel"), serverId: Id, channelId: Id }),
]);
export type CreateConversationRequest = z.infer<typeof CreateConversationRequest>;

/**
 * An MLS commit made in `epoch`. `adds` and `removes` list the devices it
 * adds and removes; the server checks them against permissions and keeps
 * its device list in step. A welcome is required when devices are added.
 */
export const CommitRequest = z
  .object({
    epoch: z.number().int().nonnegative(),
    commit: z.base64().min(1).max(E2EE_LIMITS.maxHandshakeChars),
    welcome: z.base64().min(1).max(E2EE_LIMITS.maxHandshakeChars).optional(),
    adds: z.array(DeviceRef).max(E2EE_LIMITS.maxChannelMembers * 4).default([]),
    removes: z.array(DeviceRef).max(E2EE_LIMITS.maxChannelMembers * 4).default([]),
  })
  .refine((c) => (c.adds.length > 0) === (c.welcome !== undefined), "welcome goes with adds");
export type CommitRequest = z.infer<typeof CommitRequest>;

export const SendMessageRequest = z.object({
  epoch: z.number().int().nonnegative(),
  ciphertext: z.base64().min(1).max(E2EE_LIMITS.maxMessageChars),
});

export const EnvelopeQuery = z.object({
  /** Return items after this sequence number. */
  after: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(E2EE_LIMITS.maxEnvelopePage).default(100),
});

// ------------------------------------------------------------------ plaintext

/**
 * What clients put inside an encrypted message, before padding. The server
 * never sees this. Attachments are encrypted with their own random key,
 * uploaded as opaque blobs, and the key travels here.
 */
export const MessagePayload = z.object({
  text: z.string().max(8000),
  attachments: z
    .array(
      z.object({
        /** Upload id of the encrypted blob. */
        id: Id,
        /** AES-256-GCM key and nonce, base64. */
        key: z.base64().length(44),
        nonce: z.base64().length(16),
        name: z.string().max(255),
        mime: z.string().max(127),
        size: z.number().int().nonnegative(),
      }),
    )
    .max(10)
    .default([]),
  replyTo: Id.optional(),
});
export type MessagePayload = z.infer<typeof MessagePayload>;
