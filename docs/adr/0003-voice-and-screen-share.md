# 0003. Voice and screen share on LiveKit, with the Worker deciding access

- Status: accepted
- Date: 2026-11-19

## Context

Voice channels and screen share need a media server. We want LiveKit to know
as little as possible, call state to disappear when the call ends, and
moderators to be able to act on a call as fast as on a text channel.

## Decision

- **Tokens.** `POST /servers/:id/voice/token` asks the Server object whether the
  caller may join. Only then does the Worker sign a LiveKit access token that
  lasts 5 minutes. Joining needs CONNECT_VOICE in that channel; asking for
  screen share also needs STREAM. A timeout removes both, so the route refuses
  timed-out members until the timeout ends.
- **Random ids.** The room is a random 128-bit id per voice channel, created
  when the first person joins and forgotten when the last leaves. The
  participant identity is a random 128-bit id, new on every join. The token has
  no name, metadata or attributes, and the user id and channel id never appear
  in it. The mapping from participant to person lives only in the Server
  object's `voice_states` table.
- **Grants.** The microphone needs SPEAK; screen share only if asked for and
  allowed. Cameras and data channels are never granted. The token says what was
  checked, so a client cannot publish more than its token allows.
- **Voice state.** `VOICE_STATE_UPDATE` (who is in which channel, self mute,
  self deafen, streaming) is sent over the gateway to members who can view the
  channel, and is in the READY snapshot. It is ephemeral: not stored for
  resume, so there is no call history. After a resume, clients fetch
  `GET /servers/:id/voice`. Rows are deleted the moment someone leaves.
- **No webhooks.** LiveKit webhooks stay off. Liveness is a lease: a joined
  client renews with `PATCH /servers/:id/voice` about every 30 seconds, and a
  state not renewed for 90 seconds is dropped by the Server object's alarm.
- **Moderation.** MUTE_MEMBERS (plus the usual role hierarchy) lets a member end
  someone's stream (`POST .../voice/:userId/end-stream`) or remove them from a
  call (`DELETE .../voice/:userId`). Both are audit logged. The Server object
  returns what LiveKit must be told, as `effects.voice`, and the Worker applies
  it through the `LiveKitAdmin` interface (an HTTP client in production, a fake
  in tests). Ending a stream also blocks restarting it until the person leaves
  and rejoins.
- **Lost access mid-call.** After every write, the Server object re-checks
  everyone in a call. A timeout, kick, ban, channel delete, role change or
  override that removes VIEW_CHANNEL or CONNECT_VOICE removes them from the
  call; losing only SPEAK or STREAM cuts that publishing.
- **Quality and viewers.** Free: 720p30, 25 viewers. Plus: 1080p60, 50 viewers.
  The plan comes from the Worker (`planFor`), never the client; until billing
  exists everyone is `free`. LiveKit does not say who is watching, so while a
  stream is live the room holds at most the weakest streamer's viewer limit of
  other people, and a joiner over it gets `stream_full`.
- **Room size.** A voice room holds at most 99 people, streaming or not
  (`VOICE_LIMITS.maxRoomParticipants`), one under LiveKit's own backstop of 100.
  A join over it gets `room_full`.
- **Stream limits.** At most 4 live streams in one room (`too_many_streams`),
  and 1 live stream per account across all servers. The per room count is in
  the Server object. The per account slot is a lease in D1 (`live_streams`:
  user id, server id, expiry; renewed by the voice heartbeat, deleted when the
  stream stops or the person leaves, lapsed after 90 seconds). DM calls are not
  counted: they have two people.
- **Not in the default permissions.** STREAM is bit 15 and is not in the
  default @everyone set. Servers turn it on for roles or channels.

## Consequences

- LiveKit compromise reveals random ids and network addresses, not accounts.
- A moderator action takes effect in the app at once and at LiveKit as soon as
  the admin call lands. Those calls are made once, best effort (see the
  hardening doc's known gaps).
- Viewer limits are conservative: everyone in a room with a live stream counts
  as a viewer, even if they are not watching.
- Voice state costs one small table per Server object and an alarm that only
  runs while someone is in a call.
