import { schemas } from "@bastion/shared";
import type { Api } from "../lib/http.js";
import { CallGroup, chooseRotator, type CallGroupDeps } from "./call-group.js";
import { CallKeys, VoiceE2eeError, type KeySink } from "./keys.js";

/**
 * One voice call: the LiveKit room, the MLS group that keys it, and the
 * housekeeping in between (lease renewals, key rotation on join and leave,
 * screen share limits). The room is behind `CallRoom` so the logic can be
 * tested without LiveKit; `livekit-room.ts` has the real one.
 */

type VoiceTokenResponse = schemas.VoiceTokenResponse;

/** What the call needs from a room. */
export interface CallRoom {
  /** This device's random participant id for the call. Known once connected. */
  readonly localId: string;
  /** Remote participants' random ids. */
  remoteIds(): string[];
  /** Turn on media encryption. Must be called before `connect`. */
  enableEncryption(): Promise<void>;
  connect(url: string, token: string): Promise<void>;
  publishMicrophone(): Promise<void>;
  startScreenShare(capture: ScreenCapture): Promise<void>;
  stopScreenShare(): Promise<void>;
  onParticipant(handler: (event: "joined" | "left", id: string) => void): void;
  disconnect(): Promise<void>;
}

export interface ScreenCapture {
  width: number;
  height: number;
  fps: number;
  maxBitrate: number;
}

export interface CallOptions {
  api: Pick<Api, "post" | "patch" | "delete">;
  group: CallGroupDeps;
  /** The channel's encrypted conversation, or the DM call's group conversation. */
  conversationId: string;
  serverId: string;
  channelId: string;
  /** Ask for the right to share the screen (needs STREAM). Decided at join; tokens can't be widened later. */
  screenShare?: boolean;
  /** Builds the room and its key sink; the sink is where derived keys go. */
  createRoom(sink: KeySink | null): CallRoom;
  createSink(): KeySink & { dispose?(): void };
  /** Whether this browser can encrypt media. Without it an encrypted call is refused. */
  e2eeSupported(): boolean;
  /**
   * Join with transport encryption only (the media server can see media) when
   * this device cannot use the channel's MLS group. Off unless the person
   * agreed to it; see `Call.encryption`.
   */
  allowTransportOnly?: boolean;
  /** How long a non-designated device waits per rank before rotating itself. */
  rotationFallbackMs?: number;
  leaseMs?: number;
}

const LEASE_MS = 30_000;
const FALLBACK_MS = 3_000;

export type Encryption = "e2ee" | "transport";

/** Largest screen share the grant allows, never more than asked for. */
export function clampCapture(
  granted: schemas.VoiceTokenResponse["quality"],
  asked: { height?: number; fps?: number } = {},
): ScreenCapture {
  const height = Math.min(asked.height ?? granted.height, granted.height);
  const fps = Math.min(asked.fps ?? granted.fps, granted.fps);
  return { height, width: Math.round((height * 16) / 9), fps, maxBitrate: granted.maxBitrate };
}

export class Call {
  /** "e2ee" when media is end-to-end encrypted. "transport" must be shown to the person. */
  encryption: Encryption = "e2ee";
  token!: VoiceTokenResponse;
  private room!: CallRoom;
  private group: CallGroup | null = null;
  private keys: CallKeys | null = null;
  private sink: (KeySink & { dispose?(): void }) | null = null;
  private lease: ReturnType<typeof setInterval> | null = null;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private joined = false;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly o: CallOptions) {}

  /** Join the call. Throws `VoiceE2eeError` (and leaves the call) if encryption can't be set up. */
  async join(): Promise<void> {
    const { api } = this.o;
    const supported = this.o.e2eeSupported();
    if (!supported && !this.o.allowTransportOnly) throw new VoiceE2eeError("unsupported_browser");

    this.token = schemas.VoiceTokenResponse.parse(
      await api.post(`/servers/${this.o.serverId}/voice/token`, { channelId: this.o.channelId, screenShare: this.o.screenShare ?? false }),
    );
    this.joined = true;
    try {
      await this.setupEncryption(supported);
      this.room = this.o.createRoom(this.encryption === "e2ee" ? this.sink : null);
      if (this.encryption === "e2ee") await this.room.enableEncryption();
      await this.room.connect(this.token.url, this.token.token);
      if (this.token.canPublish) await this.room.publishMicrophone();
      this.room.onParticipant((event, id) => this.onParticipant(event, id));
      this.lease = setInterval(() => void this.renew(), this.o.leaseMs ?? LEASE_MS);
    } catch (err) {
      await this.leave();
      throw err;
    }
  }

  private async setupEncryption(supported: boolean): Promise<void> {
    if (!supported) {
      this.encryption = "transport";
      return;
    }
    const group = new CallGroup(this.o.group, this.o.conversationId);
    try {
      await group.ready();
    } catch (err) {
      if (err instanceof VoiceE2eeError && err.code === "not_in_group" && this.o.allowTransportOnly) {
        this.encryption = "transport";
        return;
      }
      throw err;
    }
    this.group = group;
    this.sink = this.o.createSink();
    this.keys = new CallKeys(this.o.group.mls, group.groupId, this.token.roomId, this.sink);
    await this.keys.refresh("now");
  }

  // -------------------------------------------------------------- rotation

  /** Run async work one at a time so epochs are handled in order. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Call when the gateway says the conversation changed. */
  handleConversationUpdate(conversationId: string): Promise<void> {
    if (conversationId !== this.o.conversationId || !this.group || !this.keys) return Promise.resolve();
    return this.serial(async () => {
      await this.o.group.sync(conversationId);
      await this.keys?.refresh("soon");
    });
  }

  private onParticipant(_event: "joined" | "left", id: string): void {
    if (!this.group || !this.keys || !this.joined) return;
    const all = [this.room.localId, ...this.room.remoteIds()];
    // `all` already includes a joiner and no longer includes a leaver.
    const candidates = all.filter((p) => p !== id).sort();
    const rotator = chooseRotator(all, id);
    if (rotator === null) return;
    const baseline = this.keys.epoch;
    const rank = candidates.indexOf(this.room.localId);
    if (rank < 0) return; // this device is the one that joined: others rotate for it
    if (rotator === this.room.localId) void this.rotate();
    else this.afterDelay((this.o.rotationFallbackMs ?? FALLBACK_MS) * rank, () => this.rotateIfStill(baseline));
  }

  /** Back-up for a rotator that never acted: only rotate if nothing changed meanwhile. */
  private async rotateIfStill(baseline: number | null): Promise<void> {
    await this.serial(async () => {
      await this.o.group.sync(this.o.conversationId);
      await this.keys?.refresh("soon");
    });
    if (this.keys?.epoch === baseline) await this.rotate();
  }

  private rotate(): Promise<void> {
    return this.serial(async () => {
      if (!this.group || !this.keys) return;
      try {
        await this.group.rotate();
      } catch {
        // Missing one rotation is not fatal: the next join or leave, or the
        // back-up, tries again. Media keeps its current key meanwhile.
        return;
      }
      await this.keys.refresh("soon");
    });
  }

  private afterDelay(ms: number, work: () => Promise<void>): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (this.joined) void work();
    }, ms);
    this.timers.add(t);
  }

  // ------------------------------------------------------------ screen share

  /** Share the screen at no more than the plan's limits. Needs a token that asked for it. */
  async startScreenShare(asked?: { height?: number; fps?: number }): Promise<void> {
    if (!this.token.canShare) throw new VoiceE2eeError("not_allowed", "screen share was not granted for this call");
    await this.room.startScreenShare(clampCapture(this.token.quality, asked));
    await this.api("patch", { streaming: true });
  }

  async stopScreenShare(): Promise<void> {
    await this.room.stopScreenShare();
    await this.api("patch", { streaming: false });
  }

  // ---------------------------------------------------------------- leaving

  private async renew(): Promise<void> {
    try {
      await this.api("patch", {});
    } catch {
      // The lease is 90 seconds; one missed renewal is fine.
    }
  }

  private api(kind: "patch" | "delete", body?: unknown): Promise<unknown> {
    const path = `/servers/${this.o.serverId}/voice`;
    return kind === "patch" ? this.o.api.patch(path, body) : this.o.api.delete(path);
  }

  /** Leave the call and drop every key. Safe to call twice. */
  async leave(): Promise<void> {
    if (!this.joined) return;
    this.joined = false;
    if (this.lease) clearInterval(this.lease);
    this.lease = null;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.keys?.stop();
    this.sink?.dispose?.();
    try {
      await this.room?.disconnect();
    } finally {
      try {
        await this.api("delete");
      } catch {
        // The lease expires on its own.
      }
    }
  }
}
