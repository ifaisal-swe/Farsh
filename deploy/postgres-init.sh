#!/bin/sh
# Runs once, on an empty database: the app's own role (no superuser) and its UTF8 database.
set -eu
pw=$(cat /run/secrets/app_db_password)
case "$pw" in *[!0-9a-f]*|'') echo "app_db_password must be hexadecimal" >&2; exit 1;; esac
psql -v ON_ERROR_STOP=1 -U postgres -d postgres <<SQL
CREATE ROLE dt_app LOGIN CREATEROLE PASSWORD '$pw';
CREATE DATABASE forsah OWNER dt_app ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
SQL
