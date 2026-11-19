import { describe, expect, it } from "vitest";
import { CommitRequest, ConversationId, E2EE_LIMITS, MessagePayload, SendMessageRequest } from "../src/conversations.js";
import { newId } from "../src/ids.js";

describe("conversation schemas", () => {
  it("takes 22-char base64url ids, not ULIDs", () => {
    expect(ConversationId.safeParse("AbCdEfGhIjKlMnOpQrSt_-").success).toBe(true);
    expect(ConversationId.safeParse(newId()).success).toBe(false);
  });

  it("wants a welcome exactly when devices are added", () => {
    const device = { userId: newId(), deviceId: newId() };
    const base = { epoch: 0, commit: "AAAA" };
    expect(CommitRequest.safeParse({ ...base, adds: [device], welcome: "AAAA" }).success).toBe(true);
    expect(CommitRequest.safeParse({ ...base, adds: [device] }).success).toBe(false);
    expect(CommitRequest.safeParse({ ...base, welcome: "AAAA" }).success).toBe(false);
    expect(CommitRequest.safeParse({ ...base, removes: [device] }).success).toBe(true);
  });

  it("caps message size", () => {
    const at = "A".repeat(E2EE_LIMITS.maxMessageChars);
    expect(SendMessageRequest.safeParse({ epoch: 0, ciphertext: at }).success).toBe(true);
    expect(SendMessageRequest.safeParse({ epoch: 0, ciphertext: at + "AAAA" }).success).toBe(false);
  });

  it("carries attachment keys inside the plaintext payload", () => {
    const payload = {
      text: "photo",
      attachments: [{ id: newId(), key: "a2".repeat(21) + "a=", nonce: "bm5ubm5ubm5ubm5u", name: "a.png", mime: "image/png", size: 10 }],
    };
    expect(MessagePayload.safeParse(payload).success).toBe(true);
    expect(MessagePayload.safeParse({ text: "x".repeat(8001) }).success).toBe(false);
  });
});
