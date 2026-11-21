import { Permission } from "@bastion/shared";
import { describe, expect, it } from "vitest";
import { AuthClient } from "../src/lib/auth.js";
import { Controller } from "../src/lib/controller.js";
import { Api, MemoryTokenStore } from "../src/lib/http.js";
import { applyReady } from "../src/lib/store.js";
import { emptyState } from "../src/lib/store.js";

const OWNER = "01HZZZZZZZZZZZZZZZZZZZZZZ1";
const GUEST = "01HZZZZZZZZZZZZZZZZZZZZZZ2";
const S = "01HZZZZZZZZZZZZZZZZZZZZZS1";
const C = "01HZZZZZZZZZZZZZZZZZZZZZC1";

function controllerFor(userId: string, everyone: bigint, overrides: { allow: bigint; deny: bigint } | null = null) {
  const api = new Api({ baseUrl: "", store: new MemoryTokenStore(), fetch: async () => new Response("{}") });
  const c = new Controller({ api, auth: new AuthClient(api), createMls: () => { throw new Error("unused"); }, gatewayUrl: "ws://h" });
  const chat = applyReady(emptyState, {
    userId,
    seq: 0,
    servers: [
      {
        server: { id: S, name: "Home", ownerId: OWNER },
        roles: [{ id: S, serverId: S, name: "@everyone", permissions: everyone.toString(), position: 0 }],
        channels: [
          {
            id: C, serverId: S, name: "general", kind: "text", position: 0, slowModeSeconds: 0, ageRestricted: false,
            overrides: overrides ? [{ kind: "role", targetId: S, allow: overrides.allow.toString(), deny: overrides.deny.toString() }] : [],
          },
        ],
        members: [OWNER, GUEST].map((u) => ({ serverId: S, userId: u, nick: null, roles: [], joinedAt: 1, timeoutUntil: null })),
        presences: [],
        voiceStates: [],
      },
    ],
  });
  (c as unknown as { state: unknown }).state = { ...c.getState(), phase: "ready", chat };
  return c;
}

describe("Controller.can", () => {
  const base = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;

  it("follows the @everyone role", () => {
    const c = controllerFor(GUEST, base);
    expect(c.can(S, C, Permission.SEND_MESSAGES)).toBe(true);
    expect(c.can(S, C, Permission.MANAGE_CHANNELS)).toBe(false);
  });

  it("applies channel overrides for @everyone", () => {
    const c = controllerFor(GUEST, base, { allow: 0n, deny: Permission.SEND_MESSAGES });
    expect(c.can(S, C, Permission.SEND_MESSAGES)).toBe(false);
    expect(c.can(S, C, Permission.VIEW_CHANNEL)).toBe(true);
  });

  it("gives the owner everything", () => {
    const c = controllerFor(OWNER, 0n);
    expect(c.can(S, C, Permission.MANAGE_CHANNELS)).toBe(true);
  });

  it("denies everything for an unknown server", () => {
    expect(controllerFor(GUEST, base).can("01HZZZZZZZZZZZZZZZZZZZZNONE", C, Permission.VIEW_CHANNEL)).toBe(false);
  });

  it("checks server-wide permissions without a channel", () => {
    const c = controllerFor(GUEST, base | Permission.KICK);
    expect(c.canServer(S, Permission.KICK)).toBe(true);
    expect(c.canServer(S, Permission.BAN)).toBe(false);
    expect(controllerFor(OWNER, 0n).canServer(S, Permission.VIEW_AUDIT_LOG)).toBe(true);
  });
});

describe("Controller moderation calls", () => {
  function recording() {
    const calls: { method: string; path: string; body: unknown }[] = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(url), "http://h");
      calls.push({ method: init?.method ?? "GET", path: u.pathname + u.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return new Response("[]", { status: 200 });
    };
    const tokens = { accessToken: "a".repeat(43), refreshToken: "r".repeat(43), accessExpiresAt: Date.now() + 1e6, refreshExpiresAt: Date.now() + 1e7 };
    const api = new Api({ baseUrl: "", store: new MemoryTokenStore(tokens as never), fetch });
    const c = new Controller({ api, auth: new AuthClient(api), createMls: () => { throw new Error("unused"); }, gatewayUrl: "ws://h" });
    return { c, calls };
  }

  it("sends the right requests", async () => {
    const { c, calls } = recording();
    await c.reports(S, "open");
    await c.setReportStatus(S, "R1", "resolved");
    await c.auditLog(S, { action: "member.ban" });
    await c.bans(S);
    await c.kick(S, GUEST, "spam");
    await c.timeout(S, GUEST, 600);
    await c.removeTimeout(S, GUEST);
    await c.ban(S, GUEST, { reason: "bad", deleteMessageSeconds: 3600 });
    await c.unban(S, GUEST);
    await c.createRole(S, "Mods", Permission.KICK | Permission.TIMEOUT);
    await c.updateRole(S, "R2", { permissions: Permission.BAN });
    await c.deleteRole(S, "R2");
    await c.setMemberRole(S, GUEST, "R2", true);
    await c.setMemberRole(S, GUEST, "R2", false);
    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      `GET /servers/${S}/reports?status=open&limit=50`,
      `PATCH /servers/${S}/reports/R1`,
      `GET /servers/${S}/audit-log?action=member.ban&limit=50`,
      `GET /servers/${S}/bans?limit=100`,
      `DELETE /servers/${S}/members/${GUEST}`,
      `PUT /servers/${S}/members/${GUEST}/timeout`,
      `DELETE /servers/${S}/members/${GUEST}/timeout`,
      `PUT /servers/${S}/bans/${GUEST}`,
      `DELETE /servers/${S}/bans/${GUEST}`,
      `POST /servers/${S}/roles`,
      `PATCH /servers/${S}/roles/R2`,
      `DELETE /servers/${S}/roles/R2`,
      `PUT /servers/${S}/members/${GUEST}/roles/R2`,
      `DELETE /servers/${S}/members/${GUEST}/roles/R2`,
    ]);
    expect(calls[4]!.body).toEqual({ reason: "spam" });
    expect(calls[5]!.body).toEqual({ seconds: 600 });
    expect(calls[7]!.body).toEqual({ reason: "bad", deleteMessageSeconds: 3600 });
    expect(calls[9]!.body).toEqual({ name: "Mods", permissions: (Permission.KICK | Permission.TIMEOUT).toString() });
    expect(calls[10]!.body).toEqual({ permissions: Permission.BAN.toString() });
  });
});
