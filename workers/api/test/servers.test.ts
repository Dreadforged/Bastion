import { newId } from "@bastion/shared";
import type { Server, UserSession } from "@bastion/durable";
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "../../durable/test/world.js";
import { hashToken, newToken } from "../src/auth/crypto.js";
import { cleanupInviteCodes, handleServers } from "../src/servers/routes.js";
import { createTestD1 } from "./d1.js";

let db: D1Database;
let world: World;
let limited: boolean;
let upgrades: Request[];
let revoked: { conversationId: string; userId: string }[];

beforeEach(() => {
  db = createTestD1();
  world = new World();
  limited = false;
  upgrades = [];
  revoked = [];
});

/** Durable Object namespaces backed by the in-memory World. */
const servers = {
  idFromName: (name: string) => name,
  get: (id: string) => ({ handle: (u: string, op: unknown, key: string | null) => world.server(id).handle(u, op, key) }),
} as unknown as DurableObjectNamespace<Server>;

const sessions = {
  idFromName: (name: string) => name,
  get: (userId: string) => ({
    createServer: (u: string, key: string, name: string) => world.session(u).core.createServer(u, key, name),
    setStatus: (u: string, status: "online") => world.session(u).core.setStatus(u, status, []),
    fetch: async (request: Request) => {
      upgrades.push(request);
      return new Response(null, { status: 200, headers: { "x-user": userId } });
    },
  }),
} as unknown as DurableObjectNamespace<UserSession>;

const userLimit = { limit: async () => ({ success: !limited }) } as RateLimit;

/** A signed-in user with a valid access token. */
async function signedIn(): Promise<{ userId: string; token: string }> {
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
    .bind(newId(), userId, deviceId, await hashToken(token), now + 3_600_000, await hashToken(newToken()), now + 86_400_000, now)
    .run();
  return { userId, token };
}

let keyCounter = 0;

async function call(method: string, path: string, opts: { token?: string; body?: unknown; key?: string | null; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const key = opts.key === undefined ? (method === "GET" ? null : `k-${++keyCounter}-abcdef`) : opts.key;
  if (key) headers["idempotency-key"] = key;
  const request = new Request(`https://api.test${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) }),
  });
  const revokeConversationAccess = async (conversationId: string, userId: string) => {
    revoked.push({ conversationId, userId });
  };
  const res = await handleServers(request, { db, servers, sessions, now: () => world.now, userLimit, revokeConversationAccess });
  if (!res) throw new Error(`unrouted ${method} ${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}

async function inviteIndex(code: string) {
  return db.prepare("SELECT server_id FROM invite_codes WHERE code = ?").bind(code).first<{ server_id: string }>();
}

describe("server routes", () => {
  it("ignores paths it does not own", async () => {
    const res = await handleServers(new Request("https://api.test/auth/devices"), { db, servers, sessions, now: () => world.now });
    expect(res).toBeNull();
  });

  it("requires a signed-in user", async () => {
    expect((await call("POST", "/servers", { body: { name: "x" } })).status).toBe(401);
  });

  it("applies the per-user limit", async () => {
    const { token } = await signedIn();
    limited = true;
    expect((await call("POST", "/servers", { token, body: { name: "x" } })).status).toBe(429);
  });

  it("creates a server once per idempotency key", async () => {
    const { token } = await signedIn();
    expect((await call("POST", "/servers", { token, body: { name: "x" }, key: null })).status).toBe(400);
    expect((await call("POST", "/servers", { token, body: { name: "x" }, key: "bad key!" })).status).toBe(400);
    const first = await call("POST", "/servers", { token, body: { name: "Home" }, key: "create-home-1" });
    const retry = await call("POST", "/servers", { token, body: { name: "Home" }, key: "create-home-1" });
    expect(first.status).toBe(201);
    expect(retry.body.server.id).toBe(first.body.server.id);
  });

  it("runs the invite, join and message flow end to end", async () => {
    const owner = await signedIn();
    const guest = await signedIn();
    const created = await call("POST", "/servers", { token: owner.token, body: { name: "Home" } });
    const serverId = created.body.server.id as string;
    const general = created.body.channels[0].id as string;

    const invite = await call("POST", `/servers/${serverId}/invites`, { token: owner.token, body: { maxUses: 1 } });
    expect(invite.status).toBe(201);
    expect(invite.body).not.toHaveProperty("effects");
    expect(await inviteIndex(invite.body.code)).toEqual({ server_id: serverId });

    const preview = await call("GET", `/invites/${invite.body.code}`, { token: guest.token });
    expect(preview.body).toMatchObject({ server: { id: serverId, name: "Home" }, memberCount: 1 });

    const joined = await call("POST", `/invites/${invite.body.code}`, { token: guest.token });
    expect(joined).toMatchObject({ status: 200, body: { serverId } });
    // Single use, so the index row is gone.
    expect(await inviteIndex(invite.body.code)).toBeNull();
    expect((await call("POST", `/invites/${invite.body.code}`, { token: (await signedIn()).token })).status).toBe(404);

    const ciphertext = btoa("hello, encrypted");
    const sent = await call("POST", `/servers/${serverId}/channels/${general}/messages`, {
      token: guest.token,
      body: { ciphertext, epoch: 0 },
    });
    expect(sent.status).toBe(201);
    const history = await call("GET", `/servers/${serverId}/channels/${general}/messages?limit=10`, { token: owner.token });
    expect(history.body.map((m: { id: string }) => m.id)).toEqual([sent.body.id]);

    expect((await call("DELETE", `/servers/${serverId}/members/@me`, { token: guest.token })).status).toBe(204);
    expect((await call("GET", `/servers/${serverId}/channels/${general}/messages`, { token: guest.token })).status).toBe(404);
  });

  it("drops revoked and expired codes from the index", async () => {
    const owner = await signedIn();
    const serverId = (await call("POST", "/servers", { token: owner.token, body: { name: "Home" } })).body.server.id;
    const revoked = (await call("POST", `/servers/${serverId}/invites`, { token: owner.token, body: {} })).body.code;
    expect((await call("DELETE", `/invites/${revoked}`, { token: owner.token })).status).toBe(204);
    expect(await inviteIndex(revoked)).toBeNull();

    const expiring = (await call("POST", `/servers/${serverId}/invites`, { token: owner.token, body: { maxAgeSeconds: 60 } })).body.code;
    world.now += 120_000;
    await cleanupInviteCodes(db, world.now);
    expect(await inviteIndex(expiring)).toBeNull();
  });

  it("does not let a non-member revoke an invite", async () => {
    const owner = await signedIn();
    const stranger = await signedIn();
    const serverId = (await call("POST", "/servers", { token: owner.token, body: { name: "Home" } })).body.server.id;
    const code = (await call("POST", `/servers/${serverId}/invites`, { token: owner.token, body: {} })).body.code;
    expect((await call("DELETE", `/invites/${code}`, { token: stranger.token })).status).toBe(404);
    expect(await inviteIndex(code)).toEqual({ server_id: serverId });
  });

  it("rejects oversized and malformed bodies", async () => {
    const { token } = await signedIn();
    const serverId = (await call("POST", "/servers", { token, body: { name: "Home" } })).body.server.id;
    const huge = JSON.stringify({ ciphertext: "A".repeat(40_000), epoch: 0 });
    const channel = newId();
    expect((await call("POST", `/servers/${serverId}/channels/${channel}/messages`, { token, body: huge })).status).toBe(413);
    expect((await call("POST", `/servers/${serverId}/channels/${channel}/messages`, { token, body: "{" })).status).toBe(400);
    expect((await call("POST", `/servers/${serverId}/channels`, { token, body: { name: "" } })).status).toBe(400);
    expect((await call("GET", `/servers/not-an-id/channels`, { token })).status).toBe(404);
  });

  it("sets presence", async () => {
    const { token } = await signedIn();
    expect((await call("PUT", "/presence", { token, body: { status: "dnd" } })).status).toBe(204);
    expect((await call("PUT", "/presence", { token, body: { status: "away" } })).status).toBe(400);
  });
});

describe("moderation routes", () => {
  async function setup() {
    const owner = await signedIn();
    const member = await signedIn();
    const created = await call("POST", "/servers", { token: owner.token, body: { name: "Home" } });
    const serverId = created.body.server.id as string;
    const general = created.body.channels[0].id as string;
    const code = (await call("POST", `/servers/${serverId}/invites`, { token: owner.token, body: { maxUses: 1 } })).body.code;
    await call("POST", `/invites/${code}`, { token: member.token });
    return { owner, member, serverId, general };
  }

  it("times out and lifts a timeout", async () => {
    const { owner, member, serverId, general } = await setup();
    const path = `/servers/${serverId}/members/${member.userId}/timeout`;
    const put = await call("PUT", path, { token: owner.token, body: { seconds: 60, reason: "calm down" } });
    expect(put).toMatchObject({ status: 200, body: { userId: member.userId, timeoutUntil: world.now + 60_000 } });
    const blocked = await call("POST", `/servers/${serverId}/channels/${general}/messages`, {
      token: member.token,
      body: { ciphertext: btoa("hi"), epoch: 0 },
    });
    expect(blocked.status).toBe(403);
    expect((await call("PUT", path, { token: owner.token, body: { seconds: 0 } })).status).toBe(400);
    expect((await call("DELETE", path, { token: owner.token })).body.timeoutUntil).toBeNull();
  });

  it("kicks with a reason and needs an idempotency key", async () => {
    const { owner, member, serverId } = await setup();
    const path = `/servers/${serverId}/members/${member.userId}`;
    expect((await call("DELETE", path, { token: owner.token, key: null })).status).toBe(400);
    expect((await call("DELETE", path, { token: owner.token, body: { reason: "bye" } })).status).toBe(204);
    const log = await call("GET", `/servers/${serverId}/audit-log?action=member.kick`, { token: owner.token });
    expect(log.body).toEqual([expect.objectContaining({ action: "member.kick", targetId: member.userId, reason: "bye" })]);
  });

  it("cuts kicked and banned members off the server's encrypted channels", async () => {
    const { owner, member, serverId, general } = await setup();
    const [inChannel, otherServer] = ["AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBB"];
    await db.prepare("INSERT INTO channel_conversations VALUES (?, ?, ?)").bind(general, serverId, inChannel).run();
    await db.prepare("INSERT INTO channel_conversations VALUES (?, ?, ?)").bind(newId(), newId(), otherServer).run();
    for (const cid of [inChannel, otherServer]) {
      await db.prepare("INSERT INTO conversation_members VALUES (?, ?)").bind(cid, member.userId).run();
    }

    // A failed kick revokes nothing.
    await call("DELETE", `/servers/${serverId}/members/${owner.userId}`, { token: member.token });
    expect(revoked).toEqual([]);

    await call("DELETE", `/servers/${serverId}/members/${member.userId}`, { token: owner.token });
    expect(revoked).toEqual([{ conversationId: inChannel, userId: member.userId }]);
    await call("PUT", `/servers/${serverId}/bans/${member.userId}`, { token: owner.token, body: {} });
    expect(revoked).toHaveLength(2);
  });

  it("bans, lists bans and unbans", async () => {
    const { owner, member, serverId } = await setup();
    const path = `/servers/${serverId}/bans/${member.userId}`;
    expect((await call("PUT", path, { token: owner.token, body: { reason: "spam", deleteMessageSeconds: 3600 } })).status).toBe(204);
    const bans = await call("GET", `/servers/${serverId}/bans?limit=5`, { token: owner.token });
    expect(bans.body).toEqual([expect.objectContaining({ userId: member.userId, reason: "spam" })]);
    expect((await call("GET", `/servers/${serverId}/bans?limit=500`, { token: owner.token })).status).toBe(400);
    expect((await call("DELETE", path, { token: owner.token })).status).toBe(204);
    expect((await call("GET", `/servers/${serverId}/bans`, { token: owner.token })).body).toEqual([]);
  });

  it("files, lists and resolves reports", async () => {
    const { owner, member, serverId, general } = await setup();
    const sent = await call("POST", `/servers/${serverId}/channels/${general}/messages`, {
      token: owner.token,
      body: { ciphertext: btoa("hi"), epoch: 0 },
    });
    const filed = await call("POST", `/servers/${serverId}/reports`, {
      token: member.token,
      body: { channelId: general, category: "spam", note: "keeps posting links", messages: [{ id: sent.body.id, content: "buy now" }] },
    });
    expect(filed).toMatchObject({ status: 201, body: { status: "open" } });
    expect((await call("GET", `/servers/${serverId}/reports`, { token: member.token })).status).toBe(403);

    const list = await call("GET", `/servers/${serverId}/reports?status=open`, { token: owner.token });
    expect(list.body).toEqual([expect.objectContaining({ id: filed.body.id, note: "keeps posting links" })]);
    const resolved = await call("PATCH", `/servers/${serverId}/reports/${filed.body.id}`, { token: owner.token, body: { status: "resolved" } });
    expect(resolved.body.status).toBe("resolved");
    expect((await call("PATCH", `/servers/${serverId}/reports/${filed.body.id}`, { token: owner.token, body: { status: "gone" } })).status).toBe(400);
  });

  it("sets slow mode on a channel", async () => {
    const { owner, serverId, general } = await setup();
    const res = await call("PATCH", `/servers/${serverId}/channels/${general}`, { token: owner.token, body: { slowModeSeconds: 30 } });
    expect(res.body.slowModeSeconds).toBe(30);
  });

  it("deletes a server and drops its invite codes from the index", async () => {
    const { owner, member, serverId } = await setup();
    const code = (await call("POST", `/servers/${serverId}/invites`, { token: owner.token, body: {} })).body.code;
    expect((await call("DELETE", `/servers/${serverId}`, { token: member.token })).status).toBe(403);
    expect((await call("DELETE", `/servers/${serverId}`, { token: owner.token })).status).toBe(204);
    expect(await inviteIndex(code)).toBeNull();
    expect((await call("GET", `/servers/${serverId}/audit-log`, { token: owner.token })).status).toBe(404);
  });
});

describe("gateway upgrade", () => {
  const upgrade = (protocols: string) => ({ upgrade: "websocket", "sec-websocket-protocol": protocols });

  it("authenticates with the token subprotocol and forwards who the user is", async () => {
    const { userId, token } = await signedIn();
    const res = await call("GET", "/gateway", { headers: upgrade(`bastion.v1, bastion.auth.${token}`) });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-user")).toBe(userId);
    const forwarded = upgrades[0]!;
    expect(forwarded.headers.get("x-bastion-user")).toBe(userId);
    expect(forwarded.headers.get("x-bastion-session")).toMatch(/^[0-9A-Z]{26}$/);
    // The token is not passed further than the Worker.
    expect(forwarded.headers.get("sec-websocket-protocol")).toBeNull();
    expect(forwarded.headers.get("authorization")).toBeNull();
  });

  it("refuses bad tokens, missing protocols and plain requests", async () => {
    expect((await call("GET", "/gateway", { headers: upgrade(`bastion.v1, bastion.auth.${newToken()}`) })).status).toBe(401);
    expect((await call("GET", "/gateway", { headers: upgrade("chat") })).status).toBe(400);
    expect((await call("GET", "/gateway")).status).toBe(426);
    expect(upgrades).toEqual([]);
  });
});
