import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptWasmClient, deviceIdentity, E2ee } from "../src/lib/e2ee.js";
import { startDmCallGroup } from "../src/voice/call-group.js";
import { deriveCallKey } from "../src/voice/keys.js";
import { FakeDelivery } from "./fake-delivery.js";

const pkg = fileURLToPath(new URL("../../../crates/crypto/pkg/", import.meta.url));
const built = existsSync(pkg + "bastion_crypto_bg.wasm");
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

describe("E2ee as the voice layer's MLS client", () => {
  it("is absent on a client without the calls interface", () => {
    const e2ee = new E2ee({ api: {} as never, userId: "u", deviceId: "d", mls: {} as never });
    expect(() => e2ee.voice()).toThrow("voice_unavailable");
  });

  it("marks call groups so they are never chats", () => {
    const e2ee = new E2ee({ api: {} as never, userId: "u", deviceId: "d", mls: {} as never });
    expect(e2ee.isCallGroup("x")).toBe(false);
    e2ee.markCallGroup("x");
    expect(e2ee.isCallGroup("x")).toBe(true);
  });

  it("saves group state whenever voice changes it", async () => {
    const calls: string[] = [];
    const saves: number[] = [];
    const stub = (name: string) => () => void calls.push(name);
    const voice = {
      inGroup: () => true,
      epoch: () => 1,
      exportSecret: () => new Uint8Array(32),
      updateKeys: () => new Uint8Array(),
      commitAccepted: stub("accepted"),
      commitRejected: stub("rejected"),
      keyPackage: () => new Uint8Array(),
      createGroup: stub("create"),
      addMember: () => ({ commit: new Uint8Array(), welcome: undefined }),
      join: () => {
        calls.push("join");
        return new Uint8Array();
      },
    };
    const e2ee = new E2ee({
      api: {} as never,
      userId: "u",
      deviceId: "d",
      mls: { saveState: () => new Uint8Array([1]), voice } as never,
      persist: async () => void saves.push(saves.length),
    });
    const v = e2ee.voice();
    v.createGroup(new Uint8Array(16));
    v.commitAccepted(new Uint8Array(16));
    v.commitRejected(new Uint8Array(16));
    v.join(new Uint8Array(1));
    await e2ee.flush();
    expect(calls).toEqual(["create", "accepted", "rejected", "join"]);
    expect(saves).toHaveLength(4);
    // Reads do not trigger saves.
    v.epoch(new Uint8Array(16));
    v.exportSecret(new Uint8Array(16), "l", new Uint8Array(), 32);
    await e2ee.flush();
    expect(saves).toHaveLength(4);
  });
});

describe.skipIf(!built)("a DM call group over the real MLS core", () => {
  it("the caller makes it, the callee joins by syncing it, and both derive the same call key", async () => {
    const wasm = await import(/* @vite-ignore */ pkg + "bastion_crypto.js");
    wasm.initSync({ module: readFileSync(pkg + "bastion_crypto_bg.wasm") });
    const server = new FakeDelivery();
    const mk = (userId: string, deviceId: string) => {
      const raw = new wasm.WasmClient(deviceIdentity(userId, deviceId));
      return new E2ee({ api: server.api(userId, deviceId), userId, deviceId, mls: adaptWasmClient(raw), now: () => 1 });
    };
    const alice = mk("alice", "adev");
    const bob = mk("bob", "bdev");
    await alice.publishKeys();
    await bob.publishKeys();

    const api = server.api("alice", "adev");
    const created: string[] = [];
    const group = await startDmCallGroup(
      {
        api,
        mls: alice.voice(),
        sync: (id) => alice.syncGroup(id),
        groupIdOf: (id) => alice.groupIdOf(id),
        onCreated: (id) => {
          created.push(id);
          alice.markCallGroup(id);
        },
      },
      "bob",
    );
    expect(created).toEqual([group.conversationId]);
    expect(alice.isCallGroup(group.conversationId)).toBe(true);

    // Bob has never heard of the group until he syncs it; the welcome in the log puts him in.
    bob.markCallGroup(group.conversationId);
    expect(bob.voice().inGroup(bob.groupIdOf(group.conversationId))).toBe(false);
    await bob.syncGroup(group.conversationId);
    expect(bob.voice().inGroup(bob.groupIdOf(group.conversationId))).toBe(true);

    const gid = alice.groupIdOf(group.conversationId);
    const a = deriveCallKey(alice.voice(), gid, "room-1");
    const b = deriveCallKey(bob.voice(), gid, "room-1");
    expect(hex(a)).toBe(hex(b));
    expect(hex(a)).not.toBe(hex(deriveCallKey(alice.voice(), gid, "room-2")));
    // Call groups hold no chat messages.
    expect(alice.messages(group.conversationId)).toEqual([]);
  });
});
