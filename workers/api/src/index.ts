import { schemas } from "@bastion/shared";
import { cleanupExpired } from "./auth/devices.js";
import { createEmailSender } from "./auth/email.js";
import { simpleWebAuthn } from "./auth/passkeys.js";
import { purgeRemovedAccounts, type DeletionPorts } from "./account/delete.js";
import { handleAccount } from "./account/routes.js";
import { advanceAgeBands } from "./safety/account.js";
import { syncAgeLimit } from "./safety/enforce.js";
import { FlagReader } from "./safety/flags.js";
import { handleSafety } from "./safety/routes.js";
import { cloudflareAccessAuth, type StaffAuth } from "./safety/staff-auth.js";
import { handleStaff } from "./safety/staff-routes.js";
import { handleAuth, json } from "./auth/routes.js";
import { handleConversations } from "./conversations/routes.js";
import { NoopScanner } from "./files/scanner.js";
import { R2S3Signer } from "./files/presign.js";
import { cleanupPendingFiles, handleFiles } from "./files/routes.js";
import { handleFileServe } from "./files/serve.js";
import { cleanupInviteCodes, cleanupLiveStreams, handleServers, type ServerRouteDeps } from "./servers/routes.js";
import { devOriginOk, devSeedAllowed } from "./dev/gate.js";
import { devStaffAuth, handleDev } from "./dev/routes.js";
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
  /**
   * Staff admin tool, behind Cloudflare Access. Leave unset and /staff answers 404.
   * The team domain looks like `yourteam.cloudflareaccess.com`; the audience is the Access application's AUD tag.
   * STAFF_EMAILS is an optional comma separated second check on top of the Access policy.
   */
  STAFF_ACCESS_TEAM_DOMAIN?: string;
  STAFF_ACCESS_AUDIENCE?: string;
  STAFF_EMAILS?: string;
  /** Local dev only: "local" turns on the /dev routes. Only the top-level (local) wrangler.toml sets it. */
  DEV_SEED?: string;
}

// __BASTION_LOCAL_DEV__ comes from [define] in wrangler.toml: true locally, false in staging and
// production. The test is written out inline wherever it is needed (not behind a constant or a
// function) so the bundler folds it and drops the dev code from staging and production bundles.
// Undefined, as under vitest, counts as false.

let staffAuth: StaffAuth | undefined;
function staffFor(env: Env): StaffAuth | undefined {
  if (!env.STAFF_ACCESS_TEAM_DOMAIN || !env.STAFF_ACCESS_AUDIENCE) return undefined;
  const emails = env.STAFF_EMAILS?.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  staffAuth ??= cloudflareAccessAuth({
    teamDomain: env.STAFF_ACCESS_TEAM_DOMAIN,
    audience: env.STAFF_ACCESS_AUDIENCE,
    allowedEmails: emails && emails.length > 0 ? emails : undefined,
    now: Date.now,
  });
  return staffAuth;
}

function deletionPorts(env: Env): Omit<DeletionPorts, "db" | "now"> {
  const server = (id: string) => env.SERVER.get(env.SERVER.idFromName(id));
  const key = (kind: string, a: string, b: string) => `${kind}-${a.slice(-12)}${b.slice(-12)}`.slice(0, 64);
  return {
    serverIds: (userId) => env.USER_SESSION.get(env.USER_SESSION.idFromName(userId)).listServerIds(),
    serverOwner: async (serverId, userId) => (await server(serverId).snapshot(userId))?.server.ownerId ?? null,
    leaveServer: async (serverId, userId) => {
      await server(serverId).handle(userId, { type: "member.remove", userId, body: {} }, key("leave", serverId, userId));
    },
    deleteServer: async (serverId, ownerId) => {
      await server(serverId).handle(ownerId, { type: "server.delete" }, key("delete", serverId, ownerId));
    },
    revokeConversation: (conversationId, userId) => env.CONVERSATION.get(env.CONVERSATION.idFromName(conversationId)).revoke([userId]),
    endSessions: (userId, sessionIds) => env.USER_SESSION.get(env.USER_SESSION.idFromName(userId)).closeSessions(sessionIds),
    files: env.FILES,
  };
}

function serverDeps(env: Env): ServerRouteDeps {
  const conversation = (id: string) => env.CONVERSATION.get(env.CONVERSATION.idFromName(id));
  return {
    db: env.DB,
    servers: env.SERVER,
    sessions: env.USER_SESSION,
    now: Date.now,
    flags: flagsFor(env),
    userLimit: env.API_RATE_LIMIT,
    revokeConversationAccess: (conversationId, userId) => conversation(conversationId).revoke([userId]),
    voice: voiceDeps(env),
  };
}

function voiceDeps(env: Env): VoiceDeps | undefined {
  if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) return undefined;
  const config = { url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET };
  return { config, admin: new HttpLiveKitAdmin(config) };
}

// Kept at module level so the flag cache is shared by requests in this isolate.
let flagReader: FlagReader | undefined;
function flagsFor(env: Env): FlagReader {
  flagReader ??= new FlagReader(env.DB, Date.now);
  return flagReader;
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const conversation = (id: string) => env.CONVERSATION.get(env.CONVERSATION.idFromName(id));

    if (url.pathname === "/health") {
      return json({ ok: true, environment: env.ENVIRONMENT });
    }

    // Local dev sign-in and seed data. Compiled out of staging and production builds, and closed unless
    // every condition in dev/gate.ts holds. Anywhere else these paths fall through to "not found".
    if (typeof __BASTION_LOCAL_DEV__ !== "undefined" && __BASTION_LOCAL_DEV__ === true && url.pathname.startsWith("/dev/") && devSeedAllowed(env, request.url, true)) {
      if (!devOriginOk(request, env.APP_ORIGIN)) return json({ error: "forbidden" }, 403);
      const handled = await handleDev(request, {
        db: env.DB,
        flags: flagsFor(env),
        now: Date.now,
        api: async (req) => (await handleServers(req, serverDeps(env))) ?? json({ error: "not found" }, 404),
      });
      if (handled) return handled;
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

    const safety = await handleSafety(request, {
      db: env.DB,
      flags: flagsFor(env),
      now: Date.now,
      userLimit: env.API_RATE_LIMIT,
      onAgeChange: (userId) => syncAgeLimit({ db: env.DB, sessions: env.USER_SESSION, servers: env.SERVER }, userId),
    });
    if (safety) return safety;

    const staff = await handleStaff(request, {
      db: env.DB,
      staff: staffFor(env) ?? (typeof __BASTION_LOCAL_DEV__ !== "undefined" && __BASTION_LOCAL_DEV__ === true && devSeedAllowed(env, request.url, true) ? devStaffAuth() : undefined),
      flags: flagsFor(env),
      now: Date.now,
      onAccountChange: async (userId, state) => {
        if (schemas.BLOCKED_STATES.includes(state)) {
          const { results } = await env.DB.prepare("DELETE FROM sessions WHERE user_id = ? RETURNING id").bind(userId).all<{ id: string }>();
          await env.USER_SESSION.get(env.USER_SESSION.idFromName(userId)).closeSessions(results.map((r) => r.id));
        }
        await syncAgeLimit({ db: env.DB, sessions: env.USER_SESSION, servers: env.SERVER }, userId);
      },
      setReportHold: (serverId, reportId, held) => env.SERVER.get(env.SERVER.idFromName(serverId)).holdReport(reportId, held),
    });
    if (staff) return staff;

    const account = await handleAccount(request, { db: env.DB, sessions: env.USER_SESSION, now: Date.now, userLimit: env.API_RATE_LIMIT, flags: flagsFor(env), deletion: deletionPorts(env) });
    if (account) return account;

    const servers = await handleServers(request, serverDeps(env));
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
      flags: flagsFor(env),
      sharesServer: async (a, b) => {
        const ids = (u: string) => env.USER_SESSION.get(env.USER_SESSION.idFromName(u)).listServerIds();
        const [x, y] = await Promise.all([ids(a), ids(b)]);
        return x.some((s) => y.includes(s));
      },
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
    await cleanupLiveStreams(env.DB, Date.now());
    await cleanupPendingFiles(env.DB, env.FILES, Date.now());
    await purgeRemovedAccounts({ ...deletionPorts(env), db: env.DB, now: Date.now }, Date.now());
    await advanceAgeBands(env.DB, flagsFor(env), Date.now(), (userId) => syncAgeLimit({ db: env.DB, sessions: env.USER_SESSION, servers: env.SERVER }, userId));
  },
} satisfies ExportedHandler<Env>;
