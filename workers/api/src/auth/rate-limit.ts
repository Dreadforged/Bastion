import { hashToken } from "./crypto.js";
import { AuthError } from "./errors.js";

export interface Limit {
  /** Max requests per window. */
  max: number;
  windowMs: number;
}

export const LIMITS = {
  signupStart: { max: 3, windowMs: 60 * 60_000 },
  emailSend: { max: 5, windowMs: 60 * 60_000 },
  deviceRequest: { max: 5, windowMs: 60 * 60_000 },
  recover: { max: 5, windowMs: 60 * 60_000 },
  signIn: { max: 10, windowMs: 5 * 60_000 },
} satisfies Record<string, Limit>;

/**
 * Per-account limit in D1, keyed by a hash of the email or credential id.
 * Throws a 429 once the window is used up.
 */
export async function limitAccount(
  db: D1Database,
  name: keyof typeof LIMITS,
  subject: string,
  now: number,
): Promise<void> {
  const { max, windowMs } = LIMITS[name];
  const key = `${name}:${await hashToken(subject)}`;
  const windowEnd = Math.floor(now / windowMs) * windowMs + windowMs;
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, window_end, count) VALUES (?1, ?2, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN window_end = ?2 THEN count + 1 ELSE 1 END,
         window_end = ?2
       RETURNING count`,
    )
    .bind(key, windowEnd)
    .first<{ count: number }>();
  if (!row || row.count > max) throw new AuthError(429, "rate_limited");
}

/**
 * Per-IP limit using the Workers rate limit binding. The IP is only handed to
 * the binding as a key; it is never written to D1 or logs.
 */
export async function limitIp(binding: RateLimit | undefined, request: Request): Promise<void> {
  if (!binding) return;
  const ip = request.headers.get("cf-connecting-ip");
  if (!ip) return;
  const { success } = await binding.limit({ key: ip });
  if (!success) throw new AuthError(429, "rate_limited");
}
