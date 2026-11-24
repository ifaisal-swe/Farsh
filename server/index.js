'use strict';
/**
 * Entry point: `npm start` locally, or the container command on Railway.
 *
 * Startup order: environment → configuration check → logging → storage (+ optional import, safe
 * migrations, integrity + accounting checks) → engine recovery (portfolio, positions, pending orders,
 * watchlist, risk level, AI mode, operating states) → market data → AI scheduling → Telegram → ready.
 * The HTTP server answers /health/live from the first second; /health/ready turns 200 when ready.
 */
const fs = require('node:fs');
const path = require('node:path');

// Minimal .env loader (no dependency). Values never get written anywhere by the app.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

// secrets as files (Docker secrets): NAME_FILE=/run/secrets/x fills NAME, before privileges are dropped
for (const name of ['SAAS_ADMIN_PASSWORD', 'SAAS_DATABASE_URL', 'DATABASE_URL', 'DASHBOARD_PASSWORD', 'TERMINAL_MASTER_KEY']) {
  const file = process.env[`${name}_FILE`];
  if (file && !process.env[name]) process.env[name] = fs.readFileSync(file, 'utf8').trim();
}

const { resolveRuntime } = require('./runtime');

/**
 * Railway mounts volumes owned by root. The container starts as root only to give the data directory
 * to the unprivileged `node` user, then drops privileges before any file or network work.
 * (RUN_AS_USER=root keeps root, e.g. with RAILWAY_RUN_UID=0 setups.)
 */
function dropPrivileges() {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return null;
  const user = process.env.RUN_AS_USER || 'node';
  if (user === 'root') return 'running as root (RUN_AS_USER=root)';
  let uid; let gid;
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[0] === user);
    if (!line) return `user ${user} not found; staying root`;
    [uid, gid] = line.split(':').slice(2, 4).map(Number);
  } catch (e) { return `could not read /etc/passwd (${e.message}); staying root`; }
  const rt = resolveRuntime(process.env);
  const own = (p) => {
    try {
      fs.mkdirSync(p, { recursive: true });
      const st = fs.statSync(p);
      if (st.uid !== uid) fs.chownSync(p, uid, gid);
      for (const f of fs.readdirSync(p)) {
        const fp = path.join(p, f);
        const s2 = fs.lstatSync(fp);
        if (s2.isSymbolicLink()) continue;
        if (s2.uid !== uid) fs.chownSync(fp, uid, gid);
        if (s2.isDirectory()) own(fp);
      }
    } catch (e) { console.error(`[startup] could not prepare ${p}: ${e.message}`); }
  };
  own(rt.dataDir);
  process.setgid(gid);
  if (process.initgroups) process.initgroups(user, gid);
  process.setuid(uid);
  return `running as ${user} (uid ${uid})`;
}

async function main() {
  const priv = dropPrivileges();
  if (priv) console.log(`[startup] ${priv}`);
  // hosted platform (several accounts) instead of the single-user terminal
  if (/^(1|true|yes|on)$/i.test(process.env.SAAS_MODE || '')) return require('./saas/gateway').run();
  const { createTerminal } = require('./app');
  let t;
  try {
    t = createTerminal({ echo: process.argv.includes('--verbose') });
  } catch (e) {
    console.error(`\n[startup] ${e.message}\n`);
    process.exit(e.code === 'CONFIG' ? 78 : 1);
  }
  let shuttingDown = false;
  const shutdown = async (signal, code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[${signal}] shutting down gracefully (state is persisted)…`);
    const limit = t.runtime.shutdownTimeoutMs;
    const timer = setTimeout(() => { console.error(`[shutdown] still busy after ${limit / 1000}s — exiting`); process.exit(code || 1); }, limit);
    try { await t.stop(); } catch (e) { console.error(`[shutdown] ${e.message}`); }
    clearTimeout(timer);
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (e) => t.activity.error(`Unhandled error: ${e && e.message ? e.message : e}`, { source: 'process' }));
  process.on('uncaughtException', (e) => {
    try { t.activity.error(`Fatal error: ${e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e}`, { source: 'process' }); } catch { /* ignore */ }
    // exit non-zero so the platform restart policy brings the service back; the next start detects the unclean stop
    shutdown('uncaughtException', 1);
  });

  let port;
  try {
    port = await t.start();
  } catch (e) {
    if (e.code === 'EADDRINUSE') console.error('Port already in use. Set PORT=xxxx in .env or stop the other process.');
    else console.error(e);
    process.exit(1);
  }
  const rt = t.runtime;
  const url = rt.baseUrl || `http://localhost:${port}`;
  console.log('');
  console.log('  ┌──────────────────────────────────────────────────────────┐');
  console.log('  │  FORSAH — AI TRADING TERMINAL — PAPER TRADING ONLY        │');
  console.log(`  │  Open: ${url.padEnd(50).slice(0, 50)}│`);
  console.log(`  │  Data: ${path.basename(rt.dbFile).padEnd(50).slice(0, 50)}│`);
  console.log('  │  Never sends real orders. Ctrl+C to stop.                 │');
  console.log('  └──────────────────────────────────────────────────────────┘');
  if (process.argv.includes('--demo')) console.log('  Tip: tick "DEMO data" next to the symbol box to run on synthetic data.');
}

main();
