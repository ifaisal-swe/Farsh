# Hosting on your own VPS

Paper trading only. Ubuntu 24.04 or similar, Docker Engine with Compose, a domain pointing at the server. Size: about 1 GB for PostgreSQL, 0.5 GB for the platform and up to 350 MB per customer.

## Install
1. Firewall: `ufw allow OpenSSH && ufw allow 80,443/tcp && ufw enable`. PostgreSQL is never published.
2. Copy the repository to the server, then: `cd deploy && sh setup.sh`
3. Edit `.env` (domain, your e-mail, limits). Read the operator password once from `secrets/admin_password`.
4. `docker compose up -d --build`, then `docker compose ps` (all healthy) and open `https://YOUR-DOMAIN`.
5. Sign in, turn on two-factor login in Settings, and create invitations at `/admin`.

Changing `secrets/admin_password` later does not change the existing operator account.

## Backups
1. On another computer: `age-keygen -o backup-key.txt`. Put only the public key (`age1...`) in `.env`.
2. Install `age` (and `rclone` for an off-server copy; without it a lost server means lost backups).
3. Cron: `15 2 * * * /path/deploy/backup.sh >> /var/log/dt-backup.log 2>&1`. Everything since the last run can be lost; run it more often if needed. Continuous WAL archiving is not included.
4. Keys (`keys-*.age`) open the encrypted data: keep them in a different place from the database dumps.
5. Every month run `restore-drill.sh backup-key.txt <timestamp>` on a machine that has the private key.

## Moving existing hosted data from SQLite
`docker compose stop app`, back up the app volume, then `docker compose run --rm app sh -c 'SAAS_DATABASE_URL=$(cat /run/secrets/database_url) SAAS_DATA_DIR=/data/saas node scripts/pg-import.js'`, then start again.

## Update and rollback
- Update: back up, `git pull`, `docker compose up -d --build`.
- Rollback: check out the previous version and run the same command. If the database schema changed, restore the backup as well: an older program refuses a newer schema.

## Full restore
New server, `setup.sh`, start only postgres, restore roles and database as in `restore-drill.sh`, unpack the keys into the app volume under `/data/saas`, restore the original `secrets`, start everything.

## Service keys (operator only)

Customers never see or enter keys. Set them on the server; each value is asked for without being shown and stored encrypted in the app volume:

    docker compose exec app node scripts/services.js list
    docker compose exec app node scripts/services.js set TELEGRAM_BOT_TOKEN
    docker compose restart app

`scope operator` (default): market data and AI keys serve only the operator's account. `scope everyone` also serves customers; use it only if your data plan allows redistribution. Telegram (one-tap linking) and company filings work for everyone in both scopes. Back up `services.key` with the other keys.

## The same backend on one PC

    cd deploy && sh setup.sh
    docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build

Opens at http://localhost:8790. The operator e-mail is `ADMIN_EMAIL` in `.env`; the password is in `secrets/admin_password`.
