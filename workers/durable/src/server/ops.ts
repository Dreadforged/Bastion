import { Id, schemas } from "@bastion/shared";
import { z } from "zod";

/**
 * Everything a client can ask a Server object to do. The Worker builds an op
 * from the route and validated body; the object parses it again before acting.
 */
export const ServerOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("server.update"), body: schemas.UpdateServerRequest }),
  /** Owner only. Removes everything and tells every member. */
  z.object({ type: z.literal("server.delete") }),

  z.object({ type: z.literal("channel.create"), body: schemas.CreateChannelRequest }),
  z.object({ type: z.literal("channel.update"), channelId: Id, body: schemas.UpdateChannelRequest }),
  z.object({ type: z.literal("channel.delete"), channelId: Id }),
  z.object({
    type: z.literal("override.put"),
    channelId: Id,
    kind: schemas.OverrideKind,
    targetId: Id,
    body: schemas.PutOverrideRequest,
  }),
  z.object({ type: z.literal("override.delete"), channelId: Id, kind: schemas.OverrideKind, targetId: Id }),

  z.object({ type: z.literal("role.create"), body: schemas.CreateRoleRequest }),
  z.object({ type: z.literal("role.update"), roleId: Id, body: schemas.UpdateRoleRequest }),
  z.object({ type: z.literal("role.delete"), roleId: Id }),

  z.object({ type: z.literal("member.role.add"), userId: Id, roleId: Id }),
  z.object({ type: z.literal("member.role.remove"), userId: Id, roleId: Id }),
  /** Kick, or leave when userId is the caller. */
  z.object({ type: z.literal("member.remove"), userId: Id, body: schemas.ReasonRequest.default({}) }),
  z.object({ type: z.literal("member.timeout"), userId: Id, body: schemas.TimeoutRequest }),
  z.object({ type: z.literal("member.timeout.remove"), userId: Id, body: schemas.ReasonRequest.default({}) }),
  z.object({ type: z.literal("ban.put"), userId: Id, body: schemas.BanRequest.default({ deleteMessageSeconds: 0 }) }),
  z.object({ type: z.literal("ban.delete"), userId: Id, body: schemas.ReasonRequest.default({}) }),
  z.object({ type: z.literal("bans.list"), query: schemas.BanListQuery }),

  z.object({ type: z.literal("report.create"), body: schemas.CreateReportRequest }),
  z.object({ type: z.literal("reports.list"), query: schemas.ReportListQuery }),
  z.object({ type: z.literal("report.update"), reportId: Id, body: schemas.UpdateReportRequest }),
  z.object({ type: z.literal("audit.list"), query: schemas.AuditLogQuery }),

  z.object({ type: z.literal("messages.list"), channelId: Id, query: schemas.MessageHistoryQuery }),
  z.object({ type: z.literal("message.create"), channelId: Id, body: schemas.CreateMessageRequest }),
  z.object({
    type: z.literal("message.update"),
    channelId: Id,
    messageId: Id,
    body: schemas.UpdateMessageRequest,
  }),
  z.object({ type: z.literal("message.delete"), channelId: Id, messageId: Id }),
  z.object({ type: z.literal("typing"), channelId: Id }),

  /** Join or refresh a voice channel. The Worker adds the plan; clients cannot set it. */
  z.object({ type: z.literal("voice.join"), channelId: Id, screenShare: z.boolean().default(false), plan: schemas.Plan.default("free") }),
  z.object({ type: z.literal("voice.leave") }),
  /** Self mute, deafen, stream on or off. Also renews the lease. */
  z.object({ type: z.literal("voice.update"), body: schemas.UpdateVoiceStateRequest }),
  z.object({ type: z.literal("voice.list") }),
  z.object({ type: z.literal("voice.end_stream"), userId: Id, body: schemas.ReasonRequest.default({}) }),
  z.object({ type: z.literal("voice.disconnect"), userId: Id, body: schemas.ReasonRequest.default({}) }),

  /** Can this member view the channel, or attach files to it? Used by the file routes. */
  z.object({ type: z.literal("channel.check"), channelId: Id, need: z.enum(["view", "attach_files"]) }),

  z.object({ type: z.literal("invite.create"), body: schemas.CreateInviteRequest }),
  z.object({ type: z.literal("invite.delete"), code: schemas.InviteCode }),
  z.object({ type: z.literal("invite.preview"), code: schemas.InviteCode }),
  z.object({ type: z.literal("invite.accept"), code: schemas.InviteCode }),
]);
export type ServerOp = z.infer<typeof ServerOp>;
export type ServerOpInput = z.input<typeof ServerOp>;

/** Ops that change state. Only these use idempotency keys. */
export const READ_ONLY_OPS: ReadonlySet<ServerOp["type"]> = new Set([
  "messages.list",
  "invite.preview",
  "typing",
  "bans.list",
  "reports.list",
  "audit.list",
  // State updates are absolute and renewed every 30 seconds, so they skip idempotency keys.
  "voice.update",
  "voice.list",
  "channel.check",
]);

/**
 * What the Worker must tell LiveKit after a voice change. Applying one twice
 * is harmless, so a replayed reply is safe.
 */
export type VoiceEffect =
  | { kind: "remove"; roomId: string; participantId: string }
  | { kind: "restrict"; roomId: string; participantId: string; canPublish: boolean; canShare: boolean };

/** What a Server object answers. `effects` are for the Worker, not the client. */
export interface Reply {
  status: number;
  body: unknown;
  effects?: {
    inviteCreated?: { code: string; expiresAt: number | null };
    inviteGone?: string;
    serverDeleted?: true;
    voice?: VoiceEffect[];
  };
}
