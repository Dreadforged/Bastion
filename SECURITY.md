# Security policy

Bastion is early software. If you find a security problem, please tell us
privately before you tell anyone else.

Use GitHub's private vulnerability reporting on this repository (Security tab,
"Report a vulnerability"). Please do not open a public issue for a
vulnerability.

What helps: what you found, how to reproduce it, and which part of Bastion it
affects. We will reply to acknowledge your report and keep you updated until it
is fixed. We do not run a bug bounty yet.

The encryption code lives in `crates/crypto` and `apps/web/src/lib/e2ee.ts`,
`apps/web/src/voice`. The threat model is in `docs/threat-model.md`.
