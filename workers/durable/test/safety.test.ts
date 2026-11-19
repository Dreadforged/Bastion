import { Permission as P, newId, schemas } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { ServerCore } from "../src/server/core.js";
import { SERVER_MIGRATIONS } from "../src/server/schema.js";
import { migrate } from "../src/storage.js";
import { ciphertext, createTestStorage, World } from "./world.js";

const DAY = 24 * 60 * 60 * 1000;

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

async function auditLog() {
  const reply = await world.op(serverId, owner, { type: "audit.list", query: { limit: 100 } });
  expect(reply.status).toBe(200);
  return reply.body as schemas.AuditLogEntry[];
}

describe("age restricted channel label", () => {
  it("defaults to off and can be set on create and update", async () => {
    const plain = await world.op(serverId, owner, { type: "channel.create", body: { name: "plain" } });
    expect(plain.body.ageRestricted).toBe(false);

    const adult = await world.op(serverId, owner, { type: "channel.create", body: { name: "adults", ageRestricted: true } });
    expect(adult.status).toBe(201);
    expect(adult.body.ageRestricted).toBe(true);

    const cleared = await world.op(serverId, owner, { type: "channel.update", channelId: adult.body.id, body: { ageRestricted: false } });
    expect(cleared.body.ageRestricted).toBe(false);
    const labelled = await world.op(serverId, owner, { type: "channel.update", channelId: plain.body.id, body: { ageRestricted: true } });
    expect(labelled.body.ageRestricted).toBe(true);
  });

  it("is recorded in the audit log when it changes", async () => {
    const ch = await world.op(serverId, owner, { type: "channel.create", body: { name: "x" } });
    await world.op(serverId, owner, { type: "channel.update", channelId: ch.body.id, body: { ageRestricted: true } });
    const log = await auditLog();
    expect(log[0]).toMatchObject({ action: "channel.update", data: { ageRestricted: 1 } });
  });
});

describe("reason codes", () => {
  it("are stored next to the free text on audit entries", async () => {
    const reply = await world.op(serverId, owner, {
      type: "member.timeout",
      userId: alice,
      body: { seconds: 60, reason: "spamming links", reasonCode: "spam" },
    });
    expect(reply.status).toBe(200);
    const ban = await world.op(serverId, owner, { type: "ban.put", userId: alice, body: { reasonCode: "child_safety", deleteMessageSeconds: 0 } });
    expect(ban.status).toBeLessThan(300);
    const log = await auditLog();
    const entry = (action: string) => log.find((e) => e.action === action)!;
    expect(entry("member.timeout")).toMatchObject({ reason: "spamming links", reasonCode: "spam" });
    expect(entry("member.ban")).toMatchObject({ reason: null, reasonCode: "child_safety" });
  });

  it("are null when the moderator gave none, and unknown codes are refused", async () => {
    await world.op(serverId, owner, { type: "member.timeout", userId: alice, body: { seconds: 60 } });
    expect((await auditLog())[0]!.reasonCode).toBeNull();
    const bad = await world.op(serverId, owner, { type: "member.timeout", userId: alice, body: { seconds: 60, reasonCode: "because" as never } });
    expect(bad.status).toBe(400);
  });
});

describe("underage report category", () => {
  it("is accepted like any other category", async () => {
    const sent = await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } });
    const reply = await world.op(serverId, owner, {
      type: "report.create",
      body: { channelId: general, category: "underage", messages: [{ id: sent.body.id, content: "I am 12" }] },
    });
    expect(reply.status).toBe(201);
    const list = await world.op(serverId, owner, { type: "reports.list", query: { limit: 10 } });
    expect((list.body as { category: string }[])[0]!.category).toBe("underage");
  });
});

describe("retention", () => {
  let seq = 0;
  function core(retentionDays?: number) {
    const storage = createTestStorage();
    migrate(storage, SERVER_MIGRATIONS);
    let now = Date.UTC(2026, 10, 19);
    const c = new ServerCore(storage, {
      now: () => now,
      deliver: async () => {},
      ...(retentionDays ? { retentionMs: () => retentionDays * DAY } : {}),
    });
    return { c, advance: (ms: number) => (now += ms) };
  }

  async function auditCount(c: ServerCore, ownerId: string): Promise<number> {
    const reply = await c.handle(ownerId, { type: "audit.list", query: { limit: 100 } }, null);
    return (reply.body as unknown[]).length;
  }

  it("keeps audit entries for 90 days unless configured", async () => {
    const { c, advance } = core();
    const ownerId = newId();
    const sid = newId();
    c.init(sid, ownerId, "s");
    await c.handle(ownerId, { type: "role.create", body: { name: "a", permissions: "0", position: 1 } }, `k${++seq}-padpadpad`);
    advance(60 * DAY);
    await c.handle(ownerId, { type: "role.create", body: { name: "b", permissions: "0", position: 1 } }, `k${++seq}-padpadpad`);
    expect(await auditCount(c, ownerId)).toBe(2);
    advance(40 * DAY); // first entry is now 100 days old
    await c.handle(ownerId, { type: "role.create", body: { name: "c", permissions: "0", position: 1 } }, `k${++seq}-padpadpad`);
    expect(await auditCount(c, ownerId)).toBe(2);
  });

  it("uses the configured period", async () => {
    const { c, advance } = core(10);
    const ownerId = newId();
    c.init(newId(), ownerId, "s");
    await c.handle(ownerId, { type: "role.create", body: { name: "a", permissions: "0", position: 1 } }, `k${++seq}-padpadpad`);
    advance(11 * DAY);
    await c.handle(ownerId, { type: "role.create", body: { name: "b", permissions: "0", position: 1 } }, `k${++seq}-padpadpad`);
    expect(await auditCount(c, ownerId)).toBe(1);
  });
});

describe("report hold", () => {
  async function closedReport(): Promise<string> {
    const sent = await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } });
    const created = await world.op(serverId, owner, {
      type: "report.create",
      body: { channelId: general, category: "illegal", messages: [{ id: sent.body.id, content: "evidence" }] },
    });
    expect(created.status).toBe(201);
    const closed = await world.op(serverId, owner, { type: "report.update", reportId: created.body.id, body: { status: "resolved" } });
    expect(closed.status).toBe(200);
    return created.body.id as string;
  }

  async function listedReportIds(): Promise<string[]> {
    const list = await world.op(serverId, owner, { type: "reports.list", query: { limit: 100 } });
    return (list.body as { id: string }[]).map((r) => r.id);
  }

  it("keeps a held closed report past the retention period and lets an unheld one go", async () => {
    const held = await closedReport();
    const free = await closedReport();
    expect(world.server(serverId).setReportHold(held, true)).toBe(true);

    world.now += 100 * DAY;
    // Creating a report runs the sweep.
    const sent = await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } });
    await world.op(serverId, owner, {
      type: "report.create",
      body: { channelId: general, category: "spam", messages: [{ id: sent.body.id, content: "x" }] },
    });
    const ids = await listedReportIds();
    expect(ids).toContain(held);
    expect(ids).not.toContain(free);

    // Released, the next sweep takes it.
    world.server(serverId).setReportHold(held, false);
    const sent2 = await world.op(serverId, alice, { type: "message.create", channelId: general, body: { ciphertext: ciphertext(), epoch: 0 } });
    await world.op(serverId, owner, {
      type: "report.create",
      body: { channelId: general, category: "spam", messages: [{ id: sent2.body.id, content: "y" }] },
    });
    expect(await listedReportIds()).not.toContain(held);
  });

  it("says so when the report does not exist", () => {
    expect(world.server(serverId).setReportHold(newId(), true)).toBe(false);
  });
});

// Keeps the permission import honest: the owner holds everything these tests need.
void P;
