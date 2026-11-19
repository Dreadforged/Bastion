import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AuthClient } from "./lib/auth.js";
import { Controller } from "./lib/controller.js";
import { Api, LocalTokenStore } from "./lib/http.js";
import { IdbStateVault } from "./lib/vault.js";
import { createMlsClient } from "./lib/wasm.js";
import { liveKitCallOptions } from "./voice/livekit-room.js";
import "./ui/styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");

// In dev the Vite proxy forwards /api to the API worker.
const apiBase = import.meta.env.VITE_API_URL ?? "/api";
const wsBase = apiBase.startsWith("http") ? apiBase.replace(/^http/, "ws") : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${apiBase}`;

const api = new Api({ baseUrl: apiBase, store: new LocalTokenStore(localStorage), onSignedOut: () => controller.signOut() });
const auth = new AuthClient(api);
const controller = new Controller({ api, auth, createMls: createMlsClient, vault: new IdbStateVault(), voiceRoom: liveKitCallOptions(), gatewayUrl: `${wsBase}/gateway` });
void controller.start();

createRoot(root).render(
  <StrictMode>
    <App controller={controller} auth={auth} />
  </StrictMode>,
);
