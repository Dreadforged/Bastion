import { newId, Permission as P, type GatewayEvent } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { CONVERSATION_LIMITS, ConversationCore, type ConversationInit, type ConversationReply } from "../src/conversation/core.js";
import { CONVERSATION_MIGRATIONS } from "../src/conversation/schema.js";
import { migrate } from "../src/storage.js";
import { createTestStorage } from "./world.js";

const CID = "AAAAAAAAAAAAAAAAAAAAAA";

/** Stand-in MLS blobs; the object never looks inside. */
const blob = (tag: string) => btoa(tag.padEnd(12, "."));

let now: number;
let notified: { users: string[]; event: GatewayEvent }[];
/** Channel permissions by user, for channel conversations. */
let perms: Map<string, bigint>;
let core: ConversationCore;
let keyCounter: number;

beforeEach(() => {
  now = 1_000_000;
  notified = [];
  perms = new Map();
  keyCounter = 0;
  const storage = createTestStorage();
  migrate(storage, CONVERSATION_MIGRATIONS);
  core = new ConversationCore(storage, {
    now: () => now,
    notify: async (users, event) => {
      notified.push({ users, event });
    },
    channelAccess: async (_s, _c, actorId, userIds) => {
      if (!(perms.get(actorId) ?? 0n)) return null;
      return new Map(userIds.map((u) => [u, perms.get(u) ?? 0n]));
    },
  });
});

interface Dev {
  userId: string;
  deviceId: string;
}

function user(): Dev {
  return { userId: newId(), deviceId: newId() };
}

function deviceOf(u: Dev): Dev {
  return { userId: u.userId, deviceId: newId() };
}

async function init(kind: ConversationInit["kind"], creator: Dev, extra: Partial<ConversationInit> = {}): Promise<ConversationReply> {
  return core.init({ id: CID, kind, creator, ...extra });
}

const epochOf = async (d: Dev) => ((await core.handle(d, { type: "get" }, null)).body as { epoch: number }).epoch;

async function commit(by: Dev, opts: { adds?: Dev[]; removes?: Dev[]; epoch?: number } = {}): Promise<ConversationReply> {
  const adds = opts.adds ?? [];
  const body = {
    epoch: opts.epoch ?? (await epochOf(by)),
    commit: blob(`commit${keyCounter}`),
    adds,
    removes: opts.removes ?? [],
    ...(adds.length > 0 ? { welcome: blob(`welcome${keyCounter}`) } : {}),
  };
  return core.handle(by, { type: "commit", body }, `key-${++keyCounter}`);
}

async function send(by: Dev, text: string, epoch?: number): Promise<ConversationReply> {
  const body = { epoch: epoch ?? (await epochOf(by)), ciphertext: blob(text) };
  return core.handle(by, { type: "send", body }, `key-${++keyCounter}`);
}

async function fetchAll(d: Dev, after = 0) {
  const r = await core.handle(d, { type: "fetch", query: { after, limit: 200 } }, null);
  return r as ConversationReply & { body: { envelopes: { seq: number; kind: string; data: string }[] } };
}

const kinds = async (d: Dev) => (await fetchAll(d)).body.envelopes.map((e) => e.kind);
const texts = async (d: Dev) =>
  (await fetchAll(d)).body.envelopes.filter((e) => e.kind === "message").map((e) => atob(e.data).replace(/\.+$/, ""));

describe("direct messages", () => {
  it("adds the peer's devices and delivers in order", async () => {
    const alice = user();
    const bob = user();
    const bobPhone = deviceOf(bob);
    expect((await init("dm", alice, { peerId: bob.userId })).status).toBe(201);
    expect(notified[0]?.users).toEqual([bob.userId]);

    const r = await commit(alice, { adds: [bob, bobPhone] });
    expect(r.status).toBe(201);
    expect(r.body).toEqual({ seq: 1, epoch: 1 });

    expect((await send(alice, "hi bob")).status).toBe(201);
    expect((await send(bob, "hey")).status).toBe(201);
    expect(await kinds(bob)).toEqual(["welcome", "message", "message"]);
    expect(await texts(bobPhone)).toEqual(["hi bob", "hey"]);
    expect(await kinds(alice)).toEqual(["commit", "message", "message"]);

    const update = notified.at(-1)!;
    expect(update.event.t).toBe("CONVERSATION_UPDATE");
    expect(new Set(update.users)).toEqual(new Set([alice.userId, bob.userId]));
  });

  it("refuses a third person", async () => {
    const [alice, bob, carol] = [user(), user(), user()];
    await init("dm", alice, { peerId: bob.userId });
    expect((await commit(alice, { adds: [carol] })).body).toMatchObject({ error: "cannot_add_to_dm" });
  });

  it("orders commits: one per epoch", async () => {
    const [alice, bob] = [user(), user()];
    await init("dm", alice, { peerId: bob.userId });
    await commit(alice, { adds: [bob] });
    expect((await commit(alice, { epoch: 1 })).status).toBe(201);
    const late = await commit(bob, { epoch: 1 });
    expect(late.status).toBe(409);
    expect(late.body).toEqual({ error: "stale_epoch", epoch: 2 });
    expect((await send(bob, "old", 1)).body).toMatchObject({ error: "stale_epoch" });
  });

  it("only lets group devices act", async () => {
    const [alice, bob, mallory] = [user(), user(), user()];
    await init("dm", alice, { peerId: bob.userId });
    // Bob is a member but his device isn't in the MLS group yet.
    expect((await send(bob, "early", 0)).body).toMatchObject({ error: "device_not_in_group" });
    expect((await core.handle(mallory, { type: "get" }, null)).status).toBe(404);
    expect((await fetchAll(mallory)).status).toBe(404);
  });
});

describe("private groups", () => {
  it("lets only the owner add people, but anyone add their own device", async () => {
    const [owner, bob, carol] = [user(), user(), user()];
    await init("group", owner);
    expect((await commit(owner, { adds: [bob] })).effects).toEqual({ added: [bob.userId] });
    expect((await commit(bob, { adds: [carol] })).body).toMatchObject({ error: "missing_permission" });
    expect((await commit(bob, { adds: [deviceOf(bob)] })).status).toBe(201);
  });

  it("does not show a new device anything from before it joined", async () => {
    const [owner, bob] = [user(), user()];
    await init("group", owner);
    await commit(owner, { adds: [bob] });
    await send(owner, "before");
    const laptop = deviceOf(bob);
    await commit(bob, { adds: [laptop] });
    await send(owner, "after");
    expect(await kinds(laptop)).toEqual(["welcome", "message"]);
    expect(await texts(laptop)).toEqual(["after"]);
    expect(await texts(bob)).toEqual(["before", "after"]);
  });

  it("caps membership", async () => {
    const owner = user();
    await init("group", owner);
    const many = Array.from({ length: 49 }, user);
    expect((await commit(owner, { adds: many })).status).toBe(201);
    expect((await commit(owner, { adds: [user()] })).body).toMatchObject({ error: "too_many_members", max: 50 });
  });

  it("rotates keys on removal and cuts the removed member off", async () => {
    const [owner, bob, carol] = [user(), user(), user()];
    await init("group", owner);
    await commit(owner, { adds: [bob, carol] });
    await send(owner, "all three");

    expect((await commit(bob, { removes: [carol] })).body).toMatchObject({ error: "cannot_remove" });
    const r = await commit(owner, { removes: [carol] });
    expect(r.status).toBe(201);
    expect(r.effects).toEqual({ removed: [carol.userId] });
    expect(await epochOf(owner)).toBe(2);
    await send(owner, "two of us");

    // Carol sees the commit that removed her and nothing after it.
    expect(await kinds(carol)).toEqual(["welcome", "message", "commit"]);
    expect((await send(carol, "hello?", 2)).status).toBe(404);
    expect(await texts(bob)).toEqual(["all three", "two of us"]);
  });

  it("lets a member leave by removing their own devices", async () => {
    const [owner, bob] = [user(), user()];
    const bobPhone = deviceOf(bob);
    await init("group", owner);
    await commit(owner, { adds: [bob, bobPhone] });
    const r = await commit(bob, { removes: [bobPhone] });
    expect(r.effects).toEqual({});
    expect((await commit(bob, { removes: [bob] })).body).toMatchObject({ error: "cannot_remove_self_device" });
  });
});

describe("encrypted channels", () => {
  const VIEW_SEND = P.VIEW_CHANNEL | P.SEND_MESSAGES;
  const extra = { serverId: newId(), channelId: newId() };

  it("needs MANAGE_CHANNELS to set up", async () => {
    const mod = user();
    perms.set(mod.userId, VIEW_SEND);
    expect((await init("channel", mod, extra)).status).toBe(403);
    perms.set(mod.userId, VIEW_SEND | P.MANAGE_CHANNELS);
    expect((await init("channel", mod, extra)).status).toBe(201);
  });

  it("only adds people who can see the channel", async () => {
    const [mod, bob, outsider] = [user(), user(), user()];
    perms.set(mod.userId, VIEW_SEND | P.MANAGE_CHANNELS);
    perms.set(bob.userId, VIEW_SEND);
    await init("channel", mod, extra);
    expect((await commit(mod, { adds: [outsider] })).body).toMatchObject({ error: "cannot_view_channel" });
    expect((await commit(mod, { adds: [bob] })).status).toBe(201);
  });

  it("blocks new messages until a member who lost access is removed", async () => {
    const [mod, bob, carol] = [user(), user(), user()];
    perms.set(mod.userId, VIEW_SEND | P.MANAGE_CHANNELS);
    perms.set(bob.userId, VIEW_SEND);
    perms.set(carol.userId, VIEW_SEND);
    await init("channel", mod, extra);
    await commit(mod, { adds: [bob, carol] });
    await send(bob, "hi all");

    perms.delete(carol.userId);
    now += CONVERSATION_LIMITS.auditIntervalMs;
    const blocked = await send(bob, "secret");
    expect(blocked.status).toBe(409);
    expect(blocked.body).toEqual({ error: "rotation_required", userIds: [carol.userId] });

    // Carol is cut off at once: no reads past the cutoff, no writes.
    expect((await send(carol, "still here?", 1)).body).toMatchObject({ error: "access_revoked" });
    const before = await kinds(carol);

    // Any member may commit her removal; then the conversation moves on.
    expect((await commit(bob, { removes: [carol] })).effects).toEqual({ removed: [carol.userId] });
    expect((await send(bob, "secret")).status).toBe(201);
    // Once removed she gets the removing commit, as in groups, but nothing said after.
    expect(await kinds(carol)).toEqual([...before, "commit"]);
    expect(await texts(mod)).toEqual(["hi all", "secret"]);
  });

  it("unmarks someone who gets access back before removal", async () => {
    const [mod, bob] = [user(), user()];
    perms.set(mod.userId, VIEW_SEND | P.MANAGE_CHANNELS);
    perms.set(bob.userId, VIEW_SEND);
    await init("channel", mod, extra);
    await commit(mod, { adds: [bob] });
    await core.revoke([bob.userId]);
    expect((await send(mod, "wait")).body).toMatchObject({ error: "rotation_required" });
    now += CONVERSATION_LIMITS.auditIntervalMs;
    expect((await send(mod, "ok")).status).toBe(201);
  });

  it("needs SEND_MESSAGES to send", async () => {
    const [mod, reader] = [user(), user()];
    perms.set(mod.userId, VIEW_SEND | P.MANAGE_CHANNELS);
    perms.set(reader.userId, P.VIEW_CHANNEL);
    await init("channel", mod, extra);
    await commit(mod, { adds: [reader] });
    expect((await send(reader, "hi")).body).toMatchObject({ error: "missing_permission" });
  });
});

describe("retries", () => {
  it("replays a write with the same key and rejects a reused key", async () => {
    const [alice, bob] = [user(), user()];
    await init("dm", alice, { peerId: bob.userId });
    const body = { epoch: 0, commit: blob("c"), adds: [bob], removes: [], welcome: blob("w") };
    const first = await core.handle(alice, { type: "commit", body }, "same-key-1");
    const again = await core.handle(alice, { type: "commit", body }, "same-key-1");
    expect(again).toEqual(first);
    expect((await core.handle(alice, { type: "send", body: { epoch: 1, ciphertext: blob("x") } }, "same-key-1")).status).toBe(422);
    expect((await core.handle(alice, { type: "send", body: { epoch: 1, ciphertext: blob("x") } }, null)).status).toBe(400);
  });
});
