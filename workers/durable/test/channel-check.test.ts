import { Permission as P, newId, serializePermissions } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { World } from "./world.js";

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

const check = (user: string, need: "view" | "attach_files", channelId = general) =>
  world.op(serverId, user, { type: "channel.check", channelId, need }, null);

async function deny(userId: string, bits: bigint) {
  const reply = await world.op(serverId, owner, {
    type: "override.put",
    channelId: general,
    kind: "member",
    targetId: userId,
    body: { allow: "0", deny: serializePermissions(bits) },
  });
  expect(reply.status).toBe(200);
}

describe("channel.check", () => {
  it("answers 204 for members who may view and attach, without needing an idempotency key", async () => {
    expect((await check(alice, "view")).status).toBe(204);
    expect((await check(alice, "attach_files")).status).toBe(204);
  });

  it("answers 403 when attaching is denied but viewing is not", async () => {
    await deny(alice, P.ATTACH_FILES);
    expect((await check(alice, "attach_files")).body).toEqual({ error: "missing_permissions" });
    expect((await check(alice, "view")).status).toBe(204);
  });

  it("hides channels the member cannot view", async () => {
    await deny(alice, P.VIEW_CHANNEL);
    expect((await check(alice, "view")).status).toBe(404);
    expect((await check(alice, "attach_files")).status).toBe(404);
  });

  it("lets a timed-out member view but not attach", async () => {
    await world.op(serverId, owner, { type: "member.timeout", userId: alice, body: { seconds: 60 } });
    expect((await check(alice, "view")).status).toBe(204);
    expect((await check(alice, "attach_files")).status).toBe(403);
  });

  it("answers 404 for strangers and unknown channels, and makes no change", async () => {
    expect((await check(newId(), "view")).status).toBe(404);
    expect((await check(alice, "view", newId())).status).toBe(404);
    expect((await world.op(serverId, owner, { type: "audit.list", query: { limit: 10 } })).body).toEqual([]);
  });
});
