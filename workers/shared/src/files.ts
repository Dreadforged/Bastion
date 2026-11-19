import { z } from "zod";
import { Id } from "./ids.js";

/**
 * File uploads. Bytes go straight from the client to R2 through a pre-signed
 * URL; the Worker never proxies them, and no IP address is ever stored.
 *
 * Two kinds of file:
 *
 * - `public`: shared in a server channel. The Worker checks the real file type,
 *   strips image metadata and runs the abuse scan before the file is usable.
 * - `private`: encrypted on the device before upload (DMs and encrypted
 *   conversations). The Worker only sees opaque bytes, so it checks size alone.
 */

export const FILE_LIMITS = {
  /** Largest file in the alpha, in bytes. */
  maxBytes: 25 * 1024 * 1024,
  /** A pre-signed upload URL stops working after this long. */
  uploadUrlTtlSeconds: 5 * 60,
  /** A signed download URL stops working after this long. */
  downloadUrlTtlSeconds: 60 * 60,
  /** A started upload that is never completed is cleaned up after this long. */
  pendingTtlSeconds: 60 * 60,
  /** At most this many unfinished uploads per user. */
  maxPendingPerUser: 10,
  /** Uploads one user may start in the rate limit window (see the API). */
  maxUploadsPerWindow: 30,
} as const;

/**
 * Real types allowed in public channels, detected from the bytes. Images
 * only: their metadata is stripped. Anything else goes up as a private,
 * encrypted file.
 */
export const PUBLIC_FILE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type PublicFileType = (typeof PUBLIC_FILE_TYPES)[number];
export const PublicFileType = z.enum(PUBLIC_FILE_TYPES);

/** What private files are stored as, since the server cannot see inside them. */
export const PRIVATE_CONTENT_TYPE = "application/octet-stream";

export const FileVisibility = z.enum(["public", "private"]);
export type FileVisibility = z.infer<typeof FileVisibility>;

export const FileStatus = z.enum(["pending", "ready", "blocked"]);
export type FileStatus = z.infer<typeof FileStatus>;

/** Where a file will be used. */
export const FileScope = z.discriminatedUnion("type", [
  z.object({ type: z.literal("channel"), serverId: Id, channelId: Id }),
  z.object({ type: z.literal("conversation"), conversationId: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }),
]);
export type FileScope = z.infer<typeof FileScope>;

export const CreateUploadRequest = z
  .object({
    scope: FileScope,
    visibility: FileVisibility,
    /** Exact size in bytes. The upload URL only accepts a body of this size. */
    size: z.number().int().min(1).max(FILE_LIMITS.maxBytes),
    /**
     * What the client says the file is. Required for public files and checked
     * against the bytes later; ignored for private files.
     */
    contentType: PublicFileType.optional(),
  })
  .refine((v) => v.scope.type === "channel" || v.visibility === "private", {
    message: "conversation files are always private",
    path: ["visibility"],
  })
  .refine((v) => v.visibility === "private" || v.contentType !== undefined, {
    message: "public files need a content type",
    path: ["contentType"],
  });
export type CreateUploadRequest = z.infer<typeof CreateUploadRequest>;

export const UploadTarget = z.object({
  fileId: Id,
  /** PUT the file bytes here, with exactly these headers. */
  uploadUrl: z.string(),
  headers: z.record(z.string(), z.string()),
  expiresAt: z.number().int(),
});
export type UploadTarget = z.infer<typeof UploadTarget>;

export const FileRecord = z.object({
  id: Id,
  visibility: FileVisibility,
  status: FileStatus,
  size: z.number().int().nonnegative(),
  /** The detected type for public files; octet-stream for private ones. */
  contentType: z.string(),
  createdAt: z.number().int(),
});
export type FileRecord = z.infer<typeof FileRecord>;

export const FileUrl = z.object({
  url: z.string(),
  expiresAt: z.number().int(),
});
export type FileUrl = z.infer<typeof FileUrl>;
