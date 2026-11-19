/**
 * Client-side end-to-end encryption of voice and screen share media. See
 * docs/adr/0004-voice-e2ee-key-derivation.md.
 *
 * This is only the contract. The implementation needs the MLS client from the
 * crypto crate's WASM build, so it lives in the web and desktop clients and
 * lands after that build. Nothing on the server uses it: LiveKit relays
 * encrypted frames and never gets the key.
 */

export const VOICE_E2EE = {
  /** MLS exporter label. Bump the suffix if the derivation ever changes. */
  exporterLabel: "bastion/voice/v1",
  /** Length of the key handed to the media layer, in bytes. */
  keyBytes: 32,
  /**
   * Keys are replaced when the group's MLS epoch changes (someone joins or
   * leaves the group), so a removed member cannot keep decrypting.
   */
  rekeyOnEpochChange: true,
} as const;

export interface VoiceKeyRequest {
  /**
   * The MLS group that protects this voice channel: the channel's encrypted
   * conversation. Only members of that group can derive a key.
   */
  conversationId: string;
  /**
   * The random room id the server issued for this call. It is the exporter
   * context, so every call gets its own key even within one MLS epoch.
   */
  roomId: string;
  /** The group's current MLS epoch. */
  epoch: number;
}

/**
 * Derives the base key for a call from the MLS group. The result is
 * `MLS-Exporter(VOICE_E2EE.exporterLabel, utf8(roomId), VOICE_E2EE.keyBytes)`.
 */
export interface VoiceKeyDeriver {
  deriveBaseKey(request: VoiceKeyRequest): Promise<Uint8Array>;
}

/**
 * Where the key goes: LiveKit's client-side media encryption (insertable
 * streams) takes a key provider. The client feeds it `deriveBaseKey`'s output
 * for the current epoch and calls `onEpochChange` to rotate.
 */
export interface VoiceMediaKeys {
  /** Join the room with the key for `epoch`. Rejects if the user is not in the MLS group. */
  start(request: VoiceKeyRequest): Promise<void>;
  /** The MLS epoch moved on: derive and install the new key. Frames in flight keep decrypting for a short grace period. */
  onEpochChange(epoch: number): Promise<void>;
  /** Forget all keys. Called when leaving the call. */
  stop(): void;
}
