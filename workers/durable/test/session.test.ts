import { CloseCode, GATEWAY_LIMITS, newId, type GatewayServerFrame } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ciphertext, World, type TestConn } from "./world.js";

let world: World;
let owner: string;
let alice: string;
let serverId: string;
let general: string;

beforeEach(async () => {
  world = new World();
  owner = newId();
  alice = newId();
  serverId = await world.createServer(owner);
  general = world.generalChannel(serverId, owner);
  await world.join(serverId, owner, alice);
});

function send(userId: string) {
  world.now += 1000;
  return world.op(serverId, userId, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } });
}

function lastSeq(ws: TestConn): number {
  const seqs = ws.dispatches().flatMap((d) => (d.s === undefined ? [] : [d.s]));
  const ready = ws.frames.find((f): f is Extract<GatewayServerFrame, { op: "ready" }> => f.op === "ready");
  return Math.max(ready?.d.seq ?? 0, ...seqs);
}

describe("identify", () => {
  it("sends READY with servers and a sequence to resume from, then numbered events", async () => {
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    const ready = ws.frames[0];
    expect(ready?.op).toBe("ready");
    if (ready?.op !== "ready") return;
    expect(ready.d.userId).toBe(alice);
    expect(ready.d.servers.map((s) => s.server.id)).toEqual([serverId]);
    expect(ready.d.servers[0]!.members.map((m) => m.userId).sort()).toEqual([owner, alice].sort());

    await send(owner);
    await send(owner);
    const seqs = ws.dispatches().map((d) => d.s);
    expect(seqs).toEqual([ready.d.seq + 1, ready.d.seq + 2]);
  });

  it("sends nothing to a socket before it identifies", async () => {
    const ws = world.connect(alice);
    await send(owner);
    expect(ws.frames).toEqual([]);
  });

  it("refuses a second identify on the same socket", async () => {
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    await world.frame(ws, { op: "identify" });
    expect(ws.frames.at(-1)).toEqual({ op: "error", code: "already_identified" });
  });

  it("drops servers the user was removed from while away", async () => {
    world.down.add(alice);
    await world.op(serverId, owner, { type: "member.remove", userId: alice });
    world.down.delete(alice);
    // SERVER_DELETE never arrived, but READY asks the server and learns the truth.
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    const ready = ws.frames[0];
    expect(ready?.op === "ready" && ready.d.servers).toEqual([]);
    expect(world.session(alice).core.serverIds()).toEqual([]);
  });

  it("delivers to every connected client of a user", async () => {
    const phone = world.connect(alice);
    const laptop = world.connect(alice);
    await world.frame(phone, { op: "identify" });
    await world.frame(laptop, { op: "identify" });
    await send(owner);
    expect(phone.types()).toEqual(["MESSAGE_CREATE"]);
    expect(laptop.types()).toEqual(["MESSAGE_CREATE"]);
  });
});

describe("resume", () => {
  it("replays missed events in order after a reconnect", async () => {
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    await send(owner);
    const seen = lastSeq(ws);
    await world.disconnect(ws);

    const missed = [(await send(owner)).body.id, (await send(owner)).body.id];
    await world.op(serverId, owner, { type: "channel.create", body: { name: "new" } });

    const again = world.connect(alice);
    await world.frame(again, { op: "resume", seq: seen });
    const events = again.dispatches();
    expect(events.map((e) => e.t)).toEqual(["MESSAGE_CREATE", "MESSAGE_CREATE", "CHANNEL_CREATE"]);
    expect(events.slice(0, 2).map((e) => e.d.id)).toEqual(missed);
    expect(events.map((e) => e.s)).toEqual([seen + 1, seen + 2, seen + 3]);
    expect(again.frames.at(-1)).toEqual({ op: "resumed", seq: seen + 3 });

    // And live events keep flowing after.
    await send(owner);
    expect(again.dispatches().at(-1)?.s).toBe(seen + 4);
  });

  it("resumes with nothing missed", async () => {
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    const seen = lastSeq(ws);
    await world.disconnect(ws);
    const again = world.connect(alice);
    await world.frame(again, { op: "resume", seq: seen });
    expect(again.frames).toEqual([{ op: "resumed", seq: seen }]);
  });

  it("refuses to resume past the 24 hour window", async () => {
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    const seen = lastSeq(ws);
    await world.disconnect(ws);
    await send(owner);
    world.now += GATEWAY_LIMITS.replayWindowMs + 1;
    await send(owner);

    const again = world.connect(alice);
    await world.frame(again, { op: "resume", seq: seen });
    expect(again.frames).toEqual([{ op: "invalid_session" }]);
    // The client starts over with identify.
    await world.frame(again, { op: "identify" });
    expect(again.frames.at(-1)?.op).toBe("ready");
  });

  it("refuses a sequence number from the future", async () => {
    const ws = world.connect(alice);
    await world.frame(ws, { op: "resume", seq: 9999 });
    expect(ws.frames).toEqual([{ op: "invalid_session" }]);
  });

  it("does not log typing, so it is not replayed", async () => {
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    const seen = lastSeq(ws);
    await world.disconnect(ws);
    await world.op(serverId, owner, { type: "typing", channelId: general }, null);
    const again = world.connect(alice);
    await world.frame(again, { op: "resume", seq: seen });
    expect(again.frames).toEqual([{ op: "resumed", seq: seen }]);
  });

  it("numbers a re-delivered event only once", async () => {
    const session = world.session(alice);
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    const ev = { id: newId(), t: "SERVER_UPDATE" as const, d: { id: serverId, name: "x", ownerId: owner } };
    session.core.receive([ev], [ws]);
    session.core.receive([ev], [ws]);
    expect(ws.dispatches()).toHaveLength(1);
  });
});

describe("presence", () => {
  it("goes online on the first client and offline when the last one leaves", async () => {
    const ownerWs = world.connect(owner);
    await world.frame(ownerWs, { op: "identify" });
    ownerWs.clear();

    const phone = world.connect(alice);
    const laptop = world.connect(alice);
    await world.frame(phone, { op: "identify" });
    await world.frame(laptop, { op: "identify" });
    expect(ownerWs.dispatches().map((d) => d.d)).toEqual([{ serverId, userId: alice, status: "online" }]);

    await world.disconnect(phone);
    expect(ownerWs.dispatches()).toHaveLength(1);
    await world.disconnect(laptop);
    expect(ownerWs.dispatches().at(-1)?.d).toEqual({ serverId, userId: alice, status: "offline" });
  });

  it("shows invisible users as offline", async () => {
    const ownerWs = world.connect(owner);
    await world.frame(ownerWs, { op: "identify" });
    const ws = world.connect(alice);
    await world.frame(ws, { op: "identify" });
    ownerWs.clear();

    await world.session(alice).core.setStatus(alice, "invisible", [ws]);
    expect(ownerWs.dispatches().map((d) => d.d.status)).toEqual(["offline"]);
    const snapshot = world.server(serverId).snapshot(owner)!;
    expect(snapshot.presences.map((p) => p.userId)).not.toContain(alice);
  });
});

describe("connection limits", () => {
  it("closes a socket that sends too fast", async () => {
    const ws = world.connect(alice);
    for (let i = 0; i < GATEWAY_LIMITS.frameBurst + 1; i++) await world.frame(ws, { op: "ping" });
    expect(ws.closed?.code).toBe(CloseCode.RATE_LIMITED);
  });

  it("allows a steady ping rate", async () => {
    const ws = world.connect(alice);
    for (let i = 0; i < 60; i++) {
      world.now += 1000;
      await world.frame(ws, { op: "ping" });
    }
    expect(ws.closed).toBeNull();
  });

  it("closes on oversized or malformed frames", async () => {
    const big = world.connect(alice);
    await world.frame(big, "x".repeat(GATEWAY_LIMITS.maxFrameBytes + 1));
    expect(big.closed?.code).toBe(CloseCode.FRAME_TOO_LARGE);

    const bad = world.connect(alice);
    await world.frame(bad, { op: "send_everything" });
    expect(bad.closed?.code).toBe(CloseCode.BAD_FRAME);
  });
});
