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
| D1 migrations applied on deploy | **Missing** | `deploy.yml` | Deploy runs `wrangler deploy` only. Run `wrangler d1 migrations apply` by hand per environment, or add a step once staging exists. Not added here because it would change a production database automatically |
| Web app hosting | **Missing** | none | `deploy.yml` deploys the API Worker only. Nothing publishes `apps/web` (for example Cloudflare Pages) and there are no security headers or CSP for it. The vault note in `vault.ts` depends on a tight CSP |
| Deploy rollback | **Missing in docs** | none | The design says one-command rollback. `wrangler rollback` works per Worker; write it into the launch checklist runbook once deployed |
| Backups | **Missing** | none | The self-hosting scope calls for point-in-time recovery plus a nightly encrypted export and a monthly restore test |
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
