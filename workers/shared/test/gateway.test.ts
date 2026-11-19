import { describe, expect, it } from "vitest";
import { EventName, EventPayloads, GatewayClientFrame } from "../src/gateway.js";
import { CreateMessageRequest, LIMITS } from "../src/servers.js";

describe("gateway frames", () => {
  it("accepts identify, resume and ping only", () => {
    expect(GatewayClientFrame.safeParse({ op: "identify" }).success).toBe(true);
    expect(GatewayClientFrame.safeParse({ op: "resume", seq: 12 }).success).toBe(true);
    expect(GatewayClientFrame.safeParse({ op: "resume", seq: -1 }).success).toBe(false);
    expect(GatewayClientFrame.safeParse({ op: "send", message: {} }).success).toBe(false);
  });

  it("has a payload schema for every event name", () => {
    for (const name of EventName.options) expect(EventPayloads[name]).toBeDefined();
    expect(EventName.options).toEqual(
      expect.arrayContaining([
        "MESSAGE_CREATE",
        "MESSAGE_UPDATE",
        "MESSAGE_DELETE",
        "PRESENCE_UPDATE",
        "TYPING_START",
        "CHANNEL_CREATE",
        "ROLE_UPDATE",
        "MEMBER_ADD",
        "MEMBER_REMOVE",
      ]),
    );
  });
});

describe("message limits", () => {
  it("caps ciphertext size", () => {
    const at = "A".repeat(LIMITS.maxCiphertextChars);
    const over = "A".repeat(LIMITS.maxCiphertextChars + 4);
    expect(CreateMessageRequest.safeParse({ ciphertext: at, epoch: 0 }).success).toBe(true);
    expect(CreateMessageRequest.safeParse({ ciphertext: over, epoch: 0 }).success).toBe(false);
    expect(CreateMessageRequest.safeParse({ ciphertext: "not base64!", epoch: 0 }).success).toBe(false);
  });
});
