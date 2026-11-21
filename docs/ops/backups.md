# Backups

Status: written, not run. Nothing here has touched Cloudflare or a backup bucket. The bucket, keys and
ids are placeholders until the production account is set up.

## What is protected and how

| Data | Protection | Window |
| --- | --- | --- |
| D1 (accounts, sessions, invites, safety records) | D1 Time Travel, point in time, on by default | 30 days |
| D1, off-account copy | Nightly encrypted export (`ops/backup/export.sh`, `.github/workflows/backup.yml`) | Set by the bucket lifecycle rule |
| Durable Objects (servers, conversations, user sessions) | SQLite point-in-time recovery, built in | 30 days |
| R2 files | None yet. R2 has no versioning; copy with `rclone` to the backup account if file loss matters | None |

Durable Objects have no export API, so the nightly export covers D1 only. Message content is end to end
encrypted, so an export of it would not be readable without device keys anyway. Recovery for Durable
Objects is point-in-time restore inside the same account. If the account itself is lost, servers and
history are lost. Say so in the launch notes.

## Nightly encrypted export

1. The job runs `wrangler d1 export`, encrypts with `age` to a public key, and uploads to a bucket in a
   separate Cloudflare (or other S3 compatible) account.
2. The private key is kept offline by Nicole and one other person. CI only holds the public key, so a
   stolen CI token cannot read old backups.
3. Put a lifecycle rule on the bucket, for example 35 days of nightly copies.

Setup (none of it created yet):

- Variables on each GitHub environment: `BACKUP_AGE_RECIPIENT` (the `age1...` line from `age-keygen`),
  `BACKUP_S3_ENDPOINT`, `BACKUP_BUCKET`.
- Secrets: `BACKUP_ACCESS_KEY_ID` and `BACKUP_SECRET_ACCESS_KEY` (write only if the provider allows it),
  plus the existing `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` (the token needs D1 read).
- The restore test also needs `BACKUP_AGE_IDENTITY`. Putting the private key in CI weakens the "CI
  cannot read backups" property. Either use a separate test key pair (encrypt each export to both keys)
  or run `ops/backup/restore-test.sh` by hand. Decide before launch.

## Monthly restore test

`backup.yml` runs `ops/backup/restore-test.sh` on the 1st of each month. It downloads the newest
backup, decrypts it, loads it into a throwaway local D1 and checks that tables exist. A failed run
needs a fix that week. Once a quarter, also restore into the staging D1 by hand and sign in.

## Point in time recovery by hand

D1:

```
npx wrangler d1 time-travel info DB --env production
npx wrangler d1 time-travel restore DB --env production --timestamp "<ISO time>"
```

The restore prints the bookmark it was at before, so it can be undone.

Durable Objects: inside the object, call `ctx.storage.getBookmarkForTime(time)`, then
`onNextSessionRestoreBookmark(bookmark)`, then abort the object so it restarts. There is no admin route
for this yet. One would need to exist before it can be used in an incident.

## Not verified

The `wrangler d1 export` and `time-travel` flags, and the Durable Object bookmark calls, were written
from memory of the Cloudflare docs and have not been run. Check them against the installed wrangler
version before relying on this.
