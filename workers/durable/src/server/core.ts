import {
  ALL_PERMISSIONS,
  Permission,
  computeBasePermissions,
  computePermissions,
  has,
  newId,
  parsePermissions,
  serializePermissions,
  type ChannelOverrides,
  type EventName,
  type EventPayload,
  type GatewayEvent,
  type PermissionContext,
  type schemas,
} from "@bastion/shared";
import { schemas as s } from "@bastion/shared";
import { takeToken, type Bucket, type Storage } from "../storage.js";
import type { z } from "zod";
import { READ_ONLY_OPS, ServerOp, type Reply } from "./ops.js";

const P = Permission;

/** Default @everyone permissions for a new server. */
export const DEFAULT_EVERYONE =
  P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.CONNECT_VOICE | P.SPEAK | P.CREATE_INVITE;

const IDEMPOTENCY_TTL = 24 * 60 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 20;
const DELIVERY_BATCH = 100;

/** Per-user request limits: burst, then refill per second. */
const RATE = {
  message: { burst: 10, perSecond: 1 },
  typing: { burst: 5, perSecond: 0.5 },
  write: { burst: 30, perSecond: 0.5 },
  /** Reports: a few at once, then one a minute. */
  report: { burst: 3, perSecond: 1 / 60 },
} as const;

/** Bucket key prefix for each limit. */
const RATE_KEY = new Map<object, string>([
  [RATE.message, "m"],
  [RATE.typing, "t"],
  [RATE.write, "w"],
  [RATE.report, "r"],
]);

const ML = s.MODERATION_LIMITS;

export interface ServerDeps {
  now: () => number;
  /** Hand events to a user's UserSession. Throws if it could not. */
  deliver: (userId: string, events: GatewayEvent[]) => Promise<void>;
}

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

function fail(status: number, code: string): never {
  throw new Fail(status, code);
}

interface RoleRow {
  id: string;
  name: string;
  permissions: bigint;
  position: number;
}

interface ChannelRow {
  id: string;
  name: string;
  kind: "text" | "voice";
  position: number;
  slow_mode_seconds: number;
}

interface OverrideRow {
  channel_id: string;
  kind: "role" | "member";
  target_id: string;
  allow: string;
  deny: string;
}

/** Everything permission checks need, loaded once per operation. */
interface Snapshot {
  serverId: string;
  ownerId: string;
  roles: Map<string, RoleRow>;
  /** user id to role ids (not including @everyone) */
  members: Map<string, string[]>;
  channels: Map<string, ChannelRow>;
  overrides: Map<string, OverrideRow[]>;
  /** Members in a timeout right now, to when it ends. */
  timeouts: Map<string, number>;
}

interface Emit {
  users: Iterable<string>;
  event: GatewayEvent;
  /** Recipient must still see this channel at delivery time. */
  channelId?: string | null;
  /** Recipient must still be a member at delivery time. Default true. */
  memberOnly?: boolean;
  /** Recipient must still hold these, in `channelId` when set. */
  permission?: bigint;
}

interface AuditInput {
  targetId?: string | null;
  channelId?: string | null;
  reason?: string | undefined;
  data?: Record<string, string | number | boolean | null>;
}

interface ReportRow {
  id: string;
  channel_id: string;
  category: string;
  note: string | null;
  status: string;
  handled_by: string | null;
  created_at: number;
  updated_at: number;
}

interface AuditRow {
  id: string;
  actor_id: string;
  action: string;
  target_id: string | null;
  channel_id: string | null;
  reason: string | null;
  data: string;
  created_at: number;
}

function event<T extends EventName>(t: T, d: EventPayload<T>): GatewayEvent {
  return { id: newId(), t, d } as GatewayEvent;
}

/** FNV-1a, to spot an idempotency key reused for a different request. */
function fingerprint(value: string): string {
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i++) {
    h ^= BigInt(value.charCodeAt(i));
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16);
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function newInviteCode(): string {
  let code = "";
  while (code.length < 10) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 248 = 62 * 4, so bytes below it map to base62 without bias.
      if (byte < 248 && code.length < 10) code += BASE62[byte % 62];
    }
  }
  return code;
}

/**
 * The logic of one community server. The Durable Object wrapper owns storage
 * and the network; this class is plain code so it can be tested directly.
 *
 * Every change runs in one SQLite transaction together with the outbox rows
 * for its events. Recipients are computed from permissions at that moment and
 * checked again just before delivery.
 */
export class ServerCore {
  private readonly buckets = new Map<string, Bucket>();
  private flushing = false;
  private flushAgain = false;

  constructor(
    private readonly storage: Storage,
    private readonly deps: ServerDeps,
  ) {}

  private get sql() {
    return this.storage.sql;
  }

  // ------------------------------------------------------------ loading

  private serverRow(): { id: string; name: string; owner_id: string } | undefined {
    return this.sql.exec<{ id: string; name: string; owner_id: string }>("SELECT id, name, owner_id FROM server").toArray()[0];
  }

  private load(): Snapshot {
    const server = this.serverRow();
    if (!server) fail(404, "unknown_server");
    const roles = new Map<string, RoleRow>();
    for (const r of this.sql.exec<{ id: string; name: string; permissions: string; position: number }>(
      "SELECT id, name, permissions, position FROM roles",
    ).toArray()) {
      roles.set(r.id, { id: r.id, name: r.name, permissions: parsePermissions(r.permissions), position: r.position });
    }
    const members = new Map<string, string[]>();
    const timeouts = new Map<string, number>();
    const now = this.deps.now();
    for (const m of this.sql.exec<{ user_id: string }>("SELECT user_id FROM members").toArray()) members.set(m.user_id, []);
    for (const t of this.sql.exec<{ user_id: string; until: number }>("SELECT user_id, until FROM timeouts WHERE until > ?", now).toArray()) {
      if (members.has(t.user_id)) timeouts.set(t.user_id, t.until);
    }
    for (const mr of this.sql.exec<{ user_id: string; role_id: string }>("SELECT user_id, role_id FROM member_roles").toArray()) {
      members.get(mr.user_id)?.push(mr.role_id);
    }
    const channels = new Map<string, ChannelRow>();
    for (const c of this.sql.exec<ChannelRow>(
      "SELECT id, name, kind, position, slow_mode_seconds FROM channels ORDER BY position, id",
    ).toArray()) {
      channels.set(c.id, c);
    }
    const overrides = new Map<string, OverrideRow[]>();
    for (const o of this.sql.exec<OverrideRow>(
      "SELECT channel_id, kind, target_id, allow, deny FROM channel_overrides ORDER BY kind, target_id",
    ).toArray()) {
      const list = overrides.get(o.channel_id) ?? [];
      list.push(o);
      overrides.set(o.channel_id, list);
    }
    return { serverId: server.id, ownerId: server.owner_id, roles, members, channels, overrides, timeouts };
  }

  // ------------------------------------------------------------ permissions

  private context(snap: Snapshot, userId: string, channelId?: string): PermissionContext {
    const everyone = snap.roles.get(snap.serverId)!;
    const memberRoles = (snap.members.get(userId) ?? []).flatMap((id) => {
      const role = snap.roles.get(id);
      return role ? [role] : [];
    });
    const ctx: PermissionContext = { userId, ownerId: snap.ownerId, everyoneRole: everyone, memberRoles };
    // Every check, including the one before delivery, sees the timeout.
    if (snap.timeouts.has(userId)) ctx.timedOut = true;
    if (channelId !== undefined) ctx.channel = this.channelOverrides(snap, channelId);
    return ctx;
  }

  private channelOverrides(snap: Snapshot, channelId: string): ChannelOverrides {
    const roles: Record<string, { allow: bigint; deny: bigint }> = {};
    const members: Record<string, { allow: bigint; deny: bigint }> = {};
    let everyone: { allow: bigint; deny: bigint } | undefined;
    for (const o of snap.overrides.get(channelId) ?? []) {
      const value = { allow: parsePermissions(o.allow), deny: parsePermissions(o.deny) };
      if (o.kind === "member") members[o.target_id] = value;
      else if (o.target_id === snap.serverId) everyone = value;
      else roles[o.target_id] = value;
    }
    return everyone ? { everyone, roles, members } : { roles, members };
  }

  private basePermissions(snap: Snapshot, userId: string): bigint {
    if (!snap.members.has(userId)) return 0n;
    return computeBasePermissions(this.context(snap, userId));
  }

  private channelPermissions(snap: Snapshot, userId: string, channelId: string): bigint {
    if (!snap.members.has(userId) || !snap.channels.has(channelId)) return 0n;
    return computePermissions(this.context(snap, userId, channelId));
  }

  private canView(snap: Snapshot, userId: string, channelId: string): boolean {
    return has(this.channelPermissions(snap, userId, channelId), P.VIEW_CHANNEL);
  }

  private requireBase(snap: Snapshot, userId: string, flag: bigint): bigint {
    const perms = this.basePermissions(snap, userId);
    if (!has(perms, flag)) fail(403, "missing_permissions");
    return perms;
  }

  private requireChannel(snap: Snapshot, userId: string, channelId: string, flag: bigint): bigint {
    if (!snap.channels.has(channelId)) fail(404, "unknown_channel");
    const perms = this.channelPermissions(snap, userId, channelId);
    // Hide channels the caller cannot see.
    if (!has(perms, P.VIEW_CHANNEL)) fail(404, "unknown_channel");
    if (!has(perms, flag)) fail(403, "missing_permissions");
    return perms;
  }

  /** Highest role position a member holds. The owner outranks everyone. */
  private rank(snap: Snapshot, userId: string): number {
    if (userId === snap.ownerId) return Number.POSITIVE_INFINITY;
    let top = 0;
    for (const id of snap.members.get(userId) ?? []) top = Math.max(top, snap.roles.get(id)?.position ?? 0);
    return top;
  }

  /** A caller can only hand out permissions they hold themselves. */
  private requireSubset(granted: bigint, held: bigint): void {
    if ((granted & ~held) !== 0n) fail(403, "missing_permissions");
  }

  private viewers(snap: Snapshot, channelId: string): string[] {
    return [...snap.members.keys()].filter((u) => this.canView(snap, u, channelId));
  }

  private visibility(snap: Snapshot): Map<string, Set<string>> {
    const map = new Map<string, Set<string>>();
    for (const user of snap.members.keys()) {
      const visible = new Set<string>();
      for (const channelId of snap.channels.keys()) if (this.canView(snap, user, channelId)) visible.add(channelId);
      map.set(user, visible);
    }
    return map;
  }

  // ------------------------------------------------------------ payloads

  private channelPayload(snap: Snapshot, channelId: string): schemas.Channel {
    const c = snap.channels.get(channelId)!;
    return {
      id: c.id,
      serverId: snap.serverId,
      name: c.name,
      kind: c.kind,
      position: c.position,
      overrides: (snap.overrides.get(c.id) ?? []).map((o) => ({
        kind: o.kind,
        targetId: o.target_id,
        allow: o.allow,
        deny: o.deny,
      })),
      slowModeSeconds: c.slow_mode_seconds,
    };
  }

  private rolePayload(snap: Snapshot, role: RoleRow): schemas.Role {
    return {
      id: role.id,
      serverId: snap.serverId,
      name: role.name,
      permissions: serializePermissions(role.permissions),
      position: role.position,
    };
  }

  private memberPayload(snap: Snapshot, userId: string): schemas.Member {
    const row = this.sql
      .exec<{ nick: string | null; joined_at: number }>("SELECT nick, joined_at FROM members WHERE user_id = ?", userId)
      .toArray()[0]!;
    return {
      serverId: snap.serverId,
      userId,
      nick: row.nick,
      roles: [...(snap.members.get(userId) ?? [])].sort(),
      joinedAt: row.joined_at,
      timeoutUntil: snap.timeouts.get(userId) ?? null,
    };
  }

  private messagePayload(
    serverId: string,
    m: { id: string; channel_id: string; author_id: string; ciphertext: string; epoch: number; created_at: number; edited_at: number | null },
  ): schemas.Message {
    return {
      id: m.id,
      serverId,
      channelId: m.channel_id,
      authorId: m.author_id,
      ciphertext: m.ciphertext,
      epoch: m.epoch,
      createdAt: m.created_at,
      editedAt: m.edited_at,
    };
  }

  private visibleStatus(status: string): schemas.VisibleStatus {
    return status === "invisible" ? "offline" : (status as schemas.VisibleStatus);
  }

  /** What one member sees of this server, for READY and SERVER_CREATE. */
  private snapshotFor(snap: Snapshot, userId: string): schemas.ServerSnapshot {
    const server = this.serverRow()!;
    const presences = this.sql
      .exec<{ user_id: string; status: string }>("SELECT user_id, status FROM presence WHERE status NOT IN ('offline', 'invisible')")
      .toArray()
      .filter((p) => snap.members.has(p.user_id))
      .map((p) => ({ userId: p.user_id, status: this.visibleStatus(p.status) }));
    return {
      server: { id: server.id, name: server.name, ownerId: server.owner_id },
      roles: [...snap.roles.values()].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).map((r) => this.rolePayload(snap, r)),
      channels: [...snap.channels.keys()].filter((c) => this.canView(snap, userId, c)).map((c) => this.channelPayload(snap, c)),
      members: [...snap.members.keys()].map((u) => this.memberPayload(snap, u)),
      presences,
    };
  }

  // ------------------------------------------------------------ outbox

  private emit({ users, event: ev, channelId = null, memberOnly = true, permission }: Emit): void {
    const now = this.deps.now();
    const payload = JSON.stringify(ev);
    const perm = permission === undefined ? null : serializePermissions(permission);
    for (const user of users) {
      this.sql.exec(
        "INSERT INTO outbox (user_id, channel_id, member_only, permission, event, next_at) VALUES (?, ?, ?, ?, ?, ?)",
        user,
        channelId,
        memberOnly ? 1 : 0,
        perm,
        payload,
        now,
      );
    }
  }

  /**
   * After a change to roles, membership roles or overrides: tell each member
   * about channels they gained or lost, and send CHANNEL_UPDATE for changed
   * channels they can still see.
   */
  private emitVisibilityChanges(before: Map<string, Set<string>>, after: Snapshot, changed: ReadonlySet<string>): void {
    const now = this.visibility(after);
    for (const [user, visible] of now) {
      const was = before.get(user) ?? new Set<string>();
      for (const channelId of visible) {
        if (!was.has(channelId)) {
          this.emit({ users: [user], event: event("CHANNEL_CREATE", this.channelPayload(after, channelId)), channelId });
        } else if (changed.has(channelId)) {
          this.emit({ users: [user], event: event("CHANNEL_UPDATE", this.channelPayload(after, channelId)), channelId });
        }
      }
      for (const channelId of was) {
        if (!visible.has(channelId)) {
          this.emit({ users: [user], event: event("CHANNEL_DELETE", { id: channelId, serverId: after.serverId }) });
        }
      }
    }
  }

  /**
   * Whether an outbox row may still go to its recipient. After the server is
   * deleted only rows meant for non-members (SERVER_DELETE) still go out.
   */
  private stillAllowed(
    snap: Snapshot | null,
    row: { user_id: string; channel_id: string | null; member_only: number; permission: string | null },
  ): boolean {
    if (!snap) return !row.member_only && !row.channel_id && !row.permission;
    if (row.member_only && !snap.members.has(row.user_id)) return false;
    if (row.channel_id && !this.canView(snap, row.user_id, row.channel_id)) return false;
    if (row.permission) {
      const needed = parsePermissions(row.permission);
      const held = row.channel_id
        ? this.channelPermissions(snap, row.user_id, row.channel_id)
        : this.basePermissions(snap, row.user_id);
      if (!has(held, needed)) return false;
    }
    return true;
  }

  /**
   * Deliver due outbox rows, re-checking permissions first. Returns when the
   * next retry is due, or null when the outbox is empty.
   */
  async flush(): Promise<number | null> {
    if (this.flushing) {
      this.flushAgain = true;
      return this.nextRetry();
    }
    this.flushing = true;
    try {
      do {
        this.flushAgain = false;
        while (await this.flushOnce()) {
          // keep going while there is due work
        }
      } while (this.flushAgain);
    } finally {
      this.flushing = false;
    }
    return this.nextRetry();
  }

  private nextRetry(): number | null {
    const row = this.sql.exec<{ next_at: number | null }>("SELECT MIN(next_at) AS next_at FROM outbox").toArray()[0];
    return row?.next_at ?? null;
  }

  private async flushOnce(): Promise<boolean> {
    const now = this.deps.now();
    // A user in backoff keeps all their events back so order is preserved.
    const rows = this.sql
      .exec<{
        id: number;
        user_id: string;
        channel_id: string | null;
        member_only: number;
        permission: string | null;
        event: string;
        attempts: number;
      }>(
        `SELECT id, user_id, channel_id, member_only, permission, event, attempts FROM outbox
         WHERE user_id NOT IN (SELECT user_id FROM outbox WHERE next_at > ?)
         ORDER BY id LIMIT 1000`,
        now,
      )
      .toArray();
    if (rows.length === 0) return false;

    const snap = this.serverRow() ? this.load() : null;
    const byUser = new Map<string, typeof rows>();
    const dropped: number[] = [];
    for (const row of rows) {
      if (!this.stillAllowed(snap, row)) {
        dropped.push(row.id);
        continue;
      }
      const list = byUser.get(row.user_id) ?? [];
      list.push(row);
      byUser.set(row.user_id, list);
    }
    for (const id of dropped) this.sql.exec("DELETE FROM outbox WHERE id = ?", id);

    await Promise.all(
      [...byUser].map(async ([user, list]) => {
        try {
          for (let i = 0; i < list.length; i += DELIVERY_BATCH) {
            const batch = list.slice(i, i + DELIVERY_BATCH);
            await this.deps.deliver(user, batch.map((r) => JSON.parse(r.event) as GatewayEvent));
            for (const r of batch) this.sql.exec("DELETE FROM outbox WHERE id = ?", r.id);
          }
        } catch {
          const attempts = (list[0]?.attempts ?? 0) + 1;
          if (attempts >= MAX_DELIVERY_ATTEMPTS) {
            this.sql.exec("DELETE FROM outbox WHERE user_id = ?", user);
          } else {
            const delay = Math.min(1000 * 2 ** attempts, 5 * 60_000);
            this.sql.exec("UPDATE outbox SET attempts = ?, next_at = ? WHERE user_id = ?", attempts, this.deps.now() + delay, user);
          }
        }
      }),
    );
    return true;
  }

  /** Typing goes straight out, best effort, without the outbox. */
  private async sendEphemeral(users: string[], ev: GatewayEvent): Promise<void> {
    await Promise.allSettled(users.map((u) => this.deps.deliver(u, [ev])));
  }

  // ------------------------------------------------------------ RPC entry points

  /** Create the server. Safe to call again with the same arguments. */
  init(serverId: string, ownerId: string, name: string): Reply {
    if (this.deleted()) return { status: 410, body: { error: "server_deleted" } };
    const existing = this.serverRow();
    if (existing) {
      if (existing.id !== serverId || existing.owner_id !== ownerId) return { status: 409, body: { error: "conflict" } };
      return { status: 200, body: this.snapshotFor(this.load(), ownerId) };
    }
    const parsed = s.CreateServerRequest.safeParse({ name });
    if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
    const now = this.deps.now();
    this.storage.transactionSync(() => {
      this.sql.exec("INSERT INTO server (id, name, owner_id, created_at) VALUES (?, ?, ?, ?)", serverId, parsed.data.name, ownerId, now);
      this.sql.exec(
        "INSERT INTO roles (id, name, permissions, position, created_at) VALUES (?, '@everyone', ?, 0, ?)",
        serverId,
        serializePermissions(DEFAULT_EVERYONE),
        now,
      );
      this.sql.exec("INSERT INTO channels (id, name, kind, position, created_at) VALUES (?, 'general', 'text', 0, ?)", newId(), now);
      this.sql.exec("INSERT INTO members (user_id, nick, joined_at) VALUES (?, NULL, ?)", ownerId, now);
      this.emit({ users: [ownerId], event: event("SERVER_CREATE", this.snapshotFor(this.load(), ownerId)) });
    });
    return { status: 201, body: this.snapshotFor(this.load(), ownerId) };
  }

  /** READY data for one user, or null if they are not a member. */
  snapshot(userId: string): schemas.ServerSnapshot | null {
    if (!this.serverRow()) return null;
    const snap = this.load();
    if (!snap.members.has(userId)) return null;
    return this.snapshotFor(snap, userId);
  }

  /** Called by a member's UserSession when their status changes. */
  setPresence(userId: string, status: schemas.PresenceStatus | "offline"): void {
    if (!this.serverRow()) return;
    const snap = this.load();
    if (!snap.members.has(userId)) return;
    const prev = this.sql.exec<{ status: string }>("SELECT status FROM presence WHERE user_id = ?", userId).toArray()[0];
    const before = this.visibleStatus(prev?.status ?? "offline");
    const after = this.visibleStatus(status);
    this.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO presence (user_id, status, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at`,
        userId,
        status,
        this.deps.now(),
      );
      if (before !== after) {
        this.emit({
          users: [...snap.members.keys()].filter((u) => u !== userId),
          event: event("PRESENCE_UPDATE", { serverId: snap.serverId, userId, status: after }),
        });
      }
    });
  }

  /**
   * Run one client operation. `idempotencyKey` is required for writes; a
   * retry with the same key gets the first reply back without redoing it.
   */
  async handle(userId: string, input: unknown, idempotencyKey: string | null): Promise<Reply> {
    const parsed = ServerOp.safeParse(input);
    if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
    const op = parsed.data;
    const writes = !READ_ONLY_OPS.has(op.type);
    const now = this.deps.now();

    let print = "";
    if (writes) {
      if (!idempotencyKey) return { status: 400, body: { error: "idempotency_key_required" } };
      print = fingerprint(JSON.stringify(op));
      this.sql.exec("DELETE FROM idempotency WHERE created_at < ?", now - IDEMPOTENCY_TTL);
      const prior = this.sql
        .exec<{ fingerprint: string; status: number; body: string }>(
          "SELECT fingerprint, status, body FROM idempotency WHERE user_id = ? AND key = ?",
          userId,
          idempotencyKey,
        )
        .toArray()[0];
      if (prior) {
        if (prior.fingerprint !== print) return { status: 422, body: { error: "idempotency_key_reused" } };
        return JSON.parse(prior.body) as Reply;
      }
    }

    const limit =
      op.type === "message.create"
        ? RATE.message
        : op.type === "typing"
          ? RATE.typing
          : op.type === "report.create"
            ? RATE.report
            : writes
              ? RATE.write
              : null;
    if (limit) {
      const key = `${RATE_KEY.get(limit)}:${userId}`;
      const { allowed, bucket } = takeToken(this.buckets.get(key), limit.burst, limit.perSecond, now);
      this.buckets.set(key, bucket);
      if (!allowed) return { status: 429, body: { error: "rate_limited" } };
    }

    const remember = (reply: Reply): void => {
      if (!writes || reply.status === 429 || reply.status >= 500) return;
      this.sql.exec(
        "INSERT INTO idempotency (user_id, key, fingerprint, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        userId,
        idempotencyKey,
        print,
        reply.status,
        JSON.stringify(reply),
        now,
      );
    };

    const pending: { ephemeral?: { users: string[]; ev: GatewayEvent } } = {};
    let reply: Reply;
    try {
      // The change, its outbox rows and its stored reply commit together.
      reply = this.storage.transactionSync(() => {
        const result = this.run(userId, op, now);
        let r: Reply;
        if ("ephemeral" in result) {
          pending.ephemeral = result.ephemeral;
          r = result.reply;
        } else {
          r = result;
        }
        remember(r);
        return r;
      });
    } catch (err) {
      if (!(err instanceof Fail)) throw err;
      reply = { status: err.status, body: { error: err.code } };
      remember(reply);
    }

    if (pending.ephemeral) await this.sendEphemeral(pending.ephemeral.users, pending.ephemeral.ev);
    if (writes) await this.flush();
    return reply;
  }

  // ------------------------------------------------------------ operations

  private run(userId: string, op: ServerOp, now: number): Reply | { reply: Reply; ephemeral: { users: string[]; ev: GatewayEvent } } {
    // Invites are the only ops a non-member may use.
    if (op.type === "invite.preview") return this.previewInvite(op.code, now);
    if (op.type === "invite.accept") return this.acceptInvite(userId, op.code, now);

    const snap = this.load();
    if (!snap.members.has(userId)) fail(404, "unknown_server");

    switch (op.type) {
      case "server.update": {
        this.requireBase(snap, userId, P.ADMINISTRATOR);
        this.sql.exec("UPDATE server SET name = ?", op.body.name);
        const server = { id: snap.serverId, name: op.body.name, ownerId: snap.ownerId };
        this.emit({ users: snap.members.keys(), event: event("SERVER_UPDATE", server) });
        this.audit(snap, userId, "server.update", { data: { name: op.body.name } });
        return { status: 200, body: server };
      }
      case "server.delete": {
        if (userId !== snap.ownerId) fail(403, "not_owner");
        this.deleteServer(snap);
        return { status: 204, body: null, effects: { serverDeleted: true } };
      }

      // -------------------------------------------------- channels
      case "channel.create": {
        this.requireBase(snap, userId, P.MANAGE_CHANNELS);
        if (snap.channels.size >= s.LIMITS.maxChannelsPerServer) fail(400, "too_many_channels");
        const id = newId();
        const position = op.body.position ?? Math.max(-1, ...[...snap.channels.values()].map((c) => c.position)) + 1;
        this.sql.exec(
          "INSERT INTO channels (id, name, kind, position, slow_mode_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          op.body.name,
          op.body.kind,
          position,
          op.body.slowModeSeconds,
          now,
        );
        const after = this.load();
        const payload = this.channelPayload(after, id);
        this.emit({ users: this.viewers(after, id), event: event("CHANNEL_CREATE", payload), channelId: id });
        this.audit(after, userId, "channel.create", { targetId: id, channelId: id, data: { name: op.body.name, kind: op.body.kind } });
        return { status: 201, body: payload };
      }
      case "channel.update": {
        this.requireChannel(snap, userId, op.channelId, P.MANAGE_CHANNELS);
        const c = snap.channels.get(op.channelId)!;
        const slowMode = op.body.slowModeSeconds ?? c.slow_mode_seconds;
        this.sql.exec(
          "UPDATE channels SET name = ?, position = ?, slow_mode_seconds = ? WHERE id = ?",
          op.body.name ?? c.name,
          op.body.position ?? c.position,
          slowMode,
          op.channelId,
        );
        if (slowMode === 0) this.sql.exec("DELETE FROM slow_mode WHERE channel_id = ?", op.channelId);
        const after = this.load();
        const payload = this.channelPayload(after, op.channelId);
        this.emit({ users: this.viewers(after, op.channelId), event: event("CHANNEL_UPDATE", payload), channelId: op.channelId });
        const changes: Record<string, string | number> = {};
        if (op.body.name !== undefined && op.body.name !== c.name) changes.name = op.body.name;
        if (op.body.position !== undefined && op.body.position !== c.position) changes.position = op.body.position;
        if (Object.keys(changes).length > 0) {
          this.audit(after, userId, "channel.update", { targetId: op.channelId, channelId: op.channelId, data: changes });
        }
        if (slowMode !== c.slow_mode_seconds) {
          this.audit(after, userId, "channel.slow_mode", { targetId: op.channelId, channelId: op.channelId, data: { seconds: slowMode } });
        }
        return { status: 200, body: payload };
      }
      case "channel.delete": {
        this.requireChannel(snap, userId, op.channelId, P.MANAGE_CHANNELS);
        const viewers = this.viewers(snap, op.channelId);
        const name = snap.channels.get(op.channelId)!.name;
        this.sql.exec("DELETE FROM messages WHERE channel_id = ?", op.channelId);
        this.sql.exec("DELETE FROM channel_overrides WHERE channel_id = ?", op.channelId);
        this.sql.exec("DELETE FROM slow_mode WHERE channel_id = ?", op.channelId);
        this.sql.exec("DELETE FROM report_messages WHERE report_id IN (SELECT id FROM reports WHERE channel_id = ?)", op.channelId);
        this.sql.exec("DELETE FROM reports WHERE channel_id = ?", op.channelId);
        this.sql.exec("DELETE FROM channels WHERE id = ?", op.channelId);
        this.emit({ users: viewers, event: event("CHANNEL_DELETE", { id: op.channelId, serverId: snap.serverId }) });
        this.audit(snap, userId, "channel.delete", { targetId: op.channelId, data: { name } });
        return { status: 204, body: null };
      }
      case "override.put": {
        const held = this.requireChannel(snap, userId, op.channelId, P.MANAGE_ROLES);
        const allow = parsePermissions(op.body.allow);
        const deny = parsePermissions(op.body.deny);
        if ((allow | deny) & ~ALL_PERMISSIONS) fail(400, "unknown_permissions");
        this.requireSubset(allow | deny, held);
        this.requireOverrideTarget(snap, userId, op.kind, op.targetId);
        const before = this.visibility(snap);
        this.sql.exec(
          `INSERT INTO channel_overrides (channel_id, kind, target_id, allow, deny) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (channel_id, kind, target_id) DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
          op.channelId,
          op.kind,
          op.targetId,
          serializePermissions(allow),
          serializePermissions(deny),
        );
        const after = this.load();
        this.emitVisibilityChanges(before, after, new Set([op.channelId]));
        this.audit(after, userId, "override.put", {
          targetId: op.targetId,
          channelId: op.channelId,
          data: { kind: op.kind, allow: op.body.allow, deny: op.body.deny },
        });
        return { status: 200, body: this.channelPayload(after, op.channelId) };
      }
      case "override.delete": {
        this.requireChannel(snap, userId, op.channelId, P.MANAGE_ROLES);
        this.requireOverrideTarget(snap, userId, op.kind, op.targetId);
        const before = this.visibility(snap);
        this.sql.exec(
          "DELETE FROM channel_overrides WHERE channel_id = ? AND kind = ? AND target_id = ?",
          op.channelId,
          op.kind,
          op.targetId,
        );
        const after = this.load();
        this.emitVisibilityChanges(before, after, new Set([op.channelId]));
        this.audit(after, userId, "override.delete", { targetId: op.targetId, channelId: op.channelId, data: { kind: op.kind } });
        return { status: 204, body: null };
      }

      // -------------------------------------------------- roles
      case "role.create": {
        const held = this.requireBase(snap, userId, P.MANAGE_ROLES);
        if (snap.roles.size >= s.LIMITS.maxRolesPerServer) fail(400, "too_many_roles");
        const permissions = parsePermissions(op.body.permissions);
        if (permissions & ~ALL_PERMISSIONS) fail(400, "unknown_permissions");
        this.requireSubset(permissions, held);
        const rank = this.rank(snap, userId);
        const top = Math.max(0, ...[...snap.roles.values()].map((r) => r.position));
        // New roles go just below the caller unless placed explicitly.
        const position = op.body.position ?? (Number.isFinite(rank) ? Math.max(1, rank - 1) : top + 1);
        if (position >= rank) fail(403, "role_hierarchy");
        const id = newId();
        this.sql.exec(
          "INSERT INTO roles (id, name, permissions, position, created_at) VALUES (?, ?, ?, ?, ?)",
          id,
          op.body.name,
          serializePermissions(permissions),
          position,
          now,
        );
        const role = this.rolePayload(snap, { id, name: op.body.name, permissions, position });
        this.emit({ users: snap.members.keys(), event: event("ROLE_CREATE", role) });
        this.audit(snap, userId, "role.create", { targetId: id, data: { name: op.body.name, permissions: role.permissions } });
        return { status: 201, body: role };
      }
      case "role.update": {
        const held = this.requireBase(snap, userId, P.MANAGE_ROLES);
        const role = snap.roles.get(op.roleId) ?? fail(404, "unknown_role");
        const rank = this.rank(snap, userId);
        if (role.position >= rank) fail(403, "role_hierarchy");
        const permissions = op.body.permissions === undefined ? role.permissions : parsePermissions(op.body.permissions);
        if (permissions & ~ALL_PERMISSIONS) fail(400, "unknown_permissions");
        // Only bits being turned on need to be held by the caller.
        this.requireSubset(permissions & ~role.permissions, held);
        let position = role.position;
        if (op.body.position !== undefined) {
          if (role.id === snap.serverId) fail(400, "everyone_position_fixed");
          if (op.body.position >= rank) fail(403, "role_hierarchy");
          position = op.body.position;
        }
        const before = this.visibility(snap);
        this.sql.exec(
          "UPDATE roles SET name = ?, permissions = ?, position = ? WHERE id = ?",
          role.id === snap.serverId ? role.name : (op.body.name ?? role.name),
          serializePermissions(permissions),
          position,
          role.id,
        );
        const after = this.load();
        const payload = this.rolePayload(after, after.roles.get(role.id)!);
        this.emit({ users: after.members.keys(), event: event("ROLE_UPDATE", payload) });
        this.emitVisibilityChanges(before, after, new Set());
        this.audit(after, userId, "role.update", {
          targetId: role.id,
          data: { name: payload.name, permissions: payload.permissions, position: payload.position },
        });
        return { status: 200, body: payload };
      }
      case "role.delete": {
        this.requireBase(snap, userId, P.MANAGE_ROLES);
        const role = snap.roles.get(op.roleId) ?? fail(404, "unknown_role");
        if (role.id === snap.serverId) fail(400, "cannot_delete_everyone");
        if (role.position >= this.rank(snap, userId)) fail(403, "role_hierarchy");
        const before = this.visibility(snap);
        const touched = new Set(
          this.sql
            .exec<{ channel_id: string }>("SELECT channel_id FROM channel_overrides WHERE kind = 'role' AND target_id = ?", role.id)
            .toArray()
            .map((r) => r.channel_id),
        );
        const holders = [...snap.members].filter(([, roles]) => roles.includes(role.id)).map(([u]) => u);
        this.sql.exec("DELETE FROM member_roles WHERE role_id = ?", role.id);
        this.sql.exec("DELETE FROM channel_overrides WHERE kind = 'role' AND target_id = ?", role.id);
        this.sql.exec("DELETE FROM roles WHERE id = ?", role.id);
        const after = this.load();
        this.emit({ users: after.members.keys(), event: event("ROLE_DELETE", { id: role.id, serverId: snap.serverId }) });
        for (const holder of holders) {
          this.emit({ users: after.members.keys(), event: event("MEMBER_UPDATE", this.memberPayload(after, holder)) });
        }
        this.emitVisibilityChanges(before, after, touched);
        this.audit(after, userId, "role.delete", { targetId: role.id, data: { name: role.name } });
        return { status: 204, body: null };
      }

      // -------------------------------------------------- members
      case "member.role.add":
      case "member.role.remove": {
        this.requireBase(snap, userId, P.MANAGE_ROLES);
        if (!snap.members.has(op.userId)) fail(404, "unknown_member");
        const role = snap.roles.get(op.roleId) ?? fail(404, "unknown_role");
        if (role.id === snap.serverId) fail(400, "cannot_assign_everyone");
        if (role.position >= this.rank(snap, userId)) fail(403, "role_hierarchy");
        const before = this.visibility(snap);
        const changed =
          op.type === "member.role.add"
            ? this.sql.exec("INSERT OR IGNORE INTO member_roles (user_id, role_id) VALUES (?, ?)", op.userId, role.id).rowsWritten
            : this.sql.exec("DELETE FROM member_roles WHERE user_id = ? AND role_id = ?", op.userId, role.id).rowsWritten;
        const after = this.load();
        const member = this.memberPayload(after, op.userId);
        if (changed > 0) {
          this.emit({ users: after.members.keys(), event: event("MEMBER_UPDATE", member) });
          this.emitVisibilityChanges(before, after, new Set());
          this.audit(after, userId, op.type, { targetId: op.userId, data: { roleId: role.id } });
        }
        return { status: 200, body: member };
      }
      case "member.remove": {
        if (op.userId === userId) {
          if (userId === snap.ownerId) fail(400, "owner_cannot_leave");
          this.removeMember(snap, op.userId);
          return { status: 204, body: null };
        }
        this.requireModeration(snap, userId, op.userId, P.KICK);
        if (!snap.members.has(op.userId)) fail(404, "unknown_member");
        this.removeMember(snap, op.userId);
        this.audit(snap, userId, "member.kick", { targetId: op.userId, reason: op.body.reason });
        return { status: 204, body: null };
      }
      case "member.timeout": {
        if (op.userId === userId) fail(400, "cannot_moderate_self");
        this.requireModeration(snap, userId, op.userId, P.TIMEOUT);
        if (!snap.members.has(op.userId)) fail(404, "unknown_member");
        // Admins can do everything anyway, so a timeout would not hold them.
        if (has(computeBasePermissions(this.context(snap, op.userId)), P.ADMINISTRATOR)) fail(403, "cannot_timeout_admin");
        const until = now + op.body.seconds * 1000;
        this.sql.exec("DELETE FROM timeouts WHERE until <= ?", now);
        this.sql.exec(
          "INSERT INTO timeouts (user_id, until) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET until = excluded.until",
          op.userId,
          until,
        );
        const after = this.load();
        const member = this.memberPayload(after, op.userId);
        this.emit({ users: after.members.keys(), event: event("MEMBER_UPDATE", member) });
        this.audit(after, userId, "member.timeout", { targetId: op.userId, reason: op.body.reason, data: { until } });
        return { status: 200, body: member };
      }
      case "member.timeout.remove": {
        this.requireModeration(snap, userId, op.userId, P.TIMEOUT);
        if (!snap.members.has(op.userId)) fail(404, "unknown_member");
        const active = snap.timeouts.has(op.userId);
        this.sql.exec("DELETE FROM timeouts WHERE user_id = ?", op.userId);
        const after = this.load();
        const member = this.memberPayload(after, op.userId);
        if (active) {
          this.emit({ users: after.members.keys(), event: event("MEMBER_UPDATE", member) });
          this.audit(after, userId, "member.timeout.remove", { targetId: op.userId, reason: op.body.reason });
        }
        return { status: 200, body: member };
      }
      case "ban.put": {
        if (op.userId === userId) fail(400, "cannot_ban_self");
        this.requireModeration(snap, userId, op.userId, P.BAN);
        const added = this.sql.exec(
          "INSERT OR IGNORE INTO bans (user_id, reason, created_by, created_at) VALUES (?, ?, ?, ?)",
          op.userId,
          op.body.reason ?? null,
          userId,
          now,
        ).rowsWritten;
        const deleted = op.body.deleteMessageSeconds > 0 ? this.deleteMessagesBy(snap, op.userId, now - op.body.deleteMessageSeconds * 1000) : 0;
        const wasMember = snap.members.has(op.userId);
        if (wasMember) this.removeMember(snap, op.userId);
        if (added > 0 || wasMember || deleted > 0) {
          this.audit(snap, userId, "member.ban", { targetId: op.userId, reason: op.body.reason, data: { deletedMessages: deleted } });
        }
        return { status: 204, body: null };
      }
      case "ban.delete": {
        this.requireBase(snap, userId, P.BAN);
        const removed = this.sql.exec("DELETE FROM bans WHERE user_id = ?", op.userId).rowsWritten;
        if (removed > 0) this.audit(snap, userId, "member.unban", { targetId: op.userId, reason: op.body.reason });
        return { status: 204, body: null };
      }
      case "bans.list": {
        this.requireBase(snap, userId, P.BAN);
        const rows = this.sql
          .exec<{ user_id: string; reason: string | null; created_by: string | null; created_at: number }>(
            "SELECT user_id, reason, created_by, created_at FROM bans WHERE user_id < ? ORDER BY user_id DESC LIMIT ?",
            op.query.before ?? "~",
            op.query.limit,
          )
          .toArray();
        const bans: schemas.Ban[] = rows.map((b) => ({
          serverId: snap.serverId,
          userId: b.user_id,
          reason: b.reason,
          createdBy: b.created_by,
          createdAt: b.created_at,
        }));
        return { status: 200, body: bans };
      }

      // -------------------------------------------------- messages
      case "messages.list": {
        this.requireChannel(snap, userId, op.channelId, P.VIEW_CHANNEL);
        const rows = this.sql
          .exec<{ id: string; channel_id: string; author_id: string; ciphertext: string; epoch: number; created_at: number; edited_at: number | null }>(
            `SELECT id, channel_id, author_id, ciphertext, epoch, created_at, edited_at FROM messages
             WHERE channel_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
            op.channelId,
            op.query.before ?? "~",
            op.query.limit,
          )
          .toArray();
        return { status: 200, body: rows.map((m) => this.messagePayload(snap.serverId, m)) };
      }
      case "message.create": {
        const perms = this.requireChannel(snap, userId, op.channelId, P.SEND_MESSAGES);
        const channel = snap.channels.get(op.channelId)!;
        if (channel.kind !== "text") fail(400, "not_a_text_channel");
        const wait = this.slowModeWait(channel, userId, perms, now);
        if (wait > 0) return { status: 429, body: { error: "slow_mode", retryAfterMs: wait } };
        const row = {
          id: newId(),
          channel_id: op.channelId,
          author_id: userId,
          ciphertext: op.body.ciphertext,
          epoch: op.body.epoch,
          created_at: now,
          edited_at: null,
        };
        this.sql.exec(
          "INSERT INTO messages (id, channel_id, author_id, ciphertext, epoch, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          row.id,
          row.channel_id,
          row.author_id,
          row.ciphertext,
          row.epoch,
          row.created_at,
        );
        if (channel.slow_mode_seconds > 0) {
          this.sql.exec(
            `INSERT INTO slow_mode (channel_id, user_id, last_at) VALUES (?, ?, ?)
             ON CONFLICT (channel_id, user_id) DO UPDATE SET last_at = excluded.last_at`,
            op.channelId,
            userId,
            now,
          );
        }
        const message = this.messagePayload(snap.serverId, row);
        this.emit({ users: this.viewers(snap, op.channelId), event: event("MESSAGE_CREATE", message), channelId: op.channelId });
        return { status: 201, body: message };
      }
      case "message.update": {
        this.requireChannel(snap, userId, op.channelId, P.VIEW_CHANNEL);
        const row = this.findMessage(op.channelId, op.messageId);
        if (row.author_id !== userId) fail(403, "not_author");
        this.sql.exec("UPDATE messages SET ciphertext = ?, epoch = ?, edited_at = ? WHERE id = ?", op.body.ciphertext, op.body.epoch, now, row.id);
        const message = this.messagePayload(snap.serverId, { ...row, ciphertext: op.body.ciphertext, epoch: op.body.epoch, edited_at: now });
        this.emit({ users: this.viewers(snap, op.channelId), event: event("MESSAGE_UPDATE", message), channelId: op.channelId });
        return { status: 200, body: message };
      }
      case "message.delete": {
        const perms = this.requireChannel(snap, userId, op.channelId, P.VIEW_CHANNEL);
        const row = this.findMessage(op.channelId, op.messageId);
        if (row.author_id !== userId && !has(perms, P.MANAGE_MESSAGES)) fail(403, "missing_permissions");
        this.sql.exec("DELETE FROM messages WHERE id = ?", row.id);
        this.emit({
          users: this.viewers(snap, op.channelId),
          event: event("MESSAGE_DELETE", { id: row.id, channelId: op.channelId, serverId: snap.serverId }),
          channelId: op.channelId,
        });
        if (row.author_id !== userId) {
          this.audit(snap, userId, "message.delete", { targetId: row.author_id, channelId: op.channelId, data: { messageId: row.id } });
        }
        return { status: 204, body: null };
      }
      case "typing": {
        this.requireChannel(snap, userId, op.channelId, P.SEND_MESSAGES);
        const ev = event("TYPING_START", { serverId: snap.serverId, channelId: op.channelId, userId, at: now });
        const users = this.viewers(snap, op.channelId).filter((u) => u !== userId);
        return { reply: { status: 204, body: null }, ephemeral: { users, ev } };
      }

      // -------------------------------------------------- invites
      case "invite.create": {
        this.requireBase(snap, userId, P.CREATE_INVITE);
        this.sql.exec("DELETE FROM invites WHERE expires_at IS NOT NULL AND expires_at <= ?", now);
        const count = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM invites").toArray()[0]!.n;
        if (count >= s.LIMITS.maxInvitesPerServer) fail(400, "too_many_invites");
        const code = newInviteCode();
        const expiresAt = op.body.maxAgeSeconds === 0 ? null : now + op.body.maxAgeSeconds * 1000;
        this.sql.exec(
          "INSERT INTO invites (code, created_by, max_uses, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
          code,
          userId,
          op.body.maxUses,
          expiresAt,
          now,
        );
        const invite: schemas.Invite = {
          code,
          serverId: snap.serverId,
          createdBy: userId,
          maxUses: op.body.maxUses,
          uses: 0,
          expiresAt,
          createdAt: now,
        };
        return { status: 201, body: invite, effects: { inviteCreated: { code, expiresAt } } };
      }
      case "invite.delete": {
        const invite = this.sql
          .exec<{ created_by: string }>("SELECT created_by FROM invites WHERE code = ?", op.code)
          .toArray()[0];
        if (!invite) fail(404, "unknown_invite");
        if (invite.created_by !== userId) this.requireBase(snap, userId, P.MANAGE_CHANNELS);
        this.sql.exec("DELETE FROM invites WHERE code = ?", op.code);
        if (invite.created_by !== userId) this.audit(snap, userId, "invite.delete", { targetId: op.code, data: { createdBy: invite.created_by } });
        return { status: 204, body: null, effects: { inviteGone: op.code } };
      }

      // -------------------------------------------------- reports
      case "report.create":
        return this.createReport(snap, userId, op.body, now);
      case "reports.list": {
        const channels = this.reportChannels(snap, userId);
        if (channels.size === 0) fail(403, "missing_permissions");
        const reports: schemas.Report[] = [];
        let before = op.query.before ?? "~";
        // Filter by channel in pages so a moderator never sees other channels' reports.
        while (reports.length < op.query.limit) {
          const rows = this.sql
            .exec<ReportRow>(
              `SELECT id, channel_id, category, note, status, handled_by, created_at, updated_at FROM reports
               WHERE id < ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ?`,
              before,
              op.query.status ?? null,
              op.query.status ?? null,
              s.MODERATION_LIMITS.maxPage,
            )
            .toArray();
          for (const row of rows) {
            if (channels.has(row.channel_id) && reports.length < op.query.limit) reports.push(this.reportPayload(snap, row));
          }
          if (rows.length < s.MODERATION_LIMITS.maxPage) break;
          before = rows[rows.length - 1]!.id;
        }
        return { status: 200, body: reports };
      }
      case "report.update": {
        const row = this.findReport(op.reportId);
        // Reports in channels the caller cannot moderate look like they don't exist.
        if (!this.reportChannels(snap, userId).has(row.channel_id)) fail(404, "unknown_report");
        this.sql.exec("UPDATE reports SET status = ?, handled_by = ?, updated_at = ? WHERE id = ?", op.body.status, userId, now, row.id);
        const report = this.reportPayload(snap, this.findReport(row.id));
        if (row.status !== op.body.status) {
          this.emit({
            users: snap.members.keys(),
            event: event("REPORT_UPDATE", report),
            channelId: row.channel_id,
            permission: P.MANAGE_MESSAGES,
          });
          this.audit(snap, userId, "report.update", {
            targetId: row.id,
            channelId: row.channel_id,
            reason: op.body.reason,
            data: { status: op.body.status },
          });
        }
        return { status: 200, body: report };
      }

      // -------------------------------------------------- audit log
      case "audit.list": {
        this.requireBase(snap, userId, P.VIEW_AUDIT_LOG);
        const rows = this.sql
          .exec<AuditRow>(
            `SELECT id, actor_id, action, target_id, channel_id, reason, data, created_at FROM audit_log
             WHERE id < ? AND (? IS NULL OR action = ?) AND (? IS NULL OR actor_id = ?)
             ORDER BY id DESC LIMIT ?`,
            op.query.before ?? "~",
            op.query.action ?? null,
            op.query.action ?? null,
            op.query.actorId ?? null,
            op.query.actorId ?? null,
            op.query.limit,
          )
          .toArray();
        return { status: 200, body: rows.map((r) => this.auditPayload(snap.serverId, r)) };
      }
    }
  }

  private requireOverrideTarget(snap: Snapshot, userId: string, kind: "role" | "member", targetId: string): void {
    if (kind === "member") {
      if (!snap.members.has(targetId)) fail(404, "unknown_member");
      return;
    }
    const role = snap.roles.get(targetId) ?? fail(404, "unknown_role");
    // @everyone (position 0) is below every role, so anyone with MANAGE_ROLES may override it.
    if (role.id !== snap.serverId && role.position >= this.rank(snap, userId)) fail(403, "role_hierarchy");
  }

  /**
   * Kicks, bans and timeouts: need the permission and to outrank the target.
   * A moderator in a timeout has lost the permission, so cannot act.
   */
  private requireModeration(snap: Snapshot, actor: string, target: string, flag: bigint): void {
    this.requireBase(snap, actor, flag);
    if (target === snap.ownerId) fail(403, "role_hierarchy");
    if (snap.members.has(target) && this.rank(snap, target) >= this.rank(snap, actor)) fail(403, "role_hierarchy");
  }

  /** Milliseconds the member must still wait in a slow mode channel, or 0. */
  private slowModeWait(channel: ChannelRow, userId: string, perms: bigint, now: number): number {
    if (channel.slow_mode_seconds === 0) return 0;
    // Moderators and channel managers are not slowed down.
    if (has(perms, P.MANAGE_MESSAGES) || has(perms, P.MANAGE_CHANNELS)) return 0;
    const last = this.sql
      .exec<{ last_at: number }>("SELECT last_at FROM slow_mode WHERE channel_id = ? AND user_id = ?", channel.id, userId)
      .toArray()[0]?.last_at;
    if (last === undefined) return 0;
    return Math.max(0, last + channel.slow_mode_seconds * 1000 - now);
  }

  /** Delete a user's messages since `since`, newest first, up to the cap. */
  private deleteMessagesBy(snap: Snapshot, authorId: string, since: number): number {
    const rows = this.sql
      .exec<{ id: string; channel_id: string }>(
        "SELECT id, channel_id FROM messages WHERE author_id = ? AND created_at >= ? ORDER BY id DESC LIMIT ?",
        authorId,
        since,
        ML.maxBanDeletedMessages,
      )
      .toArray();
    const viewers = new Map<string, string[]>();
    for (const row of rows) {
      this.sql.exec("DELETE FROM messages WHERE id = ?", row.id);
      let users = viewers.get(row.channel_id);
      if (!users) {
        users = this.viewers(snap, row.channel_id);
        viewers.set(row.channel_id, users);
      }
      this.emit({
        users,
        event: event("MESSAGE_DELETE", { id: row.id, channelId: row.channel_id, serverId: snap.serverId }),
        channelId: row.channel_id,
      });
    }
    return rows.length;
  }

  // ------------------------------------------------------------ server deletion

  private deleted(): boolean {
    return this.sql.exec("SELECT 1 FROM _meta WHERE key = 'deleted_at'").toArray().length > 0;
  }

  /**
   * Remove everything but the outbox (so SERVER_DELETE still goes out) and the
   * stored replies (so a retried delete gets the same answer). A tombstone
   * stops the id being created again.
   */
  private deleteServer(snap: Snapshot): void {
    this.emit({ users: snap.members.keys(), event: event("SERVER_DELETE", { id: snap.serverId }), memberOnly: false });
    for (const table of [
      "report_messages",
      "reports",
      "audit_log",
      "slow_mode",
      "timeouts",
      "messages",
      "channel_overrides",
      "channels",
      "member_roles",
      "members",
      "roles",
      "invites",
      "bans",
      "presence",
      "server",
    ]) {
      this.sql.exec(`DELETE FROM ${table}`);
    }
    this.sql.exec("INSERT INTO _meta (key, value) VALUES ('deleted_at', ?)", String(this.deps.now()));
  }

  // ------------------------------------------------------------ audit log

  /**
   * Record a moderator or admin action and tell members who can read the log.
   * Entries older than the retention period are dropped as new ones arrive.
   */
  private audit(snap: Snapshot, actorId: string, action: schemas.AuditAction, input: AuditInput = {}): void {
    const now = this.deps.now();
    this.sql.exec("DELETE FROM audit_log WHERE created_at < ?", now - ML.retentionMs);
    const row: AuditRow = {
      id: newId(),
      actor_id: actorId,
      action,
      target_id: input.targetId ?? null,
      channel_id: input.channelId ?? null,
      reason: input.reason ?? null,
      data: JSON.stringify(input.data ?? {}),
      created_at: now,
    };
    this.sql.exec(
      "INSERT INTO audit_log (id, actor_id, action, target_id, channel_id, reason, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      row.id,
      row.actor_id,
      row.action,
      row.target_id,
      row.channel_id,
      row.reason,
      row.data,
      row.created_at,
    );
    const readers = [...snap.members.keys()].filter((u) => has(this.basePermissions(snap, u), P.VIEW_AUDIT_LOG));
    this.emit({ users: readers, event: event("AUDIT_LOG_ENTRY_CREATE", this.auditPayload(snap.serverId, row)), permission: P.VIEW_AUDIT_LOG });
  }

  private auditPayload(serverId: string, row: AuditRow): schemas.AuditLogEntry {
    return {
      id: row.id,
      serverId,
      actorId: row.actor_id,
      action: row.action as schemas.AuditAction,
      targetId: row.target_id,
      channelId: row.channel_id,
      reason: row.reason,
      data: JSON.parse(row.data) as schemas.AuditLogEntry["data"],
      createdAt: row.created_at,
    };
  }

  // ------------------------------------------------------------ reports

  /** Channels whose reports this member may read and handle. */
  private reportChannels(snap: Snapshot, userId: string): Set<string> {
    const channels = new Set<string>();
    for (const channelId of snap.channels.keys()) {
      const perms = this.channelPermissions(snap, userId, channelId);
      if (has(perms, P.VIEW_CHANNEL | P.MANAGE_MESSAGES)) channels.add(channelId);
    }
    return channels;
  }

  private findReport(reportId: string): ReportRow {
    return (
      this.sql
        .exec<ReportRow>(
          "SELECT id, channel_id, category, note, status, handled_by, created_at, updated_at FROM reports WHERE id = ?",
          reportId,
        )
        .toArray()[0] ?? fail(404, "unknown_report")
    );
  }

  private reportPayload(snap: Snapshot, row: ReportRow): schemas.Report {
    const messages = this.sql
      .exec<{ message_id: string; author_id: string; content: string; created_at: number }>(
        "SELECT message_id, author_id, content, created_at FROM report_messages WHERE report_id = ? ORDER BY message_id",
        row.id,
      )
      .toArray()
      .map((m) => ({ id: m.message_id, authorId: m.author_id, content: m.content, createdAt: m.created_at }));
    return {
      id: row.id,
      serverId: snap.serverId,
      channelId: row.channel_id,
      category: row.category as schemas.ReportCategory,
      note: row.note,
      status: row.status as schemas.ReportStatus,
      messages,
      handledBy: row.handled_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Store a report. Each message must still exist in the channel; its author
   * and time come from the server's copy, and its text from the reporter.
   */
  private createReport(snap: Snapshot, userId: string, body: z.output<typeof s.CreateReportRequest>, now: number): Reply {
    this.requireChannel(snap, userId, body.channelId, P.VIEW_CHANNEL);
    const messages = body.messages.map((m) => ({ ...this.findMessage(body.channelId, m.id), content: m.content }));
    for (const m of messages) {
      const dupe = this.sql
        .exec(
          `SELECT 1 FROM report_messages rm JOIN reports r ON r.id = rm.report_id
           WHERE rm.message_id = ? AND r.reporter_id = ? AND r.status = 'open'`,
          m.id,
          userId,
        )
        .toArray().length;
      if (dupe > 0) fail(409, "already_reported");
    }
    this.sql.exec(
      "DELETE FROM reports WHERE status != 'open' AND updated_at < ?",
      now - ML.retentionMs,
    );
    const id = newId();
    this.sql.exec(
      `INSERT INTO reports (id, channel_id, reporter_id, category, note, status, handled_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, ?)`,
      id,
      body.channelId,
      userId,
      body.category,
      body.note ?? null,
      now,
      now,
    );
    for (const m of messages) {
      this.sql.exec(
        "INSERT INTO report_messages (report_id, message_id, author_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
        id,
        m.id,
        m.author_id,
        m.content,
        m.created_at,
      );
    }
    const report = this.reportPayload(snap, this.findReport(id));
    this.emit({ users: snap.members.keys(), event: event("REPORT_CREATE", report), channelId: body.channelId, permission: P.MANAGE_MESSAGES });
    return { status: 201, body: { id, status: "open", createdAt: now } };
  }

  private removeMember(snap: Snapshot, target: string): void {
    const touched = new Set(
      this.sql
        .exec<{ channel_id: string }>("SELECT channel_id FROM channel_overrides WHERE kind = 'member' AND target_id = ?", target)
        .toArray()
        .map((r) => r.channel_id),
    );
    this.sql.exec("DELETE FROM channel_overrides WHERE kind = 'member' AND target_id = ?", target);
    this.sql.exec("DELETE FROM member_roles WHERE user_id = ?", target);
    this.sql.exec("DELETE FROM presence WHERE user_id = ?", target);
    this.sql.exec("DELETE FROM members WHERE user_id = ?", target);
    const after = this.load();
    this.emit({ users: after.members.keys(), event: event("MEMBER_REMOVE", { serverId: snap.serverId, userId: target }) });
    this.emit({ users: [target], event: event("SERVER_DELETE", { id: snap.serverId }), memberOnly: false });
    for (const channelId of touched) {
      this.emit({ users: this.viewers(after, channelId), event: event("CHANNEL_UPDATE", this.channelPayload(after, channelId)), channelId });
    }
  }

  private findMessage(channelId: string, messageId: string) {
    return (
      this.sql
        .exec<{ id: string; channel_id: string; author_id: string; ciphertext: string; epoch: number; created_at: number; edited_at: number | null }>(
          "SELECT id, channel_id, author_id, ciphertext, epoch, created_at, edited_at FROM messages WHERE id = ? AND channel_id = ?",
          messageId,
          channelId,
        )
        .toArray()[0] ?? fail(404, "unknown_message")
    );
  }

  /** Look up an invite that can still be used, dropping it if it has lapsed. */
  private usableInvite(code: string, now: number) {
    const invite = this.sql
      .exec<{ code: string; max_uses: number; uses: number; expires_at: number | null }>(
        "SELECT code, max_uses, uses, expires_at FROM invites WHERE code = ?",
        code,
      )
      .toArray()[0];
    if (!invite) fail(404, "unknown_invite");
    if ((invite.expires_at !== null && invite.expires_at <= now) || (invite.max_uses > 0 && invite.uses >= invite.max_uses)) {
      this.sql.exec("DELETE FROM invites WHERE code = ?", code);
      fail(404, "unknown_invite");
    }
    return invite;
  }

  private previewInvite(code: string, now: number): Reply {
    const server = this.serverRow() ?? fail(404, "unknown_invite");
    const invite = this.usableInvite(code, now);
    const memberCount = this.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM members").toArray()[0]!.n;
    const preview: schemas.InvitePreview = {
      code,
      server: { id: server.id, name: server.name },
      memberCount,
      expiresAt: invite.expires_at,
    };
    return { status: 200, body: preview };
  }

  private acceptInvite(userId: string, code: string, now: number): Reply {
    const server = this.serverRow() ?? fail(404, "unknown_invite");
    const invite = this.usableInvite(code, now);
    const banned = this.sql.exec("SELECT 1 FROM bans WHERE user_id = ?", userId).toArray().length > 0;
    if (banned) fail(403, "banned");
    const snap = this.load();
    if (snap.members.has(userId)) return { status: 200, body: { serverId: server.id } };

    const uses = invite.uses + 1;
    const exhausted = invite.max_uses > 0 && uses >= invite.max_uses;
    if (exhausted) this.sql.exec("DELETE FROM invites WHERE code = ?", code);
    else this.sql.exec("UPDATE invites SET uses = ? WHERE code = ?", uses, code);
    this.sql.exec("INSERT INTO members (user_id, nick, joined_at) VALUES (?, NULL, ?)", userId, now);

    const after = this.load();
    this.emit({ users: after.members.keys(), event: event("MEMBER_ADD", this.memberPayload(after, userId)) });
    this.emit({ users: [userId], event: event("SERVER_CREATE", this.snapshotFor(after, userId)) });
    const reply: Reply = { status: 200, body: { serverId: server.id } };
    if (exhausted) reply.effects = { inviteGone: code };
    return reply;
  }
}
