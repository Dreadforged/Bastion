import { newId, schemas } from "@bastion/shared";
import type { Server } from "@bastion/durable";
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "../../durable/test/world.js";
import { hashToken, newToken } from "../src/auth/crypto.js";
import type { UploadSigner } from "../src/files/presign.js";
import { cleanupPendingFiles, handleFiles, type FileRouteDeps } from "../src/files/routes.js";
import { NoopScanner, type ImageScanner, type ScanInput, type ScanVerdict } from "../src/files/scanner.js";
import { handleFileServe } from "../src/files/serve.js";
import { createTestD1 } from "./d1.js";
import { bytesOf, concat, contains, equal, jpegWithMetadata, makePng, pngWithMetadata } from "./images.js";

const { FILE_LIMITS } = schemas;
const FILES_ORIGIN = "https://files.usercontent.test";
const SECRET = "url-signing-secret-for-tests-0123456789";
const MB = 1024 * 1024;
const ATTACH_FILES = 1n << 2n;
const VIEW_CHANNEL = 1n;

/** An in-memory R2. */
class FakeR2 {
  store = new Map<string, { bytes: Uint8Array; contentType: string | undefined }>();

  async get(key: string) {
    const o = this.store.get(key);
    if (!o) return null;
    return {
      size: o.bytes.length,
      body: new Blob([o.bytes]).stream(),
      arrayBuffer: async () => o.bytes.slice().buffer,
    };
  }

  async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }) {
    this.store.set(key, { bytes: new Uint8Array(value), contentType: options?.httpMetadata?.contentType });
  }

  async delete(keys: string | string[]) {
    for (const key of Array.isArray(keys) ? keys : [keys]) this.store.delete(key);
  }

  /** What a client's PUT to the pre-signed URL does. */
  upload(key: string, bytes: Uint8Array) {
    this.store.set(key, { bytes, contentType: undefined });
  }
}

class FakeSigner implements UploadSigner {
  calls: { key: string; size: number; contentType: string; expiresSeconds: number; now: number }[] = [];
  async presignPut(input: { key: string; size: number; contentType: string; expiresSeconds: number; now: number }) {
    this.calls.push(input);
    return { url: `https://r2.test/${input.key}?sig=fake`, headers: { "content-type": input.contentType } };
  }
}

class FakeScanner implements ImageScanner {
  verdict: ScanVerdict = { verdict: "clean" };
  seen: ScanInput[] = [];
  async scan(input: ScanInput): Promise<ScanVerdict> {
    this.seen.push(input);
    return this.verdict;
  }
}

let db: D1Database;
let world: World;
let r2: FakeR2;
let signer: FakeSigner;
let scanner: FakeScanner;
let limited: boolean;

beforeEach(() => {
  db = createTestD1();
  world = new World();
  r2 = new FakeR2();
  signer = new FakeSigner();
  scanner = new FakeScanner();
  limited = false;
});

const servers = {
  idFromName: (name: string) => name,
  get: (id: string) => ({ handle: (u: string, op: unknown, key: string | null) => world.server(id).handle(u, op, key), setAgeLimit: async (u: string, on: boolean) => world.server(id).setAgeLimit(u, on) }),
} as unknown as DurableObjectNamespace<Server>;

function deps(): FileRouteDeps {
  return {
    db,
    files: r2 as unknown as R2Bucket,
    servers,
    signer,
    scanner,
    now: () => world.now,
    userLimit: { limit: async () => ({ success: !limited }) } as RateLimit,
    filesOrigin: FILES_ORIGIN,
    urlSecret: SECRET,
  };
}

type User = { userId: string; token: string };

async function signedIn(): Promise<User> {
  const userId = newId();
  const deviceId = newId();
  const token = newToken();
  const now = world.now;
  await db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(userId, `${userId.toLowerCase()}@test`, now).run();
  await db
    .prepare("INSERT INTO devices (id, user_id, name, credential_id, public_key, created_at) VALUES (?, ?, 'Laptop', ?, 'pk', ?)")
    .bind(deviceId, userId, `cred-${deviceId}`, now)
    .run();
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), userId, deviceId, await hashToken(token), now + 86_400_000, await hashToken(newToken()), now + 86_400_000, now)
    .run();
  return { userId, token };
}

async function call(method: string, path: string, opts: { user?: User; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (opts.user) headers.authorization = `Bearer ${opts.user.token}`;
  const request = new Request(`https://api.test${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const res = await handleFiles(request, deps());
  if (!res) throw new Error("unrouted");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** An owner, a member and a stranger, a text channel, and a conversation the member is in. */
async function setup() {
  const owner = await signedIn();
  const member = await signedIn();
  const stranger = await signedIn();
  const serverId = await world.createServer(owner.userId);
  const channelId = world.generalChannel(serverId, owner.userId);
  await world.join(serverId, owner.userId, member.userId);
  const conversationId = "c".repeat(22);
  for (const u of [owner, member]) await db.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)").bind(conversationId, u.userId).run();
  return { owner, member, stranger, serverId, channelId, conversationId };
}

type Setup = Awaited<ReturnType<typeof setup>>;

const publicBody = (t: Setup, bytes: Uint8Array, contentType = "image/png") => ({
  scope: { type: "channel", serverId: t.serverId, channelId: t.channelId },
  visibility: "public",
  size: bytes.length,
  contentType,
});
const privateBody = (t: Setup, size: number, scope: "channel" | "conversation" = "channel") => ({
  scope: scope === "channel" ? { type: "channel", serverId: t.serverId, channelId: t.channelId } : { type: "conversation", conversationId: t.conversationId },
  visibility: "private",
  size,
});

/** Start an upload and put bytes where the pre-signed URL would. */
async function upload(user: User, body: unknown, bytes: Uint8Array) {
  const started = await call("POST", "/files/uploads", { user, body });
  expect(started.status).toBe(201);
  r2.upload(`pending/${started.body.fileId}`, bytes);
  return started.body.fileId as string;
}

const complete = (user: User, fileId: string) => call("POST", `/files/uploads/${fileId}/complete`, { user });

async function row(fileId: string) {
  return db.prepare("SELECT * FROM attachments WHERE id = ?").bind(fileId).first<Record<string, unknown>>();
}

async function setPermission(t: Setup, userId: string, deny: bigint) {
  const reply = await world.op(t.serverId, t.owner.userId, {
    type: "override.put",
    channelId: t.channelId,
    kind: "member",
    targetId: userId,
    body: { allow: "0", deny: deny.toString() },
  });
  expect(reply.status).toBe(200);
}

// ------------------------------------------------------------------ starting uploads

describe("POST /files/uploads", () => {
  it("returns a pre-signed URL that expires in five minutes, and records a pending file", async () => {
    const t = await setup();
    const png = makePng();
    const res = await call("POST", "/files/uploads", { user: t.member, body: publicBody(t, png) });
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBe(world.now + 5 * 60_000);
    expect(res.body.uploadUrl).toBe(`https://r2.test/pending/${res.body.fileId}?sig=fake`);
    expect(res.body.headers).toEqual({ "content-type": "image/png" });
    expect(signer.calls).toEqual([
      { key: `pending/${res.body.fileId}`, size: png.length, contentType: "image/png", expiresSeconds: 300, now: world.now },
    ]);
    expect(await row(res.body.fileId)).toMatchObject({
      uploader_id: t.member.userId,
      server_id: t.serverId,
      channel_id: t.channelId,
      conversation_id: null,
      visibility: "public",
      status: "pending",
      size: png.length,
      content_type: "image/png",
    });
  });

  it("takes private files in a channel or a conversation, stored as opaque bytes", async () => {
    const t = await setup();
    for (const scope of ["channel", "conversation"] as const) {
      const res = await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 500, scope) });
      expect(res.status).toBe(201);
      expect(res.body.headers).toEqual({ "content-type": "application/octet-stream" });
      expect(await row(res.body.fileId)).toMatchObject({ visibility: "private", content_type: "application/octet-stream" });
    }
  });

  it("caps files at 25 MB", async () => {
    const t = await setup();
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 25 * MB) })).status).toBe(201);
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 25 * MB + 1) })).status).toBe(400);
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 0) })).status).toBe(400);
  });

  it("rejects bad requests", async () => {
    const t = await setup();
    const png = makePng();
    const bad: unknown[] = [
      {},
      { ...publicBody(t, png), contentType: undefined },
      { ...publicBody(t, png), contentType: "text/html" },
      { ...publicBody(t, png), contentType: "image/svg+xml" },
      { ...publicBody(t, png), scope: { type: "conversation", conversationId: t.conversationId } },
      { ...privateBody(t, 10), scope: { type: "channel", serverId: "x", channelId: "y" } },
    ];
    for (const body of bad) expect((await call("POST", "/files/uploads", { user: t.member, body })).status).toBe(400);
    expect((await call("POST", "/files/uploads", { body: publicBody(t, png) })).status).toBe(401);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM attachments").first()).toEqual({ n: 0 });
  });

  it("needs ATTACH_FILES in the channel", async () => {
    const t = await setup();
    await setPermission(t, t.member.userId, ATTACH_FILES);
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).body).toEqual({ error: "missing_permissions" });
    expect((await call("POST", "/files/uploads", { user: t.owner, body: privateBody(t, 10) })).status).toBe(201);
  });

  it("is refused for a member who is timed out", async () => {
    const t = await setup();
    const timeout = await world.op(t.serverId, t.owner.userId, { type: "member.timeout", userId: t.member.userId, body: { seconds: 60 } });
    expect(timeout.status).toBe(200);
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).status).toBe(403);
    world.now += 61_000;
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).status).toBe(201);
  });

  it("hides channels and servers from people who cannot see them", async () => {
    const t = await setup();
    await setPermission(t, t.member.userId, VIEW_CHANNEL);
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).status).toBe(404);
    expect((await call("POST", "/files/uploads", { user: t.stranger, body: privateBody(t, 10) })).status).toBe(404);
  });

  it("only lets conversation members upload to a conversation", async () => {
    const t = await setup();
    expect((await call("POST", "/files/uploads", { user: t.stranger, body: privateBody(t, 10, "conversation") })).status).toBe(404);
  });

  it("allows ten unfinished uploads at a time", async () => {
    const t = await setup();
    for (let i = 0; i < FILE_LIMITS.maxPendingPerUser; i++) {
      expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).status).toBe(201);
    }
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).body).toEqual({ error: "too_many_pending_uploads" });
    // Other people are unaffected, and an expired one stops counting.
    expect((await call("POST", "/files/uploads", { user: t.owner, body: privateBody(t, 10) })).status).toBe(201);
    world.now += FILE_LIMITS.pendingTtlSeconds * 1000 + 1;
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).status).toBe(201);
  });

  it("limits how many uploads a person can start, and resets after the window", async () => {
    const t = await setup();
    for (let i = 0; i < FILE_LIMITS.maxUploadsPerWindow; i++) {
      const res = await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) });
      expect(res.status).toBe(201);
      expect((await call("DELETE", `/files/${res.body.fileId}`, { user: t.member })).status).toBe(204);
    }
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).body).toEqual({ error: "rate_limited" });
    world.now += 10 * 60_000;
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).status).toBe(201);
  });

  it("applies the per-user request limit", async () => {
    const t = await setup();
    limited = true;
    expect((await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) })).status).toBe(429);
  });

  it("stores no file name, address or other detail beyond what the table lists", async () => {
    const t = await setup();
    const res = await call("POST", "/files/uploads", { user: t.member, body: publicBody(t, makePng()) });
    const stored = (await row(res.body.fileId))!;
    expect(Object.keys(stored).sort()).toEqual(
      ["channel_id", "completed_at", "content_type", "conversation_id", "created_at", "expires_at", "id", "server_id", "sha256", "size", "status", "uploader_id", "visibility"].sort(),
    );
  });
});

// ------------------------------------------------------------------ public images

describe("completing a public image upload", () => {
  it("strips metadata, scans the cleaned image and publishes it", async () => {
    const t = await setup();
    const original = pngWithMetadata();
    const fileId = await upload(t.member, publicBody(t, original), original);
    const res = await complete(t.member, fileId);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: fileId, visibility: "public", status: "ready", contentType: "image/png" });

    const stored = r2.store.get(`files/${fileId}`)!;
    expect(contains(stored.bytes, "GPS-SECRET")).toBe(false);
    expect(contains(stored.bytes, "Jane Q Public")).toBe(false);
    expect(stored.bytes.length).toBeLessThan(original.length);
    expect(stored.contentType).toBe("image/png");
    expect(r2.store.has(`pending/${fileId}`)).toBe(false);

    expect(scanner.seen).toHaveLength(1);
    expect(scanner.seen[0]).toMatchObject({ fileId, uploaderId: t.member.userId, contentType: "image/png" });
    expect(equal(scanner.seen[0]!.bytes, stored.bytes)).toBe(true);

    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", stored.bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await row(fileId)).toMatchObject({ status: "ready", size: stored.bytes.length, sha256: digest });
    expect(res.body.size).toBe(stored.bytes.length);
  });

  it("strips JPEG metadata too", async () => {
    const t = await setup();
    const jpeg = jpegWithMetadata();
    const fileId = await upload(t.member, publicBody(t, jpeg, "image/jpeg"), jpeg);
    expect((await complete(t.member, fileId)).status).toBe(200);
    expect(contains(r2.store.get(`files/${fileId}`)!.bytes, "GPS-SECRET")).toBe(false);
  });

  it("is idempotent once done", async () => {
    const t = await setup();
    const fileId = await upload(t.member, publicBody(t, makePng()), makePng());
    await complete(t.member, fileId);
    expect((await complete(t.member, fileId)).status).toBe(200);
    expect(scanner.seen).toHaveLength(1);
  });

  it("checks the real type, not the claimed one or a file name", async () => {
    const t = await setup();
    const cases: [string, Uint8Array, string][] = [
      ["a JPEG sent as a PNG", jpegWithMetadata(), "type_mismatch"],
      ["a Windows executable sent as a PNG", concat(bytesOf("MZ\x90\x00\x03"), new Uint8Array(100)), "unsupported_type"],
      ["HTML sent as a PNG", bytesOf("<html><script>alert(document.cookie)</script></html>"), "unsupported_type"],
      ["an SVG sent as a PNG", bytesOf("<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/>"), "unsupported_type"],
      ["a zip sent as a PNG", bytesOf("PK\x03\x04 hidden payload"), "unsupported_type"],
    ];
    for (const [name, bytes, error] of cases) {
      const fileId = await upload(t.member, publicBody(t, bytes), bytes);
      const res = await complete(t.member, fileId);
      expect(res, name).toMatchObject({ status: 422, body: { error } });
      // Nothing is kept: not the bytes, not the row.
      expect(r2.store.size, name).toBe(0);
      expect(await row(fileId), name).toBeNull();
    }
    expect(scanner.seen).toEqual([]);
  });

  it("rejects an image that does not parse", async () => {
    const t = await setup();
    const broken = makePng().slice(0, 30);
    const fileId = await upload(t.member, publicBody(t, broken), broken);
    expect(await complete(t.member, fileId)).toMatchObject({ status: 422, body: { error: "invalid_file" } });
    expect(r2.store.size).toBe(0);
  });

  it("rejects an upload whose size is not the size declared", async () => {
    const t = await setup();
    const png = makePng();
    const started = await call("POST", "/files/uploads", { user: t.member, body: publicBody(t, png) });
    r2.upload(`pending/${started.body.fileId}`, concat(png, bytesOf("extra")));
    expect(await complete(t.member, started.body.fileId)).toMatchObject({ status: 422, body: { error: "size_mismatch" } });
    expect(r2.store.size).toBe(0);
  });

  it("answers 409 when nothing was uploaded yet, and works once it has been", async () => {
    const t = await setup();
    const png = makePng();
    const started = await call("POST", "/files/uploads", { user: t.member, body: publicBody(t, png) });
    expect((await complete(t.member, started.body.fileId)).body).toEqual({ error: "upload_missing" });
    r2.upload(`pending/${started.body.fileId}`, png);
    expect((await complete(t.member, started.body.fileId)).status).toBe(200);
  });

  it("turns down an upload that was never finished in time", async () => {
    const t = await setup();
    const png = makePng();
    const fileId = await upload(t.member, publicBody(t, png), png);
    world.now += FILE_LIMITS.pendingTtlSeconds * 1000 + 1;
    expect((await complete(t.member, fileId)).status).toBe(410);
    expect(r2.store.size).toBe(0);
    expect(await row(fileId)).toBeNull();
  });

  it("is only for the person who started it", async () => {
    const t = await setup();
    const png = makePng();
    const fileId = await upload(t.member, publicBody(t, png), png);
    expect((await complete(t.owner, fileId)).status).toBe(404);
    expect((await complete(t.member, newId())).status).toBe(404);
    expect((await complete(t.member, "nope")).status).toBe(404);
  });

  it("cannot be swapped for unchecked bytes by uploading again after completion", async () => {
    const t = await setup();
    const png = makePng();
    const fileId = await upload(t.member, publicBody(t, png), png);
    await complete(t.member, fileId);
    const before = r2.store.get(`files/${fileId}`)!.bytes;
    // The pre-signed URL may still be live, but it only writes the pending key.
    r2.upload(`pending/${fileId}`, pngWithMetadata());
    expect(equal(r2.store.get(`files/${fileId}`)!.bytes, before)).toBe(true);
  });
});

describe("abuse scanning hook", () => {
  it("blocks a match: bytes deleted, never served, uploader told only that it was rejected", async () => {
    const t = await setup();
    const png = makePng();
    const fileId = await upload(t.member, publicBody(t, png), png);
    scanner.verdict = { verdict: "match", reference: "hash-123" };
    const res = await complete(t.member, fileId);
    expect(res).toMatchObject({ status: 422, body: { error: "file_rejected" } });
    expect(JSON.stringify(res.body)).not.toContain("hash-123");
    expect(r2.store.size).toBe(0);
    expect(await row(fileId)).toMatchObject({ status: "blocked" });
    // It stays blocked and cannot be fetched.
    expect((await complete(t.member, fileId)).status).toBe(422);
    expect((await call("GET", `/files/${fileId}/url`, { user: t.member })).status).toBe(404);
    expect(r2.store.size).toBe(0);
  });

  it("fails closed when the scan cannot run, and succeeds on retry", async () => {
    const t = await setup();
    const png = makePng();
    const fileId = await upload(t.member, publicBody(t, png), png);
    scanner.verdict = { verdict: "error" };
    expect((await complete(t.member, fileId)).body).toEqual({ error: "scan_unavailable" });
    expect(r2.store.has(`files/${fileId}`)).toBe(false);
    expect(await row(fileId)).toMatchObject({ status: "pending" });
    expect((await call("GET", `/files/${fileId}/url`, { user: t.member })).status).toBe(404);

    scanner.verdict = { verdict: "clean" };
    expect((await complete(t.member, fileId)).status).toBe(200);
  });

  it("ships as a stub that lets everything through", async () => {
    expect(await new NoopScanner().scan()).toEqual({ verdict: "clean" });
  });

  it("is not run on private files, which are encrypted on the device", async () => {
    const t = await setup();
    const fileId = await upload(t.member, privateBody(t, 64), new Uint8Array(64).fill(9));
    expect((await complete(t.member, fileId)).status).toBe(200);
    expect(scanner.seen).toEqual([]);
  });
});

// ------------------------------------------------------------------ private files

describe("completing a private upload", () => {
  it("stores the bytes untouched, with no type check, as octet-stream", async () => {
    const t = await setup();
    // Even bytes that look like a JPEG with EXIF are not touched: it is ciphertext to the server.
    const bytes = jpegWithMetadata();
    const fileId = await upload(t.member, privateBody(t, bytes.length), bytes);
    const res = await complete(t.member, fileId);
    expect(res.body).toMatchObject({ visibility: "private", status: "ready", contentType: "application/octet-stream", size: bytes.length });
    const stored = r2.store.get(`files/${fileId}`)!;
    expect(equal(stored.bytes, bytes)).toBe(true);
    expect(stored.contentType).toBe("application/octet-stream");
    expect(await row(fileId)).toMatchObject({ sha256: null });
  });

  it("still enforces the declared size", async () => {
    const t = await setup();
    const started = await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) });
    r2.upload(`pending/${started.body.fileId}`, new Uint8Array(11));
    expect((await complete(t.member, started.body.fileId)).body).toEqual({ error: "size_mismatch" });
  });

  it("works for a 25 MB file", async () => {
    const t = await setup();
    const fileId = await upload(t.member, privateBody(t, 25 * MB), new Uint8Array(25 * MB));
    expect((await complete(t.member, fileId)).status).toBe(200);
  });
});

// ------------------------------------------------------------------ downloads

async function ready(t: Setup, visibility: "public" | "private", scope: "channel" | "conversation" = "channel") {
  if (visibility === "public") {
    const png = pngWithMetadata();
    const fileId = await upload(t.member, publicBody(t, png), png);
    await complete(t.member, fileId);
    return fileId;
  }
  const fileId = await upload(t.member, privateBody(t, 32, scope), new Uint8Array(32).fill(7));
  await complete(t.member, fileId);
  return fileId;
}

function serve(url: string, init: RequestInit = {}, now = world.now, origin = FILES_ORIGIN) {
  return handleFileServe(new Request(url, init), { db, files: r2 as unknown as R2Bucket, now: () => now, filesOrigin: origin, urlSecret: SECRET });
}

describe("GET /files/:id/url", () => {
  it("gives channel members a signed URL on the files domain with nothing personal in it", async () => {
    const t = await setup();
    const fileId = await ready(t, "public");
    const res = await call("GET", `/files/${fileId}/url`, { user: t.owner });
    expect(res.status).toBe(200);
    expect(res.body.url.startsWith(`${FILES_ORIGIN}/f/${fileId}?exp=`)).toBe(true);
    expect(res.body.expiresAt).toBe(world.now + FILE_LIMITS.downloadUrlTtlSeconds * 1000);
    for (const secret of [t.owner.userId, t.member.userId, t.serverId, t.channelId, SECRET]) expect(res.body.url).not.toContain(secret);
    // The files domain is not the API's.
    expect(new URL(res.body.url).host).not.toBe("api.test");
  });

  it("is refused to people who cannot see the channel or are not in the conversation", async () => {
    const t = await setup();
    const inChannel = await ready(t, "public");
    const inConversation = await ready(t, "private", "conversation");
    expect((await call("GET", `/files/${inChannel}/url`, { user: t.stranger })).status).toBe(404);
    expect((await call("GET", `/files/${inConversation}/url`, { user: t.stranger })).status).toBe(404);
    expect((await call("GET", `/files/${inConversation}/url`, { user: t.owner })).status).toBe(200);
    // A member who loses the channel loses its files, uploader included.
    await setPermission(t, t.member.userId, VIEW_CHANNEL);
    expect((await call("GET", `/files/${inChannel}/url`, { user: t.member })).status).toBe(404);
    expect((await call("GET", `/files/${inChannel}/url`, { user: t.owner })).status).toBe(200);
  });

  it("is not available before a file is ready, and needs a signed-in user", async () => {
    const t = await setup();
    const started = await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) });
    expect((await call("GET", `/files/${started.body.fileId}/url`, { user: t.member })).status).toBe(404);
    expect((await call("GET", `/files/${started.body.fileId}/url`)).status).toBe(401);
  });
});

describe("the files domain", () => {
  async function urlFor(t: Setup, fileId: string) {
    return (await call("GET", `/files/${fileId}/url`, { user: t.owner })).body.url as string;
  }

  it("serves a checked image inline with headers that stop it doing anything else", async () => {
    const t = await setup();
    const fileId = await ready(t, "public");
    const res = (await serve(await urlFor(t, fileId)))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe("inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/^private, max-age=\d+$/);
    expect(equal(new Uint8Array(await res.arrayBuffer()), r2.store.get(`files/${fileId}`)!.bytes)).toBe(true);
  });

  it("serves private files as a download of opaque bytes", async () => {
    const t = await setup();
    const fileId = await ready(t, "private");
    const res = (await serve(await urlFor(t, fileId)))!;
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toBe("attachment");
    expect(res.headers.get("content-length")).toBe("32");
  });

  it("answers HEAD without a body and rejects other methods", async () => {
    const t = await setup();
    const url = await urlFor(t, await ready(t, "public"));
    const head = (await serve(url, { method: "HEAD" }))!;
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect((await serve(url, { method: "POST" }))!.status).toBe(405);
    expect((await serve(url, { method: "DELETE" }))!.status).toBe(405);
  });

  it("refuses expired, altered and unsigned URLs", async () => {
    const t = await setup();
    const fileId = await ready(t, "public");
    const other = await ready(t, "private");
    const url = await urlFor(t, fileId);
    const u = new URL(url);
    expect((await serve(url, {}, world.now + FILE_LIMITS.downloadUrlTtlSeconds * 1000 + 1000))!.status).toBe(403);
    // Someone else's file with this file's signature.
    expect((await serve(`${FILES_ORIGIN}/f/${other}${u.search}`))!.status).toBe(403);
    // A later expiry with the old signature.
    const exp = Number(u.searchParams.get("exp")) + 3600;
    expect((await serve(`${FILES_ORIGIN}/f/${fileId}?exp=${exp}&sig=${u.searchParams.get("sig")}`))!.status).toBe(403);
    expect((await serve(`${FILES_ORIGIN}/f/${fileId}?exp=${u.searchParams.get("exp")}`))!.status).toBe(403);
    expect((await serve(`${FILES_ORIGIN}/f/${fileId}`))!.status).toBe(403);
    expect((await serve(`${FILES_ORIGIN}/f/${fileId}?exp=${u.searchParams.get("exp")}&sig=${"A".repeat(43)}`))!.status).toBe(403);
    expect((await serve(`${FILES_ORIGIN}/f/not-an-id?exp=1&sig=x`))!.status).toBe(403);
  });

  it("does not serve a file that is blocked, deleted or still pending, even with a good URL", async () => {
    const t = await setup();
    const fileId = await ready(t, "public");
    const url = await urlFor(t, fileId);
    await db.prepare("UPDATE attachments SET status = 'blocked' WHERE id = ?").bind(fileId).run();
    expect((await serve(url))!.status).toBe(404);
    await db.prepare("UPDATE attachments SET status = 'ready' WHERE id = ?").bind(fileId).run();
    expect((await serve(url))!.status).toBe(200);
    await r2.delete(`files/${fileId}`);
    expect((await serve(url))!.status).toBe(404);
  });

  it("exposes nothing but /f/ on its host, and the API host never serves files", async () => {
    const t = await setup();
    const url = await urlFor(t, await ready(t, "public"));
    expect((await serve(`${FILES_ORIGIN}/auth/devices`))!.status).toBe(404);
    expect((await serve(`${FILES_ORIGIN}/`))!.status).toBe(404);
    expect(await serve(url.replace(FILES_ORIGIN, "https://api.test"))).toBeNull();
  });
});

// ------------------------------------------------------------------ records, deleting, cleanup

describe("GET /files/:id and DELETE /files/:id", () => {
  it("shows a file to people who can use it", async () => {
    const t = await setup();
    const fileId = await ready(t, "public");
    expect((await call("GET", `/files/${fileId}`, { user: t.owner })).body).toMatchObject({ id: fileId, status: "ready" });
    expect((await call("GET", `/files/${fileId}`, { user: t.stranger })).status).toBe(404);
    expect((await call("GET", `/files/${newId()}`, { user: t.owner })).status).toBe(404);
  });

  it("shows a pending file to its uploader only", async () => {
    const t = await setup();
    const started = await call("POST", "/files/uploads", { user: t.member, body: privateBody(t, 10) });
    expect((await call("GET", `/files/${started.body.fileId}`, { user: t.member })).body).toMatchObject({ status: "pending" });
    expect((await call("GET", `/files/${started.body.fileId}`, { user: t.owner })).status).toBe(404);
  });

  it("lets only the uploader delete, removing the bytes and the row", async () => {
    const t = await setup();
    const fileId = await ready(t, "public");
    expect((await call("DELETE", `/files/${fileId}`, { user: t.owner })).status).toBe(404);
    expect(r2.store.has(`files/${fileId}`)).toBe(true);
    expect((await call("DELETE", `/files/${fileId}`, { user: t.member })).status).toBe(204);
    expect(r2.store.size).toBe(0);
    expect(await row(fileId)).toBeNull();
  });

  it("ignores paths it does not own and unknown routes", async () => {
    const t = await setup();
    expect(await handleFiles(new Request("https://api.test/servers"), deps())).toBeNull();
    expect((await call("GET", "/files/uploads", { user: t.member })).status).toBe(404);
    expect((await call("PUT", `/files/${newId()}`, { user: t.member })).status).toBe(404);
  });
});

describe("cleanupPendingFiles", () => {
  it("removes unfinished uploads past their deadline and leaves the rest", async () => {
    const t = await setup();
    const stale = await upload(t.member, privateBody(t, 3), new Uint8Array(3));
    const kept = await ready(t, "private");
    world.now += FILE_LIMITS.pendingTtlSeconds * 1000 + 1;
    const fresh = await upload(t.member, privateBody(t, 3), new Uint8Array(3));
    await cleanupPendingFiles(db, r2 as unknown as R2Bucket, world.now);
    expect(await row(stale)).toBeNull();
    expect(r2.store.has(`pending/${stale}`)).toBe(false);
    expect(await row(fresh)).not.toBeNull();
    expect(r2.store.has(`pending/${fresh}`)).toBe(true);
    expect(await row(kept)).toMatchObject({ status: "ready" });
    expect(r2.store.has(`files/${kept}`)).toBe(true);
  });
});
