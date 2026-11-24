#!/bin/bash
# Encrypted backup: database, roles, and the app's key files (two separate archives). Needs: age, docker; optional rclone.
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
: "${BACKUP_AGE_RECIPIENT:?set BACKUP_AGE_RECIPIENT}"
umask 077
out="${BACKUP_DIR:?}"; t=$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$out"
trap 'rm -f "$out"/*.part' EXIT
save() { age -r "$BACKUP_AGE_RECIPIENT" > "$out/$1.part" && [ -s "$out/$1.part" ] && mv "$out/$1.part" "$out/$1"; }
docker compose exec -T postgres pg_dump -U postgres -Fc forsah | save "db-$t.dump.age"
docker compose exec -T postgres pg_dumpall -U postgres --roles-only | save "roles-$t.sql.age"
docker compose exec -T app sh -c 'cd /data/saas && find . -name "*.key" -o -name services.json | tar -cf - -T -' | save "keys-$t.tar.age"
if [ -n "${BACKUP_REMOTE:-}" ]; then for f in "db-$t.dump.age" "roles-$t.sql.age" "keys-$t.tar.age"; do rclone copy "$out/$f" "$BACKUP_REMOTE"; done; fi
find "$out" -name '*.age' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
echo "backup $t ok"
