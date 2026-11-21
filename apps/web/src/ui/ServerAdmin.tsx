import { Permission, type schemas } from "@bastion/shared";
import { useCallback, useEffect, useState } from "react";
import type { AppState, Controller } from "../lib/controller.js";
import { ApiError } from "../lib/http.js";
import { shortId } from "./Shell.js";

export const REPORT_CATEGORIES: Record<schemas.ReportCategory, string> = {
  spam: "Spam",
  harassment: "Harassment",
  hate: "Hate",
  sexual: "Sexual content",
  violence: "Violence",
  self_harm: "Self-harm",
  illegal: "Illegal content",
  underage: "Under 18",
  other: "Something else",
};

const PERMISSION_LABELS: Record<keyof typeof Permission, string> = {
  VIEW_CHANNEL: "View channels",
  SEND_MESSAGES: "Send messages",
  ATTACH_FILES: "Attach files",
  MANAGE_MESSAGES: "Manage messages and reports",
  CONNECT_VOICE: "Join voice",
  SPEAK: "Speak",
  MUTE_MEMBERS: "Mute members",
  KICK: "Remove members",
  BAN: "Ban members",
  TIMEOUT: "Time members out",
  MANAGE_CHANNELS: "Manage channels",
  MANAGE_ROLES: "Manage roles",
  CREATE_INVITE: "Create invites",
  VIEW_AUDIT_LOG: "View the audit log",
  ADMINISTRATOR: "Administrator (everything)",
  STREAM: "Share screen",
};

const AUDIT_LABELS: Record<schemas.AuditAction, string> = {
  "server.update": "Changed the server",
  "channel.create": "Created a channel",
  "channel.update": "Changed a channel",
  "channel.delete": "Deleted a channel",
  "channel.slow_mode": "Changed slow mode",
  "override.put": "Set a channel permission",
  "override.delete": "Removed a channel permission",
  "role.create": "Created a role",
  "role.update": "Changed a role",
  "role.delete": "Deleted a role",
  "member.role.add": "Gave a role",
  "member.role.remove": "Took a role away",
  "member.kick": "Removed a member",
  "member.ban": "Banned a member",
  "member.unban": "Unbanned a member",
  "member.timeout": "Timed a member out",
  "member.timeout.remove": "Ended a timeout",
  "message.delete": "Deleted a message",
  "invite.delete": "Deleted an invite",
  "report.update": "Handled a report",
  "voice.end_stream": "Ended a screen share",
  "voice.disconnect": "Disconnected someone from voice",
};

const ERROR_TEXT: Record<string, string> = {
  missing_permissions: "You do not have permission to do that.",
  rate_limited: "Too many requests. Please wait a moment.",
  unknown_member: "That person is no longer in this server.",
  role_hierarchy: "That person or role is above yours.",
};

export function errorText(err: unknown): string {
  const code = err instanceof ApiError ? err.code : err instanceof Error ? err.message : "";
  return ERROR_TEXT[code] ?? "Something went wrong. Please try again.";
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/** Load something on mount and on demand. */
function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(() => {
    setLoading(true);
    load().then(
      (value) => {
        setData(value);
        setError(null);
        setLoading(false);
      },
      (err) => {
        setError(errorText(err));
        setLoading(false);
      },
    );
  }, deps);
  useEffect(run, [run]);
  return { data, setData, error, loading, reload: run };
}

type Tab = "reports" | "roles" | "bans" | "audit";

/** The tabs this person may use in a server. */
export function adminTabs(controller: Controller, serverId: string): Tab[] {
  const tabs: Tab[] = [];
  if (controller.canServer(serverId, Permission.MANAGE_MESSAGES)) tabs.push("reports");
  if (controller.canServer(serverId, Permission.MANAGE_ROLES)) tabs.push("roles");
  if (controller.canServer(serverId, Permission.BAN)) tabs.push("bans");
  if (controller.canServer(serverId, Permission.VIEW_AUDIT_LOG)) tabs.push("audit");
  return tabs;
}

const TAB_LABELS: Record<Tab, string> = { reports: "Reports", roles: "Roles", bans: "Bans", audit: "Audit log" };

export function ServerAdmin({ controller, state, serverId }: { controller: Controller; state: AppState; serverId: string }) {
  const server = state.chat.servers[serverId];
  const tabs = adminTabs(controller, serverId);
  const [tab, setTab] = useState<Tab | null>(tabs[0] ?? null);
  const active = tab && tabs.includes(tab) ? tab : (tabs[0] ?? null);
  if (!server) return <p className="empty">This server is gone.</p>;
  if (!active) return <p className="empty">You do not have any moderation tools in this server.</p>;
  return (
    <section className="admin">
      <header>
        <h2>{server.server.name}: moderation</h2>
      </header>
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t} role="tab" aria-selected={t === active} className={t === active ? "active" : ""} onClick={() => setTab(t)}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>
      <div className="admin-body">
        {active === "reports" && <Reports controller={controller} state={state} serverId={serverId} />}
        {active === "roles" && <Roles controller={controller} state={state} serverId={serverId} />}
        {active === "bans" && <Bans controller={controller} serverId={serverId} />}
        {active === "audit" && <AuditLog controller={controller} serverId={serverId} />}
      </div>
    </section>
  );
}

function Problem({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <p role="alert" className="error">
      {error}{" "}
      <button className="link" onClick={onRetry}>
        Try again
      </button>
    </p>
  );
}

// ------------------------------------------------------------------ reports

function Reports({ controller, state, serverId }: { controller: Controller; state: AppState; serverId: string }) {
  const [status, setStatus] = useState<schemas.ReportStatus>("open");
  const { data, setData, error, loading, reload } = useLoad(() => controller.reports(serverId, status), [controller, serverId, status]);
  const [problem, setProblem] = useState<string | null>(null);
  const server = state.chat.servers[serverId];

  async function mark(report: schemas.Report, next: schemas.ReportStatus) {
    setProblem(null);
    try {
      await controller.setReportStatus(serverId, report.id, next);
      // Drop it from this list: it now belongs to another status.
      setData((list) => (list ?? []).filter((r) => r.id !== report.id));
    } catch (err) {
      setProblem(errorText(err));
    }
  }

  return (
    <>
      <div className="toolbar">
        <label>
          Show{" "}
          <select value={status} onChange={(e) => setStatus(e.target.value as schemas.ReportStatus)}>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="dismissed">Dismissed</option>
          </select>
        </label>
        <button onClick={reload}>Refresh</button>
      </div>
      <p className="hint">Reports include only the messages the reporter chose. The reporter&apos;s name is not shown.</p>
      {error && <Problem error={error} onRetry={reload} />}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {loading && !data && <p className="empty">Loading…</p>}
      {data && data.length === 0 && <p className="empty">No {status} reports.</p>}
      <ul className="cards">
        {(data ?? []).map((r) => (
          <li key={r.id} className="card">
            <div className="card-head">
              <b>{REPORT_CATEGORIES[r.category]}</b>
              <span>
                # {server?.channels[r.channelId]?.name ?? "deleted channel"} · {formatTime(r.createdAt)}
              </span>
            </div>
            {r.note && <p className="note">{r.note}</p>}
            <ol className="reported">
              {r.messages.map((m) => (
                <li key={m.id}>
                  <b>{shortId(m.authorId)}</b> <time>{formatTime(m.createdAt)}</time>
                  <p>{m.content}</p>
                </li>
              ))}
            </ol>
            <div className="controls">
              {r.status === "open" ? (
                <>
                  <button onClick={() => void mark(r, "resolved")}>Resolve</button>
                  <button onClick={() => void mark(r, "dismissed")}>Dismiss</button>
                </>
              ) : (
                <button onClick={() => void mark(r, "open")}>Reopen</button>
              )}
            </div>
            <p className="hint">To act on the people involved, use Manage next to their name in the member list.</p>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ roles

function Roles({ controller, state, serverId }: { controller: Controller; state: AppState; serverId: string }) {
  const server = state.chat.servers[serverId];
  const roles = Object.values(server?.roles ?? {}).sort((a, b) => b.position - a.position || a.name.localeCompare(b.name));
  const [selected, setSelected] = useState<string | "new" | null>(roles[0]?.id ?? null);
  if (!server) return null;
  const role = selected && selected !== "new" ? server.roles[selected] : undefined;
  return (
    <div className="roles">
      <ul className="role-list" aria-label="Roles">
        {roles.map((r) => (
          <li key={r.id}>
            <button className={selected === r.id ? "active" : ""} onClick={() => setSelected(r.id)}>
              {r.id === serverId ? "@everyone" : r.name}
            </button>
          </li>
        ))}
        <li>
          <button className={selected === "new" ? "active" : ""} onClick={() => setSelected("new")}>
            + New role
          </button>
        </li>
      </ul>
      <div className="role-editor">
        {selected === "new" && (
          <RoleForm
            key="new"
            controller={controller}
            serverId={serverId}
            onSaved={(id) => setSelected(id ?? null)}
          />
        )}
        {role && (
          <RoleForm
            key={role.id}
            controller={controller}
            serverId={serverId}
            role={role}
            isEveryone={role.id === serverId}
            onSaved={(id) => setSelected(id ?? roles.find((r) => r.id !== role.id)?.id ?? null)}
          />
        )}
        {!role && selected !== "new" && <p className="empty">Pick a role.</p>}
      </div>
    </div>
  );
}

function RoleForm(props: {
  controller: Controller;
  serverId: string;
  role?: schemas.Role;
  isEveryone?: boolean;
  /** Called with the new role id after create, or undefined after delete. */
  onSaved: (id?: string) => void;
}) {
  const { controller, serverId, role } = props;
  const [name, setName] = useState(role?.name ?? "");
  const [perms, setPerms] = useState<bigint>(role ? BigInt(role.permissions) : Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A change from elsewhere (gateway) while nothing is being edited should show up.
  const savedPerms = role?.permissions;
  useEffect(() => {
    if (savedPerms !== undefined) setPerms(BigInt(savedPerms));
  }, [savedPerms]);

  const toggle = (flag: bigint) => setPerms((p) => (p & flag) === flag ? p & ~flag : p | flag);
  const dirty = !role || perms !== BigInt(role.permissions) || (!props.isEveryone && name.trim() !== role.name);
  const valid = props.isEveryone || name.trim().length > 0;

  async function save() {
    setBusy(true);
    setProblem(null);
    const result = role
      ? await controller.updateRole(serverId, role.id, { ...(props.isEveryone ? {} : { name: name.trim() }), permissions: perms })
      : await controller.createRole(serverId, name.trim(), perms);
    setBusy(false);
    if (result === undefined) setProblem("Could not save. You may not have permission to change this role.");
    else if (!role) props.onSaved((result as schemas.Role).id);
  }

  async function remove() {
    if (!role) return;
    setBusy(true);
    const result = await controller.deleteRole(serverId, role.id);
    setBusy(false);
    if (result === undefined && controller.getState().error) setProblem("Could not delete this role.");
    else props.onSaved();
  }

  return (
    <form
      className="role-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && dirty) void save();
      }}
    >
      <h3>{role ? (props.isEveryone ? "@everyone" : role.name) : "New role"}</h3>
      {props.isEveryone ? (
        <p className="hint">Everyone in the server has these permissions. Other roles add to them.</p>
      ) : (
        <label>
          Name
          <input value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        </label>
      )}
      <fieldset>
        <legend>Permissions</legend>
        {(Object.keys(Permission) as (keyof typeof Permission)[]).map((key) => (
          <label key={key} className="check">
            <input type="checkbox" checked={(perms & Permission[key]) === Permission[key]} onChange={() => toggle(Permission[key])} />
            <span>{PERMISSION_LABELS[key]}</span>
          </label>
        ))}
      </fieldset>
      {(perms & Permission.ADMINISTRATOR) !== 0n && <p className="hint">Administrators can do everything in the server, including everything above.</p>}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      <div className="controls">
        <button disabled={busy || !valid || !dirty}>{role ? "Save changes" : "Create role"}</button>
        {role && !props.isEveryone && !confirmDelete && (
          <button type="button" onClick={() => setConfirmDelete(true)}>
            Delete role…
          </button>
        )}
        {confirmDelete && (
          <>
            <button type="button" disabled={busy} onClick={() => void remove()}>
              Yes, delete this role
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)}>
              Keep it
            </button>
          </>
        )}
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ bans

function Bans({ controller, serverId }: { controller: Controller; serverId: string }) {
  const { data, setData, error, loading, reload } = useLoad(() => controller.bans(serverId), [controller, serverId]);
  const [problem, setProblem] = useState<string | null>(null);
  async function unban(userId: string) {
    setProblem(null);
    await controller.unban(serverId, userId);
    if (controller.getState().error) setProblem("Could not unban. Please try again.");
    else setData((list) => (list ?? []).filter((b) => b.userId !== userId));
  }
  return (
    <>
      <div className="toolbar">
        <button onClick={reload}>Refresh</button>
      </div>
      {error && <Problem error={error} onRetry={reload} />}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {loading && !data && <p className="empty">Loading…</p>}
      {data && data.length === 0 && <p className="empty">Nobody is banned.</p>}
      <ul className="cards">
        {(data ?? []).map((b) => (
          <li key={b.userId} className="card">
            <div className="card-head">
              <b>{shortId(b.userId)}</b>
              <span>{formatTime(b.createdAt)}</span>
            </div>
            <p>{b.reason ?? "No reason given."}</p>
            {b.createdBy && <p className="hint">Banned by {shortId(b.createdBy)}</p>}
            <div className="controls">
              <button onClick={() => void unban(b.userId)}>Unban</button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ audit log

function details(e: schemas.AuditLogEntry): string {
  const parts: string[] = [];
  if (e.reasonCode) parts.push(e.reasonCode.replace(/_/g, " "));
  if (e.reason) parts.push(e.reason);
  const d = e.data;
  if (typeof d.until === "number") parts.push(`until ${formatTime(d.until)}`);
  if (typeof d.seconds === "number") parts.push(`${d.seconds}s`);
  if (typeof d.deletedMessages === "number" && d.deletedMessages > 0) parts.push(`${d.deletedMessages} messages deleted`);
  if (typeof d.name === "string") parts.push(d.name);
  return parts.join(" · ");
}

function AuditLog({ controller, serverId }: { controller: Controller; serverId: string }) {
  const [action, setAction] = useState<schemas.AuditAction | "">("");
  const { data, setData, error, loading, reload } = useLoad(
    () => controller.auditLog(serverId, action ? { action } : {}),
    [controller, serverId, action],
  );
  const [more, setMore] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const last = data?.[data.length - 1];

  async function loadMore() {
    if (!last) return;
    setMore(true);
    setProblem(null);
    try {
      const next = await controller.auditLog(serverId, { ...(action ? { action } : {}), before: last.id });
      setData((list) => [...(list ?? []), ...next]);
    } catch (err) {
      setProblem(errorText(err));
    }
    setMore(false);
  }

  return (
    <>
      <div className="toolbar">
        <label>
          Show{" "}
          <select value={action} onChange={(e) => setAction(e.target.value as schemas.AuditAction | "")}>
            <option value="">Everything</option>
            {(Object.keys(AUDIT_LABELS) as schemas.AuditAction[]).map((a) => (
              <option key={a} value={a}>
                {AUDIT_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        <button onClick={reload}>Refresh</button>
      </div>
      <p className="hint">Entries are kept for 90 days.</p>
      {error && <Problem error={error} onRetry={reload} />}
      {problem && (
        <p role="alert" className="error">
          {problem}
        </p>
      )}
      {loading && !data && <p className="empty">Loading…</p>}
      {data && data.length === 0 && <p className="empty">Nothing in the log yet.</p>}
      <ol className="audit">
        {(data ?? []).map((e) => (
          <li key={e.id}>
            <time>{formatTime(e.createdAt)}</time>
            <p>
              <b>{shortId(e.actorId)}</b> {AUDIT_LABELS[e.action].toLowerCase()}
              {e.targetId && <> ({e.targetId.length > 12 ? shortId(e.targetId) : e.targetId})</>}
            </p>
            {details(e) && <p className="hint">{details(e)}</p>}
          </li>
        ))}
      </ol>
      {data && data.length > 0 && data.length % 50 === 0 && (
        <button disabled={more} onClick={() => void loadMore()}>
          Load older entries
        </button>
      )}
    </>
  );
}
