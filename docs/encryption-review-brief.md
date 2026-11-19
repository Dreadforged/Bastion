# Brief for the outside review of Bastion's encryption code

Prepared 2026-11-19 for whoever Dreadforged Studios hires. This is a hand-off
document, not the review itself. Nothing here has been sent to anyone.

Per the technical design, the review happens before alpha users rely on the
encryption, and it covers voice too. Marketing does not use the phrase
"end-to-end encrypted" until it passes, and says "audited" only after the report
is published.

## What we are asking for

An independent review of how Bastion uses MLS (RFC 9420) for text and voice,
looking for ways a server operator, a member, or a network attacker could read
content, forge it, keep access after removal, or learn more than we say they can.
We want a written report with findings by severity, and we plan to publish it.

We are not asking for a review of OpenMLS itself, of LiveKit, or of Cloudflare,
only of how we use them.

## Please review these, in this order

1. **`crates/crypto`** (about 1,100 lines of Rust, includes tests)
   - `src/client.rs`: wraps OpenMLS 0.9 with ciphersuite
     `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. Group creation, adding and
     removing members, self-updates, commit accept and reject, joining from a
     Welcome, encrypt and receive, the exporter, and saving and loading state.
   - `src/padding.rs`: padding to 256 B, 1, 4, 16 and 64 KB buckets.
   - `src/safety.rs`: 60-digit safety codes from two identity keys.
   - `src/wasm.rs`: the JavaScript surface.
   - `tests/groups.rs`: what is tested today.
2. **`apps/web/src/lib/e2ee.ts`** and **`vault.ts`**: how a device keeps its
   groups in step with the server (envelope cursors, commits, Welcomes), keeps
   its readable log, handles removal and a rejected commit, and stores state
   encrypted in IndexedDB (AES-GCM, non-extractable key).
3. **`apps/web/src/voice/`**: `keys.ts` (key derivation from the MLS exporter,
   label `bastion/voice/v1`), `provider.ts` (key provider for LiveKit's frame
   encryption), `call-group.ts`, `call.ts`, `service.ts`. Design and reasoning in
   `docs/adr/0004-voice-e2ee-key-derivation.md`.
4. **The server's side as delivery service**, to check it cannot read or
   subvert content and that its checks are sound:
   `workers/durable/src/conversation/` (`core.ts`, `access.ts`, `call.ts`) and
   `workers/api/src/conversations/`.
5. **Attachments**: `workers/api/src/files/` and the file key handling in the
   message payload (`workers/shared/src/conversations.ts`). ADR 0005.
6. **Sign-in and device identity** as they affect key trust:
   `workers/api/src/auth/`, key package upload and claim in
   `workers/api/src/conversations/keys.ts`.

Repository: github.com/Dreadforged/Bastion, default branch `main`, licensed
AGPL-3.0-only. Tests: `cargo test --workspace`, then
`npm run build:wasm -w @bastion/web` and `npm test`.

## Threat model

Full version in `docs/threat-model.md`. For the reviewer, the adversaries that
matter are:

- **Malicious or compromised server operator** (us, or Cloudflare): can read
  and change everything the server stores, drop, reorder or replay messages,
  and hand out any key packages or Welcomes. Must not be able to read content
  or add a member the group did not agree to.
- **Malicious group member or ex-member:** must not read after removal, must
  not forge another member's messages.
- **Network observer:** sees TLS only.
- **Compromised device:** out of scope except that other devices should recover
  through removal and key rotation.
- **Malicious media server** for voice: sees encrypted frames and random ids.

What the server is allowed to learn (and the privacy page will say so): who is
in each conversation, when messages are sent, their size bucket, and who is in a
voice channel while a call is live. See `docs/privacy-notes.md`.

## Design points we would like challenged

- Members are **devices, not accounts**. Each account's identity key signs its
  device keys, and safety codes come from identity keys. We have not shown that
  the server cannot substitute a device key, and the web client does not show
  safety codes yet.
- **Server as delivery service**: one Durable Object per conversation orders
  commits. Does the ordering and the "pending removal" mechanism (a member who
  lost access is marked and sends return `rotation_required` until someone
  commits their removal) leave a window we have not thought of?
- **Key packages**: one-time, claimed by the server from D1. Check for reuse,
  exhaustion and last-resort handling.
- **Voice key**: `MLS-Exporter("bastion/voice/v1", utf8(roomId), 32)` fed to
  LiveKit's built-in frame encryption. Rotation timing, who commits, the
  500 ms send delay, and the 16-slot key ring.
- **Private channels** are MLS groups with up to 200 members, and a member who
  loses `VIEW_CHANNEL` is removed from the group.
- **State at rest**: protects a copied profile, not script running in the
  origin.

## Known gaps (please do not spend time rediscovering these, but do tell us if one is worse than we think)

From ADR 0004 (voice):

- Everyone who can view a voice channel is in its MLS group. A member not in
  the call could compute the call key if they also learn the room id and capture
  ciphertext. A per-call group would close it; not done.
- A leaver who stays in the group can derive later keys until removed from the
  group. Media access is gated only by the LiveKit token.
- Opus frame length is visible, which leaks some information about speech.
- LiveKit leaves the first byte of audio frames and the first 3 or 10 bytes of
  video frames unencrypted (codec headers).
- A DM call's ring is an ephemeral gateway event. A callee who is offline misses
  it. No push notifications.
- A call group is checked by the Worker only to be a plain two-person group. It
  cannot tell whether the device did the cryptography right.
- Call groups are never deleted from a device's MLS state, so they pile up.
- LiveKit's end-to-end encryption is marked experimental in its SDK.

From the persistence and web client work:

- MLS state in the browser is stored per device with a non-extractable
  IndexedDB key. Anything running in the app's origin can still ask the browser
  to decrypt it. No Content-Security-Policy is shipped yet.
- State is saved before each send and after each epoch change or receive, so a
  crash cannot reuse a message key. The save is a single blob. Tests cover
  reload, removal and rollback, but only in memory with a fake delivery service.
- The log kept for display is capped (1,000 messages per conversation, 5,000
  sent payloads). Older readable history is lost.
- A device that joins an encrypted channel later depends on whoever opens the
  channel next to add it.
- New devices see no earlier messages. There is no encrypted backup.
- Safety codes are computed in the crate and not shown in the web client.
- Members appear by short id because profiles do not exist yet.

Never run against real infrastructure: a deployed Worker (everything ran over
`node:sqlite` stand-ins), a real LiveKit server, real browsers (Chrome,
Firefox, Safari differ on encoded transforms), or real R2. Also not verified:
that frames really leave the browser encrypted, that a keyframe after rotation
decodes, and what LiveKit does when a token loses screen share permission
mid-call.

## Specific questions

1. Is the ciphersuite and credential choice (basic credentials with Ed25519)
   appropriate, given that our own identity signing sits above MLS?
2. Does our commit ordering and rollback logic break MLS's assumptions anywhere?
3. Can the server cause a client to accept a Welcome or a commit it should not?
4. Is the exporter label and context safe, and is rotation timing safe?
5. Does the state blob format (`BSTN` magic plus OpenMLS storage) have versioning
   or tampering problems?
6. Anything in padding or safety codes that weakens them (`safety.rs` uses a
   5,200-iteration derivation; confirm that is sensible)?

## Logistics (open)

- **Who and budget:** not chosen. This is an open question in the technical
  design and the go-to-market plan. The plan needs the cost known before the
  Founding Community pre-sale, since that revenue funds it.
- **Timing:** build order item 7 puts it in the week of Feb 24 to Mar 2. Reviewers
  often book weeks ahead, so ask for dates now.
- **Scope to confirm in the contract:** text, voice, attachments, and the
  server's delivery service; a retest of fixes; permission to publish the
  report.
- **What to give them:** a tagged commit, this brief, the threat model, the
  ADRs, and a working local setup so they can run the tests. They should not get
  production credentials, and no servers exist yet.
- **Before they start:** run the Rust tests and clippy in CI, fix the known
  gaps we can, and have a person on our side who can answer questions (Nicole
  or whoever owns `crates/crypto`).
