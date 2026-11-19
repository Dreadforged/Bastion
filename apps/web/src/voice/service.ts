import { schemas } from "@bastion/shared";
import { ApiError, type Api } from "../lib/http.js";
import { Call, channelTransport, dmTransport, qualityTiers, type CallOptions, type CallTransport, type QualityTier } from "./call.js";
import { startDmCallGroup, type CallGroupDeps } from "./call-group.js";
import { VoiceE2eeError } from "./keys.js";
import type { VoiceMls } from "./mls.js";

/**
 * The one call this device is in, and everything the screen needs to show it.
 *
 * A person is in at most one call at a time, in a voice channel or a DM. This
 * class owns the `Call` for it, turns the gateway's ring events into the
 * outgoing and incoming call flow, and reports a plain `VoiceUi` snapshot to
 * the controller. The room itself (LiveKit) and the MLS client come in through
 * `VoiceDeps` so all of this runs in tests without either.
 */

export interface VoiceUi {
  kind: "channel" | "dm";
  /** `calling`: ringing the other person. `connecting`: setting up keys and media. */
  phase: "calling" | "connecting" | "connected";
  serverId: string | null;
  channelId: string | null;
  /** The DM, for a DM call. */
  conversationId: string | null;
  peerId: string | null;
  muted: boolean;
  sharing: boolean;
  /** `transport` means the media server can see media; the screen must say so. */
  encryption: "e2ee" | "transport" | null;
  canShare: boolean;
  /** Screen share qualities this call may use. */
  tiers: QualityTier[];
}

export interface VoiceDeps {
  api: Pick<Api, "post" | "patch" | "delete">;
  /** This device's MLS client, as voice sees it (saves group state when it changes). */
  mls(): VoiceMls;
  /** Fetch and apply everything new in a conversation. */
  sync(conversationId: string): Promise<void>;
  groupIdOf(conversationId: string): Uint8Array;
  /** The encrypted conversation behind a voice channel, once this device has opened it. */
  channelConversation(channelId: string): string | undefined;
  /** Open the channel's encryption if it is not open yet. */
  openChannel(serverId: string, channelId: string): Promise<void>;
  /** Start or find the DM with a person; returns its conversation id. */
  openDm(peerId: string): Promise<string | undefined>;
  /** A conversation was made only to key a call. */
  markCallGroup(conversationId: string): void;
  room: Pick<CallOptions, "createRoom" | "createSink" | "e2eeSupported">;
  /** Called with the new snapshot after every change; null when no call. */
  onChange(ui: VoiceUi | null): void;
  /** Something the person should be told about (a declined call, a dropped room). */
  onNotice(code: string): void;
  now?: () => number;
  /** Timer functions, replaceable in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  callOptions?: Partial<Pick<CallOptions, "rotationFallbackMs" | "leaseMs" | "allowTransportOnly">>;
}

interface Active {
  ui: VoiceUi;
  call: Call | null;
  /** The ring or lease timer. */
  timer: unknown;
  /** The DM call this belongs to, if any. */
  dmCall: schemas.DmCall | null;
  /** Set once we start leaving, so a late event does not restart anything. */
  closing: boolean;
}

export class VoiceService {
  private active: Active | null = null;
  /** Calls ringing for this device (as callee), by DM conversation id. */
  private incoming = new Map<string, schemas.DmCall>();

  constructor(
    private readonly d: VoiceDeps,
    private readonly me: () => string | null,
  ) {}

  get ui(): VoiceUi | null {
    return this.active?.ui ?? null;
  }

  private now(): number {
    return (this.d.now ?? Date.now)();
  }

  private emit(): void {
    this.d.onChange(this.active ? { ...this.active.ui } : null);
  }

  private patch(patch: Partial<VoiceUi>): void {
    if (!this.active) return;
    this.active.ui = { ...this.active.ui, ...patch };
    this.emit();
  }

  private groupDeps(): CallGroupDeps {
    return { api: this.d.api, mls: this.d.mls(), sync: (id) => this.d.sync(id), groupIdOf: (id) => this.d.groupIdOf(id) };
  }

  private options(): Omit<CallOptions, "conversationId" | "transport" | "serverId" | "channelId" | "screenShare"> {
    return { api: this.d.api, group: this.groupDeps(), ...this.d.room, ...this.d.callOptions };
  }

  private requireFree(): void {
    if (this.active) throw new VoiceE2eeError("not_allowed", "already_in_call");
  }

  // ------------------------------------------------------------ voice channels

  /** Join a voice channel. `canStream` is whether this person has the STREAM permission there. */
  async joinChannel(serverId: string, channelId: string, canStream: boolean): Promise<void> {
    this.requireFree();
    this.begin({ kind: "channel", phase: "connecting", serverId, channelId, conversationId: null, peerId: null });
    const state = this.active!;
    try {
      let conversationId = this.d.channelConversation(channelId);
      if (!conversationId) {
        await this.d.openChannel(serverId, channelId);
        conversationId = this.d.channelConversation(channelId);
      }
      if (!conversationId) throw new VoiceE2eeError("not_in_group", "this device has not set up the channel's encryption");
      const call = new Call({
        ...this.options(),
        conversationId,
        transport: channelTransport(this.d.api, serverId, channelId),
        screenShare: canStream,
      });
      await this.run(state, call);
    } catch (err) {
      await this.abandon(state);
      throw err;
    }
  }

  // ------------------------------------------------------------ DM calls

  /** Ring the other person in a DM. Resolves once the call is ringing (not once it is answered). */
  async startDmCall(peerId: string): Promise<void> {
    this.requireFree();
    const dmId = await this.d.openDm(peerId);
    if (!dmId) throw new VoiceE2eeError("key_unavailable", "could not open the conversation");
    this.requireFree();
    this.begin({ kind: "dm", phase: "calling", serverId: null, channelId: null, conversationId: dmId, peerId });
    const state = this.active!;
    try {
      // A fresh group per call, so call keys have nothing to do with message history.
      const group = await startDmCallGroup(
        { ...this.groupDeps(), onCreated: (id) => this.d.markCallGroup(id) },
        peerId,
      );
      if (state.closing) return;
      const call = new Call({
        ...this.options(),
        conversationId: group.conversationId,
        transport: this.remember(state, dmTransport(this.d.api, dmId, { start: { groupConversationId: group.conversationId } })),
        screenShare: true,
      });
      await this.run(state, call, { ringing: true });
    } catch (err) {
      await this.abandon(state);
      throw err;
    }
  }

  /** A ring for this person arrived (or an update for a call we know about). */
  handleCallUpdate(call: schemas.DmCall): void {
    const me = this.me();
    if (!me) return;
    const mine = call.callerId === me || call.calleeId === me;
    if (!mine) return;

    if (call.state === "ringing" && call.calleeId === me) {
      // Already in a call, or the ring ran out on the way: do not ring. The caller sees it lapse.
      if (this.active || call.ringExpiresAt <= this.now()) return;
      this.incoming.set(call.conversationId, call);
      this.d.onNotice("incoming_call");
      return;
    }

    if (call.state !== "ringing") this.incoming.delete(call.conversationId);

    const a = this.active;
    if (a?.dmCall && call.id === a.dmCall.id) {
      a.dmCall = call;
      if (call.state === "active" && a.ui.phase === "calling") {
        this.clearTimer(a);
        this.patch({ phase: "connected" });
      }
      if (call.state === "ended") void this.endedByServer(a, call);
    }
  }

  /** Calls ringing for this device that nobody has answered, newest first. */
  ringing(): schemas.DmCall[] {
    const now = this.now();
    return [...this.incoming.values()].filter((c) => c.ringExpiresAt > now).sort((x, y) => y.createdAt - x.createdAt);
  }

  /** Answer a ringing call. */
  async answer(call: schemas.DmCall): Promise<void> {
    this.requireFree();
    this.incoming.delete(call.conversationId);
    this.begin({ kind: "dm", phase: "connecting", serverId: null, channelId: null, conversationId: call.conversationId, peerId: call.callerId });
    const state = this.active!;
    state.dmCall = call;
    try {
      // The call's key group was made by the caller; mark it before syncing so it never shows as a chat.
      this.d.markCallGroup(call.groupConversationId);
      const live = new Call({
        ...this.options(),
        conversationId: call.groupConversationId,
        transport: this.remember(state, dmTransport(this.d.api, call.conversationId, { answer: true })),
        screenShare: true,
      });
      await this.run(state, live);
    } catch (err) {
      await this.abandon(state);
      throw err;
    }
  }

  async decline(call: schemas.DmCall): Promise<void> {
    this.incoming.delete(call.conversationId);
    try {
      await this.d.api.post(`/conversations/${call.conversationId}/call/decline`);
    } catch (err) {
      // Already over (answered elsewhere, lapsed): nothing left to decline.
      if (!(err instanceof ApiError) || ![404, 409].includes(err.status)) throw err;
    }
  }

  // ------------------------------------------------------------ the call itself

  /** Keep the call the server describes in its token reply, so later events can be matched to it by id. */
  private remember(state: Active, transport: CallTransport): CallTransport {
    return {
      ...transport,
      token: async (screenShare) => {
        const reply = await transport.token(screenShare);
        const parsed = schemas.DmCall.safeParse((reply as { call?: unknown } | null)?.call);
        if (parsed.success) state.dmCall = parsed.data;
        return reply;
      },
    };
  }

  private begin(init: Pick<VoiceUi, "kind" | "phase" | "serverId" | "channelId" | "conversationId" | "peerId">): void {
    this.active = {
      ui: { ...init, muted: false, sharing: false, encryption: null, canShare: false, tiers: [] },
      call: null,
      timer: null,
      dmCall: null,
      closing: false,
    };
    this.emit();
  }

  private async run(state: Active, call: Call, opts: { ringing?: boolean } = {}): Promise<void> {
    state.call = call;
    call.onEnded = () => {
      if (this.active === state && !state.closing) {
        this.d.onNotice("call_dropped");
        void this.finish(state);
      }
    };
    await call.join();
    if (this.active !== state) {
      await call.leave();
      return;
    }
    this.patch({
      phase: opts.ringing ? "calling" : "connected",
      encryption: call.encryption,
      canShare: call.token.canShare,
      tiers: call.token.canShare ? qualityTiers(call.token.quality) : [],
    });
    if (opts.ringing) this.armRingTimeout(state);
  }

  /** The caller gives up on a ring that nobody answered. */
  private armRingTimeout(state: Active): void {
    const set = this.d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    // The server lapses the ring after the same time; this side hangs up a moment later if it is still waiting.
    const ms = schemas.CALL_LIMITS.ringSeconds * 1000 + 1000;
    state.timer = set(() => {
      if (this.active === state && state.ui.phase === "calling") {
        this.d.onNotice("no_answer");
        void this.leave();
      }
    }, ms);
  }

  private clearTimer(state: Active): void {
    if (state.timer === null) return;
    (this.d.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(state.timer);
    state.timer = null;
  }

  /** The server says the call is over (declined, hung up, lapsed). */
  private async endedByServer(state: Active, call: schemas.DmCall): Promise<void> {
    if (state.closing) return;
    const notice = { declined: "call_declined", missed: "no_answer", timeout: "call_dropped", cancelled: "", ended: "call_ended" }[call.endReason ?? "ended"];
    if (notice) this.d.onNotice(notice);
    await this.finish(state);
  }

  /** Leave whatever call this device is in, telling the server. For a DM call that ends it for both people. */
  async leave(): Promise<void> {
    const state = this.active;
    if (!state) return;
    await this.finish(state);
  }

  private async finish(state: Active): Promise<void> {
    if (state.closing) return;
    state.closing = true;
    this.clearTimer(state);
    try {
      await state.call?.leave();
    } finally {
      if (this.active === state) {
        this.active = null;
        this.emit();
      }
    }
  }

  /** Clean up after a join that failed part way. The failure itself is the caller's to report. */
  private async abandon(state: Active): Promise<void> {
    state.closing = true;
    this.clearTimer(state);
    try {
      await state.call?.leave();
    } catch {
      // Nothing more to do.
    }
    if (this.active === state) {
      this.active = null;
      this.emit();
    }
  }

  async setMuted(muted: boolean): Promise<void> {
    const call = this.active?.call;
    if (!call) return;
    await call.setMuted(muted);
    this.patch({ muted });
  }

  async startShare(tier?: QualityTier): Promise<void> {
    const call = this.active?.call;
    if (!call) return;
    await call.startScreenShare(tier ? { height: tier.height, fps: tier.fps } : undefined);
    this.patch({ sharing: true });
  }

  async stopShare(): Promise<void> {
    const call = this.active?.call;
    if (!call) return;
    await call.stopScreenShare();
    this.patch({ sharing: false });
  }

  /** The gateway says a conversation changed: the call's group may have a new epoch. */
  async handleConversationUpdate(conversationId: string): Promise<void> {
    await this.active?.call?.handleConversationUpdate(conversationId);
  }

  /** Sign-out: drop everything without talking to the server. */
  async reset(): Promise<void> {
    const state = this.active;
    this.incoming.clear();
    if (state) {
      state.closing = true;
      this.clearTimer(state);
      this.active = null;
      this.emit();
      try {
        await state.call?.leave();
      } catch {
        // Signing out; the server drops the lease on its own.
      }
    }
  }
}
