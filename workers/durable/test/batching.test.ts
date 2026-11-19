import { newId } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { BATCH_WINDOW_MS } from "../src/server/core.js";
import { ciphertext, World, type TestConn } from "./world.js";

let world: World;
let owner: string;
let serverId: string;
let ownerWs: TestConn;

beforeEach(async () => {
  world = new World();
  owner = newId();
  serverId = await world.createServer(owner);
  ownerWs = world.connect(owner);
  await world.frame(ownerWs, { op: "identify" });
});

async function members(count: number): Promise<string[]> {
  const ids = Array.from({ length: count }, () => newId());
  for (const id of ids) await world.join(serverId, owner, id);
  await world.settle();
  ownerWs.clear();
  world.deliveries.clear();
  return ids;
}

describe("presence batching", () => {
  it("sends a burst of connects to each member in one delivery", async () => {
    const ids = await members(20);
    for (const id of ids) await world.frame(world.connect(id), { op: "identify" });
    expect(ownerWs.types()).toEqual([]);

    await world.settle();
    expect(ownerWs.types()).toEqual(Array(20).fill("PRESENCE_UPDATE"));
    expect(world.deliveries.get(owner)).toBe(1);
  });

  it("sends only the latest status for each user", async () => {
    const [alice] = await members(1);
    const ws = world.connect(alice!);
    await world.frame(ws, { op: "identify" });
    await world.session(alice!).core.setStatus(alice!, "dnd", [ws]);
    await world.session(alice!).core.setStatus(alice!, "idle", [ws]);
    await world.settle();
    expect(ownerWs.dispatches().map((d) => d.d.status)).toEqual(["idle"]);
  });

  it("schedules the next flush for the end of the window", async () => {
    const [alice] = await members(1);
    await world.frame(world.connect(alice!), { op: "identify" });
    expect(await world.server(serverId).flush()).toBe(world.now + BATCH_WINDOW_MS);
  });
});

describe("join batching", () => {
  it("tells existing members about a wave of joins in one delivery", async () => {
    await members(0);
    for (let i = 0; i < 10; i++) await world.join(serverId, owner, newId());
    expect(ownerWs.types()).toEqual([]);
    await world.settle();
    expect(ownerWs.types()).toEqual(Array(10).fill("MEMBER_ADD"));
    expect(world.deliveries.get(owner)).toBe(1);
  });

  it("never lets a held-back event arrive after a later one", async () => {
    await members(0);
    const alice = newId();
    await world.join(serverId, owner, alice);
    const general = world.generalChannel(serverId, owner);
    const sent = await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } });
    // The message is due now, so the earlier MEMBER_ADD goes with it, first.
    expect(ownerWs.dispatches().map((d) => [d.t, d.d.id ?? d.d.userId])).toEqual([
      ["MEMBER_ADD", alice],
      ["MESSAGE_CREATE", sent.body.id],
    ]);
  });
});
