import { schemas } from "@bastion/shared";
import type { Server, UserSession } from "@bastion/durable";
import { AuthError } from "../auth/errors.js";
import type { Principal } from "../auth/sessions.js";

/**
 * Feature limits that follow the account state. Suspended and removed accounts
 * never get this far (the token check refuses them). These cover the rest:
 *
 *   restricted          read and export only: every write is refused
 *   pending_age_review  cannot start new contact (new DMs, calls, joining or
 *                       creating servers); existing conversations keep working
 *   any limited account (see isAgeLimited) cannot see age restricted channels,
 *                       which the Server object enforces from the flag set here
 */

/** Throws 403 `account_restricted` for a write by a restricted account. */
export function requireWritable(principal: Principal, method: string): void {
  if (method === "GET" || method === "HEAD") return;
  if (schemas.READ_ONLY_STATES.includes(principal.accountState)) throw new AuthError(403, "account_restricted");
}

/** Throws 403 `account_restricted` or `age_review_pending` when the account may not start new contact. */
export function requireNewContact(principal: Principal): void {
  if (!schemas.NO_NEW_CONTACT_STATES.includes(principal.accountState)) return;
  throw new AuthError(403, principal.accountState === "restricted" ? "account_restricted" : "age_review_pending");
}

export interface AgeLimitDeps {
  db: D1Database;
  sessions: DurableObjectNamespace<UserSession>;
  servers: DurableObjectNamespace<Server>;
}

/** Tell every server the person is in whether age restricted channels are hidden from them. */
export async function syncAgeLimit(deps: AgeLimitDeps, userId: string): Promise<void> {
  const user = await deps.db
    .prepare("SELECT account_state, age_band FROM users WHERE id = ?")
    .bind(userId)
    .first<{ account_state: schemas.AccountState; age_band: schemas.AgeBand }>();
  if (!user) return;
  const limited = schemas.isAgeLimited(user.account_state, user.age_band);
  const serverIds = await deps.sessions.get(deps.sessions.idFromName(userId)).listServerIds();
  await Promise.allSettled(serverIds.map((id) => deps.servers.get(deps.servers.idFromName(id)).setAgeLimit(userId, limited)));
}
