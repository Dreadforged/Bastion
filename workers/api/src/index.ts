import { cleanupExpired } from "./auth/devices.js";
import { createEmailSender } from "./auth/email.js";
import { simpleWebAuthn } from "./auth/passkeys.js";
import { handleAuth, json } from "./auth/routes.js";
import { handleConversations } from "./conversations/routes.js";
import { NoopScanner } from "./files/scanner.js";
import { R2S3Signer } from "./files/presign.js";
import { cleanupPendingFiles, handleFiles } from "./files/routes.js";
import { handleFileServe } from "./files/serve.js";
import { cleanupInviteCodes, handleServers } from "./servers/routes.js";
import { HttpLiveKitAdmin, type VoiceDeps } from "./voice/livekit.js";
import type { Conversation, Server, UserSession } from "@bastion/durable";

// Durable Object classes must be exported from the Worker entry.
export { Conversation, Server, UserSession } from "@bastion/durable";

export interface Env {
  ENVIRONMENT: string;
  DB: D1Database;
  FILES: R2Bucket;
  USER_SESSION: DurableObjectNamespace<UserSession>;
  SERVER: DurableObjectNamespace<Server>;
  CONVERSATION: DurableObjectNamespace<Conversation>;
  /** WebAuthn relying party id, e.g. the app domain. */
  RP_ID: string;
  RP_NAME: string;
  /** Web app origin; passkeys are bound to it and emailed links point at it. */
  APP_ORIGIN: string;
  /** Per-IP limit for unauthenticated auth endpoints. Optional in local dev. */
  AUTH_RATE_LIMIT?: RateLimit;
  /** Per-user limit for server, message and invite routes. Optional in local dev. */
  API_RATE_LIMIT?: RateLimit;
  /** LiveKit server for voice: wss:// URL, API key and secret. Set the secret with `wrangler secret put`. */
  LIVEKIT_URL?: string;
  LIVEKIT_API_KEY?: string;
  LIVEKIT_API_SECRET?: string;
  /** Origin files are served from. Must be a different domain from the app and the API. */
  FILES_ORIGIN?: string;
  /** Signs download URLs. Secret. */
  FILE_URL_SECRET?: string;
  /** R2 S3 API credentials for pre-signed uploads. Secrets, except the account and bucket names. */
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
}

function voiceDeps(env: Env): VoiceDeps | undefined {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return undefined;
  const config = { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET };
  return { config, admin: new HttpLiveKitAdmin(config) };
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const conversation = (id: string) => env.CONVERSATION.get(env.CONVERSATION.idFromName(id));

    if (url.pathname === "/health") {
      return json({ ok: true, environment: env.ENVIRONMENT });
    }

    // The files domain only serves signed file URLs. Nothing else is reachable on it.
    if (env.FILES_ORIGIN && env.FILE_URL_SECRET) {
      const served = await handleFileServe(request, { db: env.DB, files: env.FILES, now: Date.now, filesOrigin: env.FILES_ORIGIN, urlSecret: env.FILE_URL_SECRET });
      if (served) return served;
      if (url.host === new URL(env.FILES_ORIGIN).host) return new Response(null, { status: 404 });
    }

    const auth = await handleAuth(
      request,
      {
        db: env.DB,
        email: createEmailSender(env.ENVIRONMENT),
        passkeys: simpleWebAuthn({ id: env.RP_ID, name: env.RP_NAME, origin: env.APP_ORIGIN }),
        appOrigin: env.APP_ORIGIN,
        now: Date.now,
        endSessions: (userId, sessionIds) => env.USER_SESSION.get(env.USER_SESSION.idFromName(userId)).closeSessions(sessionIds),
        revokeConversationDevice: (conversationId, deviceId) => conversation(conversationId).revokeDevices([deviceId]),
      },
      env.AUTH_RATE_LIMIT,
    );
    if (auth) return auth;

    const servers = await handleServers(request, {
      db: env.DB,
      servers: env.SERVER,
      sessions: env.USER_SESSION,
      now: Date.now,
      userLimit: env.API_RATE_LIMIT,
      revokeConversationAccess: (conversationId, userId) => conversation(conversationId).revoke([userId]),
      voice: voiceDeps(env),
    });
    if (servers) return servers;

    if (env.FILES_ORIGIN && env.FILE_URL_SECRET && env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET_NAME) {
      const files = await handleFiles(request, {
        db: env.DB,
        files: env.FILES,
        servers: env.SERVER,
        signer: new R2S3Signer({
          accountId: env.R2_ACCOUNT_ID,
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
          bucket: env.R2_BUCKET_NAME,
        }),
        // Stub: lets everything through until a scanning service is chosen.
        scanner: new NoopScanner(),
        now: Date.now,
        userLimit: env.API_RATE_LIMIT,
        filesOrigin: env.FILES_ORIGIN,
        urlSecret: env.FILE_URL_SECRET,
      });
      if (files) return files;
    }

    const conversations = await handleConversations(request, {
      db: env.DB,
      conversations: env.CONVERSATION,
      now: Date.now,
      userLimit: env.API_RATE_LIMIT,
      voice: voiceDeps(env),
    });
    if (conversations) return conversations;

    return json({ error: "not found" }, 404);
  },

  async scheduled(_controller, env): Promise<void> {
    await cleanupExpired(env.DB, Date.now());
    await cleanupInviteCodes(env.DB, Date.now());
    await cleanupPendingFiles(env.DB, env.FILES, Date.now());
  },
} satisfies ExportedHandler<Env>;
