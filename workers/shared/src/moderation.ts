import { z } from "zod";
import { Id } from "./ids.js";
import { ReasonCode } from "./safety.js";

/**
 * Moderation: reports, timeouts, kicks, bans, slow mode and the audit log.
 *
 * Message content is end-to-end encrypted, so the server cannot read what is
 * being reported. A report carries the plaintext of only the messages the
 * reporter picked, decrypted on their device. Moderators who can see that
 * channel can read it; nobody else can.
 */

const DAY_SECONDS = 24 * 60 * 60;

export const MODERATION_LIMITS = {
  maxTimeoutSeconds: 28 * DAY_SECONDS,
  maxSlowModeSeconds: 6 * 60 * 60,
  maxReasonChars: 512,
  maxReportMessages: 25,
  maxReportedMessageChars: 4000,
  maxReportNoteChars: 1000,
  /** A ban can also delete the user's messages from this far back. */
  maxBanDeleteSeconds: 7 * DAY_SECONDS,
  /** And at most this many of them, newest first. */
  maxBanDeletedMessages: 1000,
  maxPage: 100,
  /** Closed reports and audit log entries are deleted after this long. */
  retentionMs: 90 * DAY_SECONDS * 1000,
} as const;

/** Free text a moderator gives for an action. Shown in the audit log. */
export const ModerationReason = z.string().trim().min(1).max(MODERATION_LIMITS.maxReasonChars);

/** A fixed reason, kept next to the free text so actions can be counted and explained. */
export const ModerationReasonCode = ReasonCode;

const Page = {
  before: Id.optional(),
  limit: z.coerce.number().int().min(1).max(MODERATION_LIMITS.maxPage).default(50),
};

// ------------------------------------------------------------------ reports

export const ReportCategory = z.enum(["spam", "harassment", "hate", "sexual", "violence", "self_harm", "illegal", "underage", "other"]);
export type ReportCategory = z.infer<typeof ReportCategory>;

export const ReportStatus = z.enum(["open", "resolved", "dismissed"]);
export type ReportStatus = z.infer<typeof ReportStatus>;

/** A reported message as the reporter's device decrypted it. */
export const ReportedMessage = z.object({
  id: Id,
  authorId: Id,
  content: z.string().max(MODERATION_LIMITS.maxReportedMessageChars),
  createdAt: z.number().int(),
});
export type ReportedMessage = z.infer<typeof ReportedMessage>;

/** What moderators see. The reporter is not shown. */
export const Report = z.object({
  id: Id,
  serverId: Id,
  channelId: Id,
  category: ReportCategory,
  note: z.string().nullable(),
  status: ReportStatus,
  messages: z.array(ReportedMessage),
  /** The moderator who last changed the status. */
  handledBy: Id.nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type Report = z.infer<typeof Report>;

export const CreateReportRequest = z.object({
  channelId: Id,
  category: ReportCategory,
  note: z.string().trim().min(1).max(MODERATION_LIMITS.maxReportNoteChars).optional(),
  messages: z
    .array(z.object({ id: Id, content: z.string().max(MODERATION_LIMITS.maxReportedMessageChars) }))
    .min(1)
    .max(MODERATION_LIMITS.maxReportMessages)
    .refine((list) => new Set(list.map((m) => m.id)).size === list.length, "duplicate message"),
});

export const UpdateReportRequest = z.object({
  status: ReportStatus,
  reason: ModerationReason.optional(),
  reasonCode: ReasonCode.optional(),
});

export const ReportListQuery = z.object({ status: ReportStatus.optional(), ...Page });

// ------------------------------------------------------------------ actions

export const TimeoutRequest = z.object({
  seconds: z.number().int().min(1).max(MODERATION_LIMITS.maxTimeoutSeconds),
  reason: ModerationReason.optional(),
  reasonCode: ReasonCode.optional(),
});

/** Optional body for kicks, unbans and removing a timeout. */
export const ReasonRequest = z.object({ reason: ModerationReason.optional(), reasonCode: ReasonCode.optional() });

export const BanRequest = z.object({
  reason: ModerationReason.optional(),
  reasonCode: ReasonCode.optional(),
  deleteMessageSeconds: z.number().int().min(0).max(MODERATION_LIMITS.maxBanDeleteSeconds).default(0),
});

export const Ban = z.object({
  serverId: Id,
  userId: Id,
  reason: z.string().nullable(),
  createdBy: Id.nullable(),
  createdAt: z.number().int(),
});
export type Ban = z.infer<typeof Ban>;

export const BanListQuery = z.object(Page);

// ------------------------------------------------------------------ audit log

export const AuditAction = z.enum([
  "server.update",
  "channel.create",
  "channel.update",
  "channel.delete",
  "channel.slow_mode",
  "override.put",
  "override.delete",
  "role.create",
  "role.update",
  "role.delete",
  "member.role.add",
  "member.role.remove",
  "member.kick",
  "member.ban",
  "member.unban",
  "member.timeout",
  "member.timeout.remove",
  "message.delete",
  "invite.delete",
  "report.update",
  "voice.end_stream",
  "voice.disconnect",
]);
export type AuditAction = z.infer<typeof AuditAction>;

export const AuditLogEntry = z.object({
  id: Id,
  serverId: Id,
  actorId: Id,
  action: AuditAction,
  /** A user, role, channel, report or invite code, depending on the action. */
  targetId: z.string().max(64).nullable(),
  channelId: Id.nullable(),
  reason: z.string().nullable(),
  /** The fixed reason code, when the moderator gave one. */
  reasonCode: ReasonCode.nullable(),
  /** Small action-specific details, such as a timeout's end. */
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  createdAt: z.number().int(),
});
export type AuditLogEntry = z.infer<typeof AuditLogEntry>;

export const AuditLogQuery = z.object({
  action: AuditAction.optional(),
  actorId: Id.optional(),
  ...Page,
});
