# Launch checklist: closed alpha

Status as of 2026-11-19. Tick a box only when it is true on the real system, not
just in this repo. "Code" means written and tested here. Nothing below has been
deployed: no servers are rented and no Cloudflare resources exist yet.

Goal: 3 to 5 communities using Bastion daily, without having to retrofit the
security model.

## 1. Gates: do not invite anyone until all of these are ticked

- [ ] **Outside review of the encryption code is finished and its serious findings fixed** (text and voice). Brief: `encryption-review-brief.md`. Reviewer and budget not chosen.
- [ ] Review findings retested.
- [ ] Voice has been tried on real LiveKit in Chrome, Firefox and Safari: frames really encrypted, rotation works, screen share permission changes (ADR 0004 "Not verified"). Until then voice is off or labeled experimental, and marketing makes no voice-privacy claim.
- [ ] The deployed system has been exercised end to end by people: sign up, passkey, add a device, DM, encrypted channel, kick and ban, device revoke, file upload, call.
- [ ] Public image uploads stay disabled until a real abuse scanner replaces the stub (`NoopScanner`), or are limited to private files only.
- [ ] Account deletion exists, or the alpha terms say plainly that it does not and how to ask.
- [ ] Legal basics done: terms, privacy policy, subprocessor list, abuse contact. (Legal is outside this repo.)
- [ ] Safety Phase 0 done, per `safety-and-compliance-plan.md`: alpha is 18+ (decided 2026-11-19) but children are assumed present. Sign-up asks for age, platform reporting and the admin tool exist, contact controls and teen defaults are on, a named person owns child-safety reports, and the NCMEC registration is started.

## 2. Infrastructure (needs Nicole; nothing here is touched by code)

- [ ] Domains chosen. Set `RP_ID`, `RP_NAME`, `APP_ORIGIN` for staging and production in `workers/api/wrangler.toml`. Add a separate `FILES_ORIGIN` domain. Passkeys are bound to `RP_ID`; changing it later invalidates every passkey.
- [ ] Cloudflare: create D1, R2 and rate limit resources per environment and replace the placeholder ids. Apply the migrations in `workers/api/migrations/` (0001 to 0006) to staging, then production.
- [ ] Secrets set with `wrangler secret put`: `FILE_URL_SECRET`, R2 keys, LiveKit key and secret. Nothing secret in the repo.
- [ ] Cloudflare logs: shortest retention, no IP addresses in logs. Cloudflare rate limiting rules configured for sign-up, sign-in and email sends.
- [ ] Web app hosting chosen and deployed, with a strict Content-Security-Policy and security headers (the browser key vault relies on it).
- [ ] LiveKit on two US Hetzner servers (`ops/livekit/setup.sh`, `docs/ops/livekit-hardening.md`), hardened. Never run from a developer machine without a deliberate decision.
- [ ] Email provider chosen: signs a data processing agreement, no open or click tracking. Open question in the design.
- [ ] GitHub: `production` environment with required reviewers, branch protection on `main`, secret scanning and push protection, private vulnerability reporting on (`SECURITY.md` points to it), `CODEOWNERS` for `crates/crypto`, the permission function, auth and sessions.
- [ ] Staging and production kept apart: different databases, buckets, keys. Production deploys only from a manual run.
- [ ] Rollback tried once on staging (`wrangler rollback`) and written down.
- [ ] Backups: Durable Object point-in-time recovery on, nightly encrypted export of D1 and Durable Object data to a separate account, one restore into staging tested.
- [ ] Cost check: run the load test (`npm run load -w @bastion/api`) and compare the real Cloudflare bill after a week with the estimate.

## 3. Product and privacy

- [x] Privacy settings: who may start a DM with you, typing indicators on or off. Enforced in the Worker. Presence "Invisible" already existed. (code)
- [x] Account data export and on-device message export (Settings, Privacy and data). (code)
- [ ] Privacy page written from `docs/privacy-notes.md`, including routing metadata and Cloudflare (and the email, media and scanning providers) as subprocessors.
- [ ] The "what we keep" table on the website matches `privacy-notes.md` and the code.
- [ ] Recovery: the sign-up screen says up front that losing every device and the recovery code loses message history, and that new devices start fresh.
- [ ] Safety codes shown in the DM screen, or the alpha says contacts cannot yet be verified.
- [ ] Profiles or usernames so people are not shown as short ids.
- [ ] Decision on encrypted backup for new devices (open question), or the "starts fresh" answer is accepted for alpha.
- [ ] Moderation tools work on a real server: reports, timeouts, bans, audit log.
- [ ] Internal admin tool for platform-level abuse behind Cloudflare Access with a hardware key, or a written manual process for the alpha. The tool is built (`/staff`, off until `STAFF_ACCESS_TEAM_DOMAIN` and `STAFF_ACCESS_AUDIENCE` are set); the Access application and hardware-key policy are not created. It cannot view reports or evidence yet.

## 4. Claims rules (copy into every page, post and email before sending)

- Do **not** write "end-to-end encrypted" in marketing, on the website, or in launch posts until the outside review passes. This includes the voice-channel label.
- Do not write "audited" until the audit is published.
- Do not claim metadata privacy. Say what the server sees: who is in a conversation, when, and message size bucket.
- Voice-privacy claims wait for the review to cover voice. A future broadcast feature is labeled "encrypted in transit".
- Do not promise a customer self-hosted edition. It is assessed after the alpha.
- Only say things the product does today. "Open source" is true (AGPL-3.0).

## 5. The first communities

- [ ] Invite list of 3 to 5 communities. Each owner has read the alpha terms and knows it is an alpha.
- [ ] A way to report bugs and security problems (`SECURITY.md`, a contact address).
- [ ] You can see problems without reading message content: error counts, rate limit hits, Durable Object and bill dashboards. No IPs in logs.
- [ ] A rollback and incident plan: who decides, who talks to communities.
- [ ] Daily use ourselves first (checkpoint 2 on the roadmap): the team runs its own community on it for at least a week.
- [ ] First 48 hours: someone watching the bill, error rate and reports.

## 6. Known gaps carried into the alpha

Listed so nobody is surprised. Each is also in the threat model or the review brief.

- No account deletion.
- No encrypted backup; new devices see no earlier messages.
- MLS group state lives per browser; cleared storage means lost history.
- No safety code screen; members shown by short id.
- No CSP and no web hosting yet.
- Abuse scanner is a stub.
- Never run on workerd, real LiveKit, or real browsers.
- Desktop (Tauri) build is a stub.
- No push notifications; a missed ring is missed.
