import type { schemas } from "@bastion/shared";
import { describe, expect, it } from "vitest";
import { AuthClient } from "../src/lib/auth.js";
import { Controller } from "../src/lib/controller.js";
import { Api, MemoryTokenStore } from "../src/lib/http.js";
import { buildChatExport } from "../src/lib/privacy.js";

const U = "01HZZZZZZZZZZZZZZZZZZZZZU1";
const PEER = "01HZZZZZZZZZZZZZZZZZZZZZU2";
const CH = "01HZZZZZZZZZZZZZZZZZZZZZC1";
const SECRET_KEY = "A".repeat(43) + "=";

const payload = (text: string, withFile = false): schemas.MessagePayload =>
  ({
    text,
    attachments: withFile ? [{ id: "01HZZZZZZZZZZZZZZZZZZZZZF1", key: SECRET_KEY, nonce: "B".repeat(16), name: "map.png", mime: "image/png", size: 99 }] : [],
  }) as schemas.MessagePayload;

const msg = (id: string, authorId: string): schemas.Message => ({
  id,
  serverId: "01HZZZZZZZZZZZZZZZZZZZZZS1",
  channelId: CH,
  authorId,
  ciphertext: "AAAA",
  epoch: 1,
  createdAt: 5,
  editedAt: null,
});

describe("buildChatExport", () => {
  const input = {
    userId: U,
    dms: {
      c1: {
        conversationId: "c1",
        peerId: PEER,
        messages: [{ seq: 1, senderId: PEER, senderDeviceId: "d", createdAt: 10, payload: payload("hello", true) }],
      },
    },
    channelMessages: { [CH]: [msg("m1", U), msg("m2", PEER)] },
    plaintext: { m1: payload("in channel"), m2: null },
  };

  it("includes readable DMs and channel messages only", () => {
    const out = buildChatExport(input, 123);
    expect(out).toMatchObject({ format: "bastion-chat-export", version: 1, exportedAt: 123, userId: U });
    expect(out.direct).toEqual([
      { conversationId: "c1", peerId: PEER, messages: [{ id: null, senderId: PEER, at: 10, text: "hello", attachments: [{ name: "map.png", mime: "image/png", size: 99 }] }] },
    ]);
    expect(out.channels).toEqual([{ channelId: CH, messages: [{ id: "m1", senderId: U, at: 5, text: "in channel", attachments: [] }] }]);
  });

  it("never carries attachment keys or ciphertext", () => {
    const text = JSON.stringify(buildChatExport(input, 123));
    expect(text).not.toContain(SECRET_KEY);
    expect(text).not.toContain("ciphertext");
    expect(text).not.toContain("nonce");
  });

  it("is empty but valid with no history", () => {
    const out = buildChatExport({ userId: null, dms: {}, channelMessages: {}, plaintext: {} }, 1);
    expect(out.direct).toEqual([]);
    expect(out.channels).toEqual([]);
  });
});

describe("Controller privacy calls", () => {
  it("reads and writes settings through the account routes", async () => {
    const calls: { method: string; url: string; body: string | null }[] = [];
    const api = new Api({
      baseUrl: "",
      store: new MemoryTokenStore(),
      fetch: async (url, init) => {
        calls.push({ method: init?.method ?? "GET", url: String(url), body: (init?.body as string | undefined) ?? null });
        return new Response(JSON.stringify({ dmPolicy: "nobody", typingIndicators: true }));
      },
    });
    const c = new Controller({ api, auth: new AuthClient(api), createMls: () => { throw new Error("unused"); }, gatewayUrl: "ws://h" });
    await c.getPrivacy();
    await c.updatePrivacy({ dmPolicy: "nobody" });
    await c.accountExport();
    expect(calls.map((x) => `${x.method} ${new URL(x.url).pathname}`)).toEqual(["GET /account/privacy", "PUT /account/privacy", "GET /account/export"]);
    expect(calls[1]!.body).toBe(JSON.stringify({ dmPolicy: "nobody" }));
  });
});
