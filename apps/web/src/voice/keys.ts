import { VOICE_E2EE } from "@bastion/shared";
import type { VoiceMls } from "./mls.js";

/**
 * Media keys for one call, from the MLS group's exporter (ADR 0004):
 *
 *   key = MLS-Exporter("bastion/voice/v1", utf8(roomId), 32)
 *
 * The room id is random per call, so two calls in the same epoch get
 * unrelated keys. The key changes whenever the epoch does.
 */

export class VoiceE2eeError extends Error {
  constructor(
    readonly code: "not_in_group" | "unsupported_browser" | "key_unavailable" | "rotation_failed" | "not_allowed",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "VoiceE2eeError";
  }
}

export function deriveCallKey(mls: VoiceMls, groupId: Uint8Array, roomId: string): Uint8Array {
  if (!mls.inGroup(groupId)) throw new VoiceE2eeError("not_in_group");
  const key = mls.exportSecret(groupId, VOICE_E2EE.exporterLabel, new TextEncoder().encode(roomId), VOICE_E2EE.keyBytes);
  if (key.length !== VOICE_E2EE.keyBytes) throw new VoiceE2eeError("key_unavailable");
  return key;
}

/**
 * How a new key is brought in. Receivers always take the key at once. The
 * sender either switches at once (`now`, used when someone was removed, so
 * they stop being able to read as soon as possible) or after a short delay
 * (`soon`, used for ordinary joins and leaves) so peers that have not yet
 * processed the commit don't hear a gap.
 */
export type SwitchMode = "now" | "soon";

/** Where derived keys go: the LiveKit key provider, or a fake in tests. */
export interface KeySink {
  install(epoch: number, key: Uint8Array, mode: SwitchMode): Promise<void>;
}

/** Keeps a sink on the key of the group's current epoch. */
export class CallKeys {
  private installed: number | null = null;
  private stopped = false;

  constructor(
    private readonly mls: VoiceMls,
    private readonly groupId: Uint8Array,
    private readonly roomId: string,
    private readonly sink: KeySink,
  ) {}

  get epoch(): number | null {
    return this.installed;
  }

  /** Install the key for the current epoch if it is not installed yet. Returns whether anything changed. */
  async refresh(mode: SwitchMode = "soon"): Promise<boolean> {
    if (this.stopped) return false;
    const epoch = this.mls.epoch(this.groupId);
    if (epoch === this.installed) return false;
    const key = deriveCallKey(this.mls, this.groupId, this.roomId);
    try {
      // The first key of a call is used at once: nobody has an older one.
      await this.sink.install(epoch, key, this.installed === null ? "now" : mode);
    } finally {
      key.fill(0);
    }
    this.installed = epoch;
    return true;
  }

  stop(): void {
    this.stopped = true;
  }
}
