import { newId } from "@bastion/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteAccount, purgeRemovedAccounts, type DeletionPorts } from "../src/account/delete.js";
import { handleAccount } from "../src/account/routes.js";
import { hashToken, newToken } from "../src/auth/crypto.js";
import { placeHold, releaseHold } from "../src/safety/holds.js";
import { createTestD1 } from "./d1.js";

let db: D1Database;
let now: number;
let log: string[];
let memberOf: Record<string, string[]>;
let owners: Record<string, string>;
let r2: string[];

beforeEach(() => {
  db = createTestD1();
  now = Date.UTC(2026, 10, 19, 12);
  log = [];
  memberOf = {};
  owners = {};
  r2 = [];
});

const ports = (): DeletionPorts => ({
  db,
  now: () => now,
  serverIds: async (u) => memberOf[u] ?? [],
  serverOwner: async (s) => owners[s] ?? null,
  leaveServer: async (s, u) => { log.push(`leave ${s} ${u}`); },
  deleteServer: async (s) => { log.push(`delete ${s}`); },
  revokeConversation: async (c, u) => { log.push(`revoke ${c} ${u}`); },
  endSessions: async (u, ids) => { log.push(`end ${u} ${ids.length}`); },
  files: { delete: async (keys: string[]) => { r2.push(...keys); } } as unknown as R2Bucket,
});

async function account(state = "active") {
  const userId = newId();
  const deviceId = newId();
  const token = newToken();
  await db.prepare("INSERT INTO users (id, email, created_at, account_state, state_changed_at) VALUES (?, ?, ?, ?, ?)").bind(userId, `${userId.toLowerCase()}@test`, now, state, now).run();
  await db.prepare("INSERT INTO devices (id, user_id, name, credential_id, public_key, created_at) VALUES (?, ?, 'Laptop', ?, 'pk', ?)").bind(deviceId, userId, `cred-${deviceId}`, now).run();
  await db
    .prepare("INSERT INTO sessions (id, user_id, device_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId(), userId, deviceId, await hashToken(token), now + 3_600_000, await hashToken(newToken()), now + 86_400_000, now)
    .run();
  await db.prepare("INSERT INTO terms_acceptances (user_id, document, version, accepted_at) VALUES (?, 'terms', '1', ?)").bind(userId, now).run();
  return { userId, deviceId, token };
}

async function addFile(userId: string) {
  const id = newId();
  await db
    .prepare("INSERT INTO attachments (id, uploader_id, conversation_id, visibility, status, size, content_type, created_at, expires_at) VALUES (?, ?, 'conv', 'private', 'ready', 10, 'application/octet-stream', ?, ?)")
    .bind(id, userId, now, now + 1000)
    .run();
  return id;
}

const count = async (table: string, col: string, userId: string) =>
  (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).bind(userId).first<{ n: number }>())!.n;

describe("deleteAccount", () => {
  it("removes the account and everything tied to it, leaves servers and conversations, and clears R2", async () => {
    const me = await account();
    const server = newId();
    memberOf[me.userId] = [server];
    owners[server] = newId();
    await db.prepare("INSERT INTO conversation_members (conversation_id, user_id) VALUES ('conv-1', ?)").bind(me.userId).run();
    const file = await addFile(me.userId);

    await deleteAccount(ports(), me.userId);

    expect(await count("users", "id", me.userId)).toBe(0);
    for (const [table, col] of [["devices", "user_id"], ["sessions", "user_id"], ["terms_acceptances", "user_id"], ["attachments", "uploader_id"], ["conversation_members", "user_id"]] as const) {
      expect(await count(table, col, me.userId), table).toBe(0);
    }
    expect(log).toEqual([`leave ${server} ${me.userId}`, `revoke conv-1 ${me.userId}`, `end ${me.userId} 1`]);
    expect(r2.sort()).toEqual([`files/${file}`, `pending/${file}`].sort());
  });

  it("is refused while the account is under a legal hold, and touches nothing", async () => {
    const me = await account();
    memberOf[me.userId] = [newId()];
    await placeHold(db, "staff-1", "account", me.userId, "child_safety", "case-9", now);
    await expect(deleteAccount(ports(), me.userId)).rejects.toMatchObject({ status: 409, code: "legal_hold" });
    expect(await count("users", "id", me.userId)).toBe(1);
    expect(log).toEqual([]);
    expect(r2).toEqual([]);
  });

  it("is refused while one of the person's files is held", async () => {
    const me = await account();
    const file = await addFile(me.userId);
    const hold = await placeHold(db, "staff-1", "file", file, "illegal_content", null, now);
    await expect(deleteAccount(ports(), me.userId)).rejects.toMatchObject({ code: "legal_hold" });
    expect(await count("attachments", "uploader_id", me.userId)).toBe(1);
    await releaseHold(db, "staff-1", hold, now);
    await deleteAccount(ports(), me.userId);
    expect(await count("users", "id", me.userId)).toBe(0);
  });

  it("works again once a hold is released", async () => {
    const me = await account();
    const hold = await placeHold(db, "staff-1", "account", me.userId, "child_safety", null, now);
    await expect(deleteAccount(ports(), me.userId)).rejects.toMatchObject({ code: "legal_hold" });
    await releaseHold(db, "staff-1", hold, now);
    await deleteAccount(ports(), me.userId);
    expect(await count("users", "id", me.userId)).toBe(0);
  });

  it("asks the owner of a server to delete or hand it on first", async () => {
    const me = await account();
    const server = newId();
    memberOf[me.userId] = [server];
    owners[server] = me.userId;
    await expect(deleteAccount(ports(), me.userId)).rejects.toMatchObject({ status: 409, code: "owns_servers" });
    expect(await count("users", "id", me.userId)).toBe(1);
    expect(log).toEqual([]);
  });

  it("refuses to delete a held server owned by a removed account", async () => {
    const me = await account("underage_removed");
    const server = newId();
    memberOf[me.userId] = [server];
    owners[server] = me.userId;
    await placeHold(db, "staff-1", "server", server, "child_safety", null, now);
    await expect(deleteAccount(ports(), me.userId, { deleteOwnedServers: true })).rejects.toMatchObject({ code: "legal_hold" });
    expect(log).toEqual([]);
  });
});

describe("purgeRemovedAccounts", () => {
  const DAY = 24 * 60 * 60_000;

  it("deletes removed accounts after the grace period and nothing else", async () => {
    const old = await account("underage_removed");
    const fresh = await account("underage_removed");
    const normal = await account("active");
    await db.prepare("UPDATE users SET state_changed_at = ? WHERE id = ?").bind(now - 8 * DAY, old.userId).run();
    await db.prepare("UPDATE users SET state_changed_at = ? WHERE id = ?").bind(now - 8 * DAY, normal.userId).run();
    expect(await purgeRemovedAccounts(ports(), now)).toBe(1);
    expect(await count("users", "id", old.userId)).toBe(0);
    expect(await count("users", "id", fresh.userId)).toBe(1);
    expect(await count("users", "id", normal.userId)).toBe(1);
  });

  it("skips held accounts and takes them once released", async () => {
    const held = await account("underage_removed");
    await db.prepare("UPDATE users SET state_changed_at = ? WHERE id = ?").bind(now - 30 * DAY, held.userId).run();
    const hold = await placeHold(db, "staff-1", "account", held.userId, "child_safety", "ncmec-1", now);
    expect(await purgeRemovedAccounts(ports(), now)).toBe(0);
    expect(await count("users", "id", held.userId)).toBe(1);
    await releaseHold(db, "staff-1", hold, now);
    expect(await purgeRemovedAccounts(ports(), now)).toBe(1);
  });

  it("deletes a removed account's own servers", async () => {
    const me = await account("underage_removed");
    await db.prepare("UPDATE users SET state_changed_at = ? WHERE id = ?").bind(now - 30 * DAY, me.userId).run();
    const server = newId();
    memberOf[me.userId] = [server];
    owners[server] = me.userId;
    expect(await purgeRemovedAccounts(ports(), now)).toBe(1);
    expect(log).toContain(`delete ${server}`);
  });
});

describe("DELETE /account", () => {
  async function call(as: { token: string } | null, body: unknown = { confirm: "delete my account" }, withPorts = true) {
    const res = await handleAccount(
      new Request("https://api.test/account", { method: "DELETE", headers: as ? { authorization: `Bearer ${as.token}` } : {}, body: JSON.stringify(body) }),
      { db, sessions: {} as never, now: () => now, ...(withPorts ? { deletion: ports() } : {}) },
    );
    const text = await res!.text();
    return { status: res!.status, body: text ? JSON.parse(text) : null };
  }

  it("needs sign in and an explicit confirmation", async () => {
    const me = await account();
    expect((await call(null)).status).toBe(401);
    expect((await call(me, {})).status).toBe(400);
    expect((await call(me, { confirm: "yes" })).status).toBe(400);
    expect(await count("users", "id", me.userId)).toBe(1);
  });

  it("deletes the account", async () => {
    const me = await account();
    expect((await call(me)).status).toBe(204);
    expect(await count("users", "id", me.userId)).toBe(0);
  });

  it("works for a restricted account, which may export and leave", async () => {
    const me = await account("restricted");
    expect((await call(me)).status).toBe(204);
  });

  it("answers 409 legal_hold without saying why, and 503 when deletion is not wired", async () => {
    const me = await account();
    await placeHold(db, "staff-1", "account", me.userId, "child_safety", "secret-case", now);
    const held = await call(me);
    expect(held).toEqual({ status: 409, body: { error: "legal_hold" } });
    expect((await call(me, undefined, false)).status).toBe(503);
  });

  it("is limited to a few tries an hour", async () => {
    const me = await account();
    await placeHold(db, "staff-1", "account", me.userId, "child_safety", null, now);
    for (let i = 0; i < 5; i++) expect((await call(me)).status).toBe(409);
    expect((await call(me)).status).toBe(429);
  });
});
