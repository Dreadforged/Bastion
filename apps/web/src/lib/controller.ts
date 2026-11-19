import { newId, Permission, computePermissions, type EventName, type ReadyPayload, type schemas } from "@bastion/shared";
import { AuthClient } from "./auth.js";
import { decodeBundle, E2ee, type DecryptedMessage, type MlsClient, type PersistedMeta } from "./e2ee.js";
import { Gateway, type GatewayOptions, type GatewayStatus } from "./gateway.js";
import { Api, ApiError, newIdempotencyKey } from "./http.js";
import { applyEvent, applyReady, emptyState, mergeHistory, type ChatState } from "./store.js";
import type { StateVault } from "./vault.js";

export type Phase = "signed-out" | "connecting" | "ready";

export interface DirectChat {
  conversationId: string;
  peerId: string;
  messages: DecryptedMessage[];
}

export interface AppState {
  phase: Phase;
  gateway: GatewayStatus;
  chat: ChatState;
  /** Decrypted channel messages by message id; null means this device can't read it. */
  plaintext: Record<string, schemas.MessagePayload | null>;
  dms: Record<string, DirectChat>;
  /** Last error to show, cleared by the next action. */
  error: string | null;
}

export interface ControllerOptions {
  api: Api;
  auth: AuthClient;
  /** Builds this device's MLS client once the user and device ids are known; `saved` is its stored state, if any. */
  createMls: (userId: string, deviceId: string, saved: Uint8Array | null) => MlsClient | Promise<MlsClient>;
  /** Encrypted storage for MLS state. Without it, state lives in memory only. */
  vault?: StateVault;
  gatewayUrl: string;
  createSocket?: GatewayOptions["createSocket"];
}

/**
 * Wires the API, gateway, store and encryption together and exposes one
 * observable state for the UI. All actions return after state has updated.
 */
export class Controller {
  private state: AppState = {
    phase: "signed-out",
    gateway: "idle",
    chat: emptyState,
    plaintext: {},
    dms: {},
    error: null,
  };
  private listeners = new Set<() => void>();
  private gateway: Gateway | null = null;
  private e2ee: E2ee | null = null;
  private deviceId: string | null = null;

  constructor(private readonly o: ControllerOptions) {}

  // ---------------------------------------------------------------- state

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const next = typeof patch === "function" ? patch(this.state) : patch;
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
    this.set({ error: null });
    try {
      return await fn();
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : "something_went_wrong" });
      return undefined;
    }
  }

  // ---------------------------------------------------------------- session

  /** Open the gateway if there is a saved session. */
  async start(): Promise<void> {
    if (!this.o.api.tokens) return;
    await this.connect();
  }

  /** Call after a passkey sign-in or registration has stored tokens. */
  async connect(): Promise<void> {
    this.set({ phase: "connecting" });
    const devices = await this.o.auth.devices();
    this.deviceId = devices.find((d) => d.current)?.id ?? null;
    this.gateway?.close();
    const wsUrl = this.o.gatewayUrl;
    this.gateway = new Gateway(
      {
        url: wsUrl,
        token: () => this.o.api.accessToken(),
        ...(this.o.createSocket ? { createSocket: this.o.createSocket } : {}),
      },
      {
        onReady: (ready) => void this.onReady(ready),
        onEvent: (name, data) => this.onEvent(name, data),
        onStatus: (gateway) => {
          this.set({ gateway });
          // The server ended our session (sign-out elsewhere, device revoked).
          if (gateway === "ended" && this.state.phase !== "signed-out") void this.reset();
        },
      },
    );
    this.gateway.start();
  }

  private async onReady(ready: ReadyPayload) {
    this.set((s) => ({ phase: "ready", chat: applyReady(s.chat, ready) }));
    if (!this.e2ee && this.deviceId) {
      const deviceId = this.deviceId;
      const vaultId = `${ready.userId}/${deviceId}`;
      const vault = this.o.vault;
      let saved: { mls: Uint8Array; meta: PersistedMeta } | null = null;
      if (vault) {
        try {
          const raw = await vault.load(vaultId);
          saved = raw ? decodeBundle(raw) : null;
        } catch {
          // Unreadable or from another version: start this device's groups afresh.
          saved = null;
        }
      }
      let mls: MlsClient;
      try {
        mls = await this.o.createMls(ready.userId, deviceId, saved?.mls ?? null);
      } catch (err) {
        if (!saved) throw err;
        saved = null;
        mls = await this.o.createMls(ready.userId, deviceId, null);
      }
      // Signed out while loading: do not bring anything back.
      if (this.state.phase === "signed-out") return;
      this.e2ee = new E2ee({
        api: this.o.api,
        userId: ready.userId,
        deviceId,
        mls,
        ...(saved ? { restored: saved.meta } : {}),
        ...(vault ? { persist: (bundle: Uint8Array) => vault.save(vaultId, bundle) } : {}),
        onPersistError: () => this.set({ error: "could_not_save_encryption_state" }),
      });
      await this.guard(() => this.e2ee!.publishKeys());
    }
  }

  private onEvent(name: EventName, data: unknown) {
    this.set((s) => ({ chat: applyEvent(s.chat, name, data) }));
    if (name === "MESSAGE_CREATE" || name === "MESSAGE_UPDATE") {
      const parsed = (data as schemas.Message | undefined)?.id ? (data as schemas.Message) : null;
      if (parsed) void this.decrypt([parsed]);
    } else if (name === "CONVERSATION_UPDATE") {
      const id = (data as { conversationId: string }).conversationId;
      void this.syncDm(id);
    }
  }

  async signOut(): Promise<void> {
    this.gateway?.close();
    await this.o.auth.signOut().catch(() => undefined);
    await this.reset();
  }

  /** Back to signed-out: drop in-memory state and wipe the stored keys and group state. */
  private async reset(): Promise<void> {
    this.gateway?.close();
    this.gateway = null;
    const e2ee = this.e2ee;
    this.e2ee = null;
    this.deviceId = null;
    this.set({ phase: "signed-out", chat: emptyState, plaintext: {}, dms: {}, gateway: "idle" });
    // Let queued saves land first, otherwise one could write state back after the wipe.
    await e2ee?.close();
    await this.o.vault?.clear().catch(() => undefined);
  }

  // ---------------------------------------------------------------- servers and channels

  createServer(name: string) {
    return this.guard(() => this.o.api.post<schemas.Server>("/servers", { name }, { idempotencyKey: newIdempotencyKey() }));
  }

  previewInvite(code: string) {
    return this.guard(() => this.o.api.get<schemas.InvitePreview>(`/invites/${code}`));
  }

  joinInvite(code: string) {
    return this.guard(() => this.o.api.post(`/invites/${code}`));
  }

  createChannel(serverId: string, name: string, kind: "text" | "voice") {
    return this.guard(() => this.o.api.post(`/servers/${serverId}/channels`, { name, kind }));
  }

  createInvite(serverId: string) {
    return this.guard(() => this.o.api.post<schemas.Invite>(`/servers/${serverId}/invites`, {}));
  }

  /** What the signed-in user may do in a channel, resolved with the shared permission code. */
  can(serverId: string, channelId: string, flag: bigint): boolean {
    const s = this.state.chat.servers[serverId];
    const userId = this.state.chat.userId;
    const member = userId ? s?.members[userId] : undefined;
    if (!s || !userId || !member) return false;
    const everyone = s.roles[serverId];
    const channel = s.channels[channelId];
    const overrides = channel?.overrides ?? [];
    const toOverride = (o: schemas.ChannelOverride) => ({ allow: BigInt(o.allow), deny: BigInt(o.deny) });
    const roles: Record<string, { allow: bigint; deny: bigint }> = {};
    const members: Record<string, { allow: bigint; deny: bigint }> = {};
    let everyoneOverride: { allow: bigint; deny: bigint } | undefined;
    for (const o of overrides) {
      if (o.kind === "member") members[o.targetId] = toOverride(o);
      else if (o.targetId === serverId) everyoneOverride = toOverride(o);
      else roles[o.targetId] = toOverride(o);
    }
    const permissions = computePermissions({
      userId,
      ownerId: s.server.ownerId,
      everyoneRole: { id: serverId, permissions: BigInt(everyone?.permissions ?? "0") },
      memberRoles: member.roles.flatMap((id) => (s.roles[id] ? [{ id, permissions: BigInt(s.roles[id]!.permissions) }] : [])),
      channel: { ...(everyoneOverride ? { everyone: everyoneOverride } : {}), roles, members },
      timedOut: member.timeoutUntil !== null && member.timeoutUntil > Date.now(),
    });
    return (permissions & flag) === flag;
  }

  // ---------------------------------------------------------------- channel messages

  /** Load recent history for a channel, and make this device ready for its encryption. */
  async openChannel(serverId: string, channelId: string): Promise<void> {
    await this.guard(async () => {
      const page = await this.o.api.get<schemas.Message[]>(`/servers/${serverId}/channels/${channelId}/messages`, { limit: 50 });
      this.set((s) => ({ chat: mergeHistory(s.chat, channelId, page) }));
      const members = Object.keys(this.state.chat.servers[serverId]?.members ?? {});
      if (this.e2ee) {
        try {
          await this.e2ee.openChannel(serverId, channelId, members);
        } catch {
          // Not allowed to set up the group (no MANAGE_CHANNELS) or nobody is in it yet:
          // messages stay unreadable until someone with access sets it up.
        }
      }
      await this.decrypt(page);
    });
  }

  private async decrypt(messages: schemas.Message[]) {
    if (!this.e2ee) return;
    for (const m of messages) {
      if (m.id in this.state.plaintext && this.state.plaintext[m.id] !== null) continue;
      const payload = await this.e2ee.decryptChannelMessage(m);
      this.set((s) => ({ plaintext: { ...s.plaintext, [m.id]: payload } }));
    }
  }

  async sendMessage(serverId: string, channelId: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    await this.guard(async () => {
      if (!this.e2ee) throw new Error("encryption_not_ready");
      const post = async () => {
        const { ciphertext, epoch, payload } = await this.e2ee!.encryptForChannel(channelId, body);
        const sent = await this.o.api.post<schemas.Message>(
          `/servers/${serverId}/channels/${channelId}/messages`,
          { ciphertext, epoch },
          { idempotencyKey: newIdempotencyKey() },
        );
        return { sent, payload };
      };
      let result;
      try {
        result = await post();
      } catch (err) {
        // Someone lost access: remove them from the group (new keys), then try once more.
        const convId = this.e2ee.channelConversation(channelId);
        if (!(err instanceof ApiError) || err.code !== "rotation_required" || !convId) throw err;
        await this.e2ee.removeRevoked(convId, (err.body ?? {}) as { userIds?: string[]; deviceIds?: string[] });
        result = await post();
      }
      const { sent, payload } = result;
      this.e2ee.rememberSent(sent.id, payload);
      this.set((s) => ({
        chat: applyEvent(s.chat, "MESSAGE_CREATE", sent),
        plaintext: { ...s.plaintext, [sent.id]: payload },
      }));
    });
  }

  deleteMessage(serverId: string, channelId: string, messageId: string) {
    return this.guard(() => this.o.api.delete(`/servers/${serverId}/channels/${channelId}/messages/${messageId}`));
  }

  sendTyping(serverId: string, channelId: string) {
    return this.o.api.post(`/servers/${serverId}/channels/${channelId}/typing`).catch(() => undefined);
  }

  // ---------------------------------------------------------------- direct messages

  async openDm(peerId: string): Promise<string | undefined> {
    return this.guard(async () => {
      if (!this.e2ee) throw new Error("encryption_not_ready");
      const conv = await this.e2ee.openDm(peerId);
      await this.syncDm(conv.id, peerId);
      return conv.id;
    });
  }

  private async syncDm(conversationId: string, peerId?: string) {
    if (!this.e2ee) return;
    try {
      await this.e2ee.sync(conversationId);
    } catch {
      return;
    }
    this.set((s) => ({
      dms: {
        ...s.dms,
        [conversationId]: {
          conversationId,
          peerId: peerId ?? s.dms[conversationId]?.peerId ?? "",
          messages: [...this.e2ee!.messages(conversationId)],
        },
      },
    }));
  }

  /** Remove a person's devices from a conversation (new keys, so they cannot read what comes next). */
  async removeMember(conversationId: string, userId: string): Promise<void> {
    await this.guard(async () => {
      if (!this.e2ee) throw new Error("encryption_not_ready");
      try {
        await this.e2ee.removeMember(conversationId, userId);
      } catch (err) {
        // The commit was rolled back; catch up with whatever won the epoch.
        await this.e2ee.sync(conversationId).catch(() => undefined);
        throw err;
      }
    });
  }

  /** Rotate this device's keys in a conversation. */
  async rotateKeys(conversationId: string): Promise<void> {
    await this.guard(async () => {
      if (!this.e2ee) throw new Error("encryption_not_ready");
      await this.e2ee.rotateKeys(conversationId);
    });
  }

  async sendDm(conversationId: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    await this.guard(async () => {
      await this.e2ee!.send(conversationId, body);
      await this.syncDm(conversationId);
    });
  }
}

export { Permission, newId };
