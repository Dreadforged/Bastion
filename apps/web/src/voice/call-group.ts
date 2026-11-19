import { ApiError, newIdempotencyKey, type Api } from "../lib/http.js";
import { VoiceE2eeError } from "./keys.js";
import type { VoiceMls } from "./mls.js";

/**
 * The MLS group behind a call, and the commits that rotate its keys.
 *
 * Voice channel: the group is the channel's encrypted conversation, so
 * everyone who can view the channel is a member and a kick, ban or lost
 * permission removes them from the group (the server marks them pending
 * removal and a remaining member commits it).
 *
 * DM call: a fresh `group` conversation per call, so call keys have nothing
 * to do with the DM's message history.
 *
 * Joining or leaving a call does not change who is in a channel's group, so it
 * is a self-update commit: a new epoch, and with it a new media key. The device
 * that commits is chosen by `chooseRotator` so one commit lands, not many.
 */

export interface CallGroupDeps {
  api: Pick<Api, "post">;
  mls: VoiceMls;
  /** Fetch and apply everything new in the conversation (commits, welcomes). */
  sync(conversationId: string): Promise<void>;
  /** Conversation ids are 16 bytes, base64url; the MLS group id is those bytes. */
  groupIdOf(conversationId: string): Uint8Array;
  /**
   * Called with a new call group's id as soon as it exists, before anything is
   * committed to it, so the messaging layer can ignore it as a chat.
   */
  onCreated?(conversationId: string): void;
}

const MAX_ATTEMPTS = 4;

export class CallGroup {
  readonly groupId: Uint8Array;

  constructor(
    private readonly deps: CallGroupDeps,
    readonly conversationId: string,
  ) {
    this.groupId = deps.groupIdOf(conversationId);
  }

  /** Catch up and make sure this device is a member. Joining needs a Welcome from a member. */
  async ready(): Promise<void> {
    await this.deps.sync(this.conversationId);
    if (!this.deps.mls.inGroup(this.groupId)) throw new VoiceE2eeError("not_in_group");
  }

  get epoch(): number {
    return this.deps.mls.epoch(this.groupId);
  }

  /**
   * Move the group to a new epoch. If another member's commit wins the race
   * the epoch has moved anyway, which is all a rotation needs, so a lost race
   * ends successfully once this device has caught up.
   */
  async rotate(): Promise<"committed" | "someone_else"> {
    const { api, mls, sync } = this.deps;
    const startEpoch = mls.epoch(this.groupId);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const epoch = mls.epoch(this.groupId);
      if (epoch !== startEpoch) return "someone_else";
      const commit = mls.updateKeys(this.groupId);
      try {
        await api.post(
          `/conversations/${this.conversationId}/commits`,
          { epoch, commit: toB64(commit), adds: [], removes: [] },
          { idempotencyKey: newIdempotencyKey() },
        );
      } catch (err) {
        mls.commitRejected(this.groupId);
        if (err instanceof ApiError && err.status === 409) {
          // Someone committed first. Apply theirs.
          await sync(this.conversationId);
          continue;
        }
        throw err;
      }
      mls.commitAccepted(this.groupId);
      return "committed";
    }
    // Still racing after several tries: the epoch must have moved by now.
    if (mls.epoch(this.groupId) !== startEpoch) return "someone_else";
    throw new VoiceE2eeError("rotation_failed");
  }
}

/**
 * Which participant commits after a join or leave. Everyone computes the same
 * answer from the same list, so normally exactly one device does. The joiner
 * and the leaver never rotate for their own change: they are the one person
 * the rotation is meant to cut off from, or to start fresh against. Returns
 * null when nobody else is left to do it.
 */
export function chooseRotator(participantIds: readonly string[], changed: string): string | null {
  const others = participantIds.filter((id) => id !== changed).sort();
  return others[0] ?? null;
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

// ------------------------------------------------------------------ DM calls

/**
 * Start a DM call's group: a fresh `group` conversation, this device as the
 * MLS creator, and the other person's devices added from their key packages.
 * The callee gets a Welcome through the delivery service and joins by syncing
 * the conversation (see `CallGroup.ready`).
 *
 * Needs the caller's own devices to be able to read the group afterwards, so
 * the sync passed in `deps` must treat the conversation as known (the messaging
 * layer's sync ignores conversations it has not been told about).
 */
export async function startDmCallGroup(
  deps: CallGroupDeps & { api: Pick<Api, "post"> },
  peerUserId: string,
): Promise<CallGroup> {
  const { api, mls } = deps;
  const conv = await api.post<{ id: string }>("/conversations", { kind: "group" }, { idempotencyKey: newIdempotencyKey() });
  deps.onCreated?.(conv.id);
  const gid = deps.groupIdOf(conv.id);
  mls.createGroup(gid);
  const claimed = await api.post<{ keyPackages: { userId: string; deviceId: string; keyPackage: string }[]; exhausted: unknown[] }>(
    "/keys/packages/claim",
    { userIds: [peerUserId] },
  );
  if (claimed.keyPackages.length === 0) throw new VoiceE2eeError("key_unavailable", "the other person has no device to call");
  // One commit per device: each adds a device and moves the epoch, so keys are fresh when the callee arrives.
  for (const pkg of claimed.keyPackages) {
    const epoch = mls.epoch(gid);
    const out = mls.addMember(gid, fromB64(pkg.keyPackage));
    await api.post(
      `/conversations/${conv.id}/commits`,
      {
        epoch,
        commit: toB64(out.commit),
        ...(out.welcome ? { welcome: toB64(out.welcome) } : {}),
        adds: [{ userId: pkg.userId, deviceId: pkg.deviceId }],
        removes: [],
      },
      { idempotencyKey: newIdempotencyKey() },
    );
    mls.commitAccepted(gid);
  }
  return new CallGroup(deps, conv.id);
}

function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
