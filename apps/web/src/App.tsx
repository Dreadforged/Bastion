import { useSyncExternalStore } from "react";
import type { AuthClient } from "./lib/auth.js";
import type { Controller } from "./lib/controller.js";
import { AuthScreen } from "./ui/AuthScreen.js";
import { SafetyGate } from "./ui/SafetyGate.js";
import { Shell } from "./ui/Shell.js";

export function App({ controller, auth }: { controller: Controller; auth: AuthClient }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  if (state.phase === "signed-out") return <AuthScreen controller={controller} auth={auth} notice={state.error} />;
  if (state.phase === "safety-gate" && state.gate) return <SafetyGate controller={controller} gate={state.gate} error={state.error} />;
  if (state.phase === "connecting" || state.phase === "safety-gate") return <p className="splash">Connecting…</p>;
  return <Shell controller={controller} state={state} />;
}
