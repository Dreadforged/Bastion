import { newId, schemas } from "@bastion/shared";
import type { Conversation, Server, UserSession } from "@bastion/durable";
import { beforeEach, describe, expect, it } from "vitest";
import { ConversationCore } from "../../durable/src/conversation/core.js";
import { CONVERSATION_MIGRATIONS } from "../../durable/src/conversation/schema.js";
import { migrate } from "../../durable/src/storage.js";
import { createTestStorage, World } from "../../durable/test/world.js";
import { handleAccount } from "../src/account/routes.js";
import { hashToken, newToken } from "../src/auth/crypto.js";
import { handleConversations } from "../src/conversations/routes.js";
import { handleServers } from "../src/servers/routes.js";
import { createTestD1 } from "./d1.js";

let db: D1Database;
let world: World;
const now = 1_700_000_000_000;
let serverIdsFor: Record<string, string[]>;

beforeEach(() => {
  db = createTestD1();
  world = new World();
  serverIdsFor = {};
});

const sessions = {
  idFromName: (name: string) => name,
  get: (userId: string) => ({
    listServerIds: async () => serverIdsFor[userId] ?? [],
    setStatus: async () => {},
  }),
} as unknown as DurableObjectNamespace<UserSession>;

const servers = {
  idFromName: (name: string) => name,
  get: (id: string) => ({ handle: (u: string, op: unknown, key: string | null) => world.server(id).handle(u, op, key) }),
} as unknown as DurableObjectNamespace<Server>;

const objects = new Map<string, ConversationCore>();
const conversations = {
  idFromName: (name: string) => name,
  get: (id: string) => {
    let core = objects.get(id);
    if (!core) {
      const storage = createTestStorage();
      migrate(storage, CONVERSATION_MIGRATIONS);
      core = new ConversationCore(storage, { now: () => now, notify: async () => {}, channelAccess: async () => null });
      objects.set(id, core);
    }
    const c = core;
    return {
      init: (init: Parameters<ConversationCore["init"]>[0]) => c.init(init),
      handle: (actor: { userId: string; deviceId: string }, op: unknown, key: string | null) => c.handle(actor, op, key),
    };
  },
} as unknown as DurableObjectNamespace<Conversation>;

interface Session {
  userId: string;
  deviceId: string;
  token: string;
}

async function signedIn(email?: string): Promise<Session> {
  const userId = newId();
  const deviceId = newId();
  const token = newToken();
  await db
    .prepare("INSERT INTO users (id, email, recovery_hash, created_at) VALUES (?, ?, 'hash', ?)")
    .bind(userId, email ?? `${userId.toLowerCase()}@test`, now)
    .run();
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
  return { userId, deviceId, token };
}

async function account(method: string, path: string, as: Session | null, body?: unknown) {
  const request = new Request(`https://api.test${path}`, {
    method,
    headers: as ? { authorization: `Bearer ${as.token}` } : {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleAccount(request, { db, sessions, now: () => now });
  if (!res) throw new Error("unrouted");
  const text = await res.text();
  return { status: res.status, headers: res.headers, text, body: text ? JSON.parse(text) : null };
}

let n = 0;
async function createDm(as: Session, peerId: string) {
  const request = new Request("https://api.test/conversations", {
    method: "POST",
    headers: { authorization: `Bearer ${as.token}`, "idempotency-key": `dm-key-${++n}-abcdefgh` },
    body: JSON.stringify({ kind: "dm", userId: peerId }),
  });
  const res = await handleConversations(request, { db, conversations, now: () => now });
  return { status: res!.status, body: (await res!.json()) as { error?: string } };
}

describe("privacy settings", () => {
  it("starts at the defaults and requires sign-in", async () => {
    const me = await signedIn();
    expect((await account("GET", "/account/privacy", me)).body).toEqual(schemas.DEFAULT_PRIVACY);
    expect((await account("GET", "/account/privacy", null)).status).toBe(401);
  });

  it("changes one setting at a time and keeps the rest", async () => {
    const me = await signedIn();
    expect((await account("PUT", "/account/privacy", me, { typingIndicators: false })).body).toEqual({ dmPolicy: "everyone", typingIndicators: false });
    expect((await account("PUT", "/account/privacy", me, { dmPolicy: "nobody" })).body).toEqual({ dmPolicy: "nobody", typingIndicators: false });
    expect((await account("GET", "/account/privacy", me)).body).toEqual({ dmPolicy: "nobody", typingIndicators: false });
  });

  it("rejects empty, unknown and invalid changes", async () => {
    const me = await signedIn();
    expect((await account("PUT", "/account/privacy", me, {})).status).toBe(400);
    expect((await account("PUT", "/account/privacy", me, { dmPolicy: "friends" })).status).toBe(400);
    expect((await account("PUT", "/account/privacy", me, { email: "x" })).status).toBe(400);
  });

  it("is per user", async () => {
    const a = await signedIn();
    const b = await signedIn();
    await account("PUT", "/account/privacy", a, { dmPolicy: "nobody" });
    expect((await account("GET", "/account/privacy", b)).body).toEqual(schemas.DEFAULT_PRIVACY);
  });

  it("refuses a new DM to someone who accepts none, but not an existing one", async () => {
    const a = await signedIn();
    const b = await signedIn();
    const first = await createDm(a, b.userId);
    expect(first.status).toBe(201);
    await account("PUT", "/account/privacy", b, { dmPolicy: "nobody" });
    // The existing DM keeps working for both people.
    expect((await createDm(a, b.userId)).status).toBe(200);

    const c = await signedIn();
    const refused = await createDm(c, b.userId);
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("cannot_message_user");
    // And the refusal left nothing behind.
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dm_pairs").first<{ n: number }>())!.n).toBe(1);
    // They can still start DMs themselves.
    expect((await createDm(b, c.userId)).status).toBe(201);
  });

  it("drops typing events from someone who turned them off", async () => {
    const me = await signedIn();
    const serverId = newId();
    const channelId = newId();
    const typing = async () => {
      const request = new Request(`https://api.test/servers/${serverId}/channels/${channelId}/typing`, {
        method: "POST",
        headers: { authorization: `Bearer ${me.token}` },
      });
      return handleServers(request, { db, servers, sessions, now: () => now, revokeConversationAccess: async () => {} });
    };
    const sent: unknown[] = [];
    (servers as unknown as { get: unknown }).get = (id: string) => ({
      handle: async (...args: unknown[]) => {
        sent.push(args[1]);
        return { status: 204, body: null };
      },
    });
    await typing();
    expect(sent).toHaveLength(1);
    await account("PUT", "/account/privacy", me, { typingIndicators: false });
    const res = await typing();
    expect(res!.status).toBe(204);
    expect(sent).toHaveLength(1);
  });
});

describe("account export", () => {
  it("contains the account's own data and says what it leaves out", async () => {
    const me = await signedIn("me@example.com");
    const peer = await signedIn();
    await db.prepare("INSERT INTO device_identity_keys (device_id, user_id, identity_key, created_at) VALUES (?, ?, 'idkey', ?)").bind(me.deviceId, me.userId, now).run();
    await db.prepare("INSERT INTO key_packages (id, device_id, user_id, key_package) VALUES (?, ?, ?, 'kp')").bind(newId(), me.deviceId, me.userId).run();
    expect((await createDm(me, peer.userId)).status).toBe(201);
    const fileId = newId();
    await db
      .prepare(
        `INSERT INTO attachments (id, uploader_id, conversation_id, visibility, status, size, content_type, created_at, expires_at)
         VALUES (?, ?, 'conv', 'private', 'ready', 10, 'application/octet-stream', ?, ?)`,
      )
      .bind(fileId, me.userId, now, now + 1000)
      .run();
    const serverId = newId();
    serverIdsFor[me.userId] = [serverId];
    await account("PUT", "/account/privacy", me, { dmPolicy: "nobody" });

    const res = await account("GET", "/account/export", me);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const data = schemas.AccountExport.parse(res.body);
    expect(data.account).toMatchObject({ id: me.userId, email: "me@example.com", createdAt: now, recoveryCodeActive: true });
    expect(data.privacy.dmPolicy).toBe("nobody");
    expect(data.devices).toEqual([{ id: me.deviceId, name: "Laptop", createdAt: now, lastSeenAt: null, identityKey: "idkey", unusedKeyPackages: 1 }]);
    expect(data.servers).toEqual([serverId]);
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0]).toMatchObject({ kind: "dm", peerId: peer.userId });
    expect(data.files.map((f) => f.id)).toEqual([fileId]);
    expect(data.notIncluded.length).toBeGreaterThan(0);
  });

  it("never includes secrets or other people's records", async () => {
    const me = await signedIn();
    const other = await signedIn("other@example.com");
    const res = await account("GET", "/account/export", me);
    expect(res.text).not.toContain("other@example.com");
    expect(res.text).not.toContain(other.userId);
    expect(res.text).not.toContain("recovery_hash");
    expect(res.text).not.toContain("access_hash");
    expect(res.text).not.toContain(me.token);
    expect(res.text).not.toContain("public_key");
    expect(res.text).not.toContain("credential");
  });

  it("is limited to a few exports an hour and needs sign-in", async () => {
    const me = await signedIn();
    expect((await account("GET", "/account/export", null)).status).toBe(401);
    for (let i = 0; i < 3; i++) expect((await account("GET", "/account/export", me)).status).toBe(200);
    expect((await account("GET", "/account/export", me)).status).toBe(429);
  });

  it("answers unknown account paths with 404", async () => {
    const me = await signedIn();
    expect((await account("GET", "/account/nothing", me)).status).toBe(404);
    expect((await account("DELETE", "/account/export", me)).status).toBe(404);
  });
});
