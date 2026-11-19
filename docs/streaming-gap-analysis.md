# Streaming gap analysis

Written 2026-11-19. Compares the Streaming Plan, the Self-Hosting Scope and the
voice section of Technical Design v1 (all dated Nov 18) with what is in this
repo. Nothing here was run against a real LiveKit server, workerd or a browser,
so "exists" means "written and covered by unit tests with fakes".

Sizes: S is under half a day, M is one to two days, L is three or more days.

## What the plan calls for and is built

| Plan item | Where | Notes |
| --- | --- | --- |
| Worker checks `CONNECT_VOICE`, signs a 5 minute LiveKit token for one room | `workers/api/src/voice/livekit.ts`, `servers/routes.ts` | Token has no name or metadata. `STREAM` is checked when screen share is asked for. |
| Random room ids and random participant ids, new on every join | `durable/src/server/core.ts` (`voiceJoin`) | Matches ADR 0003. |
| `STREAM` permission, separate from speaking, not in default @everyone | `shared/src/permissions.ts` (bit 15) | Lets studios limit streaming to trusted roles. |
| Quality tiers 720p30 free, 1080p60 Plus; 25 and 50 viewers; 2.5 and 6 Mbps ceilings | `shared/src/voice.ts` (`STREAM_QUALITY`) | Plan comes from `planFor`; everyone is free until billing exists. |
| Viewer caps | `core.ts` (`requireRoomFor`, `streamCap`) | Conservative: everyone in a streaming room counts as a viewer. Weakest streamer sets the cap. |
| Moderators end a stream or remove someone, LiveKit told at once | `core.ts` (`voice.end_stream`, `voice.disconnect`), `applyVoiceEffects` | Audit logged. Calls are best effort, once. |
| Access lost mid call (timeout, kick, ban, role change) removes or restricts | `core.ts` (`reconcileVoice`) | Tested. |
| Lease based liveness, no webhooks, no call history | `core.ts` (`expireVoice`) | |
| E2EE: voice channel is an MLS group, key from the MLS exporter into LiveKit's key provider, rotation on join and leave | `apps/web/src/voice/*`, `crates/crypto` | Written, tested with fake rooms only. |
| DM calls with their own MLS group | `durable/src/conversation/call.ts`, `shared/src/calls.ts` | Two people only. |
| Hardening script (no Egress, no webhooks, logs without IPs, SSH keys only, firewall, auto updates) | `ops/livekit/setup.sh`, `docs/ops/livekit-hardening.md` | Never run. |
| Moderation report audit of voice actions | `moderation.ts` (`voice.*` actions) | |

## What is missing or differs

Grouped by how much each matters.

### Cost and abuse (matters most for the budget)

1. **Adaptive stream is not turned on.** The plan calls it "the biggest saving":
   viewers who minimize or hide a stream stop receiving video, and a small tile
   gets the low layer. `LiveKitCallRoom` builds `new Room({ encryption })` with
   no `adaptiveStream` or `dynacast`. The model's 70% watched assumption depends
   on it. Also, the screen share is published with
   `screenShareSimulcastLayers: []`, so there is a single layer and nothing for
   adaptive stream to choose between. Plan says "2-3 quality layers".
   Both are client options, so this is a small change, but it only matters once
   it is tested on a real server (E2EE and simulcast interact).
2. **Bitrate ceilings are enforced by the client only.** The plan says "set by
   us, not the client". The token cannot carry a bitrate cap and, with E2EE, the
   server cannot inspect frames. A modified client can send more than 2.5 Mbps.
   The viewer cap bounds the damage (25 x extra), and LiveKit has no per
   publisher bitrate setting in the open source server. Realistic fix: watch
   outgoing bandwidth per server and per room, and drop rooms that exceed it
   (needs the metrics below). Treat this as accepted risk for the alpha.
3. **No room size cap in the Worker before this change.** Only LiveKit's
   `max_participants: 100` stood behind it. Now added: 99 per room, answered
   `409 room_full` (see "Built in this pass").
4. **No limit on how many people stream in one room.** Each extra streamer
   multiplies egress, because every other person can subscribe to every stream.
   With the room at 99 and 50 viewers per Plus stream, six simultaneous Plus
   streamers can ask the server for several hundred Mbps. Needs a number from
   Nicole (suggest 4 streams per room, 1 for free plans in rooms over 25).
5. **No per server cap on live streams or voice users.** A single community can
   fill a media server. Same fix style as 4. Needs a decision, not just code.
6. **"Streams end after 15 minutes with no viewers, with a warning first" is
   not built.** The server cannot see who is watching (LiveKit does not tell the
   Worker and webhooks are off). It can only know that nobody else is in the
   room, which costs nothing anyway because LiveKit forwards to nobody. The real
   saving case, viewers present but not watching, needs a client report
   ("I am watching") or LiveKit subscriber counts. Recommend deferring and
   relying on adaptive stream (item 1).
7. **Stream audio tiers (96 kbps free, 128 Plus, 160 at 7 boosts) are not in
   `STREAM_QUALITY`.** Cheap in bandwidth, so low priority.
8. **Community boosts and Plus billing do not exist.** `planFor` is a hook that
   returns `free` for everyone. 720p60 and 1080p60 for everyone from boosts
   cannot happen until there is a boost model. The per streamer plan is read at
   join and stored, so a plan change mid call applies at the next join.
9. **VP9 or AV1 is not requested.** Plan expects 30 to 50% less bandwidth. Set
   `videoCodec` on the client, with H.264 fallback. Interacts with E2EE and with
   Safari, so test it with the rest of the browser matrix.
10. **Screen content frame rate is fixed per tier.** The plan wants a lower frame
    rate for documents. The client uses `contentHint: "detail"` and the plan's
    fps for everything. Small client change: let the user pick "motion" or
    "detail".
11. **Voice abuse limits.** The Server object rate limits voice operations per
    user (burst 10, 0.5 per second) and token issue goes through the same check.
    There is no per account concurrent stream limit across servers (one account
    can stream in several servers at once because voice state is per Server
    object). Cheap fix is a check in the User session object, but needs a
    decision on the number (suggest 1 live stream per account).

### Billing, alerts and measurement (ops, no code)

- **Billing alerts** at $25 and $50 on Cloudflare, and a Hetzner billing alert or
  spend check. Not in `docs/launch-checklist.md` as separate items with a
  deadline. Add them as unticked items. These are done in the vendor dashboards.
- **Weekly bill versus model check** (plan, rollout step 5) is not written down
  as a procedure. Add a short runbook: peak Mbps per server, monthly GB, bill,
  compared with the plan's cost table.
- **Metrics without ids.** Plan wants counts only (rooms, tracks, bandwidth).
  Nothing in the Worker records room or stream counts. A tiny counter in the
  Worker (joins, stream starts, refusals by reason, with no user or server id)
  would give the numbers for the weekly check. Privacy check needed before
  adding.
- **Uptime check** every minute with a phone alert on each media server. Ops.
- **Load test of real throughput** (350 Mbps per server) and the one week
  provider test are not done. They need servers, so they are not in scope for
  code.

### Architecture differences

- **One LiveKit URL.** The plan has two regions (Ashburn and Hillsboro), the
  Worker choosing the closest, each the other's backup. The code has one
  `LIVEKIT_URL` and one `LiveKitAdmin`. Needs a list of regions, a region stored
  with `voice_rooms` (the room lives on one server, and the admin calls must go
  to the same server), and a pick rule. Not needed for the first server (Feb 3
  to 9 step) but is for step 4. Size M.
- **Fallback interface.** The plan says the client talks to media through a small
  interface of ours so a host or LiveKit Cloud can replace Hetzner. `CallRoom`
  and `LiveKitAdmin` are exactly that. Good.
- **Admin API only from Cloudflare.** The plan's firewall rule says the admin API
  accepts calls only from Cloudflare. `setup.sh` proxies everything on 443 to
  7880, so the Twirp admin endpoints are reachable by anyone, protected only by
  the signed token. Cloudflare Workers egress addresses are not a fixed list, so
  an IP allow list does not work. Options: path block in Caddy with a secret
  header the Worker adds, or a Cloudflare Tunnel. Decide before the first server.
  Size S.
- **Disk encryption** on the media servers is in the plan's checklist and not in
  `setup.sh` (it is a provider setting at order time). Add to the ops doc.
- **Log retention 7 days then delete** differs from the script: journald is
  volatile with a 3 day cap, which is stricter. Fine, just note it.
- **Abuse reports for streams** (viewer's app captures a still the viewer reviews
  and sends) are not built. Known gap in the hardening doc. Needs a design for
  the encrypted report path. Size M.
- **Retry for LiveKit admin calls.** Best effort once. A failed "remove" leaves a
  kicked person in the call until their token expires and rejoin fails. Also
  noted in the hardening doc. Size M (needs a small queue in the Server object
  with its alarm).
- **Idle stream and "viewer is not watching" signal** (see cost item 6).

### Copyright (plan list, before public streaming)

None of this is built, and it is mostly not code: DMCA agent registration,
takedown address and process, repeat infringer policy (a way to suspend one
account's ability to stream, which `STREAM` per role does not do per user),
terms clause, and the record keeping rule. Code piece: a per user "streaming
suspended" flag on the account that the join route checks. Size S once policy
text exists.

## Self-hosting scope: what current choices block

The Self-Hosting Scope says the customer self-hosted edition is a later question
and that Cloudflare is the chosen platform. Items where current code makes that
later question harder, none urgent:

1. **LiveKit is already the self-hostable part.** Good. `LiveKitAdmin` is an
   interface, so a customer's own LiveKit works. Nothing blocks this.
2. **`planFor` and quality tiers assume a Plus subscription.** A self-hosted
   instance has no billing, so it needs a config switch for "everyone gets tier
   X" (the 1080p60 tier, with its own viewer cap). Today the default is free
   everywhere. Add an env var such as `DEFAULT_PLAN` read in the Worker. Size S.
3. **Hard coded limits.** `VOICE_LIMITS` and `STREAM_QUALITY` are constants in
   the shared package. A self-hoster with a fat pipe may want a higher viewer cap
   and a smaller one with a thin pipe. Make them overridable by environment, with
   these as defaults. Size S.
4. **Worker runtime APIs.** Voice state lives in Durable Object SQLite and uses
   alarms. workerd supports those, but any stand-in would need the same
   alarm and transactional semantics. Nothing to change now; keep new voice code
   inside `ServerCore` (plain class, tested on node:sqlite) as it is today.
5. **`setup.sh` is Ubuntu plus Docker only.** Matches the "Docker on Linux first"
   support scope. Do not add provider specific steps to it.
6. **License.** Code is AGPL-3.0-only, which fits "open source server". The Scope
   doc's licensing question (source available vs closed) was answered by the
   AGPL decision; update the Scope doc.
7. **Region and cost docs** assume Hetzner. The ops doc should say which lines
   are Bastion's own hosting and which apply to any host.

No current code choice prevents a later self-hosted edition.

## Built in this pass

- `VOICE_LIMITS.maxRoomParticipants = 99` in `workers/shared/src/voice.ts`.
- `voice.join` refuses with `409 room_full` when a room already holds that many
  people (`ServerCore.requireRoomFor`). People already in the room can refresh
  their token; a freed seat is usable at once; other rooms are unaffected.
- Tests in `workers/durable/test/voice.test.ts` ("room size").

Not built on purpose: stream count caps, per account stream limits and the
metrics counter, because each needs a number or a privacy call from Nicole.

## Prioritized next chunks

| # | Chunk | Size | Needs servers? | Why now |
| --- | --- | --- | --- | --- |
| 1 | Billing alerts and weekly bill runbook (ops doc and launch checklist items) | S | No (dashboards) | Cheapest protection against a surprise bill |
| 2 | Decide and add stream caps: streams per room, live streams per account | S | No | Closes the biggest remaining egress multiplier. Needs Nicole's numbers |
| 3 | Admin API lockdown in `setup.sh` and Worker (secret header or tunnel) | S | No to write, yes to test | Plan checklist item, currently open to the internet |
| 4 | Client: adaptive stream, dynacast, simulcast layers, codec preference, motion or detail choice | M | Yes to verify | The largest real saving, and the cost model assumes it |
| 5 | Self-host config: `DEFAULT_PLAN` and env overridable voice limits | S | No | Keeps the later self-hosted edition open |
| 6 | Counters without ids (joins, streams, refusals) for the weekly bill check | S | No | Needed to compare real use with the plan. Privacy review first |
| 7 | Retry queue for LiveKit admin calls | M | No | Moderation reliability |
| 8 | Two regions: region on `voice_rooms`, region list, pick rule | M | Yes to verify | Needed by Feb 17 to 23 |
| 9 | Per user streaming suspension flag (copyright repeat infringer policy) | S | No | Required before public streaming |
| 10 | Stream report path (viewer reviewed still) | M | No | Plan moderation item; fits with safety plan work |
| 11 | Stream audio tiers in `STREAM_QUALITY` and client | S | Yes to verify | Low cost impact |
| 12 | Real server tests: provider week, load test, E2EE in Chrome, Firefox and Safari | L | Yes | Gate for turning voice on; no code until servers exist |

Items 1, 2, 3, 5, 6, 7 and 9 can be built without any server. Items 2 and 9
need an answer from Nicole first.
