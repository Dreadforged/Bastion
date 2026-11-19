import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KeyProviderEvent } from "livekit-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/lib/http.js";
import { Call, clampCapture, type CallOptions, type CallRoom } from "../src/voice/call.js";
import { CallGroup, chooseRotator, startDmCallGroup } from "../src/voice/call-group.js";
import { CallKeys, deriveCallKey, VoiceE2eeError, type KeySink, type SwitchMode } from "../src/voice/keys.js";
import { adaptVoiceMls, type RawVoiceClient, type VoiceMls } from "../src/voice/mls.js";
import { MlsKeyProvider } from "../src/voice/provider.js";

const pkg = fileURLToPath(new URL("../../../crates/crypto/pkg/", import.meta.url));
const built = existsSync(pkg + "bastion_crypto_bg.wasm");

const CONV = "voiceconversation0000"; // the id only needs to be stable for the fake
const GROUP = new TextEncoder().encode(CONV);
const groupIdOf = () => GROUP;
const P1 = "0".repeat(31) + "1";
const P2 = "0".repeat(31) + "2";
const P3 = "0".repeat(31) + "3";
const P9 = "0".repeat(31) + "9";
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

interface Dev {
  name: string;
  raw: any;
  mls: VoiceMls;
  cursor: number;
}

/** An in-memory delivery service for one group: one commit per epoch, an ordered log. */
class Hub {
  epoch = 0;
  log: { seq: number; by: string; commit: Uint8Array; welcome?: Uint8Array }[] = [];
  /** Key packages the claim route hands out. */
  packages: { userId: string; deviceId: string; keyPackage: string }[] = [];
  commits = 0;

  api(dev: Dev) {
    return {
      post: async <T,>(path: string, body: any): Promise<T> => {
        if (path === "/conversations") return { id: CONV } as T;
        if (path === "/keys/packages/claim") {
          return { keyPackages: this.packages.map((p) => ({ ...p })), exhausted: [] } as T;
        }
        if (!path.endsWith("/commits")) throw new Error(`unexpected ${path}`);
        if (body.epoch !== this.epoch) throw new ApiError(409, { error: "stale_epoch" } as never);
        this.epoch++;
        this.commits++;
        this.log.push({ seq: this.log.length + 1, by: dev.name, commit: b64(body.commit), ...(body.welcome ? { welcome: b64(body.welcome) } : {}) });
        return { seq: this.log.length, epoch: this.epoch } as T;
      },
    };
  }

  /** Apply everything new to this device, like E2ee.sync does. */
  sync = (dev: Dev) => async () => {
    for (const e of this.log.filter((x) => x.seq > dev.cursor)) {
      dev.cursor = e.seq;
      if (e.by === dev.name) continue;
      // A welcome is for the device that was added; the rest of us apply the commit.
      if (e.welcome && !dev.raw.inGroup(GROUP)) dev.raw.join(e.welcome);
      else dev.raw.receive(GROUP, e.commit).free();
    }
  };
}

describe.skipIf(!built)("voice end-to-end keys over the real MLS core", () => {
  let wasm: any;
  beforeEach(async () => {
    wasm ??= await import(/* @vite-ignore */ pkg + "bastion_crypto.js");
    wasm.initSync({ module: readFileSync(pkg + "bastion_crypto_bg.wasm") });
  });

  /** Alice makes the group and adds everyone else in one commit; all are at the same epoch. */
  function group(names: string[], hub = new Hub()) {
    const devs: Dev[] = names.map((name) => {
      const raw = new wasm.WasmClient(new TextEncoder().encode(name));
      return { name, raw, mls: adaptVoiceMls(raw as RawVoiceClient), cursor: 0 };
    });
    devs[0]!.raw.createGroup(GROUP);
    // Add the others one at a time, as the server would see it; earlier members apply each commit.
    for (let i = 1; i < devs.length; i++) {
      const out = devs[0]!.raw.addMember(GROUP, devs[i]!.raw.keyPackage());
      devs[0]!.raw.commitAccepted(GROUP);
      for (const d of devs.slice(1, i)) d.raw.receive(GROUP, out.commit).free();
      devs[i]!.raw.join(out.welcome);
      out.free();
    }
    hub.epoch = devs[0]!.raw.epoch(GROUP);
    return { devs, hub };
  }

  it("members derive the same key, per room, and it changes with the epoch", async () => {
    const { devs, hub } = group(["alice", "bob"]);
    const [a, b] = devs as [Dev, Dev];
    const k1 = deriveCallKey(a.mls, GROUP, "room-1");
    expect(k1).toHaveLength(32);
    expect(hex(k1)).toBe(hex(deriveCallKey(b.mls, GROUP, "room-1")));
    expect(hex(k1)).not.toBe(hex(deriveCallKey(a.mls, GROUP, "room-2")));

    const g = new CallGroup({ api: hub.api(a), mls: a.mls, sync: hub.sync(a), groupIdOf }, CONV);
    expect(await g.rotate()).toBe("committed");
    await hub.sync(b)();
    const k2 = deriveCallKey(a.mls, GROUP, "room-1");
    expect(hex(k2)).not.toBe(hex(k1));
    expect(hex(k2)).toBe(hex(deriveCallKey(b.mls, GROUP, "room-1")));
  });

  it("refuses a device that is not in the group", () => {
    const stranger = adaptVoiceMls(new wasm.WasmClient(new TextEncoder().encode("eve")));
    expect(() => deriveCallKey(stranger, GROUP, "room")).toThrow(VoiceE2eeError);
  });

  it("a lost commit race still ends with everyone on one new epoch", async () => {
    const { devs, hub } = group(["alice", "bob"]);
    const [a, b] = devs as [Dev, Dev];
    const before = a.mls.epoch(GROUP);
    const bobs = new CallGroup({ api: hub.api(b), mls: b.mls, sync: hub.sync(b), groupIdOf }, CONV);
    const alice = new CallGroup({ api: hub.api(a), mls: a.mls, sync: hub.sync(a), groupIdOf }, CONV);
    // Bob's commit lands first. Alice, still on the old epoch, is rejected and catches up.
    expect(await bobs.rotate()).toBe("committed");
    expect(await alice.rotate()).toBe("someone_else");
    expect(hub.commits).toBe(1);
    expect(a.mls.epoch(GROUP)).toBe(before + 1);
    expect(a.mls.epoch(GROUP)).toBe(b.mls.epoch(GROUP));
    expect(hex(deriveCallKey(a.mls, GROUP, "r"))).toBe(hex(deriveCallKey(b.mls, GROUP, "r")));
  });

  it("a DM call starts a fresh group, the callee joins from the welcome and both derive the call key", async () => {
    const hub = new Hub();
    const mk = (name: string): Dev => {
      const raw = new wasm.WasmClient(new TextEncoder().encode(name));
      return { name, raw, mls: adaptVoiceMls(raw as RawVoiceClient), cursor: 0 };
    };
    const [alice, bob] = [mk("alice"), mk("bob")] as [Dev, Dev];
    hub.packages = [{ userId: "BOB", deviceId: "B1", keyPackage: toB64(bob.raw.keyPackage()) }];
    const deps = { api: hub.api(alice), mls: alice.mls, sync: hub.sync(alice), groupIdOf };
    const callGroup = await startDmCallGroup(deps, "BOB");
    expect(callGroup.conversationId).toBe(CONV);

    const bobs = new CallGroup({ api: hub.api(bob), mls: bob.mls, sync: hub.sync(bob), groupIdOf }, CONV);
    await bobs.ready();
    expect(hex(deriveCallKey(alice.mls, GROUP, "call"))).toBe(hex(deriveCallKey(bob.mls, GROUP, "call")));
    // Bob can rotate too, and Alice follows.
    expect(await bobs.rotate()).toBe("committed");
    await hub.sync(alice)();
    expect(hex(deriveCallKey(alice.mls, GROUP, "call"))).toBe(hex(deriveCallKey(bob.mls, GROUP, "call")));

    // A call with nobody to ring is an error, not an empty group.
    hub.packages = [];
    await expect(startDmCallGroup({ ...deps, mls: mk("zed").mls }, "NOBODY")).rejects.toMatchObject({ code: "key_unavailable" });
  });

  it("a removed member loses the key from the next epoch on", async () => {
    const { devs, hub } = group(["alice", "bob"]);
    const [a, b] = devs as [Dev, Dev];
    const old = hex(deriveCallKey(b.mls, GROUP, "room"));
    const out = a.raw.removeMembers(GROUP, [new TextEncoder().encode("bob")]);
    a.raw.commitAccepted(GROUP);
    expect(b.raw.receive(GROUP, out.commit).kind).toBe("removed");
    out.free();
    expect(() => deriveCallKey(b.mls, GROUP, "room")).toThrow(VoiceE2eeError);
    expect(hex(deriveCallKey(a.mls, GROUP, "room"))).not.toBe(old);
    void hub;
  });

  it("CallKeys installs once per epoch and wipes its copy", async () => {
    const { devs, hub } = group(["alice", "bob"]);
    const [a, b] = devs as [Dev, Dev];
    const seen: { epoch: number; mode: SwitchMode; key: Uint8Array; copy: string }[] = [];
    const sink: KeySink = {
      async install(epoch, key, mode) {
        seen.push({ epoch, mode, key, copy: hex(key) });
      },
    };
    const keys = new CallKeys(b.mls, GROUP, "room", sink);
    expect(await keys.refresh()).toBe(true);
    expect(await keys.refresh()).toBe(false);
    const g = new CallGroup({ api: hub.api(a), mls: a.mls, sync: hub.sync(a), groupIdOf }, CONV);
    await g.rotate();
    await hub.sync(b)();
    expect(await keys.refresh("soon")).toBe(true);
    expect(seen.map((s) => [s.epoch, s.mode])).toEqual([
      [1, "now"],
      [2, "soon"],
    ]);
    expect(seen[0]!.copy).not.toBe(seen[1]!.copy);
    // The derived key bytes are zeroed once handed over.
    expect(hex(seen[0]!.key)).toBe("00".repeat(32));
  });

  describe("a call driven by a fake room", () => {
    interface Sent {
      patches: unknown[];
      deleted: number;
      tokenReq: unknown[];
    }
    class FakeRoom implements CallRoom {
      events: ((e: "joined" | "left", id: string) => void) | null = null;
      remotes: string[] = [];
      log: string[] = [];
      constructor(
        readonly localId: string,
        private readonly sink: { installed: number[] },
      ) {}
      remoteIds() {
        return [...this.remotes];
      }
      async enableEncryption() {
        this.log.push(`encrypt(keys=${this.sink.installed.length})`);
      }
      async connect() {
        this.log.push(`connect(keys=${this.sink.installed.length})`);
      }
      async publishMicrophone() {
        this.log.push("mic");
      }
      async startScreenShare(c: unknown) {
        this.log.push(`share ${JSON.stringify(c)}`);
      }
      async stopScreenShare() {
        this.log.push("unshare");
      }
      onParticipant(h: (e: "joined" | "left", id: string) => void) {
        this.events = h;
      }
      async disconnect() {
        this.log.push("disconnect");
      }
    }

    function join(
      dev: Dev,
      hub: Hub,
      id: string,
      over: Partial<CallOptions> & { canShare?: boolean; canPublish?: boolean } = {},
    ) {
      const sent: Sent = { patches: [], deleted: 0, tokenReq: [] };
      const installed: number[] = [];
      const room = new FakeRoom(id, { installed });
      const sink: KeySink & { dispose?(): void } = {
        async install(epoch) {
          installed.push(epoch);
        },
      };
      const hubApi = hub.api(dev);
      const api = {
        post: async (path: string, body: any) => {
          if (path.endsWith("/voice/token")) {
            sent.tokenReq.push(body);
            return {
              url: "wss://lk.invalid",
              token: "t",
              expiresAt: 1,
              roomId: "a".repeat(32),
              participantId: id,
              canPublish: over.canPublish ?? true,
              canShare: over.canShare ?? false,
              quality: { height: 720, fps: 30, maxViewers: 25, maxBitrate: 2_500_000 },
            };
          }
          return hubApi.post(path, body);
        },
        patch: async (_p: string, body: unknown) => void sent.patches.push(body),
        delete: async () => void (sent.deleted += 1),
      } as unknown as CallOptions["api"];
      const call = new Call({
        api,
        group: { api: { post: hubApi.post } as never, mls: dev.mls, sync: hub.sync(dev), groupIdOf },
        conversationId: CONV,
        serverId: "S",
        channelId: "C",
        createRoom: () => room,
        createSink: () => sink,
        e2eeSupported: () => true,
        rotationFallbackMs: 1000,
        leaseMs: 30_000,
        ...over,
      });
      return { call, room, sent, installed };
    }

    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("installs the key before connecting, and publishes only after", async () => {
      const { devs, hub } = group(["alice", "bob"]);
      const { call, room, sent } = join(devs[0]!, hub, P1);
      await call.join();
      expect(room.log).toEqual(["encrypt(keys=1)", "connect(keys=1)", "mic"]);
      expect(call.encryption).toBe("e2ee");
      expect(sent.tokenReq).toEqual([{ channelId: "C", screenShare: false }]);
    });

    it("rotates on join with one designated device, and everyone re-keys", async () => {
      const { devs, hub } = group(["alice", "bob", "carol"]);
      const a = join(devs[0]!, hub, P1);
      const b = join(devs[1]!, hub, P2);
      await a.call.join();
      await b.call.join();
      a.room.remotes = [P2];
      b.room.remotes = [P1];
      const e0 = devs[0]!.mls.epoch(GROUP);
      expect(a.installed).toEqual([e0]);

      // Carol joins the room: the lowest of the others (p1) rotates, p2 waits.
      a.room.remotes = [P2, P3];
      b.room.remotes = [P1, P3];
      const before = hub.commits;
      a.room.events!("joined", P3);
      b.room.events!("joined", P3);
      await vi.advanceTimersByTimeAsync(0);
      expect(hub.commits).toBe(before + 1);
      expect(hub.log.at(-1)!.by).toBe("alice");
      expect(a.installed).toEqual([e0, e0 + 1]);

      // Bob hears about it from the gateway and re-keys.
      await b.call.handleConversationUpdate(CONV);
      expect(b.installed).toEqual([e0, e0 + 1]);
      expect(hex(deriveCallKey(a.call["o"].group.mls, GROUP, "r"))).toBe(hex(deriveCallKey(devs[1]!.mls, GROUP, "r")));

      // The back-up timer sees the epoch already moved and does nothing more.
      await vi.advanceTimersByTimeAsync(5000);
      expect(hub.commits).toBe(before + 1);
      await a.call.leave();
      await b.call.leave();
    });

    it("the next device rotates if the designated one never does", async () => {
      const { devs, hub } = group(["alice", "bob", "carol"]);
      const b = join(devs[1]!, hub, P2);
      await b.call.join();
      const e0 = devs[1]!.mls.epoch(GROUP);
      b.room.remotes = [P1, P3];
      const before = hub.commits;
      // p1 is the designated rotator but is gone (crashed); a participant left.
      b.room.events!("left", P9);
      await vi.advanceTimersByTimeAsync(500);
      expect(hub.commits).toBe(before);
      await vi.advanceTimersByTimeAsync(1500);
      expect(hub.commits).toBe(before + 1);
      expect(b.installed).toEqual([e0, e0 + 1]);
      await b.call.leave();
    });

    it("the person who joined does not rotate for their own join", async () => {
      const { devs, hub } = group(["alice", "bob"]);
      const a = join(devs[0]!, hub, P1);
      await a.call.join();
      a.room.remotes = [P2];
      const before = hub.commits;
      a.room.events!("left", P1); // nonsense for the local id, must not rotate
      await vi.advanceTimersByTimeAsync(5000);
      expect(hub.commits).toBe(before);
      await a.call.leave();
    });

    it("leaving drops keys, stops renewals and releases the lease", async () => {
      const { devs, hub } = group(["alice", "bob"]);
      const a = join(devs[0]!, hub, P1);
      await a.call.join();
      const e0 = devs[0]!.mls.epoch(GROUP);
      await vi.advanceTimersByTimeAsync(65_000);
      expect(a.sent.patches).toHaveLength(2);
      await a.call.leave();
      await a.call.leave();
      expect(a.sent.deleted).toBe(1);
      expect(a.room.log.at(-1)).toBe("disconnect");
      await vi.advanceTimersByTimeAsync(65_000);
      expect(a.sent.patches).toHaveLength(2);
      // After leaving, gateway updates no longer install keys.
      await a.call.handleConversationUpdate(CONV);
      expect(a.installed).toEqual([e0]);
    });

    it("refuses to join unencrypted unless told to, and says so when it does", async () => {
      const { devs, hub } = group(["alice", "bob"]);
      const refused = join(devs[0]!, hub, P1, { e2eeSupported: () => false });
      await expect(refused.call.join()).rejects.toMatchObject({ code: "unsupported_browser" });
      expect(refused.room.log).toEqual([]);

      const stranger = new wasm.WasmClient(new TextEncoder().encode("eve"));
      const eve: Dev = { name: "eve", raw: stranger, mls: adaptVoiceMls(stranger), cursor: 0 };
      const notIn = join(eve, hub, P9);
      await expect(notIn.call.join()).rejects.toMatchObject({ code: "not_in_group" });
      // The failed join gave the voice state back.
      expect(notIn.sent.deleted).toBe(1);
      expect(notIn.room.log).toEqual([]);

      const agreed = join(eve, hub, P9, { allowTransportOnly: true });
      await agreed.call.join();
      expect(agreed.call.encryption).toBe("transport");
      expect(agreed.room.log).toEqual(["connect(keys=0)", "mic"]);
    });

    it("screen share only with a grant, never above the granted quality", async () => {
      const { devs, hub } = group(["alice", "bob"]);
      const denied = join(devs[0]!, hub, P1);
      await denied.call.join();
      await expect(denied.call.startScreenShare()).rejects.toMatchObject({ code: "not_allowed" });
      expect(denied.room.log.some((l) => l.startsWith("share"))).toBe(false);

      const ok = join(devs[1]!, hub, P2, { canShare: true, screenShare: true });
      await ok.call.join();
      await ok.call.startScreenShare({ height: 1080, fps: 60 });
      expect(ok.room.log.at(-1)).toBe('share {"height":720,"width":1280,"fps":30,"maxBitrate":2500000}');
      expect(ok.sent.patches.at(-1)).toEqual({ streaming: true });
      await ok.call.stopScreenShare();
      expect(ok.sent.patches.at(-1)).toEqual({ streaming: false });
    });
  });
});

describe("pure helpers", () => {
  it("chooseRotator picks the lowest other participant, never the changed one", () => {
    expect(chooseRotator(["c", "a", "b"], "a")).toBe("b");
    expect(chooseRotator(["c", "a", "b"], "c")).toBe("a");
    expect(chooseRotator(["a"], "a")).toBeNull();
    expect(chooseRotator([], "a")).toBeNull();
  });

  it("clampCapture follows the plan and never exceeds it", () => {
    const free = { height: 720, fps: 30, maxViewers: 25, maxBitrate: 2_500_000 };
    const plus = { height: 1080, fps: 60, maxViewers: 50, maxBitrate: 6_000_000 };
    expect(clampCapture(free)).toEqual({ height: 720, width: 1280, fps: 30, maxBitrate: 2_500_000 });
    expect(clampCapture(free, { height: 1080, fps: 60 })).toEqual({ height: 720, width: 1280, fps: 30, maxBitrate: 2_500_000 });
    expect(clampCapture(plus, { height: 1080, fps: 60 })).toEqual({ height: 1080, width: 1920, fps: 60, maxBitrate: 6_000_000 });
    expect(clampCapture(plus, { height: 480, fps: 15 })).toMatchObject({ height: 480, fps: 15 });
  });
});

describe("MlsKeyProvider", () => {
  afterEach(() => vi.useRealTimers());

  function watch(p: MlsKeyProvider) {
    const sets: { index: number | undefined; current: boolean }[] = [];
    p.on(KeyProviderEvent.SetKey, (info: any, current: boolean) => sets.push({ index: info.keyIndex, current }));
    return sets;
  }

  it("uses the first key at once, and later ones for receiving first, sending after the delay", async () => {
    vi.useFakeTimers();
    const p = new MlsKeyProvider(500);
    const sets = watch(p);
    await p.install(3, new Uint8Array(32).fill(1), "now");
    expect(sets).toEqual([{ index: 3, current: true }]);

    await p.install(4, new Uint8Array(32).fill(2), "soon");
    expect(sets.at(-1)).toEqual({ index: 4, current: false });
    expect(p.getLatestManuallySetKeyIndex()).toBe(3);
    await vi.advanceTimersByTimeAsync(500);
    expect(sets.at(-1)).toEqual({ index: 4, current: true });
    expect(p.getLatestManuallySetKeyIndex()).toBe(4);
  });

  it("a newer epoch cancels a pending switch, and slots wrap at the ring size", async () => {
    vi.useFakeTimers();
    const p = new MlsKeyProvider(500);
    const sets = watch(p);
    await p.install(1, new Uint8Array(32), "now");
    await p.install(2, new Uint8Array(32), "soon");
    await p.install(17, new Uint8Array(32), "soon"); // ring of 16: slot 1
    await vi.advanceTimersByTimeAsync(1000);
    expect(sets.filter((s) => s.current).map((s) => s.index)).toEqual([1, 1]);
    expect(p.getKeys().at(-1)!.keyIndex).toBe(1);
  });

  it("never ratchets or distrusts a key on its own", () => {
    const o = new MlsKeyProvider().getOptions();
    expect(o).toMatchObject({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 });
  });
});
