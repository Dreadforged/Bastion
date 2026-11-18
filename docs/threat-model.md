# Threat model

Status: draft skeleton. Fill in each section as the design firms up.

## Assets

- Message content and attachments (end-to-end encrypted with MLS).
- Account credentials and session tokens (D1).
- Metadata: membership, who talks to whom, timing, IP addresses.
- Encrypted files in R2.
- Signing and deploy credentials (Cloudflare, GitHub, desktop code signing).

## Trust boundaries

- Client (web, desktop) to the API Worker.
- API Worker to Durable Objects (UserSession, Server, Conversation).
- Workers to D1 and R2.
- Clients to LiveKit media servers (voice, post-v1).
- Self-hosted deployments run by third parties.

## Adversaries

- Passive network observer.
- Malicious or compromised server operator (including Dreadforged infrastructure).
- Malicious server member or moderator abusing permissions.
- Compromised client device.
- Supply-chain attacker (npm, crates.io, CI).

## Security goals

- The server never sees plaintext message content.
- Permission checks are computed in one place (`workers/shared/src/permissions.ts`) and enforced server side.
- Minimise retained metadata and logs.

## Mitigations

TODO: map each threat to a mitigation, owner and status.

## Out of scope for v1

TODO.
