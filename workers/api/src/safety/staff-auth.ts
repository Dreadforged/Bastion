/**
 * Staff sign-in for the internal admin tool. Platform staff reach it through
 * Cloudflare Access (hardware key policy set up in the Cloudflare dashboard),
 * which puts a signed token in the `Cf-Access-Jwt-Assertion` header. This
 * checks that token's signature, issuer, audience and expiry, so a request
 * that reached the Worker some other way gets nowhere.
 *
 * Unconfigured means off: with no team domain and audience the staff routes
 * answer 404. Nothing here is contacted until staff access is configured.
 */

export interface StaffAuth {
  /** The staff member's id (their email), or null if the request is not from staff. */
  authenticate(request: Request): Promise<string | null>;
}

export interface AccessConfig {
  /** For example `bastion.cloudflareaccess.com`. */
  teamDomain: string;
  /** The Access application's audience tag. */
  audience: string;
  /** Optional second check on top of the Access policy. Lowercase emails. */
  allowedEmails?: string[] | undefined;
  now: () => number;
  /** Fetches the signing keys; replaced in tests. Cached for an hour. */
  fetchKeys?: (url: string) => Promise<{ keys: Jwk[] }>;
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

const KEY_TTL_MS = 60 * 60_000;
const CLOCK_SKEW_S = 60;

function b64url(text: string): Uint8Array<ArrayBuffer> {
  const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "="));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function json(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(b64url(part)));
    return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function cloudflareAccessAuth(config: AccessConfig): StaffAuth {
  let cached: { keys: Jwk[]; at: number } | null = null;
  const certsUrl = `https://${config.teamDomain}/cdn-cgi/access/certs`;
  const fetchKeys =
    config.fetchKeys ??
    (async (url: string) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error("keys_unavailable");
      return (await res.json()) as { keys: Jwk[] };
    });

  async function keys(): Promise<Jwk[]> {
    if (cached && config.now() - cached.at < KEY_TTL_MS) return cached.keys;
    const fresh = ((await fetchKeys(certsUrl)).keys ?? []) as Jwk[];
    cached = { keys: fresh, at: config.now() };
    return fresh;
  }

  return {
    async authenticate(request) {
      const token = request.headers.get("cf-access-jwt-assertion");
      const parts = token?.split(".");
      if (!parts || parts.length !== 3) return null;
      const [h, p, s] = parts as [string, string, string];
      const header = json(h);
      const payload = json(p);
      if (!header || !payload || header.alg !== "RS256" || typeof header.kid !== "string") return null;

      let jwk: Jwk | undefined;
      try {
        jwk = (await keys()).find((k) => k.kid === header.kid);
      } catch {
        return null;
      }
      if (!jwk) return null;
      let valid = false;
      try {
        const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
        valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
      } catch {
        return null;
      }
      if (!valid) return null;

      const nowS = Math.floor(config.now() / 1000);
      if (payload.iss !== `https://${config.teamDomain}`) return null;
      const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (!aud.includes(config.audience)) return null;
      if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < nowS) return null;
      if (typeof payload.nbf === "number" && payload.nbf - CLOCK_SKEW_S > nowS) return null;
      const email = typeof payload.email === "string" ? payload.email.toLowerCase() : null;
      if (!email) return null;
      if (config.allowedEmails && !config.allowedEmails.includes(email)) return null;
      return email;
    },
  };
}
