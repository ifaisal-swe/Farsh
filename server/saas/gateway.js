'use strict';
/**
 * Hosted platform: landing page, closed registration and one isolated trading terminal per account.
 *
 * Every account gets its own process (supervisor.js) with its own database, encryption key and API keys, bound to
 * loopback on a random port. The terminal accepts only requests carrying its private gateway token, so another
 * local process (or a request forged from inside another account) cannot reach it. Operator environment
 * secrets are never passed on; the operator's service keys are, within the limits of services.js.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { parseCookies } = require('../auth');
const { resolveRuntime } = require('../runtime');
const { Accounts } = require('./accounts');
const { Supervisor } = require('./supervisor');
const { Provisioner } = require('./provision');
const { PlatformServices } = require('./services');
const { TelegramHub } = require('./telegramHub');
const { Demos, COOKIE: DEMO } = require('./demo');
const { explain } = require('./dbLog');

const COOKIE = 'dt_account';
const { sendWebPage, webAssets, brandAssets, ASSETS } = require('../webpage');
const HOP = ['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'expect'];
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Never show an empty account while the real one is still in a file of an older version. */
function refuseOldData(file) {
  if (fs.existsSync(file) && !fs.existsSync(`${file}.migrated`)) throw Object.assign(new Error(`${file} holds data of an older version that was never moved to PostgreSQL: move it with version d715aa4 (npm run pg:import) or put the file elsewhere`), { code: 'CONFIG' });
}

function createGateway({ env = process.env, port, dataDir, supervisor = {}, now = Date.now, telegramFetch } = {}) {
  const rt = resolveRuntime(env);
  const root = path.resolve(dataDir || env.SAAS_DATA_DIR || path.join(rt.dataDir, 'saas'));
  if (!env.SAAS_ADMIN_EMAIL || !env.SAAS_ADMIN_PASSWORD) throw Object.assign(new Error('SAAS_ADMIN_EMAIL and SAAS_ADMIN_PASSWORD must be set'), { code: 'CONFIG' });
  if (rt.remote && !rt.publicHosts.length) throw Object.assign(new Error('APP_BASE_URL must be set for the hosted platform'), { code: 'CONFIG' });
  const maxTenants = Math.max(1, Number(env.SAAS_MAX_TENANTS) || 25);
  const databaseUrl = env.SAAS_DATABASE_URL || env.DATABASE_URL;
  if (!databaseUrl) throw Object.assign(new Error('DATABASE_URL must be set (PostgreSQL)'), { code: 'CONFIG' });
  const sessionMs = Math.min(90, Math.max(1, Number(env.SAAS_SESSION_DAYS) || 30)) * 86400000; // people stay signed in on their device
  const accounts = new Accounts({ url: databaseUrl, schema: env.SAAS_DATABASE_SCHEMA || 'control', keyDir: root, now, idleMs: sessionMs, maxMs: sessionMs });

  // ------------------------------------------------------------------ tenants
  const prefix = env.SAAS_TENANT_PREFIX || 't';
  const provisioner = new Provisioner({ url: databaseUrl, keyDir: root, prefix });
  const demoSpace = new Provisioner({ url: databaseUrl, keyDir: root, prefix: `${prefix}demo` });
  // prices read from public pages without keys are for personal use: off unless the operator turns them on
  const PUBLIC = ['operator', 'everyone'].includes(env.SAAS_PUBLIC_DATA) ? env.SAAS_PUBLIC_DATA : 'off';
  const services = new PlatformServices({ dir: root, env });
  const botToken = services.values().TELEGRAM_BOT_TOKEN || null;
  const options = async (id) => {
    const u = await accounts.byId(id);
    return { labModel: { url: env.LAB_MODEL_URL || null, modelId: env.LAB_MODEL_NAME || null, openrouter: env.OPENROUTER_MODEL || null }, publicData: PUBLIC === 'everyone' || (PUBLIC === 'operator' && !!u && u.role === 'ADMIN'), services: services.forAccount(u && u.role, u && u.email), telegram: botToken ? { chatId: await accounts.telegramChat(id) } : null };
  };
  const tenants = new Supervisor({ options, prepare: async (id) => { refuseOldData(path.join(root, 'tenants', id, 'terminal.db')); return provisioner.ensure(id); }, root: path.join(root, 'tenants'), max: maxTenants, memoryMb: Math.max(128, Number(env.SAAS_TENANT_MEMORY_MB) || 384), ...supervisor });
  const sockets = new Map(); // user id -> Set<socket>
  let stopping = false;
  const closeSockets = (id) => { for (const s of sockets.get(id) || []) s.destroy(); sockets.delete(id); };
  const maxDemos = env.SAAS_DEMO_MAX === undefined || env.SAAS_DEMO_MAX === '' ? 5 : Math.max(0, Number(env.SAAS_DEMO_MAX) || 0); // 0 turns the demo off
  const demos = new Demos({ root: path.join(root, 'demos'), max: maxDemos, supervisor, space: demoSpace, onEnd: closeSockets, now });
  const tenant = (id) => tenants.get(id);
  const hub = botToken ? new TelegramHub({ token: botToken, accounts, fetchImpl: telegramFetch, onLink: (id, chatId) => tenants.tell(id, { type: 'telegram-chat', chatId }), deliver: async (id, update) => { await tenant(id); tenants.tell(id, { type: 'telegram-update', update }); } }) : null;
  async function stopTenant(id) {
    closeSockets(id);
    await tenants.stop(id);
  }

  // ------------------------------------------------------------------ requests
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', rt.trustProxy);
  const hosts = () => {
    const p = server.address() ? server.address().port : 0;
    return new Set([`localhost:${p}`, `127.0.0.1:${p}`, ...rt.publicHosts]);
  };
  const hostOk = (req) => hosts().has(String(req.headers.host || '').toLowerCase());
  // same-origin only: the Origin must name the host the request was sent to
  const originOk = (req) => { const o = req.headers.origin; if (!o) return true; try { return new URL(o).host.toLowerCase() === String(req.headers.host).toLowerCase(); } catch { return false; } };
  const userOf = async (req) => accounts.session(parseCookies(req.headers.cookie)[COOKIE]);
  const demoOf = (req) => demos.find(parseCookies(req.headers.cookie)[DEMO]);
  /** The terminal of this request: the signed-in account's own, or else the visitor's demo. */
  const ownerOf = async (req) => { const u = await userOf(req); if (u) return { id: u.id, open: () => tenant(u.id) }; const d = demoOf(req); return d ? { id: d.id, demo: true, open: () => { demos.touch(d); return demos.tenants.get(d.id); } } : null; };

  app.get('/health/live', (req, res) => res.set('Cache-Control', 'no-store').json({ status: 'ok' }));
  app.get('/health/ready', (req, res) => res.set('Cache-Control', 'no-store').status(stopping ? 503 : 200).json({ status: stopping ? 'stopping' : 'ready' }));
  app.use((req, res, next) => {
    if (!hostOk(req)) return res.status(403).type('text').send('Forbidden host');
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Content-Security-Policy': CSP, ...(rt.production ? { 'Strict-Transport-Security': 'max-age=15552000' } : {}) });
    if (!['GET', 'HEAD'].includes(req.method) && (req.get('X-Terminal-Client') !== '1' || !originOk(req))) return res.status(403).json({ error: 'Request rejected' });
    return next();
  });

  // public site (the page itself holds no data)
  app.use(ASSETS, ...webAssets());
  app.get('/brand', sendWebPage); // the page; files are below it
  app.use('/brand', ...brandAssets());
  app.get('/login', async (req, res, next) => ((await userOf(req)) ? res.redirect(302, '/app') : next()));
  app.get(['/', '/login', '/invite', '/reset', '/demo'], sendWebPage);

  const json = express.json({ limit: '10kb' });
  const wrap = (fn) => async (req, res) => {
    try { res.json((await fn(req, res)) || { ok: true }); } catch (e) { res.status(e.status || 500).json({ error: e.status ? e.message : 'Unexpected error' }); if (!e.status) console.error(`[gateway] ${e.message}`); }
  };
  // lax: a link from another site finds the person signed in; every change still needs our header and origin
  const signIn = (req, res, s) => res.cookie(COOKIE, s.token, { httpOnly: true, sameSite: 'lax', secure: rt.secureCookies || req.secure, path: '/', maxAge: accounts.maxMs });
  app.post('/account/login', json, wrap(async (req, res) => { signIn(req, res, await accounts.login({ email: (req.body || {}).email, password: (req.body || {}).password, code: (req.body || {}).code, ip: req.ip })); }));
  app.post('/account/register', json, wrap(async (req, res) => {
    const b = req.body || {};
    const u = await accounts.register({ token: b.token, email: b.email, password: b.password, ip: req.ip });
    signIn(req, res, await accounts.login({ email: u.email, password: b.password, ip: req.ip }));
  }));
  // ---------- the demo: no account, no keys, erased when it ends
  app.get('/demo/status', wrap(async (req) => { const d = demoOf(req); return { available: maxDemos > 0, signedIn: !!(await userOf(req)), running: !!d, endsAt: d ? demos.endsAt(d) : null }; }));
  app.post('/demo/start', wrap(async (req, res) => {
    if (stopping || !maxDemos) throw Object.assign(new Error('The demo is not available right now'), { status: 503 });
    const d = demoOf(req);
    if (d) return { endsAt: demos.endsAt(d) };
    const s = await demos.start(req.ip);
    res.cookie(DEMO, s.token, { httpOnly: true, sameSite: 'strict', secure: rt.secureCookies || req.secure, path: '/', maxAge: demos.maxMs });
    return { endsAt: s.endsAt };
  }));
  app.post('/demo/end', wrap(async (req, res) => { const d = demoOf(req); res.clearCookie(DEMO, { path: '/' }); if (d) await demos.end(d); }));
  app.post('/account/request', json, wrap(async (req) => { await accounts.requestInvite((req.body || {}).email, req.ip); }));
  app.get('/account/telegram', wrap(async (req) => { const u = await me(req); return { available: !!hub, linked: !!(await accounts.telegramChat(u.id)) }; }));
  app.post('/account/telegram/link', json, wrap(async (req) => { const u = await me(req); if (!hub) throw Object.assign(new Error('Telegram is not available right now'), { status: 503 }); return hub.link(u.id); }));
  app.post('/account/telegram/unlink', json, wrap(async (req) => { const u = await me(req); await accounts.telegramUnlink(u.id); tenants.tell(u.id, { type: 'telegram-chat', chatId: null }); }));
  app.post('/account/logout', wrap(async (req, res) => { await accounts.logout(parseCookies(req.headers.cookie)[COOKIE]); res.clearCookie(COOKIE, { path: '/' }); }));
  app.get('/account/me', wrap(async (req) => { const u = await me(req); return { email: u.email, role: u.role, totp: await accounts.hasTotp(u.id) }; }));
  const me = async (req) => { const u = await userOf(req); if (!u) throw Object.assign(new Error('Login required'), { status: 401 }); return u; };
  app.post('/account/password', json, wrap(async (req) => accounts.changePassword((await me(req)).id, (req.body || {}).current, (req.body || {}).next, req.ip)));
  app.post('/account/reset', json, wrap(async (req) => accounts.reset({ token: (req.body || {}).token, password: (req.body || {}).password, ip: req.ip })));
  app.post('/account/totp/begin', json, wrap(async (req) => accounts.totpBegin((await me(req)).id, (req.body || {}).password)));
  app.post('/account/totp/confirm', json, wrap(async (req) => accounts.totpConfirm((await me(req)).id, (req.body || {}).code)));
  app.post('/account/totp/disable', json, wrap(async (req) => accounts.totpDisable((await me(req)).id, (req.body || {}).password, (req.body || {}).code)));

  // ---------- operator
  const admin = async (req, res, next) => { const u = await userOf(req); if (!u || u.role !== 'ADMIN') return res.status(404).json({ error: 'Not found' }); req.by = { actor: u.id, ip: req.ip }; return next(); };
  app.get('/admin', admin, sendWebPage);
  app.get('/admin/data', admin, wrap(async () => ({ users: (await accounts.users()).map((u) => ({ ...u, running: tenants.has(u.id) })), invites: await accounts.invites(), requests: await accounts.inviteRequests(), maxTenants })));
  app.post('/admin/request/drop', admin, json, wrap(async (req) => accounts.dropRequest(req.body && req.body.email, req.by)));
  app.post('/admin/invite', admin, json, wrap(async (req) => accounts.invite(req.body && req.body.email, req.by)));
  app.post('/admin/invite/revoke', admin, json, wrap(async (req) => accounts.revokeInvite(req.body && req.body.email, req.by)));
  app.post('/admin/reset', admin, json, wrap(async (req) => accounts.resetLink((req.body || {}).id, req.by)));
  app.post('/admin/totp/clear', admin, json, wrap(async (req) => accounts.clearTotp((req.body || {}).id, req.by)));
  app.post('/admin/status', admin, json, wrap(async (req) => {
    const { id, status } = req.body || {};
    await accounts.setStatus(id, status, req.by);
    if (status === 'SUSPENDED') await stopTenant(id);
  }));

  // ---------- everything else belongs to the signed-in account's own terminal
  function forward(req, t, target) {
    const headers = { ...req.headers };
    for (const h of [...HOP, 'cookie', 'origin', 'forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-gateway-token']) delete headers[h];
    headers.host = `127.0.0.1:${t.port}`;
    headers['x-gateway-token'] = t.token;
    return { host: '127.0.0.1', port: t.port, method: req.method, path: target, headers };
  }
  app.use(async (req, res) => {
    const u = await ownerOf(req);
    if (!u) {
      if (req.method === 'GET' && /^\/(app|terminal)(\/|$)/i.test(req.path)) return res.redirect(302, parseCookies(req.headers.cookie)[DEMO] ? '/demo' : '/login');
      return res.status(401).json({ error: 'Login required' });
    }
    // the detailed technical interface is not part of the hosted product
    if (req.method === 'GET' && /^\/(terminal|index\.html)(\/|$)/i.test(req.path)) return res.redirect(302, '/app');
    let t;
    try { t = await u.open(); } catch (e) { return res.status(e.status || 500).json({ error: e.status ? e.message : 'Your terminal could not be started' }); }
    const up = http.request(forward(req, t, req.originalUrl), (r) => {
      const h = { ...r.headers };
      for (const k of [...HOP, 'set-cookie', 'strict-transport-security']) delete h[k];
      // the terminal names its loopback address in connect-src; the browser connects to this host
      if (h['content-security-policy']) h['content-security-policy'] = h['content-security-policy'].split(`127.0.0.1:${t.port}`).join(String(req.headers.host));
      res.writeHead(r.statusCode, h);
      r.pipe(res);
    });
    up.on('error', () => { if (!res.headersSent) res.status(502).json({ error: 'Your terminal is not responding' }); else res.destroy(); });
    res.on('close', () => up.destroy());
    return req.pipe(up);
  });

  // a database outage fails closed: nobody is treated as signed in
  app.use((err, req, res, next) => { if (res.headersSent) return next(err); if (!err.status) console.error(`[gateway] ${err.message}`); return res.status(err.status || 500).json({ error: err.status && err.status < 600 ? err.message : 'Unexpected error' }); });

  const server = http.createServer(app);
  server.on('upgrade', async (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let u = null;
    try { u = hostOk(req) && req.headers.origin && originOk(req) && req.url === '/ws' ? await ownerOf(req) : null; } catch { u = null; }
    if (!u) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
    let t;
    try { t = await u.open(); } catch { socket.destroy(); return; }
    if (socket.destroyed) return;
    const o = forward(req, t, '/ws');
    Object.assign(o.headers, { connection: 'Upgrade', upgrade: 'websocket' });
    const up = http.request(o);
    up.on('error', () => socket.destroy());
    up.on('response', () => socket.destroy());
    up.on('upgrade', (r, us, uhead) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      if (uhead.length) socket.write(uhead);
      if (head.length) us.write(head);
      us.on('error', () => socket.destroy());
      us.pipe(socket).pipe(us);
      const set = sockets.get(u.id) || new Set();
      sockets.set(u.id, set);
      socket.dtDemo = u.demo ? parseCookies(req.headers.cookie)[DEMO] : null;
      socket.dtCookie = parseCookies(req.headers.cookie)[COOKIE];
      set.add(socket);
      socket.on('close', () => { set.delete(socket); us.destroy(); });
    });
    up.end();
  });
  // a signed-out or expired session loses its live connection too
  const sweep = setInterval(async () => {
    for (const set of sockets.values()) for (const s of [...set]) { try { if (s.dtDemo ? !demos.find(s.dtDemo) : !(await accounts.session(s.dtCookie))) s.destroy(); } catch { s.destroy(); } }
  }, 60000);
  sweep.unref();

  return {
    accounts, tenant, tenants, demos, server,
    async start() {
      refuseOldData(path.join(root, 'accounts.db'));
      const step = async (name, fn) => { try { return await fn(); } catch (e) { console.error(`[startup] FAILED at: ${name}: ${explain(e, databaseUrl)}`); throw e; } };
      console.log(`[startup] address ${env.APP_BASE_URL || '(none)'}, data folder ${root}, service keys set: ${Object.keys(services.values()).join(', ') || 'none'}`);
      await step('connect to the database', async () => { await accounts.db.check(); });
      await step('prepare the account tables', async () => { await accounts.init(); });
      await step('clear old demos', () => demos.init());
      await step('operator account', async () => { await accounts.ensureAdmin(env.SAAS_ADMIN_EMAIL, env.SAAS_ADMIN_PASSWORD); });
      await new Promise((res, rej) => { server.once('error', rej); server.listen(port != null ? port : rt.port, rt.host, res); });
      // monitoring and alerts must survive a restart without anyone opening a browser
      for (const u of await accounts.active()) if (fs.existsSync(path.join(root, 'tenants', u.id))) { try { await tenant(u.id); } catch (e) { console.error(`[gateway] account ${u.id} did not start: ${e.message}`); } }
      if (hub) hub.start();
      return server.address().port;
    },
    async stop() {
      stopping = true;
      clearInterval(sweep);
      if (hub) await hub.stop();
      for (const set of sockets.values()) for (const s of set) s.destroy();
      await Promise.all([tenants.stopAll(), demos.stopAll()]);
      await new Promise((r) => { server.close(r); server.closeAllConnections(); });
      await Promise.all([provisioner.close(), demoSpace.close()]);
      await accounts.close();
    },
  };
}

module.exports = { createGateway, COOKIE, run };

function run() {
  let g;
  try { g = createGateway(); } catch (e) { console.error(`[startup] ${e.message}`); process.exit(e.code === 'CONFIG' ? 78 : 1); }
  const stop = () => g.stop().then(() => process.exit(0), () => process.exit(1));
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  g.start().then((p) => console.log(`Forsah platform on port ${p} (paper trading only)`), (e) => { console.error(e.message); process.exit(1); });
}
