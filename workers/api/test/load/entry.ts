/**
 * Worker entry for the load test only. Same Worker as production, but each
 * Durable Object call logs one `DOREQ <Class>.<method>` line so the load
 * script can count billable requests from `wrangler dev` output.
 */
import { Server as BaseServer, UserSession as BaseUserSession } from "@bastion/durable";
import worker from "../../src/index.js";

export { Conversation } from "@bastion/durable";
export default worker;

function count(name: string): void {
  console.log(`DOREQ ${name}`);
}

export class Server extends BaseServer {
  override async init(...args: Parameters<BaseServer["init"]>) {
    count("Server.init");
    return super.init(...args);
  }

  override async handle(...args: Parameters<BaseServer["handle"]>) {
    count("Server.handle");
    return super.handle(...args);
  }

  override async snapshot(...args: Parameters<BaseServer["snapshot"]>) {
    count("Server.snapshot");
    return super.snapshot(...args);
  }

  override async setPresence(...args: Parameters<BaseServer["setPresence"]>) {
    count("Server.setPresence");
    return super.setPresence(...args);
  }

  override async alarm() {
    count("Server.alarm");
    return super.alarm();
  }
}

export class UserSession extends BaseUserSession {
  override async fetch(request: Request) {
    count("UserSession.fetch");
    return super.fetch(request);
  }

  override async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    count("UserSession.wsMessage");
    return super.webSocketMessage(ws, raw);
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string) {
    count("UserSession.wsClose");
    return super.webSocketClose(ws, code, reason);
  }

  override async receive(...args: Parameters<BaseUserSession["receive"]>) {
    count("UserSession.receive");
    return super.receive(...args);
  }

  override async setStatus(...args: Parameters<BaseUserSession["setStatus"]>) {
    count("UserSession.setStatus");
    return super.setStatus(...args);
  }

  override async createServer(...args: Parameters<BaseUserSession["createServer"]>) {
    count("UserSession.createServer");
    return super.createServer(...args);
  }

  override async closeSessions(...args: Parameters<BaseUserSession["closeSessions"]>) {
    count("UserSession.closeSessions");
    return super.closeSessions(...args);
  }
}
