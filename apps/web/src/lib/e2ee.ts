import { schemas } from "@bastion/shared";

type MessagePayload = schemas.MessagePayload;
const { E2EE_LIMITS, MessagePayload } = schemas;
import { adaptVoiceMls, type RawVoiceClient, type VoiceMls } from "../voice/mls.js";
import { ApiError, newIdempotencyKey, type Api } from "./http.js";

/**
 * Message encryption for the client. The MLS work happens in the crypto
 * crate's WASM build; this file keeps that device's groups in step with the
 * server's delivery service (conversations, commits, welcomes, envelopes).
 *
 * Group state survives reloads: after every epoch change, send and receive
 * the MLS state (plus the cursors and message log kept here) is handed to
 * `persist`, which stores it encrypted (see vault.ts). A message is saved
 * before it is posted so a crash can never reuse a ratchet generation.
 */

export interface MlsIncoming {
  kind: "message" | "commit" | "removed";
  content: Uint8Array;
  sender: Uint8Array;
}

/** The slice of the WASM client this layer uses, as plain data. */
export interface MlsClient {
  identityKey(): Uint8Array;
  keyPackage(): Uint8Array;
  createGroup(groupId: Uint8Array): void;
  addMember(groupId: Uint8Array, keyPackage: Uint8Array): { commit: Uint8Array; welcome: Uint8Array | undefined };
  commitAccepted(groupId: Uint8Array): void;
  join(welcome: Uint8Array): Uint8Array;
  encrypt(groupId: Uint8Array, content: Uint8Array): Uint8Array;
  receive(groupId: Uint8Array, bytes: Uint8Array): MlsIncoming;
  epoch(groupId: Uint8Array): number;
  removeMembers(groupId: Uint8Array, identities: Uint8Array[]): { commit: Uint8Array; welcome: Uint8Array | undefined };
  updateKeys(groupId: Uint8Array): { commit: Uint8Array; welcome: Uint8Array | undefined };
  commitRejected(groupId: Uint8Array): void;
  members(groupId: Uint8Array): Uint8Array[];
  inGroup(groupId: Uint8Array): boolean;
  saveState(): Uint8Array;
  /**
   * The same client's calls interface (exporter, self-update, call groups).
   * Present on the real client only, so voice and messaging see the same groups.
   */
  voice?: VoiceMls;
}

/** The generated bindings, which return objects that must be freed. */
interface WasmModuleClient {
  identityKey(): Uint8Array;
  keyPackage(): Uint8Array;
  createGroup(g: Uint8Array): void;
  addMember(g: Uint8Array, k: Uint8Array): { commit: Uint8Array; welcome: Uint8Array | undefined; free(): void };
  commitAccepted(g: Uint8Array): void;
  join(w: Uint8Array): Uint8Array;
  encrypt(g: Uint8Array, c: Uint8Array): Uint8Array;
  receive(g: Uint8Array, b: Uint8Array): { kind: string; content: Uint8Array; sender: Uint8Array; free(): void };
  epoch(g: Uint8Array): number;
  removeMembers(g: Uint8Array, ids: Uint8Array[]): { commit: Uint8Array; welcome: Uint8Array | undefined; free(): void };
  updateKeys(g: Uint8Array): { commit: Uint8Array; welcome: Uint8Array | undefined; free(): void };
  commitRejected(g: Uint8Array): void;
  members(g: Uint8Array): Uint8Array[];
  inGroup(g: Uint8Array): boolean;
  saveState(): Uint8Array;
}

export function adaptWasmClient(raw: WasmModuleClient): MlsClient {
  return {
    voice: adaptVoiceMls(raw as unknown as RawVoiceClient),
    identityKey: () => raw.identityKey(),
    keyPackage: () => raw.keyPackage(),
    createGroup: (g) => raw.createGroup(g),
    addMember(g, k) {
      const out = raw.addMember(g, k);
      const result = { commit: out.commit, welcome: out.welcome };
      out.free();
      return result;
    },
    commitAccepted: (g) => raw.commitAccepted(g),
    join: (w) => raw.join(w),
    encrypt: (g, c) => raw.encrypt(g, c),
    receive(g, b) {
      const out = raw.receive(g, b);
      const result = { kind: out.kind as MlsIncoming["kind"], content: out.content, sender: out.sender };
      out.free();
      return result;
    },
    epoch: (g) => raw.epoch(g),
    removeMembers(g, ids) {
      const out = raw.removeMembers(g, ids);
      const result = { commit: out.commit, welcome: out.welcome };
      out.free();
      return result;
    },
    updateKeys(g) {
      const out = raw.updateKeys(g);
      const result = { commit: out.commit, welcome: out.welcome };
      out.free();
      return result;
    },
    commitRejected: (g) => raw.commitRejected(g),
    members: (g) => raw.members(g),
    inGroup: (g) => raw.inGroup(g),
    saveState: () => raw.saveState(),
  };
}

/** What this layer keeps next to the MLS state so a reload picks up where it stopped. */
export interface PersistedMeta {
  cursor: [string, number][];
  channelConv: [string, string][];
  sent: [string, MessagePayload][];
  log: [string, DecryptedMessage[]][];
}

const BUNDLE_VERSION = 1;
const KEEP_SENT = 5000;
const KEEP_LOG = 1000;

export function encodeBundle(mls: Uint8Array, meta: PersistedMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ v: BUNDLE_VERSION, mls: toB64(mls), meta }));
}

/** Throws if the bytes are not a bundle this version wrote. */
export function decodeBundle(bytes: Uint8Array): { mls: Uint8Array; meta: PersistedMeta } {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as { v?: number; mls?: string; meta?: PersistedMeta };
  if (raw.v !== BUNDLE_VERSION || typeof raw.mls !== "string" || !raw.meta) throw new Error("bundle_unsupported");
  const { cursor, channelConv, sent, log } = raw.meta;
  if (![cursor, channelConv, sent, log].every(Array.isArray)) throw new Error("bundle_unsupported");
  return { mls: fromB64(raw.mls), meta: raw.meta };
}

export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function fromB64Url(text: string): Uint8Array {
  return fromB64(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
}

/** The identity other members see in the MLS credential. */
export function deviceIdentity(userId: string, deviceId: string): Uint8Array {
  return new TextEncoder().encode(`${userId}/${deviceId}`);
}

export interface DecryptedMessage {
  /** Envelope sequence number; the order in the conversation. */
  seq: number;
  senderId: string;
  senderDeviceId: string;
  createdAt: number;
  payload: MessagePayload;
}

const KEY_PACKAGE_LOW_WATER = 20;
const KEY_PACKAGE_BATCH = 50;

export interface E2eeOptions {
  api: Api;
  userId: string;
  deviceId: string;
  mls: MlsClient;
  now?: () => number;
  /** Where to put the encrypted-at-rest state bundle. Omit to keep nothing. */
  persist?: (bundle: Uint8Array) => Promise<void>;
  /** What `decodeBundle` returned for this device, if anything was saved. */
  restored?: PersistedMeta;
  onPersistError?: (err: unknown) => void;
}

/** What `sync` found. */
export interface SyncResult {
  messages: DecryptedMessage[];
  /** This device was removed from the group. */
  removed: boolean;
}

/**
 * One device's encrypted conversations. DMs are the supported flow: the
 * device that starts one creates the group and adds the other person's
 * devices; everyone else joins from their welcome.
 */
export class E2ee {
  /** Highest envelope seq applied per conversation. */
  private readonly cursor = new Map<string, number>();
  private readonly channelConv = new Map<string, string>();
  private readonly sent = new Map<string, MessagePayload>();
  private readonly log = new Map<string, DecryptedMessage[]>();
  private readonly syncing = new Map<string, Promise<SyncResult>>();
  /** Conversations made only to key a DM call. They are groups to sync, never chats to show. */
  private readonly callGroups = new Set<string>();
  private saving: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly o: E2eeOptions) {
    const r = o.restored;
    if (r) {
      for (const [k, v] of r.cursor) this.cursor.set(k, v);
      for (const [k, v] of r.channelConv) this.channelConv.set(k, v);
      for (const [k, v] of r.sent) this.sent.set(k, v);
      for (const [k, v] of r.log) this.log.set(k, v);
    }
  }

  private isKnown(conversationId: string): boolean {
    return this.o.mls.inGroup(this.groupId(conversationId));
  }

  private snapshot(): Uint8Array {
    const meta: PersistedMeta = {
      cursor: [...this.cursor],
      channelConv: [...this.channelConv],
      sent: [...this.sent].slice(-KEEP_SENT),
      log: [...this.log].map(([k, v]) => [k, v.slice(-KEEP_LOG)]),
    };
    return encodeBundle(this.o.mls.saveState(), meta);
  }

  /**
   * Treat a conversation as the key group of a DM call: syncing it applies
   * its welcome and commits like any other, but it never appears as a chat
   * (see `isCallGroup`). Call this before syncing it, on both sides.
   */
  markCallGroup(conversationId: string): void {
    this.callGroups.add(conversationId);
  }

  isCallGroup(conversationId: string): boolean {
    return this.callGroups.has(conversationId);
  }

  /** Apply what is new in a conversation without caring about its messages. */
  async syncGroup(conversationId: string): Promise<void> {
    await this.sync(conversationId);
  }

  /** Where the group is made for a new call. Conversation ids are base64url of the MLS group id. */
  groupIdOf(conversationId: string): Uint8Array {
    return this.groupId(conversationId);
  }

  /**
   * Voice's view of this device's MLS client: the same groups messaging uses.
   * Anything that changes group state is saved, so a reload cannot leave this
   * device behind a commit it already made.
   */
  voice(): VoiceMls {
    const v = this.o.mls.voice;
    if (!v) throw new Error("voice_unavailable");
    const saved = <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const out = fn(...args);
        void this.persist();
        return out;
      };
    return {
      ...v,
      createGroup: saved(v.createGroup),
      commitAccepted: saved(v.commitAccepted),
      commitRejected: saved(v.commitRejected),
      join: saved(v.join),
    };
  }

  /** Save now. Saves queue up so they never overlap; a failure is reported, not thrown. */
  private persist(): Promise<void> {
    if (!this.o.persist || this.closed) return Promise.resolve();
    const persist = this.o.persist;
    const run = this.saving.then(() => persist(this.snapshot()));
    this.saving = run.catch((err) => this.o.onPersistError?.(err));
    return this.saving;
  }

  /** Stop saving (sign-out). Saves already queued finish first, so the caller can then wipe storage. */
  close(): Promise<void> {
    this.closed = true;
    return this.saving;
  }

  /** Resolves when every save requested so far has finished. */
  flush(): Promise<void> {
    return this.saving;
  }

  /** Publish this device's identity key and top up key packages. Call after sign-in. */
  async publishKeys(): Promise<void> {
    const { count } = await this.o.api.get<{ count: number }>("/keys/packages/count");
    if (count >= KEY_PACKAGE_LOW_WATER) return;
    const keyPackages: string[] = [];
    // Each package is single use, so make a fresh batch.
    for (let i = 0; i < KEY_PACKAGE_BATCH; i++) keyPackages.push(toB64(this.o.mls.keyPackage()));
    await this.o.api.post("/keys/packages", { identityKey: toB64(this.o.mls.identityKey()), keyPackages });
    // The private halves of those key packages live in the MLS state.
    await this.persist();
  }

  /** Conversations this device already holds readable messages for (what a reload brings back). */
  loggedConversations(): string[] {
    return [...this.log.keys()];
  }

  messages(conversationId: string): DecryptedMessage[] {
    return this.log.get(conversationId) ?? [];
  }

  private groupId(conversationId: string): Uint8Array {
    return fromB64Url(conversationId);
  }

  /** Start (or find) the DM with `peerId` and make this device ready to send. */
  async openDm(peerId: string): Promise<schemas.Conversation> {
    const conv = await this.o.api.post<schemas.Conversation>(
      "/conversations",
      { kind: "dm", userId: peerId },
      { idempotencyKey: newIdempotencyKey() },
    );
    if (this.isKnown(conv.id)) return conv;
    // A fresh conversation has only its creator's device in it, at epoch 0.
    const fresh = conv.epoch === 0 && conv.devices.length === 1 && conv.devices[0]!.deviceId === this.o.deviceId;
    if (fresh) await this.createAndInvite(conv.id, [peerId, this.o.userId]);
    else await this.sync(conv.id);
    return conv;
  }

  /** Make the group, then add every device of `userIds` (and our own other devices). */
  private async createAndInvite(conversationId: string, userIds: string[]): Promise<void> {
    this.o.mls.createGroup(this.groupId(conversationId));
    await this.persist();
    await this.invite(conversationId, userIds, []);
  }

  /** Add the devices of `userIds` that are not in the group yet. */
  async invite(conversationId: string, userIds: string[], present: schemas.DeviceRef[]): Promise<void> {
    const gid = this.groupId(conversationId);
    const inGroup = new Set(present.map((d) => d.deviceId));
    const keyPackages: schemas.ClaimedKeyPackage[] = [];
    let exhausted = 0;
    for (let i = 0; i < userIds.length; i += E2EE_LIMITS.maxClaimUsers) {
      const r = await this.o.api.post<{ keyPackages: schemas.ClaimedKeyPackage[]; exhausted: schemas.DeviceRef[] }>(
        "/keys/packages/claim",
        { userIds: userIds.slice(i, i + E2EE_LIMITS.maxClaimUsers) },
      );
      keyPackages.push(...r.keyPackages.filter((p) => !inGroup.has(p.deviceId)));
      exhausted += r.exhausted.filter((d) => !inGroup.has(d.deviceId)).length;
    }
    for (const pkg of keyPackages) {
      await this.publishCommit(
        conversationId,
        () => this.o.mls.addMember(gid, fromB64(pkg.keyPackage)),
        [{ userId: pkg.userId, deviceId: pkg.deviceId }],
        [],
      );
    }
    // Devices with no key packages left can't be added yet; their owner's client will top up.
    if (exhausted > 0) throw new Error("key_packages_exhausted");
  }

  /**
   * Send one commit and apply it once the server accepts it. If the server
   * refuses (stale epoch, no access) the pending commit is rolled back so
   * the group is exactly where it was, and the error goes to the caller.
   */
  private async publishCommit(
    conversationId: string,
    build: () => { commit: Uint8Array; welcome: Uint8Array | undefined },
    adds: schemas.DeviceRef[],
    removes: schemas.DeviceRef[],
  ): Promise<void> {
    const gid = this.groupId(conversationId);
    const epoch = this.o.mls.epoch(gid);
    const out = build();
    try {
      await this.o.api.post(
        `/conversations/${conversationId}/commits`,
        {
          epoch,
          commit: toB64(out.commit),
          ...(out.welcome ? { welcome: toB64(out.welcome) } : {}),
          adds,
          removes,
        },
        { idempotencyKey: newIdempotencyKey() },
      );
    } catch (err) {
      this.o.mls.commitRejected(gid);
      await this.persist();
      throw err;
    }
    this.o.mls.commitAccepted(gid);
    await this.persist();
  }

  /** Every other device in the group that `pick` accepts, with its MLS identity. */
  private groupDevices(conversationId: string, pick: (ref: schemas.DeviceRef) => boolean) {
    const dec = new TextDecoder();
    const found: { ref: schemas.DeviceRef; identity: Uint8Array }[] = [];
    for (const identity of this.o.mls.members(this.groupId(conversationId))) {
      const text = dec.decode(identity);
      const slash = text.indexOf("/");
      if (slash <= 0) continue;
      const ref = { userId: text.slice(0, slash), deviceId: text.slice(slash + 1) };
      if (ref.deviceId === this.o.deviceId) continue;
      if (pick(ref)) found.push({ ref, identity });
    }
    return found;
  }

  /** Remove all of one person's devices from a conversation in a single commit. */
  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.removeDevices(
      conversationId,
      this.groupDevices(conversationId, (d) => d.userId === userId),
    );
  }

  private async removeDevices(conversationId: string, devices: { ref: schemas.DeviceRef; identity: Uint8Array }[]): Promise<void> {
    if (devices.length === 0) return;
    const gid = this.groupId(conversationId);
    await this.publishCommit(
      conversationId,
      () => this.o.mls.removeMembers(gid, devices.map((d) => d.identity)),
      [],
      devices.map((d) => d.ref),
    );
  }

  /**
   * The server refused a send because people or devices lost access
   * (`rotation_required`). Remove them so the group's keys change, then the
   * caller can retry.
   */
  async removeRevoked(conversationId: string, body: { userIds?: string[]; deviceIds?: string[] }): Promise<void> {
    const users = new Set(body.userIds ?? []);
    const devices = new Set(body.deviceIds ?? []);
    await this.removeDevices(
      conversationId,
      this.groupDevices(conversationId, (d) => users.has(d.userId) || devices.has(d.deviceId)),
    );
  }

  /** Rotate this device's keys in a conversation (post-compromise healing). */
  async rotateKeys(conversationId: string): Promise<void> {
    const gid = this.groupId(conversationId);
    await this.publishCommit(conversationId, () => this.o.mls.updateKeys(gid), [], []);
  }

  /** The conversation behind a channel, if this device has opened it. */
  channelConversation(channelId: string): string | undefined {
    return this.channelConv.get(channelId);
  }

  /** Fetch and apply everything new in a conversation. Concurrent calls share one run. */
  sync(conversationId: string): Promise<SyncResult> {
    let run = this.syncing.get(conversationId);
    if (!run) {
      run = this.doSync(conversationId).finally(() => this.syncing.delete(conversationId));
      this.syncing.set(conversationId, run);
    }
    return run;
  }

  private async doSync(conversationId: string): Promise<SyncResult> {
    const gid = this.groupId(conversationId);
    const found: DecryptedMessage[] = [];
    let removed = false;
    try {
    for (;;) {
      const after = this.cursor.get(conversationId) ?? 0;
      const { envelopes } = await this.o.api.get<{ envelopes: schemas.Envelope[] }>(`/conversations/${conversationId}/envelopes`, {
        after,
        limit: 100,
      });
      if (envelopes.length === 0) break;
      for (const env of envelopes) {
        this.cursor.set(conversationId, env.seq);
        const own = env.senderDeviceId === this.o.deviceId;
        try {
          if (env.kind === "welcome") {
            if (!this.isKnown(conversationId)) this.o.mls.join(fromB64(env.data));
          } else if (!own && this.isKnown(conversationId)) {
            const incoming = this.o.mls.receive(gid, fromB64(env.data));
            if (incoming.kind === "removed") removed = true;
            else if (incoming.kind === "message") {
              const payload = MessagePayload.parse(JSON.parse(new TextDecoder().decode(incoming.content)));
              const message: DecryptedMessage = {
                seq: env.seq,
                senderId: env.senderId,
                senderDeviceId: env.senderDeviceId,
                createdAt: env.createdAt,
                payload,
              };
              found.push(message);
              this.remember(conversationId, message);
            }
          }
        } catch {
          // One undecryptable item (old epoch, replay, a message from before this
          // device joined) must not stall the rest of the log.
        }
      }
      if (envelopes.length < 100) break;
    }
    } finally {
      // Group state, cursor and log move together, so a reload replays nothing twice.
      await this.persist();
    }
    return { messages: found, removed };
  }

  private remember(conversationId: string, message: DecryptedMessage) {
    const list = this.log.get(conversationId) ?? [];
    list.push(message);
    list.sort((a, b) => a.seq - b.seq);
    this.log.set(conversationId, list);
  }

  /** Encrypt and send. Retries reuse the same idempotency key, so a flaky network can't double-send. */
  async send(conversationId: string, text: string): Promise<DecryptedMessage> {
    const gid = this.groupId(conversationId);
    if (!this.isKnown(conversationId)) throw new Error("conversation_not_ready");
    const payload = MessagePayload.parse({ text });
    const ciphertext = this.o.mls.encrypt(gid, new TextEncoder().encode(JSON.stringify(payload)));
    // Save the advanced ratchet before the ciphertext leaves, or a crash could reuse its key.
    await this.persist();
    const key = newIdempotencyKey();
    const body = { epoch: this.o.mls.epoch(gid), ciphertext: toB64(ciphertext) };
    const { seq } = await this.o.api.post<{ seq: number }>(`/conversations/${conversationId}/messages`, body, {
      idempotencyKey: key,
    });
    // We can't decrypt our own message later, so keep what we sent.
    const message: DecryptedMessage = {
      seq,
      senderId: this.o.userId,
      senderDeviceId: this.o.deviceId,
      createdAt: (this.o.now ?? Date.now)(),
      payload,
    };
    this.remember(conversationId, message);
    await this.persist();
    return message;
  }

  // ------------------------------------------------------------ server channels

  /**
   * Make this device ready to read and write an encrypted channel. The first
   * device in (someone with MANAGE_CHANNELS) creates the group; any device
   * already in it adds members' devices it finds missing.
   */
  async openChannel(serverId: string, channelId: string, memberIds: string[]): Promise<void> {
    let id = this.channelConv.get(channelId);
    let conv: schemas.Conversation | undefined;
    if (!id) {
      try {
        conv = await this.o.api.post<schemas.Conversation>(
          "/conversations",
          { kind: "channel", serverId, channelId },
          { idempotencyKey: newIdempotencyKey() },
        );
        id = conv.id;
      } catch (err) {
        // Someone made it first; the 409 body carries its id.
        const existing = err instanceof ApiError && err.status === 409 ? (err.body as { id?: string } | null)?.id : undefined;
        if (!existing) throw err;
        id = existing;
      }
      this.channelConv.set(channelId, id);
      await this.persist();
    }
    if (conv && !this.isKnown(id)) {
      const fresh = conv.epoch === 0 && conv.devices.length === 1 && conv.devices[0]!.deviceId === this.o.deviceId;
      if (fresh) {
        await this.createAndInvite(id, memberIds);
        return;
      }
    }
    await this.sync(id);
    if (this.isKnown(id)) {
      const view = await this.o.api.get<schemas.Conversation>(`/conversations/${id}`);
      await this.invite(id, memberIds, view.devices);
    }
  }

  /** Encrypt for a channel; the caller posts the result to the server's message route. */
  async encryptForChannel(channelId: string, text: string, attachments: MessagePayload["attachments"] = []): Promise<{ ciphertext: string; epoch: number; payload: MessagePayload }> {
    const id = this.channelConv.get(channelId);
    if (!id || !this.isKnown(id)) throw new Error("conversation_not_ready");
    const gid = this.groupId(id);
    const payload = MessagePayload.parse({ text, attachments });
    const bytes = this.o.mls.encrypt(gid, new TextEncoder().encode(JSON.stringify(payload)));
    // Save the advanced ratchet before the ciphertext leaves.
    await this.persist();
    return { ciphertext: toB64(bytes), epoch: this.o.mls.epoch(gid), payload };
  }

  /** Remember what we sent: MLS cannot decrypt a sender's own messages. */
  rememberSent(messageId: string, payload: MessagePayload): void {
    this.sent.set(messageId, payload);
  }

  /** Read a channel message, or null if this device can't (joined later, lost state, wrong epoch). */
  async decryptChannelMessage(message: schemas.Message): Promise<MessagePayload | null> {
    const own = this.sent.get(message.id);
    if (own) return own;
    const id = this.channelConv.get(message.channelId);
    if (!id || !this.isKnown(id)) return null;
    await this.sync(id);
    try {
      const incoming = this.o.mls.receive(this.groupId(id), fromB64(message.ciphertext));
      if (incoming.kind !== "message") return null;
      const payload = MessagePayload.parse(JSON.parse(new TextDecoder().decode(incoming.content)));
      this.sent.set(message.id, payload);
      return payload;
    } catch {
      return null;
    } finally {
      // Receiving advances the ratchet even when the message turns out unreadable.
      await this.persist();
    }
  }
}
