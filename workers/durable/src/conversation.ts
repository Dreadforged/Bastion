import type { schemas } from "@bastion/shared";
import { DurableObject } from "cloudflare:workers";
import { channelPermissions } from "./conversation/access.js";
import { ConversationCore, type ConversationInit, type ConversationReply } from "./conversation/core.js";
import { CONVERSATION_MIGRATIONS } from "./conversation/schema.js";
import type { DurableEnv } from "./env.js";
import { fromDurableStorage, migrate } from "./storage.js";

/**
 * One per encrypted conversation (DM, private group or members-only
 * channel), addressed by `idFromName(conversationId)`. The MLS delivery
 * service: orders commits, stores ciphertext and tells members when there is
 * something new. Called over RPC by the API Worker; never sees plaintext.
 */
export class Conversation extends DurableObject<DurableEnv> {
  private readonly core: ConversationCore;

  constructor(ctx: DurableObjectState, env: DurableEnv) {
    super(ctx, env);
    const storage = fromDurableStorage(ctx.storage);
    migrate(storage, CONVERSATION_MIGRATIONS);
    this.core = new ConversationCore(storage, {
      now: Date.now,
      notify: async (userIds, event) => {
        await Promise.allSettled(
          userIds.map((userId) => env.USER_SESSION.get(env.USER_SESSION.idFromName(userId)).receive(userId, [event])),
        );
      },
      channelAccess: async (serverId, channelId, actorId, userIds) => {
        const snapshot = await env.SERVER.get(env.SERVER.idFromName(serverId)).snapshot(actorId);
        return snapshot ? channelPermissions(snapshot, channelId, userIds, Date.now()) : null;
      },
    });
  }

  async init(init: ConversationInit): Promise<ConversationReply> {
    return this.core.init(init);
  }

  async handle(actor: schemas.DeviceRef, op: unknown, idempotencyKey: string | null): Promise<ConversationReply> {
    return this.core.handle(actor, op, idempotencyKey);
  }

  async revoke(userIds: string[]): Promise<void> {
    await this.core.revoke(userIds);
  }

  async revokeDevices(deviceIds: string[]): Promise<void> {
    await this.core.revokeDevices(deviceIds);
  }
}
