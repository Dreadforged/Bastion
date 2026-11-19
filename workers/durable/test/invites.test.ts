import { Permission as P, newId, serializePermissions } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { newInviteCode } from "../src/server/core.js";
import { World } from "./world.js";

let world: World;
let owner: string;
let serverId: string;

beforeEach(async () => {
  world = new World();
  owner = newId();
  serverId = await world.createServer(owner);
});

async function invite(body: { maxAgeSeconds?: number; maxUses?: number } = {}, by = owner) {
  return world.op(serverId, by, { type: "invite.create", body });
}

const accept = (userId: string, code: string) => world.op(serverId, userId, { type: "invite.accept", code });

describe("invites", () => {
  it("makes 10 character base62 codes", () => {
    const codes = new Set(Array.from({ length: 200 }, newInviteCode));
    expect(codes.size).toBe(200);
    for (const code of codes) expect(code).toMatch(/^[A-Za-z0-9]{10}$/);
  });

  it("defaults to one day and unlimited uses, and tells the Worker to index the code", async () => {
    const reply = await invite();
    expect(reply.status).toBe(201);
    expect(reply.body).toMatchObject({ maxUses: 0, uses: 0, expiresAt: world.now + 86_400_000 });
    expect(reply.effects).toEqual({ inviteCreated: { code: reply.body.code, expiresAt: world.now + 86_400_000 } });
  });

  it("needs CREATE_INVITE", async () => {
    const alice = newId();
    await world.join(serverId, owner, alice);
    await world.op(serverId, owner, {
      type: "role.update",
      roleId: serverId,
      body: { permissions: serializePermissions(P.VIEW_CHANNEL | P.SEND_MESSAGES) },
    });
    expect((await invite({}, alice)).status).toBe(403);
  });

  it("previews without joining", async () => {
    const { body } = await invite();
    const preview = await world.op(serverId, newId(), { type: "invite.preview", code: body.code }, null);
    expect(preview).toMatchObject({ status: 200, body: { server: { id: serverId, name: "Test" }, memberCount: 1 } });
  });

  it("adds the member and tells everyone, including the joiner", async () => {
    const ownerWs = world.connect(owner);
    await world.frame(ownerWs, { op: "identify" });
    ownerWs.clear();
    const alice = newId();
    const aliceWs = world.connect(alice);
    await world.frame(aliceWs, { op: "identify" });

    const { body } = await invite();
    const reply = await accept(alice, body.code);
    expect(reply).toMatchObject({ status: 200, body: { serverId } });
    // The joiner gets the server at once; everyone else hears in the next batch.
    expect(aliceWs.types()).toEqual(["MEMBER_ADD", "SERVER_CREATE"]);
    expect(ownerWs.types()).toEqual([]);
    await world.settle();
    expect(ownerWs.types()).toEqual(["MEMBER_ADD"]);
    expect(world.session(alice).core.serverIds()).toEqual([serverId]);
  });

  it("stops working after max uses and reports the code gone", async () => {
    const { body } = await invite({ maxUses: 2 });
    expect((await accept(newId(), body.code)).status).toBe(200);
    const last = await accept(newId(), body.code);
    expect(last.status).toBe(200);
    expect(last.effects).toEqual({ inviteGone: body.code });
    expect(await accept(newId(), body.code)).toMatchObject({ status: 404, body: { error: "unknown_invite" } });
  });

  it("does not use up an invite for someone already in the server", async () => {
    const alice = newId();
    const { body } = await invite({ maxUses: 1 });
    await world.join(serverId, owner, alice);
    expect((await accept(alice, body.code)).status).toBe(200);
    expect((await accept(newId(), body.code)).status).toBe(200);
  });

  it("expires", async () => {
    const { body } = await invite({ maxAgeSeconds: 60 });
    world.now += 61_000;
    expect(await accept(newId(), body.code)).toMatchObject({ status: 404, body: { error: "unknown_invite" } });
  });

  it("can be made to never expire", async () => {
    const { body } = await invite({ maxAgeSeconds: 0 });
    expect(body.expiresAt).toBeNull();
    world.now += 365 * 24 * 60 * 60 * 1000;
    expect((await accept(newId(), body.code)).status).toBe(200);
  });

  it("rejects ages and use counts past the limits", async () => {
    expect((await invite({ maxAgeSeconds: 31 * 24 * 60 * 60 })).status).toBe(400);
    expect((await invite({ maxUses: 1001 })).status).toBe(400);
  });

  it("keeps banned users out until unbanned", async () => {
    const mallory = newId();
    await world.join(serverId, owner, mallory);
    expect((await world.op(serverId, owner, { type: "ban.put", userId: mallory })).status).toBe(204);
    const { body } = await invite();
    expect(await accept(mallory, body.code)).toMatchObject({ status: 403, body: { error: "banned" } });
    await world.op(serverId, owner, { type: "ban.delete", userId: mallory });
    expect((await accept(mallory, body.code)).status).toBe(200);
  });

  it("can be revoked by its creator or MANAGE_CHANNELS, not by other members or outsiders", async () => {
    const alice = newId();
    const bob = newId();
    await world.join(serverId, owner, alice);
    await world.join(serverId, owner, bob);
    const { body } = await invite({}, alice);

    expect((await world.op(serverId, newId(), { type: "invite.delete", code: body.code })).status).toBe(404);
    expect((await world.op(serverId, bob, { type: "invite.delete", code: body.code })).status).toBe(403);
    const revoked = await world.op(serverId, alice, { type: "invite.delete", code: body.code });
    expect(revoked).toMatchObject({ status: 204, effects: { inviteGone: body.code } });
    expect((await accept(newId(), body.code)).status).toBe(404);
  });
});
