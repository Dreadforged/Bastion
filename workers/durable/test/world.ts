/**
 * In-memory stand-in for the Durable Object runtime: Server and UserSession
 * logic wired together directly, each with its own node:sqlite database.
 */
import { newId, type GatewayEvent, type GatewayServerFrame } from "@bastion/shared";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { BATCH_WINDOW_MS, ServerCore } from "../src/server/core.js";
import { SERVER_MIGRATIONS } from "../src/server/schema.js";
import type { ServerOpInput } from "../src/server/ops.js";
import { SessionCore, type Attachment, type Conn } from "../src/session/core.js";
import { SESSION_MIGRATIONS } from "../src/session/schema.js";
import { migrate, type SqlValue, type Storage } from "../src/storage.js";

export function createTestStorage(): Storage {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  let depth = 0;
  return {
    sql: {
      exec<T>(query: string, ...bindings: SqlValue[]) {
        if (bindings.length === 0 && query.trim().replace(/;\s*$/, "").includes(";")) {
          db.exec(query);
          return { toArray: () => [] as T[], rowsWritten: 0 };
        }
        const stmt = db.prepare(query);
        const params = bindings as SQLInputValue[];
        if (stmt.columns().length > 0) {
          const rows = stmt.all(...params) as T[];
          return { toArray: () => rows, rowsWritten: 0 };
        }
        const { changes } = stmt.run(...params);
        return { toArray: () => [] as T[], rowsWritten: Number(changes) };
      },
    },
    transactionSync<T>(fn: () => T): T {
      const name = `sp${depth++}`;
      db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        db.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        db.exec(`ROLLBACK TO ${name}`);
        db.exec(`RELEASE ${name}`);
        throw err;
      } finally {
        depth--;
      }
    },
  };
}

export class TestConn implements Conn {
  frames: GatewayServerFrame[] = [];
  closed: { code: number; reason: string } | null = null;
  private att: Attachment;

  constructor(userId: string) {
    this.att = { userId, deviceId: newId(), sessionId: newId(), state: "new" };
  }

  send(frame: string): void {
    if (this.closed) throw new Error("socket closed");
    this.frames.push(JSON.parse(frame) as GatewayServerFrame);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  get attachment(): Attachment {
    return this.att;
  }

  setAttachment(attachment: Attachment): void {
    this.att = structuredClone(attachment);
  }

  /** Dispatched events, in order. */
  dispatches(): { t: string; s?: number; d: any }[] {
    return this.frames.flatMap((f) => (f.op === "dispatch" ? [{ t: f.t, ...(f.s === undefined ? {} : { s: f.s }), d: f.d }] : []));
  }

  types(): string[] {
    return this.dispatches().map((d) => d.t);
  }

  clear(): void {
    this.frames = [];
  }
}

interface SessionEntry {
  core: SessionCore;
  conns: TestConn[];
}

export class World {
  now = Date.UTC(2026, 10, 19);
  /** Users whose UserSession is unreachable. */
  readonly down = new Set<string>();
  readonly servers = new Map<string, ServerCore>();
  readonly sessions = new Map<string, SessionEntry>();
  /** How many times each user's session was called with events. */
  readonly deliveries = new Map<string, number>();
  private keyCounter = 0;

  server(serverId: string): ServerCore {
    let core = this.servers.get(serverId);
    if (!core) {
      const storage = createTestStorage();
      migrate(storage, SERVER_MIGRATIONS);
      core = new ServerCore(storage, {
        now: () => this.now,
        deliver: async (userId: string, events: GatewayEvent[]) => {
          if (this.down.has(userId)) throw new Error("unreachable");
          this.deliveries.set(userId, (this.deliveries.get(userId) ?? 0) + 1);
          const session = this.session(userId);
          session.core.receive(events, this.open(session));
        },
      });
      this.servers.set(serverId, core);
    }
    return core;
  }

  session(userId: string): SessionEntry {
    let entry = this.sessions.get(userId);
    if (!entry) {
      const storage = createTestStorage();
      migrate(storage, SESSION_MIGRATIONS);
      const core = new SessionCore(storage, {
        now: () => this.now,
        snapshot: async (serverId, uid) => this.server(serverId).snapshot(uid),
        setPresence: async (serverId, uid, status) => {
          const server = this.server(serverId);
          server.setPresence(uid, status);
          await server.flush();
        },
        initServer: async (serverId, ownerId, name) => {
          const server = this.server(serverId);
          const reply = server.init(serverId, ownerId, name);
          await server.flush();
          return reply;
        },
      });
      entry = { core, conns: [] };
      this.sessions.set(userId, entry);
    }
    return entry;
  }

  private open(entry: SessionEntry): TestConn[] {
    return entry.conns.filter((c) => !c.closed);
  }

  /** Open a gateway socket. */
  connect(userId: string): TestConn {
    const conn = new TestConn(userId);
    this.session(userId).conns.push(conn);
    return conn;
  }

  async frame(conn: TestConn, frame: unknown): Promise<void> {
    const entry = this.session(conn.attachment.userId);
    await entry.core.onMessage(conn, typeof frame === "string" ? frame : JSON.stringify(frame), this.open(entry));
  }

  /** Let batched events (presence, joins) go out, as the alarm would. */
  async settle(): Promise<void> {
    this.now += BATCH_WINDOW_MS;
    for (const server of this.servers.values()) await server.flush();
  }

  async disconnect(conn: TestConn): Promise<void> {
    conn.close(1000, "bye");
    const entry = this.session(conn.attachment.userId);
    await entry.core.onClose(conn, this.open(entry));
  }

  async createServer(ownerId: string, name = "Test"): Promise<string> {
    const reply = await this.session(ownerId).core.createServer(ownerId, this.key(), name);
    if (reply.status >= 300) throw new Error(`createServer failed: ${JSON.stringify(reply)}`);
    return (reply.body as { server: { id: string } }).server.id;
  }

  key(): string {
    return `key-${String(++this.keyCounter).padStart(6, "0")}`;
  }

  /** Run an op with a fresh idempotency key. */
  async op(serverId: string, userId: string, op: ServerOpInput, key: string | null = this.key()) {
    const reply = await this.server(serverId).handle(userId, op, key);
    return reply as { status: number; body: any; effects?: any };
  }

  /** Add a member through a one-use invite made by the owner. */
  async join(serverId: string, ownerId: string, userId: string): Promise<void> {
    const invite = await this.op(serverId, ownerId, { type: "invite.create", body: { maxUses: 1 } });
    const accepted = await this.op(serverId, userId, { type: "invite.accept", code: invite.body.code });
    if (accepted.status !== 200) throw new Error(`join failed: ${JSON.stringify(accepted)}`);
  }

  generalChannel(serverId: string, userId: string): string {
    return this.server(serverId).snapshot(userId)!.channels.find((c) => c.name === "general")!.id;
  }
}

/** Base64 ciphertext of a given byte length. */
export function ciphertext(bytes = 16): string {
  return Buffer.alloc(bytes, 7).toString("base64");
}
