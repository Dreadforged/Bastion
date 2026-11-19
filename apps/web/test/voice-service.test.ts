import { schemas } from "@bastion/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/http.js";
import type { CallRoom } from "../src/voice/call.js";
import type { VoiceMls } from "../src/voice/mls.js";
import { VoiceService, type VoiceUi } from "../src/voice/service.js";

const ME = "0".repeat(24) + "M1";
const PEER = "0".repeat(24) + "P1";
const SERVER = "S1";
const CHANNEL = "C1";
const DM = "D".repeat(22);
const GROUP = "G".repeat(22);
const CHAN_CONV = "H".repeat(22);
const ROOM = "a".repeat(32);

class FakeRoom implements CallRoom {
  localId = "b".repeat(32);
  log: string[] = [];
  disconnected: (() => void) | null = null;
  remoteIds() {
    return [];
  }
  async enableEncryption() {
    this.log.push("encrypt");
  }
  async connect() {
    this.log.push("connect");
  }
  async publishMicrophone() {
    this.log.push("mic");
  }
  async setMicrophoneEnabled(on: boolean) {
    this.log.push(on ? "unmute" : "mute");
  }
  async startScreenShare(c: { height: number; fps: number }) {
    this.log.push(`share ${c.height}p${c.fps}`);
  }
  async stopScreenShare() {
    this.log.push("unshare");
  }
  onParticipant() {}
  onDisconnected(h: () => void) {
    this.disconnected = h;
  }
  async disconnect() {
    this.log.push("disconnect");
  }
}

interface Req {
  method: string;
  path: string;
  body?: unknown;
}

function setup(opts: { plan?: "free" | "plus"; channelOpen?: boolean; canShare?: boolean } = {}) {
  const requests: Req[] = [];
  const events: string[] = [];
  const uis: (VoiceUi | null)[] = [];
  const notices: string[] = [];
  const rooms: FakeRoom[] = [];
  const marked: string[] = [];
  let channelConv: string | undefined = opts.channelOpen === false ? undefined : CHAN_CONV;
  const quality = opts.plan === "plus" ? schemas.STREAM_QUALITY.plus : schemas.STREAM_QUALITY.free;

  const token = (screenShare: boolean) => ({
    url: "wss://lk.invalid",
    token: "t",
    expiresAt: 1,
    roomId: ROOM,
    participantId: "c".repeat(32),
    canPublish: true,
    canShare: screenShare && (opts.canShare ?? true),
    quality,
  });

  const reply = (method: string, path: string, body: any): unknown => {
    if (path === `/servers/${SERVER}/voice/token`) return token(body.screenShare);
    if (path === `/conversations/${DM}/call` && method === "POST") return { ...token(body.screenShare), call: call({ callerId: ME, calleeId: PEER }) };
    if (path === `/conversations/${DM}/call/accept`) return { ...token(body.screenShare), call: call({ state: "active" }) };
    if (path === "/conversations" && method === "POST") return { id: GROUP };
    if (path === "/keys/packages/claim") return { keyPackages: [{ userId: PEER, deviceId: "peerdev", keyPackage: btoa("kp") }], exhausted: [] };
    return null;
  };

  const api = {
    post: async (path: string, body?: unknown) => {
      requests.push({ method: "POST", path, body });
      events.push(`POST ${path}`);
      return reply("POST", path, body) as never;
    },
    patch: async (path: string, body?: unknown) => {
      requests.push({ method: "PATCH", path, body });
      return null as never;
    },
    delete: async (path: string) => {
      requests.push({ method: "DELETE", path });
      events.push(`DELETE ${path}`);
      return null as never;
    },
  };

  const groups = new Set<string>([CHAN_CONV]);
  const mls: VoiceMls = {
    inGroup: (g) => groups.has(new TextDecoder().decode(g)),
    epoch: () => 3,
    exportSecret: () => new Uint8Array(32).fill(7),
    updateKeys: () => new Uint8Array([1]),
    commitAccepted: () => {},
    commitRejected: () => {},
    keyPackage: () => new Uint8Array([2]),
    createGroup: (g) => void groups.add(new TextDecoder().decode(g)),
    addMember: () => ({ commit: new Uint8Array([3]), welcome: new Uint8Array([4]) }),
    join: () => new Uint8Array(),
  };

  const svc = new VoiceService(
    {
      api,
      mls: () => mls,
      sync: async (id) => {
        events.push(`sync ${id}`);
        // Answering: the welcome in the call group puts this device in it.
        if (id === GROUP) groups.add(id);
      },
      groupIdOf: (id) => new TextEncoder().encode(id),
      channelConversation: () => channelConv,
      openChannel: async () => {
        events.push("openChannel");
        channelConv = CHAN_CONV;
      },
      openDm: async () => DM,
      markCallGroup: (id) => {
        marked.push(id);
        events.push(`mark ${id}`);
      },
      room: {
        createRoom: () => {
          const r = new FakeRoom();
          rooms.push(r);
          return r;
        },
        createSink: () => ({ install: async () => {} }),
        e2eeSupported: () => true,
      },
      onChange: (ui) => uis.push(ui),
      onNotice: (code) => notices.push(code),
      callOptions: { leaseMs: 30_000 },
    },
    () => ME,
  );
  return { svc, requests, events, uis, notices, rooms, marked };
}

const call = (over: Partial<schemas.DmCall> = {}): schemas.DmCall => ({
  id: "d".repeat(32),
  conversationId: DM,
  callerId: PEER,
  calleeId: ME,
  groupConversationId: GROUP,
  state: "ringing",
  endReason: null,
  ringExpiresAt: Date.now() + 40_000,
  createdAt: Date.now(),
  ...over,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("voice channels", () => {
  it("joins, shows encryption and screen share tiers, mutes and leaves", async () => {
    const t = setup();
    await t.svc.joinChannel(SERVER, CHANNEL, true);
    const ui = t.svc.ui!;
    expect(ui).toMatchObject({ kind: "channel", phase: "connected", encryption: "e2ee", canShare: true, muted: false, sharing: false });
    expect(ui.tiers.map((x) => x.label)).toEqual(["480p 30", "720p 30"]);
    expect(t.requests[0]).toEqual({ method: "POST", path: `/servers/${SERVER}/voice/token`, body: { channelId: CHANNEL, screenShare: true } });

    await t.svc.setMuted(true);
    expect(t.svc.ui!.muted).toBe(true);
    expect(t.rooms[0]!.log).toContain("mute");
    expect(t.requests.at(-1)).toEqual({ method: "PATCH", path: `/servers/${SERVER}/voice`, body: { selfMute: true } });

    await t.svc.startShare(ui.tiers[0]);
    expect(t.svc.ui!.sharing).toBe(true);
    expect(t.rooms[0]!.log.at(-1)).toBe("share 480p30");
    await t.svc.stopShare();
    expect(t.svc.ui!.sharing).toBe(false);

    await t.svc.leave();
    expect(t.svc.ui).toBeNull();
    expect(t.uis.at(-1)).toBeNull();
    expect(t.requests.at(-1)).toEqual({ method: "DELETE", path: `/servers/${SERVER}/voice` });
  });

  it("offers every tier up to 1080p60 on plus, and none without the STREAM permission", async () => {
    const plus = setup({ plan: "plus" });
    await plus.svc.joinChannel(SERVER, CHANNEL, true);
    expect(plus.svc.ui!.tiers.at(-1)!.label).toBe("1080p 60");
    await plus.svc.leave();

    const none = setup({ canShare: false });
    await none.svc.joinChannel(SERVER, CHANNEL, false);
    expect(none.svc.ui).toMatchObject({ canShare: false, tiers: [] });
    expect(none.requests[0]!.body).toEqual({ channelId: CHANNEL, screenShare: false });
  });

  it("opens the channel's encryption first when this device has not", async () => {
    const t = setup({ channelOpen: false });
    await t.svc.joinChannel(SERVER, CHANNEL, false);
    expect(t.events[0]).toBe("openChannel");
    expect(t.svc.ui!.phase).toBe("connected");
  });

  it("refuses a second call, and gives the voice state back if joining fails", async () => {
    const t = setup();
    await t.svc.joinChannel(SERVER, CHANNEL, false);
    await expect(t.svc.joinChannel(SERVER, "C2", false)).rejects.toMatchObject({ message: "already_in_call" });
    await expect(t.svc.startDmCall(PEER)).rejects.toMatchObject({ message: "already_in_call" });
    await t.svc.leave();

    // A device that is not in the group cannot join, and nothing is left behind.
    const b = setup();
    (b.svc as unknown as { d: { channelConversation: () => string } }).d.channelConversation = () => "N".repeat(22);
    await expect(b.svc.joinChannel(SERVER, CHANNEL, false)).rejects.toMatchObject({ code: "not_in_group" });
    expect(b.svc.ui).toBeNull();
    expect(b.requests.at(-1)).toEqual({ method: "DELETE", path: `/servers/${SERVER}/voice` });
  });

  it("clears the call and says so when the room drops", async () => {
    const t = setup();
    await t.svc.joinChannel(SERVER, CHANNEL, false);
    t.rooms[0]!.disconnected!();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.svc.ui).toBeNull();
    expect(t.notices).toContain("call_dropped");
  });
});

describe("outgoing DM calls", () => {
  it("makes a fresh call group, marks it, then rings with that group", async () => {
    const t = setup();
    await t.svc.startDmCall(PEER);
    expect(t.marked).toEqual([GROUP]);
    // The group is marked before any commit goes to it.
    const markAt = t.events.indexOf(`mark ${GROUP}`);
    expect(markAt).toBeGreaterThan(-1);
    const ring = t.requests.find((r) => r.path === `/conversations/${DM}/call`)!;
    expect(ring.body).toEqual({ groupConversationId: GROUP, screenShare: true });
    expect(t.requests.findIndex((r) => r === ring)).toBeGreaterThan(t.requests.findIndex((r) => r.path === `/conversations/${GROUP}/commits`));
    expect(t.svc.ui).toMatchObject({ kind: "dm", phase: "calling", peerId: PEER, conversationId: DM, encryption: "e2ee" });
  });

  it("becomes connected when the other person answers", async () => {
    const t = setup();
    await t.svc.startDmCall(PEER);
    const ringing = call({ callerId: ME, calleeId: PEER });
    t.svc.handleCallUpdate({ ...ringing, state: "active" });
    expect(t.svc.ui!.phase).toBe("connected");
    // The ring timer is gone: nothing hangs up later.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(t.svc.ui!.phase).toBe("connected");
  });

  it("hangs up on its own when nobody answers", async () => {
    const t = setup();
    await t.svc.startDmCall(PEER);
    await vi.advanceTimersByTimeAsync(schemas.CALL_LIMITS.ringSeconds * 1000 + 1500);
    expect(t.svc.ui).toBeNull();
    expect(t.notices).toContain("no_answer");
    expect(t.requests.at(-1)).toEqual({ method: "DELETE", path: `/conversations/${DM}/call` });
  });

  it("stops when the other person declines", async () => {
    const t = setup();
    await t.svc.startDmCall(PEER);
    const mine = call({ callerId: ME, calleeId: PEER });
    t.svc.handleCallUpdate({ ...mine, state: "ended", endReason: "declined" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.svc.ui).toBeNull();
    expect(t.notices).toContain("call_declined");
  });

  it("cancelling is leaving", async () => {
    const t = setup();
    await t.svc.startDmCall(PEER);
    await t.svc.leave();
    expect(t.svc.ui).toBeNull();
    expect(t.requests.at(-1)).toEqual({ method: "DELETE", path: `/conversations/${DM}/call` });
  });
});

describe("incoming DM calls", () => {
  it("lists a ring for this person, newest first, and ignores other people's calls", () => {
    const t = setup();
    t.svc.handleCallUpdate(call());
    t.svc.handleCallUpdate(call({ id: "e".repeat(32), conversationId: "O".repeat(22), callerId: "0".repeat(24) + "X1", calleeId: "0".repeat(24) + "Y1" }));
    expect(t.svc.ringing().map((c) => c.conversationId)).toEqual([DM]);
  });

  it("does not ring while in a call, or for a ring that already ran out", async () => {
    const t = setup();
    t.svc.handleCallUpdate(call({ ringExpiresAt: Date.now() - 1 }));
    expect(t.svc.ringing()).toEqual([]);
    await t.svc.joinChannel(SERVER, CHANNEL, false);
    t.svc.handleCallUpdate(call());
    expect(t.svc.ringing()).toEqual([]);
  });

  it("stops ringing when it ends or is answered elsewhere", () => {
    const t = setup();
    t.svc.handleCallUpdate(call());
    t.svc.handleCallUpdate(call({ state: "active" }));
    expect(t.svc.ringing()).toEqual([]);
  });

  it("a ring lapses with time", () => {
    const t = setup();
    t.svc.handleCallUpdate(call({ ringExpiresAt: Date.now() + 5000 }));
    expect(t.svc.ringing()).toHaveLength(1);
    vi.advanceTimersByTime(6000);
    expect(t.svc.ringing()).toEqual([]);
  });

  it("answering marks the key group, answers, syncs the group and connects", async () => {
    const t = setup();
    const ring = call();
    t.svc.handleCallUpdate(ring);
    await t.svc.answer(ring);
    expect(t.marked).toEqual([GROUP]);
    expect(t.events.indexOf(`mark ${GROUP}`)).toBeLessThan(t.events.indexOf(`sync ${GROUP}`));
    expect(t.requests.some((r) => r.path === `/conversations/${DM}/call/accept`)).toBe(true);
    expect(t.svc.ui).toMatchObject({ kind: "dm", phase: "connected", peerId: PEER, encryption: "e2ee" });
    expect(t.svc.ringing()).toEqual([]);

    // The caller hanging up ends it here too.
    t.svc.handleCallUpdate({ ...ring, state: "ended", endReason: "ended" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.svc.ui).toBeNull();
    expect(t.notices).toContain("call_ended");
  });

  it("declining tells the server, and an already-over call is not an error", async () => {
    const t = setup();
    const ring = call();
    t.svc.handleCallUpdate(ring);
    await t.svc.decline(ring);
    expect(t.requests.at(-1)).toEqual({ method: "POST", path: `/conversations/${DM}/call/decline`, body: undefined });
    expect(t.svc.ringing()).toEqual([]);

    const gone = setup();
    (gone.svc as unknown as { d: { api: { post: () => Promise<never> } } }).d.api.post = async () => {
      throw new ApiError(409, "call_not_ringing", { error: "call_not_ringing" });
    };
    await expect(gone.svc.decline(ring)).resolves.toBeUndefined();
  });

  it("sign-out drops the call and any rings without calling the server", async () => {
    const t = setup();
    await t.svc.joinChannel(SERVER, CHANNEL, false);
    const before = t.requests.length;
    await t.svc.reset();
    expect(t.svc.ui).toBeNull();
    expect(t.requests.slice(before).every((r) => r.method === "DELETE")).toBe(true);
  });
});
