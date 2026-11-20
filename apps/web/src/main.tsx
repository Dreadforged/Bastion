import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AuthClient } from "./lib/auth.js";
import { Controller } from "./lib/controller.js";
import { LocalDevicePrefs } from "./lib/device.js";
import { Api, LocalTokenStore } from "./lib/http.js";
import { IdbStateVault } from "./lib/vault.js";
import { createMlsClient } from "./lib/wasm.js";
import { liveKitCallOptions } from "./voice/livekit-room.js";
import "./ui/styles.css";

// Local testing picker. Vite replaces import.meta.env.DEV with false in production builds, so the
// import below is dropped from them.
const DevPicker = import.meta.env.DEV ? lazy(() => import("./ui/DevPicker.js")) : null;

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// In dev the Vite proxy forwards /api to the API worker.
const apiBase = import.meta.env.VITE_API_URL ?? "/api";
const wsBase = apiBase.startsWith("http") ? apiBase.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${apiBase}`;

const api = new Api({ baseUrl: apiBase, store: new LocalTokenStore(localStorage), onSignedOut: () => void controller.sessionEnded() });
const auth = new AuthClient(api);
const controller = new Controller({ api, auth, createMls: createMlsClient, vault: new IdbStateVault(), devicePrefs: new LocalDevicePrefs(localStorage),voiceRoom: liveKitCallOptions(), gatewayUrl: `${wsBase}/gateway` });
void controller.start();

// Message history exists only in this browser's storage. Ask the browser not to evict it when disk is low.
void navigator.storage?.persist?.().catch(() => undefined);

createRoot(root).render(
  <StrictMode>
    <App
      controller={controller}
      auth={auth}
      devTools={DevPicker ? <Suspense fallback={null}><DevPicker api={api} controller={controller} /></Suspense> : null}
    />
  </StrictMode>,
);
