import { describe, expect, it } from "vitest";
import { EPHEMERAL_EVENTS, EventPayloads } from "../src/gateway.js";
import { newId } from "../src/ids.js";
import { STREAM_QUALITY, UpdateVoiceStateRequest, VOICE_LIMITS, VoiceState, VoiceTokenRequest } from "../src/voice.js";

describe("voice limits", () => {
  it("issues tokens for five minutes", () => {
    expect(VOICE_LIMITS.tokenTtlSeconds).toBe(300);
  });

  it("has the streaming plan tiers", () => {
    expect(STREAM_QUALITY.free).toMatchObject({ height: 720, fps: 30, maxViewers: 25 });
    expect(STREAM_QUALITY.plus).toMatchObject({ height: 1080, fps: 60, maxViewers: 50 });
  });
});

describe("voice schemas", () => {
  it("defaults screenShare to off and needs a channel id", () => {
    expect(VoiceTokenRequest.parse({ channelId: newId() }).screenShare).toBe(false);
    expect(VoiceTokenRequest.safeParse({}).success).toBe(false);
    expect(VoiceTokenRequest.safeParse({ channelId: "general" }).success).toBe(false);
  });

  it("accepts a partial self state update, including an empty one", () => {
    expect(UpdateVoiceStateRequest.safeParse({}).success).toBe(true);
    expect(UpdateVoiceStateRequest.safeParse({ selfMute: true, streaming: false }).success).toBe(true);
    expect(UpdateVoiceStateRequest.safeParse({ selfMute: "yes" }).success).toBe(false);
  });

  it("only accepts random hex participant ids", () => {
    const base = { serverId: newId(), userId: newId(), channelId: newId(), selfMute: false, selfDeaf: false, streaming: false };
    expect(VoiceState.safeParse({ ...base, participantId: "a".repeat(32) }).success).toBe(true);
    expect(VoiceState.safeParse({ ...base, participantId: newId() }).success).toBe(false);
    expect(VoiceState.safeParse({ ...base, channelId: null, participantId: null }).success).toBe(true);
  });
});

describe("VOICE_STATE_UPDATE", () => {
  it("is a gateway event that is not replayed", () => {
    expect(EventPayloads.VOICE_STATE_UPDATE).toBeDefined();
    expect(EPHEMERAL_EVENTS.has("VOICE_STATE_UPDATE")).toBe(true);
  });
});
