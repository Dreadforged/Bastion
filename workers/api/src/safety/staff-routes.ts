import { schemas } from "@bastion/shared";
import { AuthError } from "../auth/errors.js";
import { json } from "../auth/routes.js";
import { body, HttpError, id, query } from "../http.js";
import { applyVerifiedAge } from "./account.js";
import { setFlag, type FlagReader } from "./flags.js";
import { isHeld, placeHold, releaseHold } from "./holds.js";
import { logStaffAccess, setAccountState } from "./staff.js";
import type { StaffAuth } from "./staff-auth.js";
import { staffPage } from "./staff-page.js";

export interface StaffRouteDeps {
  db: D1Database;
  /** Undefined means staff access is not configured, and every /staff path answers 404. */
  staff: StaffAuth | undefined;
  flags: FlagReader;
  now: () => number;
  /**
   * After a staff change to an account: end its sessions when the new state blocks it,
   * and refresh what servers show it. Optional in tests.
   */
  onAccountChange?: ((userId: string, state: schemas.AccountState) => Promise<void>) | undefined;
  /** Keep a report out of the Server object's retention sweep, or release it. Returns false if there is no such report. */
  setReportHold?: ((serverId: string, reportId: string, held: boolean) => Promise<boolean>) | undefined;
}

/**
 * Internal admin tool for platform staff. Not for server moderators.
 *
 *   GET    /staff                              the page
 *   GET    /staff/accounts?state=&limit=       accounts that are not simply active, with signal weight
 *   GET    /staff/accounts/:id                 one account, its signals and holds
 *   PUT    /staff/accounts/:id/state           set the state, with a reason code
 *   POST   /staff/accounts/:id/age-review      close an age review: cleared, restrict or remove
 *   GET    /staff/flags                        every region flag
 *   PUT    /staff/flags                        set a flag for a region
 *   GET    /staff/holds?subjectType=&subjectId=
 *   POST   /staff/holds                        place a legal hold
 *   DELETE /staff/holds/:id                    release a hold
 *   GET    /staff/log?subjectType=&subjectId=  the staff access log
 *
 * Every view and every change is written to the staff access log with the
 * staff member's id. Nothing here shows message content, and reports and
 * evidence are not reachable here yet. Changes need the `x-staff-request`
 * header, which a cross site form cannot send.
 */
export async function handleStaff(request: Request, deps: StaffRouteDeps): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/staff" && !url.pathname.startsWith("/staff/")) return null;
  if (!deps.staff) return json({ error: "not_found" }, 404);

  try {
    const staffId = await deps.staff.authenticate(request);
    if (!staffId) return json({ error: "unauthorized" }, 401);
    const now = deps.now();
    const m = request.method;
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const n = parts.length;

    if (n === 0 && m === "GET") return staffPage();
    if (m !== "GET" && request.headers.get("x-staff-request") !== "1") throw new HttpError(403, "missing_staff_header");

    if (parts[0] === "accounts") {
      if (n === 1 && m === "GET") {
        const q = query(request, schemas.StaffAccountListQuery);
        await logStaffAccess(deps.db, { staffId, kind: "view", action: "accounts.list", subjectType: "query", subjectId: q.state ?? "flagged" }, now);
        return json(await listAccounts(deps.db, q.state, q.limit, now));
      }
      const userId = id(parts[1]);
      if (n === 2 && m === "GET") {
        const detail = await accountDetail(deps.db, userId, now);
        await logStaffAccess(deps.db, { staffId, kind: "view", action: "account.view", subjectType: "account", subjectId: userId }, now);
        return json(detail);
      }
      if (n === 3 && parts[2] === "state" && m === "PUT") {
        const req = await body(request, schemas.StaffSetStateRequest);
        await setAccountState(deps.db, staffId, userId, req.state, req.reasonCode, now);
        await deps.onAccountChange?.(userId, req.state);
        return json({ ok: true });
      }
      if (n === 3 && parts[2] === "age-review" && m === "POST") {
        return await resolveAgeReview(deps, staffId, userId, await body(request, schemas.StaffResolveAgeReviewRequest), now);
      }
    }

    if (parts[0] === "flags" && n === 1) {
      if (m === "GET") {
        await logStaffAccess(deps.db, { staffId, kind: "view", action: "flags.list", subjectType: "flag", subjectId: "all" }, now);
        const { results } = await deps.db
          .prepare("SELECT module, region, enabled, config, updated_by, updated_at FROM safety_flags ORDER BY module, region")
          .all<{ module: string; region: string; enabled: number; config: string; updated_by: string; updated_at: number }>();
        return json(
          results.map((r) => ({
            module: r.module,
            region: r.region,
            enabled: r.enabled === 1,
            config: JSON.parse(r.config) as unknown,
            updatedBy: r.updated_by,
            updatedAt: r.updated_at,
          })),
        );
      }
      if (m === "PUT") {
        const req = await body(request, schemas.StaffSetFlagRequest);
        await setFlag(deps.db, staffId, req.module, req.region, { enabled: req.enabled, config: req.config }, now);
        deps.flags.invalidate();
        return json({ ok: true });
      }
    }

    if (parts[0] === "holds") {
      if (n === 1 && m === "GET") {
        const subjectType = schemas.HoldSubjectType.safeParse(url.searchParams.get("subjectType"));
        const subjectId = url.searchParams.get("subjectId");
        if (!subjectType.success || !subjectId) throw new HttpError(400, "invalid_request");
        await logStaffAccess(deps.db, { staffId, kind: "view", action: "holds.list", subjectType: subjectType.data, subjectId }, now);
        const { results } = await deps.db
          .prepare(
            "SELECT id, subject_type, subject_id, reason_code, reference, created_by, created_at, released_at FROM legal_holds WHERE subject_type = ? AND subject_id = ? ORDER BY created_at DESC",
          )
          .bind(subjectType.data, subjectId)
          .all<Record<string, unknown>>();
        return json(results.map(holdView));
      }
      if (n === 1 && m === "POST") {
        const req = await body(request, schemas.StaffPlaceHoldRequest);
        // A report hold is kept as "serverId:reportId" so releasing it can find the Server object.
        let subjectId = req.subjectId;
        if (req.subjectType === "report") {
          if (!req.serverId || !deps.setReportHold) throw new HttpError(400, "server_id_required");
          if (!(await deps.setReportHold(req.serverId, req.subjectId, true))) throw new HttpError(404, "not_found");
          subjectId = `${req.serverId}:${req.subjectId}`;
        }
        const holdId = await placeHold(deps.db, staffId, req.subjectType, subjectId, req.reasonCode, req.reference, now);
        return json({ id: holdId }, 201);
      }
      if (n === 2 && m === "DELETE") {
        const holdId = id(parts[1]);
        const hold = await deps.db
          .prepare("SELECT subject_type, subject_id FROM legal_holds WHERE id = ? AND released_at IS NULL")
          .bind(holdId)
          .first<{ subject_type: schemas.HoldSubjectType; subject_id: string }>();
        await releaseHold(deps.db, staffId, holdId, now);
        // The report stays protected until its last hold is gone.
        if (hold?.subject_type === "report" && deps.setReportHold && !(await isHeld(deps.db, "report", hold.subject_id))) {
          const [serverId, reportId] = hold.subject_id.split(":") as [string, string];
          await deps.setReportHold(serverId, reportId, false);
        }
        return json({ ok: true });
      }
    }

    if (parts[0] === "log" && n === 1 && m === "GET") {
      const subjectType = url.searchParams.get("subjectType");
      const subjectId = url.searchParams.get("subjectId");
      if (!subjectType || !subjectId) throw new HttpError(400, "invalid_request");
      await logStaffAccess(deps.db, { staffId, kind: "view", action: "log.view", subjectType, subjectId }, now);
      const { results } = await deps.db
        .prepare("SELECT staff_id, kind, action, reason_code, at FROM staff_access_log WHERE subject_type = ? AND subject_id = ? ORDER BY at DESC LIMIT 200")
        .bind(subjectType, subjectId)
        .all<{ staff_id: string; kind: string; action: string; reason_code: string | null; at: number }>();
      return json(results.map((r) => ({ staffId: r.staff_id, kind: r.kind, action: r.action, reasonCode: r.reason_code, at: r.at })));
    }

    return json({ error: "not_found" }, 404);
  } catch (err) {
    if (err instanceof HttpError || err instanceof AuthError) return json({ error: err.code }, err.status);
    throw err;
  }
}

function holdView(r: Record<string, unknown>) {
  return {
    id: r.id,
    subjectType: r.subject_type,
    subjectId: r.subject_id,
    reasonCode: r.reason_code,
    reference: r.reference,
    createdBy: r.created_by,
    createdAt: r.created_at,
    releasedAt: r.released_at,
  };
}

/** Accounts in any state but active, or active ones carrying live age signals. No email. */
async function listAccounts(db: D1Database, state: schemas.AccountState | undefined, limit: number, now: number) {
  const where = state ? "u.account_state = ?1" : "(u.account_state != 'active' OR COALESCE(s.weight, 0) > 0)";
  const { results } = await db
    .prepare(
      `SELECT u.id, u.account_state, u.state_reason, u.state_changed_at, u.age_band, u.age_method, u.country, COALESCE(s.weight, 0) AS signal_weight
       FROM users u
       LEFT JOIN (SELECT user_id, SUM(weight) AS weight FROM age_signals WHERE expires_at > ?2 GROUP BY user_id) s ON s.user_id = u.id
       WHERE ${where}
       ORDER BY COALESCE(u.state_changed_at, 0) DESC, u.id
       LIMIT ?3`,
    )
    .bind(state ?? null, now, limit)
    .all<{
      id: string;
      account_state: string;
      state_reason: string | null;
      state_changed_at: number | null;
      age_band: string;
      age_method: string | null;
      country: string | null;
      signal_weight: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    accountState: r.account_state,
    stateReason: r.state_reason,
    stateChangedAt: r.state_changed_at,
    ageBand: r.age_band,
    ageMethod: r.age_method,
    country: r.country,
    signalWeight: r.signal_weight,
  }));
}

async function accountDetail(db: D1Database, userId: string, now: number) {
  const user = await db
    .prepare("SELECT id, email, created_at, account_state, state_reason, state_changed_at, age_band, age_method, age_band_until, country FROM users WHERE id = ?")
    .bind(userId)
    .first<Record<string, unknown>>();
  if (!user) throw new HttpError(404, "not_found");
  const signals = await db
    .prepare("SELECT kind, weight, created_at, expires_at FROM age_signals WHERE user_id = ? AND expires_at > ? ORDER BY created_at DESC")
    .bind(userId, now)
    .all<{ kind: string; weight: number; created_at: number; expires_at: number }>();
  const holds = await db
    .prepare(
      "SELECT id, subject_type, subject_id, reason_code, reference, created_by, created_at, released_at FROM legal_holds WHERE subject_type = 'account' AND subject_id = ? ORDER BY created_at DESC",
    )
    .bind(userId)
    .all<Record<string, unknown>>();
  return {
    id: user.id,
    email: user.email,
    createdAt: user.created_at,
    accountState: user.account_state,
    stateReason: user.state_reason,
    stateChangedAt: user.state_changed_at,
    ageBand: user.age_band,
    ageMethod: user.age_method,
    ageBandUntil: user.age_band_until,
    country: user.country,
    signals: signals.results.map((s) => ({ kind: s.kind, weight: s.weight, createdAt: s.created_at, expiresAt: s.expires_at })),
    holds: holds.results.map(holdView),
    held: await isHeld(db, "account", userId),
  };
}

async function resolveAgeReview(
  deps: StaffRouteDeps,
  staffId: string,
  userId: string,
  req: schemas.StaffResolveAgeReviewRequest,
  now: number,
): Promise<Response> {
  const user = await deps.db.prepare("SELECT account_state FROM users WHERE id = ?").bind(userId).first<{ account_state: schemas.AccountState }>();
  if (!user) throw new HttpError(404, "not_found");
  if (user.account_state !== "pending_age_review") throw new HttpError(409, "not_under_review");

  if (req.outcome === "cleared") {
    // A stronger check showed 18 or over: record it as verified so later signals are ignored, and end the review.
    await applyVerifiedAge(deps.db, deps.flags, userId, "18plus", null, "verified", now);
    await logStaffAccess(deps.db, { staffId, kind: "change", action: "age_review.cleared", subjectType: "account", subjectId: userId, reasonCode: "underage" }, now);
    await deps.onAccountChange?.(userId, "active");
  } else {
    const state: schemas.AccountState = req.outcome === "restrict" ? "restricted" : "underage_removed";
    await setAccountState(deps.db, staffId, userId, state, "underage", now);
    await deps.onAccountChange?.(userId, state);
  }
  return json({ ok: true });
}
