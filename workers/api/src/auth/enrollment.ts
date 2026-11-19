/**
 * Everything that ends in registering a passkey: sign-up links, add-device
 * links, add-device approval from an existing device, and recovery codes.
 *
 * Each path creates an "enrollment": a short-lived token that allows one
 * passkey registration. Only the token's hash is stored.
 */
import { newId, type schemas } from "@bastion/shared";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  hashRecoveryCode,
  hashToken,
  newRecoveryCode,
  newToken,
  randomBytes,
  toBase64Url,
  verifyRecoveryCode,
} from "./crypto.js";
import { ENROLLMENT_TTL, type AuthDeps } from "./deps.js";
import { AuthError } from "./errors.js";
import { limitAccount } from "./rate-limit.js";
import { newSession, type Principal } from "./sessions.js";

type Purpose = "signup" | "add_device" | "recovery";

interface EnrollmentRow {
  token_hash: string;
  id: string;
  purpose: Purpose;
  email: string;
  user_id: string;
  approved: number;
  device_name: string | null;
  code: string | null;
  challenge: string | null;
  expires_at: number;
}

async function findUser(db: D1Database, email: string) {
  return db.prepare("SELECT id, recovery_hash FROM users WHERE email = ?").bind(email).first<{
    id: string;
    recovery_hash: string | null;
  }>();
}

async function createEnrollment(
  deps: AuthDeps,
  fields: { purpose: Purpose; email: string; userId: string; approved: boolean; deviceName?: string; code?: string },
): Promise<{ id: string; token: string; expiresAt: number }> {
  const token = newToken();
  const id = newId();
  const expiresAt = deps.now() + ENROLLMENT_TTL;
  await deps.db
    .prepare(
      `INSERT INTO enrollments (token_hash, id, purpose, email, user_id, approved, device_name, code, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      await hashToken(token),
      id,
      fields.purpose,
      fields.email,
      fields.userId,
      fields.approved ? 1 : 0,
      fields.deviceName ?? null,
      fields.code ?? null,
      expiresAt,
    )
    .run();
  return { id, token, expiresAt };
}

function enrollLink(deps: AuthDeps, token: string): string {
  // Token goes in the fragment so it never reaches server logs or referrers.
  return `${deps.appOrigin}/enroll#token=${token}`;
}

async function sendEmail(deps: AuthDeps, to: string, subject: string, text: string): Promise<void> {
  await limitAccount(deps.db, "emailSend", to, deps.now());
  await deps.email.send({ to, subject, text });
}

// ---------------------------------------------------------------- sign-up

/**
 * Always succeeds from the caller's point of view, so it can't be used to
 * find out whether an email has an account.
 */
export async function startSignup(deps: AuthDeps, email: string): Promise<void> {
  await limitAccount(deps.db, "signupStart", email, deps.now());
  const existing = await findUser(deps.db, email);
  if (existing) {
    await sendEmail(
      deps,
      email,
      "You already have a Bastion account",
      "Someone tried to sign up with this email. You already have an account, so sign in with your passkey instead.\n\nIf this wasn't you, you can ignore this email.",
    );
    return;
  }
  const { token } = await createEnrollment(deps, { purpose: "signup", email, userId: newId(), approved: true });
  await sendEmail(
    deps,
    email,
    "Confirm your email for Bastion",
    `Open this link to finish creating your account. It expires in 15 minutes.\n\n${enrollLink(deps, token)}\n\nIf you didn't ask for this, ignore this email.`,
  );
}

// ---------------------------------------------------------------- adding a device

/** Email a link that lets a new device register a passkey. Silent for unknown emails. */
export async function sendDeviceLink(deps: AuthDeps, email: string): Promise<void> {
  const user = await findUser(deps.db, email);
  if (!user) return;
  const { token } = await createEnrollment(deps, { purpose: "add_device", email, userId: user.id, approved: true });
  await sendEmail(
    deps,
    email,
    "Add a device to your Bastion account",
    `Open this link on the new device to add it. It expires in 15 minutes.\n\n${enrollLink(deps, token)}\n\nIf you didn't ask for this, ignore this email and nothing will change.`,
  );
}

/**
 * A new device asks to be added. An existing signed-in device must approve it.
 * The new device keeps the token and polls registration options until approved.
 * Unknown emails get a response of the same shape that never gets approved.
 */
export async function requestDeviceApproval(
  deps: AuthDeps,
  email: string,
  deviceName: string,
): Promise<{ requestId: string; token: string; code: string; expiresAt: number }> {
  await limitAccount(deps.db, "deviceRequest", email, deps.now());
  const code = matchCode();
  const user = await findUser(deps.db, email);
  if (!user) return { requestId: newId(), token: newToken(), code, expiresAt: deps.now() + ENROLLMENT_TTL };
  const { id, token, expiresAt } = await createEnrollment(deps, {
    purpose: "add_device",
    email,
    userId: user.id,
    approved: false,
    deviceName,
    code,
  });
  return { requestId: id, token, code, expiresAt };
}

/** Six digits shown on both devices so the user can check they match. */
function matchCode(): string {
  const [a, b, c] = randomBytes(3);
  return String(((a! << 16) | (b! << 8) | c!) % 1_000_000).padStart(6, "0");
}

export async function listDeviceRequests(deps: AuthDeps, principal: Principal): Promise<schemas.PendingDeviceRequest[]> {
  const { results } = await deps.db
    .prepare(
      `SELECT id, device_name, code, expires_at FROM enrollments
       WHERE user_id = ? AND purpose = 'add_device' AND approved = 0 AND expires_at > ?
       ORDER BY id`,
    )
    .bind(principal.userId, deps.now())
    .all<{ id: string; device_name: string; code: string; expires_at: number }>();
  return results.map((r) => ({ id: r.id, deviceName: r.device_name, code: r.code, expiresAt: r.expires_at }));
}

export async function approveDeviceRequest(deps: AuthDeps, principal: Principal, requestId: string): Promise<void> {
  const result = await deps.db
    .prepare(
      `UPDATE enrollments SET approved = 1
       WHERE id = ? AND user_id = ? AND purpose = 'add_device' AND approved = 0 AND expires_at > ?`,
    )
    .bind(requestId, principal.userId, deps.now())
    .run();
  if (result.meta.changes !== 1) throw new AuthError(404, "not_found");
}

export async function denyDeviceRequest(deps: AuthDeps, principal: Principal, requestId: string): Promise<void> {
  const result = await deps.db
    .prepare("DELETE FROM enrollments WHERE id = ? AND user_id = ? AND purpose = 'add_device' AND approved = 0")
    .bind(requestId, principal.userId)
    .run();
  if (result.meta.changes !== 1) throw new AuthError(404, "not_found");
}

// ---------------------------------------------------------------- recovery

// Hashed once at startup so unknown emails cost the same Argon2id work.
let dummyHash: Promise<string> | undefined;

/**
 * Trade the one-time recovery code for an enrollment token. The code is
 * burned immediately; registering the new passkey issues a fresh one.
 */
export async function redeemRecoveryCode(deps: AuthDeps, email: string, code: string): Promise<{ token: string }> {
  await limitAccount(deps.db, "recover", email, deps.now());
  const user = await findUser(deps.db, email);
  dummyHash ??= hashRecoveryCode("0".repeat(20));
  const stored = user?.recovery_hash ?? (await dummyHash);
  const ok = await verifyRecoveryCode(code, stored);
  if (!user || !user.recovery_hash || !ok) throw new AuthError(401, "invalid_recovery_code");

  const burned = await deps.db
    .prepare("UPDATE users SET recovery_hash = NULL WHERE id = ? AND recovery_hash = ?")
    .bind(user.id, user.recovery_hash)
    .run();
  if (burned.meta.changes !== 1) throw new AuthError(401, "invalid_recovery_code");

  const { token } = await createEnrollment(deps, { purpose: "recovery", email, userId: user.id, approved: true });
  await sendEmail(
    deps,
    email,
    "Your Bastion recovery code was used",
    "Your recovery code was just used to add a new device to your account. If this wasn't you, revoke unknown devices from Settings, Sign-in and devices.",
  );
  return { token };
}

// ---------------------------------------------------------------- passkey registration

async function loadEnrollment(deps: AuthDeps, token: string): Promise<EnrollmentRow> {
  const row = await deps.db
    .prepare("SELECT * FROM enrollments WHERE token_hash = ? AND expires_at > ?")
    .bind(await hashToken(token), deps.now())
    .first<EnrollmentRow>();
  if (!row) throw new AuthError(401, "invalid_token");
  if (!row.approved) throw new AuthError(409, "pending_approval");
  return row;
}

export async function registrationOptions(deps: AuthDeps, token: string) {
  const enrollment = await loadEnrollment(deps, token);
  const { results } = await deps.db
    .prepare("SELECT credential_id FROM devices WHERE user_id = ?")
    .bind(enrollment.user_id)
    .all<{ credential_id: string }>();
  const options = await deps.passkeys.registrationOptions({
    id: enrollment.user_id,
    email: enrollment.email,
    exclude: results.map((r) => r.credential_id),
  });
  await deps.db
    .prepare("UPDATE enrollments SET challenge = ? WHERE token_hash = ?")
    .bind(options.challenge, enrollment.token_hash)
    .run();
  return options;
}

export interface Registered {
  tokens: schemas.SessionTokens;
  /** Present after sign-up and recovery. Shown once, never stored in plain text. */
  recoveryCode?: string;
}

export async function registerPasskey(
  deps: AuthDeps,
  token: string,
  deviceName: string,
  response: RegistrationResponseJSON,
): Promise<Registered> {
  const now = deps.now();
  // Consume the enrollment up front so a token can never register twice.
  const enrollment = await deps.db
    .prepare("DELETE FROM enrollments WHERE token_hash = ? AND expires_at > ? AND approved = 1 RETURNING *")
    .bind(await hashToken(token), now)
    .first<EnrollmentRow>();
  if (!enrollment?.challenge) throw new AuthError(401, "invalid_token");

  const credential = await deps.passkeys.verifyRegistration(response, enrollment.challenge);
  if (!credential) throw new AuthError(400, "passkey_not_verified");

  const userId = enrollment.user_id;
  const deviceId = newId();
  const statements: D1PreparedStatement[] = [];
  let recoveryCode: string | undefined;

  if (enrollment.purpose === "signup" || enrollment.purpose === "recovery") {
    recoveryCode = newRecoveryCode();
    const recoveryHash = await hashRecoveryCode(recoveryCode.replace(/-/g, ""));
    statements.push(
      enrollment.purpose === "signup"
        ? deps.db
            .prepare("INSERT INTO users (id, email, recovery_hash, created_at) VALUES (?, ?, ?, ?)")
            .bind(userId, enrollment.email, recoveryHash, now)
        : deps.db.prepare("UPDATE users SET recovery_hash = ? WHERE id = ?").bind(recoveryHash, userId),
    );
  }

  statements.push(
    deps.db
      .prepare(
        `INSERT INTO devices (id, user_id, name, credential_id, public_key, counter, transports, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        deviceId,
        userId,
        deviceName,
        credential.id,
        toBase64Url(credential.publicKey),
        credential.counter,
        credential.transports ? JSON.stringify(credential.transports) : null,
        now,
        now,
      ),
  );
  const session = await newSession(deps.db, userId, deviceId, now);
  statements.push(session.statement);

  try {
    await deps.db.batch(statements);
  } catch (err) {
    // Email taken by a concurrent sign-up, or passkey already registered.
    if (String(err).includes("UNIQUE")) throw new AuthError(409, "already_registered");
    throw err;
  }
  return recoveryCode ? { tokens: session.tokens, recoveryCode } : { tokens: session.tokens };
}
