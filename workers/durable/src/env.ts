import type { Server } from "./server.js";
import type { UserSession } from "./user-session.js";

/** Bindings the Durable Objects use to reach each other. */
export interface DurableEnv {
  USER_SESSION: DurableObjectNamespace<UserSession>;
  SERVER: DurableObjectNamespace<Server>;
}

/**
 * Headers the API Worker sets on a gateway upgrade after authenticating it.
 * Lives here, away from the object classes, so the Worker can import it in
 * plain Node tests.
 */
export const SESSION_HEADERS = {
  userId: "x-bastion-user",
  deviceId: "x-bastion-device",
  sessionId: "x-bastion-session",
} as const;
