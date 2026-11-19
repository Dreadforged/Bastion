import { schemas } from "@bastion/shared";
import type { UserSession } from "@bastion/durable";
import { AuthError } from "../auth/errors.js";
import { limitAccount } from "../auth/rate-limit.js";
import { json } from "../auth/routes.js";
import { authenticate } from "../auth/sessions.js";
import { body, HttpError } from "../http.js";
import { buildExport } from "./export.js";
import { getPrivacy, updatePrivacy } from "./privacy.js";

export interface AccountRouteDeps {
  db: D1Database;
  sessions: DurableObjectNamespace<UserSession>;
  now: () => number;
  userLimit?: RateLimit | undefined;
}

/**
 * Routes under /account:
 *   GET /account/privacy   the caller's privacy settings
 *   PUT /account/privacy   change one or more of them
 *   GET /account/export    everything the server holds about the account (JSON download)
 */
export async function handleAccount(request: Request, deps: AccountRouteDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  if (!pathname.startsWith("/account/")) return null;
  const route = `${request.method} ${pathname}`;
  if (route !== "GET /account/privacy" && route !== "PUT /account/privacy" && route !== "GET /account/export") {
    return json({ error: "not_found" }, 404);
  }

  try {
    const principal = await authenticate(deps.db, request, deps.now());
    if (deps.userLimit) {
      const { success } = await deps.userLimit.limit({ key: principal.userId });
      if (!success) throw new HttpError(429, "rate_limited");
    }

    if (route === "GET /account/privacy") return json(await getPrivacy(deps.db, principal.userId));
    if (route === "PUT /account/privacy") {
      const change = await body(request, schemas.UpdatePrivacyRequest);
      return json(await updatePrivacy(deps.db, principal.userId, change, deps.now()));
    }

    await limitAccount(deps.db, "accountExport", principal.userId, deps.now());
    const session = deps.sessions.get(deps.sessions.idFromName(principal.userId));
    const serverIds = await session.listServerIds();
    const data = await buildExport(deps.db, principal.userId, serverIds, deps.now());
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "content-type": "application/json",
        "content-disposition": 'attachment; filename="bastion-account-export.json"',
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    if (err instanceof HttpError || err instanceof AuthError) return json({ error: err.code }, err.status);
    throw err;
  }
}
