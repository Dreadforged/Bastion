import { newId, schemas, type GatewayEvent } from "@bastion/shared";
import type { Conversation } from "@bastion/durable";
import { beforeEach, describe, expect, it } from "vitest";
import { ConversationCore } from "../../durable/src/conversation/core.js";
import { CONVERSATION_MIGRATIONS } from "../../durable/src/conversation/schema.js";
import { migrate } from "../../durable/src/storage.js";
import { createTestStorage } from "../../durable/test/world.js";
import { hashToken, newToken } from "../src/auth/crypto.js";
import { handleConversations } from "../src/conversations/routes.js";
import type { VoiceDeps } from "../src/voice/livekit.js";
import { createTestD1 } from "./d1.js";
import { FakeLiveKitAdmin } from "./fake-livekit.js";

const DM = "AAAAAAAAAAAAAAAAAAAAAA";
const GROUP = "BBBBBBBBBBBBBBBBBBBBBB";
const GROUP2 = "CCCCCCCCCCCCCCCCCCCCCC";
const now = 1_700_000_000_000;

let db: D1Database;
let objects: Map<string, ConversationCore>;
let admin: FakeLiveKitAdmin;
let voice: VoiceDeps | undefined;
let events: { users: string[]; event: GatewayEvent }[];
let plans: Map<string, schemas.Plan>;

beforeEach(() => {
  db = createTestD1();
  objects = new Map();
  admin = new FakeLiveKitAdmin();
  voice = { config: { url: "wss://voice.test", apiKey: "APIkey123", apiSecret: "s3cret-for-tests-only-0123456789abcdef" }, admin };
  events = [];
  plans = new Map();
});

function object(id: string): ConversationCore {
  let core = objects.get(id);
  if (!core) {
    const storage = createTestStorage();
    migrate(storage, CONVERSATION_MIGRATIONS);
    core = new ConversationCore(storage, {
      now: () => now,
      notify: async (users, event) => {
        events.push({ users, event });
      },
      channelAccess: async () => null,
    });
    objects.set(id, core);
  }
  return core;
}

const conversations = {
  idFromName: (name: string) => name,
  get: (id: string) => ({
    init: (init: Parameters<ConversationCore["init"]>[0]) => object(id).init(init),
    handle: (actor: { userId: string; deviceId: string }, op: unknown, key: string | null) => object(id).handle(actor, op, key),
  }),
} as unknown as DurableObjectNamespace<Conversation>;

interface Session {
  userId: string;
  deviceId: string;
  token: string;
}

async function signedIn(): Promise<Session> {
  const userId = newId();
  const deviceId = newId();
  const token = newToken();
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
  return { userId, deviceId, token };
}

async function addMember(conversationId: string, userId: string): Promise<void> {
  await db.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)").bind(conversationId, userId).run();
}

/** A DM between two people, plus a clean two-person group for the call's keys. */
async function pair() {
  const alice = await signedIn();
  const bob = await signedIn();
  await object(DM).init({ id: DM, kind: "dm", creator: alice, peerId: bob.userId });
  await addMember(DM, alice.userId);
  await addMember(DM, bob.userId);
  await addMember(GROUP, alice.userId);
  await addMember(GROUP, bob.userId);
  events = [];
  return { alice, bob };
}

async function http(method: string, path: string, as: Session | null, body?: unknown) {
  const headers: Record<string, string> = {};
  if (as) headers.authorization = `Bearer ${as.token}`;
  const request = new Request(`https://api.test${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const res = await handleConversations(request, { db, conversations, now: () => now, voice, planFor: async (u) => plans.get(u) ?? "free" });
  if (!res) throw new Error("unrouted");
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const ring = (as: Session, group = GROUP, extra: object = {}) => http("POST", `/conversations/${DM}/call`, as, { groupConversationId: group, ...extra });
const answer = (as: Session, extra: object = {}) => http("POST", `/conversations/${DM}/call/accept`, as, extra);

describe("starting a call", () => {
  it("rings and returns a signed LiveKit token for the caller", async () => {
    const { alice, bob } = await pair();
    const r = await ring(alice);
    expect(r.status).toBe(200);
    const t = schemas.DmCallToken.parse(r.body);
    expect(t.url).toBe("wss://voice.test");
    expect(t.call.state).toBe("ringing");
    expect(t.call.calleeId).toBe(bob.userId);
    expect(t.canPublish).toBe(true);
    // The token names only the random ids: no user, device or conversation.
    const claims = JSON.parse(atob(t.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.sub).toBe(t.participantId);
    expect(claims.video.room).toBe(t.roomId);
    expect(JSON.stringify(claims)).not.toContain(alice.userId);
    expect(JSON.stringify(claims)).not.toContain(DM);
    expect(events.some((e) => e.event.t === "CALL_UPDATE" && e.users.includes(bob.userId))).toBe(true);
  });

  it("needs a session", async () => {
    await pair();
    expect((await ring(null as unknown as Session)).status).toBe(401);
  });

  it("is refused for someone who is not in the DM", async () => {
    await pair();
    const eve = await signedIn();
    const r = await ring(eve);
    expect(r.status).toBe(404);
    expect(admin.calls).toEqual([]);
  });

  it("answers 503 when voice is not configured", async () => {
    const { alice } = await pair();
    voice = undefined;
    expect((await ring(alice)).status).toBe(503);
    expect(events).toEqual([]);
  });

  it("insists on a clean two-person key group", async () => {
    const { alice } = await pair();
    const eve = await signedIn();
    // Unknown group, a third member, the DM itself, a DM pair, a channel conversation.
    expect((await ring(alice, GROUP2)).status).toBe(400);
    await addMember(GROUP2, alice.userId);
    expect((await ring(alice, GROUP2)).status).toBe(400);
    await addMember(GROUP, eve.userId);
    expect((await ring(alice)).status).toBe(400);
    expect((await ring(alice, DM)).status).toBe(400);
    expect(events).toEqual([]);

    await db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?").bind(GROUP, eve.userId).run();
    await db.prepare("INSERT INTO channel_conversations (channel_id, server_id, conversation_id) VALUES (?, ?, ?)").bind(newId(), newId(), GROUP).run();
    expect((await ring(alice)).status).toBe(400);
  });

  it("rejects a malformed body", async () => {
    const { alice } = await pair();
    expect((await http("POST", `/conversations/${DM}/call`, alice, { groupConversationId: "x" })).status).toBe(400);
  });

  it("gives screen share the quality of the caller's plan", async () => {
    const { alice } = await pair();
    plans.set(alice.userId, "plus");
    const t = schemas.DmCallToken.parse((await ring(alice, GROUP, { screenShare: true })).body);
    expect(t.canShare).toBe(true);
    expect(t.quality).toMatchObject({ height: 1080, fps: 60 });
    const claims = JSON.parse(atob(t.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(claims.video.canPublishSources).toContain("screen_share");
  });
});

describe("answering and ending", () => {
  it("gives the callee a token for the same room", async () => {
    const { alice, bob } = await pair();
    const a = schemas.DmCallToken.parse((await ring(alice)).body);
    const r = await answer(bob);
    expect(r.status).toBe(200);
    const b = schemas.DmCallToken.parse(r.body);
    expect(b.roomId).toBe(a.roomId);
    expect(b.participantId).not.toBe(a.participantId);
    expect(b.call.state).toBe("active");
    expect(b.canShare).toBe(false);
  });

  it("does not let the caller answer their own call or an outsider answer", async () => {
    const { alice } = await pair();
    await ring(alice);
    expect((await answer(alice)).status).toBe(404);
    expect((await answer(await signedIn())).status).toBe(404);
  });

  it("decline removes both people from LiveKit", async () => {
    const { alice, bob } = await pair();
    const a = schemas.DmCallToken.parse((await ring(alice)).body);
    const r = await http("POST", `/conversations/${DM}/call/decline`, bob);
    expect(r.status).toBe(204);
    expect(admin.calls).toHaveLength(2);
    expect(admin.calls.every((c) => c.kind === "remove" && c.roomId === a.roomId)).toBe(true);
    // The line is free again after the redial wait.
    expect((await http("GET", `/conversations/${DM}/call`, alice)).body).toEqual({ call: null });
  });

  it("either person can hang up an answered call", async () => {
    const { alice, bob } = await pair();
    await ring(alice);
    await answer(bob);
    const r = await http("DELETE", `/conversations/${DM}/call`, bob);
    expect(r.status).toBe(204);
    expect(admin.calls).toHaveLength(2);
    expect((await http("DELETE", `/conversations/${DM}/call`, alice)).status).toBe(204);
  });

  it("still ends the call when LiveKit is down", async () => {
    const { alice, bob } = await pair();
    await ring(alice);
    admin.failing = true;
    expect((await http("POST", `/conversations/${DM}/call/decline`, bob)).status).toBe(204);
    expect((await http("GET", `/conversations/${DM}/call`, alice)).body).toEqual({ call: null });
  });

  it("renews and reads the live call", async () => {
    const { alice, bob } = await pair();
    await ring(alice);
    await answer(bob);
    expect((await http("PATCH", `/conversations/${DM}/call`, alice)).status).toBe(200);
    expect((await http("GET", `/conversations/${DM}/call`, bob)).body).toMatchObject({ call: { state: "active" } });
    expect((await http("GET", `/conversations/${DM}/call`, await signedIn())).status).toBe(404);
  });

  it("unknown call paths are 404", async () => {
    const { alice } = await pair();
    expect((await http("POST", `/conversations/${DM}/call/nope`, alice)).status).toBe(404);
    expect((await http("PUT", `/conversations/${DM}/call`, alice)).status).toBe(404);
  });
});
