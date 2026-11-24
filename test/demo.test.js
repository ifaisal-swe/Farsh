'use strict';
const { platformEnv } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createGateway } = require('../server/saas/gateway');
const { PlatformServices } = require('../server/saas/services');

async function setup(env, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-demo-'));
  const keys = new PlatformServices({ dir }); keys.set('ALPACA_KEY_ID', 'operator-key'); keys.set('ALPACA_SECRET_KEY', 'operator-secret'); keys.scope('everyone');
  let t = Date.now();
  const admin = { email: 'admin@example.com', password: crypto.randomBytes(12).toString('hex') };
  const g = createGateway({ port: 0, dataDir: dir, now: () => t, supervisor: { log: () => {} }, env: { ...platformEnv(), SAAS_ADMIN_EMAIL: admin.email, SAAS_ADMIN_PASSWORD: admin.password, SAAS_PUBLIC_DATA: 'everyone', ...env } });
  const base = 'http://127.0.0.1:' + (await g.start());
  const call = async (p, { body, cookie, method } = {}) => { const r = await fetch(base + p, { method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'manual', headers: { ...(body === undefined && !method ? {} : { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch { /* html */ } const c = r.headers.get('set-cookie'); return { status: r.status, data, location: r.headers.get('location'), cookie: c ? c.split(';')[0] : null, raw: c }; };
  try { await fn({ g, call, admin, dir, later: (ms) => { t += ms; } }); } finally { await g.stop(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}

test('demo: a visitor practises with invented prices only, apart from every account, and nothing is left behind', { timeout: 120000 }, () => setup({}, async ({ g, call, admin, dir, later }) => {
  assert.equal((await call('/app')).location, '/login');
  const s = await call('/demo/start', { body: {} });
  assert.equal(s.status, 200, JSON.stringify(s.data)); assert.match(s.raw, /HttpOnly/i); assert.match(s.raw, /SameSite=Strict/i);
  const cookie = s.cookie; const st = (await call('/api/state', { cookie })).data;
  assert.equal(st.tradingSession.dataMode, 'DEMO'); assert.equal((await call('/api/connections', { cookie })).data.prices, false, 'no operator key or public prices');
  assert.ok((await call('/api/watchlist', { cookie })).data.items.length >= 3);
  assert.equal((await call('/api/opportunities', { cookie })).status, 200);
  assert.equal((await call('/api/helper', { cookie, body: { text: 'wallet', lang: 'en' } })).data.messages.length, 2);

  // everything that is not practice is refused
  for (const [p, body] of [['/api/credentials', { name: 'ALPACA_KEY_ID', value: 'x' }], ['/api/settings', { ai: { baseUrl: 'http://127.0.0.1:1' } }], ['/api/settings', { news: {} }], ['/api/test/alpaca', {}], ['/api/lab/run', { symbol: 'NVDA' }], ['/api/telegram/test', {}], ['/api/sharia/screen', { symbol: 'NVDA' }], ['/api/ops/monitoring', { active: false }], ['/api/admin/backups', {}]]) assert.ok([403, 404].includes((await call(p, { cookie, body })).status), p);
  assert.equal((await call('/api/credentials/ALPACA_KEY_ID', { cookie, method: 'DELETE' })).status, 403);
  await call('/api/session/reset', { cookie, body: { confirm: 'RESET' } });
  await call('/api/session/start', { cookie, body: { symbol: 'AAPL', initialCapital: 5000, demo: false, mode: 'LIVE' } });
  assert.equal((await call('/api/state', { cookie })).data.tradingSession.dataMode, 'DEMO', 'real prices cannot be switched on');
  await call('/api/symbol/change', { cookie, body: { symbol: 'MSFT', demo: false } });
  assert.equal((await call('/api/state', { cookie })).data.tradingSession.dataMode, 'DEMO');

  // it is not an account, and an account wins over it
  for (const p of ['/account/me', '/account/telegram']) assert.equal((await call(p, { cookie })).status, 401);
  assert.equal((await call('/admin', { cookie })).status, 404);
  const op = (await call('/account/login', { body: admin })).cookie;
  assert.equal((await call('/api/state', { cookie: `${op}; ${cookie}` })).data.tradingSession || null, null, 'the account sees its own empty terminal');
  assert.equal((await call('/api/state', { cookie: 'dt_demo=' + 'a'.repeat(64) })).status, 401, 'a guessed demo is refused');
  assert.equal((await call('/api/state', { cookie: cookie.replace('dt_demo', 'dt_account') })).status, 401, 'a demo token is not a sign-in');

  // the same visitor keeps the same demo; another visitor gets another
  assert.equal((await call('/demo/start', { cookie, body: {} })).cookie, null);
  const two = (await call('/demo/start', { body: {} })).cookie; assert.notEqual(two, cookie);
  await call('/api/helper', { cookie: two, body: { text: 'hello' } });
  assert.equal((await call('/api/helper', { cookie: two })).data.messages.length, 2);

  await call('/demo/end', { cookie: two, body: {} });
  assert.equal((await call('/api/state', { cookie: two })).status, 401);
  later(3 * 3600000); await g.demos.sweep();
  assert.equal((await call('/api/state', { cookie })).status, 401); assert.equal((await call('/app', { cookie })).location, '/demo');
  assert.deepEqual(fs.readdirSync(path.join(dir, 'demos')), []);
}));

test('demo: the number running and the starts per address are limited, and it can be turned off', { timeout: 120000 }, async () => {
  await setup({ SAAS_DEMO_MAX: '1' }, async ({ g, call }) => {
    const a = await call('/demo/start', { body: {} }); assert.equal(a.status, 200);
    assert.equal((await call('/demo/start', { body: {} })).status, 503);
    g.demos.perMinute = 3; let last; for (let i = 0; i < 5; i++) last = await call('/api/state', { cookie: a.cookie });
    assert.equal(last.status, 429);
    await call('/demo/end', { cookie: a.cookie, body: {} });
    g.demos.perAddress = 1; assert.equal((await call('/demo/start', { body: {} })).status, 429);
  });
  await setup({ SAAS_DEMO_MAX: '0' }, async ({ call }) => {
    assert.equal((await call('/demo/start', { body: {} })).status, 503); assert.equal((await call('/demo/status')).data.available, false);
  });
});

test('demo: a request from another site cannot start one', { timeout: 60000 }, () => setup({}, async ({ g }) => {
  const r = await fetch(`http://127.0.0.1:${g.server.address().port}/demo/start`, { method: 'POST' }); assert.equal(r.status, 403); assert.equal(g.demos.items.size, 0);
}));
