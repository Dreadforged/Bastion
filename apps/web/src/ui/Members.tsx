import { Permission, type schemas } from "@bastion/shared";
import { useState } from "react";
import type { AppState, Controller } from "../lib/controller.js";
import { formatTime } from "./ServerAdmin.js";
import { shortId } from "./Shell.js";

const TIMEOUTS: { label: string; seconds: number }[] = [
  { label: "1 minute", seconds: 60 },
  { label: "10 minutes", seconds: 600 },
  { label: "1 hour", seconds: 3600 },
  { label: "1 day", seconds: 86_400 },
  { label: "1 week", seconds: 604_800 },
];

const BAN_DELETES: { label: string; seconds: number }[] = [
  { label: "Keep their messages", seconds: 0 },
  { label: "Delete the last hour", seconds: 3600 },
  { label: "Delete the last day", seconds: 86_400 },
  { label: "Delete the last 7 days", seconds: 604_800 },
];

/** The member list, with moderation tools for people who have them. */
export function MemberList(props: {
  controller: Controller;
  state: AppState;
  serverId: string;
  onMessage: (userId: string) => void;
}) {
  const { controller, state, serverId } = props;
  const server = state.chat.servers[serverId]!;
  const members = Object.values(server.members);
  const [open, setOpen] = useState<string | null>(null);
  const me = state.chat.userId;
  const can = (flag: bigint) => controller.canServer(serverId, flag);
  const canManageAny = can(Permission.KICK) || can(Permission.BAN) || can(Permission.TIMEOUT) || can(Permission.MANAGE_ROLES);
  const now = Date.now();

  return (
    <>
      <h3>Members ({members.length})</h3>
      <ul className="member-list">
        {members.map((m) => {
          const status = server.presences[m.userId] ?? "offline";
          const timedOut = m.timeoutUntil !== null && m.timeoutUntil > now;
          const isMe = m.userId === me;
          const isOwner = m.userId === server.server.ownerId;
          const manageable = canManageAny && !isMe && !isOwner;
          const expanded = open === m.userId;
          return (
            <li key={m.userId} className={status}>
              <span className="dot" aria-label={status} />
              {m.nick ?? shortId(m.userId)}
              {isOwner && <small> owner</small>}
              {timedOut && <small> timed out</small>}
              {!isMe && (
                <button className="link" onClick={() => props.onMessage(m.userId)}>
                  Message
                </button>
              )}
              {manageable && (
                <button className="link" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : m.userId)}>
                  {expanded ? "Close" : "Manage"}
                </button>
              )}
              {expanded && <MemberTools controller={controller} state={state} serverId={serverId} member={m} onDone={() => setOpen(null)} />}
            </li>
          );
        })}
      </ul>
    </>
  );
}

type Mode = "menu" | "timeout" | "kick" | "ban";

function MemberTools(props: { controller: Controller; state: AppState; serverId: string; member: schemas.Member; onDone: () => void }) {
  const { controller, serverId, member } = props;
  const server = props.state.chat.servers[serverId]!;
  const [mode, setMode] = useState<Mode>("menu");
  const [seconds, setSeconds] = useState(TIMEOUTS[2]!.seconds);
  const [deleteSeconds, setDeleteSeconds] = useState(0);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const can = (flag: bigint) => controller.canServer(serverId, flag);
  const timedOut = member.timeoutUntil !== null && member.timeoutUntil > Date.now();
  const roles = Object.values(server.roles)
    .filter((r) => r.id !== serverId)
    .sort((a, b) => b.position - a.position);
  const name = member.nick ?? shortId(member.userId);
  const why = reason.trim() || undefined;

  async function run(action: () => Promise<unknown>, done = true) {
    setBusy(true);
    setProblem(null);
    await action();
    setBusy(false);
    // The controller keeps the last error; it shows in the sidebar. Close only on success.
    if (controller.getState().error) setProblem("That did not work. You may not be allowed to act on this person.");
    else if (done) props.onDone();
  }

  const reasonField = (
    <label>
      Reason (shown in the audit log)
      <input value={reason} maxLength={512} onChange={(e) => setReason(e.target.value)} />
    </label>
  );

  return (
    <div className="member-tools" role="group" aria-label={`Manage ${name}`}>
      {mode === "menu" && (
        <>
          {can(Permission.MANAGE_ROLES) && roles.length > 0 && (
            <fieldset>
              <legend>Roles</legend>
              {roles.map((r) => (
                <label key={r.id} className="check">
                  <input
                    type="checkbox"
                    checked={member.roles.includes(r.id)}
                    disabled={busy}
                    onChange={(e) => void run(() => controller.setMemberRole(serverId, member.userId, r.id, e.target.checked), false)}
                  />
                  <span>{r.name}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="controls">
            {can(Permission.TIMEOUT) &&
              (timedOut ? (
                <button disabled={busy} onClick={() => void run(() => controller.removeTimeout(serverId, member.userId))}>
                  End timeout
                </button>
              ) : (
                <button onClick={() => setMode("timeout")}>Timeout…</button>
              ))}
            {can(Permission.KICK) && <button onClick={() => setMode("kick")}>Kick…</button>}
            {can(Permission.BAN) && <button onClick={() => setMode("ban")}>Ban…</button>}
          </div>
          {timedOut && member.timeoutUntil !== null && <small>Timed out until {formatTime(member.timeoutUntil)}</small>}
        </>
      )}
      {mode === "timeout" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => controller.timeout(serverId, member.userId, seconds, why));
          }}
        >
          <label>
            Length
            <select value={seconds} onChange={(e) => setSeconds(Number(e.target.value))}>
              {TIMEOUTS.map((t) => (
                <option key={t.seconds} value={t.seconds}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          {reasonField}
          <p className="hint">{name} can read but not send messages, join voice or react until it ends.</p>
          <div className="controls">
            <button disabled={busy}>Time {name} out</button>
            <button type="button" onClick={() => setMode("menu")}>
              Back
            </button>
          </div>
        </form>
      )}
      {mode === "kick" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => controller.kick(serverId, member.userId, why));
          }}
        >
          <p>Remove {name} from the server? They can join again with a new invite.</p>
          {reasonField}
          <div className="controls">
            <button disabled={busy}>Yes, kick {name}</button>
            <button type="button" onClick={() => setMode("menu")}>
              Back
            </button>
          </div>
        </form>
      )}
      {mode === "ban" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => controller.ban(serverId, member.userId, { ...(why ? { reason: why } : {}), deleteMessageSeconds: deleteSeconds }));
          }}
        >
          <p>Ban {name}? They are removed and cannot rejoin until you unban them.</p>
          <label>
            Their messages
            <select value={deleteSeconds} onChange={(e) => setDeleteSeconds(Number(e.target.value))}>
              {BAN_DELETES.map((d) => (
                <option key={d.seconds} value={d.seconds}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          {reasonField}
          <div className="controls">
            <button disabled={busy}>Yes, ban {name}</button>
            <button type="button" onClick={() => setMode("menu")}>
              Back
            </button>
          </div>
        </form>
      )}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
    </div>
  );
}
