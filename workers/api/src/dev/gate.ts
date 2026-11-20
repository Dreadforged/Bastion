/**
 * The one place that decides whether the local-only dev routes exist.
 *
 * They exist only when ALL of these hold, and any doubt means off:
 *   1. The Worker was built for local dev (`__BASTION_LOCAL_DEV__` is true).
 *      wrangler.toml sets it to true for the top-level (local) config and to
 *      false in the staging and production environments, so the dev code is
 *      compiled out of those bundles.
 *   2. ENVIRONMENT is exactly "development".
 *   3. DEV_SEED is exactly "local". Nothing but the top-level wrangler.toml sets it.
 *   4. The passkey relying party is "localhost" and the app origin is a local http origin.
 *   5. The request itself arrived on a loopback host.
 *
 * Fail closed: missing, misspelled or unexpected values all return false.
 */

export interface DevGateEnv {
  ENVIRONMENT?: string | undefined;
  DEV_SEED?: string | undefined;
  RP_ID?: string | undefined;
  APP_ORIGIN?: string | undefined;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function isLocalOrigin(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function devSeedAllowed(env: DevGateEnv, requestUrl: string, built: boolean): boolean {
  if (built !== true) return false;
  if (env.ENVIRONMENT !== "development") return false;
  if (env.DEV_SEED !== "local") return false;
  if (env.RP_ID !== "localhost") return false;
  if (!isLocalOrigin(env.APP_ORIGIN)) return false;
  try {
    if (!LOOPBACK_HOSTS.has(new URL(requestUrl).hostname)) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Browsers attach an Origin to cross-site requests. A page on another site
 * must not be able to make the dev routes act, so an Origin that is present
 * has to be the app origin or the API's own origin.
 */
export function devOriginOk(request: Request, appOrigin: string | undefined): boolean {
  const origin = request.headers.get("origin");
  if (origin === null) return true;
  return origin === appOrigin || origin === new URL(request.url).origin;
}
