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

const pw = () => crypto.randomBytes(12).toString('hex');
const until = async (fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { if (await fn()) return true; if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 50)); } };
const dirOf = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dt-plat-'));

async function setup(values, scope, fn) {
  const dir = dirOf();
  const s = new PlatformServices({ dir });
  for (const [k, v] of Object.entries(values)) s.set(k, v);
  if (scope) s.scope(scope);
  const sent = [];
  const queue = [];
  const telegramFetch = async (url, o) => {
    const method = String(url).split('/').pop();
    const b = JSON.parse(o.body);
    let result = true;
    if (method === 'getMe') result = { username: 'forsah_test_bot' };
    else if (method === 'getUpdates') { if (!queue.length) await new Promise((r) => setTimeout(r, 30)); result = queue.splice(0).filter((u) => u.update_id >= b.offset); } else sent.push([method, b]);
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: true, result }), text: async () => JSON.stringify({ ok: true, result }) };
  };
  const admin = { email: 'admin@example.com', password: pw() };
  const g = createGateway({ port: 0, dataDir: dir, telegramFetch, supervisor: { log: () => {} }, env: { ...platformEnv(), SAAS_ADMIN_EMAIL: admin.email, SAAS_ADMIN_PASSWORD: admin.password } });
  const base = 'http://127.0.0.1:' + (await g.start());
  const call = async (p, { body, cookie } = {}) => { const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', redirect: 'manual', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }), ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }); const t = await r.text(); let data = t; try { data = JSON.parse(t); } catch { /* html */ } const c = r.headers.get('set-cookie'); return { status: r.status, data, text: t, location: r.headers.get('location'), cookie: c ? c.split(';')[0] : null }; };
  const op = (await call('/account/login', { body: admin })).cookie;
  const join = async (email) => { const i = await call('/admin/invite', { body: { email }, cookie: op }); return (await call('/account/register', { body: { token: i.data.token, email, password: pw() } })).cookie; };
  try { await fn({ g, call, join, op, sent, queue, dir }); } finally { await g.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
}

test('platform: service keys are encrypted on disk and limited by scope', () => {
  const dir = dirOf();
  const s = new PlatformServices({ dir });
  s.set('ALPACA_KEY_ID', 'secret-alpaca');
  s.set('SEC_USER_AGENT', 'Test test@example.com');
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'services.json'), 'utf8'), /secret-alpaca/);
  assert.deepEqual(Object.keys(s.forAccount('USER')), ['SEC_USER_AGENT']);
  assert.equal(s.forAccount('ADMIN').ALPACA_KEY_ID, 'secret-alpaca');
  assert.equal(s.forAccount('USER', 'one@example.com').ALPACA_KEY_ID, undefined);
  s.allow('One@example.com');
  assert.equal(s.forAccount('USER', 'one@example.com').ALPACA_KEY_ID, 'secret-alpaca');
  assert.equal(s.forAccount('USER', 'two@example.com').ALPACA_KEY_ID, undefined, 'only the named account');
  s.allow('one@example.com', false);
  assert.equal(s.forAccount('USER', 'one@example.com').ALPACA_KEY_ID, undefined);
  s.scope('everyone');
  assert.equal(s.forAccount('USER').ALPACA_KEY_ID, 'secret-alpaca');
  assert.throws(() => s.set('OTHER', 'x'), /Unknown/);
  assert.throws(() => s.scope('all'), /scope/);
  fs.rmSync(path.join(dir, 'services.key'));
  assert.throws(() => s.load(), /services.key/);
  assert.throws(() => s.set('ALPACA_KEY_ID', 'x'), /services.key/, 'a lost key is never silently replaced');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('platform: customers use the keys without ever seeing them', () => setup({ ALPACA_KEY_ID: 'platform-key-123456', ALPACA_SECRET_KEY: 'platform-secret-123456', DEEPSEEK_API_KEY: 'platform-ai-123456', OPENROUTER_API_KEY: 'platform-key-or-123456' }, 'everyone', async ({ call, join }) => {
  const a = await join('a@example.com');
  assert.deepEqual((await call('/api/connections', { cookie: a })).data, { prices: true, assistant: true, rules: false, filings: false });
  assert.equal((await call('/api/lab?symbol=NVDA', { cookie: a })).data.agentsReady, true);
  for (const p of ['/api/settings', '/api/credentials', '/api/state', '/api/system/health', '/api/lab?symbol=NVDA']) assert.doesNotMatch((await call(p, { cookie: a })).text, /platform-(key|secret|ai)|plat…|3456/, p);
  assert.equal((await call('/api/credentials', { cookie: a, body: { name: 'ALPACA_KEY_ID', value: 'mine' } })).status, 403);
  for (const body of [{ ai: { dailyBudgetUsd: 500 } }, { market: { maxSymbols: 50 } }, { ai: { autonomy: 'SEMI', model: 'x' } }]) assert.equal((await call('/api/settings', { cookie: a, body })).status, 403, JSON.stringify(body));
  assert.equal((await call('/api/settings', { cookie: a, body: { ai: { autonomy: 'SEMI' } } })).status, 200);
  assert.equal((await call('/terminal', { cookie: a })).location, '/app');
}));

test('platform: by default market data and AI keys serve the operator only', () => setup({ ALPACA_KEY_ID: 'platform-key-123456', ALPACA_SECRET_KEY: 'platform-secret-123456' }, null, async ({ call, join, op }) => {
  assert.equal((await call('/api/connections', { cookie: await join('a@example.com') })).data.prices, false);
  assert.equal((await call('/api/connections', { cookie: op })).data.prices, true);
}));

test('platform: anyone may ask for an invitation; the operator sees it, and the answer reveals nothing', () => setup({}, null, async ({ call, join, op }) => {
  await join('known@example.com');
  for (const email of ['new@example.com', 'known@example.com', 'new@example.com']) assert.deepEqual([(await call('/account/request', { body: { email } })).status], [200]);
  assert.equal((await call('/account/request', { body: { email: 'nope' } })).status, 400);
  assert.deepEqual((await call('/admin/data', { cookie: op })).data.requests.map((r) => r.email), ['new@example.com']);
  await call('/admin/invite', { cookie: op, body: { email: 'new@example.com' } });
  assert.deepEqual((await call('/admin/data', { cookie: op })).data.requests, []);
  await call('/account/request', { body: { email: 'x1@example.com' } });
  await call('/account/request', { body: { email: 'x2@example.com' } });
  assert.equal((await call('/account/request', { body: { email: 'x3@example.com' } })).status, 429, 'rate limited');
}));

test('platform: one tap links a private Telegram chat to one account, and messages reach only its owner', () => setup({ TELEGRAM_BOT_TOKEN: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, null, async ({ g, call, join, sent, queue }) => {
  const a = await join('a@example.com');
  const b = await join('b@example.com');
  let n = 1;
  const says = (chat, text, type = 'private') => queue.push({ update_id: n++, message: { message_id: n, text, chat: { id: chat, type }, from: { id: 777 } } });
  const reply = (re) => until(() => sent.some(([m, x]) => m === 'sendMessage' && re.test(x.text)));
  assert.deepEqual((await call('/account/telegram', { cookie: a })).data, { available: true, linked: false });
  assert.equal((await call('/account/telegram/link', { body: {} })).status, 401);
  const { url } = (await call('/account/telegram/link', { cookie: a, body: {} })).data;
  const code = /^https:\/\/t\.me\/forsah_test_bot\?start=([\w-]+)$/.exec(url)[1];
  says(777, 'hello');
  assert.ok(await reply(/غير مرتبطة/));
  says(-5, '/start ' + code, 'group');
  says(777, '/start ' + code);
  assert.ok(await reply(/تم ربط/));
  assert.equal((await call('/account/telegram', { cookie: a })).data.linked, true);
  assert.equal((await call('/account/telegram', { cookie: b })).data.linked, false);
  says(777, '/start ' + code);
  assert.ok(await reply(/انتهت صلاحية/), 'a code works once');
  const idA = (await g.accounts.byEmail('a@example.com')).id;
  const told = [];
  const tell = g.tenants.tell.bind(g.tenants);
  g.tenants.tell = (id, m) => { told.push([id, m.type]); tell(id, m); };
  says(777, '/portfolio');
  assert.ok(await until(() => told.length));
  assert.deepEqual(told, [[idA, 'telegram-update']]);
  // linking the same chat to another account releases the first one
  const c2 = (await call('/account/telegram/link', { cookie: b, body: {} })).data.url.split('=')[1];
  says(777, '/start ' + c2);
  assert.ok(await until(async () => (await call('/account/telegram', { cookie: b })).data.linked));
  assert.equal((await call('/account/telegram', { cookie: a })).data.linked, false);
  await call('/account/telegram/unlink', { cookie: b, body: {} });
  assert.equal((await call('/account/telegram', { cookie: b })).data.linked, false);
}));
