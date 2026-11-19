/**
 * Pre-signed R2 upload URLs (AWS Signature Version 4, query string form).
 *
 * R2 bindings cannot make signed URLs, so the S3 API does: the client PUTs the
 * bytes straight to R2 and the Worker never carries them. The signature covers
 * the exact content length and type, so a URL cannot be used for a larger file
 * or a different type, and it stops working after `expiresSeconds`.
 */

export interface UploadSigner {
  presignPut(input: { key: string; size: number; contentType: string; expiresSeconds: number; now: number }): Promise<{
    url: string;
    /** Headers the client must send with the PUT. Content-Length is set by the browser itself. */
    headers: Record<string, string>;
  }>;
}

const encoder = new TextEncoder();

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, encoder.encode(value));
}

/** RFC 3986 encoding as AWS wants it. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

export interface PresignInput {
  method: "GET" | "PUT";
  host: string;
  /** Already URI-encoded, starting with a slash. */
  path: string;
  region: string;
  service: string;
  accessKeyId: string;
  secretAccessKey: string;
  now: number;
  expiresSeconds: number;
  /** Signed headers besides `host`, with lower case names. */
  headers?: Record<string, string>;
}

/** Build a pre-signed URL. Exported for tests against AWS's published example. */
export async function presignUrl(input: PresignInput): Promise<string> {
  const iso = new Date(input.now).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const date = iso.slice(0, 8);
  const scope = `${date}/${input.region}/${input.service}/aws4_request`;

  const headers: Record<string, string> = { host: input.host, ...input.headers };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(";");
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim()}\n`).join("");

  const query: Record<string, string> = {
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.accessKeyId}/${scope}`,
    "X-Amz-Date": iso,
    "X-Amz-Expires": String(input.expiresSeconds),
    "X-Amz-SignedHeaders": signedHeaders,
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encode(k)}=${encode(query[k]!)}`)
    .join("&");

  const canonicalRequest = [input.method, input.path, canonicalQuery, canonicalHeaders, signedHeaders, "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", iso, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key = await hmac(encoder.encode(`AWS4${input.secretAccessKey}`), date);
  key = await hmac(key, input.region);
  key = await hmac(key, input.service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  return `https://${input.host}${input.path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export interface R2SignerConfig {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
}

/** Signs uploads for a bucket through R2's S3 compatible endpoint. */
export class R2S3Signer implements UploadSigner {
  constructor(private readonly config: R2SignerConfig) {}

  async presignPut(input: { key: string; size: number; contentType: string; expiresSeconds: number; now: number }) {
    const { accountId, accessKeyId, secretAccessKey, bucket } = this.config;
    const url = await presignUrl({
      method: "PUT",
      host: `${accountId}.r2.cloudflarestorage.com`,
      path: `/${encode(bucket)}/${input.key.split("/").map(encode).join("/")}`,
      region: "auto",
      service: "s3",
      accessKeyId,
      secretAccessKey,
      now: input.now,
      expiresSeconds: input.expiresSeconds,
      headers: { "content-length": String(input.size), "content-type": input.contentType },
    });
    return { url, headers: { "content-type": input.contentType } };
  }
}
