import { Permission as P, newId, serializePermissions } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ciphertext, World, type TestConn } from "./world.js";

let world: World;
let owner: string;
let alice: string;
let bob: string;
let serverId: string;
let general: string;
let aliceWs: TestConn;
let bobWs: TestConn;

const perms = (bits: bigint) => serializePermissions(bits);

beforeEach(async () => {
  world = new World();
  owner = newId();
  alice = newId();
  bob = newId();
  serverId = await world.createServer(owner);
  general = world.generalChannel(serverId, owner);
  await world.join(serverId, owner, alice);
  await world.join(serverId, owner, bob);
  aliceWs = world.connect(alice);
  bobWs = world.connect(bob);
  await world.frame(aliceWs, { op: "identify" });
  await world.frame(bobWs, { op: "identify" });
  await world.settle();
  aliceWs.clear();
  bobWs.clear();
});

async function createRole(actor: string, permissions: bigint, position?: number) {
  const reply = await world.op(serverId, actor, {
    type: "role.create",
    body: { name: "role", permissions: perms(permissions), ...(position === undefined ? {} : { position }) },
  });
  expect(reply.status).toBe(201);
  return reply.body.id as string;
}

async function grant(userId: string, roleId: string) {
  const reply = await world.op(serverId, owner, { type: "member.role.add", userId, roleId });
  expect(reply.status).toBe(200);
}

function send(userId: string, channelId = general) {
  return world.op(serverId, userId, { type: "message.create", channelId, body: { ciphertext: ciphertext(), epoch: 0 } });
}

describe("server creation", () => {
  it("gives the owner a general channel and puts the server in READY", async () => {
    const ws = world.connect(owner);
    await world.frame(ws, { op: "identify" });
    const ready = ws.frames.find((f) => f.op === "ready");
    expect(ready?.op === "ready" && ready.d.servers.map((s) => s.server.id)).toEqual([serverId]);
    expect(ready?.op === "ready" && ready.d.servers[0]!.channels.map((c) => c.name)).toEqual(["general"]);
  });

  it("returns the same server when creation is retried with the same key", async () => {
    const first = await world.session(owner).core.createServer(owner, "retry-key-1", "Again");
    const second = await world.session(owner).core.createServer(owner, "retry-key-1", "Again");
    expect((second.body as any).server.id).toBe((first.body as any).server.id);
  });
});

describe("messages", () => {
  it("fans a new message out to everyone who can see the channel", async () => {
    const reply = await send(alice);
    expect(reply.status).toBe(201);
    expect(bobWs.dispatches()).toEqual([expect.objectContaining({ t: "MESSAGE_CREATE", d: reply.body })]);
    expect(aliceWs.types()).toEqual(["MESSAGE_CREATE"]);
  });

  it("rejects ciphertext over the size limit", async () => {
    const reply = await world.op(serverId, alice, {
      type: "message.create",
      channelId: general,
      body: { ciphertext: ciphertext(13_000), epoch: 0 },
    });
    expect(reply.status).toBe(400);
  });

  it("lets only the author edit, and the author or MANAGE_MESSAGES delete", async () => {
    const { body: msg } = await send(alice);
    const edit = (userId: string) =>
      world.op(serverId, userId, { type: "message.update", channelId: general, messageId: msg.id, body: { ciphertext: ciphertext(4), epoch: 1 } });
    expect((await edit(bob)).status).toBe(403);
    expect((await edit(alice)).status).toBe(200);

    const del = (userId: string) => world.op(serverId, userId, { type: "message.delete", channelId: general, messageId: msg.id });
    expect((await del(bob)).status).toBe(403);
    await grant(bob, await createRole(owner, P.MANAGE_MESSAGES));
    expect((await del(bob)).status).toBe(204);
    expect(aliceWs.types()).toContain("MESSAGE_DELETE");
  });

  it("pages history newest first", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      world.now += 1000;
      ids.push((await send(alice)).body.id);
    }
    const page = await world.op(serverId, bob, { type: "messages.list", channelId: general, query: { limit: 2, before: ids[3] } }, null);
    expect(page.body.map((m: any) => m.id)).toEqual([ids[2], ids[1]]);
  });

  it("limits how fast one user can send", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await send(alice)).status);
    expect(statuses.filter((s) => s === 429)).toHaveLength(2);
    world.now += 5000;
    expect((await send(alice)).status).toBe(201);
  });

  it("sends typing only to others who can see the channel, without a sequence number", async () => {
    const reply = await world.op(serverId, alice, { type: "typing", channelId: general }, null);
    expect(reply.status).toBe(204);
    expect(bobWs.dispatches()).toEqual([{ t: "TYPING_START", d: expect.objectContaining({ userId: alice }) }]);
    expect(aliceWs.dispatches()).toEqual([]);
  });
});

describe("idempotency", () => {
  it("replays the first reply for a retried write and emits once", async () => {
    const op = { type: "message.create" as const, channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } };
    const first = await world.op(serverId, alice, op, "same-key-01");
    const retry = await world.op(serverId, alice, op, "same-key-01");
    expect(retry).toEqual(first);
    expect(bobWs.types()).toEqual(["MESSAGE_CREATE"]);
  });

  it("rejects a key reused for a different request", async () => {
    await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(1), epoch: 0 } }, "reused-key-1");
    const other = await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(2), epoch: 0 } }, "reused-key-1");
    expect(other.status).toBe(422);
  });

  it("scopes keys per user", async () => {
    const op = { type: "message.create" as const, channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } };
    const a = await world.op(serverId, alice, op, "shared-key-1");
    const b = await world.op(serverId, bob, op, "shared-key-1");
    expect(b.body.id).not.toBe(a.body.id);
  });

  it("requires a key for writes", async () => {
    const reply = await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } }, null);
    expect(reply).toMatchObject({ status: 400, body: { error: "idempotency_key_required" } });
  });

  it("forgets keys after a day", async () => {
    const op = { type: "message.create" as const, channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } };
    const first = await world.op(serverId, alice, op, "old-key-0001");
    world.now += 25 * 60 * 60 * 1000;
    const later = await world.op(serverId, alice, op, "old-key-0001");
    expect(later.body.id).not.toBe(first.body.id);
  });
});

describe("channel permissions", () => {
  it("blocks sending when @everyone is denied SEND_MESSAGES, and a role allow wins back", async () => {
    await world.op(serverId, owner, {
      type: "override.put",
      channelId: general,
      kind: "role",
      targetId: serverId,
      body: { allow: "0", deny: perms(P.SEND_MESSAGES) },
    });
    expect((await send(alice)).status).toBe(403);

    const speaker = await createRole(owner, 0n);
    await grant(alice, speaker);
    await world.op(serverId, owner, {
      type: "override.put",
      channelId: general,
      kind: "role",
      targetId: speaker,
      body: { allow: perms(P.SEND_MESSAGES), deny: "0" },
    });
    expect((await send(alice)).status).toBe(201);
    expect((await send(bob)).status).toBe(403);
  });

  it("hides a channel: CHANNEL_DELETE to those who lose it, no messages, and 404 on read", async () => {
    const secret = (await world.op(serverId, owner, { type: "channel.create", body: { name: "secret" } })).body.id as string;
    aliceWs.clear();
    bobWs.clear();

    await world.op(serverId, owner, {
      type: "override.put",
      channelId: secret,
      kind: "member",
      targetId: bob,
      body: { allow: "0", deny: perms(P.VIEW_CHANNEL) },
    });
    expect(bobWs.dispatches()).toEqual([{ t: "CHANNEL_DELETE", s: expect.any(Number), d: { id: secret, serverId } }]);
    expect(aliceWs.types()).toEqual(["CHANNEL_UPDATE"]);

    bobWs.clear();
    await send(alice, secret);
    expect(bobWs.dispatches()).toEqual([]);
    const read = await world.op(serverId, bob, { type: "messages.list", channelId: secret, query: { limit: 10 } }, null);
    expect(read).toMatchObject({ status: 404, body: { error: "unknown_channel" } });
    expect(world.server(serverId).snapshot(bob)!.channels.map((c) => c.id)).not.toContain(secret);

    await world.op(serverId, owner, { type: "override.delete", channelId: secret, kind: "member", targetId: bob });
    expect(bobWs.types()).toEqual(["CHANNEL_CREATE"]);
  });

  it("grants channels through a role and takes them away when the role is removed", async () => {
    const staff = await world.op(serverId, owner, { type: "channel.create", body: { name: "staff" } });
    await world.op(serverId, owner, {
      type: "override.put",
      channelId: staff.body.id,
      kind: "role",
      targetId: serverId,
      body: { allow: "0", deny: perms(P.VIEW_CHANNEL) },
    });
    const role = await createRole(owner, 0n);
    await world.op(serverId, owner, {
      type: "override.put",
      channelId: staff.body.id,
      kind: "role",
      targetId: role,
      body: { allow: perms(P.VIEW_CHANNEL), deny: "0" },
    });
    aliceWs.clear();

    await grant(alice, role);
    expect(aliceWs.types()).toEqual(["MEMBER_UPDATE", "CHANNEL_CREATE"]);
    aliceWs.clear();
    await world.op(serverId, owner, { type: "role.delete", roleId: role });
    expect(aliceWs.types()).toEqual(["ROLE_DELETE", "MEMBER_UPDATE", "CHANNEL_DELETE"]);
  });

  it("lets ADMINISTRATOR ignore channel denies", async () => {
    await world.op(serverId, owner, {
      type: "override.put",
      channelId: general,
      kind: "member",
      targetId: alice,
      body: { allow: "0", deny: perms(P.VIEW_CHANNEL | P.SEND_MESSAGES) },
    });
    expect((await send(alice)).status).toBe(404);
    await grant(alice, await createRole(owner, P.ADMINISTRATOR));
    expect((await send(alice)).status).toBe(201);
  });

  it("re-checks permissions at delivery time", async () => {
    world.down.add(bob);
    await send(alice);
    // Bob loses the channel while his copy is still waiting in the outbox.
    await world.op(serverId, owner, {
      type: "override.put",
      channelId: general,
      kind: "member",
      targetId: bob,
      body: { allow: "0", deny: perms(P.VIEW_CHANNEL) },
    });
    world.down.delete(bob);
    world.now += 60_000;
    await world.server(serverId).flush();
    expect(bobWs.types()).toEqual(["CHANNEL_DELETE"]);
  });

  it("retries delivery after a failure, in order", async () => {
    world.down.add(bob);
    const first = await send(alice);
    world.now += 1000;
    const second = await send(alice);
    expect(bobWs.dispatches()).toEqual([]);
    world.down.delete(bob);
    world.now += 60_000;
    await world.server(serverId).flush();
    expect(bobWs.dispatches().map((d) => d.d.id)).toEqual([first.body.id, second.body.id]);
  });
});

describe("roles and moderation", () => {
  it("needs MANAGE_ROLES to create roles", async () => {
    const reply = await world.op(serverId, alice, { type: "role.create", body: { name: "x" } });
    expect(reply).toMatchObject({ status: 403, body: { error: "missing_permissions" } });
  });

  it("stops a manager granting permissions they lack or placing roles above themselves", async () => {
    const manager = await createRole(owner, P.MANAGE_ROLES | P.KICK, 10);
    await grant(alice, manager);

    const tooStrong = await world.op(serverId, alice, { type: "role.create", body: { name: "x", permissions: perms(P.BAN) } });
    expect(tooStrong.status).toBe(403);
    const tooHigh = await world.op(serverId, alice, { type: "role.create", body: { name: "x", position: 10 } });
    expect(tooHigh).toMatchObject({ status: 403, body: { error: "role_hierarchy" } });
    const ok = await world.op(serverId, alice, { type: "role.create", body: { name: "x", permissions: perms(P.KICK) } });
    expect(ok.status).toBe(201);
    expect(ok.body.position).toBe(9);

    const own = await world.op(serverId, alice, { type: "role.update", roleId: manager, body: { permissions: perms(P.ADMINISTRATOR) } });
    expect(own).toMatchObject({ status: 403, body: { error: "role_hierarchy" } });
    const assignOwn = await world.op(serverId, alice, { type: "member.role.add", userId: bob, roleId: manager });
    expect(assignOwn.status).toBe(403);
  });

  it("keeps @everyone in place and undeletable", async () => {
    const moved = await world.op(serverId, owner, { type: "role.update", roleId: serverId, body: { position: 5 } });
    expect(moved.status).toBe(400);
    const deleted = await world.op(serverId, owner, { type: "role.delete", roleId: serverId });
    expect(deleted.status).toBe(400);
  });

  it("kicks only members ranked below, never the owner", async () => {
    const mod = await createRole(owner, P.KICK, 5);
    await grant(alice, mod);
    await grant(bob, mod);
    expect((await world.op(serverId, alice, { type: "member.remove", userId: bob })).status).toBe(403);
    expect((await world.op(serverId, alice, { type: "member.remove", userId: owner })).status).toBe(403);

    await world.op(serverId, owner, { type: "member.role.remove", userId: bob, roleId: mod });
    bobWs.clear();
    aliceWs.clear();
    expect((await world.op(serverId, alice, { type: "member.remove", userId: bob })).status).toBe(204);
    expect(bobWs.types()).toEqual(["SERVER_DELETE"]);
    expect(aliceWs.types()).toEqual(["MEMBER_REMOVE"]);
    expect((await send(bob)).status).toBe(404);
  });

  it("lets members leave but not the owner", async () => {
    expect((await world.op(serverId, alice, { type: "member.remove", userId: alice })).status).toBe(204);
    expect((await world.op(serverId, owner, { type: "member.remove", userId: owner })).status).toBe(400);
  });

  it("needs MANAGE_CHANNELS to create, edit and delete channels", async () => {
    expect((await world.op(serverId, alice, { type: "channel.create", body: { name: "x" } })).status).toBe(403);
    expect((await world.op(serverId, alice, { type: "channel.delete", channelId: general })).status).toBe(403);
    await grant(alice, await createRole(owner, P.MANAGE_CHANNELS));
    const created = await world.op(serverId, alice, { type: "channel.create", body: { name: "x" } });
    expect(created.status).toBe(201);
    expect(bobWs.types()).toContain("CHANNEL_CREATE");
    expect((await world.op(serverId, alice, { type: "channel.update", channelId: created.body.id, body: { name: "y" } })).body.name).toBe("y");
    expect((await world.op(serverId, alice, { type: "channel.delete", channelId: created.body.id })).status).toBe(204);
  });

  it("returns 404 to non-members", async () => {
    const stranger = newId();
    const reply = await world.op(serverId, stranger, { type: "messages.list", channelId: general, query: { limit: 10 } }, null);
    expect(reply).toMatchObject({ status: 404, body: { error: "unknown_server" } });
    expect(world.server(serverId).snapshot(stranger)).toBeNull();
  });
});
