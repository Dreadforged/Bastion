# Foundations check

Checked 2026-11-19 against build order item 1 of the technical design (monorepo,
CI with tests, dependency audit and secret scanning, separate staging and
production environments, threat model in `docs/`). "Exists" means it is in the
repo. Nothing here has been run on GitHub or Cloudflare from this checkout.

| Item | State | Where | Notes |
| --- | --- | --- | --- |
| Monorepo | Exists | `package.json`, `Cargo.toml` | npm workspaces and a Cargo workspace |
| CI: typecheck, tests, build | Exists | `.github/workflows/ci.yml` | TypeScript and Rust jobs. The Rust job runs fmt, clippy with warnings denied, tests and a wasm build |
| CI runs the encryption tests | **Fixed in this change** | `ci.yml` | The web encryption tests skip themselves when the WASM build is missing, and CI never built it, so they were silently skipped. CI now builds it with wasm-pack first. Unverified until the workflow runs |
| Dependency audit | Exists | `ci.yml` `audit` job | `npm audit --audit-level=high` and `cargo audit` |
| Dependency review on PRs | Exists | `ci.yml` `dependency-review` | Fails on high severity |
| Automatic dependency updates | **Added in this change** | `.github/dependabot.yml` | npm, cargo and GitHub Actions, weekly |
| Secret scanning in CI | Exists | `ci.yml` `secrets` job | TruffleHog on full history |
| Secret scanning on GitHub itself | **Missing, needs a click** | Repo settings | Turn on GitHub secret scanning and push protection if the plan allows it |
| `.gitignore` for secrets | Exists | `.gitignore` | `.env*`, `.dev.vars*`, keys. Secrets are set with `wrangler secret put` |
| Vulnerability reporting | **Added in this change** | `SECURITY.md` | Points to GitHub private vulnerability reporting. Turn that on in repo settings, or reports have nowhere to go |
| Staging and production separation | Partly | `workers/api/wrangler.toml`, `deploy.yml` | Separate worker names, D1 databases, R2 buckets, rate limit namespaces, Durable Object bindings. Pushes to `main` deploy to staging. Production is a manual run behind the GitHub `production` environment |
| Staging and production domains | **Missing, needs a decision** | `wrangler.toml` | `RP_ID`, `RP_NAME`, `APP_ORIGIN` are TODO for both. Passkeys are bound to `RP_ID`, so sign-in cannot work on staging until set. Also `FILES_ORIGIN` must be a separate domain |
| Real Cloudflare resource ids | **Missing** | `wrangler.toml` | D1 database ids are all-zero placeholders. Needs `wrangler d1 create` per environment, which means touching Cloudflare |
| D1 migrations applied on deploy | **Added, unrun** | `deploy.yml` | A `wrangler d1 migrations apply` step runs before the Worker deploys, per environment. Production still waits for the reviewer gate on the `production` environment |
| Web app hosting and CSP | **Added, unrun** | `deploy.yml`, `apps/web/wrangler.toml`, `apps/web/scripts/headers.mjs` | Builds the app and publishes it to Cloudflare Pages when the `WEB_PAGES_PROJECT` variable is set. The build writes `_headers` with a strict CSP (no inline script, `wasm-unsafe-eval` only), HSTS, nosniff, no framing. Project names and the API, files and LiveKit origins are placeholders until set |
| Deploy rollback | **Missing in docs** | none | The design says one-command rollback. `wrangler rollback` works per Worker; write it into the launch checklist runbook once deployed |
| Backups | **Added, unrun** | `docs/ops/backups.md`, `ops/backup/`, `backup.yml` | Nightly `age` encrypted D1 export to a separate account, monthly restore test, point in time recovery notes. Durable Objects rely on built in point in time recovery only. Needs the bucket, keys and a decision on the restore test key |
| Threat model in `docs/` | Exists, was a skeleton | `docs/threat-model.md` | Filled in this change: threats mapped to mitigations and status |
| ADRs | Exists | `docs/adr/` | 0001 to 0005. No ADR yet for the MLS messaging design or for the encrypted state vault |
| Code owner review for sensitive paths | **Missing, needs names** | none | The design says changes to `crates/crypto`, the permission function, sign-in and sessions get human review. A `CODEOWNERS` file and branch protection would enforce it |
| README accuracy | **Fixed in this change** | `README.md` | It said nothing worked and the crypto crate was a stub |

## Summary

Exists: monorepo, CI with tests, audit, dependency review, secret scanning,
per-environment Wrangler config, threat model file, ADRs.

Filled here (config or docs only): CI WASM build, Dependabot, SECURITY.md,
threat model, README status.

Needs Nicole: domains, Cloudflare resource creation, GitHub repo settings
(secret scanning, private vulnerability reporting, branch protection,
CODEOWNERS names, the `production` environment reviewers).

Needs engineering later: web hosting and CSP, migrations in deploy, backups,
account deletion.
