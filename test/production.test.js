'use strict';
const { temp, named, openStore } = require('./helpers/db');
/**
 * Production readiness: runtime configuration, login and session security, health endpoints,
 * browser independence (one engine for any number of dashboards), event catch-up, graceful shutdown,
 * restart recovery (accounting check, offline-expired orders, no auto-resume after failed checks),
 * duplicate-order protection, safe migrations, and the deployment files.
 * Everything runs locally against mocks/DEMO data — no external service is contacted.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { PostgresSync } = require('../server/db-postgres');
const { createTerminal } = require('../server/app');
const { resolveRuntime, validateRuntime } = require('../server/runtime');
const { hashPassword, verifyPassword } = require('../server/auth');
const { Store } = require('../server/db');
const M = require('../server/maintenance');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { Desk } = require('../server/engine/desk');
const { Redactor } = require('../server/util/misc');
const { AnalysisScheduler } = require('../server/ai/scheduler');
const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

const ROOT = path.join(__dirname, '..');
const PW = 'correct-horse-battery-staple';
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

function raw(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `localhost:${port}`, ...headers } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers, json: () => JSON.parse(d) }));
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}
const post = (port, p, body, headers = {}) => raw(port, { method: 'POST', path: p, body, headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1', ...headers } });
const cookieOf = (res) => (res.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
const wsOpen = (port, headers = {}) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://localhost:${port}/ws`, { headers });
  ws.on('open', () => resolve({ ok: true, ws }));
  ws.on('unexpected-response', (req, res) => resolve({ ok: false, status: res.statusCode }));
  ws.on('error', () => resolve({ ok: false }));
});

// ---------------------------------------------------------------- runtime
test('runtime: production variables → 0.0.0.0:$PORT, key files on the volume, login required', () => {
  const env = { NODE_ENV: 'production', PORT: '8080', DATA_DIR: '/data', APP_BASE_URL: 'https://trading.example.com' };
  const rt = resolveRuntime(env, { host: '127.0.0.1', port: 8787 });
  assert.equal(rt.production, true);
  assert.equal(rt.host, '0.0.0.0');
  assert.equal(rt.port, 8080);
  assert.equal(rt.dataDir.replace(/\\/g, '/').endsWith('/data'), true);
  assert.equal(rt.authRequired, true);
  assert.deepEqual(rt.publicHosts, ['trading.example.com']);
  assert.equal(rt.secureCookies, true);
  assert.match(validateRuntime(rt).errors.join(), /DASHBOARD_PASSWORD/, 'a public dashboard without a password must not start');
  assert.deepEqual(validateRuntime({ ...rt, password: PW }).errors, []);
  assert.match(validateRuntime({ ...rt, password: 'short' }).errors.join(), /at least 12/);
  const local = resolveRuntime({}, { host: '127.0.0.1', port: 8787 });
  assert.equal(local.host, '127.0.0.1');
  assert.equal(local.authRequired, false);
  assert.equal(resolveRuntime({ DATA_DIR: '/x' }).dataDir.replace(/\\/g, '/').endsWith('/x'), true);
  assert.throws(() => createTerminal({ postgres: temp(), port: 0, host: '0.0.0.0', env: {} }), /DASHBOARD_PASSWORD/);
});

test('password hashing: scrypt, salted, timing-safe verification', () => {
  const h1 = hashPassword(PW);
  const h2 = hashPassword(PW);
  assert.notEqual(h1, h2, 'random salt');
  assert.match(h1, /^scrypt\$16384\$8\$1\$/);
  assert.equal(verifyPassword(PW, h1), true);
  assert.equal(verifyPassword('wrong-password-123', h1), false);
  assert.equal(verifyPassword(PW, 'garbage'), false);
});

// ---------------------------------------------------------------- login & sessions
test('login: every page, API route and the WebSocket require a session; cookie is HttpOnly/SameSite; logout revokes', async () => {
  const t = createTerminal({ postgres: temp(), port: 0, env: { DASHBOARD_PASSWORD: PW, SECURE_COOKIES: 'true' }, fetchImpl: silentFetch });
  const port = await t.start();
  try {
    assert.equal((await raw(port, { path: '/api/state' })).status, 401);
    const home = await raw(port, { path: '/' });
    assert.equal(home.status, 302);
    assert.equal(home.headers.location, '/login');
    assert.equal((await raw(port, { path: '/login' })).status, 200);
    assert.equal((await raw(port, { path: '/js/login.js' })).status, 200, 'login assets are public');
    assert.equal((await raw(port, { path: '/js/app.js' })).status, 401, 'dashboard code is not public');
    assert.equal((await wsOpen(port)).ok, false, 'WebSocket refused without a session');
    assert.equal((await post(port, '/api/auth/login', { password: 'nope-nope-nope' })).status, 401);
    const ok = await post(port, '/api/auth/login', { password: PW });
    assert.equal(ok.status, 200);
    const setCookie = ok.headers['set-cookie'].join(';');
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, /Secure/i);
    const cookie = cookieOf(ok);
    assert.equal((await raw(port, { path: '/api/state', headers: { Cookie: cookie } })).status, 200);
    const noHdr = await raw(port, { method: 'POST', path: '/api/ai/pause', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(noHdr.status, 403, 'CSRF: a session alone is not enough for a state change');
    const evil = await raw(port, { method: 'POST', path: '/api/ai/pause', headers: { Cookie: cookie, Origin: 'https://evil.example.com', 'X-Terminal-Client': '1', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(evil.status, 403, 'cross-origin rejected');
    const w = await wsOpen(port, { Cookie: cookie });
    assert.equal(w.ok, true, 'WebSocket accepted with a session');
    w.ws.close();
    const st = (await raw(port, { path: '/api/settings', headers: { Cookie: cookie } })).json();
    assert.equal(JSON.stringify(st).includes(PW), false, 'password never returned');
    const dbRow = t.store.db.prepare('SELECT token_hash FROM auth_sessions').get();
    assert.equal(cookie.includes(dbRow.token_hash), false, 'only a hash of the token is stored');
    await post(port, '/api/auth/logout', {}, { Cookie: cookie });
    assert.equal((await raw(port, { path: '/api/state', headers: { Cookie: cookie } })).status, 401, 'logged-out session is dead');
  } finally { await t.stop(); }
});

test('login rate limiting locks a client out after repeated failures', async () => {
  const t = createTerminal({ postgres: temp(), port: 0, env: { DASHBOARD_PASSWORD: PW }, fetchImpl: silentFetch });
  const port = await t.start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await post(port, '/api/auth/login', { password: `wrong-${i}-xxxxxxxx` })).status, 401);
    const locked = await post(port, '/api/auth/login', { password: PW });
    assert.equal(locked.status, 429, 'even the right password waits during the lockout');
    assert.ok(Number(locked.headers['retry-after']) > 0);
  } finally { await t.stop(); }
});

// ---------------------------------------------------------------- health, independence, events
test('health: /health/live and /health/ready (for any probe Host header); components without secrets', async () => {
  const t = createTerminal({ postgres: temp(), port: 0, env: { DASHBOARD_PASSWORD: PW, DEEPSEEK_API_KEY: 'sk-secret-health-0001' }, fetchImpl: silentFetch });
  const port = await t.start();
  try {
    const live = await raw(port, { path: '/health/live', headers: { Host: 'healthcheck.example.net' } });
    assert.equal(live.status, 200);
    const ready = await raw(port, { path: '/health/ready', headers: { Host: 'healthcheck.example.net' } });
    assert.equal(ready.status, 200, 'ready once the engine restored its state (no login needed, no secrets)');
    const body = ready.json();
    assert.equal(body.status, 'ready');
    assert.deepEqual(Object.keys(body.components).sort(), ['alpaca', 'database', 'deepseek', 'engine', 'gemini', 'news', 'telegram', 'tiingo']);
    assert.equal(ready.body.includes('sk-secret'), false);
    assert.equal((await raw(port, { path: '/api/state', headers: { Host: 'healthcheck.example.net' } })).status, 403, 'only health is open to that host');
    const h = t.health();
    assert.equal(h.components.deepseek.state, 'ok');
    assert.equal(h.components.alpaca.state, 'not_configured');
    const r = t.resources();
    for (const k of ['uptimeSec', 'memory', 'database', 'websocketClients', 'monitoredSymbols', 'queues', 'ai', 'note']) assert.ok(k in r, k);
  } finally { await t.stop(); }
});

test('browser independence: the engine runs with no dashboard; many dashboards share ONE engine; closing them stops nothing', async () => {
  const t = createTerminal({ postgres: temp(), port: 0, env: { DASHBOARD_PASSWORD: PW }, fetchImpl: silentFetch });
  const port = await t.start();
  try {
    const cookie = cookieOf(await post(port, '/api/auth/login', { password: PW }));
    const H = { Cookie: cookie };
    assert.equal((await post(port, '/api/symbol/change', { symbol: 'ACME', demo: true }, H)).status, 200);
    assert.equal((await post(port, '/api/session/start', { symbol: 'ACME', initialCapital: 10000, demo: true }, H)).status, 200);
    assert.equal(t.desk.book.aiState, 'RUNNING', 'running with zero browsers connected');
    const agents = t.desk.all().length; const providers = t.desk.book.providers.size;
    const socks = [];
    for (let i = 0; i < 5; i++) { const w = await wsOpen(port, H); assert.ok(w.ok); socks.push(w.ws); }
    assert.equal(t.desk.all().length, agents, 'no extra engine per dashboard');
    assert.equal(t.desk.book.providers.size, providers, 'no extra market-data connection per dashboard');
    for (const s of socks) s.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(t.desk.book.aiState, 'RUNNING', 'closing every dashboard changes nothing');
    assert.equal(t.desk.operatingStates().monitoring.state, 'ACTIVE');
    // reconnecting dashboards catch up from the persisted event log (no gaps, no duplicates)
    t.desk.emitEvent('RISK_LIMIT', 'ACME', { message: 'test limit' }, 'high', 'stable-evt-1');
    t.desk.emitEvent('RISK_LIMIT', 'ACME', { message: 'test limit' }, 'high', 'stable-evt-1');
    const ev = (await raw(port, { path: '/api/events?after=0', headers: H })).json();
    assert.equal(ev.items.filter((e) => e.id === 'stable-evt-1').length, 1, 'same event id stored once');
    const seq = ev.items.find((e) => e.id === 'stable-evt-1').seq;
    assert.equal((await raw(port, { path: `/api/events?after=${seq}`, headers: H })).json().items.some((e) => e.id === 'stable-evt-1'), false);
    // monitoring and AI states are independent and persisted
    const paused = await post(port, '/api/ops/monitoring', { active: false }, H);
    assert.equal(paused.json().monitoring.state, 'PAUSED');
    assert.equal(paused.json().monitoring.pausedByUser, true);
    assert.equal(t.desk.book.aiState, 'RUNNING', 'pausing monitoring is not pausing the AI state');
    assert.equal(t.store.getSetting('ops.monitoringPaused'), true);
    await post(port, '/api/ops/monitoring', { active: true }, H);
    assert.equal(t.desk.operatingStates().monitoring.state, 'ACTIVE');
    // AI mode is one setting for web and Telegram
    const m = await post(port, '/api/ai/mode', { mode: 'DUAL' }, H);
    assert.equal(m.json().mode, 'DUAL');
    assert.equal(t.config.get().ai.mode, 'DUAL');
    assert.equal((await post(port, '/api/ai/mode', { mode: 'NOPE' }, H)).status, 400);
  } finally { await t.stop(); }
});

test('graceful shutdown persists state and marks the run clean; a crash is detected on the next start', async () => {
  const dir = tmp('dt-shut-');
  const t = createTerminal({ dataDir: dir, postgres: named(path.join(dir, 'terminal.db')), port: 0, env: {}, fetchImpl: silentFetch });
  await t.start();
  t.desk.book.lock.run(() => new Promise((r) => setTimeout(r, 200))); // in-flight work
  await t.stop();
  assert.equal(t.desk.book.shuttingDown, true);
  const s = openStore(path.join(dir, 'terminal.db'));
  assert.equal(s.getSetting('runtime.run').cleanShutdown, true);
  assert.equal(M.markRunStart(s, Date.now()).unclean, false);
  assert.equal(M.markRunStart(s, Date.now()).unclean, true, 'a run that never stopped cleanly is reported');
  s.close();
});

// ---------------------------------------------------------------- restart recovery on the real engine
const origStart = AnalysisScheduler.prototype.start;
test.before(() => { AnalysisScheduler.prototype.start = function () { this.running = false; }; });
test.after(() => { AnalysisScheduler.prototype.start = origStart; });

class Fake2 extends FakeProvider { connect() { this.state = 'SUBSCRIBED'; this.emit('connection', { state: 'SUBSCRIBED', detail: 'test' }); } }

function makeDesk(file, clock, startup = null) {
  const store = openStore(file);
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  if (!store.getSetting('config', {}).risk) config.update({ risk: { ...LEGACY_DEFAULTS, maxOpenPositions: 2, profile: 'CUSTOM' } });
  let desk;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (desk && desk.book.session ? desk.book.session.id : null) });
  const provider = new Fake2({ clock });
  const decider = new ScriptedDecider();
  desk = new Desk({ store, config, secrets, activity, now: () => clock.t, providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  desk.primary.news.start = () => {};
  if (startup) desk.book.startup = startup;
  return { store, desk, provider, decider, config };
}

test('restart recovery: balances survive, accounting is reconciled, offline-expired orders are not filled, failed checks block auto-resume', async () => {
  const dir = tmp('dt-rec-');
  const file = path.join(dir, 'trading.db');
  const clock = { t: T0, now() { return this.t; } };
  const a = makeDesk(file, clock);
  await a.desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  a.provider.quote(99.98, 100.02); a.provider.trade(100);
  a.decider.push((s) => buyProposal(s));
  await a.desk.primary.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  const cash = a.desk.book.portfolio.cash;
  assert.ok(cash < 10000, 'bought');
  // the fill and the portfolio balance were written together
  assert.equal(a.store.getActiveSession().portfolio.cash, cash);
  // a resting limit order that will expire while the app is "offline"
  const o = a.desk.book.orders.addPending({ symbol: 'TEST', side: 'BUY', qty: 1, limitPrice: 90, stopLoss: 85, takeProfit: 99, decisionId: 'dec_x', proposal: {}, createdAt: clock.t, expiresAt: clock.t + 60000 });
  a.desk.primary.recordOrder({ id: o.id, side: 'BUY', type: 'LIMIT', qty: 1, limitPrice: 90, status: 'PENDING', source: 'AI', decisionId: 'dec_x' });
  a.desk.primary.persist();
  // duplicate protection: the same decision cannot create a second entry order
  const decId = a.store.listOrders(a.store.getActiveSession().id).find((x) => x.status === 'FILLED').decisionId;
  const r = a.desk.primary.executeEntry(buyProposal({ id: 'snap', market: { quote: { ask: 100.02 } } }), { id: decId, audit: { steps: [] } });
  assert.equal(r, undefined);
  assert.equal(a.store.listOrders(a.store.getActiveSession().id).filter((x) => x.decisionId === decId).length, 1, 'no duplicate order');
  // shutting down: proposals are refused
  a.desk.book.shuttingDown = true;
  a.decider.push((s) => buyProposal(s));
  const before = a.store.listOrders(a.store.getActiveSession().id).length;
  await a.desk.primary.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(a.store.listOrders(a.store.getActiveSession().id).length, before, 'no order while shutting down');
  a.desk.book.shuttingDown = false;
  // "crash": no clean shutdown; restart 10 minutes later on the same file
  clock.t += 10 * 60000;
  const rec = M.reconcileSession(a.store, a.store.getActiveSession());
  assert.equal(rec.ok, true, `accounting reconciles: ${JSON.stringify(rec.problems)}`);
  a.store.close();
  const b = makeDesk(file, clock, { dbOk: true, accountingOk: true, problems: [] });
  await b.desk.init();
  assert.equal(b.desk.book.portfolio.cash, cash, 'cash survives the restart');
  assert.ok(b.desk.book.portfolio.position('TEST'), 'position survives');
  assert.equal(b.desk.book.aiState, 'RUNNING', 'resumed after passing checks');
  assert.equal(b.store.getOrder(o.id).status, 'EXPIRED', 'expired while offline');
  assert.equal(b.store.listFills(b.store.getActiveSession().id).length, 1, 'no fill invented for the downtime');
  // tampered balance → reconciliation fails → AI not resumed
  b.store.saveSessionState(b.store.getActiveSession().id, { portfolio: { ...b.desk.book.portfolio.toJSON(), cash: cash + 500 }, aiState: 'RUNNING' });
  const bad = M.reconcileSession(b.store, b.store.getActiveSession());
  assert.equal(bad.ok, false);
  assert.match(bad.problems.join(), /cash/);
  const events = [];
  b.store.close();
  const c = makeDesk(file, clock, { dbOk: true, accountingOk: false, problems: bad.problems });
  c.desk.on('appEvent', (e) => events.push(e));
  await c.desk.init();
  assert.equal(c.desk.book.aiState, 'PAUSED', 'not resumed when the books do not reconcile');
  assert.ok(events.some((e) => e.type === 'ENGINE_CHECK_FAILED'));
  for (const x of [a, b, c]) { try { await x.desk.shutdown(); } catch { /* ignore */ } }
});

test('a watchlist symbol never overwrites the session main symbol', async () => {
  const dir = tmp('dt-sym-');
  const clock = { t: T0, now() { return this.t; } };
  const a = makeDesk(path.join(dir, 'trading.db'), clock);
  a.provider.fetchAsset = async (symbol) => ({ symbol, name: symbol, exchange: 'NASDAQ', status: 'active', tradable: true, fractionable: true });
  await a.desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  await a.desk.addSymbol('ABC');
  a.desk.agent('ABC').persist();
  assert.equal(a.store.getActiveSession().symbol, 'TEST');
  await a.desk.shutdown();
});

// ---------------------------------------------------------------- migrations
test('migrations: an older database is upgraded in place, and provider usage is backfilled', () => {
  const dir = tmp('dt-mig-');
  const file = path.join(dir, 'terminal.db');
  const target = named(file);
  const db = new PostgresSync(target.url, target);
  db.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, data_mode TEXT NOT NULL DEFAULT 'LIVE', initial_capital REAL NOT NULL, target_capital REAL, started_at INTEGER NOT NULL, ended_at INTEGER, ai_state TEXT NOT NULL DEFAULT 'IDLE', portfolio_json TEXT, orders_json TEXT, risk_json TEXT, benchmark_json TEXT, meta_json TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, model TEXT, purpose TEXT, ok INTEGER, prompt_tokens INTEGER, completion_tokens INTEGER, cache_hit INTEGER, cache_miss INTEGER, reasoning_tokens INTEGER, cost_usd REAL, latency_ms INTEGER, error TEXT);
    CREATE TABLE decisions (id TEXT PRIMARY KEY, session_id INTEGER, snapshot_id TEXT, ts INTEGER NOT NULL, symbol TEXT, action TEXT, confidence REAL, strategy TEXT, status TEXT, model TEXT, latency_ms INTEGER, proposal_json TEXT, risk_json TEXT, execution_json TEXT, audit_json TEXT, usage_json TEXT);
    INSERT INTO sessions(symbol, initial_capital, started_at, updated_at) VALUES ('ANT', 500, 1, 1);
    INSERT INTO ai_usage(ts, day, model, ok) VALUES (1, '2026-11-20', 'deepseek-flash', 1), (2, '2026-11-20', 'gemini-3.5-flash-lite', 1);`);
  db.close();
  const s = openStore(file);
  assert.deepEqual(s.migration.applied, [1, 2, 3]);
  assert.deepEqual(s.db.prepare('SELECT provider FROM ai_usage ORDER BY id').all().map((r) => r.provider), ['deepseek', 'gemini']);
  assert.equal(s.getActiveSession().symbol, 'ANT', 'existing data kept');
  s.close();
  const again = openStore(file);
  assert.deepEqual(again.migration.applied, [], 'idempotent');
  again.close();
});

// ---------------------------------------------------------------- deployment files
test('deployment files: Docker image without data or secrets, ignore files, env example, CI workflow', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const docker = read('Dockerfile');
  assert.match(docker, /^FROM node:26/m);
  assert.match(docker, /npm ci --omit=dev/);
  assert.match(docker, /CMD \["node", "--disable-warning=ExperimentalWarning", "server\/index\.js"\]/);
  assert.doesNotMatch(docker, /(API_KEY|SECRET|TOKEN|PASSWORD)\s*=/i, 'no credentials in the image');
  assert.doesNotMatch(docker, /COPY \. \./, 'no blanket copy of the working tree');
  const di = read('.dockerignore').split(/\r?\n/);
  for (const x of ['data', '.env', '*.db', 'test', 'node_modules']) assert.ok(di.includes(x), `.dockerignore ${x}`);
  const gi = read('.gitignore').split(/\r?\n/);
  for (const x of ['data/', '.env', '*.db', 'backups/']) assert.ok(gi.includes(x), `.gitignore ${x}`);
  for (const line of read('.env.example').split(/\r?\n/)) {
    if (/^(DEEPSEEK_API_KEY|GEMINI_API_KEY|ALPACA_KEY_ID|ALPACA_SECRET_KEY|TIINGO_API_KEY|TELEGRAM_BOT_TOKEN|TERMINAL_MASTER_KEY)=/.test(line)) assert.match(line, /=$/, `${line.split('=')[0]} must be empty in the example`);
  }
  assert.ok(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'test.yml')));
  assert.ok(fs.existsSync(path.join(ROOT, 'DEPLOYMENT.md')));
  const pkg = JSON.parse(read('package.json'));
  for (const s of ['start', 'test', 'preflight', 'hash-password']) assert.ok(pkg.scripts[s], s);
  assert.equal(Object.keys(pkg.devDependencies || {}).length, 0, 'production image needs no build tooling');
});
