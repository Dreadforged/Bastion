# Bastion

Bastion is an open source, privacy-first chat and community platform by
Dreadforged Studios. Messages are end-to-end encrypted with MLS; the server
only relays ciphertext.

> Status: pre-alpha. Accounts, servers, text, moderation, encrypted DMs and
> channels, voice, files, and a web client are written and tested in isolation.
> Nothing has been deployed, and the encryption code has not had its outside
> review yet. Do not rely on it for anything private. See
> `docs/launch-checklist.md` and `docs/foundations-check.md`.

## Layout

```
workers/
  api/        Worker entry: HTTP routes, WebSocket upgrades, wrangler.toml
  durable/    Durable Objects: UserSession, Server, Conversation (WebSocket Hibernation)
  shared/     Types, zod schemas, ULIDs and the permissions bitmask (client + server)
crates/
  crypto/     bastion-crypto: Rust encryption core (OpenMLS, compiled to WASM)
apps/
  web/        React + TypeScript + Vite client
  desktop/    Tauri shell around the web client. Stub.
docs/
  threat-model.md
  launch-checklist.md, foundations-check.md, encryption-review-brief.md, privacy-notes.md
  adr/        Architecture decision records
```

## Stack

- Server: TypeScript on Cloudflare Workers, Durable Objects for realtime state.
- Storage: D1 for accounts, R2 for files.
- Validation: zod schemas shared by client and server.
- Encryption: Rust (OpenMLS) compiled to WASM.
- Voice: self-hosted LiveKit media servers (end-to-end encrypted frames).

## Getting started

Requirements: Node 20+, and for the Rust parts a stable Rust toolchain.

```bash
npm install
npm run typecheck
npm test
npm run dev:api   # wrangler dev on the API worker
npm run dev:web   # Vite dev server on http://localhost:5173
```

Rust:

```bash
cargo test --workspace
```

## Deployments

`workers/api/wrangler.toml` defines `staging` and `production` environments.
Pushes to `main` deploy to staging; production is a manual workflow run gated
by the GitHub `production` environment. Replace the placeholder D1 database ids
before the first deploy.

## License

[AGPL-3.0](LICENSE).
