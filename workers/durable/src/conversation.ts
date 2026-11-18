import { DurableObject } from "cloudflare:workers";
import { acceptUpgrade, parseFrame, send } from "./socket.js";

/**
 * One per channel or DM. Orders and relays encrypted message envelopes
 * (MLS ciphertext) to subscribed sockets. Never sees plaintext.
 */
export class Conversation extends DurableObject {
  override async fetch(request: Request): Promise<Response> {
    return acceptUpgrade(this.ctx, request);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const frame = parseFrame(raw);
    if (!frame) return send(ws, { type: "error", code: "bad_frame", message: "invalid frame" });
    if (frame.type === "ping") return send(ws, { type: "pong" });
    if (frame.type === "send") {
      // TODO: permission check, persistence and ordering.
      for (const peer of this.ctx.getWebSockets()) {
        send(peer, { type: "message", message: frame.message });
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
