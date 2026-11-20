import { useState, type ReactNode } from "react";
import { tokenFromHash, type AuthClient } from "../lib/auth.js";
import type { Controller } from "../lib/controller.js";
import { errorText } from "./SafetyGate.js";

type Mode = "sign-in" | "sign-up" | "add-device";

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Firefox/.test(ua) ? "Firefox" : /Edg/.test(ua) ? "Edge" : /Chrome/.test(ua) ? "Chrome" : /Safari/.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${navigator.platform || "this device"}`.slice(0, 64);
}

export function AuthScreen({ controller, auth, notice, devTools = null }: { controller: Controller; auth: AuthClient; notice?: string | null; devTools?: ReactNode }) {
  const [mode, setMode] = useState<Mode>("sign-in");
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const token = tokenFromHash(location.hash);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof Error ? err.message : "something_went_wrong");
    } finally {
      setBusy(false);
    }
  }

  // Opened from the emailed link: register a passkey for this device.
  if (token && !recoveryCode) {
    return (
      <main className="auth">
        <h1>Bastion</h1>
        <p>Create a passkey to finish. Your device will ask you to confirm.</p>
        <button
          disabled={busy}
          onClick={() =>
            run(async () => {
              const result = await auth.register(token, defaultDeviceName());
              history.replaceState(null, "", location.pathname);
              if (result.recoveryCode) setRecoveryCode(result.recoveryCode);
              else await controller.connect();
            })
          }
        >
          Create passkey
        </button>
        {error && <p role="alert" className="error">{error}</p>}
      </main>
    );
  }

  if (recoveryCode) {
    return (
      <main className="auth">
        <h1>Save your recovery code</h1>
        <p>This is the only way back in if you lose every device. It is shown once and we can't show it again.</p>
        <pre className="code">{recoveryCode}</pre>
        <button onClick={() => run(() => controller.connect())}>I've saved it</button>
      </main>
    );
  }

  return (
    <main className="auth">
      <h1>Bastion</h1>
      <p className="tag">Private chat. Only the people in a conversation can read it. The alpha is for people 18 and older.</p>
      {mode === "sign-in" && (
        <>
          <button disabled={busy} onClick={() => run(async () => { await auth.signIn(); await controller.connect(); })}>
            Sign in with a passkey
          </button>
          <p>
            <button className="link" onClick={() => setMode("sign-up")}>Create an account</button>
            {" · "}
            <button className="link" onClick={() => setMode("add-device")}>Add this device</button>
          </p>
        </>
      )}
      {mode !== "sign-in" && !sent && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              if (mode === "sign-up") await auth.startSignup(email);
              else await auth.sendDeviceLink(email);
              setSent(true);
            });
          }}
        >
          <label>
            Email
            <input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button disabled={busy}>{mode === "sign-up" ? "Email me a link" : "Email me a device link"}</button>
          <p><button type="button" className="link" onClick={() => setMode("sign-in")}>Back</button></p>
        </form>
      )}
      {sent && <p>Check your email for a link. It expires in 15 minutes.</p>}
      {error && <p role="alert" className="error">{error}</p>}
      {!error && notice && <p role="alert" className="error">{errorText(notice)}</p>}
      {devTools}
    </main>
  );
}
