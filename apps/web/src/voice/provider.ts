import { BaseKeyProvider, KeyProviderEvent, createKeyMaterialFromBuffer } from "livekit-client";
import type { KeySink, SwitchMode } from "./keys.js";

/**
 * LiveKit key provider fed from the MLS exporter. LiveKit's E2EE worker
 * (encoded transforms, AES-GCM, per-sender keys derived with HKDF from what
 * we hand it) does the frame encryption; this class only says which key is
 * which.
 *
 * Every participant shares one base key per epoch (`sharedKey`). Epochs are
 * mapped onto LiveKit's key ring slots (`epoch % keyringSize`), and every
 * frame carries its slot, so frames sent just before a switch still decrypt
 * for as long as that slot has not been reused. Slots are reused after
 * `keyringSize` epochs.
 *
 * Failed decryptions never ratchet or invalidate a key (`ratchetWindowSize: 0`,
 * `failureTolerance: -1`): the only way keys change is a new MLS epoch.
 */
export class MlsKeyProvider extends BaseKeyProvider implements KeySink {
  /** Pending delayed switch, so a newer epoch can cancel an older one. */
  private pending: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly sendDelayMs = 500) {
    super({ sharedKey: true, ratchetWindowSize: 0, failureTolerance: -1, keySize: 256 });
  }

  async install(epoch: number, key: Uint8Array, mode: SwitchMode): Promise<void> {
    // HKDF key material; copy so the caller can wipe its buffer.
    const material = await createKeyMaterialFromBuffer(key.slice().buffer);
    const index = epoch % this.getOptions().keyringSize;
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;

    if (mode === "now" || this.sendDelayMs <= 0) {
      this.onSetEncryptionKey(material, undefined, index);
      return;
    }
    // Receive with the new key now, start sending with it a moment later.
    this.emit(KeyProviderEvent.SetKey, { key: material, keyIndex: index }, false);
    this.pending = setTimeout(() => {
      this.pending = null;
      this.onSetEncryptionKey(material, undefined, index);
    }, this.sendDelayMs);
  }

  dispose(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = null;
  }
}
