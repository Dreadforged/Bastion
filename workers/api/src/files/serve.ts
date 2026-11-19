import { Id, schemas } from "@bastion/shared";
import { timingSafeEqual, toBase64Url } from "../auth/crypto.js";

/**
 * Serving files from a domain of their own.
 *
 * Uploaded files are untrusted content, so they are served from a separate
 * origin (for example `files.example-usercontent.net`) that never sees the
 * app's cookies, tokens or storage. Each URL is signed for one file and a
 * short time; it carries no user id. The API host never serves file bytes.
 */

const encoder = new TextEncoder();

async function mac(secret: string, fileId: string, exp: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`file:${fileId}:${exp}`)));
}

/** A download URL for one file, good for `downloadUrlTtlSeconds`. */
export async function signFileUrl(
  secret: string,
  filesOrigin: string,
  fileId: string,
  now: number,
): Promise<{ url: string; expiresAt: number }> {
  const exp = Math.floor(now / 1000) + schemas.FILE_LIMITS.downloadUrlTtlSeconds;
  const sig = toBase64Url(await mac(secret, fileId, exp));
  return { url: `${filesOrigin.replace(/\/+$/, "")}/f/${fileId}?exp=${exp}&sig=${sig}`, expiresAt: exp * 1000 };
}

async function validSignature(secret: string, fileId: string, exp: number, sig: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return false;
  const expected = await mac(secret, fileId, exp);
  const given = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
  return timingSafeEqual(expected, given);
}

export interface ServeDeps {
  db: D1Database;
  files: R2Bucket;
  now: () => number;
  /** Origin the files are served from, e.g. https://files.example.net */
  filesOrigin: string;
  urlSecret: string;
}

/**
 * Headers that keep an uploaded file from doing anything but being shown or
 * downloaded: no sniffing, no scripts, no framing tricks, no referrer, no cookies.
 */
export function fileHeaders(contentType: string, inline: boolean, cacheSeconds: number): Headers {
  return new Headers({
    "content-type": contentType,
    "content-disposition": inline ? "inline" : "attachment",
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; sandbox",
    "cross-origin-resource-policy": "cross-origin",
    "cross-origin-opener-policy": "same-origin",
    "referrer-policy": "no-referrer",
    "cache-control": `private, max-age=${Math.max(0, cacheSeconds)}`,
    "access-control-allow-origin": "*",
  });
}

/**
 * GET /f/:id?exp=&sig= on the files host. Returns null for any other host or
 * path, so the API's own routes are unaffected.
 */
export async function handleFileServe(request: Request, deps: ServeDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.host !== new URL(deps.filesOrigin).host) return null;
  const match = url.pathname.match(/^\/f\/([^/]+)$/);
  if (!match) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });

  const fileId = Id.safeParse(match[1]);
  const exp = Number(url.searchParams.get("exp"));
  const sig = url.searchParams.get("sig") ?? "";
  const now = deps.now();
  if (!fileId.success || !Number.isInteger(exp) || exp * 1000 <= now || !(await validSignature(deps.urlSecret, fileId.data, exp, sig))) {
    return new Response(null, { status: 403 });
  }

  const row = await deps.db
    .prepare("SELECT visibility, content_type FROM attachments WHERE id = ? AND status = 'ready'")
    .bind(fileId.data)
    .first<{ visibility: schemas.FileVisibility; content_type: string }>();
  if (!row) return new Response(null, { status: 404 });
  const object = await deps.files.get(`files/${fileId.data}`);
  if (!object) return new Response(null, { status: 404 });

  // Only checked images are shown in the page; everything else downloads.
  const inline = row.visibility === "public" && row.content_type.startsWith("image/");
  const type = row.visibility === "public" ? row.content_type : schemas.PRIVATE_CONTENT_TYPE;
  const headers = fileHeaders(type, inline, Math.floor((exp * 1000 - now) / 1000));
  headers.set("content-length", String(object.size));
  return new Response(request.method === "HEAD" ? null : object.body, { status: 200, headers });
}
