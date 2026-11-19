import { z } from "zod";
import { Id } from "./ids.js";
import { ConversationId } from "./conversations.js";
import { VoiceOpaqueId, VoiceTokenResponse } from "./voice.js";

/**
 * Calls inside a direct message: ring, answer or decline, then a LiveKit room
 * for the two people. The DM's own Conversation object holds the call state,
 * so only its two members can start, answer or end it.
 *
 * Keys: a call has its own fresh MLS `group` conversation (`groupConversationId`),
 * made by the caller before ringing, so call keys have nothing to do with the
 * DM's message history. See docs/adr/0004-voice-e2ee-key-derivation.md.
 */

export const CALL_LIMITS = {
  /** How long a call rings before it counts as missed. */
  ringSeconds: 45,
  /** An answered call with no renewal for this long is over. Clients renew about every 30 seconds. */
  leaseSeconds: 90,
  /** The same person cannot start another call this soon after their last one. */
  redialSeconds: 5,
} as const;

export const CallState = z.enum(["ringing", "active", "ended"]);
export type CallState = z.infer<typeof CallState>;

export const CallEndReason = z.enum(["declined", "cancelled", "missed", "ended", "timeout"]);
export type CallEndReason = z.infer<typeof CallEndReason>;

/** What both people may see about a call. The LiveKit room id is not part of it. */
export const DmCall = z.object({
  id: VoiceOpaqueId,
  conversationId: ConversationId,
  callerId: Id,
  calleeId: Id,
  /** The call's MLS group; the callee finds their Welcome there. */
  groupConversationId: ConversationId,
  state: CallState,
  endReason: CallEndReason.nullable(),
  /** The call counts as missed after this time unless answered. */
  ringExpiresAt: z.number().int(),
  createdAt: z.number().int(),
});
export type DmCall = z.infer<typeof DmCall>;

export const StartCallRequest = z.object({
  groupConversationId: ConversationId,
  /** Ask for the right to share the screen. Decided at join; tokens cannot be widened later. */
  screenShare: z.boolean().default(false),
});

export const AnswerCallRequest = z.object({
  screenShare: z.boolean().default(false),
});

/** The reply to starting or answering a call: a LiveKit token plus the call. */
export const DmCallToken = VoiceTokenResponse.extend({ call: DmCall });
export type DmCallToken = z.infer<typeof DmCallToken>;
