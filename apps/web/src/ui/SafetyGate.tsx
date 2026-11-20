import { useState } from "react";
import { birthYears } from "../lib/safety.js";
import type { Controller } from "../lib/controller.js";
import type { Gate } from "../lib/safety.js";

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * Shown after sign-up or sign-in when the account has to declare an age,
 * accept the terms, or is limited. Only a birth month and year are asked for,
 * and only the age band is kept.
 */
export function SafetyGate({ controller, gate, error }: { controller: Controller; gate: Gate; error: string | null }) {
  const [month, setMonth] = useState("");
  const [year, setYear] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    try {
      await fn();
    } finally {
      setBusy(false);
    }
  }

  if (gate.kind === "declare") {
    return (
      <main className="auth">
        <h1>Before you start</h1>
        <p>Bastion's alpha is for people 18 and older. Tell us your birth month and year. We keep only whether you are over or under certain ages, not your birth date.</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => controller.declareAge(Number(year), Number(month)));
          }}
        >
          <label>
            Birth month
            <select required value={month} onChange={(e) => setMonth(e.target.value)}>
              <option value="" disabled>Choose</option>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
          </label>
          <label>
            Birth year
            <select required value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="" disabled>Choose</option>
              {birthYears(Date.now()).map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </label>
          <button disabled={busy || !month || !year}>Continue</button>
        </form>
        {error && <p role="alert" className="error">{errorText(error)}</p>}
        <p><button className="link" onClick={() => void controller.signOut()}>Sign out</button></p>
      </main>
    );
  }

  if (gate.kind === "device") {
    return (
      <main className="auth">
        <h1>Is this your own device?</h1>
        <p>Your encrypted messages are stored only on this device, and we have no copy.</p>
        <p><strong>Private device.</strong> Signing out keeps your messages here, and they are back when you sign in again with your passkey.</p>
        <p><strong>Shared device.</strong> Signing out erases your messages and keys from this browser. Use this on a shared or borrowed computer.</p>
        <div className="controls">
          <button onClick={() => void controller.chooseDevice("private")}>This is my private device</button>
          <button onClick={() => void controller.chooseDevice("shared")}>This is a shared device</button>
        </div>
        <p className="hint">You can change this later in Privacy.</p>
        <p><button className="link" onClick={() => void controller.signOut()}>Sign out</button></p>
      </main>
    );
  }

  if (gate.kind === "terms") {
    return (
      <main className="auth">
        <h1>Terms and policies</h1>
        <p>To use Bastion, please accept:</p>
        <ul>
          {gate.outstanding.map((d) => <li key={d.document}>{DOC_NAMES[d.document] ?? d.document} (version {d.version})</li>)}
        </ul>
        <label>
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> I am 18 or older and I accept these.
        </label>
        <button disabled={busy || !agreed} onClick={() => void run(() => controller.acceptTerms())}>Accept and continue</button>
        {error && <p role="alert" className="error">{errorText(error)}</p>}
        <p><button className="link" onClick={() => void controller.signOut()}>Sign out</button></p>
      </main>
    );
  }

  const text =
    gate.kind === "too_young"
      ? "Bastion's alpha is only open to people 18 and older, so this account can't be used yet. You can still export your account data from a signed-in session later, and you're welcome back when the age limit changes."
      : "We need to check this account's age before it can be used. We'll be in touch. Until then it can't send messages, join servers or open age-restricted channels.";
  return (
    <main className="auth">
      <h1>{gate.kind === "too_young" ? "Not available yet" : "Account under review"}</h1>
      <p>{text}</p>
      <button onClick={() => void controller.signOut()}>Sign out</button>
    </main>
  );
}

const DOC_NAMES: Record<string, string> = { terms: "Terms of service", privacy: "Privacy notice", aup: "Acceptable use policy" };

export function errorText(code: string): string {
  if (code === "underage") return "Sorry, Bastion isn't available to people under 13.";
  if (code === "account_blocked") return "This account can't be used.";
  if (code === "rate_limited") return "Too many tries. Please wait a while.";
  return "Something went wrong. Please try again.";
}
