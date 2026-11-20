/**
 * Encrypted storage for this device's MLS state.
 *
 * The state blob holds group secrets, so it never touches localStorage and is
 * never written in the clear. Each save is AES-GCM encrypted with a fresh
 * random 12-byte IV, and IV plus ciphertext is stored in IndexedDB. The key
 * is a non-extractable CryptoKey kept in the same database: page scripts
 * can use it but cannot read its bytes out.
 *
 * Be honest about what this buys: it protects the blob at rest (a copied
 * profile or database dump is useless without the key), but script running
 * in this origin can still ask the browser to decrypt. Keep the CSP tight.
 */

const DB_NAME = "bastion-e2ee";
const KEYS = "keys";
const STATE = "state";
const IV_BYTES = 12;
/** Backups live beside the live record under `<id>#backup-<stamp>`. */
const BACKUP_MARK = "#backup-";

export interface StateVault {
  /** The saved state for a device, or null if there is none. */
  load(id: string): Promise<Uint8Array | null>;
  save(id: string, bytes: Uint8Array): Promise<void>;
  /**
   * Remove one device's key and saved state. Only for the explicit "erase data from
   * this device" action and account deletion. Plain sign-out, an expired session
   * or a forced sign-out must never call this.
   */
  remove(id: string): Promise<void>;
  /**
   * Copy a device's saved state and its key to a backup slot, leaving the original
   * untouched. Returns the backup id, or null if there was nothing saved. Call this
   * before anything that could replace state that failed to load.
   */
  backup(id: string): Promise<string | null>;
  /** Put a backup made by `backup` back as the live state (the backup stays). */
  restore(id: string, backupId: string): Promise<void>;
  /** Remove every key and every saved state (all accounts on this browser profile). Same rules as `remove`. */
  clear(): Promise<void>;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexeddb_error"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("indexeddb_error"));
    tx.onabort = () => reject(tx.error ?? new Error("indexeddb_aborted"));
  });
}

export class IdbStateVault implements StateVault {
  private db: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly idb: IDBFactory = indexedDB,
    private readonly subtle: SubtleCrypto = crypto.subtle,
    private readonly random: (n: number) => Uint8Array<ArrayBuffer> = (n) => crypto.getRandomValues(new Uint8Array(n)),
  ) {}

  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = this.idb.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(KEYS);
        req.result.createObjectStore(STATE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("indexeddb_error"));
    });
    return this.db;
  }

  private async key(id: string, create: boolean): Promise<CryptoKey | null> {
    const db = await this.open();
    const existing = (await request(db.transaction(KEYS).objectStore(KEYS).get(id))) as CryptoKey | undefined;
    if (existing) return existing;
    if (!create) return null;
    const fresh = await this.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const tx = db.transaction(KEYS, "readwrite");
    tx.objectStore(KEYS).put(fresh, id);
    await done(tx);
    return fresh;
  }

  async save(id: string, bytes: Uint8Array): Promise<void> {
    const key = (await this.key(id, true))!;
    const iv = this.random(IV_BYTES);
    const sealed = new Uint8Array(
      await this.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) }, key, bytes as Uint8Array<ArrayBuffer>),
    );
    const record = new Uint8Array(IV_BYTES + sealed.length);
    record.set(iv, 0);
    record.set(sealed, IV_BYTES);
    const db = await this.open();
    const tx = db.transaction(STATE, "readwrite");
    tx.objectStore(STATE).put(record, id);
    await done(tx);
  }

  async load(id: string): Promise<Uint8Array | null> {
    const db = await this.open();
    const record = (await request(db.transaction(STATE).objectStore(STATE).get(id))) as Uint8Array | undefined;
    if (!record) return null;
    const key = await this.key(id, false);
    // State without its key can never be read; treat it as gone.
    if (!key || record.length <= IV_BYTES) throw new Error("vault_unreadable");
    try {
      const plain = await this.subtle.decrypt(
        { name: "AES-GCM", iv: record.slice(0, IV_BYTES), additionalData: new TextEncoder().encode(id) },
        key,
        record.slice(IV_BYTES),
      );
      return new Uint8Array(plain);
    } catch {
      throw new Error("vault_unreadable");
    }
  }

  async backup(id: string): Promise<string | null> {
    const db = await this.open();
    const record = (await request(db.transaction(STATE).objectStore(STATE).get(id))) as Uint8Array | undefined;
    if (!record) return null;
    const key = (await request(db.transaction(KEYS).objectStore(KEYS).get(id))) as CryptoKey | undefined;
    const backupId = `${id}${BACKUP_MARK}${Date.now()}-${Array.from(this.random(4)).join("")}`;
    const tx = db.transaction([KEYS, STATE], "readwrite");
    tx.objectStore(STATE).put(record, backupId);
    if (key) tx.objectStore(KEYS).put(key, backupId);
    await done(tx);
    return backupId;
  }

  async restore(id: string, backupId: string): Promise<void> {
    if (!backupId.startsWith(id + BACKUP_MARK)) throw new Error("backup_mismatch");
    const db = await this.open();
    const record = (await request(db.transaction(STATE).objectStore(STATE).get(backupId))) as Uint8Array | undefined;
    if (!record) throw new Error("backup_missing");
    const key = (await request(db.transaction(KEYS).objectStore(KEYS).get(backupId))) as CryptoKey | undefined;
    const tx = db.transaction([KEYS, STATE], "readwrite");
    tx.objectStore(STATE).put(record, id);
    if (key) tx.objectStore(KEYS).put(key, id);
    await done(tx);
  }

  async remove(id: string): Promise<void> {
    const db = await this.open();
    // An explicit erase takes this device's backups with it.
    const prefix = id + BACKUP_MARK;
    const keys = (await request(db.transaction(STATE).objectStore(STATE).getAllKeys())) as string[];
    const stale = keys.filter((k) => typeof k === "string" && k.startsWith(prefix));
    const tx = db.transaction([KEYS, STATE], "readwrite");
    for (const k of [id, ...stale]) {
      tx.objectStore(KEYS).delete(k);
      tx.objectStore(STATE).delete(k);
    }
    await done(tx);
  }

  async clear(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([KEYS, STATE], "readwrite");
    tx.objectStore(KEYS).clear();
    tx.objectStore(STATE).clear();
    await done(tx);
  }
}
