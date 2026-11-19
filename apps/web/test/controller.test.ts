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
            id: C, serverId: S, name: "general", kind: "text", position: 0, slowModeSeconds: 0,
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
});
