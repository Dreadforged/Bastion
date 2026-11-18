import { DurableObject } from "cloudflare:workers";
import { acceptUpgrade, parseFrame, send } from "./socket.js";

/**
 * One per user. Holds the user's live connections (all devices) and fans
 * events out to them.
 */
export class UserSession extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    return acceptUpgrade(this.ctx, request);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const frame = parseFrame(raw);
    if (!frame) return send(ws, { type: "error", code: "bad_frame", message: "invalid frame" });
    if (frame.type === "ping") return send(ws, { type: "pong" });
    // TODO: route subscribe/send to Conversation objects.
    send(ws, { type: "error", code: "not_implemented", message: frame.type });
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
