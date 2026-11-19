/**
 * The slice of the WASM MLS client that voice needs, as plain data. Kept apart
 * from lib/e2ee.ts so voice does not depend on how that file wraps the module.
 * To wire it up, hand `adaptVoiceMls` the same raw `WasmClient` the messaging
 * code uses (so both see the same groups).
 */
export interface VoiceMls {
  inGroup(groupId: Uint8Array): boolean;
  epoch(groupId: Uint8Array): number;
  /** MLS exporter for the group's current epoch. */
  exportSecret(groupId: Uint8Array, label: string, context: Uint8Array, length: number): Uint8Array;
  /** A commit that only rotates this device's leaf keys. Pending until accepted or rejected. */
  updateKeys(groupId: Uint8Array): Uint8Array;
  commitAccepted(groupId: Uint8Array): void;
  commitRejected(groupId: Uint8Array): void;
  /** Only needed to start a DM call (a fresh group per call). */
  keyPackage(): Uint8Array;
  createGroup(groupId: Uint8Array): void;
  addMember(groupId: Uint8Array, keyPackage: Uint8Array): { commit: Uint8Array; welcome: Uint8Array | undefined };
  join(welcome: Uint8Array): Uint8Array;
}

/** The generated bindings. `updateKeys` returns an object that must be freed. */
export interface RawVoiceClient {
  inGroup(g: Uint8Array): boolean;
  epoch(g: Uint8Array): number;
  exportSecret(g: Uint8Array, label: string, context: Uint8Array, length: number): Uint8Array;
  updateKeys(g: Uint8Array): { commit: Uint8Array; free(): void };
  commitAccepted(g: Uint8Array): void;
  commitRejected(g: Uint8Array): void;
  keyPackage(): Uint8Array;
  createGroup(g: Uint8Array): void;
  addMember(g: Uint8Array, k: Uint8Array): { commit: Uint8Array; welcome: Uint8Array | undefined; free(): void };
  join(w: Uint8Array): Uint8Array;
}

export function adaptVoiceMls(raw: RawVoiceClient): VoiceMls {
  return {
    inGroup: (g) => raw.inGroup(g),
    epoch: (g) => raw.epoch(g),
    exportSecret: (g, label, context, length) => raw.exportSecret(g, label, context, length),
    updateKeys(g) {
      const out = raw.updateKeys(g);
      const commit = out.commit;
      out.free();
      return commit;
    },
    commitAccepted: (g) => raw.commitAccepted(g),
    commitRejected: (g) => raw.commitRejected(g),
    keyPackage: () => raw.keyPackage(),
    createGroup: (g) => raw.createGroup(g),
    addMember(g, k) {
      const out = raw.addMember(g, k);
      const result = { commit: out.commit, welcome: out.welcome };
      out.free();
      return result;
    },
    join: (w) => raw.join(w),
  };
}
