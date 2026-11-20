import { useEffect, useState } from "react";
import type { schemas } from "@bastion/shared";
import type { Api } from "../lib/http.js";
import type { Controller } from "../lib/controller.js";

interface DevUsers {
  users: { handle: string; email: string; blurb: string }[];
  serverName: string;
  inviteCode: string | null;
}

/**
 * Local testing only. main.tsx loads this only when Vite runs in dev mode
 * (`import.meta.env.DEV`), so production builds do not contain it. It also
 * shows nothing unless the local API answers /dev/users, which only a local
 * dev Worker does (see docs/local-testing.md).
 */
export default function DevPicker({ api, controller }: { api: Api; controller: Controller }) {
  const [info, setInfo] = useState<DevUsers | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<DevUsers>("/dev/users").then(setInfo, () => setInfo(null));
  }, [api]);

  if (!info) return null;

  async function signInAs(handle: string) {
    setBusy(true);
    setError(null);
    try {
      const tokens = await api.post<schemas.SessionTokens>("/dev/signin", { handle }, { anonymous: true });
      api.setTokens(tokens);
      await controller.connect();
    } catch (err) {
      setError(err instanceof Error ? err.message : "something_went_wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="dev-picker" aria-label="Local test accounts">
      <h2>Local test accounts</h2>
      <p>Dev only. Pick one to sign in without a passkey.</p>
      <ul>
        {info.users.map((u) => (
          <li key={u.handle}>
            <button disabled={busy} onClick={() => void signInAs(u.handle)}>Sign in as {u.handle}</button> <small>{u.blurb}</small>
          </li>
        ))}
      </ul>
      {info.inviteCode && <p><small>{info.serverName} invite code: <code>{info.inviteCode}</code></small></p>}
      {error && <p role="alert" className="error">{error}</p>}
    </section>
  );
}
