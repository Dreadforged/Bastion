import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { AuthClient } from "../src/lib/auth.js";
import { Controller } from "../src/lib/controller.js";
import { Api, MemoryTokenStore } from "../src/lib/http.js";
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

describe("Controller sign-out", () => {
  it("wipes the vault", async () => {
    const vault = new IdbStateVault(new IDBFactory());
    await vault.save("u/d", secret);
    const api = new Api({ baseUrl: "", store: new MemoryTokenStore(), fetch: async () => new Response("{}") });
    const c = new Controller({ api, auth: new AuthClient(api), createMls: () => { throw new Error("unused"); }, vault, gatewayUrl: "ws://h" });
    await c.signOut();
    expect(await vault.load("u/d")).toBeNull();
  });
});
