import { schemas } from "@bastion/shared";

/**
 * Shared WebSocket Hibernation plumbing. Each object accepts sockets through
 * `ctx.acceptWebSocket` so it can be evicted from memory between messages.
 */
export function acceptUpgrade(ctx: DurableObjectState, request: Request): Response {
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("expected websocket upgrade", { status: 426 });
  }
  const { 0: client, 1: server } = new WebSocketPair();
  ctx.acceptWebSocket(server);
  return new Response(null, { status: 101, webSocket: client });
}

export function parseFrame(raw: string | ArrayBuffer): schemas.ClientFrame | null {
  if (typeof raw !== "string") return null;
  try {
    const result = schemas.ClientFrame.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function send(ws: WebSocket, frame: schemas.ServerFrame): void {
  ws.send(JSON.stringify(frame));
}
