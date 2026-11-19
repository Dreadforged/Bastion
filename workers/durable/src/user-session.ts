import { CloseCode, GATEWAY_PROTOCOL, type GatewayEvent, type schemas } from "@bastion/shared";
import { DurableObject } from "cloudflare:workers";
import { SESSION_HEADERS, type DurableEnv } from "./env.js";
import { SessionCore, type Attachment, type Conn } from "./session/core.js";
import { SESSION_MIGRATIONS } from "./session/schema.js";
import { fromDurableStorage, migrate } from "./storage.js";

function wrap(ws: WebSocket): Conn {
  return {
    send: (frame) => ws.send(frame),
    close: (code, reason) => ws.close(code, reason),
    get attachment() {
      return ws.deserializeAttachment() as Attachment;
    },
    setAttachment: (attachment) => ws.serializeAttachment(attachment),
  };
}

/**
 * One per user, addressed by `idFromName(userId)`. Holds every live gateway
 * socket for that user (one per client) using WebSocket Hibernation, keeps a
 * numbered event log for resume, and knows which servers the user is in.
 */
export class UserSession extends DurableObject<DurableEnv> {
  private readonly core: SessionCore;

  constructor(ctx: DurableObjectState, env: DurableEnv) {
    super(ctx, env);
    const storage = fromDurableStorage(ctx.storage);
    migrate(storage, SESSION_MIGRATIONS);
    const server = (id: string) => env.SERVER.get(env.SERVER.idFromName(id));
    this.core = new SessionCore(storage, {
      now: Date.now,
      snapshot: (serverId, userId) => server(serverId).snapshot(userId),
      setPresence: (serverId, userId, status) => server(serverId).setPresence(userId, status),
      initServer: (serverId, ownerId, name) => server(serverId).init(serverId, ownerId, name),
    });
  }

  private conns(): Conn[] {
    return this.ctx.getWebSockets().map(wrap);
  }

  /** Gateway upgrade, already authenticated by the Worker. */
  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("expected websocket upgrade", { status: 426 });
    const userId = request.headers.get(SESSION_HEADERS.userId);
    const deviceId = request.headers.get(SESSION_HEADERS.deviceId);
    const sessionId = request.headers.get(SESSION_HEADERS.sessionId);
    if (!userId || !deviceId || !sessionId) return new Response("unauthorized", { status: 401 });

    const { 0: client, 1: server } = new WebSocketPair();
    // Tagged by auth session so a sign-out can find and close its sockets.
    this.ctx.acceptWebSocket(server, [sessionId]);
    const attachment: Attachment = { userId, deviceId, sessionId, state: "new" };
    server.serializeAttachment(attachment);
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": GATEWAY_PROTOCOL },
    });
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    await this.core.onMessage(wrap(ws), raw, this.conns());
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const others = this.ctx.getWebSockets().filter((w) => w !== ws).map(wrap);
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    await this.core.onClose(wrap(ws), others);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    const others = this.ctx.getWebSockets().filter((w) => w !== ws).map(wrap);
    await this.core.onClose(wrap(ws), others);
  }

  // ------------------------------------------------------------ RPC

  /** Called by Server objects with events for this user. */
  async receive(_userId: string, events: GatewayEvent[]): Promise<void> {
    this.core.receive(events, this.conns());
  }

  async setStatus(userId: string, status: schemas.PresenceStatus): Promise<void> {
    await this.core.setStatus(userId, status, this.conns());
  }

  async createServer(userId: string, idempotencyKey: string, name: string): Promise<{ status: number; body: unknown }> {
    return this.core.createServer(userId, idempotencyKey, name);
  }

  /** Close the sockets of ended auth sessions: sign-out, device removal or token reuse. */
  async closeSessions(sessionIds: string[]): Promise<void> {
    for (const sessionId of sessionIds) {
      for (const ws of this.ctx.getWebSockets(sessionId)) {
        try {
          ws.close(CloseCode.SESSION_ENDED, "session ended");
        } catch {
          // already closing
        }
      }
    }
  }
}
