import type { GatewayEvent, schemas } from "@bastion/shared";
import { DurableObject } from "cloudflare:workers";
import type { DurableEnv } from "./env.js";
import { ServerCore } from "./server/core.js";
import type { Reply } from "./server/ops.js";
import { SERVER_MIGRATIONS } from "./server/schema.js";
import { fromDurableStorage, migrate } from "./storage.js";

/**
 * One per community server, addressed by `idFromName(serverId)`.
 * Authoritative for membership, roles, channels, overrides, messages and
 * invites, all in its own SQLite database. Called over RPC by the API Worker
 * and by UserSession objects; never reachable from clients directly.
 */
export class Server extends DurableObject<DurableEnv> {
  private readonly core: ServerCore;

  constructor(ctx: DurableObjectState, env: DurableEnv) {
    super(ctx, env);
    const storage = fromDurableStorage(ctx.storage);
    migrate(storage, SERVER_MIGRATIONS);
    this.core = new ServerCore(storage, {
      now: Date.now,
      deliver: async (userId: string, events: GatewayEvent[]) => {
        const stub = env.USER_SESSION.get(env.USER_SESSION.idFromName(userId));
        await stub.receive(userId, events);
      },
    });
  }

  async init(serverId: string, ownerId: string, name: string): Promise<Reply> {
    const reply = this.core.init(serverId, ownerId, name);
    await this.afterWrite();
    return reply;
  }

  async handle(userId: string, op: unknown, idempotencyKey: string | null): Promise<Reply> {
    const reply = await this.core.handle(userId, op, idempotencyKey);
    await this.afterWrite();
    return reply;
  }

  async snapshot(userId: string): Promise<schemas.ServerSnapshot | null> {
    return this.core.snapshot(userId);
  }

  async setPresence(userId: string, status: schemas.PresenceStatus | "offline"): Promise<void> {
    this.core.setPresence(userId, status);
    await this.afterWrite();
  }

  override async alarm(): Promise<void> {
    await this.scheduleRetry(await this.core.flush());
  }

  private async afterWrite(): Promise<void> {
    await this.scheduleRetry(await this.core.flush());
  }

  /** Undelivered events are retried from an alarm. */
  private async scheduleRetry(next: number | null): Promise<void> {
    if (next === null) return;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next) await this.ctx.storage.setAlarm(Math.max(next, Date.now() + 1000));
  }
}
