import { newId, schemas } from "@bastion/shared";
import { HttpError } from "../http.js";
import { staffLogStatement } from "./staff.js";

/**
 * Legal holds. A held account, server, file or report must not be deleted or
 * expired until the hold is released. Every path that deletes or expires
 * these things must call `assertNotHeld` (or `isHeld`) first. The account
 * deletion route does not exist yet; it must do so when it is built.
 */

export async function placeHold(
  db: D1Database,
  staffId: string,
  subjectType: schemas.HoldSubjectType,
  subjectId: string,
  reasonCode: schemas.ReasonCode,
  reference: string | null,
  now: number,
): Promise<string> {
  const id = newId();
  await db.batch([
    db
      .prepare("INSERT INTO legal_holds (id, subject_type, subject_id, reason_code, reference, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, subjectType, subjectId, reasonCode, reference, staffId, now),
    staffLogStatement(db, { staffId, kind: "change", action: "hold.place", subjectType, subjectId, reasonCode }, now),
  ]);
  return id;
}

export async function releaseHold(db: D1Database, staffId: string, holdId: string, now: number): Promise<void> {
  const hold = await db
    .prepare("SELECT subject_type, subject_id FROM legal_holds WHERE id = ? AND released_at IS NULL")
    .bind(holdId)
    .first<{ subject_type: string; subject_id: string }>();
  if (!hold) throw new HttpError(404, "not_found");
  await db.batch([
    db.prepare("UPDATE legal_holds SET released_at = ?, released_by = ? WHERE id = ?").bind(now, staffId, holdId),
    staffLogStatement(db, { staffId, kind: "change", action: "hold.release", subjectType: hold.subject_type, subjectId: hold.subject_id }, now),
  ]);
}

export async function isHeld(db: D1Database, subjectType: schemas.HoldSubjectType, subjectId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS held FROM legal_holds WHERE subject_type = ? AND subject_id = ? AND released_at IS NULL LIMIT 1")
    .bind(subjectType, subjectId)
    .first();
  return row !== null;
}

/** Throws 409 `legal_hold` when the subject is held. */
export async function assertNotHeld(db: D1Database, subjectType: schemas.HoldSubjectType, subjectId: string): Promise<void> {
  if (await isHeld(db, subjectType, subjectId)) throw new HttpError(409, "legal_hold");
}
