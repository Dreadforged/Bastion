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

export * from "./auth.js";
export * from "./safety.js";
export * from "./servers.js";
export * from "./gateway.js";
export * from "./moderation.js";
export * from "./conversations.js";
export * from "./voice.js";
export * from "./calls.js";
export * from "./files.js";
export * from "./account.js";
