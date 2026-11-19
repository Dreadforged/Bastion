import type { schemas } from "@bastion/shared";
import { useEffect, useState } from "react";
import type { Controller } from "../lib/controller.js";
import { downloadJson } from "../lib/privacy.js";

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
    } catch {
      setMessage("Could not save that change.");
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
          <option value="nobody">Nobody</option>
        </select>
      </label>
      <p className="hint">Conversations you already have keep working. You can still message others.</p>

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
    </section>
  );
}
