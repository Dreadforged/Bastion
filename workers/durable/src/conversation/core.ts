import { newId, Permission as P, has, schemas, type GatewayEvent } from "@bastion/shared";
import { z } from "zod";
import { takeToken, type Bucket, type Storage } from "../storage.js";

/**
 * MLS delivery service for one encrypted conversation.
 *
 * It keeps who is in the conversation and which devices are MLS leaves,
 * orders commits (exactly one per epoch), and stores an append-only log of
 * commits, welcomes and application messages for devices to fetch. It never
 * holds keys and can't read anything in the log.
 *
 * Commits list the devices they add and remove, so the object can enforce
 * who may change membership. Clients check the MLS commit itself.
 *
 * When a member loses access (a channel permission change, a kick or ban,
 * or `revoke`) they are cut off from new items at once and marked pending
 * removal. A signed-out device (`revokeDevices`) is treated the same way. No
 * new messages are accepted until a member commits the removal, so nothing
 * is ever encrypted under keys they still hold.
 */

export const CONVERSATION_LIMITS = {
  /** Every member's channel access is rechecked this often, and on adds. */
  auditIntervalMs: 60_000,
  /** How long one user's channel permissions are trusted. */
  permCacheMs: 10_000,
  idempotencyTtlMs: 24 * 60 * 60 * 1000,
} as const;

const RATE = {
  message: { burst: 10, perSecond: 1 },
  commit: { burst: 10, perSecond: 0.5 },
} as const;

export const ConversationOp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("get") }),
  z.object({ type: z.literal("fetch"), query: schemas.EnvelopeQuery }),
  z.object({ type: z.literal("commit"), body: schemas.CommitRequest }),
  z.object({ type: z.literal("send"), body: schemas.SendMessageRequest }),
]);
export type ConversationOp = z.infer<typeof ConversationOp>;
export type ConversationOpInput = z.input<typeof ConversationOp>;

export interface ConversationInit {
  id: string;
  kind: schemas.ConversationKind;
  creator: schemas.DeviceRef;
  /** The other user in a DM. */
  peerId?: string;
  serverId?: string;
  channelId?: string;
}

/** `effects` tell the Worker how to update its D1 index. */
export interface ConversationReply {
  status: number;
  body: unknown;
  effects?: { added?: string[]; removed?: string[] };
}

export interface ConversationDeps {
  now: () => number;
  /** Push an event to users' gateways. Best effort; clients also poll. */
  notify: (userIds: string[], event: GatewayEvent) => Promise<void>;
  /**
   * Channel permissions of `userIds`, worked out from `actorId`'s view of
   * the server. Null if the actor can't see the channel.
   */
  channelAccess: (serverId: string, channelId: string, actorId: string, userIds: string[]) => Promise<Map<string, bigint> | null>;
}

interface ConvRow {
  id: string;
  kind: schemas.ConversationKind;
  server_id: string | null;
  channel_id: string | null;
  epoch: number;
  audited_at: number;
  created_at: number;
}

interface MemberRow {
  user_id: string;
  role: "owner" | "member";
  pending_removal: number;
  cutoff_seq: number | null;
}

interface DeviceRow {
  device_id: string;
  user_id: string;
  joined_seq: number;
  left_seq: number | null;
  revoked_seq: number | null;
}

class Fail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

function fail(status: number, code: string, extra?: Record<string, unknown>): never {
  throw new Fail(status, code, extra);
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

export class ConversationCore {
  private readonly sql;
  private readonly buckets = new Map<string, Bucket>();
  private readonly permCache = new Map<string, { perms: bigint; at: number }>();

  constructor(
    private readonly storage: Storage,
    private readonly deps: ConversationDeps,
  ) {
    this.sql = storage.sql;
  }

  // ------------------------------------------------------------ reads

  private conv(): ConvRow | undefined {
    return this.sql.exec<ConvRow>("SELECT * FROM conversation").toArray()[0];
  }

  private members(): MemberRow[] {
    return this.sql.exec<MemberRow>("SELECT user_id, role, pending_removal, cutoff_seq FROM members ORDER BY user_id").toArray();
  }

  private member(userId: string): MemberRow | undefined {
    return this.sql
      .exec<MemberRow>("SELECT user_id, role, pending_removal, cutoff_seq FROM members WHERE user_id = ?", userId)
      .toArray()[0];
  }

  private device(deviceId: string): DeviceRow | undefined {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE device_id = ?", deviceId).toArray()[0];
  }

  private activeDevices(): DeviceRow[] {
    return this.sql.exec<DeviceRow>("SELECT * FROM devices WHERE left_seq IS NULL ORDER BY user_id, device_id").toArray();
  }

  private lastSeq(): number {
    const row = this.sql.exec<{ seq: number | null }>("SELECT MAX(seq) AS seq FROM log").toArray()[0];
    return row?.seq ?? 0;
  }

  private view(conv: ConvRow): schemas.Conversation {
    return {
      id: conv.id,
      kind: conv.kind,
      serverId: conv.server_id,
      channelId: conv.channel_id,
      epoch: conv.epoch,
      members: this.members().map((m) => ({ userId: m.user_id, role: m.role, pendingRemoval: m.pending_removal === 1 })),
      devices: this.activeDevices().map((d) => ({ userId: d.user_id, deviceId: d.device_id })),
      createdAt: conv.created_at,
    };
  }

  // ------------------------------------------------------------ setup

  /**
   * Creates the conversation with the creator's device as the only MLS
   * leaf, at epoch 0. A DM's peer is a member from the start; the creator's
   * first commit adds their devices.
   */
  async init(init: ConversationInit): Promise<ConversationReply> {
    if (this.conv()) return { status: 409, body: { error: "already_exists" } };
    const now = this.deps.now();
    if (init.kind === "channel") {
      if (!init.serverId || !init.channelId) return { status: 400, body: { error: "invalid_request" } };
      const perms = await this.deps.channelAccess(init.serverId, init.channelId, init.creator.userId, [init.creator.userId]);
      const mine = perms?.get(init.creator.userId) ?? 0n;
      if (!has(mine, P.VIEW_CHANNEL)) return { status: 404, body: { error: "not_found" } };
      if (!has(mine, P.MANAGE_CHANNELS)) return { status: 403, body: { error: "missing_permission" } };
    }
    if (init.kind === "dm" && (!init.peerId || init.peerId === init.creator.userId)) {
      return { status: 400, body: { error: "invalid_request" } };
    }
    this.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO conversation (id, kind, server_id, channel_id, epoch, audited_at, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)",
        init.id,
        init.kind,
        init.serverId ?? null,
        init.channelId ?? null,
        now,
        now,
      );
      const role = init.kind === "group" ? "owner" : "member";
      this.sql.exec("INSERT INTO members (user_id, role, added_at) VALUES (?, ?, ?)", init.creator.userId, role, now);
      if (init.peerId) this.sql.exec("INSERT INTO members (user_id, role, added_at) VALUES (?, 'member', ?)", init.peerId, now);
      this.sql.exec("INSERT INTO devices (device_id, user_id, joined_seq) VALUES (?, ?, 0)", init.creator.deviceId, init.creator.userId);
    });
    const added = [init.creator.userId, ...(init.peerId ? [init.peerId] : [])];
    const conv = this.conv()!;
    if (init.peerId) await this.notify([init.peerId], 0);
    return { status: 201, body: this.view(conv), effects: { added } };
  }

  /**
   * Cuts users off and marks them for removal, e.g. when they're removed
   * from the server or sign a device out. Called by other objects.
   */
  async revoke(userIds: string[]): Promise<void> {
    if (!this.conv()) return;
    const marked = this.markPending(userIds);
    if (marked.length > 0) await this.notify(this.readers(), this.lastSeq());
  }

  /** Cuts off devices that were signed out, until a commit removes them. */
  async revokeDevices(deviceIds: string[]): Promise<void> {
    if (!this.conv()) return;
    const seq = this.lastSeq();
    let changed = 0;
    for (const deviceId of deviceIds) {
      changed += this.sql.exec(
        "UPDATE devices SET revoked_seq = ? WHERE device_id = ? AND left_seq IS NULL AND revoked_seq IS NULL",
        seq,
        deviceId,
      ).rowsWritten;
    }
    if (changed > 0) await this.notify(this.readers(), seq);
  }

  private markPending(userIds: readonly string[]): string[] {
    const seq = this.lastSeq();
    const marked: string[] = [];
    for (const userId of userIds) {
      const m = this.member(userId);
      if (!m || m.pending_removal === 1) continue;
      this.sql.exec("UPDATE members SET pending_removal = 1, cutoff_seq = ? WHERE user_id = ?", seq, userId);
      marked.push(userId);
    }
    return marked;
  }

  // ------------------------------------------------------------ ops

  /**
   * Run one op for a device. Writes need an idempotency key; a retry with
   * the same key gets the first reply back.
   */
  async handle(actor: schemas.DeviceRef, input: unknown, idempotencyKey: string | null): Promise<ConversationReply> {
    const parsed = ConversationOp.safeParse(input);
    if (!parsed.success) return { status: 400, body: { error: "invalid_request" } };
    const op = parsed.data;
    const conv = this.conv();
    if (!conv) return { status: 404, body: { error: "not_found" } };
    const now = this.deps.now();
    const writes = op.type === "commit" || op.type === "send";

    let print = "";
    if (writes) {
      if (!idempotencyKey) return { status: 400, body: { error: "idempotency_key_required" } };
      print = fingerprint(JSON.stringify(op));
      this.sql.exec("DELETE FROM idempotency WHERE created_at < ?", now - CONVERSATION_LIMITS.idempotencyTtlMs);
      const prior = this.sql
        .exec<{ fingerprint: string; reply: string }>(
          "SELECT fingerprint, reply FROM idempotency WHERE user_id = ? AND key = ?",
          actor.userId,
          idempotencyKey,
        )
        .toArray()[0];
      if (prior) {
        if (prior.fingerprint !== print) return { status: 422, body: { error: "idempotency_key_reused" } };
        return JSON.parse(prior.reply) as ConversationReply;
      }
      const limit = op.type === "send" ? RATE.message : RATE.commit;
      const key = `${op.type}:${actor.userId}`;
      const { allowed, bucket } = takeToken(this.buckets.get(key), limit.burst, limit.perSecond, now);
      this.buckets.set(key, bucket);
      if (!allowed) return { status: 429, body: { error: "rate_limited" } };
    }

    let reply: ConversationReply;
    try {
      const extra = op.type === "commit" ? op.body.adds.map((a) => a.userId) : [];
      const perms = await this.audit(conv, actor.userId, now, extra);
      switch (op.type) {
        case "get":
          this.requireMember(actor.userId);
          reply = { status: 200, body: this.view(this.conv()!) };
          break;
        case "fetch":
          reply = { status: 200, body: this.fetch(actor, op.query) };
          break;
        case "send":
          reply = await this.send(actor, op.body, now, perms);
          break;
        case "commit":
          reply = await this.commit(actor, op.body, now, perms);
          break;
      }
    } catch (err) {
      if (!(err instanceof Fail)) throw err;
      reply = { status: err.status, body: { error: err.code, ...err.extra } };
    }

    if (writes && reply.status < 500 && reply.status !== 429) {
      this.sql.exec(
        "INSERT INTO idempotency (user_id, key, fingerprint, reply, created_at) VALUES (?, ?, ?, ?, ?)",
        actor.userId,
        idempotencyKey,
        print,
        JSON.stringify(reply),
        now,
      );
    }
    return reply;
  }

  /**
   * For channel conversations: work out the permissions of the actor and
   * `extra` users (cached briefly), and every so often of all members. Anyone
   * who lost VIEW_CHANNEL is marked for removal; anyone who got it back
   * before being removed is unmarked. Returns null outside channels.
   */
  private async audit(conv: ConvRow, actorId: string, now: number, extra: readonly string[]): Promise<Map<string, bigint> | null> {
    if (conv.kind !== "channel") return null;
    const members = this.members();
    const actor = members.find((m) => m.user_id === actorId);
    // Someone already cut off: don't spend a server call on them.
    if (!actor || actor.pending_removal === 1) return null;

    const due = extra.length > 0 || now - conv.audited_at >= CONVERSATION_LIMITS.auditIntervalMs;
    const wanted = due ? [...new Set([...members.map((m) => m.user_id), ...extra])] : [actorId];
    const fresh = wanted.filter((u) => {
      const hit = this.permCache.get(u);
      return !hit || now - hit.at >= CONVERSATION_LIMITS.permCacheMs;
    });
    if (fresh.length > 0) {
      const perms = await this.deps.channelAccess(conv.server_id!, conv.channel_id!, actorId, fresh);
      for (const u of fresh) this.permCache.set(u, { perms: perms?.get(u) ?? 0n, at: now });
    }
    const perms = new Map(wanted.map((u) => [u, this.permCache.get(u)!.perms]));

    const memberIds = new Set(members.map((m) => m.user_id));
    const lost = wanted.filter((u) => memberIds.has(u) && !has(perms.get(u)!, P.VIEW_CHANNEL));
    const regained = members.filter((m) => m.pending_removal === 1 && perms.has(m.user_id) && has(perms.get(m.user_id)!, P.VIEW_CHANNEL));

    let marked: string[] = [];
    this.storage.transactionSync(() => {
      marked = this.markPending(lost);
      for (const m of regained) this.sql.exec("UPDATE members SET pending_removal = 0, cutoff_seq = NULL WHERE user_id = ?", m.user_id);
      if (due) this.sql.exec("UPDATE conversation SET audited_at = ?", now);
    });
    if (marked.length > 0) await this.notify(this.readers(), this.lastSeq());
    return perms;
  }

  private requireMember(userId: string): MemberRow {
    const m = this.member(userId);
    if (!m) fail(404, "not_found");
    if (m.pending_removal === 1) fail(403, "access_revoked");
    return m;
  }

  /** The actor's device must be a current leaf. */
  private requireLeaf(actor: schemas.DeviceRef): MemberRow {
    const m = this.requireMember(actor.userId);
    const d = this.device(actor.deviceId);
    if (!d || d.user_id !== actor.userId || d.left_seq !== null) fail(403, "device_not_in_group");
    if (d.revoked_seq !== null) fail(403, "device_revoked");
    return m;
  }

  private fetch(actor: schemas.DeviceRef, query: z.output<typeof schemas.EnvelopeQuery>): { envelopes: schemas.Envelope[]; epoch: number } {
    const m = this.member(actor.userId);
    const d = this.device(actor.deviceId);
    if (!d || d.user_id !== actor.userId) fail(404, "not_found");
    // Former members keep reading up to the commit that removed them, so
    // their client sees it; pending ones stop where they were cut off.
    const until = Math.min(
      d.left_seq ?? Number.MAX_SAFE_INTEGER,
      d.revoked_seq ?? Number.MAX_SAFE_INTEGER,
      m?.pending_removal === 1 ? (m.cutoff_seq ?? 0) : Number.MAX_SAFE_INTEGER,
    );
    const rows = this.sql
      .exec<{
        seq: number;
        kind: schemas.Envelope["kind"];
        sender_id: string;
        sender_device_id: string;
        epoch: number;
        data: string;
        created_at: number;
      }>(
        `SELECT seq, kind, sender_id, sender_device_id, epoch, data, created_at FROM log
         WHERE seq > ? AND seq >= ? AND seq <= ? AND (kind != 'welcome' OR seq = ?)
         ORDER BY seq LIMIT ?`,
        query.after,
        d.joined_seq,
        until,
        d.joined_seq,
        query.limit,
      )
      .toArray();
    return {
      envelopes: rows.map((r) => ({
        seq: r.seq,
        kind: r.kind,
        senderId: r.sender_id,
        senderDeviceId: r.sender_device_id,
        epoch: r.epoch,
        data: r.data,
        createdAt: r.created_at,
      })),
      epoch: this.conv()!.epoch,
    };
  }

  private async send(
    actor: schemas.DeviceRef,
    body: z.output<typeof schemas.SendMessageRequest>,
    now: number,
    perms: Map<string, bigint> | null,
  ): Promise<ConversationReply> {
    this.requireLeaf(actor);
    const conv = this.conv()!;
    if (perms && !has(perms.get(actor.userId) ?? 0n, P.SEND_MESSAGES)) fail(403, "missing_permission");
    if (body.epoch !== conv.epoch) fail(409, "stale_epoch", { epoch: conv.epoch });
    // Keys must rotate before anything new is said.
    const pending = this.members().filter((m) => m.pending_removal === 1);
    const revoked = this.activeDevices().filter((d) => d.revoked_seq !== null);
    if (pending.length > 0 || revoked.length > 0) {
      fail(409, "rotation_required", { userIds: pending.map((m) => m.user_id), deviceIds: revoked.map((d) => d.device_id) });
    }

    this.sql.exec(
      "INSERT INTO log (kind, sender_id, sender_device_id, epoch, data, created_at) VALUES ('message', ?, ?, ?, ?, ?)",
      actor.userId,
      actor.deviceId,
      body.epoch,
      body.ciphertext,
      now,
    );
    const seq = this.lastSeq();
    await this.notify(this.readers(), seq);
    return { status: 201, body: { seq } };
  }

  private async commit(
    actor: schemas.DeviceRef,
    body: z.output<typeof schemas.CommitRequest>,
    now: number,
    perms: Map<string, bigint> | null,
  ): Promise<ConversationReply> {
    const me = this.requireLeaf(actor);
    const conv = this.conv()!;
    if (body.epoch !== conv.epoch) fail(409, "stale_epoch", { epoch: conv.epoch });

    const members = new Map(this.members().map((m) => [m.user_id, m]));
    const active = new Map(this.activeDevices().map((d) => [d.device_id, d]));

    // ---- removes
    const removedDevices = new Set<string>();
    for (const r of body.removes) {
      const d = active.get(r.deviceId);
      if (!d || d.user_id !== r.userId || removedDevices.has(r.deviceId)) fail(400, "unknown_device", { deviceId: r.deviceId });
      removedDevices.add(r.deviceId);
      if (r.userId === actor.userId) continue;
      const target = members.get(r.userId);
      // Your own devices, anyone or any device cut off, or anyone at all for a group owner.
      const allowed = d.revoked_seq !== null || target?.pending_removal === 1 || (conv.kind === "group" && me.role === "owner");
      if (!allowed) fail(403, "cannot_remove", { userId: r.userId });
    }
    if (removedDevices.has(actor.deviceId)) fail(400, "cannot_remove_self_device");

    // ---- adds
    const newUsers = new Set<string>();
    for (const a of body.adds) {
      if (active.has(a.deviceId) && !removedDevices.has(a.deviceId)) fail(409, "device_already_in_group", { deviceId: a.deviceId });
      const m = members.get(a.userId);
      if (m) {
        if (m.pending_removal === 1) fail(403, "access_revoked", { userId: a.userId });
        continue;
      }
      if (conv.kind === "dm") fail(403, "cannot_add_to_dm");
      if (conv.kind === "group" && me.role !== "owner") fail(403, "missing_permission");
      if (conv.kind === "channel" && !has(perms?.get(a.userId) ?? 0n, P.VIEW_CHANNEL)) {
        fail(403, "cannot_view_channel", { userId: a.userId });
      }
      newUsers.add(a.userId);
    }
    const cap = conv.kind === "dm" ? 2 : conv.kind === "group" ? schemas.E2EE_LIMITS.maxGroupMembers : schemas.E2EE_LIMITS.maxChannelMembers;

    // Users left with no device after the removes stop being members.
    const remaining = new Map<string, number>();
    for (const d of active.values()) if (!removedDevices.has(d.device_id)) remaining.set(d.user_id, (remaining.get(d.user_id) ?? 0) + 1);
    for (const a of body.adds) remaining.set(a.userId, (remaining.get(a.userId) ?? 0) + 1);
    const departed = [...new Set(body.removes.map((r) => r.userId))].filter((u) => !remaining.has(u));
    const memberCount = members.size + newUsers.size - departed.filter((u) => members.has(u)).length;
    if (memberCount > cap) fail(409, "too_many_members", { max: cap });

    let commitSeq = 0;
    let lastSeq = 0;
    this.storage.transactionSync(() => {
      this.sql.exec(
        "INSERT INTO log (kind, sender_id, sender_device_id, epoch, data, created_at) VALUES ('commit', ?, ?, ?, ?, ?)",
        actor.userId,
        actor.deviceId,
        body.epoch,
        body.commit,
        now,
      );
      commitSeq = this.lastSeq();
      for (const deviceId of removedDevices) this.sql.exec("UPDATE devices SET left_seq = ? WHERE device_id = ?", commitSeq, deviceId);
      for (const userId of departed) this.sql.exec("DELETE FROM members WHERE user_id = ?", userId);

      if (body.welcome !== undefined) {
        this.sql.exec(
          "INSERT INTO log (kind, sender_id, sender_device_id, epoch, data, created_at) VALUES ('welcome', ?, ?, ?, ?, ?)",
          actor.userId,
          actor.deviceId,
          body.epoch + 1,
          body.welcome,
          now,
        );
        const welcomeSeq = this.lastSeq();
        for (const userId of newUsers) this.sql.exec("INSERT INTO members (user_id, role, added_at) VALUES (?, 'member', ?)", userId, now);
        for (const a of body.adds) {
          this.sql.exec(
            `INSERT INTO devices (device_id, user_id, joined_seq) VALUES (?, ?, ?)
             ON CONFLICT (device_id) DO UPDATE SET
               user_id = excluded.user_id, joined_seq = excluded.joined_seq, left_seq = NULL, revoked_seq = NULL`,
            a.deviceId,
            a.userId,
            welcomeSeq,
          );
        }
      }
      this.sql.exec("UPDATE conversation SET epoch = epoch + 1");
      lastSeq = this.lastSeq();
    });

    // Everyone still in, newcomers, and those removed (so they see it).
    const touched = new Set([...this.readers(), ...body.removes.map((r) => r.userId)]);
    await this.notify([...touched], lastSeq);
    const effects: ConversationReply["effects"] = {};
    if (newUsers.size > 0) effects.added = [...newUsers];
    if (departed.length > 0) effects.removed = departed;
    return { status: 201, body: { seq: commitSeq, epoch: body.epoch + 1 }, effects };
  }

  // ------------------------------------------------------------ delivery

  /** Members who may read new items. */
  private readers(): string[] {
    return this.members()
      .filter((m) => m.pending_removal === 0)
      .map((m) => m.user_id);
  }

  private async notify(userIds: string[], seq: number): Promise<void> {
    if (userIds.length === 0) return;
    const conversationId = this.conv()!.id;
    const event = { id: newId(), t: "CONVERSATION_UPDATE", d: { conversationId, seq } } as GatewayEvent;
    try {
      await this.deps.notify(userIds, event);
    } catch {
      // Clients catch up by fetching after their last seq.
    }
  }
}
