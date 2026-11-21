#!/usr/bin/env bash
# Nightly encrypted export of the D1 database.
# Usage: ops/backup/export.sh <staging|production>
# Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID (source account), BACKUP_AGE_RECIPIENT (age public key),
#        BACKUP_S3_ENDPOINT, BACKUP_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY (separate account's R2 or S3).
# The private key is never needed here, so a stolen CI token cannot read old backups.
set -euo pipefail
env_name="${1:?usage: export.sh <staging|production>}"
: "${BACKUP_AGE_RECIPIENT:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_BUCKET:?}"

stamp="$(date -u +%Y-%m-%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sql="$work/d1.sql"

(cd workers/api && npx wrangler d1 export DB --remote --env "$env_name" --output "$sql")
[ -s "$sql" ] || { echo "export is empty" >&2; exit 1; }

age -r "$BACKUP_AGE_RECIPIENT" -o "$work/d1.sql.age" "$sql"
rm -f "$sql"

key="$env_name/d1/$stamp.sql.age"
aws s3 cp "$work/d1.sql.age" "s3://$BACKUP_BUCKET/$key" --endpoint-url "$BACKUP_S3_ENDPOINT"
echo "uploaded $key"
