#!/bin/sh
# Creates the secrets once. Never overwrites an existing one.
set -eu
cd "$(dirname "$0")"
umask 077
mkdir -p secrets
new() { [ -s "secrets/$1" ] || openssl rand -hex 24 | tr -dc 0-9a-f > "secrets/$1"; }
new admin_password; new postgres_password; new app_db_password
[ -s secrets/database_url ] || printf 'postgres://dt_app:%s@postgres:5432/forsah\n' "$(cat secrets/app_db_password)" > secrets/database_url
# the postgres image reads its secrets as another user inside the container
chmod 755 postgres-init.sh backup.sh restore-drill.sh; chmod 644 secrets/postgres_password secrets/app_db_password; chmod 711 secrets
[ -f .env ] || cp .env.example .env
echo "Secrets are in deploy/secrets. Edit deploy/.env, then: docker compose up -d --build"
