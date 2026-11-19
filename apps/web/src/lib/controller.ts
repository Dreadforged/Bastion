import { newId, Permission, computePermissions, EventPayloads, type EventName, type ReadyPayload, type schemas } from "@bastion/shared";
import type { CallOptions, QualityTier } from "../voice/call.js";
import { VoiceService, type VoiceUi } from "../voice/service.js";
import { AuthClient } from "./auth.js";
import { decodeBundle, E2ee, type DecryptedMessage, type MlsClient, type PersistedMeta } from "./e2ee.js";
import { Gateway, type GatewayOptions, type GatewayStatus } from "./gateway.js";
import { Api, ApiError, newIdempotencyKey } from "./http.js";
import { buildChatExport, type ChatExport } from "./privacy.js";
import { gateFor, type Gate } from "./safety.js";
import { applyEvent, applyReady, emptyState, mergeHistory, type ChatState } from "./store.js";
import type { StateVault } from "./vault.js";

export type Phase = "signed-out" | "safety-gate" | "connecting" | "ready";

export interface DirectChat {
  conversationId: string;
  peerId: string;
  messages: DecryptedMessage[];
}

export interface AppState {
  phase: Phase;
  /** Set while phase is "safety-gate": what the person has to deal with before the app opens. */
  gate: Gate | null;
  gateway: GatewayStatus;
  chat: ChatState;
  /** Decrypted channel messages by message id; null means this device can't read it. */
  plaintext: Record<string, schemas.MessagePayload | null>;
  dms: Record<string, DirectChat>;
  /** The call this device is in (voice channel or DM), if any. */
  voice: VoiceUi | null;
  /** DM calls ringing for this person that nobody has answered. */
  incomingCalls: schemas.DmCall[];
  /** Something about a call worth showing: a stable code, not a sentence. Cleared by dismissCallNotice. */
  callNotice: string | null;
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
  /** LiveKit room factory for voice. Without it voice and calls are unavailable. */
  voiceRoom?: Pick<CallOptions, "createRoom" | "createSink" | "e2eeSupported">;
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
    gate: null,
    gateway: "idle",
    chat: emptyState,
    plaintext: {},
    dms: {},
    voice: null,
    incomingCalls: [],
    callNotice: null,
    error: null,
  };
  private listeners = new Set<() => void>();
  private gateway: Gateway | null = null;
  private e2ee: E2ee | null = null;
  private deviceId: string | null = null;
  private voiceService: VoiceService | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  /** What each conversation turned out to be, so a call group is never shown as a chat. */
  private readonly convInfo = new Map<string, { kind: schemas.ConversationKind; peerId: string | null }>();

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
    this.set({ phase: "connecting", gate: null });
    let gate: Gate | null;
    try {
      gate = gateFor(await this.o.api.get<schemas.AccountSafety>("/account/safety"));
    } catch (err) {
      // A blocked account fails at the token check; anything else is a failed load. Either way, no app.
      await this.reset();
      this.set({ error: err instanceof ApiError ? err.code : "something_went_wrong" });
      return;
    }
    if (gate?.kind === "blocked") {
      await this.reset();
      this.set({ error: "account_blocked" });
      return;
    }
    if (gate) {
      this.set({ phase: "safety-gate", gate });
      return;
    }
    await this.openGateway();
  }

  /** Age declaration for the sign-up gate. The server keeps only the band. */
  async declareAge(birthYear: number, birthMonth: number, country?: string): Promise<void> {
    this.set({ error: null });
    try {
      const safety = await this.o.api.put<schemas.AccountSafety>("/account/age", { birthYear, birthMonth, ...(country ? { country } : {}) });
      await this.afterGate(safety);
    } catch (err) {
      if (err instanceof ApiError && err.code === "underage") {
        await this.reset();
        this.set({ error: "underage" });
        return;
      }
      if (err instanceof ApiError && err.code === "already_declared") {
        await this.afterGate(await this.o.api.get<schemas.AccountSafety>("/account/safety"));
        return;
      }
      this.set({ error: err instanceof Error ? err.message : "something_went_wrong" });
    }
  }

  /** Accept every outstanding document at the version shown. */
  async acceptTerms(): Promise<void> {
    this.set({ error: null });
    try {
      const gate = this.state.gate;
      if (gate?.kind !== "terms") return;
      let safety: schemas.AccountSafety | undefined;
      for (const d of gate.outstanding) safety = await this.o.api.post<schemas.AccountSafety>("/account/terms", d);
      if (safety) await this.afterGate(safety);
    } catch (err) {
      this.set({ error: err instanceof Error ? err.message : "something_went_wrong" });
    }
  }

  private async afterGate(safety: schemas.AccountSafety): Promise<void> {
    const gate = gateFor(safety);
    if (gate?.kind === "blocked") {
      await this.signOut();
      this.set({ error: "account_blocked" });
    } else if (gate) this.set({ gate });
    else await this.openGateway();
  }

  private async openGateway(): Promise<void> {
    this.set({ phase: "connecting", gate: null });
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
      this.voiceService = this.makeVoice(this.e2ee);
      await this.guard(() => this.e2ee!.publishKeys());
    }
  }

  private makeVoice(e2ee: E2ee): VoiceService | null {
    const room = this.o.voiceRoom;
    if (!room) return null;
    return new VoiceService(
      {
        api: this.o.api,
        mls: () => e2ee.voice(),
        sync: (id) => e2ee.syncGroup(id),
        groupIdOf: (id) => e2ee.groupIdOf(id),
        channelConversation: (channelId) => e2ee.channelConversation(channelId),
        openChannel: async (serverId, channelId) => {
          const members = Object.keys(this.state.chat.servers[serverId]?.members ?? {});
          await e2ee.openChannel(serverId, channelId, members);
        },
        openDm: async (peerId) => {
          const conv = await e2ee.openDm(peerId);
          await this.syncDm(conv.id, peerId);
          return conv.id;
        },
        markCallGroup: (id) => {
          e2ee.markCallGroup(id);
          this.convInfo.set(id, { kind: "group", peerId: null });
        },
        room,
        onChange: (voice) => this.set({ voice }),
        onNotice: (code) => this.set({ callNotice: code || null }),
      },
      () => this.state.chat.userId,
    );
  }

  private onEvent(name: EventName, data: unknown) {
    this.set((s) => ({ chat: applyEvent(s.chat, name, data) }));
    if (name === "MESSAGE_CREATE" || name === "MESSAGE_UPDATE") {
      const parsed = (data as schemas.Message | undefined)?.id ? (data as schemas.Message) : null;
      if (parsed) void this.decrypt([parsed]);
    } else if (name === "CONVERSATION_UPDATE") {
      const id = (data as { conversationId: string }).conversationId;
      void this.voiceService?.handleConversationUpdate(id).catch(() => undefined);
      void this.onConversationUpdate(id);
    } else if (name === "CALL_UPDATE") {
      const call = EventPayloads.CALL_UPDATE.safeParse(data);
      if (call.success && this.voiceService) {
        this.voiceService.handleCallUpdate(call.data);
        this.refreshRinging();
      }
    }
  }

  /** What a conversation is. DMs become chats; a call group and channel groups are only kept in step. */
  private async onConversationUpdate(id: string): Promise<void> {
    if (!this.e2ee) return;
    let info = this.convInfo.get(id);
    if (!info && this.state.dms[id]) info = { kind: "dm", peerId: this.state.dms[id]!.peerId };
    if (!info) {
      try {
        const conv = await this.o.api.get<schemas.Conversation>("/conversations/" + id);
        const me = this.state.chat.userId;
        info = { kind: conv.kind, peerId: conv.kind === "dm" ? (conv.members.find((m) => m.userId !== me)?.userId ?? null) : null };
        this.convInfo.set(id, info);
      } catch {
        return;
      }
    }
    if (info.kind === "dm") await this.syncDm(id, info.peerId ?? undefined);
    // A call group is synced when the call is joined; a channel group, so its epochs stay current.
    else if (info.kind === "channel") await this.e2ee.syncGroup(id).catch(() => undefined);
  }

  /** Keep the incoming call list in step, and drop each ring when it runs out. */
  private refreshRinging(): void {
    const ringing = this.voiceService?.ringing() ?? [];
    this.set({ incomingCalls: ringing });
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
    const next = Math.min(...ringing.map((c) => c.ringExpiresAt));
    if (Number.isFinite(next)) this.ringTimer = setTimeout(() => this.refreshRinging(), Math.max(0, next - Date.now()) + 50);
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
    const voice = this.voiceService;
    this.voiceService = null;
    if (this.ringTimer) clearTimeout(this.ringTimer);
    this.ringTimer = null;
    this.convInfo.clear();
    this.set({ phase: "signed-out", gate: null, chat: emptyState, plaintext: {}, dms: {}, voice: null, incomingCalls: [], callNotice: null, gateway: "idle" });
    await voice?.reset();
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

  // ---------------------------------------------------------------- privacy and data

  getPrivacy() {
    return this.o.api.get<schemas.PrivacySettings>("/account/privacy");
  }

  updatePrivacy(change: schemas.UpdatePrivacyRequest) {
    return this.o.api.put<schemas.PrivacySettings>("/account/privacy", change);
  }

  /**
   * Delete this account. Refused with `legal_hold` (kept for a legal reason we may not
   * be able to explain) or `owns_servers` (delete or hand on your servers first).
   * Resolves to the refusal code, or null once the account is gone and this device is wiped.
   */
  async deleteAccount(): Promise<string | null> {
    try {
      await this.o.api.delete("/account", { confirm: "delete my account" });
    } catch (err) {
      return err instanceof ApiError ? err.code : "something_went_wrong";
    }
    this.o.api.setTokens(null);
    await this.reset();
    return null;
  }

  /** What the server holds about this account. */
  accountExport() {
    return this.o.api.get<schemas.AccountExport>("/account/export");
  }

  /** The readable history this device holds. Never leaves the device. */
  chatExport(): ChatExport {
    const s = this.state;
    return buildChatExport({ userId: s.chat.userId, dms: s.dms, channelMessages: s.chat.messages, plaintext: s.plaintext }, Date.now());
  }

  // ---------------------------------------------------------------- message requests

  /** Messages from people you share no server with, waiting for you to accept or decline. */
  messageRequests() {
    return this.o.api.get<schemas.MessageRequest[]>("/conversations/requests");
  }

  /** Accept a request: the conversation joins your direct messages. */
  async acceptRequest(request: schemas.MessageRequest): Promise<void> {
    await this.guard(async () => {
      await this.o.api.post(`/conversations/${request.conversationId}/accept`);
      this.convInfo.set(request.conversationId, { kind: "dm", peerId: request.from });
      await this.syncDm(request.conversationId, request.from);
    });
  }

  /** Decline a request. The sender is not told, and cannot ask again. */
  async declineRequest(request: schemas.MessageRequest): Promise<void> {
    await this.guard(() => this.o.api.post(`/conversations/${request.conversationId}/decline`));
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

  // ---------------------------------------------------------------- voice and calls

  private requireVoice(): VoiceService {
    if (!this.voiceService) throw new Error("voice_unavailable");
    return this.voiceService;
  }

  /** Join a voice channel. Asks for screen share only if this person may stream there. */
  joinVoice(serverId: string, channelId: string) {
    return this.guard(() => this.requireVoice().joinChannel(serverId, channelId, this.can(serverId, channelId, Permission.STREAM)));
  }

  /** Leave the current call. In a DM call this ends it for both people. */
  leaveVoice() {
    return this.guard(() => this.requireVoice().leave());
  }

  setMuted(muted: boolean) {
    return this.guard(() => this.requireVoice().setMuted(muted));
  }

  startShare(tier?: QualityTier) {
    return this.guard(() => this.requireVoice().startShare(tier));
  }

  stopShare() {
    return this.guard(() => this.requireVoice().stopShare());
  }

  /** Ring someone in a DM. */
  callUser(peerId: string) {
    return this.guard(() => this.requireVoice().startDmCall(peerId));
  }

  async answerCall(call: schemas.DmCall) {
    await this.guard(() => this.requireVoice().answer(call));
    this.refreshRinging();
  }

  async declineCall(call: schemas.DmCall) {
    await this.guard(() => this.requireVoice().decline(call));
    this.refreshRinging();
  }

  dismissCallNotice() {
    this.set({ callNotice: null });
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
