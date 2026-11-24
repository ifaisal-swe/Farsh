'use strict';
const { platformEnv } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const { createGateway, COOKIE } = require('../server/saas/gateway');

const pw = () => crypto.randomBytes(12).toString('hex');
async function setup(fn, extra = {}, supervisor = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-saas-'));
  const admin = { email: 'admin@example.com', password: pw() };
  const g = createGateway({ port: 0, dataDir: dir, supervisor: { log: () => {}, backoffMs: 50, ...supervisor }, env: { ...platformEnv(), SAAS_ADMIN_EMAIL: admin.email, SAAS_ADMIN_PASSWORD: admin.password, ALPACA_KEY_ID: 'operator-key', ...extra } });
  const port = await g.start();
  const base = 'http://127.0.0.1:' + port;
  const call = async (p, { body, cookie, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const r = await fetch(base + p, { method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* html */ }
    const set = r.headers.get('set-cookie');
    return { status: r.status, data, headers: r.headers, cookie: set ? set.split(';')[0] : null, set };
  };
  const join = async (email) => {
    const a = await call('/account/login', { body: admin });
    const inv = await call('/admin/invite', { body: { email }, cookie: a.cookie });
    const password = pw();
    const r = await call('/account/register', { body: { token: inv.data.token, email, password } });
    return { ...r, email, password, invite: inv.data.token, admin: a.cookie };
  };
  try { await fn({ g, port, base, call, join, admin }); } finally { await g.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('saas: public pages work, everything else needs a session', () => setup(async ({ call }) => {
  const built = require('../server/webpage').webPage();
  for (const p of built ? ['/', '/login', '/invite', '/reset', '/health/live'] : ['/health/live']) assert.equal((await call(p)).status, 200, p);
  for (const p of ['/app/', '/terminal']) assert.equal((await call(p)).headers.get('location'), '/login', p);
  for (const p of ['/api/state', '/API/state', '/index.html', '/js/app.js', '//api/state']) assert.equal((await call(p)).status, 401, p);
  assert.equal((await call('/admin')).status, 404);
  assert.doesNotMatch(/script-src ([^;]*)/.exec((await call('/')).headers.get('content-security-policy'))[1], /unsafe/);
}));

test('saas: registration is closed; an invitation works once, for its own e-mail, and only with a long password', () => setup(async ({ call, join }) => {
  assert.equal((await call('/account/register', { body: { email: 'x@example.com', password: pw(), token: 'guess' } })).status, 403);
  const u = await join('one@example.com');
  assert.equal(u.status, 200);
  assert.match(u.set, /HttpOnly/);
  assert.match(u.set, /SameSite=Lax/);
  assert.match(u.set, /Max-Age=2592000/, 'stays signed in for 30 days');
  assert.equal((await call('/account/logout', { method: 'POST', cookie: u.cookie })).status, 403, 'a cookie alone changes nothing');
  assert.equal((await call('/account/register', { body: { token: u.invite, email: 'one@example.com', password: pw() } })).status, 403);
  const inv = await call('/admin/invite', { body: { email: 'two@example.com' }, cookie: u.admin });
  assert.equal((await call('/account/register', { body: { token: inv.data.token, email: 'evil@example.com', password: pw() } })).status, 403);
  assert.equal((await call('/account/register', { body: { token: inv.data.token, email: 'two@example.com', password: 'short' } })).status, 400);
  assert.equal((await call('/admin/data', { cookie: u.cookie })).status, 404, 'customers are not operators');
}));

test('saas: accounts are isolated and never see operator keys', () => setup(async ({ call, join, g }) => {
  const a = await join('a@example.com');
  const b = await join('b@example.com');
  assert.equal((await call('/api/sharia/ruling', { cookie: a.cookie, body: { symbol: 'ABC', status: 'FAIL', source: 'board of a' } })).status, 200);
  assert.equal((await call('/api/sharia', { cookie: a.cookie })).data.items.length, 1);
  assert.equal((await call('/api/sharia', { cookie: b.cookie })).data.items.length, 0);
  assert.ok((await call('/api/credentials', { cookie: a.cookie })).data.every((c) => !c.configured));
  // direct access to another account's terminal is refused without its private token
  const t = await g.tenant((await g.accounts.byEmail('a@example.com')).id);
  const direct = await fetch('http://127.0.0.1:' + t.port + '/api/state');
  assert.equal(direct.status, 403);
  await direct.text();
}));

test('saas: platform-managed settings and admin routes are refused', () => setup(async ({ call, join }) => {
  const a = await join('a@example.com');
  for (const body of [{ news: { customFeeds: [{ url: 'http://127.0.0.1/' }] } }, { ai: { baseUrl: 'http://127.0.0.1' } }, { backups: { keep: 1 } }, { 'ai.baseUrl': 'http://127.0.0.1' }]) assert.equal((await call('/api/settings', { cookie: a.cookie, body })).status, 403, JSON.stringify(body));
  assert.equal((await call('/api/settings', { cookie: a.cookie, body: { ai: { autonomy: 'SEMI' } } })).status, 200);
  assert.equal((await call('/api/admin/backups', { cookie: a.cookie })).status, 404);
}));

test('saas: cross-site writes and foreign hosts are refused', () => setup(async ({ call, join, port }) => {
  const a = await join('a@example.com');
  assert.equal((await call('/api/ai/pause', { cookie: a.cookie, body: {}, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await call('/api/ai/pause', { cookie: a.cookie, method: 'POST' })).status, 403);
  const status = await new Promise((r) => http.get({ host: '127.0.0.1', port, path: '/', headers: { Host: 'evil.example' } }, (x) => { x.resume(); r(x.statusCode); }));
  assert.equal(status, 403);
}));

test('saas: live connection works through the gateway and ends when the account is suspended', () => setup(async ({ call, join, port, g }) => {
  const a = await join('a@example.com');
  const open = (o) => new Promise((res) => { const w = new WebSocket('ws://127.0.0.1:' + port + '/ws', o); w.on('message', (m) => res([w, JSON.parse(m)])); w.on('error', () => res(null)); });
  const origin = 'http://127.0.0.1:' + port;
  assert.equal(await open({ origin }), null, 'no session');
  assert.equal(await open({ origin: 'https://evil.example', headers: { cookie: a.cookie } }), null, 'foreign origin');
  const [w, hello] = await open({ origin, headers: { cookie: a.cookie } });
  assert.equal(hello.type, 'hello');
  const closed = new Promise((r) => w.on('close', r));
  const id = (await g.accounts.byEmail('a@example.com')).id;
  assert.equal((await call('/admin/status', { cookie: a.admin, body: { id, status: 'SUSPENDED' } })).status, 200);
  await closed;
  assert.equal((await call('/api/state', { cookie: a.cookie })).status, 401);
  assert.equal((await call('/account/login', { body: { email: a.email, password: a.password } })).status, 401);
}));

test('saas: repeated wrong passwords are locked out, and logout ends the session', () => setup(async ({ call, join }) => {
  const a = await join('a@example.com');
  assert.ok(a.cookie.startsWith(COOKIE));
  await call('/account/logout', { cookie: a.cookie, body: {} });
  assert.equal((await call('/api/state', { cookie: a.cookie })).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await call('/account/login', { body: { email: a.email, password: 'wrong' } })).status, 401);
  assert.equal((await call('/account/login', { body: { email: a.email, password: a.password } })).status, 429);
}));

test('saas: capacity is bounded and a public start needs its configuration', async () => {
  assert.throws(() => createGateway({ env: {} }), /SAAS_ADMIN_EMAIL/);
  await setup(async ({ call, join }) => {
    const a = await join('a@example.com');
    const b = await join('b@example.com');
    assert.equal((await call('/api/state', { cookie: a.cookie })).status, 200);
    assert.equal((await call('/api/state', { cookie: b.cookie })).status, 503);
  }, { SAAS_MAX_TENANTS: '1' });
});

test('saas: two-factor login, with single-use codes', () => setup(async ({ call, join }) => {
  const totp = require('../server/saas/totp');
  assert.equal(totp.codeAt(totp.base32(Buffer.from('12345678901234567890')), 1), '287082', 'RFC 6238 vector');
  const a = await join('a@example.com');
  const creds = { email: a.email, password: a.password };
  assert.equal((await call('/account/totp/begin', { cookie: a.cookie, body: { password: 'wrong' } })).status, 403);
  const { secret } = (await call('/account/totp/begin', { cookie: a.cookie, body: { password: a.password } })).data;
  assert.equal((await call('/account/login', { body: creds })).status, 200, 'not active before it is confirmed');
  const step = Math.floor(Date.now() / 30000);
  const code = totp.codeAt(secret, step);
  assert.equal((await call('/account/totp/confirm', { cookie: a.cookie, body: { code } })).status, 200);
  assert.equal((await call('/account/login', { body: creds })).status, 401);
  assert.equal((await call('/account/login', { body: { ...creds, code } })).status, 401, 'a used code is refused');
  assert.equal((await call('/account/login', { body: { ...creds, code: totp.codeAt(secret, step + 1) } })).status, 200);
  const id = (await call('/admin/data', { cookie: a.admin })).data.users.find((u) => u.email === a.email).id;
  assert.equal((await call('/admin/totp/clear', { cookie: a.admin, body: { id } })).status, 200);
  assert.equal((await call('/account/login', { body: creds })).status, 200);
}));

test('saas: password change and operator reset end old sessions; a reset link works once and keeps two-factor on', () => setup(async ({ call, join, g }) => {
  const a = await join('a@example.com');
  const b = await join('b@example.com');
  const next = pw();
  assert.equal((await call('/account/password', { cookie: a.cookie, body: { current: 'wrong', next } })).status, 403);
  assert.equal((await call('/account/password', { cookie: a.cookie, body: { current: a.password, next } })).status, 200);
  assert.equal((await call('/account/me', { cookie: a.cookie })).status, 401);
  assert.equal((await call('/account/login', { body: { email: a.email, password: next } })).status, 200);
  const id = (await g.accounts.byEmail(b.email)).id;
  assert.equal((await call('/admin/reset', { cookie: b.cookie, body: { id } })).status, 404, 'operators only');
  const { token } = (await call('/admin/reset', { cookie: b.admin, body: { id } })).data;
  await g.accounts.totpBegin(id, b.password);
  await g.accounts.db.q('UPDATE totp SET confirmed = 1 WHERE user_id = ?', [id]);
  const p2 = pw();
  assert.equal((await call('/account/reset', { body: { token, password: p2 } })).status, 200);
  assert.equal((await call('/account/reset', { body: { token, password: pw() } })).status, 403);
  assert.equal((await call('/account/me', { cookie: b.cookie })).status, 401);
  assert.equal((await call('/account/login', { body: { email: b.email, password: p2 } })).data.error, 'Two-factor code required');
}));

const until = async (fn, ms = 20000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 100)); } };

test('saas: a crashed customer process restarts with its data; other customers and the gateway stay up', () => setup(async ({ call, join, g }) => {
  const a = await join('a@example.com');
  const b = await join('b@example.com');
  await call('/api/sharia/ruling', { cookie: a.cookie, body: { symbol: 'ABC', status: 'FAIL', source: 'board' } });
  await call('/api/state', { cookie: b.cookie });
  const id = (await g.accounts.byEmail('a@example.com')).id;
  const bx = g.tenants.items.get((await g.accounts.byEmail('b@example.com')).id);
  const pid = g.tenants.items.get(id).child.pid;
  const bpid = bx.child.pid;
  g.tenants.items.get(id).child.kill('SIGKILL');
  assert.ok(await until(() => g.tenants.items.get(id).state !== 'RUNNING' || g.tenants.items.get(id).child.pid !== pid));
  assert.equal((await call('/api/state', { cookie: b.cookie })).status, 200);
  assert.equal((await call('/health/live')).status, 200);
  assert.ok(await until(async () => (await call('/api/state', { cookie: a.cookie })).status === 200));
  assert.equal((await call('/api/sharia', { cookie: a.cookie })).data.items.length, 1);
  assert.equal(bx.child.pid, bpid, 'the other customer was not touched');
}));

test('saas: a hanging customer process is killed and replaced while others keep working', () => setup(async ({ call, join, g }) => {
  const a = await join('a@example.com');
  const b = await join('b@example.com');
  await call('/api/state', { cookie: a.cookie });
  await call('/api/state', { cookie: b.cookie });
  const x = g.tenants.items.get((await g.accounts.byEmail('a@example.com')).id);
  const pid = x.child.pid;
  x.child.send({ type: 'test-hang' });
  const t0 = Date.now();
  assert.equal((await call('/api/state', { cookie: b.cookie })).status, 200);
  assert.ok(Date.now() - t0 < 2000);
  assert.ok(await until(() => x.child && x.child.pid !== pid && x.state === 'RUNNING'));
  assert.equal((await call('/api/state', { cookie: a.cookie })).status, 200);
}, {}, { pingMs: 300, misses: 3, script: path.join(__dirname, 'helpers', 'hang-tenant.js') }));

test('saas: customer processes get no operator secrets, and stop with the gateway', async () => {
  let child;
  await setup(async ({ call, join, g }) => {
    const a = await join('a@example.com');
    await call('/api/state', { cookie: a.cookie });
    child = g.tenants.items.get((await g.accounts.byEmail('a@example.com')).id).child;
    assert.ok(!child.spawnargs.join(' ').includes(g.tenants.items.values().next().value.token));
    assert.ok((await call('/api/credentials', { cookie: a.cookie })).data.every((c) => !c.configured));
  });
  assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test('saas: with TERMINAL_MASTER_KEY nothing is kept on disk and a fresh container opens the same accounts', async () => {
  const os2 = require('node:os'); const key = crypto.randomBytes(32).toString('hex'); const plat = platformEnv(); const password = pw();
  const make = (k = key) => { const dir = fs.mkdtempSync(path.join(os2.tmpdir(), 'dt-mk-')); return { dir, g: createGateway({ port: 0, dataDir: dir, supervisor: { log: () => {} }, env: { ...plat, SAAS_DEMO_MAX: '0', SAAS_ADMIN_EMAIL: 'admin@example.com', SAAS_ADMIN_PASSWORD: password, TERMINAL_MASTER_KEY: k } }) }; };
  const files = (d) => fs.readdirSync(d, { recursive: true }).filter((x) => fs.statSync(path.join(d, String(x))).isFile());
  const a = make(); await a.g.start();
  const id = (await a.g.accounts.byEmail('admin@example.com')).id;
  await a.g.tenant(id);
  const secret = a.g.accounts.seal('x');
  assert.deepEqual(files(a.dir), []);
  await a.g.stop(); fs.rmSync(a.dir, { recursive: true, force: true });
  const b = make(); await b.g.start();
  assert.equal(b.g.accounts.open(secret), 'x');
  assert.ok(b.g.tenants.has(id), 'an opened account starts again without files');
  await b.g.accounts.db.q('INSERT INTO totp VALUES (?,?,?,?)', [id, secret, 0, 0]);
  await b.g.stop(); fs.rmSync(b.dir, { recursive: true, force: true });
  const c = make(crypto.randomBytes(32).toString('hex'));
  await assert.rejects(c.g.start(), /another key/);
  await c.g.stop(); fs.rmSync(c.dir, { recursive: true, force: true });
  assert.throws(() => make('short'), /64 hex/);
});
