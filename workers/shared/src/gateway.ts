import { z } from "zod";
import { Id } from "./ids.js";
import { ConversationId } from "./conversations.js";
import { AuditLogEntry, Report } from "./moderation.js";
import { Channel, Member, Message, Role, Server, VisibleStatus } from "./servers.js";
import { VoiceState } from "./voice.js";
import { DmCall } from "./calls.js";

/**
 * Gateway: the realtime WebSocket each client keeps open to its UserSession.
 * Reads are pushed here; writes go over HTTPS.
 *
 * Connect to GET /gateway with the subprotocols `bastion.v1` and
 * `bastion.auth.<accessToken>`, then send `identify` (fresh start, answered
 * with READY) or `resume` with the last sequence number seen (answered with
 * the missed events and RESUMED, or `invalid_session` if they are gone).
 *
 * Events are upserts: a client may see the same event twice around READY and
 * resume, and should key everything by id.
 */

export const GATEWAY_PROTOCOL = "bastion.v1";
export const GATEWAY_AUTH_PREFIX = "bastion.auth.";

export const GATEWAY_LIMITS = {
  /** Missed events are kept this long for resume. */
  replayWindowMs: 24 * 60 * 60 * 1000,
  /** And at most this many per user. */
  maxReplayEvents: 5000,
  /** Largest client frame. Client frames are tiny. */
  maxFrameBytes: 1024,
  /** Per connection: a burst of this many frames... */
  frameBurst: 20,
  /** ...refilled at this many per second. */
  framesPerSecond: 2,
} as const;

/** Close codes sent by the server. */
export const CloseCode = {
  /** The frame could not be parsed or was not allowed. */
  BAD_FRAME: 4000,
  /** The access token's session ended. */
  SESSION_ENDED: 4004,
  RATE_LIMITED: 4008,
  FRAME_TOO_LARGE: 4009,
} as const;

export const ServerSnapshot = z.object({
  server: Server,
  roles: z.array(Role),
  /** Only channels this user can view. */
  channels: z.array(Channel),
  members: z.array(Member),
  presences: z.array(z.object({ userId: Id, status: VisibleStatus })),
  /** Who is in a voice channel right now. Current state only, never history. */
  voiceStates: z.array(VoiceState.extend({ channelId: Id, participantId: z.string() })),
});
export type ServerSnapshot = z.infer<typeof ServerSnapshot>;

const ServerRef = z.object({ id: Id });
const ChannelRef = z.object({ id: Id, serverId: Id });
const RoleRef = z.object({ id: Id, serverId: Id });
const MemberRef = z.object({ serverId: Id, userId: Id });
const MessageRef = z.object({ id: Id, channelId: Id, serverId: Id });

/** Every event a server can dispatch, keyed by name. */
export const EventPayloads = {
  SERVER_CREATE: ServerSnapshot,
  SERVER_UPDATE: Server,
  SERVER_DELETE: ServerRef,
  CHANNEL_CREATE: Channel,
  CHANNEL_UPDATE: Channel,
  CHANNEL_DELETE: ChannelRef,
  ROLE_CREATE: Role,
  ROLE_UPDATE: Role,
  ROLE_DELETE: RoleRef,
  MEMBER_ADD: Member,
  MEMBER_UPDATE: Member,
  MEMBER_REMOVE: MemberRef,
  MESSAGE_CREATE: Message,
  MESSAGE_UPDATE: Message,
  MESSAGE_DELETE: MessageRef,
  PRESENCE_UPDATE: z.object({ serverId: Id, userId: Id, status: VisibleStatus }),
  TYPING_START: z.object({ serverId: Id, channelId: Id, userId: Id, at: z.number().int() }),
  /**
   * Someone joined, left, moved between or changed state in voice channels.
   * `channelId: null` means they left. Only to members who can view the
   * channel. Not replayed on resume: refetch GET /servers/:id/voice instead.
   */
  VOICE_STATE_UPDATE: VoiceState,
  /** Only to members who can manage messages in the report's channel. */
  REPORT_CREATE: Report,
  REPORT_UPDATE: Report,
  /** Only to members with VIEW_AUDIT_LOG. */
  AUDIT_LOG_ENTRY_CREATE: AuditLogEntry,
  /**
   * New items in an encrypted conversation, up to `seq`. Carries no content;
   * clients fetch the envelopes. Also sent when the user is added.
   */
  CONVERSATION_UPDATE: z.object({ conversationId: ConversationId, seq: z.number().int().nonnegative() }),
  /**
   * A direct message call started ringing, was answered, or ended. Sent to
   * both people on every device they have open, so a second device stops
   * ringing when the first answers. Not replayed on resume: a ring that
   * arrives while the client is offline is simply missed.
   */
  CALL_UPDATE: DmCall,
} as const;

export type EventName = keyof typeof EventPayloads;
export const EventName = z.enum(Object.keys(EventPayloads) as [EventName, ...EventName[]]);

export type EventPayload<T extends EventName> = z.infer<(typeof EventPayloads)[T]>;

/** An event as the Server object hands it to a UserSession. */
export type GatewayEvent = {
  [T in EventName]: { id: string; t: T; d: EventPayload<T> };
}[EventName];

/** Events that are not kept for resume; missing one is harmless. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventName> = new Set(["TYPING_START", "VOICE_STATE_UPDATE", "CALL_UPDATE"]);

export const ReadyPayload = z.object({
  userId: Id,
  /** Resume from here. Events after READY carry higher numbers. */
  seq: z.number().int().nonnegative(),
  servers: z.array(ServerSnapshot),
});
export type ReadyPayload = z.infer<typeof ReadyPayload>;

/** Client to server. */
export const GatewayClientFrame = z.discriminatedUnion("op", [
  z.object({ op: z.literal("ping") }),
  z.object({ op: z.literal("identify") }),
  z.object({ op: z.literal("resume"), seq: z.number().int().nonnegative() }),
]);
export type GatewayClientFrame = z.infer<typeof GatewayClientFrame>;

/**
 * Server to client. `dispatch` frames carry `s`, the per-user sequence
 * number, except for ephemeral events.
 */
export type GatewayServerFrame =
  | { op: "pong" }
  | { op: "ready"; d: ReadyPayload }
  | { op: "resumed"; seq: number }
  | { op: "invalid_session" }
  | { op: "dispatch"; t: EventName; s?: number; d: unknown }
  | { op: "error"; code: string };
