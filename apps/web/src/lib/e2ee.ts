import { schemas } from "@bastion/shared";

type MessagePayload = schemas.MessagePayload;
const { E2EE_LIMITS, MessagePayload } = schemas;
import { ApiError, newIdempotencyKey, type Api } from "./http.js";

/**
 * Message encryption for the client. The MLS work happens in the crypto
 * crate's WASM build; this file keeps that device's groups in step with the
 * server's delivery service (conversations, commits, welcomes, envelopes).
 *
 * Limits of what exists today, all inherited from the crypto crate:
 *  - Group state lives in memory only. A reload loses it, so a conversation
 *    that was opened before the reload can't be read after it.
 *  - Members can be added but not removed, and a rejected commit can't be rolled back.
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
}

export function adaptWasmClient(raw: WasmModuleClient): MlsClient {
  return {
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
  };
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
  private readonly known = new Set<string>();
  private readonly log = new Map<string, DecryptedMessage[]>();
  private readonly syncing = new Map<string, Promise<SyncResult>>();

  constructor(private readonly o: E2eeOptions) {}

  /** Publish this device's identity key and top up key packages. Call after sign-in. */
  async publishKeys(): Promise<void> {
    const { count } = await this.o.api.get<{ count: number }>("/keys/packages/count");
    if (count >= KEY_PACKAGE_LOW_WATER) return;
    const keyPackages: string[] = [];
    // Each package is single use, so make a fresh batch.
    for (let i = 0; i < KEY_PACKAGE_BATCH; i++) keyPackages.push(toB64(this.o.mls.keyPackage()));
    await this.o.api.post("/keys/packages", { identityKey: toB64(this.o.mls.identityKey()), keyPackages });
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
    if (this.known.has(conv.id)) return conv;
    // A fresh conversation has only its creator's device in it, at epoch 0.
    const fresh = conv.epoch === 0 && conv.devices.length === 1 && conv.devices[0]!.deviceId === this.o.deviceId;
    if (fresh) await this.createAndInvite(conv.id, [peerId, this.o.userId]);
    else await this.sync(conv.id);
    return conv;
  }

  /** Make the group, then add every device of `userIds` (and our own other devices). */
  private async createAndInvite(conversationId: string, userIds: string[]): Promise<void> {
    this.o.mls.createGroup(this.groupId(conversationId));
    this.known.add(conversationId);
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
      const epoch = this.o.mls.epoch(gid);
      const out = this.o.mls.addMember(gid, fromB64(pkg.keyPackage));
      await this.o.api.post(
        `/conversations/${conversationId}/commits`,
        {
          epoch,
          commit: toB64(out.commit),
          ...(out.welcome ? { welcome: toB64(out.welcome) } : {}),
          adds: [{ userId: pkg.userId, deviceId: pkg.deviceId }],
          removes: [],
        },
        { idempotencyKey: newIdempotencyKey() },
      );
      this.o.mls.commitAccepted(gid);
    }
    // Devices with no key packages left can't be added yet; their owner's client will top up.
    if (exhausted > 0) throw new Error("key_packages_exhausted");
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
            if (!this.known.has(conversationId)) {
              this.o.mls.join(fromB64(env.data));
              this.known.add(conversationId);
            }
          } else if (!own && this.known.has(conversationId)) {
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
    if (!this.known.has(conversationId)) throw new Error("conversation_not_ready");
    const payload = MessagePayload.parse({ text });
    const ciphertext = this.o.mls.encrypt(gid, new TextEncoder().encode(JSON.stringify(payload)));
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
    return message;
  }

  // ------------------------------------------------------------ server channels

  private readonly channelConv = new Map<string, string>();
  private readonly sent = new Map<string, MessagePayload>();

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
    }
    if (conv && !this.known.has(id)) {
      const fresh = conv.epoch === 0 && conv.devices.length === 1 && conv.devices[0]!.deviceId === this.o.deviceId;
      if (fresh) {
        await this.createAndInvite(id, memberIds);
        return;
      }
    }
    await this.sync(id);
    if (this.known.has(id)) {
      const view = await this.o.api.get<schemas.Conversation>(`/conversations/${id}`);
      await this.invite(id, memberIds, view.devices);
    }
  }

  /** Encrypt for a channel; the caller posts the result to the server's message route. */
  encryptForChannel(channelId: string, text: string): { ciphertext: string; epoch: number; payload: MessagePayload } {
    const id = this.channelConv.get(channelId);
    if (!id || !this.known.has(id)) throw new Error("conversation_not_ready");
    const gid = this.groupId(id);
    const payload = MessagePayload.parse({ text });
    const bytes = this.o.mls.encrypt(gid, new TextEncoder().encode(JSON.stringify(payload)));
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
    if (!id || !this.known.has(id)) return null;
    await this.sync(id);
    try {
      const incoming = this.o.mls.receive(this.groupId(id), fromB64(message.ciphertext));
      if (incoming.kind !== "message") return null;
      const payload = MessagePayload.parse(JSON.parse(new TextDecoder().decode(incoming.content)));
      this.sent.set(message.id, payload);
      return payload;
    } catch {
      return null;
    }
  }
}
