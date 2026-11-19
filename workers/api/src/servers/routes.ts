import { GATEWAY_AUTH_PREFIX, GATEWAY_PROTOCOL, Id, schemas } from "@bastion/shared";
import type { Reply, Server, ServerOpInput, UserSession } from "@bastion/durable";
import { SESSION_HEADERS } from "@bastion/durable/env";
import type { z } from "zod";
import { AuthError } from "../auth/errors.js";
import { json } from "../auth/routes.js";
import { authenticate, type Principal } from "../auth/sessions.js";
import { body, HttpError, id, query } from "../http.js";

export interface ServerRouteDeps {
  db: D1Database;
  servers: DurableObjectNamespace<Server>;
  sessions: DurableObjectNamespace<UserSession>;
  now: () => number;
  /** Per-user request limit, keyed by user id. Optional in local dev. */
  userLimit?: RateLimit | undefined;
}

function inviteCode(value: string | undefined): string {
  const result = schemas.InviteCode.safeParse(value);
  if (!result.success) throw new HttpError(404, "unknown_invite");
  return result.data;
}

function idempotencyKey(request: Request): string | null {
  const value = request.headers.get("idempotency-key");
  if (value === null) return null;
  const result = schemas.IdempotencyKey.safeParse(value);
  if (!result.success) throw new HttpError(400, "invalid_idempotency_key");
  return result.data;
}

/** Hide the Worker-only `effects` from clients. */
function reply(r: Reply): Response {
  return json(r.status === 204 ? null : r.body, r.status);
}

/** Map a route under /servers/:id to a Server object op. */
async function serverOp(request: Request, parts: string[], principal: Principal): Promise<ServerOpInput | null> {
  const m = request.method;
  const [, , a, b, c, d, e] = parts;
  const n = parts.length;

  if (n === 2 && m === "PATCH") return { type: "server.update", body: await body(request, schemas.UpdateServerRequest) };
  if (n === 2 && m === "DELETE") return { type: "server.delete" };

  if (a === "channels") {
    if (n === 3 && m === "POST") return { type: "channel.create", body: await body(request, schemas.CreateChannelRequest) };
    const channelId = id(b);
    if (n === 4 && m === "PATCH") return { type: "channel.update", channelId, body: await body(request, schemas.UpdateChannelRequest) };
    if (n === 4 && m === "DELETE") return { type: "channel.delete", channelId };
    if (n === 7 && c === "overrides") {
      const kind = schemas.OverrideKind.safeParse(d);
      if (!kind.success) return null;
      const targetId = id(e);
      if (m === "PUT") {
        return { type: "override.put", channelId, kind: kind.data, targetId, body: await body(request, schemas.PutOverrideRequest) };
      }
      if (m === "DELETE") return { type: "override.delete", channelId, kind: kind.data, targetId };
    }
    if (c === "messages") {
      if (n === 5 && m === "GET") return { type: "messages.list", channelId, query: query(request, schemas.MessageHistoryQuery) };
      if (n === 5 && m === "POST") return { type: "message.create", channelId, body: await body(request, schemas.CreateMessageRequest) };
      const messageId = id(d);
      if (n === 6 && m === "PATCH") {
        return { type: "message.update", channelId, messageId, body: await body(request, schemas.UpdateMessageRequest) };
      }
      if (n === 6 && m === "DELETE") return { type: "message.delete", channelId, messageId };
    }
    if (n === 5 && c === "typing" && m === "POST") return { type: "typing", channelId };
    return null;
  }

  if (a === "roles") {
    if (n === 3 && m === "POST") return { type: "role.create", body: await body(request, schemas.CreateRoleRequest) };
    const roleId = id(b);
    if (n === 4 && m === "PATCH") return { type: "role.update", roleId, body: await body(request, schemas.UpdateRoleRequest) };
    if (n === 4 && m === "DELETE") return { type: "role.delete", roleId };
    return null;
  }

  if (a === "members") {
    const userId = b === "@me" ? principal.userId : id(b);
    if (n === 4 && m === "DELETE") return { type: "member.remove", userId, body: await body(request, schemas.ReasonRequest) };
    if (n === 5 && c === "timeout") {
      if (m === "PUT") return { type: "member.timeout", userId, body: await body(request, schemas.TimeoutRequest) };
      if (m === "DELETE") return { type: "member.timeout.remove", userId, body: await body(request, schemas.ReasonRequest) };
    }
    if (n === 6 && c === "roles") {
      const roleId = id(d);
      if (m === "PUT") return { type: "member.role.add", userId, roleId };
      if (m === "DELETE") return { type: "member.role.remove", userId, roleId };
    }
    return null;
  }

  if (a === "bans") {
    if (n === 3 && m === "GET") return { type: "bans.list", query: query(request, schemas.BanListQuery) };
    if (n !== 4) return null;
    const userId = id(b);
    if (m === "PUT") return { type: "ban.put", userId, body: await body(request, schemas.BanRequest) };
    if (m === "DELETE") return { type: "ban.delete", userId, body: await body(request, schemas.ReasonRequest) };
    return null;
  }

  if (a === "reports") {
    if (n === 3 && m === "POST") return { type: "report.create", body: await body(request, schemas.CreateReportRequest) };
    if (n === 3 && m === "GET") return { type: "reports.list", query: query(request, schemas.ReportListQuery) };
    if (n === 4 && m === "PATCH") return { type: "report.update", reportId: id(b), body: await body(request, schemas.UpdateReportRequest) };
    return null;
  }

  if (a === "audit-log" && n === 3 && m === "GET") return { type: "audit.list", query: query(request, schemas.AuditLogQuery) };

  if (a === "invites" && n === 3 && m === "POST") {
    return { type: "invite.create", body: await body(request, schemas.CreateInviteRequest) };
  }
  return null;
}

/** Keep the D1 invite index in step with what the Server object did. */
async function applyEffects(deps: ServerRouteDeps, serverId: string, r: Reply): Promise<void> {
  const created = r.effects?.inviteCreated;
  if (created) {
    await deps.db
      .prepare("INSERT OR IGNORE INTO invite_codes (code, server_id, expires_at) VALUES (?, ?, ?)")
      .bind(created.code, serverId, created.expiresAt)
      .run();
  }
  const gone = r.effects?.inviteGone;
  if (gone) await deps.db.prepare("DELETE FROM invite_codes WHERE code = ?").bind(gone).run();
  if (r.effects?.serverDeleted) await deps.db.prepare("DELETE FROM invite_codes WHERE server_id = ?").bind(serverId).run();
}

async function inviteServer(deps: ServerRouteDeps, code: string): Promise<string> {
  const row = await deps.db
    .prepare("SELECT server_id FROM invite_codes WHERE code = ? AND (expires_at IS NULL OR expires_at > ?)")
    .bind(code, deps.now())
    .first<{ server_id: string }>();
  if (!row) throw new HttpError(404, "unknown_invite");
  return row.server_id;
}

/**
 * The WebSocket gateway. Browsers cannot set headers on a WebSocket, so the
 * access token rides in a subprotocol: `bastion.v1, bastion.auth.<token>`.
 */
async function gateway(request: Request, deps: ServerRouteDeps): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "expected_websocket");
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((p) => p.trim());
  if (!protocols.includes(GATEWAY_PROTOCOL)) throw new HttpError(400, "unsupported_protocol");
  const token = protocols.find((p) => p.startsWith(GATEWAY_AUTH_PREFIX))?.slice(GATEWAY_AUTH_PREFIX.length);
  const authHeader = token ? `Bearer ${token}` : (request.headers.get("authorization") ?? "");
  const principal = await authenticate(deps.db, new Request(request.url, { headers: { authorization: authHeader } }), deps.now());

  const headers = new Headers(request.headers);
  headers.delete("authorization");
  headers.delete("sec-websocket-protocol");
  headers.set(SESSION_HEADERS.userId, principal.userId);
  headers.set(SESSION_HEADERS.deviceId, principal.deviceId);
  headers.set(SESSION_HEADERS.sessionId, principal.sessionId);
  const stub = deps.sessions.get(deps.sessions.idFromName(principal.userId));
  return stub.fetch(new Request(request.url, { method: "GET", headers }));
}

/**
 * Routes for servers, channels, roles, members, messages, invites, presence,
 * moderation and the gateway. Returns null for paths it doesn't own.
 */
export async function handleServers(request: Request, deps: ServerRouteDeps): Promise<Response | null> {
  const { pathname } = new URL(request.url);
  const parts = pathname.split("/").slice(1);
  const root = parts[0];
  if (root !== "servers" && root !== "invites" && root !== "presence" && root !== "gateway") return null;

  try {
    if (root === "gateway" && parts.length === 1 && request.method === "GET") return await gateway(request, deps);

    const principal = await authenticate(deps.db, request, deps.now());
    if (deps.userLimit) {
      const { success } = await deps.userLimit.limit({ key: principal.userId });
      if (!success) throw new HttpError(429, "rate_limited");
    }
    const key = idempotencyKey(request);
    const session = () => deps.sessions.get(deps.sessions.idFromName(principal.userId));
    // RPC return types lose `unknown` fields, so replies are re-typed here.
    const handle = async (serverId: string, op: ServerOpInput): Promise<Reply> =>
      (await deps.servers.get(deps.servers.idFromName(serverId)).handle(principal.userId, op, key)) as unknown as Reply;

    if (root === "presence" && parts.length === 1 && request.method === "PUT") {
      const { status } = await body(request, schemas.UpdatePresenceRequest);
      await session().setStatus(principal.userId, status);
      return json(null, 204);
    }

    if (root === "invites" && parts.length === 2) {
      const code = inviteCode(parts[1]);
      const type = { GET: "invite.preview", POST: "invite.accept", DELETE: "invite.delete" }[request.method] as
        | "invite.preview"
        | "invite.accept"
        | "invite.delete"
        | undefined;
      if (!type) return json({ error: "not_found" }, 404);
      const serverId = await inviteServer(deps, code);
      const r = await handle(serverId, { type, code });
      // The object found the code gone or lapsed: drop it from the index too.
      const lapsed = r.status === 404 && (r.body as { error?: string } | null)?.error === "unknown_invite";
      if (lapsed) await applyEffects(deps, serverId, { ...r, effects: { inviteGone: code } });
      else await applyEffects(deps, serverId, r);
      return reply(r);
    }

    if (root === "servers") {
      if (parts.length === 1 && request.method === "POST") {
        if (!key) throw new HttpError(400, "idempotency_key_required");
        const { name } = await body(request, schemas.CreateServerRequest);
        const r = (await session().createServer(principal.userId, key, name)) as unknown as Reply;
        return json(r.body, r.status);
      }
      if (parts.length >= 2) {
        const serverId = id(parts[1]);
        const op = await serverOp(request, parts, principal);
        if (op) {
          const r = await handle(serverId, op);
          await applyEffects(deps, serverId, r);
          return reply(r);
        }
      }
    }
    return json({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof HttpError || err instanceof AuthError) return json({ error: err.code }, err.status);
    throw err;
  }
}

/** Drop lapsed invite codes from the index. Run from the cron trigger. */
export async function cleanupInviteCodes(db: D1Database, now: number): Promise<void> {
  await db.prepare("DELETE FROM invite_codes WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now).run();
}
