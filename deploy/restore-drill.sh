#!/bin/bash
# Proves that a backup can be restored, in a throwaway container. Usage: restore-drill.sh <age-identity-file> <timestamp>
set -euo pipefail
cd "$(dirname "$0")"
set -a; . ./.env; set +a
id="$1"; t="$2"; d="${BACKUP_DIR:?}"; c="dt-drill-$$"
trap 'docker rm -f "$c" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$c" --network none -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_INITDB_ARGS="--encoding=UTF8 --locale=C" postgres:17-alpine >/dev/null
for _ in $(seq 60); do docker exec "$c" pg_isready -q -U postgres -h 127.0.0.1 && break; sleep 1; done
age -d -i "$id" "$d/roles-$t.sql.age" | grep -v -E '^(CREATE|ALTER) ROLE postgres' | docker exec -i "$c" psql -q -v ON_ERROR_STOP=1 -U postgres
docker exec "$c" createdb -U postgres -O dt_app -T template0 -E UTF8 -l C forsah
age -d -i "$id" "$d/db-$t.dump.age" | docker exec -i "$c" pg_restore -U postgres -d forsah --exit-on-error
age -d -i "$id" "$d/keys-$t.tar.age" | tar -tf - | grep -q tenant-db.key
docker exec "$c" psql -At -U postgres -d forsah -c "SELECT 'accounts: ' || count(*) FROM control.users" -c "SELECT 'customer schemas: ' || count(*) FROM pg_namespace WHERE nspname ~ '^t_[0-9a-f]{32}$'"
echo "restore drill ok"
