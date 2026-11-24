'use strict';
/**
 * HTTP + WebSocket server and the single authoritative backend (market engine, AI, paper trading,
 * Telegram). Locally it binds to 127.0.0.1; in production (Railway) to 0.0.0.0:$PORT with a mandatory
 * login. Secrets never leave the backend. Mutating API calls require a custom header (forces a CORS
 * preflight that we never approve); Host/Origin checks block DNS-rebinding and cross-site requests.
 * The browser is only a view: opening or closing it never starts or stops the engine.
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const http = require('node:http');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const express = require('express');
const { WebSocketServer } = require('ws');
const { Store, SCHEMA_VERSION } = require('./db');
const { SecretStore, CREDENTIALS } = require('./secrets');
const { ConfigManager, DEFAULTS } = require('./config');
const { resolveRuntime, validateRuntime, LOOPBACK, truthy } = require('./runtime');
const { AuthManager, COOKIE } = require('./auth');
const M = require('./maintenance');
const { ActivityLog } = require('./activity');
const { Desk } = require('./engine/desk');
const { isCrypto } = require('./market/crypto');
const { marketHours } = require('./market/hours');
const chartbook = require('./analysis/chartbook');
const { InvestorService } = require('./lab/investors');
const { OpportunityService, parseEarningsDate } = require('./opportunity/service');
const { HelperService } = require('./helper/service');
const { sendWebPage, webAssets, ASSETS } = require('./webpage');
const { ShariaService } = require('./sharia/screener');
const { TerminalService } = require('./services/terminalService');
const { GeminiClient } = require('./ai/gemini');
const { Redactor } = require('./util/misc');
const { DeepSeekClient } = require('./ai/deepseek');
const { AlpacaProvider } = require('./market/alpaca');
const { LabService } = require('./lab/service');
const { PlanService } = require('./plan/service');
const { InvestService } = require('./invest/service');
const { CommandService } = require('./commands/service');
const technical = require('./lab/technical');
const { fetchJson } = require('./util/http');
const { isValidTf, etDateStr, etTimeStr } = require('./util/time');

const ROOT = path.join(__dirname, '..');
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"` : s;
}

const idList = (v) => String(v || '').split(/[,\s]+/).map((x) => x.trim()).filter((x) => /^-?\d{1,20}$/.test(x));

function createTerminal({ dataDir, port, host, env = process.env, providerFactory, fetchImpl, echo = false, dbFile, runtime = null, gatewayToken = null, postgres = null, telegramRelay = null, publicData = false, labModel = null, demoOnly = false } = {}) {
  // managed = one account of the hosted platform, reachable only through the gateway (server/saas)
  const viaGateway = (headers) => {
    if (!gatewayToken) return true;
    const got = crypto.createHash('sha256').update(String(headers['x-gateway-token'] || '')).digest();
    return crypto.timingSafeEqual(got, crypto.createHash('sha256').update(gatewayToken).digest());
  };
  // 1) environment → runtime settings (paths, host/port, login), validated before anything starts
  const rt = { ...(runtime || resolveRuntime(env, DEFAULTS.server)) };
  if (dataDir) Object.assign(rt, { dataDir, backupDir: path.join(dataDir, 'backups'), importDir: path.join(dataDir, 'import'), dbFile: path.join(dataDir, 'terminal.db') });
  if (dbFile) rt.dbFile = dbFile;
  if (port != null) rt.port = port;
  if (host) { rt.host = host; rt.remote = !LOOPBACK.has(host); rt.authRequired = rt.authRequired || rt.remote; }
  const check = validateRuntime(rt);
  if (check.errors.length) { const e = new Error(`Configuration error: ${check.errors.join('; ')}`); e.code = 'CONFIG'; throw e; }
  const bootLog = check.warnings.map((w) => ['warn', w]);
  const memory = rt.dbFile === ':memory:';
  const noFile = memory || !!postgres; // nothing to import, copy or download
  // 2) one-time import of an existing database placed in <data>/import/trading.db (before the DB is opened)
  if (!noFile) {
    try { M.applyPendingImport({ dbFile: rt.dbFile, importDir: rt.importDir, backupDir: rt.backupDir, confirm: rt.dbImportConfirm, log: (lvl, m) => bootLog.push([lvl, m]) }); } catch (e) { bootLog.push(['error', `Database import failed: ${e.message}`]); }
  }
  // 3) storage + safe migrations (a restorable copy is written before any schema change)
  const store = new Store(rt.dbFile, { backupDir: memory ? null : rt.backupDir, durable: !!gatewayToken, postgres });
  const integrity = (() => { try { return store.quickCheck(); } catch (e) { return [e.message]; } })();
  const dbOk = integrity.length === 1 && integrity[0] === 'ok';
  const redactor = new Redactor();
  // Railway-style variable names are accepted as aliases of the project's own names
  const envX = { ...env };
  if (!envX.ALPACA_KEY_ID && env.ALPACA_API_KEY) envX.ALPACA_KEY_ID = env.ALPACA_API_KEY;
  if (!envX.ALPACA_SECRET_KEY && env.ALPACA_API_SECRET) envX.ALPACA_SECRET_KEY = env.ALPACA_API_SECRET;
  const secrets = new SecretStore({ store, dataDir: memory ? null : rt.dataDir, env: envX, redactor });
  const config = new ConfigManager(store);
  const PORT = rt.port;
  const HOST = rt.host;
  let desk = null;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (desk && desk.book.session ? desk.book.session.id : null), echo });
  for (const [lvl, m] of bootLog) {
    if (lvl === 'ok') activity.ok('SYSTEM', m, { source: 'startup' });
    else if (lvl === 'error') activity.error(m, { source: 'startup' });
    else activity.warn(m, { source: 'startup' });
  }
  if (store.migration.applied.length) activity.info('SYSTEM', `Database schema upgraded v${store.migration.from} → v${store.migration.to}${store.migration.backup ? ` (backup: ${path.basename(store.migration.backup)})` : ''}`, { source: 'SQLite' });
  if (!dbOk) activity.error(`Database integrity check FAILED: ${integrity.slice(0, 3).join('; ')} — AI trading will not resume automatically`, { source: 'SQLite' });
  desk = new Desk({ store, config, secrets, activity, providerFactory, fetchImpl, publicData });
  const sharia = new ShariaService({
    store, getConfig: () => config.get(), getSecret: (n) => secrets.get(n), fetchImpl, publicProfile: publicData ? (s) => require('./lab/facts').profile(s, { fetchImpl }) : null,
    priceOf: (s) => { const a = desk.agent(s); return a && a.market && a.dataMode === 'LIVE' ? a.market.mark() : null; },
    onChange: (e, prev) => {
      activity.info('RISK', `Sharia status of ${e.symbol}: ${prev} → ${e.status}`, { status: e.status === 'PASS' ? 'ok' : 'warn', source: 'sharia screen' });
      const a = desk.agent(e.symbol);
      const held = !!(a && desk.book.portfolio && desk.book.portfolio.position(e.symbol));
      desk.emitEvent('SHARIA_STATUS', e.symbol, { status: e.status, prev, held, basis: e.basis }, held && e.status !== 'PASS' ? 'high' : 'normal');
    },
  });
  desk.book.sharia = sharia;
  // who the analysts talk to: the operator's own model first, then a configured AI key; none is fine (fixed rules only)
  const getModel = () => {
    const or = secrets.get('OPENROUTER_API_KEY');
    if (or) return { providerId: 'openrouter', modelId: (labModel && labModel.openrouter) || 'deepseek/deepseek-v4.1-flash-1017', url: 'https://openrouter.ai/api/v1', apiKey: or, parallel: true };
    if (labModel && labModel.url && labModel.modelId) return { providerId: 'local', modelId: labModel.modelId, url: labModel.url, apiKey: 'none', parallel: false };
    const ds = secrets.get('DEEPSEEK_API_KEY');
    if (ds) return { providerId: 'deepseek', modelId: 'deepseek-chat', url: 'https://api.deepseek.com/v1', apiKey: ds, parallel: true };
    const gm = secrets.get('GEMINI_API_KEY');
    return gm ? { providerId: 'gemini', modelId: config.get().ai.gemini.model, url: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: gm, parallel: true } : null;
  };
  const lab = new LabService({ store, desk, sharia, publicData, getModel, fetchImpl, activity });
  desk.book.lab = lab;
  const plan = new PlanService({ store, desk, lab, activity, getConfig: () => config.get() });
  const planTimer = setInterval(() => plan.tick().catch((e) => activity.warn(`The plan could not run: ${e.message}`, { source: 'plan' })), 15000);
  planTimer.unref();
  let opportunities = null;
  const oppTimer = setInterval(() => { if (opportunities) opportunities.scan().catch((e) => activity.warn(`Opportunities could not be checked: ${e.message}`, { source: 'opportunity' })); }, 60000);
  oppTimer.unref();
  const invest = new InvestService({ store, desk, lab, activity });
  const commands = new CommandService({ store, desk, activity });
  const techCache = new Map();
  const techBars = async (symbol) => {
    const a = desk.agent(symbol);
    if (!a || !a.provider) throw Object.assign(new Error('Add the symbol to your list first'), { status: 400 });
    const c = techCache.get(`${a.dataMode}|${a.symbol}`);
    if (c && Date.now() - c.at < 120000) return { a, ...c };
    const [daily, hourly] = await Promise.all([a.provider.fetchBars(a.symbol, '1d', { limit: 1250 }), a.provider.fetchBars(a.symbol, '1h', { limit: 400 }).catch(() => [])]);
    const x = { at: Date.now(), daily, hourly };
    techCache.set(`${a.dataMode}|${a.symbol}`, x);
    if (techCache.size > 20) techCache.delete(techCache.keys().next().value);
    return { a, ...x };
  };
  const investTimer = setInterval(() => { try { commands.tick(); invest.tick(); } catch (e) { activity.warn(`Investments could not be checked: ${e.message}`); } }, 5000);
  investTimer.unref();
  const labTimer = setInterval(() => lab.sweep(), 120000);
  labTimer.unref();
  let shariaBusy = false;
  const shariaTried = new Map();
  const shariaSweep = async () => {
    if (shariaBusy || !config.get().sharia.enabled || !sharia.canScreen()) return;
    shariaBusy = true;
    try {
      for (const a of desk.all()) {
        if (a.dataMode !== 'LIVE') continue;
        const r = sharia.results[a.symbol];
        const now = Date.now();
        const dueMs = r && r.status !== 'UNKNOWN' ? 86400000 : 3600000;
        if (now - Math.max(r ? r.at : 0, shariaTried.get(a.symbol) || 0) < dueMs) continue;
        shariaTried.set(a.symbol, now);
        try { await sharia.screen(a.symbol); } catch (e) { activity.warn(`Sharia screen of ${a.symbol} failed: ${redactor.redactString(e.message)}`, { source: 'sharia screen' }); }
      }
    } finally { shariaBusy = false; }
  };
  const shariaTimer = setInterval(shariaSweep, 60000);
  const shariaSoon = setTimeout(shariaSweep, 15000);
  shariaSoon.unref();
  shariaTimer.unref();
  const agent = desk.primary; // main symbol (session lifecycle); other symbols are reached through the desk
  const service = new TerminalService({ desk, store, config, secrets });
  // Telegram ids may also come from Railway variables (merged with the ids saved in Settings)
  const envChats = idList(env.TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_IDS);
  const envUsers = [...idList(env.TELEGRAM_ADMIN_USER_IDS || env.TELEGRAM_USER_IDS), ...envChats.filter((x) => !x.startsWith('-'))]; // private chat id == user id
  let relayChat = telegramRelay ? telegramRelay.chatId : null;
  const telegramCfg = () => {
    const c = config.get();
    const t = c.telegram || {};
    // platform bot: the linked private chat and nothing else, whatever the saved settings say
    if (telegramRelay) { const ids = relayChat ? [String(relayChat)] : []; return { ...c, telegram: { ...t, enabled: !!relayChat, authorizedChatIds: ids, authorizedUserIds: ids } }; }
    const uniq = (a) => [...new Set(a.map(String))];
    return { ...c, telegram: { ...t, enabled: env.TELEGRAM_ENABLED != null && env.TELEGRAM_ENABLED !== '' ? truthy(env.TELEGRAM_ENABLED) : !!t.enabled, authorizedChatIds: uniq([...(t.authorizedChatIds || []), ...envChats]), authorizedUserIds: uniq([...(t.authorizedUserIds || []), ...envUsers]) } };
  };
  const telegram = createTelegramSafe({ store, service, config, getConfig: telegramCfg, secrets, redactor, activity, fetchImpl, relay: !!telegramRelay });
  const auth = new AuthManager({ store, runtime: rt, log: (lvl, m) => (lvl === 'ok' ? activity.info('SYSTEM', m, { source: 'login' }) : activity.warn(m, { source: 'login' })) });
  const startedAt = Date.now();
  let ready = false;
  let stopping = null;

  const app = express();
  app.disable('x-powered-by');
  if (rt.trustProxy) app.set('trust proxy', rt.trustProxy);
  const allowed = () => {
    const p = server.address() ? server.address().port : PORT;
    const hosts = new Set([`localhost:${p}`, `127.0.0.1:${p}`, `[::1]:${p}`, ...rt.publicHosts]);
    const origins = new Set([`http://localhost:${p}`, `http://127.0.0.1:${p}`, `http://[::1]:${p}`, ...rt.publicHosts.flatMap((h) => [`https://${h}`, `http://${h}`])]);
    return { hosts, origins };
  };

  // ---------- health (before the Host check: Railway probes with Host healthcheck.railway.app; no secrets here)
  app.get('/health/live', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok', uptimeSec: Math.round((Date.now() - startedAt) / 1000) }));
  app.get('/health/ready', (req, res) => {
    const h = health();
    const ok = ready && !stopping && h.components.database.state === 'ok';
    res.set('Cache-Control', 'no-store').status(ok ? 200 : 503).json({ status: ok ? 'ready' : stopping ? 'stopping' : ready ? 'degraded' : 'starting', server: h.server.state, components: Object.fromEntries(Object.entries(h.components).map(([k, v]) => [k, v.state])) });
  });

  app.use((req, res, next) => {
    if (!viaGateway(req.headers)) return res.status(403).type('text').send('Forbidden');
    const h = String(req.headers.host || '').toLowerCase();
    if (!allowed().hosts.has(h)) return res.status(403).type('text').send('Forbidden: unexpected Host header (set APP_BASE_URL / ALLOWED_HOSTS for a public domain).');
    const wsSrc = `ws://${h} wss://${h}`;
    res.set({
      'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ${wsSrc}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
      ...(rt.production ? { 'Strict-Transport-Security': 'max-age=15552000' } : {}),
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    if (req.method !== 'GET') {
      if (req.get('X-Terminal-Client') !== '1') return res.status(403).json({ error: 'Missing X-Terminal-Client header' });
      const origin = req.get('Origin');
      if (origin && !allowed().origins.has(origin)) return res.status(403).json({ error: 'Cross-origin request rejected' });
    }
    next();
  });
  app.use(express.json({ limit: '100kb' }));

  // ---------- login (single user). Everything below requires a session when login is enabled.
  const PUBLIC_PATHS = new Set(['/login', '/login.html', '/js/login.js', '/css/login.css', '/favicon.ico', '/api/auth/login', '/api/auth/status']);
  app.get('/login', (req, res) => {
    if (!auth.enabled() || auth.sessionFrom(req.headers.cookie)) return res.redirect(302, '/');
    res.sendFile(path.join(ROOT, 'public', 'login.html'));
  });
  app.get('/api/auth/status', (req, res) => res.json({ required: auth.enabled(), authenticated: !auth.enabled() || !!auth.sessionFrom(req.headers.cookie) }));
  app.post('/api/auth/login', (req, res) => {
    if (!auth.enabled()) return res.json({ ok: true, required: false });
    const r = auth.login(req.body && req.body.password, { ip: req.ip, userAgent: req.get('User-Agent') });
    if (!r.ok) { if (r.retryAfterSec) res.set('Retry-After', String(r.retryAfterSec)); return res.status(r.status).json({ error: r.error, retryAfterSec: r.retryAfterSec || null }); }
    res.cookie(COOKIE, r.token, auth.cookieOptions(req));
    return res.json({ ok: true });
  });
  app.use((req, res, next) => {
    if (!auth.enabled() || PUBLIC_PATHS.has(req.path)) return next();
    const sess = auth.sessionFrom(req.headers.cookie);
    if (sess) { req.authSession = sess; return next(); }
    if (req.path.startsWith('/api/') || req.method !== 'GET') return res.status(401).json({ error: 'Login required' });
    if (req.path === '/' || req.path === '/terminal' || req.path.endsWith('.html') || (/^\/app(\/|$)/.test(req.path) && !req.path.startsWith('/app/_nuxt/'))) return res.redirect(302, '/login');
    return res.status(401).type('text').send('Login required');
  });
  app.post('/api/auth/logout', (req, res) => { auth.logout(req.headers.cookie); res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });
  app.post('/api/auth/logout-all', (req, res) => { const n = auth.enabled() ? auth.logoutAll() : 0; res.clearCookie(COOKIE, { path: '/' }); activity.warn(`All dashboard sessions signed out (${n})`, { source: 'login' }); res.json({ ok: true, sessions: n }); });

  // a demo can practise, and nothing else: no keys, no outside services, only invented prices
  const DEMO_ACTIONS = /^\/api\/(watchlist\/(add|remove|pause|resume)|invest(\/(suggest|update|cancel|goal|goal\/remove))?|commands(\/(read|change|cancel))?|plan(\/(toggle|answer))?|symbol\/(verify|change)|session\/(start|reset)|ai\/(pause|resume|stop|analyze)|position\/(close|reduce)|risk\/profile|capital|proposals\/[\w-]+\/\w+|opportunities\/scan|helper(\/clear)?|settings)$/;
  if (demoOnly) app.use((req, res, next) => {
    if (['GET', 'HEAD'].includes(req.method)) return next();
    const b = req.body || {};
    const only = (o, k) => o && typeof o === 'object' && Object.keys(o).every((x) => x === k);
    const ok = req.method === 'POST' && DEMO_ACTIONS.test(req.path) && (req.path !== '/api/settings' || (only(b, 'ai') && only(b.ai, 'autonomy'))) && (req.path !== '/api/watchlist/add' || desk.dataMode === 'DEMO');
    if (!ok) return res.status(403).json({ error: 'Not part of the demo' });
    if (/^\/api\/(session\/start|symbol\/(verify|change))$/.test(req.path)) { req.body = { ...b, demo: true }; delete req.body.mode; }
    return next();
  });
  app.use('/api/admin', (req, res, next) => (gatewayToken ? res.status(404).json({ error: 'Not found' }) : next()));
  app.get('/terminal', (req, res) => res.sendFile(path.join(ROOT, 'public', 'index.html')));
  app.get('/vendor/lightweight-charts.js', (req, res) => res.type('application/javascript').sendFile(path.join(ROOT, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js')));
  app.get('/shared/indicators.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'analysis', 'indicators.js')));
  app.get('/shared/technicals.js', (req, res) => res.type('application/javascript').sendFile(path.join(__dirname, 'analysis', 'technicals.js')));
  app.use(ASSETS, ...webAssets());
  app.get(/^\/app(\/.*)?$/, sendWebPage);
  app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html' }));

  const wrap = (fn) => async (req, res) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out === undefined ? { ok: true } : out);
    } catch (e) {
      res.status(e.status || 400).json({ error: redactor.redactString(e.message), validation: e.validation });
    }
  };

  // ---------- state & market
  const symQ = (req) => (req.query.symbol ? String(req.query.symbol).toUpperCase() : null);
  app.get('/api/state', wrap((req) => desk.publicState(symQ(req))));
  app.get('/api/bars', wrap(async (req) => {
    const tf = String(req.query.tf || '1m');
    if (!isValidTf(tf)) throw new Error('Invalid timeframe');
    return desk.bars(symQ(req), tf);
  }));
  app.get('/api/market/hours', wrap(() => { const a = desk.stockAgent(); return marketHours(a && a.calendar, Date.now()); }));
  app.get('/api/watchlist', wrap(() => ({ items: desk.watchlist(), max: desk.maxSymbols(), reference: desk.reference.summary() })));
  app.post('/api/watchlist/add', wrap(async (req) => ({ items: await desk.addSymbol(req.body && req.body.symbol) })));
  app.post('/api/watchlist/remove', wrap(async (req) => {
    if (!req.body || req.body.confirm !== true) throw new Error('Removing a symbol requires explicit confirmation');
    return { items: await desk.removeSymbol(req.body.symbol) };
  }));
  app.post('/api/watchlist/pause', wrap((req) => ({ items: desk.pauseSymbol(req.body && req.body.symbol) })));
  app.post('/api/watchlist/resume', wrap((req) => ({ items: desk.resumeSymbol(req.body && req.body.symbol) })));
  const listQ = (req) => ({ side: req.query.side || null, status: req.query.status || null, period: req.query.period || 'all', symbol: symQ(req), limit: Math.min(500, Number(req.query.limit) || 100), offset: Math.max(0, Number(req.query.offset) || 0) });
  app.get('/api/orders', wrap((req) => service.orders(listQ(req))));
  app.get('/api/trades', wrap((req) => service.fills(listQ(req))));
  app.get('/api/stats', wrap((req) => service.stats({ period: String(req.query.period || 'all') })));
  app.get('/api/report/:kind', wrap((req) => { if (!['daily', 'weekly', 'monthly'].includes(req.params.kind)) throw new Error('unknown report'); return service.report(req.params.kind); }));
  app.get('/api/ai/usage', wrap(() => service.ai()));
  app.get('/api/portfolio', wrap(() => service.portfolio()));
  app.get('/api/telegram/status', wrap(() => telegram.status()));
  app.post('/api/telegram/test', wrap(async () => telegram.sendTest()));
  app.get('/api/lab', wrap((req) => lab.status(symQ(req) || (desk.primary && desk.primary.symbol))));
  app.post('/api/lab/run', wrap((req) => {
    const b = req.body || {};
    const p = lab.run(b.symbol, { lang: b.lang === 'en' ? 'en' : 'ar' });
    p.catch(() => {}); // the page follows the steps; only an immediate refusal is an error here
    return Promise.race([p.then(() => ({ ok: true })), new Promise((r) => setTimeout(() => r({ ok: true, started: true }), 150))]);
  }));
  app.post('/api/lab/gate', wrap((req) => ({ on: lab.setGate(!!(req.body && req.body.on)) })));
  app.get('/api/invest', wrap(() => invest.status()));
  app.post('/api/invest/suggest', wrap((req) => invest.suggest(req.body)));
  app.post('/api/invest', wrap((req) => invest.create(req.body)));
  app.post('/api/invest/update', wrap((req) => invest.update(String((req.body && req.body.id) || ''), req.body)));
  app.post('/api/invest/cancel', wrap((req) => invest.cancel(String((req.body && req.body.id) || ''))));
  app.post('/api/invest/goal', wrap((req) => invest.addGoal(req.body)));
  app.post('/api/invest/goal/remove', wrap((req) => invest.removeGoal(String((req.body && req.body.id) || ''))));
  const investors = new InvestorService({ desk, lab, publicData, isCrypto, getBars: techBars, gatherImpl: (s) => require('./lab/facts').gather(s, { fetchImpl }) });
  app.get('/api/investors', wrap(() => investors.status()));
  const earningsDate = publicData ? async (s) => { const { data } = await fetchJson(`https://api.nasdaq.com/api/analyst/${encodeURIComponent(s)}/earnings-date`, { headers: { 'User-Agent': 'market-data-client/1.0' }, timeoutMs: 15000, fetchImpl }); return parseEarningsDate(data && data.data && data.data.announcement); } : null;
  let catalysts = [];
  try { catalysts = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'research-snapshot.json'), 'utf8')).catalysts || []; } catch { /* no dated events */ }
  opportunities = new OpportunityService({ store, desk, lab, investors, sharia, getBars: techBars, technical, catalysts, earningsDate, isCrypto, activity });
  const helper = new HelperService({ store, lab, activity, getBundle: async () => {
    if (!opportunities.scannedAt || Date.now() - opportunities.scannedAt > 120000) await opportunities.scan();
    const st = desk.primary.publicState(); const s = opportunities.status(); const h = marketHours((desk.stockAgent() || {}).calendar, Date.now());
    const now = Date.now(); const today = h.days.find((d) => d.open && now >= d.open && now < d.close); const next = h.days.find((d) => d.open && d.open > now); const open = !!today && !h.closedUntil;
    const inv = invest.status();
    return { session: s.session, live: s.live, wallet: st.portfolio || {}, positions: desk.positions().map((p) => ({ symbol: p.symbol, qty: p.qty, avgPrice: p.avgPrice, price: p.mark, unrealizedPnl: p.unrealizedPnl })), calls: s.items, record: s.record, hours: { open, closesAt: open ? today.close : null, opensAt: open ? null : h.closedUntil || (next && next.open) || null }, goals: ((inv && inv.goals) || []).map((g) => ({ name: g.name, target: g.amount, date: g.by })) };
  } });
  app.get('/api/opportunities', wrap(async () => { if (!opportunities.scannedAt) await opportunities.scan(); return opportunities.status(); }));
  app.post('/api/opportunities/scan', wrap(async () => { await opportunities.scan(); return opportunities.status(); }));
  app.post('/api/opportunities/review', wrap(async (req) => { await opportunities.review(req.body && req.body.symbol, req.body && req.body.lang); return opportunities.status(); }));
  app.get('/api/helper', wrap(() => helper.status()));
  app.post('/api/helper', wrap((req) => helper.ask(req.body)));
  app.post('/api/helper/clear', wrap(() => helper.clear()));
  app.get('/api/chart', wrap(async (req) => {
    const tf = String(req.query.tf || '1d');
    const symbol = symQ(req) || (desk.primary && desk.primary.symbol);
    if (!isValidTf(tf) && tf !== '1w') throw Object.assign(new Error('Invalid timeframe'), { status: 400 });
    const a = desk.agent(symbol);
    const price = a && a.market ? a.market.mark() : null;
    if (tf === '1d' || tf === '1w') { const { daily } = await techBars(symbol); return { symbol, live: a.dataMode === 'LIVE', ...chartbook.build(tf === '1w' ? technical.weekly(daily) : daily, { tf }) }; }
    if (!a) throw Object.assign(new Error('Add the symbol to your list first'), { status: 400 });
    return { symbol, live: a.dataMode === 'LIVE', ...chartbook.build((await desk.bars(symbol, tf)).bars, { tf, price }) };
  }));
  app.get('/api/technical', wrap(async (req) => {
    const { a, daily, hourly } = await techBars(symQ(req) || (desk.primary && desk.primary.symbol));
    const p = desk.book.portfolio && desk.book.portfolio.position(a.symbol);
    const r = technical.analyze({ daily, hourly, price: a.market && a.market.mark(), held: p ? p.qty : 0 });
    return { symbol: a.symbol, live: a.dataMode === 'LIVE', report: r };
  }));
  app.get('/api/technical/practice', wrap(async (req) => { const { daily } = await techBars(symQ(req)); return { item: technical.practice(daily, (Number(req.query.seed) >>> 0) || 1) }; }));
  app.get('/api/commands', wrap(() => commands.status()));
  app.post('/api/commands', wrap((req) => commands.add(req.body)));
  app.post('/api/commands/read', wrap((req) => commands.preview(req.body && req.body.text)));
  app.post('/api/commands/change', wrap((req) => commands.change(String((req.body && req.body.id) || ''), req.body)));
  app.post('/api/commands/cancel', wrap((req) => commands.cancel(String((req.body && req.body.id) || ''))));
  app.get('/api/plan', wrap(() => plan.status()));
  app.post('/api/plan', wrap((req) => plan.set(req.body)));
  app.post('/api/plan/toggle', wrap((req) => plan.toggle(!!(req.body && req.body.on))));
  app.post('/api/plan/answer', wrap((req) => plan.answer(String((req.body && req.body.id) || ''), !!(req.body && req.body.yes))));
  app.get('/api/plan/simulate', wrap(() => plan.simulate()));
  app.get('/api/equity', wrap(() => (agent.session ? store.listEquity(agent.session.id) : [])));
  app.get('/api/activity', wrap((req) => store.listActivity(agent.session ? agent.session.id : null, Math.min(2000, Number(req.query.limit) || 300))));
  app.get('/api/decisions', wrap((req) => (agent.session ? (symQ(req) ? store.listDecisionsBySymbol(agent.session.id, symQ(req), 100) : store.listDecisions(agent.session.id, 100)) : [])));
  app.get('/api/decisions/:id', wrap((req) => {
    const d = store.getDecision(req.params.id);
    if (!d) { const e = new Error('Not found'); e.status = 404; throw e; }
    return { ...d, snapshot: d.snapshotId ? store.getSnapshot(d.snapshotId) : null };
  }));
  app.get('/api/fills', wrap(() => (agent.session ? store.listFills(agent.session.id) : [])));
  app.get('/api/fills/:id', wrap((req) => {
    const f = agent.session ? store.listFills(agent.session.id).find((x) => x.id === req.params.id) : null;
    if (!f) { const e = new Error('Not found'); e.status = 404; throw e; }
    const d = f.decisionId ? store.getDecision(f.decisionId) : null;
    return { fill: f, decision: d };
  }));

  // ---------- controls
  app.post('/api/symbol/verify', wrap((req) => agent.verifySymbol(req.body.symbol, { demo: !!req.body.demo })));
  const symB = (req) => (req.body && req.body.symbol ? String(req.body.symbol).toUpperCase() : null);
  const target = (req) => desk.agent(symB(req) || symQ(req)) || agent;
  app.post('/api/symbol/change', wrap(async (req) => { await desk.changeSymbol(req.body.symbol, { demo: req.body.demo }); return desk.publicState(); }));
  app.post('/api/session/start', wrap(async (req) => { await desk.startTrading(req.body || {}); return desk.publicState(symB(req)); }));
  app.post('/api/ai/pause', wrap((req) => { desk.pause(); return desk.publicState(symB(req)); }));
  app.post('/api/ai/resume', wrap((req) => { desk.resume(); return desk.publicState(symB(req)); }));
  app.post('/api/ai/stop', wrap((req) => { desk.stop(); return desk.publicState(symB(req)); }));
  app.post('/api/ai/analyze', wrap((req) => {
    const a = target(req);
    if (!a.session) throw new Error('No active session');
    if (!a.scheduler.running) a.scheduler.running = true;
    const r = a.scheduler.trigger({ type: 'MANUAL', detail: 'user requested analysis' });
    if (a.aiState !== 'RUNNING') setTimeout(() => { if (a.aiState !== 'RUNNING' && !a.scheduler.inFlight && !a.scheduler.pending) a.scheduler.running = false; }, 1000);
    return { result: r, symbol: a.symbol };
  }));
  app.post('/api/position/close', wrap(async (req) => { const a = target(req); await a.closePosition(); return desk.publicState(a.symbol); }));
  app.post('/api/position/reduce', wrap((req) => {
    if (!req.body || req.body.confirm !== true) throw new Error('Reducing a position requires explicit confirmation');
    const a = target(req);
    a.reducePosition(req.body.qty);
    return desk.publicState(a.symbol);
  }));
  app.post('/api/risk/profile', wrap((req) => {
    const r = agent.setRiskProfile(String((req.body && req.body.profile) || ''));
    return { ...r, state: desk.publicState(symB(req)) };
  }));
  app.get('/api/risk/review', wrap(() => (agent.portfolio ? { at: Date.now(), ...agent.reviewRisk() } : null)));
  app.post('/api/session/reset', wrap(async (req) => {
    if (!req.body || req.body.confirm !== 'RESET') throw new Error('Reset requires confirmation: send {"confirm":"RESET"}');
    await desk.reset();
    return desk.publicState();
  }));
  app.post('/api/capital', wrap((req) => { agent.changeCapital(req.body || {}); return desk.publicState(symB(req)); }));
  app.post('/api/proposals/:id/:verdict', wrap((req) => {
    if (!['approve', 'reject'].includes(req.params.verdict)) throw new Error('verdict must be approve or reject');
    desk.approve(req.params.id, req.params.verdict === 'approve');
    return desk.publicState(symB(req));
  }));
  app.post('/api/risk/clear-disable', wrap(() => {
    if (!agent.risk) throw new Error('No session');
    agent.risk.clearDisable();
    activity.warn('User cleared the TRADING DISABLED (max drawdown) flag', { source: 'user' });
    agent.persist();
    return desk.publicState(symB(req));
  }));

  // ---------- settings & credentials
  // in a hosted account no part of a platform key is ever shown, not even masked
  const describeKeys = () => secrets.describe().map((c) => (gatewayToken && c.source === 'environment' ? { ...c, masked: '', source: 'platform' } : c));
  const platformKeys = !!gatewayToken && ['ALPACA_KEY_ID', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'TIINGO_API_KEY'].some((n) => env[n]);
  // what the platform keys pay for (data, AI use and budgets) is not the customer's to change
  const CUSTOMER_AI = ['autonomy'];
  app.get('/api/connections', wrap(() => ({ prices: publicData || !!(secrets.get('ALPACA_KEY_ID') && secrets.get('ALPACA_SECRET_KEY')), assistant: !!(secrets.get('DEEPSEEK_API_KEY') || secrets.get('GEMINI_API_KEY')), rules: !!publicData, filings: !!secrets.get('SEC_USER_AGENT') })));
  app.get('/api/settings', wrap(() => ({ config: config.get(), schema: config.editableSchema(), credentials: describeKeys() })));
  app.post('/api/settings', wrap((req) => {
    // hosted accounts must not choose addresses the server connects to, or host-wide limits
    const b = req.body || {};
    if (gatewayToken && ((b.news && 'customFeeds' in b.news) || (b.ai && 'baseUrl' in b.ai) || 'backups' in b || 'retention' in b || Object.keys(b).some((k) => k.includes('.')))) throw Object.assign(new Error('This setting is managed by the platform'), { status: 403 });
    if (platformKeys && (Object.keys(b).some((k) => ['market', 'tiingo', 'news', 'pricing', 'adaptiveMonitoring'].includes(k)) || Object.keys(b.ai || {}).some((k) => !CUSTOMER_AI.includes(k)))) throw Object.assign(new Error('This setting is managed by the platform'), { status: 403 });
    config.update(b); return { config: config.get() };
  }));
  app.get('/api/credentials', wrap(() => describeKeys()));
  app.post('/api/credentials', wrap((req) => {
    const { name, value } = req.body || {};
    if (!SecretStore.isKnown(name)) throw new Error('Unknown credential name');
    if (gatewayToken && env[name]) throw Object.assign(new Error('This key is managed by the platform'), { status: 403 });
    secrets.set(name, value);
    activity.info('SYSTEM', `Credential ${CREDENTIALS[name].label} saved (encrypted local store)`, { source: 'user' });
    if (name === 'ALPACA_KEY_ID' || name === 'ALPACA_SECRET_KEY') agent.invalidateProviders();
    agent.credentialsChanged(name);
    if (name === 'TELEGRAM_BOT_TOKEN') telegram.restart();
    return describeKeys();
  }));
  app.delete('/api/credentials/:name', wrap((req) => {
    if (!SecretStore.isKnown(req.params.name)) throw new Error('Unknown credential');
    secrets.delete(req.params.name);
    activity.info('SYSTEM', `Credential ${req.params.name} removed from local store`, { source: 'user' });
    return describeKeys();
  }));
  app.post('/api/test/gemini', wrap(async () => {
    const key = secrets.get('GEMINI_API_KEY');
    if (!key) throw new Error('Gemini API key not configured');
    const c = new GeminiClient({ apiKey: key, baseUrl: config.get().ai.gemini.baseUrl, fetchImpl });
    const models = await c.listModels();
    activity.ok('AI', `Gemini connection OK: ${models.length} models available`, { source: 'generativelanguage.googleapis.com' });
    return { ok: true, models };
  }));
  app.post('/api/test/tiingo', wrap(async () => {
    const key = secrets.get('TIINGO_API_KEY');
    if (!key) throw new Error('Tiingo API token not configured');
    const { data } = await fetchJson(`${config.get().tiingo.baseUrl}/tiingo/equity/intraday?tickers=spy`, { headers: { Authorization: `Token ${key}` }, timeoutMs: 15000, fetchImpl });
    const r = Array.isArray(data) ? data[0] : null;
    activity.ok('MARKET', `Tiingo connection OK: SPY reference ${r && r.tngoLast != null ? r.tngoLast : 'n/a'}`, { source: 'api.tiingo.com' });
    return { ok: true, sample: r ? { ticker: r.ticker, tngoLast: r.tngoLast, timestamp: r.timestamp } : null };
  }));
  app.post('/api/test/deepseek', wrap(async () => {
    const key = secrets.get('DEEPSEEK_API_KEY');
    if (!key) throw new Error('DeepSeek API key not configured');
    const c = new DeepSeekClient({ apiKey: key, baseUrl: config.get().ai.baseUrl, fetchImpl });
    const [models, balance] = await Promise.all([c.listModels(), c.getBalance().catch((e) => ({ error: e.message }))]);
    activity.ok('AI', `DeepSeek connection OK: ${models.length} models available (${models.map((m) => m.id).join(', ')})`, { source: 'api.deepseek.com' });
    return { ok: true, models, balance };
  }));
  app.post('/api/test/alpaca', wrap(async () => {
    const keyId = secrets.get('ALPACA_KEY_ID');
    const secret = secrets.get('ALPACA_SECRET_KEY');
    if (!keyId || !secret) throw new Error('Alpaca key ID and secret are required');
    const m = config.get().market;
    const p = new AlpacaProvider({ keyId, secretKey: secret, feed: m.feed, cfg: m, fetchImpl });
    const clock = await p.fetchClock();
    let snap = null; let snapErr = null;
    try { snap = await p.fetchSnapshot('SPY'); } catch (e) { snapErr = e.message; }
    activity.ok('MARKET', `Alpaca connection OK: market ${clock.is_open ? 'OPEN' : 'CLOSED'}; data feed ${m.feed}${snapErr ? ` (snapshot error: ${snapErr})` : ''}`, { source: 'Alpaca' });
    return { ok: true, clock, feed: p.feedInfo(), spy: snap && snap.latestTrade ? snap.latestTrade : null, snapshotError: snapErr };
  }));
  app.post('/api/test/sec', wrap(async () => {
    const ua = secrets.get('SEC_USER_AGENT');
    if (!ua) throw new Error('SEC_USER_AGENT not configured');
    const { data } = await fetchJson('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': ua }, timeoutMs: 20000, fetchImpl });
    return { ok: true, companies: Object.keys(data || {}).length };
  }));
  app.get('/api/research', wrap(() => JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'research-snapshot.json'), 'utf8'))));
  // ---------- Sharia screen
  const shariaSym = (req) => String((req.body && req.body.symbol) || '').trim().toUpperCase();
  app.get('/api/sharia', wrap(() => ({
    enabled: config.get().sharia.enabled, limits: config.get().sharia, secConfigured: sharia.canScreen(), filings: !!secrets.get('SEC_USER_AGENT'), mode: config.get().sharia.mode,
    items: [...new Set([...desk.all().map((a) => a.symbol), ...Object.keys(sharia.rulings)])].map((s) => sharia.effective(s)),
  })));
  app.post('/api/sharia/screen', wrap((req) => sharia.screen(shariaSym(req))));
  app.post('/api/sharia/ruling', wrap((req) => sharia.setRuling(shariaSym(req), req.body || {})));
  app.post('/api/sharia/ruling/clear', wrap((req) => sharia.clearRuling(shariaSym(req))));
  app.get('/api/models', wrap(async () => {
    if (config.get().ai.provider === 'gemini') {
      const gk = secrets.get('GEMINI_API_KEY');
      if (!gk) return { models: [], provider: 'gemini', note: 'Configure the Gemini key to list models' };
      return { provider: 'gemini', models: await new GeminiClient({ apiKey: gk, baseUrl: config.get().ai.gemini.baseUrl, fetchImpl }).listModels() };
    }
    const key = secrets.get('DEEPSEEK_API_KEY');
    if (!key) return { models: [], note: 'Configure the DeepSeek key to list models' };
    const c = new DeepSeekClient({ apiKey: key, baseUrl: config.get().ai.baseUrl, fetchImpl });
    return { models: await c.listModels() };
  }));

  // ---------- operations: states, AI mode, events catch-up, health, resources, backups
  app.get('/api/ops/states', wrap(() => ({ ...desk.operatingStates(), server: health().server })));
  app.get('/api/monitoring', wrap(() => service.monitoring()));
  app.post('/api/ops/monitoring', wrap((req) => desk.setMonitoring(!!(req.body && req.body.active), 'web dashboard')));
  app.get('/api/ai/providers', wrap(() => desk.book.aiManager.status()));
  app.post('/api/ai/mode', wrap(async (req) => { await service.setAiMode(req.body && req.body.mode, 'web dashboard'); return desk.book.aiManager.status(); }));
  app.get('/api/events', wrap((req) => {
    const after = Math.max(0, Number(req.query.after) || 0);
    const limit = Math.min(500, Number(req.query.limit) || 200);
    const latestSeq = store.latestEventSeq();
    return { latestSeq, items: store.listAppEvents({ afterSeq: req.query.latest ? Math.max(0, latestSeq - limit) : after, limit }) };
  }));
  app.get('/api/system/health', wrap(() => health()));
  app.get('/api/system/resources', wrap(() => resources()));
  app.get('/api/admin/integrity', wrap(() => ({
    quickCheck: store.quickCheck(), schemaVersion: SCHEMA_VERSION, migration: store.migration, counts: store.counts(),
    accounting: M.reconcileSession(store, desk.book.session ? store.getSession(desk.book.session.id) : store.getActiveSession()),
  })));
  app.get('/api/admin/backups', wrap(() => ({ dir: memory ? null : rt.backupDir, items: M.listBackups(rt.backupDir), last: store.getSetting('backups.last', null) })));
  app.post('/api/admin/backups', wrap(() => {
    if (memory) throw new Error('In-memory database: nothing to back up');
    const b = M.createBackup(store, rt.backupDir, 'manual');
    activity.ok('SYSTEM', `Database backup created: ${path.basename(b.file)} (${(b.bytes / 1048576).toFixed(2)} MB, verified)`, { source: 'backup' });
    return { name: path.basename(b.file), bytes: b.bytes, counts: b.counts };
  }));
  app.get('/api/admin/backup.db', (req, res) => {
    if (memory) return res.status(400).json({ error: 'In-memory database' });
    const tmp = path.join(os.tmpdir(), `forsah-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try { store.backupTo(tmp); } catch (e) { return res.status(500).json({ error: redactor.redactString(e.message) }); }
    activity.info('SYSTEM', 'Database backup downloaded from the dashboard', { source: 'backup' });
    res.download(tmp, `forsah-${new Date().toISOString().slice(0, 10)}.db`, () => { fs.unlink(tmp, () => {}); });
  });

  // ---------- exports
  app.get('/api/export/trades.csv', (req, res) => {
    const q = { ...req.query };
    const fills = (agent.session ? store.listFills(agent.session.id) : []).filter((f) => (!q.symbol || f.symbol === String(q.symbol).toUpperCase()) && (!q.side || f.side === q.side)
      && (!q.from || f.ts >= Date.parse(q.from)) && (!q.to || f.ts <= Date.parse(q.to) + 86400000) && (!q.result || (q.result === 'profit' ? f.realizedPnl > 0 : q.result === 'loss' ? f.realizedPnl < 0 : true)) && (!q.strategy || f.strategy === q.strategy));
    const cols = ['id', 'order_id', 'time_utc', 'time_et', 'symbol', 'side', 'qty', 'price', 'fees', 'realized_pnl', 'return_pct', 'order_type', 'status', 'kind', 'strategy', 'confidence', 'risk_profile', 'decision_id', 'data_source', 'reason'];
    const rows = fills.map((f) => [f.id, f.orderId || '', new Date(f.ts).toISOString(), `${etDateStr(f.ts)} ${etTimeStr(f.ts)}`, f.symbol, f.side, f.qty, f.price, f.fees, f.realizedPnl, f.returnPct ?? '', f.orderType, f.status, f.kind, f.strategy, f.confidence, f.riskProfile || '', f.decisionId, f.dataSource, f.reason]);
    res.set('Content-Disposition', `attachment; filename="paper-trades-session-${agent.session ? agent.session.id : 'none'}.csv"`);
    res.type('text/csv').send([cols.join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\r\n'));
  });
  app.get('/api/export/activity.json', (req, res) => {
    const out = {
      exportedAt: new Date().toISOString(), session: agent.session ? { id: agent.session.id, symbol: agent.session.symbol, dataMode: agent.session.dataMode } : null,
      activity: store.listActivity(agent.session ? agent.session.id : null, 100000),
      decisions: agent.session ? store.listDecisions(agent.session.id, 100000) : [],
    };
    res.set('Content-Disposition', `attachment; filename="ai-activity-session-${agent.session ? agent.session.id : 'none'}.json"`);
    res.type('application/json').send(JSON.stringify(out, null, 2));
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  const server = http.createServer(app);
  const wss = new WebSocketServer({
    server, path: '/ws', maxPayload: 64 * 1024,
    verifyClient: ({ origin, req }) => {
      if (!viaGateway(req.headers)) return false;
      const a = allowed();
      if (!a.hosts.has(String(req.headers.host || '').toLowerCase()) || (origin && !a.origins.has(origin))) return false;
      return !auth.enabled() || !!auth.sessionFrom(req.headers.cookie);
    },
  });
  const clients = new Set();
  const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const broadcast = (msg) => { const s = JSON.stringify(msg); for (const c of clients) if (c.ws.readyState === 1) c.ws.send(s); };

  wss.on('connection', (ws, req) => {
    const client = { ws, tf: '1m', symbol: null, lastBarKey: null, cookie: req.headers.cookie || '' };
    clients.add(client);
    send(ws, { type: 'hello', state: desk.publicState(null), activity: activity.recent(400), latestEventSeq: store.latestEventSeq() });
    ws.on('message', (raw) => {
      let m;
      try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.type === 'subscribe' && isValidTf(m.tf)) {
        client.tf = m.tf; client.lastBarKey = null;
        if (typeof m.symbol === 'string' && (/^[A-Z][A-Z0-9.]{0,9}$/.test(m.symbol) || isCrypto(m.symbol))) client.symbol = m.symbol;
        send(ws, { type: 'state', state: desk.publicState(client.symbol) });
      }
    });
    ws.on('close', () => clients.delete(client));
    ws.on('error', () => clients.delete(client));
  });

  activity.on('event', (evt) => broadcast({ type: 'activity', event: evt }));
  desk.on('fill', (f) => broadcast({ type: 'fill', fill: f }));
  desk.on('decision', (d) => broadcast({ type: 'decision', decision: { id: d.id, ts: d.ts, symbol: d.symbol, action: d.action, status: d.status, confidence: d.confidence, strategy: d.strategy, proposal: d.proposal } }));
  desk.on('aiProgress', (p) => broadcast({ type: 'aiProgress', progress: p }));
  desk.on('equity', (p) => broadcast({ type: 'equity', point: p }));
  // every application event is persisted with a sequence number so a reconnecting dashboard can catch up
  service.on('event', (e) => {
    let seq = null;
    try { seq = store.insertAppEvent(e); } catch { seq = null; }
    if (seq == null && e.id && !/^evt_/.test(String(e.id))) return; // stable id already recorded: a repeat of the same event
    broadcast({ type: 'appEvent', event: { seq, id: e.id, type: e.type, ts: e.ts, symbol: e.symbol, priority: e.priority } });
  });
  service.healthProvider = () => health();
  config.on('change', (cfg, patch) => { if (patch.telegram) telegram.restart(); if (patch.sharia) setTimeout(shariaSweep, 50).unref(); });

  let lastStateAt = 0;
  const pushTimer = setInterval(() => {
    const now = Date.now();
    const agents = desk.all().length ? desk.all() : [agent];
    for (const a of agents) {
      if (!a.dirty.candles || !a.candles) continue;
      a.dirty.candles = false;
      for (const c of clients) {
        if ((desk.agent(c.symbol) || agent) !== a) continue;
        const bar = a.candles.currentBar(c.tf);
        if (!bar) continue;
        const key = `${a.symbol}|${bar.time}|${bar.close}|${bar.high}|${bar.low}|${bar.volume}`;
        if (key === c.lastBarKey) continue;
        c.lastBarKey = key;
        send(c.ws, { type: 'candle', tf: c.tf, symbol: a.symbol, bar });
      }
    }
    const dirty = agents.some((a) => a.dirty.state);
    if (dirty || now - lastStateAt > 2000) {
      for (const a of agents) a.dirty.state = false;
      lastStateAt = now;
      if (clients.size) {
        const bySym = new Map();
        for (const c of clients) {
          const key = (desk.agent(c.symbol) || agent).symbol || '';
          if (!bySym.has(key)) bySym.set(key, JSON.stringify({ type: 'state', state: desk.publicState(key || null) }));
          if (c.ws.readyState === 1) c.ws.send(bySym.get(key));
        }
      }
    }
  }, 250);
  if (pushTimer.unref) pushTimer.unref();
  // signed-out sessions lose their live connection too
  const wsAuthTimer = setInterval(() => {
    if (!auth.enabled()) return;
    for (const c of clients) if (!auth.sessionFrom(c.cookie)) { try { c.ws.close(4401, 'session expired'); } catch { /* ignore */ } }
  }, 60000);
  if (wsAuthTimer.unref) wsAuthTimer.unref();

  // ---------- health & resources
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  let cpuPrev = { t: Date.now(), u: process.cpuUsage() };
  let cpuPct = null;
  const cpuTimer = setInterval(() => {
    const t = Date.now(); const u = process.cpuUsage();
    cpuPct = (((u.user - cpuPrev.u.user) + (u.system - cpuPrev.u.system)) / 1000 / Math.max(1, t - cpuPrev.t)) * 100;
    cpuPrev = { t, u };
  }, 10000);
  if (cpuTimer.unref) cpuTimer.unref();

  function health() {
    const comps = {};
    comps.database = dbOk ? { state: 'ok', detail: `${store.pg ? 'PostgreSQL' : 'SQLite'} schema v${SCHEMA_VERSION}` } : { state: 'error', detail: `integrity check failed: ${integrity.slice(0, 2).join('; ')}` };
    const st = desk.book.startup || {};
    if (dbOk && st.accountingOk === false) comps.database = { state: 'degraded', detail: `accounting check: ${(st.problems || []).slice(0, 2).join('; ')}` };
    comps.engine = stopping ? { state: 'degraded', detail: 'shutting down' } : ready ? { state: 'ok', detail: `${desk.all().length} symbol(s) monitored` } : { state: 'degraded', detail: 'starting' };
    const md = desk.primary.market;
    const keys = !!(secrets.get('ALPACA_KEY_ID') && secrets.get('ALPACA_SECRET_KEY'));
    if (desk.dataMode === 'DEMO') comps.alpaca = { state: 'idle', detail: 'DEMO synthetic data (Alpaca not used)' };
    else if (!keys) comps.alpaca = { state: 'not_configured', detail: 'Alpaca keys not set' };
    else if (!md) comps.alpaca = { state: 'idle', detail: 'no symbol loaded' };
    else {
      const cs = md.connection.state;
      const ds = desk.primary.market ? md.dataStatus(Date.now(), desk.primary.sessionInfo(), desk.primary.statusOpts()) : null;
      comps.alpaca = { state: cs === 'SUBSCRIBED' ? 'ok' : cs === 'UNAVAILABLE' ? 'error' : 'degraded', detail: `${cs}${ds ? ` — ${ds.label}` : ''}` };
    }
    const ref = desk.reference.summary();
    const tk = !!secrets.get('TIINGO_API_KEY');
    comps.tiingo = !tk ? { state: 'not_configured', detail: 'optional Tiingo token not set' } : ref.status.tiingo.lastError ? { state: 'degraded', detail: ref.status.tiingo.lastError } : { state: ref.active ? 'ok' : 'idle', detail: ref.status.tiingo.lastOkAt ? `last reference ${new Date(ref.status.tiingo.lastOkAt).toISOString()}` : 'used only outside regular hours' };
    const ai = desk.book.aiManager.status();
    for (const id of ['deepseek', 'gemini']) {
      const x = ai.providers[id];
      comps[id] = !x.configured ? { state: 'not_configured', detail: 'API key not set' } : x.state === 'PAUSED_AFTER_ERRORS' ? { state: 'error', detail: `${x.lastErrorCode}: paused until ${new Date(x.openUntil).toISOString()}` } : { state: 'ok', detail: `${x.model} · ${x.requestsToday} request(s) today` };
    }
    const tg = telegram.status();
    comps.telegram = !tg.enabled ? { state: 'disabled', detail: 'Telegram bot disabled in settings' } : !tg.configured ? { state: 'not_configured', detail: 'bot token not set' } : tg.running ? { state: tg.lastError ? 'degraded' : 'ok', detail: tg.lastError || `${tg.sentToday || 0} message(s) sent today` } : { state: 'error', detail: tg.loadError || 'not running' };
    const news = desk.primary.news ? desk.primary.news.sourcesStatus() : [];
    const nErr = news.filter((x) => x.state === 'error');
    comps.news = !news.length || !news.some((x) => x.state === 'ok' || x.state === 'error') ? { state: 'idle', detail: news.length ? 'no source polled yet' : 'no symbol' } : nErr.length === news.filter((x) => x.state !== 'disabled').length && nErr.length ? { state: 'error', detail: nErr.map((x) => x.name).join(', ') } : nErr.length ? { state: 'degraded', detail: `errors: ${nErr.map((x) => x.name).join(', ')}` } : { state: 'ok', detail: `${news.filter((x) => x.state === 'ok').length} source(s) OK` };
    const reasons = [];
    if (comps.database.state === 'error') reasons.push('database integrity');
    if (ready && comps.engine.state !== 'ok') reasons.push('engine');
    if (comps.alpaca.state === 'error' && !desk.book.monitoringPaused) reasons.push('market data');
    if (desk.book.aiState === 'RUNNING' && desk.dataMode === 'LIVE' && !desk.primary.deciderOverride && ['deepseek', 'gemini'].every((id) => comps[id].state !== 'ok')) reasons.push('no AI provider available');
    if (comps.telegram.state === 'error') reasons.push('Telegram');
    return { server: { state: reasons.length ? 'DEGRADED' : 'ONLINE', reasons, startedAt, ready }, components: comps, operating: desk.operatingStates() };
  }

  function resources() {
    const mem = process.memoryUsage();
    const ai = desk.book.aiManager.status();
    let subs = 0;
    for (const p of desk.book.providers.values()) subs += p && p.users ? p.users.size : 0;
    const tg = telegram.status();
    return {
      at: Date.now(), uptimeSec: Math.round(process.uptime()), node: process.version, platform: `${process.platform}/${process.arch}`,
      memory: { rssMb: +(mem.rss / 1048576).toFixed(1), heapUsedMb: +(mem.heapUsed / 1048576).toFixed(1), heapTotalMb: +(mem.heapTotal / 1048576).toFixed(1) },
      cpuPct: cpuPct == null ? null : +cpuPct.toFixed(1), eventLoopDelayMs: +(loopDelay.mean / 1e6).toFixed(2),
      database: { file: memory ? ':memory:' : path.basename(rt.dbFile), ...store.sizeBytes(), schemaVersion: SCHEMA_VERSION, lastBackup: store.getSetting('backups.last', null) },
      websocketClients: clients.size, monitoredSymbols: desk.all().length, marketDataConnections: desk.book.providers.size, marketSubscriptions: subs, dataMode: desk.dataMode,
      scheduler: desk.all().map((a) => ({ symbol: a.symbol, running: !!a.scheduler.running, inFlight: !!a.scheduler.inFlight, pending: !!a.scheduler.pending, paused: !!a.monitoringPaused })),
      queues: { telegramQueued: tg.queued || 0, telegramFailed: tg.failed || 0 },
      ai: { mode: ai.mode, deepseek: { requestsToday: ai.providers.deepseek.requestsToday, costTodayUsd: ai.providers.deepseek.costTodayUsd }, gemini: { requestsToday: ai.providers.gemini.requestsToday, costTodayUsd: ai.providers.gemini.costTodayUsd } },
      dataProviders: desk.watchlist().map((w) => ({ symbol: w.symbol, provider: w.provider, dataLabel: w.dataLabel, fresh: w.fresh, priceTs: w.priceTs })),
      reference: desk.reference.summary(),
      note: 'Process metrics measured inside the app. They are not your Railway invoice: hosting, AI and market-data charges are billed separately by each provider.',
    };
  }

  // ---------- scheduled maintenance: verified backups + retention (single instance, in-process)
  function maintenanceTick() {
    if (memory || stopping) return;
    const c = config.get();
    const now = Date.now();
    if (c.backups && c.backups.enabled && !store.pg) {
      const last = store.getSetting('backups.last', null);
      if (!last || now - last.at > c.backups.intervalHours * 3600000) {
        try {
          const b = M.createBackup(store, rt.backupDir, 'scheduled');
          store.setSetting('backups.last', { at: now, name: path.basename(b.file), bytes: b.bytes });
          const removed = M.pruneBackups(rt.backupDir, c.backups.keep);
          activity.info('SYSTEM', `Scheduled database backup ${path.basename(b.file)} verified (${(b.bytes / 1048576).toFixed(2)} MB)${removed.length ? `; ${removed.length} old backup(s) removed` : ''}`, { source: 'backup' });
        } catch (e) { activity.error(`Scheduled database backup failed: ${e.message}`, { source: 'backup' }); }
      }
    }
    const lastPrune = store.getSetting('retention.last', 0);
    if (now - lastPrune > 24 * 3600000) {
      const r = c.retention || {};
      try {
        const out = store.prune({ activityBefore: now - (r.activityDays || 90) * 86400000, eventsBefore: now - (r.eventsDays || 30) * 86400000, snapshotsBefore: now - (r.snapshotsDays || 30) * 86400000 });
        store.setSetting('retention.last', now);
        if (out.activity || out.events || out.snapshots) activity.info('SYSTEM', `Retention: removed ${out.activity} activity row(s), ${out.events} event(s), ${out.snapshots} market snapshot(s); trades, orders and decisions are never pruned`, { source: 'maintenance' });
      } catch (e) { activity.error(`Retention job failed: ${e.message}`, { source: 'maintenance' }); }
    }
  }
  let maintTimer = null;

  // ---------- startup: storage checks → engine recovery → Telegram → ready
  async function start() {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(PORT, HOST, resolve);
    });
    const shown = rt.baseUrl || `http://${HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST}:${server.address().port}`;
    activity.info('SYSTEM', `AI Trading Terminal listening on ${HOST}:${server.address().port} (${shown}) — PAPER TRADING ONLY (no brokerage orders are ever sent)${auth.enabled() ? ' — dashboard login required' : ''}`, { source: 'server' });
    const run = M.markRunStart(store, Date.now());
    // verify the books BEFORE the engine may resume: the stored balances must match the recorded fills
    const problems = [];
    if (!dbOk) problems.push(`database integrity: ${integrity.slice(0, 2).join('; ')}`);
    let rec = null;
    try { rec = M.reconcileSession(store, store.getActiveSession()); } catch (e) { rec = { ok: false, problems: [e.message] }; }
    if (rec && !rec.ok) { problems.push(...rec.problems.map((x) => `accounting: ${x}`)); activity.error(`Accounting check FAILED: ${rec.problems.join('; ')}`, { source: 'startup checks' }); }
    else if (rec && rec.sessionId) activity.ok('SYSTEM', `Accounting check passed: cash and positions of session #${rec.sessionId} match its ${rec.fills} recorded fill(s)`, { source: 'startup checks' });
    desk.book.startup = { dbOk, accountingOk: !rec || rec.ok, problems };
    try {
      await desk.init();
    } catch (e) {
      activity.error(`Engine start failed: ${e.message}`, { source: 'startup' });
      throw e;
    }
    // wait (briefly) for the bot to subscribe, so the startup alerts below reach Telegram
    await Promise.race([telegram.start(), new Promise((r) => { const t = setTimeout(r, 5000); if (t.unref) t.unref(); })]);
    maintTimer = setInterval(maintenanceTick, 3600000);
    if (maintTimer.unref) maintTimer.unref();
    setTimeout(maintenanceTick, 60000).unref?.();
    ready = true;
    if (run.unclean) {
      activity.warn(`The previous run (started ${new Date(run.previousStartedAt).toISOString()}) ended without a clean shutdown — state was restored from the database; no fills are reconstructed for the downtime`, { source: 'startup' });
      desk.emitEvent('ENGINE_UNCLEAN_RESTART', null, { previousStartedAt: run.previousStartedAt }, 'high', `unclean:${run.previousStartedAt}`);
    }
    desk.emitEvent('ENGINE_STARTED', null, { symbols: desk.all().map((a) => a.symbol), aiMode: desk.book.aiManager.mode() }, 'low', `started:${startedAt}`);
    const os2 = desk.operatingStates();
    activity.ok('SYSTEM', `Startup complete: ${desk.all().length} symbol(s) restored, monitoring ${os2.monitoring.state}, AI trading ${os2.aiTrading.state}, AI mode ${desk.book.aiManager.mode()}`, { source: 'startup' });
    return server.address().port;
  }

  /** Graceful stop: no new proposals, finish/record in-flight work, persist, disconnect, close. */
  async function stop({ timeoutMs = rt.shutdownTimeoutMs } = {}) {
    if (stopping) return stopping;
    stopping = (async () => {
      desk.book.shuttingDown = true;
      ready = false;
      clearInterval(pushTimer); clearInterval(wsAuthTimer); clearInterval(cpuTimer); if (maintTimer) clearInterval(maintTimer);
      try { activity.info('SYSTEM', 'Shutting down: new proposals are refused; waiting for in-flight work, then saving state', { source: 'server' }); } catch { /* ignore */ }
      for (const a of desk.all()) a.scheduler.stop();
      telegram.stop();
      clearInterval(oppTimer); clearInterval(labTimer); clearInterval(planTimer); clearInterval(investTimer);
      lab.stop();
      // an analysis that is already running may finish; its proposal is refused because shuttingDown is set
      await Promise.race([desk.book.lock.tail, new Promise((r) => { const t = setTimeout(r, Math.min(10000, timeoutMs / 2)); if (t.unref) t.unref(); })]);
      try { await desk.shutdown(); } catch { /* best effort: state is persisted on every change */ }
      try { M.markCleanShutdown(store, Date.now()); } catch { /* ignore */ }
      for (const c of clients) { try { c.ws.terminate(); } catch { /* ignore */ } }
      loopDelay.disable();
      await new Promise((r) => wss.close(() => r()));
      if (server.closeIdleConnections) server.closeIdleConnections();
      await Promise.race([new Promise((r) => server.close(() => r())), new Promise((r) => { const t = setTimeout(() => { if (server.closeAllConnections) server.closeAllConnections(); r(); }, 3000); if (t.unref) t.unref(); })]);
      store.close();
    })();
    return stopping;
  }

  /** A demo opens with a wallet that already follows a few invented markets. */
  async function openDemo() {
    if (!demoOnly) return;
    config.update({ ai: { autonomy: 'SEMI' } });
    await desk.startTrading({ symbol: 'NVDA', initialCapital: 10000, demo: true });
    for (const s of ['AAPL', 'MSFT', 'BTC/USD']) { try { await desk.addSymbol(s); } catch (e) { activity.warn(`${s} was not added: ${e.message}`); } }
  }

  return { openDemo, app, server, wss, agent, desk, service, telegram, store, config, secrets, activity, auth, runtime: rt, start, stop, health, resources, setTelegramChat(id) { relayChat = id || null; telegram.restart(); } };
}

/**
 * Telegram companion (server/telegram). Loaded defensively: if the module is missing or fails, the terminal
 * keeps working and the status endpoint reports why.
 */
function createTelegramSafe({ store, service, config, getConfig = () => config.get(), secrets, redactor, activity, fetchImpl, relay = false }) {
  let impl = null;
  let loadError = null;
  try {
    const { createTelegram } = require('./telegram');
    impl = createTelegram({
      store, service, getConfig, getToken: () => secrets.get('TELEGRAM_BOT_TOKEN'), fetchImpl, relay,
      log: (level, message) => {
        const msg = redactor.redactString(String(message));
        if (level === 'error') activity.error(`Telegram: ${msg}`, { source: 'Telegram' });
        else if (level === 'warn') activity.warn(`Telegram: ${msg}`, { source: 'Telegram' });
        else activity.info('SYSTEM', `Telegram: ${msg}`, { source: 'Telegram' });
      },
    });
  } catch (e) { loadError = e.message; }
  let running = false;
  return {
    start() {
      if (!(impl && getConfig().telegram.enabled && secrets.get('TELEGRAM_BOT_TOKEN') && !running)) return Promise.resolve();
      running = true;
      return Promise.resolve(impl.start()).then((r) => { running = !!(r && r.started); if (r && !r.started && r.reason === 'error') loadError = 'start failed'; }).catch((e) => { running = false; loadError = e.message; });
    },
    stop() { if (impl && running) { try { impl.stop(); } catch { /* ignore */ } running = false; } },
    restart() { this.stop(); this.start(); },
    notify(e) { if (impl && running) { try { impl.notify(e); } catch { /* never break trading */ } } }, // the bot also subscribes to service events itself
    update(u) { if (impl && running) Promise.resolve(impl.handleUpdate(u)).catch(() => {}); },
    async sendTest() {
      if (!impl) throw new Error(`Telegram module unavailable: ${loadError || 'not installed'}`);
      if (!secrets.get('TELEGRAM_BOT_TOKEN')) throw new Error('Telegram bot token is not configured');
      return impl.sendTest();
    },
    status() { return { available: !!impl, loadError, running, configured: !!secrets.get('TELEGRAM_BOT_TOKEN'), enabled: !!getConfig().telegram.enabled, ...(impl && running ? impl.status() : {}) }; },
  };
}

module.exports = { createTerminal, csvEscape };
