import { newId, type schemas } from "@bastion/shared";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { fromBase64Url } from "./crypto.js";
import { CHALLENGE_TTL, type AuthDeps } from "./deps.js";
import { AuthError } from "./errors.js";
import { limitAccount } from "./rate-limit.js";
import { newSession } from "./sessions.js";

export async function signInOptions(deps: AuthDeps) {
  const options = await deps.passkeys.authenticationOptions();
  const challengeId = newId();
  await deps.db
    .prepare("INSERT INTO challenges (id, challenge, expires_at) VALUES (?, ?, ?)")
    .bind(challengeId, options.challenge, deps.now() + CHALLENGE_TTL)
    .run();
  return { challengeId, options };
}

export async function signIn(
  deps: AuthDeps,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Promise<schemas.SessionTokens> {
  const now = deps.now();
  // Challenges are single use whether or not verification succeeds.
  const challenge = await deps.db
    .prepare("DELETE FROM challenges WHERE id = ? AND expires_at > ? RETURNING challenge")
    .bind(challengeId, now)
    .first<{ challenge: string }>();
  if (!challenge) throw new AuthError(401, "invalid_challenge");

  await limitAccount(deps.db, "signIn", response.id, now);

  const device = await deps.db
    .prepare("SELECT id, user_id, credential_id, public_key, counter, transports FROM devices WHERE credential_id = ?")
    .bind(response.id)
    .first<{
      id: string;
      user_id: string;
      credential_id: string;
      public_key: string;
      counter: number;
      transports: string | null;
    }>();
  if (!device) throw new AuthError(401, "unknown_passkey");

  const result = await deps.passkeys.verifyAuthentication(response, challenge.challenge, {
    id: device.credential_id,
    publicKey: fromBase64Url(device.public_key),
    counter: device.counter,
    ...(device.transports ? { transports: JSON.parse(device.transports) as string[] } : {}),
  });
  if (!result) throw new AuthError(401, "passkey_not_verified");

  const session = await newSession(deps.db, device.user_id, device.id, now);
  await deps.db.batch([
    deps.db.prepare("UPDATE devices SET counter = ?, last_seen_at = ? WHERE id = ?").bind(result.newCounter, now, device.id),
    session.statement,
  ]);
  return session.tokens;
}
