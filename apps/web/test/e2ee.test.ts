import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { adaptWasmClient, deviceIdentity, E2ee } from "../src/lib/e2ee.js";
import { FakeDelivery } from "./fake-delivery.js";

const pkg = fileURLToPath(new URL("../../../crates/crypto/pkg/", import.meta.url));
const built = existsSync(pkg + "bastion_crypto_bg.wasm");

// The WASM build is a generated artifact; skip rather than fail where it is missing.
describe.skipIf(!built)("E2ee over the crypto crate", () => {
  async function setup() {
    const wasm = await import(/* @vite-ignore */ pkg + "bastion_crypto.js");
    wasm.initSync({ module: readFileSync(pkg + "bastion_crypto_bg.wasm") });
    const server = new FakeDelivery();
    const make = (userId: string, deviceId: string) =>
      new E2ee({
        api: server.api(userId, deviceId),
        userId,
        deviceId,
        mls: adaptWasmClient(new wasm.WasmClient(deviceIdentity(userId, deviceId))),
        now: () => 1,
      });
    return { server, make };
  }

  it("two people exchange messages in a DM and the server only sees ciphertext", async () => {
    const { server, make } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();

    const conv = await alice.openDm("BOB");
    await alice.send(conv.id, "hello bob");

    // Bob finds the conversation, joins from his welcome and reads.
    await bob.openDm("ALICE");
    await bob.sync(conv.id);
    expect(bob.messages(conv.id).map((m) => m.payload.text)).toEqual(["hello bob"]);
    expect(bob.messages(conv.id)[0]!.senderId).toBe("ALICE");

    await bob.send(conv.id, "hi alice");
    await alice.sync(conv.id);
    expect(alice.messages(conv.id).map((m) => m.payload.text)).toEqual(["hello bob", "hi alice"]);

    const logged = JSON.stringify([...server.convs.values()].map((c) => c.log));
    expect(logged).not.toContain("hello bob");
    expect(logged).not.toContain("hi alice");
  });

  it("adds each of the peer's devices, and the other device can read too", async () => {
    const { make } = await setup();
    const alice = make("ALICE", "A1");
    const bob1 = make("BOB", "B1");
    const bob2 = make("BOB", "B2");
    await Promise.all([alice.publishKeys(), bob1.publishKeys(), bob2.publishKeys()]);

    const conv = await alice.openDm("BOB");
    await alice.send(conv.id, "to both");
    for (const device of [bob1, bob2]) {
      await device.openDm("ALICE");
      await device.sync(conv.id);
      expect(device.messages(conv.id).map((m) => m.payload.text)).toEqual(["to both"]);
    }
  });

  it("keeps our own sent messages in the log", async () => {
    const { make } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();
    const conv = await alice.openDm("BOB");
    await alice.send(conv.id, "one");
    await alice.send(conv.id, "two");
    await alice.sync(conv.id);
    expect(alice.messages(conv.id).map((m) => m.payload.text)).toEqual(["one", "two"]);
  });

  it("does not top up key packages when the stock is healthy", async () => {
    const { server, make } = await setup();
    const alice = make("ALICE", "A1");
    await alice.publishKeys();
    await alice.publishKeys();
    expect(server.devices.get("A1")!.packages.length).toBe(50);
  });

  it("encrypts channel messages for every member device", async () => {
    const { make } = await setup();
    const alice = make("ALICE", "A1");
    const bob = make("BOB", "B1");
    await alice.publishKeys();
    await bob.publishKeys();

    // Alice (a channel manager) sets the group up and adds Bob's device.
    await alice.openChannel("S1", "C1", ["ALICE", "BOB"]);
    const sent = alice.encryptForChannel("C1", "channel hello");
    alice.rememberSent("M1", sent.payload);
    expect(sent.ciphertext).not.toContain("channel");

    // Bob finds the group already exists, joins from his welcome, and decrypts.
    await bob.openChannel("S1", "C1", ["ALICE", "BOB"]);
    const message = { id: "M2", serverId: "S1", channelId: "C1", authorId: "ALICE", ciphertext: sent.ciphertext, epoch: sent.epoch, createdAt: 1, editedAt: null };
    expect((await bob.decryptChannelMessage(message))?.text).toBe("channel hello");
    // Alice reads her own message from what she sent.
    expect((await alice.decryptChannelMessage({ ...message, id: "M1" }))?.text).toBe("channel hello");
    // A device that never joined can't read it.
    const carol = make("CAROL", "C1x");
    expect(await carol.decryptChannelMessage(message)).toBeNull();
  });
});
