import { schemas } from "@bastion/shared";
import type { Conversation, ConversationOpInput, ConversationReply } from "@bastion/durable";
import { getPrivacy } from "../account/privacy.js";
import { AuthError } from "../auth/errors.js";
import { toBase64Url } from "../auth/crypto.js";
import { json } from "../auth/routes.js";
import { authenticate, type Principal } from "../auth/sessions.js";
import { body, HttpError, id, query } from "../http.js";
import { applyVoiceEffects, issueToken, type VoiceDeps } from "../voice/livekit.js";
import { claimKeyPackages, devicesBelong, identityKeys, stock, uploadKeyPackages } from "./keys.js";

export interface ConversationRouteDeps {
  db: D1Database;
  conversations: DurableObjectNamespace<Conversation>;
  now: () => number;
  /** Per-user request limit, keyed by user id. Optional in local dev. */
  userLimit?: RateLimit | undefined;
  /** LiveKit settings and admin client. Without them starting or answering a call answers 503. */
  voice?: VoiceDeps | undefined;
  /** A user's plan, for screen share quality. Everyone is on free if unset. */
  planFor?: ((userId: string) => Promise<schemas.Plan>) | undefined;
}

/**
 * Conversation ids are 16 bytes that look random: unlike ULIDs they carry no
 * timestamp. Derived from the caller and their idempotency key, so a retried
 * create lands on the same conversation.
 */
export async function newConversationId(userId: string, idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`conversation:${userId}:${idempotencyKey}`));
  return toBase64Url(new Uint8Array(digest).slice(0, 16));
}

function conversationId(value: string | undefined): string {
  const result = schemas.ConversationId.safeParse(value);
  if (!result.success) throw new HttpError(404, "not_found");
  return result.data;
}

function idempotencyKey(request: Request, required: boolean): string | null {
  const value = request.headers.get("idempotency-key");
  if (value === null) {
    if (required) throw new HttpError(400, "idempotency_key_required");
    return null;
  }
  const result = schemas.IdempotencyKey.safeParse(value);
  if (!result.success) throw new HttpError(400, "invalid_idempotency_key");
  return result.data;
}

/** Keep the D1 membership index in step with what the object did. */
async function applyEffects(db: D1Database, conversationId: string, r: ConversationReply): Promise<void> {
  const statements: D1PreparedStatement[] = [];
  for (const userId of r.effects?.added ?? []) {
    statements.push(
      db.prepare("INSERT OR IGNORE INTO conversation_members (conversation_id, user_id) VALUES (?, ?)").bind(conversationId, userId),
    );
  }
  for (const userId of r.effects?.removed ?? []) {
    statements.push(db.prepare("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?").bind(conversationId, userId));
  }
  if (statements.length > 0) await db.batch(statements);
}

function reply(r: ConversationReply): Response {
  return json(r.body, r.status);
}

async function create(deps: ConversationRouteDeps, principal: Principal, request: Request): Promise<Response> {
  const key = idempotencyKey(request, true)!;
  const req = await body(request, schemas.CreateConversationRequest);
  const { db } = deps;
  const stub = (cid: string) => deps.conversations.get(deps.conversations.idFromName(cid));
  const creator = { userId: principal.userId, deviceId: principal.deviceId };
  const newId = await newConversationId(principal.userId, key);

  // DMs and channels have at most one conversation, so claim the slot first
  // and give it back if the object refuses.
  let release: D1PreparedStatement | null = null;
  if (req.kind === "dm") {
    if (req.userId === principal.userId) throw new HttpError(400, "invalid_request");
    const peer = await db.prepare("SELECT id FROM users WHERE id = ?").bind(req.userId).first();
    if (!peer) throw new HttpError(404, "unknown_user");
    const [a, b] = [principal.userId, req.userId].sort() as [string, string];
    // Only a new DM is refused; an existing one keeps working.
    const existing = await db.prepare("SELECT 1 AS x FROM dm_pairs WHERE user_a = ? AND user_b = ?").bind(a, b).first();
    if (!existing && (await getPrivacy(db, req.userId)).dmPolicy === "nobody") throw new HttpError(403, "cannot_message_user");
    await db.prepare("INSERT OR IGNORE INTO dm_pairs (user_a, user_b, conversation_id) VALUES (?, ?, ?)").bind(a, b, newId).run();
    const row = await db.prepare("SELECT conversation_id FROM dm_pairs WHERE user_a = ? AND user_b = ?").bind(a, b).first<{ conversation_id: string }>();
    if (row!.conversation_id !== newId) {
      const r = (await stub(row!.conversation_id).handle(creator, { type: "get" }, null)) as unknown as ConversationReply;
      return reply(r);
    }
    release = db.prepare("DELETE FROM dm_pairs WHERE conversation_id = ?").bind(newId);
  } else if (req.kind === "channel") {
    await db
      .prepare("INSERT OR IGNORE INTO channel_conversations (channel_id, server_id, conversation_id) VALUES (?, ?, ?)")
      .bind(req.channelId, req.serverId, newId)
      .run();
    const row = await db.prepare("SELECT conversation_id FROM channel_conversations WHERE channel_id = ?").bind(req.channelId).first<{ conversation_id: string }>();
    if (row!.conversation_id !== newId) {
      const r = (await stub(row!.conversation_id).handle(creator, { type: "get" }, null)) as unknown as ConversationReply;
      return r.status === 200 ? json({ error: "already_exists", id: row!.conversation_id }, 409) : reply(r);
    }
    release = db.prepare("DELETE FROM channel_conversations WHERE conversation_id = ?").bind(newId);
  }

  const init = {
    id: newId,
    kind: req.kind,
    creator,
    ...(req.kind === "dm" ? { peerId: req.userId } : {}),
    ...(req.kind === "channel" ? { serverId: req.serverId, channelId: req.channelId } : {}),
  };
  const r = (await stub(newId).init(init)) as unknown as ConversationReply;
  // A retry: the first attempt already made it.
  if (r.status === 409) return reply((await stub(newId).handle(creator, { type: "get" }, null)) as unknown as ConversationReply);
  if (r.status !== 201) {
    if (release) await release.run();
    return reply(r);
  }
  await applyEffects(db, newId, r);
  return reply(r);
}

/**
 * Calls in a direct message. The DM's conversation object holds the state and
 * decides who may do what; this checks the call's key group against D1 and
 * signs LiveKit tokens, which only the Worker can.
 *
 *   GET    /conversations/:id/call            the live call, if any
 *   POST   /conversations/:id/call            ring the other person; returns a token for the caller
 *   POST   /conversations/:id/call/accept     answer; returns a token for the callee
 *   POST   /conversations/:id/call/decline
 *   PATCH  /conversations/:id/call            keep an answered call alive
 *   DELETE /conversations/:id/call            cancel a ring or hang up
 */
async function callRoute(
  deps: ConversationRouteDeps,
  principal: Principal,
  cid: string,
  action: string | undefined,
  request: Request,
): Promise<Response> {
  const m = request.method;
  const actor = { userId: principal.userId, deviceId: principal.deviceId };
  const plan = async () => (await deps.planFor?.(principal.userId)) ?? "free";
  let op: ConversationOpInput | null = null;
  let wantsToken = false;

  if (action === undefined && m === "GET") op = { type: "call.get" };
  else if (action === undefined && m === "PATCH") op = { type: "call.renew" };
  else if (action === undefined && m === "DELETE") op = { type: "call.end" };
  else if (action === undefined && m === "POST") {
    const req = await body(request, schemas.StartCallRequest);
    await checkCallGroup(deps.db, cid, principal.userId, req.groupConversationId);
    op = { type: "call.start", body: req, plan: await plan() };
    wantsToken = true;
  } else if (action === "accept" && m === "POST") {
    op = { type: "call.accept", body: await body(request, schemas.AnswerCallRequest), plan: await plan() };
    wantsToken = true;
  } else if (action === "decline" && m === "POST") op = { type: "call.decline" };
  if (!op) return json({ error: "not_found" }, 404);
  if (wantsToken && !deps.voice) throw new HttpError(503, "voice_unavailable");

  const stub = deps.conversations.get(deps.conversations.idFromName(cid));
  const r = (await stub.handle(actor, op, null)) as unknown as ConversationReply;
  if (deps.voice) await applyVoiceEffects(deps.voice.admin, r.effects?.voice);
  if (wantsToken && r.status === 200 && deps.voice) {
    const g = r.body as {
      call: schemas.DmCall;
      roomId: string;
      participantId: string;
      canPublish: boolean;
      canShare: boolean;
      quality: schemas.VoiceTokenResponse["quality"];
    };
    const { token, expiresAt } = await issueToken(deps.voice.config, g, deps.now());
    const out: schemas.DmCallToken = { ...g, url: deps.voice.config.url, token, expiresAt };
    return json(out);
  }
  return json(r.status === 204 ? null : r.body, r.status);
}

/**
 * The call's key group must be a plain group of exactly these two people. A
 * third member could compute the call's keys, and reusing the DM or a
 * channel conversation would tie call keys to message history.
 */
async function checkCallGroup(db: D1Database, dmId: string, callerId: string, groupId: string): Promise<void> {
  if (groupId === dmId) throw new HttpError(400, "invalid_request");
  const { results: dm } = await db
    .prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?")
    .bind(dmId)
    .all<{ user_id: string }>();
  const pair = new Set(dm.map((r) => r.user_id));
  if (pair.size !== 2 || !pair.has(callerId)) throw new HttpError(404, "not_found");
  const { results: group } = await db
    .prepare("SELECT user_id FROM conversation_members WHERE conversation_id = ?")
    .bind(groupId)
    .all<{ user_id: string }>();
  const members = new Set(group.map((r) => r.user_id));
  if (members.size !== 2 || ![...pair].every((u) => members.has(u))) throw new HttpError(400, "invalid_call_group");
  const special = await db
    .prepare("SELECT 1 AS x FROM dm_pairs WHERE conversation_id = ? UNION ALL SELECT 1 FROM channel_conversations WHERE conversation_id = ?")
    .bind(groupId, groupId)
    .first();
  if (special) throw new HttpError(400, "invalid_call_group");
}

/**
 * Routes for MLS keys and encrypted conversations. Returns null for paths it
 * doesn't own.
 *
 *   POST /keys/packages            upload identity key and key packages
 *   GET  /keys/packages/count      this device's unclaimed stock
 *   POST /keys/packages/claim      take one package per device of some users
 *   GET  /users/:id/keys           a user's device identity keys
 *   GET  /conversations            ids of the caller's conversations
 *   POST /conversations            start a DM, group or channel conversation
 *   GET  /conversations/:id        members, devices and epoch
 *   GET  /conversations/:id/envelopes?after=&limit=
 *   POST /conversations/:id/commits
 *   POST /conversations/:id/messages
 *   .../call                       calls in a DM, see callRoute
 */
export async function handleConversations(request: Request, deps: ConversationRouteDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const parts = pathname.split("/").slice(1);
  const root = parts[0];
  const m = request.method;
  const n = parts.length;
  const isUserKeys = root === "users" && n === 3 && parts[2] === "keys";
  if (root !== "keys" && root !== "conversations" && !isUserKeys) return null;

  try {
    const principal = await authenticate(deps.db, request, deps.now());
    if (deps.userLimit) {
      const { success } = await deps.userLimit.limit({ key: principal.userId });
      if (!success) throw new HttpError(429, "rate_limited");
    }
    const { db } = deps;
    const large = schemas.E2EE_LIMITS.maxBodyBytes;

    if (root === "keys" && parts[1] === "packages") {
      if (n === 2 && m === "POST") {
        return json(await uploadKeyPackages(db, principal, await body(request, schemas.UploadKeyPackagesRequest, large), deps.now()));
      }
      if (n === 3 && parts[2] === "count" && m === "GET") return json({ count: await stock(db, principal.deviceId) });
      if (n === 3 && parts[2] === "claim" && m === "POST") {
        const { userIds } = await body(request, schemas.ClaimKeyPackagesRequest);
        return json(await claimKeyPackages(db, principal, userIds));
      }
      return json({ error: "not_found" }, 404);
    }

    if (isUserKeys && m === "GET") return json({ devices: await identityKeys(db, id(parts[1])) });

    if (root === "conversations") {
      if (n === 1 && m === "GET") {
        const { results } = await db
          .prepare("SELECT conversation_id FROM conversation_members WHERE user_id = ? ORDER BY conversation_id")
          .bind(principal.userId)
          .all<{ conversation_id: string }>();
        return json({ ids: results.map((r) => r.conversation_id) });
      }
      if (n === 1 && m === "POST") return await create(deps, principal, request);

      const cid = conversationId(parts[1]);
      if (parts[2] === "call" && n <= 4) return await callRoute(deps, principal, cid, parts[3], request);
      const actor = { userId: principal.userId, deviceId: principal.deviceId };
      let op: ConversationOpInput | null = null;
      if (n === 2 && m === "GET") op = { type: "get" };
      else if (n === 3 && parts[2] === "envelopes" && m === "GET") op = { type: "fetch", query: query(request, schemas.EnvelopeQuery) };
      else if (n === 3 && parts[2] === "messages" && m === "POST") op = { type: "send", body: await body(request, schemas.SendMessageRequest, large) };
      else if (n === 3 && parts[2] === "commits" && m === "POST") {
        const commit = await body(request, schemas.CommitRequest, large);
        // The object can't see D1, so device ownership is checked here.
        if (!(await devicesBelong(db, commit.adds))) throw new HttpError(400, "unknown_device");
        op = { type: "commit", body: commit };
      }
      if (!op) return json({ error: "not_found" }, 404);

      const key = idempotencyKey(request, op.type === "send" || op.type === "commit");
      const stub = deps.conversations.get(deps.conversations.idFromName(cid));
      const r = (await stub.handle(actor, op, key)) as unknown as ConversationReply;
      await applyEffects(db, cid, r);
      return reply(r);
    }
    return json({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof HttpError || err instanceof AuthError) return json({ error: err.code }, err.status);
    throw err;
  }
}
