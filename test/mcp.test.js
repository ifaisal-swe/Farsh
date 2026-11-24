'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { platformEnv } = require('./helpers/db');
const { createGateway } = require('../server/saas/gateway');
const { redirectOk, sameRedirect } = require('../server/saas/oauth');
const { TeamService } = require('../server/team/service');

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
async function setup(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mcp-')); const port = await freePort(); const base = `http://localhost:${port}`; let t = Date.now();
  const admin = { email: 'admin@example.com', password: crypto.randomBytes(12).toString('hex') };
  const g = createGateway({ port, dataDir: dir, now: () => t, supervisor: { log: () => {} }, env: { ...platformEnv(), HOST: '127.0.0.1', APP_BASE_URL: base, SAAS_DEMO_MAX: '0', SAAS_ADMIN_EMAIL: admin.email, SAAS_ADMIN_PASSWORD: admin.password } });
  await g.start();
  const raw = async (p, { body, form, cookie, headers = {}, method } = {}) => { const r = await fetch(base + p, { method: method || (body || form ? 'POST' : 'GET'), redirect: 'manual', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie, 'X-Terminal-Client': '1' } : {}), ...headers }, body: body ? JSON.stringify(body) : form ? new URLSearchParams(form) : undefined }); const text = await r.text(); let data = text; try { data = JSON.parse(text); } catch { /* text */ } const c = r.headers.get('set-cookie'); return { status: r.status, data, headers: r.headers, cookie: c ? c.split(';')[0] : null }; };
  const login = async (x = admin) => (await raw('/account/login', { body: x, headers: { 'X-Terminal-Client': '1' } })).cookie;
  try { await fn({ g, raw, login, base, later: (ms) => { t += ms; } }); } finally { await g.stop(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); }
}
const pkce = () => { const v = crypto.randomBytes(40).toString('base64url'); return { v, c: crypto.createHash('sha256').update(v).digest('base64url') }; };
async function connect({ raw, login }, redirect = 'https://claude.example/callback') {
  const cookie = await login(); const { v, c } = pkce();
  const client = (await raw('/oauth/register', { body: { client_name: 'Claude', redirect_uris: [redirect] } })).data.client_id;
  const q = { response_type: 'code', client_id: client, redirect_uri: redirect, code_challenge: c, code_challenge_method: 'S256', state: 's1' };
  const u = new URL((await raw('/account/connect/approve', { body: q, cookie })).data.url);
  const form = { grant_type: 'authorization_code', code: u.searchParams.get('code'), client_id: client, redirect_uri: redirect, code_verifier: v };
  return { cookie, client, q, u, form, redirect };
}
const rpc = (raw, access, method, params, extra = {}) => raw('/mcp', { body: { jsonrpc: '2.0', id: 1, method, params }, headers: { authorization: `Bearer ${access}`, accept: 'application/json, text/event-stream', ...extra } });
const payload = (r) => { if (typeof r.data !== 'string') return r.data; const m = /^data: (.*)$/m.exec(r.data); return m ? JSON.parse(m[1]) : r.data; };

test('mcp: addresses an assistant may return to', () => {
  for (const u of ['https://claude.ai/api/mcp/auth_callback', 'http://localhost:33418/cb', 'http://127.0.0.1/cb']) assert.ok(redirectOk(u), u);
  for (const u of ['http://evil.example/cb', 'javascript:alert(1)', 'https://a.example/#x', 'https://u:p@a.example/', 'cursor://x', 'x']) assert.ok(!redirectOk(u), u);
  assert.ok(sameRedirect('http://localhost:1/cb', 'http://localhost:2/cb')); assert.ok(!sameRedirect('http://localhost:1/cb', 'http://localhost:2/other')); assert.ok(!sameRedirect('https://a.example/cb', 'https://a.example:444/cb')); assert.ok(!sameRedirect('http://localhost:1/cb', 'http://127.0.0.1:1/cb'));
});

test('mcp: sign-in is discoverable, needs the owner, PKCE and the exact address; codes and refresh work once', { timeout: 60000 }, () => setup(async (x) => {
  const { raw, login, base, g, later } = x;
  const no = await raw('/mcp', { body: { jsonrpc: '2.0', id: 1, method: 'tools/list' } });
  assert.equal(no.status, 401); assert.match(no.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await raw('/.well-known/oauth-protected-resource/mcp')).data.resource, `${base}/mcp`);
  const meta = (await raw('/.well-known/oauth-authorization-server')).data; assert.equal(meta.issuer, base); assert.deepEqual(meta.code_challenge_methods_supported, ['S256']);
  assert.equal((await raw('/oauth/register', { body: { redirect_uris: ['http://evil.example/'] } })).status, 400);

  const a = await connect(x);
  assert.equal(a.u.searchParams.get('iss'), base); assert.equal(a.u.searchParams.get('state'), 's1');
  for (const bad of [{ redirect_uri: 'https://other.example/' }, { code_challenge_method: 'plain' }, { client_id: 'x' }, { resource: 'https://other.example/mcp' }]) assert.equal((await raw('/account/connect/approve', { body: { ...a.q, ...bad }, cookie: a.cookie })).status, 400, JSON.stringify(bad));
  assert.equal((await raw('/account/connect/approve', { body: a.q, headers: { cookie: a.cookie } })).status, 403, 'a cookie alone approves nothing');
  assert.equal((await raw('/account/connect/approve', { body: a.q, headers: { 'X-Terminal-Client': '1' } })).status, 401);
  assert.equal((await raw('/oauth/token', { form: { ...a.form, code_verifier: 'wrong'.repeat(10) } })).data.error, 'invalid_grant');
  const b = await connect(x); const tok = (await raw('/oauth/token', { form: b.form })).data; assert.ok(tok.access_token);
  assert.equal((await rpc(raw, tok.refresh_token, 'tools/list', {})).status, 401, 'a refresh token opens nothing');
  const t2 = (await raw('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: b.client } })).data; assert.ok(t2.access_token);
  later(61000);
  assert.equal((await raw('/oauth/token', { form: { grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: b.client } })).status, 400);
  assert.equal((await rpc(raw, t2.access_token, 'tools/list', {})).status, 401, 'reuse of an old refresh token ends the connection');
  const c = await connect(x); const t3 = (await raw('/oauth/token', { form: c.form })).data; assert.equal((await raw('/oauth/token', { form: c.form })).status, 400); assert.equal((await rpc(raw, t3.access_token, 'tools/list', {})).status, 401, 'a code used twice ends the connection');
  const rows = JSON.stringify([(await g.accounts.db.q('SELECT * FROM oauth_tokens')).rows, (await g.accounts.db.q('SELECT * FROM oauth_codes')).rows]); assert.ok(!rows.includes(t3.access_token) && !rows.includes(c.form.code), 'only hashes are stored');

  // another account cannot connect anything
  const inv = (await raw('/admin/invite', { body: { email: 'u@example.com' }, cookie: await login() })).data; const pw = crypto.randomBytes(12).toString('hex');
  const u = (await raw('/account/register', { body: { token: inv.token, email: 'u@example.com', password: pw }, headers: { 'X-Terminal-Client': '1' } })).cookie;
  assert.equal((await raw('/account/connect/approve', { body: a.q, cookie: u })).status, 404); assert.equal((await raw('/account/connections', { cookie: u })).status, 404);
}));

test('mcp: the assistant lists only team tools, reads, saves a report, and loses access when disconnected', { timeout: 90000 }, () => setup(async (x) => {
  const { raw, later } = x; const a = await connect(x, 'http://localhost:4000/cb'); const access = (await raw('/oauth/token', { form: a.form })).data.access_token;
  const init = payload(await rpc(raw, access, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } })); assert.ok(init.result && init.result.serverInfo, JSON.stringify(init));
  const list = payload(await rpc(raw, access, 'tools/list', {}, { 'mcp-protocol-version': '2025-06-18' })).result.tools;
  assert.deepEqual(list.map((t) => t.name).sort(), ['get_overview', 'get_reports', 'get_stock_file', 'get_team_guide', 'save_note', 'save_report']);
  assert.equal(list.find((t) => t.name === 'get_overview').annotations.readOnlyHint, true); assert.equal(list.find((t) => t.name === 'save_report').annotations.readOnlyHint, false);
  const now = payload(await rpc(raw, access, 'tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {}, 'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' } } }, { 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/list' }));
  assert.equal(now.result && now.result.tools.length, 6, 'the newest protocol too: ' + JSON.stringify(now));
  const call = async (name, args = {}) => payload(await rpc(raw, access, 'tools/call', { name, arguments: args }, { 'mcp-protocol-version': '2025-06-18' })).result;
  assert.match(JSON.stringify(await call('get_team_guide')), /never trade/);
  const report = { symbol: 'NVDA', view: 'POSITIVE', confidence: 60, horizonDays: 20, summaryAr: 'رأي', drivers: ['a'], risks: ['b'], sources: [{ title: 'x', url: 'https://a.example/' }], by: 'Claude' };
  assert.ok(!(await call('save_report', report)).isError);
  assert.equal((await call('save_report', { ...report, sources: [] })).isError, true);
  assert.equal((await call('save_report', { ...report, symbol: '../x' })).isError, true);
  assert.match(JSON.stringify(await call('get_reports', { symbol: 'NVDA' })), /Claude/);
  assert.equal((await raw('/api/team', { cookie: a.cookie })).data.reports.length, 1, 'the person sees it');
  // the access opens nothing else
  for (const p of ['/api/state', '/account/me', '/admin/data', '/api/credentials']) assert.equal((await raw(p, { headers: { authorization: `Bearer ${access}` } })).status, p === '/admin/data' ? 404 : 401, p);
  assert.equal((await rpc(raw, access, 'tools/list', {}, { origin: 'https://evil.example' })).status, 403);
  const key = (await raw('/account/connections/key', { body: { name: 'cli' }, cookie: a.cookie })).data.key; assert.equal((await rpc(raw, key, 'tools/list', {}, { 'mcp-protocol-version': '2025-06-18' })).status, 200);
  const items = (await raw('/account/connections', { cookie: a.cookie })).data.items; assert.equal(items.length, 2);
  for (const i of items) await raw('/account/connections/remove', { body: { id: i.id }, cookie: a.cookie });
  assert.equal((await rpc(raw, access, 'tools/list', {})).status, 401); assert.equal((await rpc(raw, key, 'tools/list', {})).status, 401);
  const b = await connect(x); const t = (await raw('/oauth/token', { form: b.form })).data.access_token; later(3600001); assert.equal((await rpc(raw, t, 'tools/list', {})).status, 401, 'access ends after an hour');
  assert.equal((await raw('/account/templates', { cookie: b.cookie })).data.clients.map((c) => c.id).join(), 'claude,chatgpt,gemini,grok');
}));

test('team: says what needs a look, cleans saved text and scores finished views', async () => {
  let t = Date.parse('2026-11-25T00:00:00Z'); let px = 100; const mem = {};
  const make = () => new TeamService({ store: { getSetting: (k, d) => mem[k] || d, setSetting: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); } }, calls: () => [{ symbol: 'NVDA', price: px, news: [1, 2, 3].map((n) => ({ title: `n${n}`, at: t })) }], research: async () => ({ company: null, news: [] }), price: () => px, followed: () => ['NVDA'], now: () => t });
  const s = make(); assert.deepEqual(s.status().stocks[0].needs, ['no report yet']);
  const base = { symbol: 'nvda', view: 'POSITIVE', confidence: 70, horizonDays: 5, summaryAr: 'x\u0000y', drivers: ['a', ''], risks: ['b'], sources: [{ title: 'ok', url: 'https://a.example' }, { title: 'bad', url: 'javascript:1' }], catalysts: [{ date: '2026-12-03', what: 'hearing' }, { date: 'soon', what: 'x' }] };
  s.saveReport(base); const r = s.reports[0];
  assert.equal(r.symbol, 'NVDA'); assert.equal(r.summaryAr, 'x y'); assert.deepEqual(r.drivers, ['a']); assert.equal(r.sources.length, 1); assert.equal(r.catalysts.length, 1); assert.deepEqual(s.status().stocks[0].needs, []);
  px = 106; t += 3600000; assert.deepEqual(s.status().stocks[0].needs, ['price moved 6.0% since the report', '3 new headlines']);
  t += 5 * 86400000; assert.deepEqual(s.status().record, { finished: 1, right: 1, rightPercent: 100, open: 0 });
  assert.equal(make().reports[0].result.right, true, 'kept');
  for (const bad of [{ view: 'BUY' }, { confidence: 101 }, { horizonDays: 0 }, { sources: [] }, { summaryAr: '' }, { risks: [] }]) assert.throws(() => s.saveReport({ ...base, ...bad }));
  assert.throws(() => s.saveNote({ symbol: 'NVDA', role: 'trader', text: 'x' }));
  for (let i = 0; i < 200; i++) { try { s.saveNote({ symbol: 'NVDA', role: 'news', text: 'x' }); } catch (e) { assert.equal(e.status, 429); } }
  assert.ok(s.notes.length <= 120);
});
