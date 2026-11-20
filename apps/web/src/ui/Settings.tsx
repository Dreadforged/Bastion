import type { schemas } from "@bastion/shared";
import { useEffect, useState } from "react";
import type { Controller } from "../lib/controller.js";
import { downloadJson } from "../lib/privacy.js";

const DELETE_REFUSALS: Record<string, string> = {
  owns_servers: "You own at least one server. Delete it or hand it on first, then try again.",
  // Deliberately vague: we may be unable to say why.
  legal_hold: "We can't delete this account right now. Please contact support.",
  rate_limited: "Too many tries. Please wait a while.",
};

/** Settings, Privacy and data. */
export function Settings({ controller }: { controller: Controller }) {
  const [settings, setSettings] = useState<schemas.PrivacySettings | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    controller.getPrivacy().then(setSettings, () => setMessage("Could not load your settings."));
  }, [controller]);

  async function change(next: schemas.UpdatePrivacyRequest) {
    setMessage(null);
    try {
      setSettings(await controller.updatePrivacy(next));
    } catch (err) {
      setMessage(err instanceof Error && err.message === "teen_default_locked" ? "That choice is not available to accounts under 18." : "Could not save that change.");
    }
  }

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmErase, setConfirmErase] = useState(false);
  async function deleteAccount() {
    setMessage(null);
    const refusal = await controller.deleteAccount();
    if (refusal) {
      setConfirmDelete(false);
      setMessage(DELETE_REFUSALS[refusal] ?? "Could not delete your account right now. Please try again later.");
    }
  }

  async function exportAccount() {
    setMessage(null);
    try {
      downloadJson("bastion-account-export.json", await controller.accountExport());
    } catch {
      setMessage("Could not export right now. Exports are limited to a few an hour.");
    }
  }

  return (
    <section className="settings">
      <header>
        <h2>Privacy and data</h2>
      </header>
      {message && (
        <p role="alert" className="error">
          {message}
        </p>
      )}

      <h3>Who can reach you</h3>
      <label>
        New direct messages from{" "}
        <select
          value={settings?.dmPolicy ?? "everyone"}
          disabled={!settings}
          onChange={(e) => void change({ dmPolicy: e.target.value as schemas.DmPolicy })}
        >
          <option value="everyone">Anyone</option>
          <option value="requests">People I share a server with, and requests from others</option>
          <option value="nobody">Nobody</option>
        </select>
      </label>
      <p className="hint">Conversations you already have keep working. You can still message others.</p>
      <p className="hint">If you are under 18, requests is the least strict choice available, so people you do not share a server with have to ask first.</p>

      <h3>What others see</h3>
      <label>
        <input
          type="checkbox"
          checked={settings?.typingIndicators ?? true}
          disabled={!settings}
          onChange={(e) => void change({ typingIndicators: e.target.checked })}
        />{" "}
        Show when I am typing
      </label>
      <p className="hint">To hide when you are online, set your status to Invisible.</p>

      <h3>Your data</h3>
      <p className="hint">
        Messages are end-to-end encrypted, so the server cannot read them or include them in an export. Your account export lists what the
        server holds: your email, devices, servers, conversations and files. Your message export is made on this device from the history it
        can read.
      </p>
      <div className="controls">
        <button onClick={() => void exportAccount()}>Export my account data</button>
        <button onClick={() => downloadJson("bastion-messages-export.json", controller.chatExport())}>Export messages on this device</button>
      </div>

      <h3>This device</h3>
      <p className="hint">
        Your encrypted messages are stored only on this device. On a private device, signing out keeps them here and they come back when
        you sign in again with your passkey. On a shared device, signing out erases them.
      </p>
      <label>
        This browser is a{" "}
        <select value={controller.deviceKind()} onChange={(e) => controller.setDeviceKind(e.target.value as "private" | "shared")}>
          <option value="private">Private: keep messages</option>
          <option value="shared">Shared: erase on sign-out</option>
        </select>
      </label>

      <h3 id="erase-device">Erase messages from this device</h3>
      <p className="hint">
        This signs you out and deletes your encrypted messages and keys from this browser, whatever the setting above. We have no copy, so
        they cannot be restored, and they stay on other people's devices.
      </p>
      {!confirmErase ? (
        <button onClick={() => setConfirmErase(true)}>Sign out and erase this device…</button>
      ) : (
        <div className="controls">
          <button onClick={() => void controller.signOutAndErase()}>Yes, erase and sign out</button>
          <button onClick={() => setConfirmErase(false)}>Cancel</button>
        </div>
      )}

      <h3>Delete your account</h3>
      <p className="hint">
        This removes your account, passkeys and files and takes you out of every server and conversation. Messages already delivered to other
        people stay on their devices. It cannot be undone.
      </p>
      {!confirmDelete ? (
        <button onClick={() => setConfirmDelete(true)}>Delete my account…</button>
      ) : (
        <div className="controls">
          <button onClick={() => void deleteAccount()}>Yes, delete my account</button>
          <button onClick={() => setConfirmDelete(false)}>Keep it</button>
        </div>
      )}
    </section>
  );
}
