import init, { WasmClient } from "@bastion/crypto-wasm/bastion_crypto.js";
import wasmUrl from "@bastion/crypto-wasm/bastion_crypto_bg.wasm?url";
import { adaptWasmClient, deviceIdentity, type MlsClient } from "./e2ee.js";

let loading: Promise<unknown> | null = null;

/** Load the crypto module once, then make this device's MLS client. */
export async function createMlsClient(userId: string, deviceId: string, saved: Uint8Array | null = null): Promise<MlsClient> {
  loading ??= init({ module_or_path: wasmUrl });
  await loading;
  const client = saved ? WasmClient.loadState(saved) : new WasmClient(deviceIdentity(userId, deviceId));
  return adaptWasmClient(client as never);
}
