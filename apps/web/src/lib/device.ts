/**
 * Whether this browser is the person's own ("private") or one other people use
 * ("shared"). A private device keeps encrypted history after sign-out; a shared
 * one erases it when the person signs out. Chosen once per browser profile, at
 * the first sign-in, and changeable in Privacy. Not a secret, so localStorage.
 */
export type DeviceKind = "private" | "shared";

export interface DevicePrefs {
  /** null until the person has chosen. */
  load(): DeviceKind | null;
  save(kind: DeviceKind): void;
}

export class MemoryDevicePrefs implements DevicePrefs {
  constructor(private kind: DeviceKind | null = null) {}
  load() {
    return this.kind;
  }
  save(kind: DeviceKind) {
    this.kind = kind;
  }
}

export class LocalDevicePrefs implements DevicePrefs {
  constructor(
    private readonly storage: Pick<Storage, "getItem" | "setItem">,
    private readonly key = "bastion.device-kind",
  ) {}
  load(): DeviceKind | null {
    const v = this.storage.getItem(this.key);
    return v === "private" || v === "shared" ? v : null;
  }
  save(kind: DeviceKind) {
    this.storage.setItem(this.key, kind);
  }
}
