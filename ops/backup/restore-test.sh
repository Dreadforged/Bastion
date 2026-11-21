#!/usr/bin/env bash
# Restores the newest backup of an environment into a throwaway local D1 and checks it.
# Usage: ops/backup/restore-test.sh <staging|production>
# Needs the export.sh storage variables plus BACKUP_AGE_IDENTITY (the age private key, as text).
# Never touches a real database: the restore goes into wrangler's local state in a temp directory.
set -euo pipefail
env_name="${1:?usage: restore-test.sh <staging|production>}"
: "${BACKUP_AGE_IDENTITY:?}" "${BACKUP_S3_ENDPOINT:?}" "${BACKUP_BUCKET:?}"

root="$(pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

latest="$(aws s3 ls "s3://$BACKUP_BUCKET/$env_name/d1/" --endpoint-url "$BACKUP_S3_ENDPOINT" | awk '{print $4}' | sort | tail -1)"
[ -n "$latest" ] || { echo "no backups found for $env_name" >&2; exit 1; }
echo "restoring $latest"

aws s3 cp "s3://$BACKUP_BUCKET/$env_name/d1/$latest" "$work/d1.sql.age" --endpoint-url "$BACKUP_S3_ENDPOINT"
printf '%s\n' "$BACKUP_AGE_IDENTITY" > "$work/identity.txt"
age -d -i "$work/identity.txt" -o "$work/d1.sql" "$work/d1.sql.age"
rm -f "$work/identity.txt"

cd "$root/workers/api"
state="$work/state"
npx wrangler d1 execute DB --local --persist-to "$state" --file "$work/d1.sql"
tables="$(npx wrangler d1 execute DB --local --persist-to "$state" --json \
  --command "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0].results[0].n))')"
echo "tables restored: $tables"
[ "$tables" -ge 5 ] || { echo "restore looks wrong: too few tables" >&2; exit 1; }
echo "restore test passed for $latest"
