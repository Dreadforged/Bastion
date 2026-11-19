import type { EmailSender } from "./email.js";
import type { Passkeys } from "./passkeys.js";

export interface AuthDeps {
  db: D1Database;
  email: EmailSender;
  passkeys: Passkeys;
  /** Web app origin, used to build emailed links. */
  appOrigin: string;
  now: () => number;
}

export const MINUTE = 60_000;
export const ACCESS_TTL = 15 * MINUTE;
export const REFRESH_TTL = 30 * 24 * 60 * MINUTE;
/** Sign-up links, add-device links and device approval requests. */
export const ENROLLMENT_TTL = 15 * MINUTE;
export const CHALLENGE_TTL = 5 * MINUTE;
