import { schemas } from "@bastion/shared";
import type { Api } from "./http.js";

/**
 * Attachments in encrypted channels. Each file is encrypted on this device with
 * its own random AES-256-GCM key, uploaded as opaque bytes straight to storage
 * through a pre-signed URL, and the key travels inside the encrypted message.
 * The server never sees the name, the type or the contents.
 */

export type Attachment = NonNullable<schemas.MessagePayload["attachments"]>[number];

export const MAX_ATTACHMENTS = 10;
/** The GCM tag adds 16 bytes, so the file itself can be this much smaller than the upload limit. */
export const MAX_PLAIN_BYTES = schemas.FILE_LIMITS.maxBytes - 16;

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export class AttachmentError extends Error {
  constructor(readonly code: "too_big" | "empty" | "upload_failed" | "download_failed" | "cannot_decrypt" | "too_many") {
    super(code);
  }
}

/** Encrypt a file's bytes with a fresh key. */
export async function encryptFile(bytes: Uint8Array<ArrayBuffer>): Promise<{ cipher: Uint8Array<ArrayBuffer>; key: string; nonce: string }> {
  const rawKey = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, bytes));
  return { cipher, key: toB64(rawKey), nonce: toB64(nonce) };
}

export async function decryptFile(cipher: Uint8Array<ArrayBuffer>, a: Pick<Attachment, "key" | "nonce">): Promise<Uint8Array<ArrayBuffer>> {
  try {
    const key = await crypto.subtle.importKey("raw", fromB64(a.key), "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(a.nonce) }, key, cipher));
  } catch {
    throw new AttachmentError("cannot_decrypt");
  }
}

interface FetchLike {
  (input: string, init?: RequestInit): Promise<Response>;
}

/**
 * Encrypt and upload one file for a channel. Returns the entry to put in the
 * message. The `put` fetch is separate from the API client because the upload
 * goes to storage, not to our API, and must not carry our access token.
 */
export async function uploadChannelFile(
  api: Api,
  scope: { serverId: string; channelId: string },
  file: { name: string; type: string; bytes: Uint8Array<ArrayBuffer> },
  put: FetchLike = (...args) => fetch(...args),
): Promise<Attachment> {
  if (file.bytes.length === 0) throw new AttachmentError("empty");
  if (file.bytes.length > MAX_PLAIN_BYTES) throw new AttachmentError("too_big");
  const { cipher, key, nonce } = await encryptFile(file.bytes);
  const target = await api.post<schemas.UploadTarget>("/files/uploads", {
    scope: { type: "channel", ...scope },
    visibility: "private",
    size: cipher.length,
  });
  const res = await put(target.uploadUrl, { method: "PUT", headers: target.headers, body: cipher });
  if (!res.ok) throw new AttachmentError("upload_failed");
  await api.post(`/files/uploads/${target.fileId}/complete`);
  return {
    id: target.fileId,
    key,
    nonce,
    name: file.name.slice(0, 255),
    mime: (file.type || "application/octet-stream").slice(0, 127),
    size: file.bytes.length,
  };
}

/** Fetch and decrypt an attachment. */
export async function downloadAttachment(api: Api, a: Attachment, get: FetchLike = (...args) => fetch(...args)): Promise<Uint8Array<ArrayBuffer>> {
  const link = await api.get<schemas.FileUrl>(`/files/${a.id}/url`);
  const res = await get(link.url);
  if (!res.ok) throw new AttachmentError("download_failed");
  return decryptFile(new Uint8Array(await res.arrayBuffer()), a);
}

export function describeSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
