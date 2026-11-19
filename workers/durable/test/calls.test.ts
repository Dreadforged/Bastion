import { newId, schemas, type GatewayEvent } from "@bastion/shared";

const { CALL_LIMITS } = schemas;
import { beforeEach, describe, expect, it } from "vitest";
import { ConversationCore, type ConversationReply } from "../src/conversation/core.js";
import { CONVERSATION_MIGRATIONS } from "../src/conversation/schema.js";
import { migrate } from "../src/storage.js";
import { createTestStorage } from "./world.js";

const DM = "AAAAAAAAAAAAAAAAAAAAAA";
const GROUP = "BBBBBBBBBBBBBBBBBBBBBB";
const GROUP2 = "CCCCCCCCCCCCCCCCCCCCCC";

let now: number;
let notified: { users: string[]; event: GatewayEvent }[];
let core: ConversationCore;

interface Dev {
  userId: string;
  deviceId: string;
}
const user = (): Dev => ({ userId: newId(), deviceId: newId() });

let alice: Dev;
let bob: Dev;

beforeEach(async () => {
  now = 1_000_000;
  notified = [];
  const storage = createTestStorage();
  migrate(storage, CONVERSATION_MIGRATIONS);
  core = new ConversationCore(storage, {
    now: () => now,
    notify: async (users, event) => {
      notified.push({ users, event });
    },
    channelAccess: async () => null,
  });
  alice = user();
  bob = user();
  await core.init({ id: DM, kind: "dm", creator: alice, peerId: bob.userId });
  notified = [];
});

const op = (actor: Dev, o: Record<string, unknown>): Promise<ConversationReply> => core.handle(actor, o, null);
const start = (actor = alice, group = GROUP, plan: "free" | "plus" = "free", screenShare = false) =>
  op(actor, { type: "call.start", body: { groupConversationId: group, screenShare }, plan });
const accept = (actor = bob, plan: "free" | "plus" = "free", screenShare = false) =>
  op(actor, { type: "call.accept", body: { screenShare }, plan });
const calls = () => notified.filter((n) => n.event.t === "CALL_UPDATE");
const states = () => calls().map((n) => (n.event.d as { state: string }).state);

describe("ringing", () => {
  it("rings the other person and gives the caller a grant", async () => {
    const r = await start();
    expect(r.status).toBe(200);
    const g = r.body as { call: { state: string; calleeId: string; ringExpiresAt: number }; roomId: string; participantId: string; canShare: boolean };
    expect(g.call.state).toBe("ringing");
    expect(g.call.calleeId).toBe(bob.userId);
    expect(g.call.ringExpiresAt).toBe(now + CALL_LIMITS.ringSeconds * 1000);
    expect(g.roomId).toMatch(/^[0-9a-f]{32}$/);
    expect(g.participantId).toMatch(/^[0-9a-f]{32}$/);
    expect(g.canShare).toBe(false);
    expect(calls()[0]?.users.sort()).toEqual([alice.userId, bob.userId].sort());
    expect(states()).toEqual(["ringing"]);
  });

  it("never puts the room or participant ids in the event", async () => {
    const g = (await start()).body as { roomId: string; participantId: string };
    const text = JSON.stringify(calls().map((c) => c.event));
    expect(text).not.toContain(g.roomId);
    expect(text).not.toContain(g.participantId);
  });

  it("applies the caller's plan to screen share quality", async () => {
    const r = await start(alice, GROUP, "plus", true);
    const g = r.body as { canShare: boolean; quality: { height: number; fps: number } };
    expect(g.canShare).toBe(true);
    expect(g.quality).toMatchObject({ height: 1080, fps: 60 });
  });

  it("treats the caller asking again as a retry", async () => {
    const a = (await start()).body as { roomId: string; participantId: string };
    const b = (await start()).body as { roomId: string; participantId: string };
    expect(b.roomId).toBe(a.roomId);
    expect(b.participantId).toBe(a.participantId);
    expect(states()).toEqual(["ringing"]);
  });

  it("refuses a second call while one is live", async () => {
    await start();
    const r = await start(bob, GROUP2);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "call_in_progress" });
    expect((await start(alice, GROUP2)).status).toBe(409);
  });

  it("refuses outsiders and non-DMs", async () => {
    const eve = user();
    expect((await start(eve)).status).toBe(404);
    expect((await accept(eve)).status).toBe(404);
    const storage = createTestStorage();
    migrate(storage, CONVERSATION_MIGRATIONS);
    const other = new ConversationCore(storage, { now: () => now, notify: async () => {}, channelAccess: async () => null });
    await other.init({ id: GROUP, kind: "group", creator: alice });
    const r = await other.handle(alice, { type: "call.start", body: { groupConversationId: GROUP2 }, plan: "free" }, null);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "not_a_dm" });
  });

  it("refuses to reuse a group or the DM itself as the key group", async () => {
    await start();
    await op(alice, { type: "call.end" });
    now += 10_000;
    expect((await start(alice, GROUP)).body).toEqual({ error: "group_reused" });
    expect((await start(alice, DM)).status).toBe(400);
  });

  it("limits how fast someone can redial", async () => {
    await start();
    await op(bob, { type: "call.decline" });
    expect((await start(alice, GROUP2)).status).toBe(429);
    now += CALL_LIMITS.redialSeconds * 1000;
    expect((await start(alice, GROUP2)).status).toBe(200);
  });

  it("rejects bad input", async () => {
    const r = await op(alice, { type: "call.start", body: { groupConversationId: "nope" }, plan: "free" });
    expect(r.status).toBe(400);
    // A client cannot pick its own plan: it is an op field only the Worker sets.
    const r2 = await op(alice, { type: "call.start", body: { groupConversationId: GROUP }, plan: "gold" });
    expect(r2.status).toBe(400);
  });
});

describe("answering", () => {
  it("makes the call active and gives the callee their own participant id", async () => {
    const a = (await start()).body as { roomId: string; participantId: string };
    notified = [];
    const r = await accept();
    expect(r.status).toBe(200);
    const b = r.body as { roomId: string; participantId: string; call: { state: string } };
    expect(b.call.state).toBe("active");
    expect(b.roomId).toBe(a.roomId);
    expect(b.participantId).not.toBe(a.participantId);
    expect(states()).toEqual(["active"]);
  });

  it("only the callee can answer", async () => {
    await start();
    const r = await accept(alice);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "no_call" });
  });

  it("lets the same device ask again but not another of the callee's devices", async () => {
    await start();
    const first = (await accept()).body as { participantId: string };
    const again = (await accept()).body as { participantId: string };
    expect(again.participantId).toBe(first.participantId);
    const phone = { userId: bob.userId, deviceId: newId() };
    const r = await accept(phone);
    expect(r.status).toBe(409);
    expect(r.body).toEqual({ error: "call_not_ringing" });
  });

  it("cannot answer a ring that ran out", async () => {
    await start();
    now += CALL_LIMITS.ringSeconds * 1000;
    notified = [];
    const r = await accept();
    expect(r.status).toBe(409);
    expect(states()).toEqual(["ended"]);
    expect((calls()[0]!.event.d as { endReason: string }).endReason).toBe("missed");
  });

  it("applies the callee's own plan and screen share choice", async () => {
    await start(alice, GROUP, "plus", true);
    const g = (await accept(bob, "free", true)).body as { canShare: boolean; quality: { height: number } };
    expect(g.canShare).toBe(true);
    expect(g.quality.height).toBe(720);
  });
});

describe("ending", () => {
  it("decline ends it, tells both people and removes both from LiveKit", async () => {
    const g = (await start()).body as { roomId: string; participantId: string };
    notified = [];
    const r = await op(bob, { type: "call.decline" });
    expect(r.status).toBe(204);
    expect(states()).toEqual(["ended"]);
    expect((calls()[0]!.event.d as { endReason: string }).endReason).toBe("declined");
    expect(r.effects?.voice).toHaveLength(2);
    expect(r.effects?.voice?.every((e) => e.roomId === g.roomId)).toBe(true);
    expect(r.effects?.voice?.map((e) => e.participantId)).toContain(g.participantId);
  });

  it("only the callee can decline", async () => {
    await start();
    expect((await op(alice, { type: "call.decline" })).status).toBe(404);
  });

  it("the caller cancelling a ring is 'cancelled'; the callee ending one is 'declined'", async () => {
    await start();
    notified = [];
    await op(alice, { type: "call.end" });
    expect((calls()[0]!.event.d as { endReason: string }).endReason).toBe("cancelled");
    now += 10_000;
    await start(alice, GROUP2);
    notified = [];
    await op(bob, { type: "call.end" });
    expect((calls()[0]!.event.d as { endReason: string }).endReason).toBe("declined");
  });

  it("either person can hang up an answered call, and hanging up twice is fine", async () => {
    await start();
    await accept();
    notified = [];
    const r = await op(bob, { type: "call.end" });
    expect(r.status).toBe(204);
    expect((calls()[0]!.event.d as { endReason: string }).endReason).toBe("ended");
    expect(r.effects?.voice).toHaveLength(2);
    const again = await op(alice, { type: "call.end" });
    expect(again.status).toBe(204);
    expect(calls()).toHaveLength(1);
  });

  it("outsiders cannot end a call", async () => {
    await start();
    expect((await op(user(), { type: "call.end" })).status).toBe(404);
  });

  it("a lapsed lease ends an answered call the next time anyone looks", async () => {
    await start();
    await accept();
    now += CALL_LIMITS.leaseSeconds * 1000;
    notified = [];
    const r = await op(alice, { type: "call.get" });
    expect(r.body).toEqual({ call: null });
    expect((calls()[0]!.event.d as { endReason: string }).endReason).toBe("timeout");
    expect(r.effects?.voice).toHaveLength(2);
    // And the line is free again.
    expect((await start(bob, GROUP2)).status).toBe(200);
  });

  it("renewing keeps the call alive", async () => {
    await start();
    await accept();
    for (let i = 0; i < 4; i++) {
      now += 30_000;
      expect((await op(alice, { type: "call.renew" })).status).toBe(200);
    }
    expect((await op(bob, { type: "call.get" })).body).toMatchObject({ call: { state: "active" } });
    now += CALL_LIMITS.leaseSeconds * 1000;
    expect((await op(alice, { type: "call.renew" })).status).toBe(409);
  });
});

describe("reading", () => {
  it("shows the live call to both people and nothing else", async () => {
    expect((await op(alice, { type: "call.get" })).body).toEqual({ call: null });
    await start();
    for (const who of [alice, bob]) {
      expect((await op(who, { type: "call.get" })).body).toMatchObject({ call: { state: "ringing", callerId: alice.userId } });
    }
    expect((await op(user(), { type: "call.get" })).status).toBe(404);
  });
});
