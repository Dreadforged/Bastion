/**
 * Client-side end-to-end encryption of voice and screen share media. See
 * docs/adr/0004-voice-e2ee-key-derivation.md.
 *
 * Only constants live here. The implementation is in apps/web/src/voice: the
 * key comes from the MLS group's exporter, and LiveKit's encoded-transform
 * worker encrypts the frames. Nothing on the server uses this: LiveKit relays
 * encrypted frames and never gets the key.
 */

export const VOICE_E2EE = {
  /** MLS exporter label. Bump the suffix if the derivation ever changes. */
  exporterLabel: "bastion/voice/v1",
  /** Length of the key handed to the media layer, in bytes. */
  keyBytes: 32,
  /**
   * Keys are replaced when the group's MLS epoch changes (a join or leave of
   * the call, or someone removed from the group), so a removed member cannot
   * keep decrypting.
   */
  rekeyOnEpochChange: true,
} as const;
