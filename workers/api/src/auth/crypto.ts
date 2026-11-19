import { argon2idAsync } from "@noble/hashes/argon2.js";

const encoder = new TextEncoder();

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** 32 random bytes, base64url. Used for every bearer token and emailed link. */
export function newToken(): string {
  return toBase64Url(randomBytes(32));
}

/**
 * SHA-256 of a high-entropy token. Tokens are random 256-bit values, so a
 * fast hash is enough; only low-entropy secrets need Argon2id.
 */
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return toBase64Url(new Uint8Array(digest));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

// ---------------------------------------------------------------- recovery codes

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 20 Crockford base32 chars (100 bits), grouped as XXXXX-XXXXX-XXXXX-XXXXX. */
export function newRecoveryCode(): string {
  const bytes = randomBytes(20);
  let code = "";
  for (const b of bytes) code += CROCKFORD[b & 31];
  return code.match(/.{5}/g)!.join("-");
}

// OWASP minimum for Argon2id: 19 MiB, 2 iterations, 1 lane.
const ARGON = { m: 19456, t: 2, p: 1, dkLen: 32 } as const;

/** Hash a normalized recovery code (no dashes, uppercase). */
export async function hashRecoveryCode(normalized: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await argon2idAsync(encoder.encode(normalized), salt, ARGON);
  return `argon2id$m=${ARGON.m},t=${ARGON.t},p=${ARGON.p}$${toBase64Url(salt)}$${toBase64Url(hash)}`;
}

export async function verifyRecoveryCode(normalized: string, stored: string): Promise<boolean> {
  const match = stored.match(/^argon2id\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/);
  if (!match) return false;
  const [, m, t, p, salt, expected] = match;
  const hash = await argon2idAsync(encoder.encode(normalized), fromBase64Url(salt!), {
    m: Number(m),
    t: Number(t),
    p: Number(p),
    dkLen: 32,
  });
  return timingSafeEqual(hash, fromBase64Url(expected!));
}
