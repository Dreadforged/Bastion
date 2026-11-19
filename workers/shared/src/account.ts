import { z } from "zod";
import { Id } from "./ids.js";

/**
 * Privacy settings and the account data export.
 *
 * Presence ("invisible") is a status, set through PUT /presence, and is not
 * repeated here. These are the other choices a person has.
 */

/** Who may start a new DM with you. Existing DMs keep working. */
export const DmPolicy = z.enum(["everyone", "nobody"]);
export type DmPolicy = z.infer<typeof DmPolicy>;

export const PrivacySettings = z.object({
  dmPolicy: DmPolicy,
  /** When off, others never see that you are typing. Enforced by the Worker. */
  typingIndicators: z.boolean(),
});
export type PrivacySettings = z.infer<typeof PrivacySettings>;

export const DEFAULT_PRIVACY: PrivacySettings = { dmPolicy: "everyone", typingIndicators: true };

export const UpdatePrivacyRequest = z
  .object({ dmPolicy: DmPolicy, typingIndicators: z.boolean() })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, "nothing to update");
export type UpdatePrivacyRequest = z.infer<typeof UpdatePrivacyRequest>;

/**
 * Everything the server holds about the account. It cannot include message
 * text: the server only stores ciphertext it cannot read. A device exports
 * the readable history it holds locally (see the web client's export).
 */
export const AccountExport = z.object({
  format: z.literal("bastion-account-export"),
  version: z.literal(1),
  exportedAt: z.number().int(),
  account: z.object({ id: Id, email: z.string(), createdAt: z.number().int(), recoveryCodeActive: z.boolean() }),
  privacy: PrivacySettings,
  devices: z.array(
    z.object({
      id: Id,
      name: z.string(),
      createdAt: z.number().int(),
      lastSeenAt: z.number().int().nullable(),
      /** Public identity key for encrypted chats, if the device uploaded one. */
      identityKey: z.string().nullable(),
      unusedKeyPackages: z.number().int(),
    }),
  ),
  servers: z.array(Id),
  conversations: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["dm", "channel", "group_or_call"]),
      /** The other person, for a DM. */
      peerId: Id.nullable(),
    }),
  ),
  files: z.array(
    z.object({
      id: Id,
      visibility: z.enum(["public", "private"]),
      status: z.enum(["pending", "ready", "blocked"]),
      size: z.number().int(),
      contentType: z.string(),
      createdAt: z.number().int(),
      serverId: Id.nullable(),
      channelId: Id.nullable(),
      conversationId: z.string().nullable(),
    }),
  ),
  notIncluded: z.array(z.string()),
});
export type AccountExport = z.infer<typeof AccountExport>;
