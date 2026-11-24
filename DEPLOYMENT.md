# Deploying Forsah to Railway (always-on, paper trading only)

This guide takes the existing project from your Windows PC to one always-on Railway service. After that, the
trading engine, market monitoring, AI analysis, paper trading and the Telegram bot run on Railway. Your PC
and browser can be off.

> **Paper trading only.** Nothing in this guide, and no setting or variable, enables real brokerage
> orders. Alpaca keys are used read-only for market data.

The Railway facts below were checked against docs.railway.com on 2026-11-22. Railway changes its product
often, so if a menu name differs, search the Railway docs for the term in quotes.

Railway's `railway.json` / `railway.toml` ("Config as Code") is **deprecated**: new services cannot use it,
and existing files stop working on 2026-12-01. This project therefore ships **no** `railway.json`. The
build comes from the `Dockerfile`, and the few service settings are set once in the Railway dashboard
(steps 13–18).

---

## Overview

```
GitHub (private repo, branch "production") ──► Railway service (Dockerfile)
                                                 ├─ one Node.js process: web + API + WebSocket
                                                 │    market engine · AI manager · paper trading · Telegram
                                                 └─ Volume mounted at /data  →  /data/trading.db, /data/backups
```

* **One service, one instance, one volume.** Railway does not allow replicas on a service that has a
  volume. That suits this app: exactly one engine may change the portfolio.
* **Health:** `/health/live` checks that the process answers. `/health/ready` checks that the engine has
  restored its state and the database is sound. Railway calls the healthcheck only during a deploy.
* **Redeploys have a short downtime.** Railway never runs two deployments that share one volume. While a
  deployment is stopped, nothing trades. No trades are invented for that gap.

---

## 1. Prepare the local project

1. Install **Node.js 24** (or 22.13 or newer) and **Git**. Check both:

   ```powershell
   node --version
   ```

   ```powershell
   git --version
   ```

2. Open PowerShell in the project folder:

   ```powershell
   cd C:\Users\TURKI\Desktop\3r\ai-trading-terminal
   ```

3. Install the dependencies:

   ```powershell
   npm ci
   ```

## 2. Verify that all tests pass

```powershell
npm test
```

All tests must pass before you continue. These checks run against mocks. They do **not** contact
Alpaca, DeepSeek, Gemini, Tiingo or Telegram.

Optionally, simulate the production configuration check:

```powershell
npm run preflight -- --production
```

Locally this check fails until a dashboard password is set. That is expected: in production the dashboard
refuses to start without one.

## 3. Create a private GitHub repository

On github.com, click **New repository** and fill it in:

* Name: `forsah`
* Visibility: **Private**
* Do **not** add a README, .gitignore or licence.

## 4. Upload the project

```powershell
git init -b main
```

```powershell
git add .
```

Check what will be committed:

```powershell
git status
```

The list must **not** contain `data/`, `.env`, any `*.db` file, `backups/` or `railway-import/`. The
`.gitignore` already excludes them. If any of them appears, stop and fix `.gitignore` first.

```powershell
git commit -m "Forsah trading terminal"
```

Replace `<your-user>` with your GitHub user name:

```powershell
git remote add origin https://github.com/<your-user>/forsah.git
```

```powershell
git push -u origin main
```

Create the **production** branch. Only this branch is ever deployed (see step 28):

```powershell
git branch production
```

```powershell
git push -u origin production
```

## 5. Connect GitHub to Railway

1. Sign in at railway.com and create or choose a plan. The Hobby plan costs $5/month and includes $5 of
   usage. Usage above that is billed on top. Check the current prices on Railway's pricing page.
2. Click **New Project → Deploy from GitHub repo**. Authorise Railway for your GitHub account and grant
   access to the `forsah` repository only.

## 6. Create the Railway service

1. Select the repository. Railway creates a service and finds the `Dockerfile` (Railway builds with a
   Dockerfile whenever one exists).
2. Open the service, then **Settings → Source**, and set the deploy branch to **`production`**.
3. The first build may start immediately. It is expected to fail its healthcheck until the variables from
   step 7 exist.

## 7. Set environment variables

Open the service's **Variables** tab and add the variables below. Values are encrypted by Railway. Never
put them in GitHub.

| Variable | Value | Required |
|---|---|---|
| `NODE_ENV` | `production` | yes |
| `DATABASE_PATH` | `/data/trading.db` | yes (step 14) |
| `DASHBOARD_PASSWORD_HASH` | output of `npm run hash-password` | yes (or `DASHBOARD_PASSWORD`, at least 12 characters) |
| `TERMINAL_MASTER_KEY` | 64 hex characters (see below) | recommended |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `30` | recommended (step 17) |
| `DEEPSEEK_API_KEY` | DeepSeek key | at least one AI key |
| `GEMINI_API_KEY` | Gemini key | at least one AI key |
| `ALPACA_KEY_ID`, `ALPACA_SECRET_KEY` | Alpaca **paper** account keys (`ALPACA_API_KEY` / `ALPACA_API_SECRET` are also accepted) | yes, for live data |
| `TIINGO_API_KEY` | Tiingo token | optional |
| `SEC_USER_AGENT` | `Your Name you@example.com` | optional |
| `TELEGRAM_BOT_TOKEN` | from @BotFather | for Telegram |
| `TELEGRAM_CHAT_ID` | your chat id (step 12) | for Telegram |
| `TELEGRAM_ADMIN_USER_IDS` | your user id (comma-separated if several) | for Telegram |
| `TELEGRAM_ENABLED` | `true` | for Telegram |

Create the password hash. The command asks for the password and saves nothing:

```powershell
npm run hash-password
```

Generate a master key, which encrypts any key you later save in Settings on the server:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

You do **not** need to set `PORT`, `HOST` or `APP_BASE_URL`:

* Railway injects `PORT`.
* The app listens on `0.0.0.0` in production.
* The `*.up.railway.app` domain is read from `RAILWAY_PUBLIC_DOMAIN`.

For a custom domain, add `ALLOWED_HOSTS=your.domain.com`.

## 8. Configure DeepSeek

1. Create a key at platform.deepseek.com and add credit if you want to make paid requests.
2. Set it as `DEEPSEEK_API_KEY`.
3. After deploying, check it under **Settings → Credentials → DeepSeek → Test** in the dashboard. The
   test lists the available models and your balance.

## 9. Configure Gemini

1. Create a key at aistudio.google.com and set it as `GEMINI_API_KEY`.
2. The model is `ai.gemini.model` (default `gemini-3.5-flash-lite`). Change it in **Settings → AI** if
   Google retires it.
3. Use **Test** in Settings to list the models your key can use.

**Choose the AI mode** in the **AI usage** tab of the dashboard (or `/ai` in Telegram):

| Mode | Behaviour |
|---|---|
| Automatic (default, recommended) | Picks the usable provider with the lowest expected cost, adjusted for its recent failure rate. Falls back to the other provider on errors. |
| DeepSeek only / Gemini only | All analysis goes to that provider. The other one is used only when **Automatic failover** is on. |
| Dual analysis | Important events are analysed by both providers and compared. A disagreement never trades: the system waits (no position) or holds (open position). |

* Budgets are **spending limits you set inside the app**: a global daily budget, plus optional
  per-provider daily and monthly budgets. They are not provider quotas.
* When a provider fails repeatedly, or reports a key, balance or quota error, the app stops calling it for
  a cooldown period and uses the other one.
* If both providers fail, monitoring and protective orders continue, and no new AI-driven entries are made.

## 10. Configure Alpaca

1. At app.alpaca.markets, open your **paper** account and create API keys.
2. Set `ALPACA_KEY_ID` and `ALPACA_SECRET_KEY`. The keys are used read-only. Order and position
   endpoints are blocked in code.

> **Run only one copy with the same Alpaca keys.** A free Alpaca market-data account allows only one live
> data stream at a time. Stop the app on your PC after Railway is running (step 25), or the two copies
> will keep disconnecting each other.

## 11. Configure Tiingo (optional)

1. Create a token at api.tiingo.com and set it as `TIINGO_API_KEY`.
2. Tiingo supplies a *derived reference price* outside regular hours. It is labelled **INDICATIVE**
   and is never used for simulated fills.

## 12. Configure Telegram

1. In Telegram, open **@BotFather**, send `/newbot` and copy the token. If you already have the bot from
   the local version, reuse its token. Do not create a new bot.
2. Find your chat id **before** enabling the bot on Railway:
   * Send any message to your bot.
   * Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in your browser.
   * Copy the number under `"chat":{"id": …}`. In a private chat this is also your user id.
3. Set the Railway variables:
   * `TELEGRAM_BOT_TOKEN` = the token
   * `TELEGRAM_CHAT_ID` = the number
   * `TELEGRAM_ADMIN_USER_IDS` = the number
   * `TELEGRAM_ENABLED` = `true`
4. **Only one copy may poll a bot.** Turn Telegram off in the local app (**Settings → Telegram**, untick
   *Enable*) or stop the local app. Otherwise Telegram answers `409 Conflict` and messages are split
   between the two copies.

## 13. Create the persistent volume

In the project canvas, add a **Volume** (right-click the canvas, or **Ctrl+K** and type "Volume"),
attach it to the service and set the **mount path** to `/data`.

With the Railway CLI, the same step is:

```powershell
railway volume add --mount-path /data
```

* The volume is mounted at runtime only, not during the build.
* Volumes are owned by root. The container starts as root only to give `/data` to the unprivileged
  `node` user, then drops its privileges. You do **not** need `RAILWAY_RUN_UID`.
* The Hobby plan includes a 5 GB volume. Volume storage costs $0.15 per GB per month.

## 14. Set `DATABASE_PATH`

`DATABASE_PATH=/data/trading.db` from step 7 places the database on the volume. If you leave it out,
the app uses `<volume mount>/trading.db` automatically. Without a volume, every redeploy would start with
an empty database: the app warns about this at startup, and the preflight check does too.

## 15. Disable Serverless (app sleeping)

Go to **Settings → Deploy → Serverless** and make sure **Enable Serverless is off**.

* Serverless would put the service to sleep when it has no traffic, and trading would stop.
* The change takes effect at the next deploy.

## 16. Production start command

Leave **Settings → Deploy → Custom Start Command** empty. The Dockerfile's command is used:

```
node --disable-warning=ExperimentalWarning server/index.js
```

## 17. Restart behaviour, draining and healthcheck

In **Settings → Deploy**:

* **Restart Policy:** *On Failure*. This is the default, with up to 10 restarts. On paid plans you may
  choose *Always*.
* **Healthcheck Path:** `/health/ready`. The default timeout of 300 seconds is enough.
* **Draining time:** `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` from step 7. Railway's default is
  **0 seconds** between SIGTERM and SIGKILL. With 30 seconds, the app has time to stop new proposals,
  finish in-flight work, save its state and close its connections.
* **Replicas:** keep **1**. Volumes cannot be used with replicas.

## 18. Generate the public HTTPS domain

Go to **Settings → Networking → Public Networking → Generate Domain**. You get a URL like
`https://forsah-production.up.railway.app`. The app reads it automatically.

---

## 19. Open the web dashboard

**Before you enable the cloud service with real Alpaca/Telegram credentials:** stop the local
application (`Ctrl+C`), or disable its market-data stream and Telegram polling. Do not have
both installations consuming the same single-connection Alpaca/Telegram credentials. You can
resume local development later with separate test credentials and the Telegram bot disabled.

1. Click **Deploy** (or **Ctrl+K → Deploy Latest Commit**) and wait for the deployment to turn
   **Active**.
2. Open the domain. You should see the Arabic login page.
3. Check the **Deploy Logs**:
   * The `Startup complete` line lists the symbols, the monitoring state, the AI trading state and the
     AI mode.
   * The `Accounting check passed` line appears once trades exist.

## 20. Test authentication

* Enter a wrong password: it is refused. After 5 failures the address is locked out for 15 minutes.
* Enter the right password: the dashboard opens.
* **⋯ → Sign out** returns to the login page.
* The session cookie is HttpOnly, Secure and SameSite=Strict.
* Every API route and the WebSocket refuse requests that have no valid session.

## 21. Test market monitoring

1. Type a ticker such as `NVDA`, click **Verify**, enter the starting capital and click **Start**.
2. Add more stocks in the **Watchlist** panel. All of them share one market-data connection and one
   portfolio.
3. The header shows three states: **Server**, **Monitoring** and **AI trading**.
4. Outside market hours the data status reads **MARKET CLOSED**. This is not an error.

## 22. Test the AI integrations

1. Open the **AI usage** tab. Each provider shows *available*, *not configured* or *paused after errors*.
2. Click **Analyze now** and watch the activity log. It shows which provider was used, the tokens and the
   estimated cost.
3. To try **Dual analysis**, select it and click **Analyze now** again. The chart explanation panel then
   shows both assessments.

## 23. Test Telegram

* `/start` shows the menu.
* `/portfolio`, `/status` and `/ai` should all answer from the same data the dashboard shows.

## 24. Test paper trading

* Executions appear in the chart, the **Trade history** tab and Telegram (`/buys`, `/sells`), labelled
  **صفقة افتراضية** (paper trade).
* Every trade still has to pass the deterministic risk engine.

## 25. Close the browser and verify background operation

1. Close every dashboard tab, and shut down your PC if you like.
2. From your phone, send `/status` to the bot. The server should be ONLINE and monitoring ACTIVE.
3. Reopen the dashboard later. A **"While you were away"** window lists the fills, orders, decision
   changes and alerts that happened in the meantime, from the server's event log.

The local copy should already be stopped before the Railway instance connects to Alpaca or Telegram (step 19).

## 26. Restart the service safely

Use the deployment menu **⋮ → Restart**, or redeploy. On SIGTERM the app:

1. refuses new proposals;
2. stops the schedulers;
3. stops Telegram polling;
4. waits up to 10 seconds for an analysis already in flight (its proposal is not executed);
5. saves the state and closes the market connections, the WebSocket, the HTTP server and the database.

On the next start:

* If the previous run ended without this sequence, for example after a crash, the app logs it and sends
  a Telegram alert.
* The app checks database integrity and reconciles the cash and positions against the recorded fills.
  AI trading resumes only if both checks pass.
* Analyses and new entries wait for fresh, verified market data.
* Decisions made before the restart are never executed.
* Pending limit orders that expired during the downtime are marked **EXPIRED** and are not filled.

## 27. Verify data persistence

After a restart:

* The portfolio, positions, trade history, watchlist, risk level, AI mode and operating states are
  unchanged.
* **Resources & services → Integrity & accounting check** should report that the database is sound and
  the balances match the trade records.

---

## 28. Update the application (controlled production deployments)

Experimental commits must not restart the trading engine, so only the `production` branch deploys.

1. Work and commit on `main`. Pushing to `main` does **not** deploy.
2. Before releasing, run the tests and the production check:

   ```powershell
   npm run predeploy
   ```

3. Merge `main` into `production`:

   ```powershell
   git checkout production
   ```

   ```powershell
   git merge main
   ```

   ```powershell
   git push
   ```

4. Railway builds and deploys `production`. Expect a short downtime, because the service has a volume.
5. Optional: in **Settings**, enable **Wait for CI**. Railway then waits for the GitHub Actions workflow
   in `.github/workflows/test.yml` to pass before deploying. If you prefer to deploy only by hand, disable
   auto-deploys and use **Ctrl+K → Deploy Latest Commit**.
6. After the deploy, check:
   * `/health/ready` returns 200;
   * the `Startup complete` log line;
   * the **Resources & services** tab;
   * `/status` in Telegram.
7. **Rollback:** in **Deployments**, choose an earlier deployment and click **Redeploy**. Database
   migrations only add tables and columns, so earlier versions keep working with the upgraded database.

Back up the database before every release (step 29).

## 29. Back up the database

The app keeps three independent layers of backups:

1. **Automatic in-app backups.** Every 24 hours the app writes a consistent copy (SQLite `VACUUM INTO`) to
   `/data/backups/scheduled-*.db`, verifies it and keeps the newest 7. You can change this under
   **Settings → Data**. A `pre-migration-*.db` copy is written before any schema upgrade, and a
   `pre-import-*.db` copy before any import. These copies sit on the same volume: they protect against
   mistakes, not against losing the volume.
2. **Off-site copy.** In the dashboard, open **Resources & services → Download a database copy**. You
   receive a consistent snapshot of the live database. Keep it somewhere private. **Never commit it.**
3. **Railway volume backups.** In the service's **Backups** tab you can take manual backups or schedule
   them daily (kept 6 days), weekly (27 days) or monthly (89 days).

Never copy `trading.db` file by file while the app is running. Always use one of the three methods above,
or `npm run db:backup` locally.

To verify a backup file locally:

```powershell
npm run db:check -- --db C:\path\to\backup.db
```

The output reports the integrity, the record counts and the accounting reconciliation.

## 30. Restore the database

* **From a Railway volume backup:**
  1. In the **Backups** tab, choose the backup and click **Restore**. Railway creates a volume from it
     and keeps the old one unmounted.
  2. Review the staged change and click **Deploy**.
* **From an app backup file** (scheduled, downloaded or exported):
  1. Upload the file as `/import/trading.db` (see *Migrate your local data* below).
  2. Set `DB_IMPORT_CONFIRM=overwrite`, because the current database holds data.
  3. Redeploy.
  4. On start, the app saves the current database as `/data/backups/pre-import-*.db`, verifies the
     uploaded file and swaps it in.
  5. Remove `DB_IMPORT_CONFIRM` afterwards.
* **After a failed migration:** the `pre-migration-*.db` file in `/data/backups` is the database exactly
  as it was before the upgrade. Restore it the same way, together with the previous app version (step 28,
  Rollback).

## Migrate your local data (trades, decisions, watchlist, settings)

The app **never** creates an empty portfolio over existing data, and it refuses to replace a database
that already holds trades unless you confirm explicitly.

1. Stop the local app (`Ctrl+C`) so its last state is saved.
2. Create a verified, consistent copy. The command also prints the record counts and the accounting check:

   ```powershell
   npm run db:export-for-railway
   ```

   It writes `railway-import\trading.db`. This folder is git-ignored.
3. Install the Railway CLI and link it to the project:

   ```powershell
   npm i -g @railway/cli
   ```

   ```powershell
   railway login
   ```

   ```powershell
   railway link
   ```

4. Upload the copy to the volume under the import name:

   ```powershell
   railway volume files upload .\railway-import\trading.db /import/trading.db
   ```

   Check that it arrived:

   ```powershell
   railway volume files list /import
   ```

   Alternatively, use SCP through `railway ssh`, as described in Railway's SSH docs.
5. If the Railway database already contains sessions or trades (for example from test runs), set the
   variable `DB_IMPORT_CONFIRM=overwrite`.
6. Redeploy or restart. The log should show `Database imported: {…counts…}`. The previous database is
   backed up first, and the import file is renamed so it is never applied twice.
7. Compare the counts with step 2, run **Integrity & accounting check** in the dashboard, then remove
   `DB_IMPORT_CONFIRM`.
8. **API keys:** keys you saved in the local Settings are encrypted with your local `data\master.key`.
   On Railway, either set the keys as Variables (recommended) or set `TERMINAL_MASTER_KEY` to the 64-hex
   content of `data\master.key` so the imported keys can be decrypted. Keys that cannot be decrypted are
   simply shown as *not set*.

## 31. Monitor resource usage

* **Railway:** the service **Metrics** tab shows CPU, memory and network. **Usage** shows the
  month-to-date cost. Only Railway's billing pages show what you will actually pay.
* **In the app:** the **Resources & services** tab shows:
  * uptime, memory, CPU and event-loop delay;
  * database size and last backup;
  * connected browsers, market-data connections and subscriptions;
  * the Telegram queue and component health;
  * DeepSeek and Gemini requests and estimated cost, kept separate.

  These are measurements taken inside the app, **not** an invoice.
* **Cost target:** aiming for about $5–10/month on Railway is reasonable for one small Node process with
  a small volume, but it is not guaranteed. Measure it in the Metrics tab during your first week. AI and
  market-data charges are billed separately by those providers.

To reduce costs:

* use the **Economy** usage mode;
* keep **Dual analysis** limited to important events;
* monitor fewer stocks;
* lower the snapshot and activity retention;
* turn off web research.

## 32. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| The deploy fails with exit code 78 and `Configuration error: DASHBOARD_PASSWORD …` in the logs | Set `DASHBOARD_PASSWORD_HASH` (or `DASHBOARD_PASSWORD`, at least 12 characters). |
| `Forbidden: unexpected Host header` | You use a custom domain. Add it to `ALLOWED_HOSTS` (or set `APP_BASE_URL`). |
| Healthcheck fails or times out | Read the deploy logs. `/health/ready` returns 503 while the app is starting or if the database integrity check failed. |
| Data disappears after a redeploy | No volume is attached, or `DATABASE_PATH` does not point into the volume mount path. |
| Telegram does not answer; the logs show `409 Conflict` | Another copy (usually the local app) polls the same bot. Stop it, or disable Telegram there. |
| Market data keeps reconnecting, or Alpaca reports a connection limit | Another copy uses the same Alpaca keys for streaming. Stop it. |
| Keys show *not set* after importing a database | Master-key mismatch. Set the keys as Variables, or set `TERMINAL_MASTER_KEY` (Migrate your local data, step 8). |
| AI trading shows ERROR / "No AI provider available" | Check the AI usage tab: missing keys, a provider paused after errors (its cooldown time is shown) or a budget reached. Monitoring and protective orders keep running. |
| AI trading shows RISK BLOCKED | A daily-loss or drawdown limit was reached. This is by design. See the Risk panel. |
| `MARKET CLOSED` | Outside the session. This is not an error. Overnight prices are labelled INDICATIVE or DELAYED. |
| AI was not resumed after a restart | A startup check failed. The log line and the Telegram alert list the problems. Run **Integrity & accounting check**, then resume manually. |

### If a secret was ever committed to Git

1. **Rotate it first.** Create new keys at each provider (DeepSeek, Gemini, Alpaca, Tiingo, Telegram via
   `/revoke` in BotFather) and update the Railway Variables.
2. Stop tracking the file:

   ```powershell
   git rm --cached .env
   ```

3. Commit that change.
4. Remove the file from the history (requires the `git-filter-repo` tool):

   ```powershell
   git filter-repo --path .env --invert-paths
   ```

5. Force-push. Treat the old keys as compromised either way.
