import { newId, schemas } from "@bastion/shared";
import { HttpError } from "../http.js";

/**
 * Staff here means platform staff with admin access, not server moderators.
 * There is no staff login yet: these functions are for the internal admin tool
 * (behind Cloudflare Access) and for tests. Do not expose them on a public route.
 */

export interface StaffAccess {
  staffId: string;
  kind: "view" | "change";
  action: string;
  subjectType: string;
  subjectId: string;
  reasonCode?: schemas.ReasonCode | undefined;
}

export async function logStaffAccess(db: D1Database, entry: StaffAccess, now: number): Promise<void> {
  await staffLogStatement(db, entry, now).run();
}

export function staffLogStatement(db: D1Database, entry: StaffAccess, now: number): D1PreparedStatement {
  return db
    .prepare("INSERT INTO staff_access_log (id, staff_id, kind, action, subject_type, subject_id, reason_code, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(newId(), entry.staffId, entry.kind, entry.action, entry.subjectType, entry.subjectId, entry.reasonCode ?? null, now);
}

/** Change an account's state. The reason code is required and recorded in the staff log. */
export async function setAccountState(
  db: D1Database,
  staffId: string,
  userId: string,
  state: schemas.AccountState,
  reasonCode: schemas.ReasonCode,
  now: number,
): Promise<void> {
  const [updated] = await db.batch([
    db.prepare("UPDATE users SET account_state = ?, state_reason = ?, state_changed_at = ? WHERE id = ?").bind(state, reasonCode, now, userId),
    staffLogStatement(db, { staffId, kind: "change", action: `account.state.${state}`, subjectType: "account", subjectId: userId, reasonCode }, now),
  ]);
  if (updated!.meta.changes === 0) throw new HttpError(404, "not_found");
}
