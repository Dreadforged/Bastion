import type { EmailSender } from "./email.js";
import type { Passkeys } from "./passkeys.js";

export interface AuthDeps {
  db: D1Database;
  email: EmailSender;
  passkeys: Passkeys;
  /** Web app origin, used to build emailed links. */
  appOrigin: string;
  now: () => number;
  /**
   * Close the gateway sockets of auth sessions that just ended. Optional so
   * auth tests can run without Durable Objects.
   */
  endSessions?: ((userId: string, sessionIds: string[]) => Promise<void>) | undefined;
}

/** Close ended sessions' sockets. Best effort: the tokens are already dead. */
export async function closeSockets(deps: AuthDeps, ended: { userId: string; sessionId: string }[]): Promise<void> {
  if (!deps.endSessions || ended.length === 0) return;
  const byUser = new Map<string, string[]>();
  for (const { userId, sessionId } of ended) byUser.set(userId, [...(byUser.get(userId) ?? []), sessionId]);
  await Promise.allSettled([...byUser].map(([userId, ids]) => deps.endSessions!(userId, ids)));
}

export const MINUTE = 60_000;
export const ACCESS_TTL = 15 * MINUTE;
export const REFRESH_TTL = 30 * 24 * 60 * MINUTE;
/** Sign-up links, add-device links and device approval requests. */
export const ENROLLMENT_TTL = 15 * MINUTE;
export const CHALLENGE_TTL = 5 * MINUTE;
