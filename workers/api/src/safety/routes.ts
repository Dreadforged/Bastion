import { schemas } from "@bastion/shared";
import { AuthError } from "../auth/errors.js";
import { limitAccount } from "../auth/rate-limit.js";
import { json } from "../auth/routes.js";
import { authenticate } from "../auth/sessions.js";
import { body, HttpError } from "../http.js";
import { acceptTerms, declareAge, getClientConfig, getSafety } from "./account.js";
import type { FlagReader } from "./flags.js";

export interface SafetyRouteDeps {
  db: D1Database;
  flags: FlagReader;
  now: () => number;
  userLimit?: RateLimit | undefined;
}

/**
 * Routes:
 *   GET  /account/safety   age band, state, country, outstanding terms
 *   PUT  /account/age      declare a birth month and year (only the band is kept)
 *   POST /account/terms    accept a version of the terms, privacy notice or acceptable use policy
 *   GET  /safety/config    this region's safety settings for the client
 *
 * Staff operations (flags, legal holds, account states) have no route: they
 * need the internal admin tool behind Cloudflare Access, which is not built.
 */
export async function handleSafety(request: Request, deps: SafetyRouteDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const route = `${request.method} ${pathname}`;
  const known = ["GET /account/safety", "PUT /account/age", "POST /account/terms", "GET /safety/config"];
  if (!pathname.startsWith("/safety/") && pathname !== "/account/safety" && pathname !== "/account/age" && pathname !== "/account/terms") return null;
  if (!known.includes(route)) return json({ error: "not_found" }, 404);

  try {
    const principal = await authenticate(deps.db, request, deps.now());
    if (deps.userLimit) {
      const { success } = await deps.userLimit.limit({ key: principal.userId });
      if (!success) throw new HttpError(429, "rate_limited");
    }
    const now = deps.now();

    if (route === "GET /account/safety") return json(await getSafety(deps.db, deps.flags, principal.userId));
    if (route === "GET /safety/config") return json(await getClientConfig(deps.db, deps.flags, principal.userId));
    if (route === "POST /account/terms") {
      await acceptTerms(deps.db, principal.userId, await body(request, schemas.AcceptTermsRequest), now);
      return json(await getSafety(deps.db, deps.flags, principal.userId));
    }

    // PUT /account/age. Few tries an hour, so an answer cannot be fished for.
    await limitAccount(deps.db, "ageDeclare", principal.userId, now);
    const change = await body(request, schemas.DeclareAgeRequest);
    // Only the two letter country code is read from the connection. The address is never touched.
    const header = request.headers.get("cf-ipcountry");
    const observed = header && schemas.COUNTRY_CODE.test(header) && header !== "XX" ? header : null;
    return json(await declareAge(deps.db, deps.flags, principal.userId, change, observed, now));
  } catch (err) {
    if (err instanceof HttpError || err instanceof AuthError) return json({ error: err.code }, err.status);
    throw err;
  }
}
