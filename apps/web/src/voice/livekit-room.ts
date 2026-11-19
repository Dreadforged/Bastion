import { Room, RoomEvent, isE2EESupported } from "livekit-client";
import type { CallOptions, CallRoom, ScreenCapture } from "./call.js";
import type { KeySink } from "./keys.js";
import { MlsKeyProvider } from "./provider.js";

/**
 * The real room: LiveKit's client with its end-to-end encryption turned on
 * and keyed by `MlsKeyProvider`. Not exercised by the tests (they use a fake
 * `CallRoom`); see docs/adr/0004 for what has and has not been run.
 */
export class LiveKitCallRoom implements CallRoom {
  private readonly room: Room;
  private worker: Worker | null = null;
  private ready = false;

  constructor(provider: MlsKeyProvider | null) {
    if (provider) {
      // One worker per room: it holds that room's encryption state.
      this.worker = new Worker(new URL("livekit-client/e2ee-worker", import.meta.url), { type: "module" });
      this.room = new Room({ encryption: { keyProvider: provider, worker: this.worker } });
    } else {
      this.room = new Room();
    }
  }

  get localId(): string {
    return this.room.localParticipant.identity;
  }

  remoteIds(): string[] {
    return [...this.room.remoteParticipants.values()].map((p) => p.identity);
  }

  async enableEncryption(): Promise<void> {
    await this.room.localParticipant.setE2EEEnabled(true);
  }

  async connect(url: string, token: string): Promise<void> {
    await this.room.connect(url, token);
    this.ready = true;
  }

  async publishMicrophone(): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(true);
  }

  async setMicrophoneEnabled(enabled: boolean): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(enabled);
  }

  async startScreenShare(c: ScreenCapture): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(
      true,
      { resolution: { width: c.width, height: c.height, frameRate: c.fps }, contentHint: "detail" },
      // One layer, capped at the plan's bitrate and frame rate.
      { screenShareEncoding: { maxBitrate: c.maxBitrate, maxFramerate: c.fps }, screenShareSimulcastLayers: [] },
    );
  }

  async stopScreenShare(): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(false);
  }

  onParticipant(handler: (event: "joined" | "left", id: string) => void): void {
    this.room.on(RoomEvent.ParticipantConnected, (p) => handler("joined", p.identity));
    this.room.on(RoomEvent.ParticipantDisconnected, (p) => handler("left", p.identity));
  }

  onDisconnected(handler: () => void): void {
    this.room.on(RoomEvent.Disconnected, handler);
  }

  async disconnect(): Promise<void> {
    if (this.ready) await this.room.disconnect();
    this.worker?.terminate();
    this.worker = null;
  }
}

/** Options that plug LiveKit into `Call`. */
export function liveKitCallOptions(): Pick<CallOptions, "createRoom" | "createSink" | "e2eeSupported"> {
  let provider: MlsKeyProvider | null = null;
  return {
    createSink: () => (provider ??= new MlsKeyProvider()),
    createRoom: (sink: KeySink | null) => new LiveKitCallRoom(sink as MlsKeyProvider | null),
    e2eeSupported: isE2EESupported,
  };
}
