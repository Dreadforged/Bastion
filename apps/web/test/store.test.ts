import { describe, expect, it } from "vitest";
import { applyEvent, applyReady, emptyState, mergeHistory, sortedChannels, typingUsers, upsertMessage } from "../src/lib/store.js";

const U = "01HZZZZZZZZZZZZZZZZZZZZZZ1";
const OTHER = "01HZZZZZZZZZZZZZZZZZZZZZZ2";
const S = "01HZZZZZZZZZZZZZZZZZZZZZS1";
const C1 = "01HZZZZZZZZZZZZZZZZZZZZZC1";
const C2 = "01HZZZZZZZZZZZZZZZZZZZZZC2";
const mid = (n: number) => `01HZZZZZZZZZZZZZZZZZZZZM${String(n).padStart(2, "0")}`;

const channel = (id: string, position: number, kind: "text" | "voice" = "text") => ({
  id, serverId: S, name: id.slice(-2), kind, position, overrides: [], slowModeSeconds: 0, ageRestricted: false,
});
const member = (userId: string) => ({ serverId: S, userId, nick: null, roles: [], joinedAt: 1, timeoutUntil: null });
const message = (n: number, channelId = C1) => ({
  id: mid(n), serverId: S, channelId, authorId: U, ciphertext: "AAAA", epoch: 0, createdAt: n, editedAt: null,
});

const snapshot = () => ({
  server: { id: S, name: "Home", ownerId: U },
  roles: [{ id: S, serverId: S, name: "@everyone", permissions: "3", position: 0 }],
  channels: [channel(C1, 1), channel(C2, 0)],
  members: [member(U), member(OTHER)],
  presences: [{ userId: OTHER, status: "online" as const }],
  voiceStates: [],
});

const ready = () => applyReady(emptyState, { userId: U, seq: 1, servers: [snapshot()] });

describe("store", () => {
  it("builds state from READY", () => {
    const s = ready();
    expect(s.userId).toBe(U);
    expect(Object.keys(s.servers[S]!.channels)).toHaveLength(2);
    expect(s.servers[S]!.presences[OTHER]).toBe("online");
    expect(sortedChannels(s.servers[S]!, "text").map((c) => c.id)).toEqual([C2, C1]);
  });

  it("keeps history across READY but drops channels that went away", () => {
    let s = ready();
    s = mergeHistory(s, C1, [message(1)]);
    s = mergeHistory(s, "01HZZZZZZZZZZZZZZZZZZZGONE", [message(2, "01HZZZZZZZZZZZZZZZZZZZGONE")]);
    s = applyReady(s, { userId: U, seq: 9, servers: [snapshot()] });
    expect(s.messages[C1]).toHaveLength(1);
    expect(s.messages["01HZZZZZZZZZZZZZZZZZZZGONE"]).toBeUndefined();
  });

  it("keeps messages in id order and treats repeats as upserts", () => {
    let list = upsertMessage([], message(3));
    list = upsertMessage(list, message(1));
    list = upsertMessage(list, message(2));
    expect(list.map((m) => m.id)).toEqual([mid(1), mid(2), mid(3)]);
    const edited = { ...message(2), editedAt: 99 };
    list = upsertMessage(list, edited);
    expect(list).toHaveLength(3);
    expect(list[1]!.editedAt).toBe(99);
  });

  it("applies message create, update and delete", () => {
    let s = ready();
    s = applyEvent(s, "MESSAGE_CREATE", message(1));
    s = applyEvent(s, "MESSAGE_CREATE", message(1));
    expect(s.messages[C1]).toHaveLength(1);
    s = applyEvent(s, "MESSAGE_UPDATE", { ...message(1), editedAt: 5 });
    expect(s.messages[C1]![0]!.editedAt).toBe(5);
    s = applyEvent(s, "MESSAGE_DELETE", { id: mid(1), channelId: C1, serverId: S });
    expect(s.messages[C1]).toEqual([]);
  });

  it("handles channels, members and presence", () => {
    let s = ready();
    s = applyEvent(s, "CHANNEL_CREATE", channel("01HZZZZZZZZZZZZZZZZZZZZZC3", 2));
    expect(Object.keys(s.servers[S]!.channels)).toHaveLength(3);
    s = applyEvent(s, "PRESENCE_UPDATE", { serverId: S, userId: OTHER, status: "dnd" });
    expect(s.servers[S]!.presences[OTHER]).toBe("dnd");
    s = applyEvent(s, "MEMBER_REMOVE", { serverId: S, userId: OTHER });
    expect(s.servers[S]!.members[OTHER]).toBeUndefined();
    expect(s.servers[S]!.presences[OTHER]).toBeUndefined();
  });

  it("drops a channel's messages when the channel is deleted", () => {
    let s = mergeHistory(ready(), C1, [message(1)]);
    s = applyEvent(s, "CHANNEL_DELETE", { id: C1, serverId: S });
    expect(s.servers[S]!.channels[C1]).toBeUndefined();
    expect(s.messages[C1]).toBeUndefined();
  });

  it("removes the whole server when we are the member removed", () => {
    let s = mergeHistory(ready(), C1, [message(1)]);
    s = applyEvent(s, "MEMBER_REMOVE", { serverId: S, userId: U });
    expect(s.servers[S]).toBeUndefined();
    expect(s.messages[C1]).toBeUndefined();
  });

  it("tracks voice joins and leaves", () => {
    const base = { serverId: S, userId: OTHER, selfMute: false, selfDeaf: false, streaming: false };
    let s = applyEvent(ready(), "VOICE_STATE_UPDATE", { ...base, channelId: C2, participantId: "a".repeat(32) });
    expect(s.servers[S]!.voice[OTHER]!.channelId).toBe(C2);
    s = applyEvent(s, "VOICE_STATE_UPDATE", { ...base, channelId: null, participantId: null });
    expect(s.servers[S]!.voice[OTHER]).toBeUndefined();
  });

  it("shows typing for a few seconds, never for ourselves", () => {
    let s = ready();
    s = applyEvent(s, "TYPING_START", { serverId: S, channelId: C1, userId: OTHER, at: 1000 });
    s = applyEvent(s, "TYPING_START", { serverId: S, channelId: C1, userId: U, at: 1000 });
    expect(typingUsers(s, C1, 2000)).toEqual([OTHER]);
    expect(typingUsers(s, C1, 20_000)).toEqual([]);
  });

  it("ignores malformed and unknown events", () => {
    const s = ready();
    expect(applyEvent(s, "MESSAGE_CREATE", { nope: true })).toBe(s);
    expect(applyEvent(s, "FUTURE_EVENT" as never, {})).toBe(s);
  });

  it("records conversation updates by highest seq", () => {
    let s = applyEvent(ready(), "CONVERSATION_UPDATE", { conversationId: "c".repeat(22), seq: 5 });
    s = applyEvent(s, "CONVERSATION_UPDATE", { conversationId: "c".repeat(22), seq: 3 });
    expect(s.conversationSeq["c".repeat(22)]).toBe(5);
  });
});

describe("CALL_UPDATE", () => {
  const call = {
    id: "d".repeat(32),
    conversationId: "D".repeat(22),
    callerId: "0".repeat(24) + "A1",
    calleeId: "0".repeat(24) + "B1",
    groupConversationId: "G".repeat(22),
    state: "ringing" as const,
    endReason: null,
    ringExpiresAt: 2,
    createdAt: 1,
  };

  it("tracks a live call by DM and drops it when it ends", () => {
    let s = applyEvent(emptyState, "CALL_UPDATE", call);
    expect(s.calls[call.conversationId]?.state).toBe("ringing");
    s = applyEvent(s, "CALL_UPDATE", { ...call, state: "active" });
    expect(s.calls[call.conversationId]?.state).toBe("active");
    s = applyEvent(s, "CALL_UPDATE", { ...call, state: "ended", endReason: "declined" });
    expect(s.calls).toEqual({});
  });

  it("ignores a malformed event", () => {
    expect(applyEvent(emptyState, "CALL_UPDATE", { ...call, id: "nope" })).toBe(emptyState);
  });
});
