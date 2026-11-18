import { z } from "zod";
import { Id } from "./ids.js";

/** Permission sets travel as decimal strings since JSON has no BigInt. */
export const PermissionString = z.string().regex(/^\d{1,20}$/);

export const Username = z
  .string()
  .min(2)
  .max(32)
  .regex(/^[a-z0-9_.]+$/, "lowercase letters, digits, _ and . only");

export const User = z.object({
  id: Id,
  username: Username,
  displayName: z.string().min(1).max(64).optional(),
});
export type User = z.infer<typeof User>;

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
});
export type Channel = z.infer<typeof Channel>;

/**
 * Message envelope. Content is end-to-end encrypted with MLS, so the server
 * only ever sees ciphertext.
 */
export const MessageEnvelope = z.object({
  id: Id,
  conversationId: Id,
  senderId: Id,
  ciphertext: z.base64(),
  epoch: z.number().int().nonnegative(),
});
export type MessageEnvelope = z.infer<typeof MessageEnvelope>;

/** Client to server WebSocket frames. */
export const ClientFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
  z.object({ type: z.literal("subscribe"), conversationId: Id }),
  z.object({ type: z.literal("send"), message: MessageEnvelope }),
]);
export type ClientFrame = z.infer<typeof ClientFrame>;

/** Server to client WebSocket frames. */
export const ServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("pong") }),
  z.object({ type: z.literal("message"), message: MessageEnvelope }),
  z.object({ type: z.literal("error"), code: z.string(), message: z.string() }),
]);
export type ServerFrame = z.infer<typeof ServerFrame>;
