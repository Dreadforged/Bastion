import { describe, expect, it } from "vitest";
import { newId } from "../src/ids.js";
import { CreateUploadRequest, FILE_LIMITS, FileScope } from "../src/files.js";

const channel = { type: "channel", serverId: newId(), channelId: newId() } as const;
const conversation = { type: "conversation", conversationId: "A".repeat(22) } as const;

describe("file limits", () => {
  it("has the alpha cap and short lived upload urls", () => {
    expect(FILE_LIMITS.maxBytes).toBe(25 * 1024 * 1024);
    expect(FILE_LIMITS.uploadUrlTtlSeconds).toBe(300);
  });
});

describe("CreateUploadRequest", () => {
  it("accepts a public image in a channel", () => {
    const r = CreateUploadRequest.safeParse({ scope: channel, visibility: "public", size: 1000, contentType: "image/png" });
    expect(r.success).toBe(true);
  });

  it("accepts private files in a channel or a conversation without a type", () => {
    expect(CreateUploadRequest.safeParse({ scope: channel, visibility: "private", size: 10 }).success).toBe(true);
    expect(CreateUploadRequest.safeParse({ scope: conversation, visibility: "private", size: 10 }).success).toBe(true);
  });

  it("rejects public files in a conversation", () => {
    const r = CreateUploadRequest.safeParse({ scope: conversation, visibility: "public", size: 10, contentType: "image/png" });
    expect(r.success).toBe(false);
  });

  it("needs a content type for public files and only knows the allowed ones", () => {
    expect(CreateUploadRequest.safeParse({ scope: channel, visibility: "public", size: 10 }).success).toBe(false);
    for (const contentType of ["text/html", "image/svg+xml", "application/x-msdownload"]) {
      expect(CreateUploadRequest.safeParse({ scope: channel, visibility: "public", size: 10, contentType }).success).toBe(false);
    }
  });

  it("enforces the size cap at both ends", () => {
    const base = { scope: channel, visibility: "private" } as const;
    expect(CreateUploadRequest.safeParse({ ...base, size: FILE_LIMITS.maxBytes }).success).toBe(true);
    expect(CreateUploadRequest.safeParse({ ...base, size: FILE_LIMITS.maxBytes + 1 }).success).toBe(false);
    expect(CreateUploadRequest.safeParse({ ...base, size: 0 }).success).toBe(false);
    expect(CreateUploadRequest.safeParse({ ...base, size: 1.5 }).success).toBe(false);
  });

  it("rejects malformed scopes", () => {
    expect(FileScope.safeParse({ type: "channel", serverId: "x", channelId: newId() }).success).toBe(false);
    expect(FileScope.safeParse({ type: "conversation", conversationId: "short" }).success).toBe(false);
  });
});
