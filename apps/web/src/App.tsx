import { useSyncExternalStore } from "react";
import type { AuthClient } from "./lib/auth.js";
import type { Controller } from "./lib/controller.js";
import { AuthScreen } from "./ui/AuthScreen.js";
import { Shell } from "./ui/Shell.js";

export function App({ controller, auth }: { controller: Controller; auth: AuthClient }) {
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  if (state.phase === "signed-out") return <AuthScreen controller={controller} auth={auth} />;
  if (state.phase === "connecting") return <p className="splash">Connecting…</p>;
  return <Shell controller={controller} state={state} />;
}
