import { Id } from "@bastion/shared";
import { cleanupExpired } from "./auth/devices.js";
import { createEmailSender } from "./auth/email.js";
import { simpleWebAuthn } from "./auth/passkeys.js";
import { handleAuth, json } from "./auth/routes.js";

// Durable Object classes must be exported from the Worker entry.
export { Conversation, Server, UserSession } from "@bastion/durable";

export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  FILES: R2Bucket;
  USER_SESSION: DurableObjectNamespace;
  SERVER: DurableObjectNamespace;
  CONVERSATION: DurableObjectNamespace;
  /** WebAuthn relying party id, e.g. the app domain. */
  RP_ID: string;
  RP_NAME: string;
  /** Web app origin; passkeys are bound to it and emailed links point at it. */
  APP_ORIGIN: string;
  /** Per-IP limit for unauthenticated auth endpoints. Optional in local dev. */
  AUTH_RATE_LIMIT?: RateLimit;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, environment: env.ENVIRONMENT });
    }

    const auth = await handleAuth(
      request,
      {
        db: env.DB,
        email: createEmailSender(env.ENVIRONMENT),
        passkeys: simpleWebAuthn({ id: env.RP_ID, name: env.RP_NAME, origin: env.APP_ORIGIN }),
        appOrigin: env.APP_ORIGIN,
        now: Date.now,
      },
      env.AUTH_RATE_LIMIT,
    );
    if (auth) return auth;

    // GET /conversations/:id/socket upgrades into the Conversation object.
    const match = url.pathname.match(/^\/conversations\/([^/]+)\/socket$/);
    if (match) {
      const parsed = Id.safeParse(match[1]);
      if (!parsed.success) return json({ error: "invalid id" }, 400);
      // TODO: authenticate and check VIEW_CHANNEL before upgrading.
      const stub = env.CONVERSATION.get(env.CONVERSATION.idFromName(parsed.data));
      return stub.fetch(request);
    }

    return json({ error: "not found" }, 404);
  },

  async scheduled(_controller, env): Promise<void> {
    await cleanupExpired(env.DB, Date.now());
  },
} satisfies ExportedHandler<Env>;
