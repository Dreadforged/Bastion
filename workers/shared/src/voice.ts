import { z } from "zod";
import { Id } from "./ids.js";

/**
 * Voice channels and screen share. Media goes through LiveKit; the Worker only
 * decides who may join and hands out short-lived access tokens.
 *
 * Privacy: LiveKit sees a random room id and a random participant id, never a
 * channel name, user id or display name. The Server object keeps the mapping
 * from participant to user only while the person is in the call.
 */

export type Plan = "free" | "plus";
export const Plan = z.enum(["free", "plus"]);

export const VOICE_LIMITS = {
  /** LiveKit access tokens live this long. */
  tokenTtlSeconds: 5 * 60,
  /**
   * A voice state not refreshed for this long is dropped. Clients send
   * `PATCH /servers/:id/voice` about every 30 seconds while in a call.
   */
  leaseSeconds: 90,
} as const;

export interface StreamQuality {
  /** Vertical resolution in pixels (720 means 1280x720). */
  height: number;
  fps: number;
  /** Most viewers one stream can have. */
  maxViewers: number;
  /** Encoder ceiling for the sender, bits per second. */
  maxBitrate: number;
}

/** Screen share tiers. Quality and viewer caps follow the streamer's plan. */
export const STREAM_QUALITY: Readonly<Record<Plan, StreamQuality>> = {
  free: { height: 720, fps: 30, maxViewers: 25, maxBitrate: 2_500_000 },
  plus: { height: 1080, fps: 60, maxViewers: 50, maxBitrate: 6_000_000 },
};

/** Opaque ids handed to LiveKit: 128 random bits as hex. */
export const VoiceOpaqueId = z.string().regex(/^[0-9a-f]{32}$/);

/** One person's place in a call. */
export const VoiceState = z.object({
  serverId: Id,
  userId: Id,
  /** The voice channel they are in, or null when they have left. */
  channelId: Id.nullable(),
  /** Their LiveKit identity for this call, or null when they have left. Random per join. */
  participantId: VoiceOpaqueId.nullable(),
  selfMute: z.boolean(),
  selfDeaf: z.boolean(),
  streaming: z.boolean(),
});
export type VoiceState = z.infer<typeof VoiceState>;

// ------------------------------------------------------------------ requests

export const VoiceTokenRequest = z.object({
  channelId: Id,
  /** Ask for the right to share the screen. Needs STREAM. */
  screenShare: z.boolean().default(false),
});

export const VoiceTokenResponse = z.object({
  /** LiveKit server URL (wss://). */
  url: z.string(),
  token: z.string(),
  expiresAt: z.number().int(),
  roomId: VoiceOpaqueId,
  participantId: VoiceOpaqueId,
  canPublish: z.boolean(),
  canShare: z.boolean(),
  /** What this person's screen share is allowed to be. */
  quality: z.object({
    height: z.number().int(),
    fps: z.number().int(),
    maxViewers: z.number().int(),
    maxBitrate: z.number().int(),
  }),
});
export type VoiceTokenResponse = z.infer<typeof VoiceTokenResponse>;

/** Self state. Every field is optional; sending none still renews the lease. */
export const UpdateVoiceStateRequest = z.object({
  selfMute: z.boolean().optional(),
  selfDeaf: z.boolean().optional(),
  streaming: z.boolean().optional(),
});
