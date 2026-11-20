import { Permission, type schemas } from "@bastion/shared";
import { useEffect, useRef, useState } from "react";
import type { AppState, Controller } from "../lib/controller.js";
import { sortedChannels, typingUsers } from "../lib/store.js";
import { ErrorBoundary } from "./ErrorBoundary.js";
import { Settings } from "./Settings.js";
import { CallAlerts, CallBar, VoiceParticipants, voiceErrorText } from "./Voice.js";

/** Short stand-in for a user id until profiles exist. */
export function shortId(userId: string): string {
  return userId.slice(-6).toLowerCase();
}

type View = { kind: "channel"; serverId: string; channelId: string } | { kind: "dm"; conversationId: string } | { kind: "settings" } | { kind: "none" };

export function Shell({ controller, state }: { controller: Controller; state: AppState }) {
  const [serverId, setServerId] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "none" });
  const servers = Object.values(state.chat.servers);
  const server = serverId ? state.chat.servers[serverId] : undefined;

  // Leave a server that went away (deleted, kicked, left).
  useEffect(() => {
    if (serverId && !state.chat.servers[serverId]) {
      setServerId(null);
      setView({ kind: "none" });
    }
  }, [serverId, state.chat.servers]);

  function pickChannel(sid: string, cid: string) {
    setView({ kind: "channel", serverId: sid, channelId: cid });
    void controller.openChannel(sid, cid);
  }

  return (
    <div className="shell">
      <nav className="rail" aria-label="Servers">
        <button className={serverId === null ? "active" : ""} title="Direct messages" onClick={() => setServerId(null)}>
          DM
        </button>
        {servers.map((s) => (
          <button key={s.server.id} className={serverId === s.server.id ? "active" : ""} title={s.server.name} onClick={() => setServerId(s.server.id)}>
            {s.server.name.slice(0, 2).toUpperCase()}
          </button>
        ))}
        <button
          title="Create a server"
          onClick={() => {
            const name = prompt("Server name");
            if (name) void controller.createServer(name);
          }}
        >
          +
        </button>
        <button
          title="Join with an invite code"
          onClick={() => {
            const code = prompt("Invite code");
            if (code) void controller.joinInvite(code.trim());
          }}
        >
          Join
        </button>
        <button title="Privacy and data" onClick={() => setView({ kind: "settings" })}>
          Privacy
        </button>
        <button className="signout" onClick={() => void controller.signOut()}>
          Sign out
        </button>
      </nav>

      <aside className="sidebar">
        {server ? (
          <>
            <h2>{server.server.name}</h2>
            <ChannelList controller={controller} serverId={server.server.id} state={state} view={view} onPick={pickChannel} />
          </>
        ) : (
          <DmList controller={controller} state={state} view={view} onOpen={(conversationId) => setView({ kind: "dm", conversationId })} />
        )}
        <CallAlerts controller={controller} state={state} />
        {state.voice && <CallBar controller={controller} ui={state.voice} />}
        {state.error && (
          <p role="alert" className="error">
            {voiceErrorText(state.error)}
          </p>
        )}
        <p className={`status ${state.gateway}`}>{state.gateway === "ready" ? "Connected" : "Reconnecting…"}</p>
      </aside>

      <main className="content">
        <ErrorBoundary key={JSON.stringify(view)}>
          {view.kind === "channel" && <ChannelView controller={controller} state={state} serverId={view.serverId} channelId={view.channelId} />}
          {view.kind === "dm" && <DmView controller={controller} state={state} conversationId={view.conversationId} />}
          {view.kind === "settings" && <Settings controller={controller} />}
          {view.kind === "none" && <p className="empty">Pick a channel or a conversation.</p>}
        </ErrorBoundary>
      </main>

      {server && (
        <aside className="members">
          <h3>Members ({Object.keys(server.members).length})</h3>
          <ul>
            {Object.values(server.members).map((m) => {
              const status = server.presences[m.userId] ?? "offline";
              return (
                <li key={m.userId} className={status}>
                  <span className="dot" aria-label={status} />
                  {m.nick ?? shortId(m.userId)}
                  {m.userId !== state.chat.userId && (
                    <button
                      className="link"
                      onClick={async () => {
                        const id = await controller.openDm(m.userId);
                        if (id) {
                          setServerId(null);
                          setView({ kind: "dm", conversationId: id });
                        }
                      }}
                    >
                      Message
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <button
            onClick={async () => {
              const invite = await controller.createInvite(server.server.id);
              if (invite) prompt("Share this invite code", invite.code);
            }}
          >
            Invite people
          </button>
        </aside>
      )}
    </div>
  );
}

function ChannelList(props: {
  controller: Controller;
  serverId: string;
  state: AppState;
  view: View;
  onPick: (serverId: string, channelId: string) => void;
}) {
  const server = props.state.chat.servers[props.serverId]!;
  const text = sortedChannels(server, "text");
  const voice = sortedChannels(server, "voice");
  const anyChannel = text[0] ?? voice[0];
  const canManage = anyChannel
    ? props.controller.can(props.serverId, anyChannel.id, Permission.MANAGE_CHANNELS)
    : server.server.ownerId === props.state.chat.userId;
  return (
    <>
      <h3>Text</h3>
      <ul>
        {text.map((c) => (
          <li key={c.id}>
            <button
              className={props.view.kind === "channel" && props.view.channelId === c.id ? "active" : ""}
              onClick={() => props.onPick(props.serverId, c.id)}
            >
              # {c.name}
            </button>
          </li>
        ))}
      </ul>
      <h3>Voice</h3>
      <ul>
        {voice.map((c) => {
          const inCall = Object.values(server.voice).filter((v) => v.channelId === c.id);
          return (
            <li key={c.id}>
              <span className="voice">{c.name}</span>
              {inCall.length > 0 && <small> {inCall.length} in call</small>}
              {props.state.voice?.channelId === c.id ? (
                <button className="link" onClick={() => void props.controller.leaveVoice()}>
                  Leave
                </button>
              ) : (
                <button
                  className="link"
                  disabled={props.state.voice !== null || !props.controller.can(props.serverId, c.id, Permission.CONNECT_VOICE)}
                  onClick={() => void props.controller.joinVoice(props.serverId, c.id)}
                >
                  Join
                </button>
              )}
              <VoiceParticipants voice={server.voice} channelId={c.id} me={props.state.chat.userId} />
            </li>
          );
        })}
      </ul>
      {canManage && (
        <button
          onClick={() => {
            const name = prompt("Channel name");
            if (name) void props.controller.createChannel(props.serverId, name, "text");
          }}
        >
          Add channel
        </button>
      )}
    </>
  );
}

function ChannelView({ controller, state, serverId, channelId }: { controller: Controller; state: AppState; serverId: string; channelId: string }) {
  const channel = state.chat.servers[serverId]?.channels[channelId];
  const messages = state.chat.messages[channelId] ?? [];
  const typing = typingUsers(state.chat, channelId, Date.now());
  const canSend = controller.can(serverId, channelId, Permission.SEND_MESSAGES);
  const canModerate = controller.can(serverId, channelId, Permission.MANAGE_MESSAGES);
  const me = state.chat.userId;
  const bottom = useRef<HTMLDivElement>(null);
  // Braces matter: an arrow returning scrollIntoView's result would hand React a non-function cleanup.
  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: "end" });
  }, [messages.length]);
  if (!channel) return <p className="empty">This channel is gone.</p>;

  return (
    <>
      <header>
        <h2># {channel.name}</h2>
      </header>
      <ol className="messages">
        {messages.map((m) => {
          const payload = state.plaintext[m.id];
          return (
            <li key={m.id}>
              <b>{shortId(m.authorId)}</b> <time>{new Date(m.createdAt).toLocaleTimeString()}</time>
              {m.editedAt !== null && <small> (edited)</small>}
              <p className={payload ? "" : "locked"}>{payload ? payload.text : "This device cannot read this message."}</p>
              {(m.authorId === me || canModerate) && (
                <button className="link" onClick={() => void controller.deleteMessage(serverId, channelId, m.id)}>
                  Delete
                </button>
              )}
            </li>
          );
        })}
        <div ref={bottom} />
      </ol>
      {typing.length > 0 && <p className="typing">{typing.map(shortId).join(", ")} typing…</p>}
      <Composer
        disabled={!canSend}
        placeholder={canSend ? `Message #${channel.name}` : "You cannot send messages here"}
        onTyping={() => void controller.sendTyping(serverId, channelId)}
        onSend={(text) => controller.sendMessage(serverId, channelId, text)}
      />
    </>
  );
}

function DmList({ controller, state, view, onOpen }: { controller: Controller; state: AppState; view: View; onOpen: (id: string) => void }) {
  const [requests, setRequests] = useState<schemas.MessageRequest[]>([]);
  useEffect(() => {
    controller.messageRequests().then(setRequests, () => setRequests([]));
  }, [controller, state.phase]);
  async function answer(r: schemas.MessageRequest, accept: boolean) {
    await (accept ? controller.acceptRequest(r) : controller.declineRequest(r));
    setRequests((list) => list.filter((x) => x.conversationId !== r.conversationId));
  }
  return (
    <>
      {requests.length > 0 && (
        <>
          <h2>Message requests</h2>
          <ul>
            {requests.map((r) => (
              <li key={r.conversationId}>
                {shortId(r.from)} wants to message you{" "}
                <button onClick={() => void answer(r, true)}>Accept</button> <button onClick={() => void answer(r, false)}>Decline</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2>Direct messages</h2>
      <ul>
        {Object.values(state.dms).map((d) => (
          <li key={d.conversationId}>
            <button className={view.kind === "dm" && view.conversationId === d.conversationId ? "active" : ""} onClick={() => onOpen(d.conversationId)}>
              {shortId(d.peerId)}
            </button>
          </li>
        ))}
      </ul>
      <p className="hint">Open a server and choose Message next to someone to start a private conversation.</p>
      <p className="hint">Encrypted conversations are kept in memory only, so they reset when you reload.</p>
    </>
  );
}

function DmView({ controller, state, conversationId }: { controller: Controller; state: AppState; conversationId: string }) {
  const dm = state.dms[conversationId];
  if (!dm) return <p className="empty">Loading…</p>;
  return (
    <>
      <header className="with-action">
        <h2>{shortId(dm.peerId)}</h2>
        <button disabled={state.voice !== null || dm.peerId === ""} onClick={() => void controller.callUser(dm.peerId)}>
          Call
        </button>
      </header>
      <ol className="messages">
        {dm.messages.map((m) => (
          <li key={m.seq}>
            <b>{shortId(m.senderId)}</b> <time>{new Date(m.createdAt).toLocaleTimeString()}</time>
            <p>{m.payload.text}</p>
          </li>
        ))}
      </ol>
      <Composer placeholder="Message" onSend={(text) => controller.sendDm(conversationId, text)} />
    </>
  );
}

function Composer(props: { disabled?: boolean; placeholder: string; onSend: (text: string) => Promise<void>; onTyping?: () => void }) {
  const [text, setText] = useState("");
  const lastTyping = useRef(0);
  return (
    <form
      className="composer"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text;
        setText("");
        void props.onSend(t);
      }}
    >
      <input
        disabled={props.disabled ?? false}
        value={text}
        placeholder={props.placeholder}
        maxLength={8000}
        onChange={(e) => {
          setText(e.target.value);
          const now = Date.now();
          if (props.onTyping && now - lastTyping.current > 5000) {
            lastTyping.current = now;
            props.onTyping();
          }
        }}
      />
      <button disabled={(props.disabled ?? false) || text.trim() === ""}>Send</button>
    </form>
  );
}
