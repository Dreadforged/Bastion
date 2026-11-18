# 0001. TypeScript on Cloudflare Workers with Durable Objects

- Status: accepted
- Date: 2026-11-18

## Context

Bastion needs low-latency realtime messaging, per-conversation ordering and
cheap idle connections, with a small team operating it.

## Decision

- The server is TypeScript on Cloudflare Workers.
- Realtime state lives in Durable Objects using WebSocket Hibernation:
  `UserSession` (per user), `Server` (per community) and `Conversation`
  (per channel or DM).
- Accounts live in D1; files live in R2.
- Request and frame validation uses zod schemas shared by client and server
  (`workers/shared`).
- Rust is used only for the encryption core (`crates/crypto`, OpenMLS compiled
  to WASM).
- Voice uses LiveKit media servers (post-v1).

## Consequences

- One language across server and web client; schemas and permission logic are shared.
- Hibernation keeps idle sockets cheap, but object state must be rebuilt from storage on wake.
- Self-hosting depends on Workers-compatible runtimes; tracked separately in the self-hosting scope.
