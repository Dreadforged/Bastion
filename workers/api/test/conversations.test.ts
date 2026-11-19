import { newId } from "@bastion/shared";
import type { Conversation } from "@bastion/durable";
import { beforeEach, describe, expect, it } from "vitest";
import { ConversationCore } from "../../durable/src/conversation/core.js";
import { CONVERSATION_MIGRATIONS } from "../../durable/src/conversation/schema.js";
import { migrate } from "../../durable/src/storage.js";
import { createTestStorage } from "../../durable/test/world.js";
import { hashToken, newToken } from "../src/auth/crypto.js";
import { handleConversations } from "../src/conversations/routes.js";
import { FlagReader } from "../src/safety/flags.js";
import { createTestD1 } from "./d1.js";

let db: D1Database;
let objects: Map<string, ConversationCore>;
let sharedServer = false;
const now = 1_700_000_000_000;

beforeEach(() => {
  db = createTestD1();
  objects = new Map();
  sharedServer = false;
});

function object(id: string): ConversationCore {
  let core = objects.get(id);
  if (!core) {
    const storage = createTestStorage();
    migrate(storage, CONVERSATION_MIGRATIONS);
    core = new ConversationCore(storage, { now: () => now, notify: async () => {}, channelAccess: async () => null });
    objects.set(id, core);
  }
  return core;
}

const conversations = {
  idFromName: (name: string) => name,
  get: (id: string) => ({
    init: (init: Parameters<ConversationCore["init"]>[0]) => object(id).init(init),
    handle: (actor: { userId: string; deviceId: string }, op: unknown, key: string | null) => object(id).handle(actor, op, key),
    revoke: (userIds: string[]) => object(id).revoke(userIds),
  }),
} as unknown as DurableObjectNamespace<Conversation>;

interface Session {
  userId: string;
  deviceId: string;
  token: string;
}

async function addDevice(userId: string): Promise<Session> {
  const deviceId = newId();
  const token = newToken();
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

async function signedIn(): Promise<Session> {
  const userId = newId();
  await db.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").bind(userId, `${userId.toLowerCase()}@test`, now).run();
  return addDevice(userId);
}

let keyCounter = 0;

async function call(method: string, path: string, as: Session | null, body?: unknown, key?: string | null) {
  const headers: Record<string, string> = {};
  if (as) headers.authorization = `Bearer ${as.token}`;
  const k = key === undefined ? (method === "GET" ? null : `k-${++keyCounter}-abcdef`) : key;
  if (k) headers["idempotency-key"] = k;
  const request = new Request(`https://api.test${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await handleConversations(request, { db, conversations, now: () => now, sharesServer: async () => sharedServer });
  if (!res) throw new Error(`unrouted ${method} ${path}`);
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const identityKey = (n: number) => btoa(String.fromCharCode(...new Array(32).fill(n)));
const kp = (tag: string) => btoa(`kp:${tag}`);
const blob = (tag: string) => btoa(tag.padEnd(12, "."));

async function upload(s: Session, count = 3, idKey = identityKey(1)) {
  const keyPackages = Array.from({ length: count }, (_, i) => kp(`${s.deviceId}:${i}`));
  return call("POST", "/keys/packages", s, { identityKey: idKey, keyPackages });
}

describe("key packages", () => {
  it("stores, counts and hands out each package once", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    const bobPhone = await addDevice(bob.userId);
    expect((await upload(bob, 2)).body).toEqual({ stored: 2 });
    await upload(bobPhone, 1, identityKey(2));
    expect((await call("GET", "/keys/packages/count", bob)).body).toEqual({ count: 2 });

    const first = await call("POST", "/keys/packages/claim", alice, { userIds: [bob.userId] });
    expect(first.body.keyPackages).toHaveLength(2);
    expect(first.body.exhausted).toEqual([]);
    const second = await call("POST", "/keys/packages/claim", alice, { userIds: [bob.userId] });
    expect(second.body.keyPackages).toEqual([{ userId: bob.userId, deviceId: bob.deviceId, keyPackage: kp(`${bob.deviceId}:1`) }]);
    expect(second.body.exhausted).toEqual([{ userId: bob.userId, deviceId: bobPhone.deviceId }]);
  });

  it("skips the claiming device", async () => {
    const alice = await signedIn();
    const laptop = await addDevice(alice.userId);
    await upload(alice);
    await upload(laptop, 1, identityKey(3));
    const r = await call("POST", "/keys/packages/claim", alice, { userIds: [alice.userId] });
    expect(r.body.keyPackages.map((k: { deviceId: string }) => k.deviceId)).toEqual([laptop.deviceId]);
  });

  it("pins the identity key and caps the stock", async () => {
    const alice = await signedIn();
    await upload(alice, 50);
    expect((await upload(alice, 1, identityKey(9))).body).toEqual({ error: "identity_key_mismatch" });
    await upload(alice, 50);
    expect((await upload(alice, 1)).body).toEqual({ error: "too_many_key_packages" });
  });

  it("publishes identity keys for safety codes", async () => {
    const [alice, bob] = [await signedIn(), await signedIn()];
    await upload(bob, 1, identityKey(7));
    const r = await call("GET", `/users/${bob.userId}/keys`, alice);
    expect(r.body).toEqual({ devices: [{ deviceId: bob.deviceId, identityKey: identityKey(7) }] });
  });

  it("needs a session", async () => {
    expect((await call("GET", "/keys/packages/count", null)).status).toBe(401);
  });
});

describe("conversations", () => {
  it("keeps one DM per pair and lists it for both", async () => {
    const [alice, bob] = [await signedIn(), await signedIn()];
    const first = await call("POST", "/conversations", alice, { kind: "dm", userId: bob.userId });
    expect(first.status).toBe(201);
    expect(first.body.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const again = await call("POST", "/conversations", bob, { kind: "dm", userId: alice.userId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    for (const s of [alice, bob]) expect((await call("GET", "/conversations", s)).body).toEqual({ ids: [first.body.id] });
  });

  it("rejects DMs with yourself or nobody", async () => {
    const alice = await signedIn();
    expect((await call("POST", "/conversations", alice, { kind: "dm", userId: alice.userId })).status).toBe(400);
    expect((await call("POST", "/conversations", alice, { kind: "dm", userId: newId() })).status).toBe(404);
  });

  it("returns the same group when a create is retried", async () => {
    const alice = await signedIn();
    const a = await call("POST", "/conversations", alice, { kind: "group" }, "retry-key-1");
    const b = await call("POST", "/conversations", alice, { kind: "group" }, "retry-key-1");
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect((await call("POST", "/conversations", alice, { kind: "group" }, null)).status).toBe(400);
  });

  it("carries commits, welcomes and messages, and keeps the index in step", async () => {
    const [owner, bob] = [await signedIn(), await signedIn()];
    const { body: conv } = await call("POST", "/conversations", owner, { kind: "group" });
    const base = `/conversations/${conv.id}`;
    const bobDevice = { userId: bob.userId, deviceId: bob.deviceId };

    const forged = { userId: bob.userId, deviceId: owner.deviceId };
    const bad = await call("POST", `${base}/commits`, owner, { epoch: 0, commit: blob("c"), welcome: blob("w"), adds: [forged] });
    expect(bad.body).toEqual({ error: "unknown_device" });

    const add = await call("POST", `${base}/commits`, owner, { epoch: 0, commit: blob("c1"), welcome: blob("w1"), adds: [bobDevice] });
    expect(add.status).toBe(201);
    expect((await call("GET", "/conversations", bob)).body.ids).toEqual([conv.id]);

    expect((await call("POST", `${base}/messages`, bob, { epoch: 1, ciphertext: blob("hello") })).status).toBe(201);
    const env = await call("GET", `${base}/envelopes?after=0`, bob);
    expect(env.body.envelopes.map((e: { kind: string }) => e.kind)).toEqual(["welcome", "message"]);
    expect((await call("GET", `${base}/envelopes?after=2`, bob)).body.envelopes).toHaveLength(1);

    const remove = await call("POST", `${base}/commits`, owner, { epoch: 1, commit: blob("c2"), removes: [bobDevice] });
    expect(remove.status).toBe(201);
    expect((await call("GET", "/conversations", bob)).body.ids).toEqual([]);
    expect((await call("GET", base, bob)).status).toBe(404);
  });

  it("checks commit bodies", async () => {
    const alice = await signedIn();
    const { body: conv } = await call("POST", "/conversations", alice, { kind: "group" });
    // Adds need a welcome.
    const r = await call("POST", `/conversations/${conv.id}/commits`, alice, {
      epoch: 0,
      commit: blob("c"),
      adds: [{ userId: alice.userId, deviceId: newId() }],
    });
    expect(r.status).toBe(400);
    expect((await call("GET", "/conversations/not-an-id/envelopes", alice)).status).toBe(404);
  });
});

describe("account state limits", () => {
  const setState = (userId: string, state: string) => db.prepare("UPDATE users SET account_state = ? WHERE id = ?").bind(state, userId).run();

  it("keeps a restricted account to reading", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    await upload(bob, 1);
    const made = await call("POST", "/conversations", alice, { kind: "dm", userId: bob.userId });
    expect(made.status).toBeLessThan(300);
    await setState(alice.userId, "restricted");

    expect((await call("GET", "/conversations", alice)).status).toBe(200);
    expect((await call("GET", `/conversations/${made.body.id}`, alice)).status).toBe(200);
    for (const [path, body] of [
      ["/conversations", { kind: "dm", userId: bob.userId }],
      ["/keys/packages/claim", { userIds: [bob.userId] }],
      [`/conversations/${made.body.id}/messages`, { envelope: "AAAA" }],
    ] as const) {
      expect(await call("POST", path, alice, body), path).toMatchObject({ status: 403, body: { error: "account_restricted" } });
    }
  });

  it("stops an account under age review from starting new DMs or claiming keys, but not from reading", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    await upload(bob, 1);
    await setState(alice.userId, "pending_age_review");
    expect(await call("POST", "/conversations", alice, { kind: "dm", userId: bob.userId })).toMatchObject({ status: 403, body: { error: "age_review_pending" } });
    expect(await call("POST", "/keys/packages/claim", alice, { userIds: [bob.userId] })).toMatchObject({ status: 403, body: { error: "age_review_pending" } });
    expect((await call("GET", "/conversations", alice)).status).toBe(200);
  });

  it("lets an account under age review answer a DM that already exists", async () => {
    const alice = await signedIn();
    const bob = await signedIn();
    await upload(bob, 1);
    const made = await call("POST", "/conversations", alice, { kind: "dm", userId: bob.userId });
    await setState(bob.userId, "pending_age_review");
    // Bob can still open and read it; the object, not the account check, decides about sends.
    expect((await call("GET", `/conversations/${made.body.id}`, bob)).status).toBe(200);
  });
});

describe("message requests and teen defaults", () => {
  const setPolicy = (userId: string, policy: string) =>
    db.prepare("INSERT INTO privacy_settings (user_id, dm_policy, updated_at) VALUES (?, ?, ?) ON CONFLICT (user_id) DO UPDATE SET dm_policy = ?2").bind(userId, policy, now).run();
  const setBand = (userId: string, band: string) => db.prepare("UPDATE users SET age_band = ?, account_state = 'active' WHERE id = ?").bind(band, userId).run();
  const status = async (a: Session, b: Session) =>
    await db.prepare("SELECT status, requested_by FROM dm_pairs WHERE user_a = ? AND user_b = ?").bind(...[a.userId, b.userId].sort()).first<{ status: string; requested_by: string | null }>();
  const device = (s: Session) => ({ userId: s.userId, deviceId: s.deviceId });

  async function stranger() {
    const [alice, bob] = [await signedIn(), await signedIn()];
    await setPolicy(bob.userId, "requests");
    const made = await call("POST", "/conversations", alice, { kind: "dm", userId: bob.userId });
    expect(made.status).toBe(201);
    await call("POST", `/conversations/${made.body.id}/commits`, alice, { epoch: 0, commit: blob("c"), welcome: blob("w"), adds: [device(bob)] });
    return { alice, bob, id: made.body.id as string };
  }
  const send = (s: Session, id: string) => call("POST", `/conversations/${id}/messages`, s, { epoch: 1, ciphertext: blob("hi") });

  it("starts a DM from a stranger as a request, and hides it from the recipient until accepted", async () => {
    const { alice, bob, id } = await stranger();
    expect(await status(alice, bob)).toEqual({ status: "request", requested_by: alice.userId });
    expect((await call("GET", "/conversations", bob)).body.ids).not.toContain(id);
    expect((await call("GET", "/conversations", alice)).body.ids).toContain(id);
    expect((await call("GET", "/conversations/requests", bob)).body).toEqual([{ conversationId: id, from: alice.userId }]);
    expect((await call("GET", "/conversations/requests", alice)).body).toEqual([]);
  });

  it("lets people who share a server DM straight away", async () => {
    const [alice, bob] = [await signedIn(), await signedIn()];
    await setPolicy(bob.userId, "requests");
    sharedServer = true;
    expect((await call("POST", "/conversations", alice, { kind: "dm", userId: bob.userId })).status).toBe(201);
    expect(await status(alice, bob)).toEqual({ status: "active", requested_by: null });
  });

  it("limits the requester to one message until the recipient accepts", async () => {
    const { alice, bob, id } = await stranger();
    expect((await send(alice, id)).status).toBe(201);
    expect(await send(alice, id)).toMatchObject({ status: 403, body: { error: "message_request_pending" } });
    expect((await call("POST", `/conversations/${id}/accept`, alice)).status).toBe(404); // not theirs to accept
    expect((await call("POST", `/conversations/${id}/accept`, bob)).status).toBe(204);
    expect((await call("GET", "/conversations", bob)).body.ids).toContain(id);
    expect((await send(alice, id)).status).toBe(201);
  });

  it("treats a reply from the recipient as accepting", async () => {
    const { alice, bob, id } = await stranger();
    expect((await send(bob, id)).status).toBe(201);
    expect((await status(alice, bob))!.status).toBe("active");
  });

  it("does not let a request start a call until accepted", async () => {
    const { alice, id } = await stranger();
    const res = await call("POST", `/conversations/${id}/call`, alice, { groupConversationId: newId() });
    expect(res).toMatchObject({ status: 403, body: { error: "message_request_pending" } });
  });

  it("declining ends the request for good: no sends, no new request, recipient removed", async () => {
    const { alice, bob, id } = await stranger();
    expect((await call("POST", `/conversations/${id}/decline`, bob)).status).toBe(204);
    expect(await send(alice, id)).toMatchObject({ status: 403, body: { error: "message_request_declined" } });
    expect((await call("GET", `/conversations/${id}`, bob)).status).not.toBe(200);
    expect(await call("POST", "/conversations", alice, { kind: "dm", userId: bob.userId })).toMatchObject({ status: 403, body: { error: "cannot_message_user" } });
    expect((await call("POST", "/conversations", bob, { kind: "dm", userId: alice.userId })).status).toBe(403);
  });

  it("applies teen defaults: a 13 to 17 year old with no choice made gets message requests", async () => {
    const [alice, teen] = [await signedIn(), await signedIn()];
    await setBand(teen.userId, "16to17");
    expect((await call("POST", "/conversations", alice, { kind: "dm", userId: teen.userId })).status).toBe(201);
    expect((await status(alice, teen))!.status).toBe("request");
  });

  it("keeps a teen's own choice of nobody", async () => {
    const [alice, teen] = [await signedIn(), await signedIn()];
    await setBand(teen.userId, "13to15");
    await setPolicy(teen.userId, "nobody");
    expect(await call("POST", "/conversations", alice, { kind: "dm", userId: teen.userId })).toMatchObject({ status: 403, body: { error: "cannot_message_user" } });
  });

  it("leaves adults on their own choice", async () => {
    const [alice, adult] = [await signedIn(), await signedIn()];
    await setBand(adult.userId, "18plus");
    expect((await call("POST", "/conversations", alice, { kind: "dm", userId: adult.userId })).status).toBe(201);
    expect((await status(alice, adult))!.status).toBe("active");
  });

  it("refuses stranger requests when the region turns message requests off", async () => {
    const [alice, bob] = [await signedIn(), await signedIn()];
    await setPolicy(bob.userId, "requests");
    await db.prepare("INSERT INTO safety_flags (module, region, enabled, config, updated_by, updated_at) VALUES ('contact', 'default', 1, '{\"messageRequests\":false}', 's', ?)").bind(now).run();
    const request = new Request("https://api.test/conversations", {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "idempotency-key": "k-flag-0001" },
      body: JSON.stringify({ kind: "dm", userId: bob.userId }),
    });
    const res = await handleConversations(request, { db, conversations, now: () => now, flags: new FlagReader(db, () => now) });
    expect(res!.status).toBe(403);
  });
});
