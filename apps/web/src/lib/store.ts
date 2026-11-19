import { EventPayloads, type EventName, type ReadyPayload, type schemas } from "@bastion/shared";

export interface ServerState {
  server: schemas.Server;
  roles: Record<string, schemas.Role>;
  channels: Record<string, schemas.Channel>;
  members: Record<string, schemas.Member>;
  presences: Record<string, schemas.VisibleStatus>;
  /** userId to voice state; only people currently in a call. */
  voice: Record<string, schemas.VoiceState>;
}

export interface TypingEntry {
  userId: string;
  at: number;
}

export interface ChatState {
  userId: string | null;
  servers: Record<string, ServerState>;
  /** Messages by channel id, oldest first. */
  messages: Record<string, schemas.Message[]>;
  typing: Record<string, TypingEntry[]>;
  /** Conversations that have new envelopes: id to highest seq announced. */
  conversationSeq: Record<string, number>;
  /** Live DM calls (ringing or answered) by DM conversation id. Ended calls are dropped. */
  calls: Record<string, schemas.DmCall>;
}

export const emptyState: ChatState = { userId: null, servers: {}, messages: {}, typing: {}, conversationSeq: {}, calls: {} };

const TYPING_MS = 8000;

function toServerState(s: schemas.ServerSnapshot): ServerState {
  const voice: Record<string, schemas.VoiceState> = {};
  for (const v of s.voiceStates) voice[v.userId] = v;
  return {
    server: s.server,
    roles: Object.fromEntries(s.roles.map((r) => [r.id, r])),
    channels: Object.fromEntries(s.channels.map((c) => [c.id, c])),
    members: Object.fromEntries(s.members.map((m) => [m.userId, m])),
    presences: Object.fromEntries(s.presences.map((p) => [p.userId, p.status])),
    voice,
  };
}

/** READY replaces everything the gateway owns. Message history is kept so a reconnect doesn't blank the view. */
export function applyReady(state: ChatState, ready: ReadyPayload): ChatState {
  const servers = Object.fromEntries(ready.servers.map((s) => [s.server.id, toServerState(s)]));
  const messages: ChatState["messages"] = {};
  for (const [channelId, list] of Object.entries(state.messages)) {
    // Drop history for channels that are gone or no longer visible.
    if (Object.values(servers).some((s) => channelId in s.channels)) messages[channelId] = list;
  }
  // Calls are not replayed after a reconnect, so any we knew about may be over.
  return { ...state, userId: ready.userId, servers, messages, typing: {}, calls: {} };
}

/** Insert or replace by id, keeping ULID order (which is creation order). */
export function upsertMessage(list: readonly schemas.Message[], message: schemas.Message): schemas.Message[] {
  const i = list.findIndex((m) => m.id === message.id);
  if (i >= 0) {
    const next = list.slice();
    next[i] = message;
    return next;
  }
  const next = list.slice();
  let at = next.length;
  while (at > 0 && next[at - 1]!.id > message.id) at--;
  next.splice(at, 0, message);
  return next;
}

/** Merge a fetched page of history (any order) into what is loaded. */
export function mergeHistory(state: ChatState, channelId: string, page: readonly schemas.Message[]): ChatState {
  let list = state.messages[channelId] ?? [];
  for (const m of page) list = upsertMessage(list, m);
  return { ...state, messages: { ...state.messages, [channelId]: list } };
}

function withServer(state: ChatState, serverId: string, fn: (s: ServerState) => ServerState): ChatState {
  const current = state.servers[serverId];
  if (!current) return state;
  return { ...state, servers: { ...state.servers, [serverId]: fn(current) } };
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = record;
  return rest;
}

/**
 * Apply one gateway event. Unknown or malformed events are ignored, so a newer
 * server never breaks an older client.
 */
export function applyEvent(state: ChatState, name: EventName, data: unknown): ChatState {
  const schema = EventPayloads[name as keyof typeof EventPayloads];
  if (!schema) return state;
  const parsed = schema.safeParse(data);
  if (!parsed.success) return state;
  // The union of payloads is narrowed per case below.
  const d: unknown = parsed.data;

  switch (name) {
    case "SERVER_CREATE": {
      const snap = parsed.data as schemas.ServerSnapshot;
      return { ...state, servers: { ...state.servers, [snap.server.id]: toServerState(snap) } };
    }
    case "SERVER_UPDATE": {
      const s = parsed.data as schemas.Server;
      return withServer(state, s.id, (cur) => ({ ...cur, server: s }));
    }
    case "SERVER_DELETE": {
      const { id } = d as { id: string };
      const channelIds = Object.keys(state.servers[id]?.channels ?? {});
      const messages = { ...state.messages };
      for (const c of channelIds) delete messages[c];
      return { ...state, servers: without(state.servers, id), messages };
    }
    case "CHANNEL_CREATE":
    case "CHANNEL_UPDATE": {
      const c = parsed.data as schemas.Channel;
      return withServer(state, c.serverId, (s) => ({ ...s, channels: { ...s.channels, [c.id]: c } }));
    }
    case "CHANNEL_DELETE": {
      const { id, serverId } = d as { id: string; serverId: string };
      const next = withServer(state, serverId, (s) => ({ ...s, channels: without(s.channels, id) }));
      return { ...next, messages: without(next.messages, id) };
    }
    case "ROLE_CREATE":
    case "ROLE_UPDATE": {
      const r = parsed.data as schemas.Role;
      return withServer(state, r.serverId, (s) => ({ ...s, roles: { ...s.roles, [r.id]: r } }));
    }
    case "ROLE_DELETE": {
      const { id, serverId } = d as { id: string; serverId: string };
      return withServer(state, serverId, (s) => ({ ...s, roles: without(s.roles, id) }));
    }
    case "MEMBER_ADD":
    case "MEMBER_UPDATE": {
      const m = parsed.data as schemas.Member;
      return withServer(state, m.serverId, (s) => ({ ...s, members: { ...s.members, [m.userId]: m } }));
    }
    case "MEMBER_REMOVE": {
      const { serverId, userId } = d as { serverId: string; userId: string };
      // We were removed: the server is gone from our view.
      if (userId === state.userId) return applyEvent(state, "SERVER_DELETE", { id: serverId });
      return withServer(state, serverId, (s) => ({
        ...s,
        members: without(s.members, userId),
        presences: without(s.presences, userId),
        voice: without(s.voice, userId),
      }));
    }
    case "MESSAGE_CREATE":
    case "MESSAGE_UPDATE": {
      const m = parsed.data as schemas.Message;
      return { ...state, messages: { ...state.messages, [m.channelId]: upsertMessage(state.messages[m.channelId] ?? [], m) } };
    }
    case "MESSAGE_DELETE": {
      const { id, channelId } = d as { id: string; channelId: string };
      const list = state.messages[channelId];
      if (!list) return state;
      return { ...state, messages: { ...state.messages, [channelId]: list.filter((m) => m.id !== id) } };
    }
    case "PRESENCE_UPDATE": {
      const { serverId, userId, status } = d as { serverId: string; userId: string; status: schemas.VisibleStatus };
      return withServer(state, serverId, (s) => ({ ...s, presences: { ...s.presences, [userId]: status } }));
    }
    case "TYPING_START": {
      const { channelId, userId, at } = d as { channelId: string; userId: string; at: number };
      const others = (state.typing[channelId] ?? []).filter((t) => t.userId !== userId);
      return { ...state, typing: { ...state.typing, [channelId]: [...others, { userId, at }] } };
    }
    case "VOICE_STATE_UPDATE": {
      const v = parsed.data as schemas.VoiceState;
      return withServer(state, v.serverId, (s) => ({
        ...s,
        voice: v.channelId === null ? without(s.voice, v.userId) : { ...s.voice, [v.userId]: v },
      }));
    }
    case "CALL_UPDATE": {
      const call = parsed.data as schemas.DmCall;
      return { ...state, calls: call.state === "ended" ? without(state.calls, call.conversationId) : { ...state.calls, [call.conversationId]: call } };
    }
    case "CONVERSATION_UPDATE": {
      const { conversationId, seq } = d as { conversationId: string; seq: number };
      return { ...state, conversationSeq: { ...state.conversationSeq, [conversationId]: Math.max(seq, state.conversationSeq[conversationId] ?? 0) } };
    }
    default:
      // Moderator-only events (reports, audit log) are handled by their own screens.
      return state;
  }
}

/** Who is typing in a channel right now, ignoring stale entries and the viewer. */
export function typingUsers(state: ChatState, channelId: string, now: number): string[] {
  return (state.typing[channelId] ?? []).filter((t) => now - t.at < TYPING_MS && t.userId !== state.userId).map((t) => t.userId);
}

/** Text channels first by position, for the sidebar. */
export function sortedChannels(server: ServerState, kind: "text" | "voice"): schemas.Channel[] {
  return Object.values(server.channels)
    .filter((c) => c.kind === kind)
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}
