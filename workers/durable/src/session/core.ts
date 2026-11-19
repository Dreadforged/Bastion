import {
  CloseCode,
  EPHEMERAL_EVENTS,
  GATEWAY_LIMITS,
  GatewayClientFrame,
  newId,
  type GatewayEvent,
  type GatewayServerFrame,
  type schemas,
} from "@bastion/shared";
import { schemas as s } from "@bastion/shared";
import { takeToken, type Bucket, type Storage } from "../storage.js";

/** Kept on each socket so it survives hibernation. */
export interface Attachment {
  userId: string;
  deviceId: string;
  sessionId: string;
  /** "new" until the client identifies or resumes; only "ready" sockets get events. */
  state: "new" | "ready";
  bucket?: Bucket;
}

/** One client connection. The Durable Object wraps a hibernatable WebSocket. */
export interface Conn {
  send(frame: string): void;
  close(code: number, reason: string): void;
  readonly attachment: Attachment;
  setAttachment(attachment: Attachment): void;
}

export interface SessionDeps {
  now: () => number;
  /** This user's view of a server, or null if they are no longer a member. */
  snapshot: (serverId: string, userId: string) => Promise<schemas.ServerSnapshot | null>;
  setPresence: (serverId: string, userId: string, status: schemas.PresenceStatus | "offline") => Promise<void>;
  /** Create a server owned by this user. */
  initServer: (serverId: string, ownerId: string, name: string) => Promise<{ status: number; body: unknown }>;
}

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;

function frame(f: GatewayServerFrame): string {
  return JSON.stringify(f);
}

function safeSend(conn: Conn, f: GatewayServerFrame): void {
  try {
    conn.send(frame(f));
  } catch {
    // Socket already gone; its close handler cleans up.
  }
}

/**
 * The logic of one user's realtime session: their sockets, their numbered
 * event log for resume, and their server list for READY.
 */
export class SessionCore {
  constructor(
    private readonly storage: Storage,
    private readonly deps: SessionDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  private meta(key: string): string | null {
    return this.sql.exec<{ value: string }>("SELECT value FROM _meta WHERE key = ?", key).toArray()[0]?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  /** Latest sequence number handed out. Survives pruning of the log. */
  seq(): number {
    return Number(this.meta("seq") ?? "0");
  }

  status(): schemas.PresenceStatus {
    return (this.meta("status") as schemas.PresenceStatus | null) ?? "online";
  }

  serverIds(): string[] {
    return this.sql.exec<{ server_id: string }>("SELECT server_id FROM servers ORDER BY joined_at, server_id").toArray().map((r) => r.server_id);
  }

  private prune(now: number): void {
    this.sql.exec("DELETE FROM events WHERE at < ?", now - GATEWAY_LIMITS.replayWindowMs);
    this.sql.exec("DELETE FROM events WHERE seq <= ?", this.seq() - GATEWAY_LIMITS.maxReplayEvents);
  }

  // ------------------------------------------------------------ events from servers

  /**
   * Store and push events a Server object sent for this user. Each event is
   * numbered once; a retried delivery of the same event id is ignored.
   */
  receive(events: GatewayEvent[], conns: Conn[]): void {
    const now = this.deps.now();
    const ready = conns.filter((c) => c.attachment.state === "ready");
    const out: GatewayServerFrame[] = [];

    this.storage.transactionSync(() => {
      let seq = this.seq();
      for (const ev of events) {
        if (EPHEMERAL_EVENTS.has(ev.t)) {
          out.push({ op: "dispatch", t: ev.t, d: ev.d });
          continue;
        }
        const known = this.sql.exec("SELECT 1 FROM events WHERE event_id = ?", ev.id).toArray().length > 0;
        if (known) continue;
        seq += 1;
        this.sql.exec("INSERT INTO events (seq, event_id, t, d, at) VALUES (?, ?, ?, ?, ?)", seq, ev.id, ev.t, JSON.stringify(ev.d), now);
        if (ev.t === "SERVER_CREATE") {
          this.sql.exec("INSERT OR IGNORE INTO servers (server_id, joined_at) VALUES (?, ?)", ev.d.server.id, now);
        } else if (ev.t === "SERVER_DELETE") {
          this.sql.exec("DELETE FROM servers WHERE server_id = ?", ev.d.id);
        }
        out.push({ op: "dispatch", t: ev.t, s: seq, d: ev.d });
      }
      this.setMeta("seq", String(seq));
      this.prune(now);
    });

    for (const conn of ready) for (const f of out) safeSend(conn, f);
  }

  // ------------------------------------------------------------ sockets

  async onMessage(conn: Conn, raw: string | ArrayBuffer, conns: Conn[]): Promise<void> {
    const size = typeof raw === "string" ? raw.length : raw.byteLength;
    if (size > GATEWAY_LIMITS.maxFrameBytes) return conn.close(CloseCode.FRAME_TOO_LARGE, "frame too large");

    const { allowed, bucket } = takeToken(conn.attachment.bucket, GATEWAY_LIMITS.frameBurst, GATEWAY_LIMITS.framesPerSecond, this.deps.now());
    conn.setAttachment({ ...conn.attachment, bucket });
    if (!allowed) return conn.close(CloseCode.RATE_LIMITED, "rate limited");

    let parsed: GatewayClientFrame | null = null;
    if (typeof raw === "string") {
      try {
        const result = GatewayClientFrame.safeParse(JSON.parse(raw));
        if (result.success) parsed = result.data;
      } catch {
        // fall through
      }
    }
    if (!parsed) return conn.close(CloseCode.BAD_FRAME, "bad frame");

    switch (parsed.op) {
      case "ping":
        return safeSend(conn, { op: "pong" });
      case "identify":
        if (conn.attachment.state === "ready") return safeSend(conn, { op: "error", code: "already_identified" });
        return this.identify(conn, conns);
      case "resume":
        if (conn.attachment.state === "ready") return safeSend(conn, { op: "error", code: "already_identified" });
        return this.resume(conn, parsed.seq, conns);
    }
  }

  private anyReady(conns: Conn[], except: Conn): boolean {
    return conns.some((c) => c !== except && c.attachment.state === "ready");
  }

  private markReady(conn: Conn, conns: Conn[]): boolean {
    const first = !this.anyReady(conns, conn);
    conn.setAttachment({ ...conn.attachment, state: "ready" });
    return first;
  }

  /** Fresh start: send READY with every server this user is in. */
  private async identify(conn: Conn, conns: Conn[]): Promise<void> {
    const userId = conn.attachment.userId;
    const from = this.seq();
    const ids = this.serverIds();
    const snapshots = await Promise.all(ids.map((id) => this.deps.snapshot(id, userId).catch(() => undefined)));

    const servers: schemas.ServerSnapshot[] = [];
    snapshots.forEach((snap, i) => {
      // null means the server says this user is not a member any more.
      if (snap === null) this.sql.exec("DELETE FROM servers WHERE server_id = ?", ids[i]!);
      else if (snap) servers.push(snap);
    });

    // Everything below runs without awaiting, so no event can slip between
    // READY and the catch-up replay.
    safeSend(conn, { op: "ready", d: { userId, seq: from, servers } });
    const first = this.markReady(conn, conns);
    this.replay(conn, from);
    if (first) await this.broadcastPresence(userId, this.status());
  }

  /** Reconnect: replay what was missed since `seq`, or ask for a fresh identify. */
  private async resume(conn: Conn, seq: number, conns: Conn[]): Promise<void> {
    this.prune(this.deps.now());
    const latest = this.seq();
    const oldest = this.sql.exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM events").toArray()[0]?.seq ?? null;
    const gap = seq < latest && (oldest === null || seq < oldest - 1);
    if (seq > latest || gap) return safeSend(conn, { op: "invalid_session" });

    this.replay(conn, seq);
    safeSend(conn, { op: "resumed", seq: latest });
    const first = this.markReady(conn, conns);
    if (first) await this.broadcastPresence(conn.attachment.userId, this.status());
  }

  private replay(conn: Conn, after: number): void {
    const rows = this.sql
      .exec<{ seq: number; t: string; d: string }>("SELECT seq, t, d FROM events WHERE seq > ? ORDER BY seq", after)
      .toArray();
    for (const row of rows) {
      safeSend(conn, { op: "dispatch", t: row.t as GatewayEvent["t"], s: row.seq, d: JSON.parse(row.d) });
    }
  }

  /** `others` are the sockets still open, not including the closed one. */
  async onClose(conn: Conn, others: Conn[]): Promise<void> {
    if (conn.attachment.state !== "ready") return;
    if (others.some((c) => c.attachment.state === "ready")) return;
    await this.broadcastPresence(conn.attachment.userId, "offline");
  }

  private async broadcastPresence(userId: string, status: schemas.PresenceStatus | "offline"): Promise<void> {
    await Promise.allSettled(this.serverIds().map((id) => this.deps.setPresence(id, userId, status)));
  }

  // ------------------------------------------------------------ HTTPS-initiated

  async setStatus(userId: string, status: schemas.PresenceStatus, conns: Conn[]): Promise<void> {
    this.setMeta("status", status);
    if (conns.some((c) => c.attachment.state === "ready")) await this.broadcastPresence(userId, status);
  }

  /**
   * Create a server owned by this user. The new id is recorded before the
   * Server object is touched, so a retry with the same key reuses it.
   */
  async createServer(userId: string, key: string, name: string): Promise<{ status: number; body: unknown }> {
    const parsed = s.CreateServerRequest.safeParse({ name });
    if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
    const now = this.deps.now();
    this.sql.exec("DELETE FROM created_servers WHERE created_at < ?", now - IDEMPOTENCY_TTL);
    let serverId = this.sql.exec<{ server_id: string }>("SELECT server_id FROM created_servers WHERE key = ?", key).toArray()[0]?.server_id;
    if (!serverId) {
      serverId = newId();
      this.sql.exec("INSERT INTO created_servers (key, server_id, created_at) VALUES (?, ?, ?)", key, serverId, now);
    }
    const reply = await this.deps.initServer(serverId, userId, parsed.data.name);
    if (reply.status < 300) {
      this.sql.exec("INSERT OR IGNORE INTO servers (server_id, joined_at) VALUES (?, ?)", serverId, now);
    }
    return reply;
  }
}
