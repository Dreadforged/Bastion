import { newId, schemas, type GatewayEvent } from "@bastion/shared";
import type { Storage } from "../storage.js";
import type { VoiceEffect } from "../server/ops.js";

/**
 * Calls in a direct message. The DM's Conversation object keeps the state, so
 * the only people who can ring, answer, decline or end are its two members,
 * and the object never needs to look anything up elsewhere.
 *
 *   ringing --accept--> active --end/lease lapses--> ended
 *      \--decline/cancel/ring lapses--> ended
 *
 * There are no timers. A ring or lease that has lapsed is noticed the next
 * time anyone touches the call (`settle`), and clients also time out locally.
 * Nothing here ever holds a key: the call's MLS group is its own conversation.
 */

export interface CallActor {
  userId: string;
  deviceId: string;
}

export interface CallContext {
  storage: Storage;
  now: () => number;
  conversationId: string;
  /** Throws unless the user is a current member of this DM. Returns the other member. */
  peerOf(userId: string): string;
  notify(userIds: string[], event: GatewayEvent): Promise<void>;
}

/** What the Worker must turn into a LiveKit token, plus the call itself. */
export interface CallGrant {
  call: schemas.DmCall;
  roomId: string;
  participantId: string;
  canPublish: true;
  canShare: boolean;
  quality: schemas.StreamQuality;
}

export interface CallResult {
  status: number;
  body: unknown;
  voice?: VoiceEffect[];
}

interface CallRow {
  id: string;
  room_id: string;
  caller_id: string;
  callee_id: string;
  group_id: string;
  caller_participant: string;
  callee_participant: string;
  caller_share: number;
  callee_share: number;
  caller_plan: schemas.Plan;
  callee_plan: schemas.Plan | null;
  answered_device: string | null;
  state: schemas.CallState;
  end_reason: schemas.CallEndReason | null;
  ring_expires_at: number;
  lease_until: number;
  created_at: number;
}

const secs = (n: number) => n * 1000;

function randomHex(): string {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class CallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export class CallLogic {
  constructor(private readonly cx: CallContext) {}

  private get sql() {
    return this.cx.storage.sql;
  }

  private latest(): CallRow | undefined {
    return this.sql.exec<CallRow>("SELECT * FROM calls ORDER BY created_at DESC, rowid DESC LIMIT 1").toArray()[0];
  }

  private view(row: CallRow): schemas.DmCall {
    return {
      id: row.id,
      conversationId: this.cx.conversationId,
      callerId: row.caller_id,
      calleeId: row.callee_id,
      groupConversationId: row.group_id,
      state: row.state,
      endReason: row.end_reason,
      ringExpiresAt: row.ring_expires_at,
      createdAt: row.created_at,
    };
  }

  private both(row: CallRow): string[] {
    return [row.caller_id, row.callee_id];
  }

  private async push(row: CallRow): Promise<void> {
    const event = { id: newId(), t: "CALL_UPDATE", d: this.view(row) } as GatewayEvent;
    try {
      await this.cx.notify(this.both(row), event);
    } catch {
      // Best effort. Clients time out a ring on their own.
    }
  }

  /** Both people leave the room, whatever state it was in. Removing someone who is not there is harmless. */
  private removals(row: CallRow): VoiceEffect[] {
    return [
      { kind: "remove", roomId: row.room_id, participantId: row.caller_participant },
      { kind: "remove", roomId: row.room_id, participantId: row.callee_participant },
    ];
  }

  private end(row: CallRow, reason: schemas.CallEndReason): CallRow {
    this.sql.exec("UPDATE calls SET state = 'ended', end_reason = ? WHERE id = ?", reason, row.id);
    return { ...row, state: "ended", end_reason: reason };
  }

  /**
   * Close the latest call if its ring or lease has lapsed. Returns the call as
   * it now stands and any LiveKit clean-up this caused.
   */
  private async settle(): Promise<{ row: CallRow | undefined; voice: VoiceEffect[] }> {
    const now = this.cx.now();
    const row = this.latest();
    if (!row) return { row, voice: [] };
    if (row.state === "ringing" && now >= row.ring_expires_at) {
      const ended = this.end(row, "missed");
      await this.push(ended);
      return { row: ended, voice: this.removals(ended) };
    }
    if (row.state === "active" && now >= row.lease_until) {
      const ended = this.end(row, "timeout");
      await this.push(ended);
      return { row: ended, voice: this.removals(ended) };
    }
    return { row, voice: [] };
  }

  private grant(row: CallRow, userId: string): CallGrant {
    const caller = userId === row.caller_id;
    const plan = (caller ? row.caller_plan : row.callee_plan) ?? "free";
    return {
      call: this.view(row),
      roomId: row.room_id,
      participantId: caller ? row.caller_participant : row.callee_participant,
      canPublish: true,
      canShare: (caller ? row.caller_share : row.callee_share) === 1,
      quality: schemas.STREAM_QUALITY[plan],
    };
  }

  // ------------------------------------------------------------ ops

  async start(
    actor: CallActor,
    req: { groupConversationId: string; screenShare: boolean; plan: schemas.Plan },
  ): Promise<CallResult> {
    const peer = this.cx.peerOf(actor.userId);
    const now = this.cx.now();
    const { row: current, voice } = await this.settle();

    if (current && current.state !== "ended") {
      // The caller asking again for the call they already started is a retry.
      if (current.state === "ringing" && current.caller_id === actor.userId && current.group_id === req.groupConversationId) {
        return { status: 200, body: this.grant(current, actor.userId), voice };
      }
      throw new CallError(409, "call_in_progress");
    }
    if (current && current.caller_id === actor.userId && now - current.created_at < secs(schemas.CALL_LIMITS.redialSeconds)) {
      throw new CallError(429, "rate_limited");
    }
    if (this.sql.exec("SELECT 1 FROM calls WHERE group_id = ?", req.groupConversationId).toArray().length > 0) {
      // Reusing a group would reuse the call's key history.
      throw new CallError(409, "group_reused");
    }
    if (req.groupConversationId === this.cx.conversationId) throw new CallError(400, "invalid_request");

    const row: CallRow = {
      id: randomHex(),
      room_id: randomHex(),
      caller_id: actor.userId,
      callee_id: peer,
      group_id: req.groupConversationId,
      caller_participant: randomHex(),
      callee_participant: randomHex(),
      caller_share: req.screenShare ? 1 : 0,
      callee_share: 0,
      caller_plan: req.plan,
      callee_plan: null,
      answered_device: null,
      state: "ringing",
      end_reason: null,
      ring_expires_at: now + secs(schemas.CALL_LIMITS.ringSeconds),
      lease_until: now + secs(schemas.CALL_LIMITS.ringSeconds),
      created_at: now,
    };
    this.sql.exec(
      `INSERT INTO calls (id, room_id, caller_id, callee_id, group_id, caller_participant, callee_participant, caller_share,
         callee_share, caller_plan, callee_plan, answered_device, state, end_reason, ring_expires_at, lease_until, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.room_id,
      row.caller_id,
      row.callee_id,
      row.group_id,
      row.caller_participant,
      row.callee_participant,
      row.caller_share,
      row.callee_share,
      row.caller_plan,
      row.callee_plan,
      row.answered_device,
      row.state,
      row.end_reason,
      row.ring_expires_at,
      row.lease_until,
      row.created_at,
    );
    await this.push(row);
    return { status: 200, body: this.grant(row, actor.userId), voice };
  }

  async accept(actor: CallActor, req: { screenShare: boolean; plan: schemas.Plan }): Promise<CallResult> {
    this.cx.peerOf(actor.userId);
    const { row, voice } = await this.settle();
    if (!row || row.callee_id !== actor.userId) throw new CallError(404, "no_call");

    // The same device asking again gets the same grant; another of their devices does not.
    if (row.state === "active") {
      if (row.answered_device !== actor.deviceId) throw new CallError(409, "call_not_ringing");
      return { status: 200, body: this.grant(row, actor.userId), voice };
    }
    if (row.state !== "ringing") throw new CallError(409, "call_not_ringing");

    const now = this.cx.now();
    this.sql.exec(
      `UPDATE calls SET state = 'active', answered_device = ?, callee_share = ?, callee_plan = ?, lease_until = ? WHERE id = ?`,
      actor.deviceId,
      req.screenShare ? 1 : 0,
      req.plan,
      now + secs(schemas.CALL_LIMITS.leaseSeconds),
      row.id,
    );
    const answered = this.latest()!;
    await this.push(answered);
    return { status: 200, body: this.grant(answered, actor.userId), voice };
  }

  async decline(actor: CallActor): Promise<CallResult> {
    this.cx.peerOf(actor.userId);
    const { row, voice } = await this.settle();
    if (!row || row.callee_id !== actor.userId) throw new CallError(404, "no_call");
    if (row.state !== "ringing") throw new CallError(409, "call_not_ringing");
    const ended = this.end(row, "declined");
    await this.push(ended);
    return { status: 204, body: null, voice: [...voice, ...this.removals(ended)] };
  }

  /** The caller cancels a ring, or either person hangs up. Ending a call that is already over is not an error. */
  async hangUp(actor: CallActor): Promise<CallResult> {
    this.cx.peerOf(actor.userId);
    const { row, voice } = await this.settle();
    if (!row || (row.caller_id !== actor.userId && row.callee_id !== actor.userId)) throw new CallError(404, "no_call");
    if (row.state === "ended") return { status: 204, body: null, voice };
    // The callee ending a ring is declining it.
    const reason = row.state === "active" ? "ended" : row.caller_id === actor.userId ? "cancelled" : "declined";
    const ended = this.end(row, reason);
    await this.push(ended);
    return { status: 204, body: null, voice: [...voice, ...this.removals(ended)] };
  }

  /** Keeps an answered call alive. Clients send it about every 30 seconds. */
  async renew(actor: CallActor): Promise<CallResult> {
    this.cx.peerOf(actor.userId);
    const { row, voice } = await this.settle();
    if (!row || (row.caller_id !== actor.userId && row.callee_id !== actor.userId)) throw new CallError(404, "no_call");
    if (row.state === "ended") throw new CallError(409, "call_ended");
    if (row.state === "active") {
      this.sql.exec("UPDATE calls SET lease_until = ? WHERE id = ?", this.cx.now() + secs(schemas.CALL_LIMITS.leaseSeconds), row.id);
    }
    return { status: 200, body: this.view(this.latest()!), voice };
  }

  /** The latest call if it is still live (ringing or active), or null. */
  async current(actor: CallActor): Promise<CallResult> {
    this.cx.peerOf(actor.userId);
    const { row, voice } = await this.settle();
    return { status: 200, body: { call: row && row.state !== "ended" ? this.view(row) : null }, voice };
  }
}
