import { Permission as P, newId, schemas, serializePermissions } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { World, type TestConn } from "./world.js";

const HEX32 = /^[0-9a-f]{32}$/;

let world: World;
let owner: string;
let mod: string;
let alice: string;
let bob: string;
let serverId: string;
let general: string;
let lounge: string;
let modWs: TestConn;
let aliceWs: TestConn;
let bobWs: TestConn;

beforeEach(async () => {
  world = new World();
  owner = newId();
  mod = newId();
  alice = newId();
  bob = newId();
  serverId = await world.createServer(owner);
  general = world.generalChannel(serverId, owner);
  lounge = await createChannel("lounge", "voice");
  for (const user of [mod, alice, bob]) await world.join(serverId, owner, user);
  const modRole = await createRole(P.MUTE_MEMBERS | P.TIMEOUT | P.KICK, 5);
  await grant(mod, modRole);
  modWs = await connect(mod);
  aliceWs = await connect(alice);
  bobWs = await connect(bob);
  await world.settle();
  for (const ws of [modWs, aliceWs, bobWs]) ws.clear();
});

async function connect(userId: string): Promise<TestConn> {
  const ws = world.connect(userId);
  await world.frame(ws, { op: "identify" });
  ws.clear();
  return ws;
}

async function createChannel(name: string, kind: "text" | "voice"): Promise<string> {
  const reply = await world.op(serverId, owner, { type: "channel.create", body: { name, kind, slowModeSeconds: 0 } });
  expect(reply.status).toBe(201);
  return reply.body.id;
}

async function createRole(permissions: bigint, position: number): Promise<string> {
  const reply = await world.op(serverId, owner, {
    type: "role.create",
    body: { name: "role", permissions: serializePermissions(permissions), position },
  });
  expect(reply.status).toBe(201);
  return reply.body.id;
}

async function grant(userId: string, roleId: string): Promise<void> {
  expect((await world.op(serverId, owner, { type: "member.role.add", userId, roleId })).status).toBe(200);
}

function join(userId: string, opts: { channelId?: string; screenShare?: boolean; plan?: "free" | "plus" } = {}, key?: string) {
  return world.op(
    serverId,
    userId,
    { type: "voice.join", channelId: opts.channelId ?? lounge, screenShare: opts.screenShare ?? false, plan: opts.plan ?? "free" },
    key,
  );
}

function update(userId: string, body: Record<string, boolean>) {
  return world.op(serverId, userId, { type: "voice.update", body });
}

function leave(userId: string) {
  return world.op(serverId, userId, { type: "voice.leave" });
}

async function list(userId: string): Promise<schemas.VoiceState[]> {
  const reply = await world.op(serverId, userId, { type: "voice.list" });
  expect(reply.status).toBe(200);
  return reply.body;
}

function voiceEvents(ws: TestConn) {
  return ws.dispatches().filter((d) => d.t === "VOICE_STATE_UPDATE");
}

async function denyOverride(channelId: string, userId: string, deny: bigint) {
  const reply = await world.op(serverId, owner, {
    type: "override.put",
    channelId,
    kind: "member",
    targetId: userId,
    body: { allow: "0", deny: serializePermissions(deny) },
  });
  expect(reply.status).toBe(200);
}

async function auditActions(): Promise<string[]> {
  const reply = await world.op(serverId, owner, { type: "audit.list", query: { limit: 100 } });
  return reply.body.map((e: schemas.AuditLogEntry) => e.action);
}

/** Add n members and put each in the lounge. Returns their ids. */
async function crowd(n: number, plan: "free" | "plus" = "free"): Promise<string[]> {
  const users: string[] = [];
  for (let i = 0; i < n; i++) {
    const user = newId();
    world.now += 2000; // stay under the owner write limit
    await world.join(serverId, owner, user);
    expect((await join(user, { plan })).status).toBe(200);
    users.push(user);
    // Calls run longer than a lease, so everyone keeps renewing like a real client.
    if (i % 10 === 9) for (const state of await list(owner)) await update(state.userId, {});
  }
  return users;
}

// ------------------------------------------------------------------ joining

describe("voice.join", () => {
  it("returns random room and participant ids, not channel or user ids", async () => {
    const a = await join(alice);
    const b = await join(bob);
    expect(a.status).toBe(200);
    expect(a.body.roomId).toMatch(HEX32);
    expect(a.body.participantId).toMatch(HEX32);
    expect(a.body.roomId).not.toContain(lounge.toLowerCase());
    expect(a.body.participantId).not.toBe(b.body.participantId);
    // Everyone in a channel shares one room.
    expect(b.body.roomId).toBe(a.body.roomId);
  });

  it("gives every channel its own room", async () => {
    const other = await createChannel("games", "voice");
    const a = await join(alice);
    const b = await join(bob, { channelId: other });
    expect(b.body.roomId).not.toBe(a.body.roomId);
  });

  it("rejects text channels and unknown channels", async () => {
    expect((await join(alice, { channelId: general })).body).toEqual({ error: "not_voice_channel" });
    expect((await join(alice, { channelId: newId() })).status).toBe(404);
  });

  it("needs CONNECT_VOICE in that channel", async () => {
    await denyOverride(lounge, alice, P.CONNECT_VOICE);
    expect((await join(alice)).body).toEqual({ error: "missing_permissions" });
    expect((await join(bob)).status).toBe(200);
  });

  it("hides channels the member cannot see", async () => {
    await denyOverride(lounge, alice, P.VIEW_CHANNEL);
    expect((await join(alice)).status).toBe(404);
  });

  it("only works for members", async () => {
    expect((await join(newId())).status).toBe(404);
  });

  it("grants publishing only with SPEAK", async () => {
    expect((await join(alice)).body.canPublish).toBe(true);
    await denyOverride(lounge, bob, P.SPEAK);
    const b = await join(bob);
    expect(b.status).toBe(200);
    expect(b.body.canPublish).toBe(false);
  });

  it("keeps the participant id when refreshing a token, and issues a new one after leaving", async () => {
    const first = await join(alice);
    const again = await join(alice);
    expect(again.body.participantId).toBe(first.body.participantId);
    await leave(alice);
    const rejoined = await join(alice);
    expect(rejoined.body.participantId).not.toBe(first.body.participantId);
  });

  it("answers a retried request with the same reply", async () => {
    const key = world.key();
    const first = await join(alice, {}, key);
    const retry = await join(alice, {}, key);
    expect(retry).toEqual(first);
    expect(voiceEvents(bobWs)).toHaveLength(1);
  });

  it("is rate limited", async () => {
    for (let i = 0; i < 10; i++) expect((await join(alice)).status).toBe(200);
    expect((await join(alice)).status).toBe(429);
  });

  it("includes the quality tier for the plan", async () => {
    expect((await join(alice, { plan: "free" })).body.quality).toMatchObject({ height: 720, fps: 30, maxViewers: 25 });
    expect((await join(bob, { plan: "plus" })).body.quality).toMatchObject({ height: 1080, fps: 60, maxViewers: 50 });
  });
});

// ------------------------------------------------------------------ events and state

describe("voice state events", () => {
  it("tell channel viewers who joined and left, without keeping them for resume", async () => {
    const a = await join(alice);
    const expected = {
      serverId,
      userId: alice,
      channelId: lounge,
      participantId: a.body.participantId,
      selfMute: false,
      selfDeaf: false,
      streaming: false,
    };
    expect(voiceEvents(bobWs)).toEqual([{ t: "VOICE_STATE_UPDATE", d: expected }]);
    // Ephemeral events carry no sequence number.
    expect(voiceEvents(bobWs)[0]).not.toHaveProperty("s");

    bobWs.clear();
    await leave(alice);
    expect(voiceEvents(bobWs)[0]!.d).toEqual({
      serverId,
      userId: alice,
      channelId: null,
      participantId: null,
      selfMute: false,
      selfDeaf: false,
      streaming: false,
    });
  });

  it("do not go to members who cannot see the channel", async () => {
    await denyOverride(lounge, bob, P.VIEW_CHANNEL);
    bobWs.clear();
    await join(alice);
    expect(voiceEvents(bobWs)).toEqual([]);
    expect(voiceEvents(modWs)).toHaveLength(1);
  });

  it("report mute and deafen changes, and stay quiet when nothing changed", async () => {
    await join(alice);
    bobWs.clear();
    expect((await update(alice, { selfMute: true })).status).toBe(200);
    expect(voiceEvents(bobWs)[0]!.d).toMatchObject({ userId: alice, selfMute: true, selfDeaf: false });
    bobWs.clear();
    await update(alice, { selfMute: true });
    await update(alice, {});
    expect(voiceEvents(bobWs)).toEqual([]);
    await update(alice, { selfDeaf: true });
    expect(voiceEvents(bobWs)[0]!.d).toMatchObject({ selfMute: true, selfDeaf: true });
  });

  it("renew the lease without an idempotency key, which heartbeats do not carry", async () => {
    await join(alice);
    expect((await world.op(serverId, alice, { type: "voice.update", body: {} }, null)).status).toBe(200);
    expect((await world.op(serverId, alice, { type: "voice.list" }, null)).status).toBe(200);
    // Joining is a write and still needs one.
    expect((await world.op(serverId, alice, { type: "voice.join", channelId: lounge, screenShare: false, plan: "free" }, null)).status).toBe(400);
  });

  it("need the member to be in a call to update", async () => {
    expect((await update(alice, { selfMute: true })).body).toEqual({ error: "not_in_voice" });
  });

  it("move someone between channels, telling the old channel they left", async () => {
    const other = await createChannel("games", "voice");
    await denyOverride(other, bob, P.VIEW_CHANNEL);
    await join(alice);
    bobWs.clear();
    modWs.clear();
    const moved = await join(alice, { channelId: other });
    expect(moved.status).toBe(200);
    // Bob could see the old channel only, so he is told Alice left it.
    expect(voiceEvents(bobWs).map((e) => e.d.channelId)).toEqual([null]);
    // The mod sees both, so one event says she is now in the new one.
    expect(voiceEvents(modWs).map((e) => e.d.channelId)).toEqual([other]);
    expect(await list(owner)).toHaveLength(1);
  });

  it("are listed for current members only, and only for channels the viewer can see", async () => {
    await join(alice);
    await join(bob);
    expect((await list(mod)).map((s) => s.userId).sort()).toEqual([alice, bob].sort());
    await denyOverride(lounge, mod, P.VIEW_CHANNEL);
    expect(await list(mod)).toEqual([]);
    await leave(alice);
    expect((await list(owner)).map((s) => s.userId)).toEqual([bob]);
  });

  it("appear in the snapshot a new client gets", async () => {
    const a = await join(alice);
    const snapshot = world.server(serverId).snapshot(bob)!;
    expect(snapshot.voiceStates).toEqual([
      { serverId, userId: alice, channelId: lounge, participantId: a.body.participantId, selfMute: false, selfDeaf: false, streaming: false },
    ]);
  });

  it("leave nothing behind: no history after the call", async () => {
    await join(alice);
    await join(bob);
    await leave(alice);
    await leave(bob);
    expect(await list(owner)).toEqual([]);
    const sql = (world.server(serverId) as unknown as { sql: { exec: (q: string) => { toArray(): unknown[] } } }).sql;
    expect(sql.exec("SELECT * FROM voice_states").toArray()).toEqual([]);
    expect(sql.exec("SELECT * FROM voice_rooms").toArray()).toEqual([]);
  });

  it("drop people whose client stopped renewing, and keep those who renew", async () => {
    await join(alice);
    await join(bob);
    world.now += 60_000;
    await update(bob, {});
    bobWs.clear();
    world.now += 40_000; // 100s since Alice's last sign of life, 40s since Bob's
    await world.server(serverId).flush();
    expect((await list(owner)).map((s) => s.userId)).toEqual([bob]);
    expect(voiceEvents(modWs).at(-1)!.d).toMatchObject({ userId: alice, channelId: null });
  });
});

// ------------------------------------------------------------------ screen share

describe("screen share", () => {
  let streamRole: string;
  beforeEach(async () => {
    streamRole = await createRole(P.STREAM, 2);
  });

  it("is not part of the default permissions", async () => {
    expect((await join(alice, { screenShare: true })).body).toEqual({ error: "missing_permissions" });
    const plain = await join(alice);
    expect(plain.body.canShare).toBe(false);
  });

  it("is granted in the token only when asked for and allowed", async () => {
    await grant(alice, streamRole);
    expect((await join(alice)).body.canShare).toBe(false);
    expect((await join(alice, { screenShare: true })).body.canShare).toBe(true);
  });

  it("needs STREAM in that channel, not just on the server", async () => {
    await grant(alice, streamRole);
    await denyOverride(lounge, alice, P.STREAM);
    expect((await join(alice, { screenShare: true })).body).toEqual({ error: "missing_permissions" });
  });

  it("goes live and off through the state update, with an event", async () => {
    await grant(alice, streamRole);
    await join(alice, { screenShare: true });
    bobWs.clear();
    expect((await update(alice, { streaming: true })).body.streaming).toBe(true);
    expect(voiceEvents(bobWs)[0]!.d).toMatchObject({ userId: alice, streaming: true });
    await update(alice, { streaming: false });
    expect(voiceEvents(bobWs).at(-1)!.d).toMatchObject({ streaming: false });
  });

  it("cannot be started without STREAM", async () => {
    await join(alice);
    expect((await update(alice, { streaming: true })).body).toEqual({ error: "missing_permissions" });
  });

  it("stops when STREAM is taken away, and tells LiveKit", async () => {
    await grant(alice, streamRole);
    const a = await join(alice, { screenShare: true });
    await update(alice, { streaming: true });
    bobWs.clear();
    const removed = await world.op(serverId, owner, { type: "role.update", roleId: streamRole, body: { permissions: "0" } });
    expect(removed.status).toBe(200);
    expect(removed.effects.voice).toEqual([
      { kind: "restrict", roomId: a.body.roomId, participantId: a.body.participantId, canPublish: true, canShare: false },
    ]);
    expect(voiceEvents(bobWs)[0]!.d).toMatchObject({ userId: alice, streaming: false });
    expect((await list(owner))[0]).toMatchObject({ streaming: false });
  });

  it("cuts publishing when SPEAK is taken away but keeps the person in the call", async () => {
    const a = await join(alice);
    const reply = await world.op(serverId, owner, {
      type: "override.put",
      channelId: lounge,
      kind: "member",
      targetId: alice,
      body: { allow: "0", deny: serializePermissions(P.SPEAK) },
    });
    expect(reply.effects.voice).toEqual([
      { kind: "restrict", roomId: a.body.roomId, participantId: a.body.participantId, canPublish: false, canShare: false },
    ]);
    expect(await list(owner)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ room size

describe("room size", () => {
  it("holds at most the room limit, streaming or not", async () => {
    const limit = schemas.VOICE_LIMITS.maxRoomParticipants;
    const people = await crowd(limit - 1);
    world.now += 3000;
    expect((await join(mod)).status).toBe(200);
    world.now += 3000;
    expect((await join(bob)).body).toEqual({ error: "room_full" });
    expect(await list(owner)).toHaveLength(limit);

    // Someone already in the room can still refresh their token.
    world.now += 3000;
    expect((await join(people[0]!)).status).toBe(200);

    // A free seat is usable straight away, and other rooms are unaffected.
    expect((await leave(people[1]!)).status).toBe(204);
    world.now += 3000;
    expect((await join(bob)).status).toBe(200);
    const other = await createChannel("second", "voice");
    world.now += 3000;
    expect((await join(alice, { channelId: other })).status).toBe(200);
  });

  it("matches LiveKit's backstop of 100", () => {
    expect(schemas.VOICE_LIMITS.maxRoomParticipants).toBeLessThan(100);
  });
});

// ------------------------------------------------------------------ quality and viewer limits

describe("viewer limits", () => {
  let streamRole: string;
  beforeEach(async () => {
    streamRole = await createRole(P.STREAM, 2);
    await grant(alice, streamRole);
    await grant(bob, streamRole);
  });

  async function startStream(userId: string, plan: "free" | "plus") {
    const joined = await join(userId, { screenShare: true, plan });
    expect(joined.status).toBe(200);
    return update(userId, { streaming: true });
  }

  it("lets a free stream have 25 viewers and no more", async () => {
    expect((await startStream(alice, "free")).status).toBe(200);
    await crowd(25);
    world.now += 3000;
    expect((await join(mod)).body).toEqual({ error: "stream_full" });
    expect((await list(owner)).filter((s) => !s.streaming)).toHaveLength(25);
  });

  it("lets a Plus stream have 50 viewers and no more", async () => {
    expect((await startStream(alice, "plus")).status).toBe(200);
    await crowd(50, "plus");
    world.now += 3000;
    expect((await join(mod)).body).toEqual({ error: "stream_full" });
  });

  it("does not limit calls with no stream", async () => {
    await crowd(30);
    world.now += 3000;
    expect((await join(mod)).status).toBe(200);
  });

  it("refuses to start a stream the room already exceeds", async () => {
    await crowd(30);
    world.now += 3000;
    expect((await startStream(alice, "free")).body).toEqual({ error: "too_many_viewers" });
    world.now += 3000;
    expect((await startStream(bob, "plus")).status).toBe(200);
  });

  it("applies the lowest cap when a free and a Plus stream share a room", async () => {
    expect((await startStream(bob, "plus")).status).toBe(200);
    expect((await startStream(alice, "free")).status).toBe(200);
    await crowd(25);
    world.now += 3000;
    expect((await join(mod)).body).toEqual({ error: "stream_full" });
  });

  it("does not turn away someone who is already in the room when they refresh", async () => {
    expect((await startStream(alice, "free")).status).toBe(200);
    await crowd(25);
    const [first] = (await list(owner)).filter((s) => s.userId !== alice);
    world.now += 3000;
    expect((await join(first!.userId)).status).toBe(200);
  });
});

describe("streams per room", () => {
  it("allows four live streams in a room and refuses a fifth until one stops", async () => {
    const role = await createRole(P.STREAM, 2);
    const streamers: string[] = [];
    for (let i = 0; i < 5; i++) {
      const user = newId();
      world.now += 2000;
      await world.join(serverId, owner, user);
      await grant(user, role);
      expect((await join(user, { screenShare: true })).status).toBe(200);
      streamers.push(user);
    }
    for (const user of streamers.slice(0, 4)) {
      world.now += 2000;
      expect((await update(user, { streaming: true })).status).toBe(200);
    }
    world.now += 2000;
    expect((await update(streamers[4]!, { streaming: true })).body).toEqual({ error: "too_many_streams" });
    expect((await list(owner)).filter((s) => s.streaming)).toHaveLength(schemas.VOICE_LIMITS.maxStreamsPerRoom);

    // Already streaming people can keep renewing, and a stopped stream frees the slot.
    world.now += 2000;
    expect((await update(streamers[0]!, { streaming: true })).status).toBe(200);
    expect((await update(streamers[0]!, { streaming: false })).status).toBe(200);
    world.now += 2000;
    expect((await update(streamers[4]!, { streaming: true })).status).toBe(200);
  });

  it("counts each room on its own", async () => {
    const role = await createRole(P.STREAM, 2);
    const other = await createChannel("second", "voice");
    for (const [i, channelId] of [lounge, lounge, lounge, lounge, other].entries()) {
      const user = newId();
      world.now += 2000;
      await world.join(serverId, owner, user);
      await grant(user, role);
      expect((await join(user, { channelId, screenShare: true })).status).toBe(200);
      expect((await update(user, { streaming: true })).status).toBe(200);
      void i;
    }
  });
});

// ------------------------------------------------------------------ timeouts and lost permissions

describe("timeouts and lost access", () => {
  it("a timed-out member cannot get a voice token until it ends", async () => {
    expect((await world.op(serverId, mod, { type: "member.timeout", userId: alice, body: { seconds: 60 } })).status).toBe(200);
    expect((await join(alice)).body).toEqual({ error: "missing_permissions" });
    world.now += 61_000;
    expect((await join(alice)).status).toBe(200);
  });

  it("a timeout removes someone already in a call and has LiveKit drop them", async () => {
    const a = await join(alice);
    bobWs.clear();
    const timeout = await world.op(serverId, mod, { type: "member.timeout", userId: alice, body: { seconds: 60 } });
    expect(timeout.status).toBe(200);
    expect(timeout.effects.voice).toEqual([{ kind: "remove", roomId: a.body.roomId, participantId: a.body.participantId }]);
    expect(voiceEvents(bobWs).map((e) => e.d)).toEqual([expect.objectContaining({ userId: alice, channelId: null })]);
    expect(await list(owner)).toEqual([]);
  });

  it("a timed-out member cannot update their way back in", async () => {
    await world.op(serverId, mod, { type: "member.timeout", userId: alice, body: { seconds: 60 } });
    expect((await update(alice, { selfMute: false })).body).toEqual({ error: "not_in_voice" });
  });

  it("a kick removes someone from the call", async () => {
    const a = await join(alice);
    const kick = await world.op(serverId, mod, { type: "member.remove", userId: alice, body: {} });
    expect(kick.effects.voice).toEqual([{ kind: "remove", roomId: a.body.roomId, participantId: a.body.participantId }]);
    expect(await list(owner)).toEqual([]);
  });

  it("leaving the server removes someone from the call", async () => {
    await join(alice);
    const left = await world.op(serverId, alice, { type: "member.remove", userId: alice, body: {} });
    expect(left.effects.voice).toHaveLength(1);
    expect(await list(owner)).toEqual([]);
  });

  it("losing CONNECT_VOICE or VIEW_CHANNEL removes someone", async () => {
    await join(alice);
    await join(bob);
    const a = await denyOverride(lounge, alice, P.CONNECT_VOICE);
    void a;
    await denyOverride(lounge, bob, P.VIEW_CHANNEL);
    expect(await list(owner)).toEqual([]);
  });

  it("deleting the channel tells LiveKit to drop everyone in it", async () => {
    const a = await join(alice);
    const b = await join(bob);
    const deleted = await world.op(serverId, owner, { type: "channel.delete", channelId: lounge });
    expect(deleted.status).toBe(204);
    expect(deleted.effects.voice).toEqual(
      expect.arrayContaining([
        { kind: "remove", roomId: a.body.roomId, participantId: a.body.participantId },
        { kind: "remove", roomId: b.body.roomId, participantId: b.body.participantId },
      ]),
    );
  });

  it("deleting the server tells LiveKit to drop everyone", async () => {
    await join(alice);
    const deleted = await world.op(serverId, owner, { type: "server.delete" });
    expect(deleted.effects.voice).toHaveLength(1);
  });

  it("unrelated changes leave people alone and add no effects", async () => {
    await join(alice);
    const reply = await world.op(serverId, owner, { type: "channel.update", channelId: general, body: { name: "chat" } });
    expect(reply.effects).toBeUndefined();
    expect(await list(owner)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ moderation

describe("moderating voice", () => {
  let streamRole: string;
  beforeEach(async () => {
    streamRole = await createRole(P.STREAM, 2);
    await grant(alice, streamRole);
  });

  async function startStream(userId = alice) {
    await join(userId, { screenShare: true });
    expect((await update(userId, { streaming: true })).status).toBe(200);
  }

  it("lets a moderator end someone's stream, keeping them in the call", async () => {
    await startStream();
    const state = (await list(owner))[0]!;
    bobWs.clear();
    const ended = await world.op(serverId, mod, { type: "voice.end_stream", userId: alice, body: { reason: "too loud" } });
    expect(ended.status).toBe(200);
    expect(ended.body.streaming).toBe(false);
    expect(ended.effects.voice).toEqual([
      { kind: "restrict", roomId: expect.stringMatching(HEX32), participantId: state.participantId, canPublish: true, canShare: false },
    ]);
    expect(voiceEvents(bobWs)[0]!.d).toMatchObject({ userId: alice, channelId: lounge, streaming: false });
    expect(await auditActions()).toContain("voice.end_stream");
  });

  it("keeps an ended stream ended until the person leaves and joins again", async () => {
    await startStream();
    await world.op(serverId, mod, { type: "voice.end_stream", userId: alice, body: {} });
    expect((await update(alice, { streaming: true })).body).toEqual({ error: "stream_blocked" });
    expect((await join(alice, { screenShare: true })).body).toEqual({ error: "stream_blocked" });
    // A fresh token without screen share still works.
    expect((await join(alice)).body.canShare).toBe(false);
    await leave(alice);
    expect((await join(alice, { screenShare: true })).body.canShare).toBe(true);
  });

  it("lets a moderator remove someone from a call and has LiveKit drop them", async () => {
    const a = await join(alice);
    bobWs.clear();
    const removed = await world.op(serverId, mod, { type: "voice.disconnect", userId: alice, body: { reason: "spam" } });
    expect(removed.status).toBe(204);
    expect(removed.effects.voice).toEqual([{ kind: "remove", roomId: a.body.roomId, participantId: a.body.participantId }]);
    expect(voiceEvents(bobWs)[0]!.d).toMatchObject({ userId: alice, channelId: null });
    expect(await list(owner)).toEqual([]);
    expect(await auditActions()).toContain("voice.disconnect");
    const log = await world.op(serverId, owner, { type: "audit.list", query: { limit: 10, action: "voice.disconnect" } });
    expect(log.body[0]).toMatchObject({ actorId: mod, targetId: alice, channelId: lounge, reason: "spam" });
  });

  it("works on anyone in a call, in a channel the moderator is not in", async () => {
    await join(bob);
    expect((await world.op(serverId, mod, { type: "voice.disconnect", userId: bob, body: {} })).status).toBe(204);
  });

  it("needs MUTE_MEMBERS", async () => {
    await join(bob);
    for (const type of ["voice.end_stream", "voice.disconnect"] as const) {
      expect((await world.op(serverId, alice, { type, userId: bob, body: {} })).body).toEqual({ error: "missing_permissions" });
    }
  });

  it("respects the role hierarchy and the owner", async () => {
    const higher = await createRole(P.MUTE_MEMBERS, 9);
    await grant(alice, higher);
    await join(mod);
    await join(owner);
    expect((await world.op(serverId, mod, { type: "voice.disconnect", userId: alice, body: {} })).status).toBe(403);
    expect((await world.op(serverId, alice, { type: "voice.disconnect", userId: owner, body: {} })).status).toBe(403);
    expect((await world.op(serverId, alice, { type: "voice.disconnect", userId: mod, body: {} })).status).toBe(204);
  });

  it("cannot be used on someone who is not in a call, or on yourself", async () => {
    expect((await world.op(serverId, mod, { type: "voice.disconnect", userId: bob, body: {} })).body).toEqual({ error: "not_in_voice" });
    expect((await world.op(serverId, mod, { type: "voice.end_stream", userId: mod, body: {} })).body).toEqual({ error: "cannot_moderate_self" });
  });

  it("is blocked for a moderator in a timeout", async () => {
    await join(bob);
    await world.op(serverId, owner, { type: "member.timeout", userId: mod, body: { seconds: 60 } });
    expect((await world.op(serverId, mod, { type: "voice.disconnect", userId: bob, body: {} })).status).toBe(403);
  });
});
