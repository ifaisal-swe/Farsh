# Deploying Forsah

This guide works with any host that can run a Docker container or Node.js: a cloud container platform, a
virtual server or your own machine. For a ready-made setup on one server (app, PostgreSQL and HTTPS with
Docker Compose), use [DEPLOYMENT-VPS.md](DEPLOYMENT-VPS.md) instead.

> **Paper trading only.** Nothing in this guide, and no setting or variable, enables real brokerage
> orders. Alpaca keys are used read-only for market data.

## 1. What the host needs

| Need | Details |
|---|---|
| Runtime | Docker (the repository has a `Dockerfile`), or Node.js 26 or newer |
| Database | PostgreSQL 14 or newer, UTF8 |
| Always on | Turn off app sleeping and scale-to-zero, or trading stops |
| One instance | Never run two replicas: exactly one engine may change the portfolio |
| HTTPS | The host's own domain or a reverse proxy that supports WebSockets |
| Storage | A persistent volume for `DATA_DIR`, for the encryption key files |
| Shutdown time | At least 30 seconds between SIGTERM and SIGKILL |
| Restart policy | Restart on failure |

Avoid overlapping deployments: stop the old instance before the new one starts. No trades are invented for
the downtime.

## 2. Check the project

```sh
npm ci
npm run web:build
npm test
npm run preflight -- --production
```

`npm test` needs a disposable PostgreSQL server in `PG_TEST_URL`. The preflight check fails until
`DATABASE_URL` and a dashboard password are set.

## 3. Environment variables

Set these as secrets on your host. Never commit them. [.env.example](.env.example) describes them.

| Variable | Value | Required |
|---|---|---|
| `NODE_ENV` | `production` (the Docker image sets it) | yes |
| `DATABASE_URL` | address of your PostgreSQL database | yes |
| `APP_BASE_URL` | public address, for example `https://trading.example.com` | yes |
| `DASHBOARD_PASSWORD_HASH` | output of `npm run hash-password` | yes (or `DASHBOARD_PASSWORD`, at least 12 characters) |
| `PORT` | port to listen on; the Docker image uses `8080` | optional |
| `DATA_DIR` | folder on the persistent volume; the Docker image uses `/data` | yes outside Docker |
| `TERMINAL_MASTER_KEY` | 64 hex characters (see below) | recommended |
| `ALLOWED_HOSTS` | extra domain names, comma separated | optional |
| `SHUTDOWN_TIMEOUT_SEC` | seconds to finish in-flight work, default `25` | optional |
| `DEEPSEEK_API_KEY`, `GEMINI_API_KEY` | AI keys | at least one |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | Alpaca **paper** account keys | for live data |
| `TIINGO_API_KEY` | Tiingo token | optional |
| `SEC_USER_AGENT` | `Your Name you@example.com` | optional |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_ADMIN_USER_IDS` | bot token from @BotFather and your ids | for Telegram |
| `TELEGRAM_ENABLED` | `true` | for Telegram |

Create the password hash and a master key:

```sh
npm run hash-password
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The app does not start in production without a password. It expects one reverse proxy in front of it that
sets `X-Forwarded-For` and `X-Forwarded-Proto` and keeps the original `Host` header.

This is the single-user terminal. For the invite-only platform (`SAAS_MODE=1`), see
[DEPLOYMENT-VPS.md](DEPLOYMENT-VPS.md).

## 4. Run it

### On a container platform

1. Connect your repository. The platform builds the `Dockerfile`; leave the start command empty.
2. Add PostgreSQL and the variables above.
3. Mount a persistent volume at `/data`.
4. Set the health check path to `/health/ready`, with a timeout of about 300 seconds.
5. Set one instance, no sleeping, and a shutdown time of 30 seconds or more.
6. Point your domain at the service and set `APP_BASE_URL` to it.

### With Docker

Put the variables in a file called `.env`, without quotes around the values, then:

```sh
docker build -t forsah .
docker run -d --name forsah --restart unless-stopped --stop-timeout 30 --env-file .env -v forsah_data:/data -p 127.0.0.1:8080:8080 forsah
```

In the container, `localhost` is the container itself: `DATABASE_URL` must use an address it can reach. The
container starts as root only to give `/data` to the `node` user, then drops its privileges.

### With Node.js

```sh
npm ci --omit=dev
npm run web:build
npm start
```

Use a service manager such as systemd to start it at boot and restart it on failure.

## 5. Connect the services

- **AI:** choose the mode in the **AI usage** tab. Test each key under **Settings → Credentials**.
- **Alpaca:** a free account allows one live data stream. Run only one copy with the same keys.
- **Telegram:** create a bot with @BotFather, send it a message, then read your chat id from
  `https://api.telegram.org/bot<TOKEN>/getUpdates`. Only one copy may poll a bot.

## 6. Check the deployment

1. `/health/live` and `/health/ready` return 200.
2. The log shows `Startup complete`.
3. Your domain shows the login page. A wrong password is refused.
4. Start a session, close the browser, and check `/status` in Telegram: the engine keeps running.
5. Restart the service. Portfolio, positions and history must be unchanged, and
   **Resources & services → Integrity & accounting check** must pass.

## 7. Update and roll back

1. Back up the database.
2. Run `npm run predeploy`, with the production variables and `PG_TEST_URL` available locally.
3. Deploy the new version, then repeat section 6.
4. To roll back, deploy the previous version. If it refuses a newer database schema, restore the backup too.

Deploy from a separate branch, such as `production`, so that ordinary commits do not restart the engine. If
your host can wait for CI, let it wait for `.github/workflows/test.yml`.

## 8. Back up and restore

- **Back up:** `pg_dump -Fc "$DATABASE_URL" > forsah.dump`. Keep the key files in `DATA_DIR` and
  `TERMINAL_MASTER_KEY` in a different place from the dump.
- **Restore:** stop the service, run `pg_restore --clean --if-exists -d "$DATABASE_URL" forsah.dump`, put
  the key files back, start it and run the integrity check.

## 9. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Exit code 78 and `Configuration error` | Read the message; usually the dashboard password is missing. |
| `Forbidden: unexpected Host header` | Set `APP_BASE_URL`, or add the domain to `ALLOWED_HOSTS`. |
| Health check fails | Read the logs. `/health/ready` returns 503 while starting or if the database check failed. |
| Saved keys cannot be opened after a redeploy | `DATA_DIR` is not on a persistent volume, or `TERMINAL_MASTER_KEY` changed. |
| Data disappears after a redeploy | `DATABASE_URL` points at another database. |
| Telegram `409 Conflict` | Another copy polls the same bot. Stop it. |
| Market data keeps reconnecting | Another copy uses the same Alpaca keys. Stop it. |
| `MARKET CLOSED` | Outside market hours. This is not an error. |

### If a secret was ever committed to Git

Rotate it first at its provider, update the variable on your host, then remove the file from the history:

```sh
git filter-repo --path .env --invert-paths
```

Force-push, and treat the old key as compromised either way.
