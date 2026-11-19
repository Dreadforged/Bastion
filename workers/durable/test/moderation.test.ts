import { Permission as P, newId, schemas, serializePermissions } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ciphertext, World, type TestConn } from "./world.js";

const DAY = 24 * 60 * 60 * 1000;

let world: World;
let owner: string;
let mod: string;
let alice: string;
let bob: string;
let serverId: string;
let general: string;
let modRole: string;
let modWs: TestConn;
let aliceWs: TestConn;
let bobWs: TestConn;

const MOD_PERMISSIONS = P.KICK | P.BAN | P.TIMEOUT | P.MANAGE_MESSAGES | P.VIEW_AUDIT_LOG;

beforeEach(async () => {
  world = new World();
  owner = newId();
  mod = newId();
  alice = newId();
  bob = newId();
  serverId = await world.createServer(owner);
  general = world.generalChannel(serverId, owner);
  for (const user of [mod, alice, bob]) await world.join(serverId, owner, user);
  modRole = await createRole(MOD_PERMISSIONS, 5);
  await grant(mod, modRole);
  modWs = await connect(mod);
  aliceWs = await connect(alice);
  bobWs = await connect(bob);
  // Drop the presence updates from connecting.
  await world.settle();
  for (const ws of [modWs, aliceWs, bobWs]) ws.clear();
});

async function connect(userId: string): Promise<TestConn> {
  const ws = world.connect(userId);
  await world.frame(ws, { op: "identify" });
  ws.clear();
  return ws;
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

function send(userId: string, channelId = general, key?: string) {
  return world.op(serverId, userId, { type: "message.create", channelId, body: { ciphertext: ciphertext(), epoch: 0 } }, key);
}

function timeout(actor: string, userId: string, seconds = 60, reason?: string) {
  return world.op(serverId, actor, { type: "member.timeout", userId, body: { seconds, ...(reason ? { reason } : {}) } });
}

async function auditLog(query: Record<string, unknown> = {}) {
  const reply = await world.op(serverId, owner, { type: "audit.list", query: { limit: 100, ...query } });
  expect(reply.status).toBe(200);
  return reply.body as schemas.AuditLogEntry[];
}

function report(reporter: string, messageIds: string[], channelId = general) {
  return world.op(serverId, reporter, {
    type: "report.create",
    body: { channelId, category: "harassment", messages: messageIds.map((id) => ({ id, content: `plaintext of ${id}` })) },
  });
}

function member(userId: string) {
  return world.server(serverId).snapshot(owner)!.members.find((m) => m.userId === userId)!;
}

// ------------------------------------------------------------------ timeouts

describe("timeouts", () => {
  it("block sending, typing and invites until they end", async () => {
    const reply = await timeout(mod, alice, 60, "cool off");
    expect(reply.status).toBe(200);
    expect(reply.body.timeoutUntil).toBe(world.now + 60_000);
    expect(bobWs.dispatches()).toContainEqual(expect.objectContaining({ t: "MEMBER_UPDATE", d: reply.body }));

    expect((await send(alice)).body).toEqual({ error: "missing_permissions" });
    expect((await world.op(serverId, alice, { type: "typing", channelId: general })).status).toBe(403);
    expect((await world.op(serverId, alice, { type: "invite.create", body: {} })).status).toBe(403);

    world.now += 61_000;
    expect((await send(alice)).status).toBe(201);
    expect(member(alice).timeoutUntil).toBeNull();
  });

  it("still let the member read and report", async () => {
    const message = await send(bob);
    await timeout(mod, alice);
    expect((await world.op(serverId, alice, { type: "messages.list", channelId: general, query: { limit: 10 } })).status).toBe(200);
    expect((await report(alice, [message.body.id])).status).toBe(201);
  });

  it("are not ended by leaving and rejoining", async () => {
    await timeout(mod, alice, 3600);
    expect((await world.op(serverId, alice, { type: "member.remove", userId: alice })).status).toBe(204);
    await world.join(serverId, owner, alice);
    expect((await send(alice)).status).toBe(403);
    expect(member(alice).timeoutUntil).toBe(world.now + 3_600_000);
  });

  it("need TIMEOUT and a higher role than the target", async () => {
    expect((await timeout(bob, alice)).body).toEqual({ error: "missing_permissions" });
    expect((await timeout(mod, owner)).body).toEqual({ error: "role_hierarchy" });
    expect((await timeout(mod, mod)).body).toEqual({ error: "cannot_moderate_self" });
    await grant(alice, modRole);
    expect((await timeout(mod, alice)).body).toEqual({ error: "role_hierarchy" });
    expect((await timeout(mod, newId())).body).toEqual({ error: "unknown_member" });
  });

  it("cannot be put on an administrator", async () => {
    const admin = await createRole(P.ADMINISTRATOR, 1);
    await grant(alice, admin);
    expect((await timeout(mod, alice)).body).toEqual({ error: "cannot_timeout_admin" });
  });

  it("stop a timed-out moderator from moderating", async () => {
    expect((await timeout(owner, mod)).status).toBe(200);
    expect((await world.op(serverId, mod, { type: "member.remove", userId: alice })).body).toEqual({ error: "missing_permissions" });
    expect((await world.op(serverId, mod, { type: "ban.put", userId: alice })).status).toBe(403);
    expect((await world.op(serverId, mod, { type: "audit.list", query: { limit: 10 } })).status).toBe(403);
  });

  it("can be lifted early, and both steps are logged", async () => {
    await timeout(mod, alice, 600, "spamming");
    bobWs.clear();
    const lifted = await world.op(serverId, mod, { type: "member.timeout.remove", userId: alice, body: { reason: "apologised" } });
    expect(lifted.body.timeoutUntil).toBeNull();
    expect(bobWs.types()).toEqual(["MEMBER_UPDATE"]);
    expect((await send(alice)).status).toBe(201);

    // Lifting a timeout that is not there changes nothing and logs nothing.
    await world.op(serverId, mod, { type: "member.timeout.remove", userId: alice });
    const log = await auditLog();
    expect(log.map((e) => [e.action, e.actorId, e.targetId, e.reason])).toEqual([
      ["member.timeout.remove", mod, alice, "apologised"],
      ["member.timeout", mod, alice, "spamming"],
      ["member.role.add", owner, mod, null],
      ["role.create", owner, modRole, null],
    ]);
    expect(log[1]!.data).toEqual({ until: world.now + 600_000 });
  });
});

// ------------------------------------------------------------------ kicks

describe("kicks", () => {
  it("remove the member, tell everyone and log the reason", async () => {
    const reply = await world.op(serverId, mod, { type: "member.remove", userId: alice, body: { reason: "rude" } });
    expect(reply.status).toBe(204);
    expect(aliceWs.types()).toEqual(["SERVER_DELETE"]);
    expect(bobWs.dispatches()).toContainEqual(expect.objectContaining({ t: "MEMBER_REMOVE", d: { serverId, userId: alice } }));
    expect((await auditLog({ action: "member.kick" })).map((e) => [e.actorId, e.targetId, e.reason])).toEqual([[mod, alice, "rude"]]);
  });

  it("need KICK and a higher role", async () => {
    expect((await world.op(serverId, bob, { type: "member.remove", userId: alice })).status).toBe(403);
    expect((await world.op(serverId, mod, { type: "member.remove", userId: owner })).body).toEqual({ error: "role_hierarchy" });
  });

  it("are logged but leaving is not", async () => {
    await world.op(serverId, alice, { type: "member.remove", userId: alice });
    expect(await auditLog({ action: "member.kick" })).toEqual([]);
  });
});

// ------------------------------------------------------------------ bans

describe("bans", () => {
  it("remove the member, block rejoining and list the reason", async () => {
    expect((await world.op(serverId, mod, { type: "ban.put", userId: alice, body: { reason: "raid" } })).status).toBe(204);
    expect(aliceWs.types()).toEqual(["SERVER_DELETE"]);
    await expect(world.join(serverId, owner, alice)).rejects.toThrow(/banned/);

    const bans = await world.op(serverId, mod, { type: "bans.list", query: { limit: 10 } });
    expect(bans.body).toEqual([{ serverId, userId: alice, reason: "raid", createdBy: mod, createdAt: world.now }]);

    expect((await world.op(serverId, mod, { type: "ban.delete", userId: alice, body: { reason: "appeal" } })).status).toBe(204);
    await world.join(serverId, owner, alice);
    const log = await auditLog();
    expect(log.slice(0, 2).map((e) => [e.action, e.reason])).toEqual([
      ["member.unban", "appeal"],
      ["member.ban", "raid"],
    ]);
  });

  it("can delete the user's recent messages", async () => {
    const old = await send(alice);
    world.now += 2 * 60 * 60 * 1000;
    const recent = [await send(alice), await send(alice)];
    bobWs.clear();

    await world.op(serverId, mod, { type: "ban.put", userId: alice, body: { deleteMessageSeconds: 3600 } });
    const deletes = bobWs.dispatches().filter((d) => d.t === "MESSAGE_DELETE").map((d) => d.d.id);
    expect(deletes.sort()).toEqual(recent.map((m) => m.body.id).sort());
    const left = await world.op(serverId, bob, { type: "messages.list", channelId: general, query: { limit: 10 } });
    expect(left.body.map((m: { id: string }) => m.id)).toEqual([old.body.id]);
    expect((await auditLog({ action: "member.ban" }))[0]!.data).toEqual({ deletedMessages: 2 });
  });

  it("work on users who are not members", async () => {
    const stranger = newId();
    expect((await world.op(serverId, mod, { type: "ban.put", userId: stranger })).status).toBe(204);
    await expect(world.join(serverId, owner, stranger)).rejects.toThrow(/banned/);
  });

  it("need BAN to add, remove or list", async () => {
    expect((await world.op(serverId, bob, { type: "ban.put", userId: alice })).status).toBe(403);
    expect((await world.op(serverId, bob, { type: "ban.delete", userId: alice })).status).toBe(403);
    expect((await world.op(serverId, bob, { type: "bans.list", query: { limit: 10 } })).status).toBe(403);
    expect((await world.op(serverId, mod, { type: "ban.put", userId: owner })).body).toEqual({ error: "role_hierarchy" });
  });
});

// ------------------------------------------------------------------ slow mode

describe("slow mode", () => {
  async function setSlowMode(seconds: number) {
    const reply = await world.op(serverId, owner, { type: "channel.update", channelId: general, body: { slowModeSeconds: seconds } });
    expect(reply.status).toBe(200);
    return reply;
  }

  it("makes members wait between messages", async () => {
    const reply = await setSlowMode(30);
    expect(reply.body.slowModeSeconds).toBe(30);
    expect(aliceWs.dispatches()).toContainEqual(expect.objectContaining({ t: "CHANNEL_UPDATE", d: expect.objectContaining({ slowModeSeconds: 30 }) }));

    expect((await send(alice)).status).toBe(201);
    expect(await send(alice)).toEqual({ status: 429, body: { error: "slow_mode", retryAfterMs: 30_000 } });
    world.now += 10_000;
    expect((await send(alice)).body).toEqual({ error: "slow_mode", retryAfterMs: 20_000 });
    // Each member has their own clock.
    expect((await send(bob)).status).toBe(201);
    world.now += 20_000;
    expect((await send(alice)).status).toBe(201);
  });

  it("lets a slowed message be retried with the same key", async () => {
    await setSlowMode(5);
    await send(alice);
    expect((await send(alice, general, "retry-key-1")).status).toBe(429);
    world.now += 5_000;
    expect((await send(alice, general, "retry-key-1")).status).toBe(201);
  });

  it("does not slow down moderators", async () => {
    await setSlowMode(60);
    expect((await send(mod)).status).toBe(201);
    expect((await send(mod)).status).toBe(201);
  });

  it("is logged and can be turned off", async () => {
    await setSlowMode(60);
    await send(alice);
    await setSlowMode(0);
    expect((await send(alice)).status).toBe(201);
    const log = await auditLog({ action: "channel.slow_mode" });
    expect(log.map((e) => e.data)).toEqual([{ seconds: 0 }, { seconds: 60 }]);
  });

  it("can be set when a channel is created and needs MANAGE_CHANNELS", async () => {
    const created = await world.op(serverId, owner, { type: "channel.create", body: { name: "slow", slowModeSeconds: 120 } });
    expect(created.body.slowModeSeconds).toBe(120);
    const denied = await world.op(serverId, mod, { type: "channel.update", channelId: general, body: { slowModeSeconds: 10 } });
    expect(denied.status).toBe(403);
  });
});

// ------------------------------------------------------------------ reports

describe("reports", () => {
  it("store only the chosen messages and go to moderators without naming the reporter", async () => {
    const first = await send(alice);
    await send(alice);
    const reply = await report(bob, [first.body.id]);
    expect(reply).toEqual({ status: 201, body: { id: expect.any(String), status: "open", createdAt: world.now } });

    const expected = {
      id: reply.body.id,
      serverId,
      channelId: general,
      category: "harassment",
      note: null,
      status: "open",
      messages: [{ id: first.body.id, authorId: alice, content: `plaintext of ${first.body.id}`, createdAt: first.body.createdAt }],
      handledBy: null,
      createdAt: world.now,
      updatedAt: world.now,
    };
    expect(modWs.dispatches()).toContainEqual(expect.objectContaining({ t: "REPORT_CREATE", d: expected }));
    expect(aliceWs.types()).not.toContain("REPORT_CREATE");
    expect(bobWs.types()).not.toContain("REPORT_CREATE");

    const list = await world.op(serverId, mod, { type: "reports.list", query: { limit: 10 } });
    expect(list.body).toEqual([expected]);
    expect(JSON.stringify(list.body)).not.toContain(bob);
  });

  it("reject unknown messages, hidden channels and repeats", async () => {
    const message = await send(alice);
    expect((await report(bob, [newId()])).body).toEqual({ error: "unknown_message" });
    expect((await report(bob, [message.body.id], newId())).body).toEqual({ error: "unknown_channel" });
    // Failed attempts count toward the limit too.
    world.now += 3 * 60_000;
    expect((await report(bob, [message.body.id])).status).toBe(201);
    expect((await report(bob, [message.body.id])).body).toEqual({ error: "already_reported" });
    // Someone else may still report the same message.
    expect((await report(mod, [message.body.id])).status).toBe(201);
  });

  it("are rate limited per reporter", async () => {
    const messages = [];
    for (let i = 0; i < 4; i++) messages.push((await send(alice)).body.id);
    for (const id of messages.slice(0, 3)) expect((await report(bob, [id])).status).toBe(201);
    expect((await report(bob, [messages[3]!])).status).toBe(429);
    world.now += 60_000;
    expect((await report(bob, [messages[3]!])).status).toBe(201);
  });

  it("can only be read and handled by moderators of that channel", async () => {
    const secret = (await world.op(serverId, owner, { type: "channel.create", body: { name: "secret" } })).body.id as string;
    await world.op(serverId, owner, {
      type: "override.put",
      channelId: secret,
      kind: "role",
      targetId: modRole,
      body: { allow: "0", deny: serializePermissions(P.VIEW_CHANNEL) },
    });
    const hidden = await report(owner, [(await send(owner, secret)).body.id], secret);
    const visible = await report(bob, [(await send(alice)).body.id]);

    const list = await world.op(serverId, mod, { type: "reports.list", query: { limit: 10 } });
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([visible.body.id]);
    const update = (actor: string, reportId: string) =>
      world.op(serverId, actor, { type: "report.update", reportId, body: { status: "resolved" } });
    expect((await update(mod, hidden.body.id)).body).toEqual({ error: "unknown_report" });
    expect((await update(alice, visible.body.id)).body).toEqual({ error: "unknown_report" });
    expect((await world.op(serverId, alice, { type: "reports.list", query: { limit: 10 } })).status).toBe(403);
  });

  it("log and broadcast status changes", async () => {
    const created = await report(bob, [(await send(alice)).body.id]);
    modWs.clear();
    const updated = await world.op(serverId, mod, {
      type: "report.update",
      reportId: created.body.id,
      body: { status: "resolved", reason: "timed out the author" },
    });
    expect(updated.body).toMatchObject({ status: "resolved", handledBy: mod });
    expect(modWs.types()).toEqual(["REPORT_UPDATE", "AUDIT_LOG_ENTRY_CREATE"]);
    const [entry] = await auditLog({ action: "report.update" });
    expect(entry).toMatchObject({ actorId: mod, targetId: created.body.id, channelId: general, reason: "timed out the author", data: { status: "resolved" } });

    const open = await world.op(serverId, mod, { type: "reports.list", query: { status: "open", limit: 10 } });
    expect(open.body).toEqual([]);
  });

  it("are not delivered to someone who lost the permission before delivery", async () => {
    const message = await send(alice);
    world.down.add(mod);
    await report(bob, [message.body.id]);
    await world.op(serverId, owner, { type: "member.role.remove", userId: mod, roleId: modRole });
    world.down.delete(mod);
    modWs.clear();
    world.now += 60_000;
    await world.server(serverId).flush();
    expect(modWs.types()).not.toContain("REPORT_CREATE");
    expect(modWs.types()).toContain("MEMBER_UPDATE");
  });

  it("are deleted 90 days after they are closed, and with their channel", async () => {
    const closed = await report(bob, [(await send(alice)).body.id]);
    await world.op(serverId, mod, { type: "report.update", reportId: closed.body.id, body: { status: "dismissed" } });
    world.now += 91 * DAY;
    const open = await report(bob, [(await send(alice)).body.id]);
    const list = await world.op(serverId, mod, { type: "reports.list", query: { limit: 10 } });
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([open.body.id]);

    const extra = (await world.op(serverId, owner, { type: "channel.create", body: { name: "extra" } })).body.id as string;
    await report(bob, [(await send(alice, extra)).body.id], extra);
    await world.op(serverId, owner, { type: "channel.delete", channelId: extra });
    const after = await world.op(serverId, mod, { type: "reports.list", query: { limit: 10 } });
    expect(after.body.map((r: { id: string }) => r.id)).toEqual([open.body.id]);
  });
});

// ------------------------------------------------------------------ audit log

describe("audit log", () => {
  it("needs VIEW_AUDIT_LOG", async () => {
    expect((await world.op(serverId, alice, { type: "audit.list", query: { limit: 10 } })).body).toEqual({ error: "missing_permissions" });
  });

  it("sends new entries only to members who can read it", async () => {
    await timeout(mod, alice);
    const entry = modWs.dispatches().find((d) => d.t === "AUDIT_LOG_ENTRY_CREATE");
    expect(entry?.d).toMatchObject({ serverId, actorId: mod, action: "member.timeout", targetId: alice });
    expect(bobWs.types()).not.toContain("AUDIT_LOG_ENTRY_CREATE");
    expect(aliceWs.types()).not.toContain("AUDIT_LOG_ENTRY_CREATE");
  });

  it("logs moderators deleting other people's messages but not their own", async () => {
    const theirs = await send(alice);
    const mine = await send(mod);
    for (const m of [theirs, mine]) {
      await world.op(serverId, mod, { type: "message.delete", channelId: general, messageId: m.body.id });
    }
    const log = await auditLog({ action: "message.delete" });
    expect(log.map((e) => [e.targetId, e.data])).toEqual([[alice, { messageId: theirs.body.id }]]);
  });

  it("filters by action and actor and pages newest first", async () => {
    await timeout(mod, alice);
    await timeout(mod, bob);
    await world.op(serverId, owner, { type: "server.update", body: { name: "Renamed" } });

    expect((await auditLog({ actorId: mod })).map((e) => e.targetId)).toEqual([bob, alice]);
    const page = await auditLog({ limit: 2 });
    expect(page.map((e) => e.action)).toEqual(["server.update", "member.timeout"]);
    const next = await auditLog({ before: page[1]!.id, limit: 1 });
    expect(next.map((e) => e.targetId)).toEqual([alice]);
  });

  it("drops entries after 90 days", async () => {
    await timeout(mod, alice);
    world.now += 91 * DAY;
    await timeout(mod, bob);
    expect((await auditLog({ action: "member.timeout" })).map((e) => e.targetId)).toEqual([bob]);
  });
});

// ------------------------------------------------------------------ deletion

describe("server deletion", () => {
  it("is for the owner only", async () => {
    expect((await world.op(serverId, mod, { type: "server.delete" })).body).toEqual({ error: "not_owner" });
  });

  it("tells every member, removes everything and cannot be undone", async () => {
    const reply = await world.op(serverId, owner, { type: "server.delete" }, "delete-key-1");
    expect(reply).toEqual({ status: 204, body: null, effects: { serverDeleted: true } });
    for (const ws of [modWs, aliceWs, bobWs]) expect(ws.types()).toContain("SERVER_DELETE");
    expect(world.session(alice).core.serverIds()).toEqual([]);

    const core = world.server(serverId);
    expect(core.snapshot(owner)).toBeNull();
    expect((await world.op(serverId, owner, { type: "messages.list", channelId: general, query: { limit: 10 } })).status).toBe(404);
    expect(core.init(serverId, owner, "Again")).toEqual({ status: 410, body: { error: "server_deleted" } });
    // A retried delete gets the same answer.
    expect(await world.op(serverId, owner, { type: "server.delete" }, "delete-key-1")).toEqual(reply);
  });

  it("still reaches members whose session was down", async () => {
    world.down.add(alice);
    await world.op(serverId, owner, { type: "server.delete" });
    world.down.delete(alice);
    world.now += 60_000;
    await world.server(serverId).flush();
    expect(aliceWs.types()).toEqual(["SERVER_DELETE"]);
  });
});
