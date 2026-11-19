import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeBundle, adaptWasmClient, deviceIdentity, E2ee, type PersistedMeta } from "../src/lib/e2ee.js";
import { ApiError, type Api } from "../src/lib/http.js";
import { FakeDelivery } from "./fake-delivery.js";

const pkg = fileURLToPath(new URL("../../../crates/crypto/pkg/", import.meta.url));
const built = existsSync(pkg + "bastion_crypto_bg.wasm");

describe.skipIf(!built)("E2ee persistence, removal and rollback", () => {
  async function setup() {
    const wasm = await import(/* @vite-ignore */ pkg + "bastion_crypto.js");
    wasm.initSync({ module: readFileSync(pkg + "bastion_crypto_bg.wasm") });
    const server = new FakeDelivery();
    /** Bytes each device would have in storage. */
    const disk = new Map<string, Uint8Array>();
    const events: string[] = [];

    function make(userId: string, deviceId: string, opts: { api?: (real: Api) => Api } = {}) {
      const saved = disk.get(deviceId);
      const bundle = saved ? decodeBundle(saved) : null;
      const raw = bundle ? wasm.WasmClient.loadState(bundle.mls) : new wasm.WasmClient(deviceIdentity(userId, deviceId));
      const real = server.api(userId, deviceId);
      return new E2ee({
        api: opts.api ? opts.api(real) : real,
        userId,
        deviceId,
        mls: adaptWasmClient(raw),
        now: () => 1,
        ...(bundle ? { restored: bundle.meta as PersistedMeta } : {}),
        persist: async (b) => {
          events.push(`save:${deviceId}`);
          disk.set(deviceId, b);
        },
      });
    }
    return { server, make, disk, events };
  }

  it("a reloaded device keeps its conversations, log and ability to send and receive", async () => {
    const { make, server, disk } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();
    const conv = await alice.openDm("BOB");
    await alice.send(conv.id, "before reload");
    await bob.openDm("ALICE");
    await bob.sync(conv.id);
    await bob.send(conv.id, "bob before");
    await alice.sync(conv.id);
    await alice.flush();
    await bob.flush();

    // Both tabs reload: new objects built only from what was stored.
    const alice2 = make("ALICE", "A1");
    const bob2 = make("BOB", "B1");
    expect(alice2.messages(conv.id).map((m) => m.payload.text)).toEqual(["before reload", "bob before"]);

    await alice2.send(conv.id, "after reload");
    await bob2.sync(conv.id);
    expect(bob2.messages(conv.id).map((m) => m.payload.text)).toEqual(["before reload", "bob before", "after reload"]);
    await bob2.send(conv.id, "bob after");
    await alice2.sync(conv.id);
    expect(alice2.messages(conv.id).map((m) => m.payload.text)).toEqual(["before reload", "bob before", "after reload", "bob after"]);

    // Opening the DM again after a reload must not start a second group.
    await alice2.openDm("BOB");
    expect(server.convs.size).toBe(1);
    expect(disk.size).toBe(2);
  });

  it("does not replay old envelopes after a reload", async () => {
    const { make } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();
    const conv = await alice.openDm("BOB");
    await alice.send(conv.id, "one");
    await bob.openDm("ALICE");
    await bob.sync(conv.id);
    await bob.flush();
    const bob2 = make("BOB", "B1");
    const again = await bob2.sync(conv.id);
    expect(again.messages).toEqual([]);
    expect(bob2.messages(conv.id).map((m) => m.payload.text)).toEqual(["one"]);
  });

  it("saves before a message is posted", async () => {
    const { make, events } = await setup();
    const alice = make("ALICE", "A1", {
      api: (real) => {
        const wrapped = Object.create(real) as Api;
        wrapped.post = ((path: string, ...rest: unknown[]) => {
          if (path.endsWith("/messages")) events.push("post:message");
          return (real.post as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
        }) as Api["post"];
        return wrapped;
      },
    });
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();
    const conv = await alice.openDm("BOB");
    events.length = 0;
    await alice.send(conv.id, "order matters");
    expect(events.indexOf("save:A1")).toBeGreaterThanOrEqual(0);
    expect(events.indexOf("save:A1")).toBeLessThan(events.indexOf("post:message"));
  });

  it("saves after every epoch change", async () => {
    const { make, events } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();
    events.length = 0;
    await alice.openDm("BOB");
    // group created, then one add commit accepted
    expect(events.filter((e) => e === "save:A1").length).toBeGreaterThanOrEqual(2);
  });

  it("removes a member: they cannot read what comes next, the rest can", async () => {
    const { make } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    const carol = make("CAROL", "C1x");
    await Promise.all([alice.publishKeys(), bob.publishKeys(), carol.publishKeys()]);
    await alice.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    await bob.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    await carol.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    const conv = alice.channelConversation("C1")!;

    await alice.removeMember(conv, "CAROL");
    await bob.sync(conv);
    const msg = await alice.encryptForChannel("C1", "carol should not see this");
    const wire = { id: "M9", serverId: "S1", channelId: "C1", authorId: "ALICE", ciphertext: msg.ciphertext, epoch: msg.epoch, createdAt: 1, editedAt: null };
    expect((await bob.decryptChannelMessage(wire))?.text).toBe("carol should not see this");
    expect(await carol.decryptChannelMessage(wire)).toBeNull();
  });

  it("rolls back a rejected commit and the group keeps working", async () => {
    const { make } = await setup();
    let reject = true;
    const alice = make("ALICE", "A1", {
      api: (real) => {
        const wrapped = Object.create(real) as Api;
        wrapped.post = ((path: string, ...rest: unknown[]) => {
          if (reject && path.endsWith("/commits") && (rest[0] as { removes: unknown[] }).removes.length > 0) {
            return Promise.reject(new ApiError(409, "stale_epoch"));
          }
          return (real.post as (...a: unknown[]) => Promise<unknown>)(path, ...rest);
        }) as Api["post"];
        return wrapped;
      },
    });
    const bob = make("BOB", "B1");
    const carol = make("CAROL", "C1x");
    await Promise.all([alice.publishKeys(), bob.publishKeys(), carol.publishKeys()]);
    await alice.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    await bob.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    await carol.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    const conv = alice.channelConversation("C1")!;

    await expect(alice.removeMember(conv, "CAROL")).rejects.toThrow("stale_epoch");

    // Nothing diverged: everyone still reads each other.
    const msg = await alice.encryptForChannel("C1", "still fine");
    const wire = { id: "M1", serverId: "S1", channelId: "C1", authorId: "ALICE", ciphertext: msg.ciphertext, epoch: msg.epoch, createdAt: 1, editedAt: null };
    expect((await bob.decryptChannelMessage(wire))?.text).toBe("still fine");
    expect((await carol.decryptChannelMessage(wire))?.text).toBe("still fine");

    // And the removal works once the server accepts it.
    reject = false;
    await alice.removeMember(conv, "CAROL");
  });

  it("rotates keys and others follow", async () => {
    const { make } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();
    const conv = await alice.openDm("BOB");
    await bob.openDm("ALICE");
    await bob.sync(conv.id);
    await alice.rotateKeys(conv.id);
    await bob.sync(conv.id);
    await bob.send(conv.id, "after rotation");
    await alice.sync(conv.id);
    expect(alice.messages(conv.id).map((m) => m.payload.text)).toEqual(["after rotation"]);
  });

  it("removeRevoked drops the named users and devices", async () => {
    const { make } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    const carol = make("CAROL", "C1x");
    await Promise.all([alice.publishKeys(), bob.publishKeys(), carol.publishKeys()]);
    await alice.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    await bob.openChannel("S1", "C1", ["ALICE", "BOB", "CAROL"]);
    const conv = alice.channelConversation("C1")!;
    await alice.removeRevoked(conv, { userIds: ["BOB"], deviceIds: ["C1x"] });
    const msg = await alice.encryptForChannel("C1", "x");
    const wire = { id: "M1", serverId: "S1", channelId: "C1", authorId: "ALICE", ciphertext: msg.ciphertext, epoch: msg.epoch, createdAt: 1, editedAt: null };
    expect(await bob.decryptChannelMessage(wire)).toBeNull();
  });
});
