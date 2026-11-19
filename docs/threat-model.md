# Threat model

Status: v1 draft, updated 2026-11-19 for the alpha build. Review it with the
outside reviewer (see `encryption-review-brief.md`) and revise after.
Statuses: **Done** is built and tested in this repo, **Partly** has a known gap
listed, **Not built** is planned, **Not verified** means written but never run
against real infrastructure or browsers.

## Assets

- Message content and attachments (end-to-end encrypted with MLS).
- Account credentials and session tokens (D1).
- Metadata: membership, who talks to whom, timing, IP addresses.
- Encrypted files in R2.
- Signing and deploy credentials (Cloudflare, GitHub, LiveKit, R2 keys, desktop code signing).
- Each device's MLS state (group secrets), kept in the browser's IndexedDB.

## Trust boundaries

- Client (web, desktop) to the API Worker.
- API Worker to Durable Objects (UserSession, Server, Conversation).
- Workers to D1 and R2.
- Clients to LiveKit media servers (voice, our own two servers).
- Self-hosted deployments run by third parties (after the alpha).

## Adversaries

- Passive network observer.
- Malicious or compromised server operator (including Dreadforged infrastructure and Cloudflare).
- Malicious server member or moderator abusing permissions.
- Compromised client device.
- Malicious script in the web app's origin (XSS, bad dependency).
- Supply-chain attacker (npm, crates.io, CI).

## Security goals

- The server never sees plaintext message content.
- Permission checks are computed in one place (`workers/shared/src/permissions.ts`) and enforced server side.
- Minimise retained metadata and logs.
- Someone removed from a conversation or server cannot read what is sent afterward.

## What we do not protect against

- The server learning who talks to whom, when, and message size bucket (see `privacy-notes.md`).
- A compromised device that holds the keys, or someone using an unlocked one.
- Script running in the app's origin: the encrypted state vault only protects data at rest.
- Traffic analysis of voice by frame sizes.
- A malicious server operator serving a modified web client. A web app is delivered by the same operator it is trying to hide from. The desktop build and reproducible builds reduce this, and neither exists yet.

## Mitigations

| Threat | Mitigation | Where | Status |
| --- | --- | --- | --- |
| Server reads messages | MLS group encryption on the device; server stores ciphertext | `crates/crypto`, `workers/durable/src/conversation` | Done, **awaiting outside review** |
| Message length leaks content | Padding to fixed buckets (256 B to 64 KB) | `crates/crypto/src/padding.rs` | Done |
| Server swaps a contact's keys | Safety codes derived from both identity keys; users compare them | `crates/crypto/src/safety.rs`, DM screen | Partly: the function exists in the crate, but the web client does not show it yet, so people cannot verify a contact, and nothing warns when a contact's keys change |
| Removed member keeps reading | Removal commit rotates keys; server marks them pending removal and refuses sends until a member commits | `conversation/core.ts`, `apps/web/src/lib/e2ee.ts` | Partly: removal and commit rollback exist but were only tested with two or three clients in memory; the kick, ban and device revoke paths call revoke in the Worker, and the end-to-end flow has never run on a deployed system (see review brief) |
| Stolen session token | 15 minute access tokens, rotating refresh tokens stored hashed, reuse detection, device list and revoke | `workers/api/src/auth` | Done |
| Phishing, password theft | No passwords. Passkeys (WebAuthn) only | `auth/passkeys.ts` | Done, not run on a real domain |
| Account takeover by email | New devices need approval from an existing device, or an emailed link with a short expiry. Recovery code hashed with Argon2id | `auth/enrollment.ts` | Done |
| Signup and email abuse | Per-IP binding and per-account limits | `auth/rate-limit.ts`, `wrangler.toml` | Done |
| Permission escalation | One permission function, re-checked at fan-out, timeouts as a mask | `workers/shared/src/permissions.ts`, `server/core.ts` | Done |
| Malformed input | zod schemas on every route and gateway payload, size limits | `workers/shared` | Done |
| Malicious uploads | Size cap, real type check, EXIF strip, separate files domain, short-lived signed URLs | `workers/api/src/files` | Partly: abuse image scan is a stub that allows everything, so public-channel uploads must stay off until a scanner is chosen |
| Voice eavesdropping by media server | Frame encryption keyed from the MLS exporter | `apps/web/src/voice`, ADR 0004 | **Not verified** against real LiveKit or browsers |
| Media server abuse | Short-lived tokens for random room ids, hardening notes | ADR 0003, `docs/ops/livekit-hardening.md` | Not built (no servers rented) |
| Device MLS state copied from disk | AES-GCM with a non-extractable key in IndexedDB | `apps/web/src/lib/vault.ts` | Done, limited by XSS (see above) |
| XSS in the web app | React escaping; message text rendered as text | `apps/web` | Partly: no Content-Security-Policy is shipped yet |
| IP address retention | Never written to storage; rate limit key only; logs kept short | `wrangler.toml`, code | Partly: depends on Cloudflare log settings being configured |
| Privacy settings are cosmetic | DM policy and typing indicators are enforced in the Worker | `workers/api/src/account` | Done |
| Data requests | Account data export and on-device message export | `workers/api/src/account`, `apps/web/src/ui/Settings.tsx` | Done. Account deletion **not built** |
| Supply chain | CI audit, dependency review, Dependabot, lockfiles, secret scanning | `.github` | Done, not yet run on GitHub |
| Insider or leaked deploy credentials | `production` environment with required reviewers | `deploy.yml` | Config exists, reviewers not set |
| Abuse of the platform (illegal content) | Reports forward only what the reporter chose; internal admin tool behind Cloudflare Access | design | Reports done. Admin tool **not built** |
| Data loss | Durable Object point-in-time recovery, nightly encrypted export | self-hosting scope | Not built |

## Out of scope for v1

- Hiding the sender from the server (sealed sender).
- Federation and bots.
- Encrypted backup and restore of old messages on a new device. A new device starts fresh.
- Video and large broadcast streams.
- Mobile apps.
- Customer self-hosted deployments.
- Defending against a state-level adversary with control of the network and Cloudflare at once.
