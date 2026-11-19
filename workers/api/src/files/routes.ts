import { newId, schemas } from "@bastion/shared";
import type { Server } from "@bastion/durable";
import { AuthError } from "../auth/errors.js";
import { limitAccount } from "../auth/rate-limit.js";
import { json } from "../auth/routes.js";
import { authenticate } from "../auth/sessions.js";
import { body, HttpError, id } from "../http.js";
import type { UploadSigner } from "./presign.js";
import type { ImageScanner } from "./scanner.js";
import { signFileUrl } from "./serve.js";
import { detectType } from "./sniff.js";
import { InvalidFileError, stripMetadata } from "./strip.js";

export interface FileRouteDeps {
  db: D1Database;
  files: R2Bucket;
  servers: DurableObjectNamespace<Server>;
  signer: UploadSigner;
  /** Abuse scan for public images. */
  scanner: ImageScanner;
  now: () => number;
  /** Per-user request limit. Optional in local dev. */
  userLimit?: RateLimit | undefined;
  /** Origin files are served from, a different domain from the API. */
  filesOrigin: string;
  /** Key for signing download URLs. */
  urlSecret: string;
}

interface Row {
  id: string;
  uploader_id: string;
  server_id: string | null;
  channel_id: string | null;
  conversation_id: string | null;
  visibility: schemas.FileVisibility;
  status: schemas.FileStatus;
  size: number;
  content_type: string;
  created_at: number;
  expires_at: number;
}

const COLUMNS = "id, uploader_id, server_id, channel_id, conversation_id, visibility, status, size, content_type, created_at, expires_at";

/** Uploads land here first. Only the Worker writes to files/, after checking the bytes. */
const pendingKey = (fileId: string): string => `pending/${fileId}`;
const finalKey = (fileId: string): string => `files/${fileId}`;

function record(row: Row): schemas.FileRecord {
  return { id: row.id, visibility: row.visibility, status: row.status, size: row.size, contentType: row.content_type, createdAt: row.created_at };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Whether this user may use files of this scope, throwing the right error if not. */
async function authorize(deps: FileRouteDeps, userId: string, row: Pick<Row, "server_id" | "channel_id" | "conversation_id">, need: "view" | "attach_files"): Promise<void> {
  if (row.conversation_id) {
    const member = await deps.db
      .prepare("SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?")
      .bind(row.conversation_id, userId)
      .first();
    if (!member) throw new HttpError(404, "not_found");
    return;
  }
  const stub = deps.servers.get(deps.servers.idFromName(row.server_id!));
  const reply = (await stub.handle(userId, { type: "channel.check", channelId: row.channel_id, need }, null)) as unknown as { status: number };
  if (reply.status === 204) return;
  // Hide servers and channels the caller cannot see.
  throw new HttpError(reply.status === 403 ? 403 : 404, reply.status === 403 ? "missing_permissions" : "not_found");
}

async function findFile(deps: FileRouteDeps, fileId: string): Promise<Row> {
  const row = await deps.db.prepare(`SELECT ${COLUMNS} FROM attachments WHERE id = ?`).bind(fileId).first<Row>();
  if (!row) throw new HttpError(404, "not_found");
  return row;
}

async function createUpload(request: Request, deps: FileRouteDeps, userId: string): Promise<Response> {
  const req = await body(request, schemas.CreateUploadRequest);
  const now = deps.now();
  await limitAccount(deps.db, "fileUpload", userId, now);

  const pending = await deps.db
    .prepare("SELECT COUNT(*) AS n FROM attachments WHERE uploader_id = ? AND status = 'pending' AND expires_at > ?")
    .bind(userId, now)
    .first<{ n: number }>();
  if ((pending?.n ?? 0) >= schemas.FILE_LIMITS.maxPendingPerUser) throw new HttpError(429, "too_many_pending_uploads");

  const scope =
    req.scope.type === "channel"
      ? { server_id: req.scope.serverId, channel_id: req.scope.channelId, conversation_id: null }
      : { server_id: null, channel_id: null, conversation_id: req.scope.conversationId };
  await authorize(deps, userId, scope, "attach_files");

  const fileId = newId();
  // Private files are ciphertext: the server cannot know what they are, and says so.
  const contentType = req.visibility === "public" ? req.contentType! : schemas.PRIVATE_CONTENT_TYPE;
  const signed = await deps.signer.presignPut({
    key: pendingKey(fileId),
    size: req.size,
    contentType,
    expiresSeconds: schemas.FILE_LIMITS.uploadUrlTtlSeconds,
    now,
  });
  await deps.db
    .prepare(
      `INSERT INTO attachments (id, uploader_id, server_id, channel_id, conversation_id, visibility, status, size, content_type, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
    )
    .bind(fileId, userId, scope.server_id, scope.channel_id, scope.conversation_id, req.visibility, req.size, contentType, now, now + schemas.FILE_LIMITS.pendingTtlSeconds * 1000)
    .run();
  const target: schemas.UploadTarget = {
    fileId,
    uploadUrl: signed.url,
    headers: signed.headers,
    expiresAt: now + schemas.FILE_LIMITS.uploadUrlTtlSeconds * 1000,
  };
  return json(target, 201);
}

/** Drop an upload that cannot be used: its bytes and its row. */
async function discard(deps: FileRouteDeps, fileId: string): Promise<void> {
  await deps.files.delete([pendingKey(fileId), finalKey(fileId)]);
  await deps.db.prepare("DELETE FROM attachments WHERE id = ?").bind(fileId).run();
}

async function completeUpload(deps: FileRouteDeps, userId: string, fileId: string): Promise<Response> {
  const row = await findFile(deps, fileId);
  if (row.uploader_id !== userId) throw new HttpError(404, "not_found");
  if (row.status === "ready") return json(record(row));
  if (row.status === "blocked") throw new HttpError(422, "file_rejected");
  const now = deps.now();
  if (row.expires_at <= now) {
    await discard(deps, fileId);
    throw new HttpError(410, "upload_expired");
  }

  const object = await deps.files.get(pendingKey(fileId));
  if (!object) throw new HttpError(409, "upload_missing");
  // The signed URL fixed the size, so a different one means something is wrong.
  if (object.size !== row.size) {
    await discard(deps, fileId);
    throw new HttpError(422, "size_mismatch");
  }
  let bytes = new Uint8Array(await object.arrayBuffer());
  let contentType = row.content_type;
  let digest: string | null = null;

  if (row.visibility === "public") {
    // The real type comes from the bytes. The claimed type and the name do not count.
    const detected = detectType(bytes);
    if (!detected) {
      await discard(deps, fileId);
      throw new HttpError(422, "unsupported_type");
    }
    if (detected !== row.content_type) {
      await discard(deps, fileId);
      throw new HttpError(422, "type_mismatch");
    }
    try {
      bytes = stripMetadata(detected, bytes);
    } catch (err) {
      if (!(err instanceof InvalidFileError)) throw err;
      await discard(deps, fileId);
      throw new HttpError(422, "invalid_file");
    }
    contentType = detected;
    digest = await sha256(bytes);

    const scan = await deps.scanner.scan({ fileId, uploaderId: userId, contentType, bytes });
    if (scan.verdict === "match") {
      await deps.files.delete([pendingKey(fileId), finalKey(fileId)]);
      await deps.db.prepare("UPDATE attachments SET status = 'blocked', completed_at = ? WHERE id = ?").bind(now, fileId).run();
      throw new HttpError(422, "file_rejected");
    }
    // Fail closed: an unscanned image is never served. It stays pending to retry.
    if (scan.verdict === "error") throw new HttpError(503, "scan_unavailable");
  }

  await deps.files.put(finalKey(fileId), bytes, { httpMetadata: { contentType } });
  await deps.files.delete(pendingKey(fileId));
  await deps.db
    .prepare("UPDATE attachments SET status = 'ready', size = ?, content_type = ?, sha256 = ?, completed_at = ? WHERE id = ?")
    .bind(bytes.length, contentType, digest, now, fileId)
    .run();
  return json(record({ ...row, status: "ready", size: bytes.length, content_type: contentType }));
}

async function downloadUrl(deps: FileRouteDeps, userId: string, fileId: string): Promise<Response> {
  const row = await findFile(deps, fileId);
  if (row.status !== "ready") throw new HttpError(404, "not_found");
  // Everyone, the uploader included, needs access to where the file lives right now.
  await authorize(deps, userId, row, "view");
  const signed = await signFileUrl(deps.urlSecret, deps.filesOrigin, fileId, deps.now());
  return json(signed satisfies schemas.FileUrl);
}

/**
 * Routes under /files. Returns null for paths it doesn't own.
 *
 *   POST   /files/uploads              start an upload, get a pre-signed URL
 *   POST   /files/uploads/:id/complete check, clean and publish the uploaded file
 *   GET    /files/:id                  the file's record
 *   GET    /files/:id/url              a short-lived download URL on the files domain
 *   DELETE /files/:id                  delete a file (uploader only)
 */
export async function handleFiles(request: Request, deps: FileRouteDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const parts = pathname.split("/").slice(1);
  if (parts[0] !== "files") return null;
  const m = request.method;

  try {
    const principal = await authenticate(deps.db, request, deps.now());
    if (deps.userLimit) {
      const { success } = await deps.userLimit.limit({ key: principal.userId });
      if (!success) throw new HttpError(429, "rate_limited");
    }
    const userId = principal.userId;

    if (parts.length === 2 && parts[1] === "uploads" && m === "POST") return await createUpload(request, deps, userId);
    if (parts.length === 4 && parts[1] === "uploads" && parts[3] === "complete" && m === "POST") {
      return await completeUpload(deps, userId, id(parts[2]));
    }
    if (parts.length === 2 && parts[1] !== "uploads") {
      const fileId = id(parts[1]);
      if (m === "GET") {
        const row = await findFile(deps, fileId);
        if (row.status !== "ready" && row.uploader_id !== userId) throw new HttpError(404, "not_found");
        if (row.status === "ready") await authorize(deps, userId, row, "view");
        return json(record(row));
      }
      if (m === "DELETE") {
        const row = await findFile(deps, fileId);
        if (row.uploader_id !== userId) throw new HttpError(404, "not_found");
        await discard(deps, fileId);
        return json(null, 204);
      }
    }
    if (parts.length === 3 && parts[2] === "url" && m === "GET") return await downloadUrl(deps, userId, id(parts[1]));
    return json({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof HttpError || err instanceof AuthError) return json({ error: err.code }, err.status);
    throw err;
  }
}

/** Drop uploads that were started and never finished. Run from the cron trigger. */
export async function cleanupPendingFiles(db: D1Database, files: R2Bucket, now: number): Promise<void> {
  const { results } = await db
    .prepare("SELECT id FROM attachments WHERE status = 'pending' AND expires_at <= ? LIMIT 200")
    .bind(now)
    .all<{ id: string }>();
  for (const { id: fileId } of results) {
    await files.delete([pendingKey(fileId), finalKey(fileId)]);
    await db.prepare("DELETE FROM attachments WHERE id = ?").bind(fileId).run();
  }
}
