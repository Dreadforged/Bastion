import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { AuthClient } from "../src/lib/auth.js";
import { Controller } from "../src/lib/controller.js";
import { Api, MemoryTokenStore } from "../src/lib/http.js";
import { MemoryDevicePrefs } from "../src/lib/device.js";
import { encodeBundle } from "../src/lib/e2ee.js";
import { IdbStateVault } from "../src/lib/vault.js";

const secret = new TextEncoder().encode("group secret: do not leak");

function dump(idb: IDBFactory, store: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = idb.open("bastion-e2ee");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const req = open.result.transaction(store).objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    };
  });
}

describe("IdbStateVault", () => {
  it("round-trips state and returns null when nothing is saved", async () => {
    const vault = new IdbStateVault(new IDBFactory());
    expect(await vault.load("u/d")).toBeNull();
    await vault.save("u/d", secret);
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("stores IV plus ciphertext, never the plaintext", async () => {
    const idb = new IDBFactory();
    const vault = new IdbStateVault(idb);
    await vault.save("u/d", secret);
    const [record] = (await dump(idb, "state")) as Uint8Array[];
    expect(record!.length).toBe(12 + secret.length + 16);
    expect(new TextDecoder().decode(record)).not.toContain("group secret");
  });

  it("keeps the key non-extractable", async () => {
    const idb = new IDBFactory();
    await new IdbStateVault(idb).save("u/d", secret);
    const [key] = (await dump(idb, "keys")) as CryptoKey[];
    expect(key!.extractable).toBe(false);
    expect(key!.algorithm).toMatchObject({ name: "AES-GCM", length: 256 });
    await expect(crypto.subtle.exportKey("raw", key!)).rejects.toThrow();
  });

  it("uses a fresh IV for every save", async () => {
    const idb = new IDBFactory();
    const vault = new IdbStateVault(idb);
    const ivs = new Set<string>();
    for (let i = 0; i < 20; i++) {
      await vault.save("u/d", secret);
      const [record] = (await dump(idb, "state")) as Uint8Array[];
      ivs.add(Array.from(record!.slice(0, 12)).join(","));
    }
    expect(ivs.size).toBe(20);
  });

  it("refuses state that was tampered with or copied to another device id", async () => {
    const idb = new IDBFactory();
    const vault = new IdbStateVault(idb);
    await vault.save("u/d", secret);
    await vault.save("u/other", secret);
    // Flip a bit in the stored record.
    await new Promise<void>((resolve, reject) => {
      const open = idb.open("bastion-e2ee");
      open.onsuccess = () => {
        const store = open.result.transaction("state", "readwrite").objectStore("state");
        const get = store.get("u/d");
        get.onsuccess = () => {
          const record = get.result as Uint8Array;
          record[record.length - 1] = record[record.length - 1]! ^ 1;
          const put = store.put(record, "u/d");
          put.onsuccess = () => resolve();
          put.onerror = () => reject(put.error);
        };
      };
    });
    await expect(vault.load("u/d")).rejects.toThrow("vault_unreadable");
  });

  it("clear removes every key and every state", async () => {
    const idb = new IDBFactory();
    const vault = new IdbStateVault(idb);
    await vault.save("a/1", secret);
    await vault.save("b/2", secret);
    await vault.clear();
    expect(await dump(idb, "state")).toEqual([]);
    expect(await dump(idb, "keys")).toEqual([]);
    expect(await vault.load("a/1")).toBeNull();
  });

  it("never touches localStorage", async () => {
    const touched: string[] = [];
    const prev = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = new Proxy({}, { get: (_t, p) => (touched.push(String(p)), undefined), set: (_t, p) => (touched.push(String(p)), true) });
    try {
      await new IdbStateVault(new IDBFactory()).save("u/d", secret);
    } finally {
      (globalThis as { localStorage?: unknown }).localStorage = prev;
    }
    expect(touched).toEqual([]);
  });
});

describe("IdbStateVault.remove", () => {
  it("removes one device and leaves the others readable", async () => {
    const vault = new IdbStateVault(new IDBFactory());
    await vault.save("a/1", secret);
    await vault.save("b/2", secret);
    await vault.remove("a/1");
    expect(await vault.load("a/1")).toBeNull();
    expect(await vault.load("b/2")).toEqual(secret);
  });
});

describe("Controller sign-out keeps history", () => {
  function make(fetchImpl: typeof fetch = async () => new Response("{}"), tokens: ConstructorParameters<typeof MemoryTokenStore>[0] = null, devicePrefs?: MemoryDevicePrefs) {
    const vault = new IdbStateVault(new IDBFactory());
    let controller: Controller | undefined;
    const api = new Api({ baseUrl: "", store: new MemoryTokenStore(tokens), fetch: fetchImpl, onSignedOut: () => void controller?.sessionEnded() });
    controller = new Controller({ api, auth: new AuthClient(api), createMls: () => { throw new Error("unused"); }, vault, gatewayUrl: "ws://h", ...(devicePrefs ? { devicePrefs } : {}) });
    // Pretend this device is signed in as u / d and the vault holds its state.
    (controller as unknown as { vaultId: string }).vaultId = "u/d";
    return { vault, api, c: controller };
  }

  it("a plain sign-out leaves the vault alone", async () => {
    const { vault, c } = make();
    await vault.save("u/d", secret);
    await c.signOut();
    expect(c.getState().phase).toBe("signed-out");
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("an expired or revoked session (refresh refused) leaves the vault alone", async () => {
    const tokens = { accessToken: "a", refreshToken: "r", accessExpiresAt: 0, refreshExpiresAt: 0 } as ConstructorParameters<typeof MemoryTokenStore>[0];
    const { vault, api, c } = make(async () => new Response(JSON.stringify({ error: "invalid_refresh_token" }), { status: 401 }), tokens);
    await vault.save("u/d", secret);
    expect(await api.refresh()).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(api.tokens).toBeNull();
    expect(c.getState().phase).toBe("signed-out");
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("the server ending the session leaves the vault alone", async () => {
    const { vault, c } = make();
    await vault.save("u/d", secret);
    await (c as unknown as { reset(erase: boolean): Promise<void> }).reset(false);
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("sign out and erase removes only this account's state", async () => {
    const { vault, c } = make();
    await vault.save("u/d", secret);
    await vault.save("other/d2", secret);
    await c.signOutAndErase();
    expect(await vault.load("u/d")).toBeNull();
    expect(await vault.load("other/d2")).toEqual(secret);
    expect(c.getState().phase).toBe("signed-out");
    expect(c.getState().error).toBeNull();
  });

  it("erase before the account is known clears the whole vault", async () => {
    const { vault, c } = make();
    (c as unknown as { vaultId: string | null }).vaultId = null;
    await vault.save("u/d", secret);
    await c.signOutAndErase();
    expect(await vault.load("u/d")).toBeNull();
  });

  it("reports it when the erase fails", async () => {
    const { vault, c } = make();
    vault.remove = async () => { throw new Error("idb"); };
    await c.signOutAndErase();
    expect(c.getState().error).toBe("could_not_erase_device_data");
  });

  it("deleting the account erases this device's state", async () => {
    const { vault, c } = make(async () => new Response(null, { status: 204 }));
    await vault.save("u/d", secret);
    expect(await c.deleteAccount()).toBeNull();
    expect(await vault.load("u/d")).toBeNull();
  });
});

describe("Private and shared devices", () => {
  const safe = { ageBand: "18plus", ageMethod: "declared", ageBandUntil: null, accountState: "active", country: null, minAge: 18, ageDeclarationRequired: false, termsOutstanding: [] };

  function make(kind: "private" | "shared" | null, fetchImpl: typeof fetch = async () => new Response("{}")) {
    const vault = new IdbStateVault(new IDBFactory());
    const prefs = new MemoryDevicePrefs(kind);
    let controller: Controller | undefined;
    const api = new Api({ baseUrl: "", store: new MemoryTokenStore({ accessToken: "a", refreshToken: "r", accessExpiresAt: Date.now() + 3_600_000 } as never), fetch: fetchImpl, onSignedOut: () => void controller?.sessionEnded() });
    controller = new Controller({ api, auth: new AuthClient(api), createMls: () => { throw new Error("unused"); }, vault, gatewayUrl: "ws://h", devicePrefs: prefs, createSocket: () => ({ readyState: 1, send() {}, close() {}, onopen: null, onmessage: null, onclose: null, onerror: null }) as never });
    (controller as unknown as { vaultId: string }).vaultId = "u/d";
    return { vault, prefs, api, c: controller };
  }

  it("asks once after sign-in when nobody has chosen, then remembers the answer", async () => {
    const { c, prefs } = make(null, async (input) => new Response(String(input).includes("/account/safety") ? JSON.stringify(safe) : "[]"));
    await c.connect();
    expect(c.getState().phase).toBe("safety-gate");
    expect(c.getState().gate).toEqual({ kind: "device" });
    await c.chooseDevice("shared");
    expect(prefs.load()).toBe("shared");
    expect(c.getState().gate).toBeNull();
    expect(c.deviceKind()).toBe("shared");
  });

  it("does not ask again once chosen", async () => {
    const { c } = make("private", async (input) => new Response(String(input).includes("/account/safety") ? JSON.stringify(safe) : "[]"));
    await c.connect();
    expect(c.getState().gate).toBeNull();
    expect(c.getState().phase).not.toBe("safety-gate");
  });

  it("a shared device erases this account's history when the person signs out", async () => {
    const { vault, c } = make("shared");
    await vault.save("u/d", secret);
    await vault.save("other/d2", secret);
    await c.signOut();
    expect(await vault.load("u/d")).toBeNull();
    expect(await vault.load("other/d2")).toEqual(secret);
  });

  it("a private device keeps it", async () => {
    const { vault, c } = make("private");
    await vault.save("u/d", secret);
    await c.signOut();
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("signing out of the device question on a shared device erases nothing (no account known yet)", async () => {
    const { vault, c } = make("shared");
    (c as unknown as { vaultId: string | null }).vaultId = null;
    await vault.save("u/d", secret);
    await c.signOut();
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("a forced end of session never erases, even on a shared device", async () => {
    const { vault, c } = make("shared");
    await vault.save("u/d", secret);
    await c.sessionEnded();
    expect(c.getState().phase).toBe("signed-out");
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("an expired session on a shared device never erases", async () => {
    const { vault, api } = make("shared", async () => new Response(JSON.stringify({ error: "invalid_refresh_token" }), { status: 401 }));
    (api as unknown as { opts: { store: MemoryTokenStore } }).opts.store.save({ accessToken: "a", refreshToken: "r", accessExpiresAt: 0, refreshExpiresAt: 0 } as never);
    await vault.save("u/d", secret);
    expect(await api.refresh()).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("a blocked account is signed out without erasing, even on a shared device", async () => {
    const blocked = { ...safe, accountState: "suspended" };
    const { vault, c } = make("shared", async (input) => new Response(String(input).includes("/account/safety") ? JSON.stringify(blocked) : "{}"));
    await vault.save("u/d", secret);
    await c.connect();
    expect(c.getState().error).toBe("account_blocked");
    expect(await vault.load("u/d")).toEqual(secret);
  });
});

describe("IdbStateVault.backup", () => {
  it("copies state and key without touching the original, and restore brings it back", async () => {
    const vault = new IdbStateVault(new IDBFactory());
    await vault.save("u/d", secret);
    const backupId = await vault.backup("u/d");
    expect(backupId).not.toBeNull();
    expect(await vault.load("u/d")).toEqual(secret);
    await vault.save("u/d", new TextEncoder().encode("replacement"));
    await vault.restore("u/d", backupId!);
    expect(await vault.load("u/d")).toEqual(secret);
  });

  it("returns null when there is nothing to back up", async () => {
    expect(await new IdbStateVault(new IDBFactory()).backup("u/d")).toBeNull();
  });

  it("an explicit erase removes the backups too, and other devices are left alone", async () => {
    const idb = new IDBFactory();
    const vault = new IdbStateVault(idb);
    await vault.save("u/d", secret);
    await vault.save("u/d2", secret);
    await vault.backup("u/d");
    await vault.backup("u/d2");
    await vault.remove("u/d");
    expect(await dump(idb, "state")).toHaveLength(2); // u/d2 and its backup
    expect(await vault.load("u/d2")).toEqual(secret);
  });
});

describe("Controller with unreadable saved history", () => {
  const meta = { cursor: [], channelConv: [], sent: [], log: [] };
  const ready = { userId: "u", seq: 0, servers: [] };

  async function setup(stored: Uint8Array | null, createMls: () => never = () => { throw new Error("opened"); }) {
    const idb = new IDBFactory();
    const vault = new IdbStateVault(idb);
    if (stored) await vault.save("u/d", stored);
    const api = new Api({ baseUrl: "", store: new MemoryTokenStore(), fetch: async () => new Response("{}") });
    const c = new Controller({ api, auth: new AuthClient(api), createMls, vault, gatewayUrl: "ws://h" });
    (c as unknown as { deviceId: string }).deviceId = "d";
    const onReady = () => (c as unknown as { onReady(r: unknown): Promise<void> }).onReady(ready);
    return { vault, idb, c, onReady };
  }

  it("corrupt data is kept untouched and reported", async () => {
    const { vault, c, onReady } = await setup(new TextEncoder().encode("not json {"));
    await onReady();
    expect(c.getState().vaultProblem).toBe("unreadable");
    expect(c.getState().error).toBeNull();
    expect(await vault.load("u/d")).toEqual(new TextEncoder().encode("not json {"));
  });

  it("a different bundle version is kept untouched and reported as such", async () => {
    const other = new TextEncoder().encode(JSON.stringify({ v: 99, mls: "AA==", meta }));
    const { vault, c, onReady } = await setup(other);
    await onReady();
    expect(c.getState().vaultProblem).toBe("unsupported_version");
    expect(await vault.load("u/d")).toEqual(other);
  });

  it("saved state that the MLS client cannot open is kept, not replaced", async () => {
    const good = encodeBundle(new Uint8Array([1, 2, 3]), meta);
    const calls: (Uint8Array | null)[] = [];
    const { vault, c, onReady } = await setup(good, ((_u: string, _d: string, saved: Uint8Array | null) => { calls.push(saved); throw new Error("bad state"); }) as never);
    await onReady();
    expect(c.getState().vaultProblem).toBe("unreadable");
    expect(calls).toHaveLength(1); // never retried with a blank client
    expect(await vault.load("u/d")).toEqual(good);
  });

  it("a vault that cannot be read at all does not start fresh either", async () => {
    const { vault, c, onReady } = await setup(null);
    vault.load = async () => { throw new Error("vault_unreadable"); };
    await onReady();
    expect(c.getState().vaultProblem).toBe("unreadable");
  });

  it("retry reads the saved history again and keeps it if it still will not open", async () => {
    const good = encodeBundle(new Uint8Array([1]), meta);
    let attempts = 0;
    const { vault, c, onReady } = await setup(good, (() => { attempts++; throw new Error("temporary"); }) as never);
    await onReady();
    await c.retryVault();
    expect(attempts).toBe(2);
    expect(c.getState().vaultProblem).toBe("unreadable");
    expect(await vault.load("u/d")).toEqual(good);
  });

  it("starting fresh backs the old data up before anything can replace it", async () => {
    const bad = new TextEncoder().encode("garbage");
    const { vault, idb, c, onReady } = await setup(bad);
    await onReady();
    // createMls throws here, which stops us right after the backup was taken.
    await expect(c.startFresh()).rejects.toThrow("opened");
    const states = (await dump(idb, "state")) as Uint8Array[];
    expect(states).toHaveLength(2);
    const ids = await new Promise<string[]>((resolve) => {
      const open = idb.open("bastion-e2ee");
      open.onsuccess = () => {
        const req = open.result.transaction("state").objectStore("state").getAllKeys();
        req.onsuccess = () => resolve(req.result as string[]);
      };
    });
    const backupId = ids.find((i) => i.startsWith("u/d#backup-"))!;
    expect(backupId).toBeDefined();
    await vault.restore("u/d", backupId);
    await expect(vault.load("u/d")).resolves.toEqual(bad);
  });

  it("if the backup fails, nothing changes and the problem stays", async () => {
    const { vault, c, onReady } = await setup(new TextEncoder().encode("garbage"));
    await onReady();
    vault.backup = async () => { throw new Error("idb"); };
    await c.startFresh();
    expect(c.getState().vaultProblem).toBe("unreadable");
    expect(c.getState().error).toBe("could_not_back_up_device_data");
  });

  it("a plain sign-out while the problem is showing erases nothing", async () => {
    const { vault, c, onReady } = await setup(new TextEncoder().encode("garbage"));
    await onReady();
    await c.signOut();
    expect(c.getState().vaultProblem).toBeNull();
    expect(await vault.load("u/d")).toEqual(new TextEncoder().encode("garbage"));
    expect(await vault.backup("u/d")).not.toBeNull(); // the record is still there
  });
});
