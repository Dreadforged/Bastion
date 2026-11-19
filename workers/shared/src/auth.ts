import { z } from "zod";
import { Id } from "./ids.js";

/** Emails are trimmed and lowercased before anything else sees them. */
export const Email = z.string().trim().toLowerCase().max(254).pipe(z.email());
export type Email = z.infer<typeof Email>;

export const DeviceName = z.string().trim().min(1).max(64);

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const Base64Url = z.string().min(1).max(4096).regex(BASE64URL);

/** Opaque 32 byte random tokens, base64url without padding. */
export const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "invalid token");

/** Recovery codes: 20 Crockford base32 chars, shown as XXXXX-XXXXX-XXXXX-XXXXX. */
export const RecoveryCode = z
  .string()
  .max(64)
  .transform((s) => s.toUpperCase().replace(/[\s-]/g, ""))
  .pipe(z.string().regex(/^[0-9A-HJKMNP-TV-Z]{20}$/, "invalid recovery code"));

/**
 * WebAuthn responses from the browser. Only the outer shape is checked here;
 * the WebAuthn library does the real verification.
 */
export const RegistrationResponse = z.looseObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: Base64Url,
    attestationObject: z.string().min(1).max(16384).regex(BASE64URL),
    transports: z.array(z.string().max(32)).max(8).optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

export const AuthenticationResponse = z.looseObject({
  id: Base64Url,
  rawId: Base64Url,
  type: z.literal("public-key"),
  response: z.looseObject({
    clientDataJSON: Base64Url,
    authenticatorData: Base64Url,
    signature: Base64Url,
    userHandle: Base64Url.optional(),
  }),
  clientExtensionResults: z.record(z.string(), z.unknown()),
});

// ---------------------------------------------------------------- requests

export const SignupStartRequest = z.object({ email: Email });

export const DeviceLinkRequest = z.object({ email: Email });

export const DeviceApprovalRequest = z.object({ email: Email, deviceName: DeviceName });

export const RecoverRequest = z.object({ email: Email, code: RecoveryCode });

export const RegisterOptionsRequest = z.object({ token: Token });

export const RegisterVerifyRequest = z.object({
  token: Token,
  deviceName: DeviceName,
  response: RegistrationResponse,
});

export const SignInVerifyRequest = z.object({
  challengeId: Id,
  response: AuthenticationResponse,
});

export const RefreshRequest = z.object({ refreshToken: Token });

// ---------------------------------------------------------------- responses

export const SessionTokens = z.object({
  accessToken: Token,
  accessExpiresAt: z.number().int(),
  refreshToken: Token,
  refreshExpiresAt: z.number().int(),
});
export type SessionTokens = z.infer<typeof SessionTokens>;

export const Device = z.object({
  id: Id,
  name: DeviceName,
  createdAt: z.number().int(),
  lastSeenAt: z.number().int().nullable(),
  current: z.boolean(),
});
export type Device = z.infer<typeof Device>;

export const PendingDeviceRequest = z.object({
  id: Id,
  deviceName: DeviceName,
  code: z.string(),
  expiresAt: z.number().int(),
});
export type PendingDeviceRequest = z.infer<typeof PendingDeviceRequest>;
