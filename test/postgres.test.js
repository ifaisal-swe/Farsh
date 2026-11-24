'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { Store } = require('../server/db');
const { translate } = require('../server/db-postgres');
const { Provisioner } = require('../server/saas/provision');
const M = require('../server/maintenance');
const { makeAgent, startLive, manual, buyProposal } = require('./helpers/engine');

const PG = process.env.PG_TEST_URL;
const opts = { skip: PG ? false : 'PG_TEST_URL is not set' };
const rnd = (p) => p + crypto.randomBytes(6).toString('hex');
async function admin(fn) { const c = new Client(PG); await c.connect(); try { return await fn(c); } finally { await c.end(); } }
const open = (schema, o = {}) => new Store(null, { postgres: { url: PG, schema, createSchema: true, ...o } });

test('postgres: dialect translation', () => {
  assert.equal(translate("SELECT a AS fooBar FROM t WHERE x = '?' AND y = ?").sql, "SELECT a AS \"fooBar\" FROM t WHERE x = '?' AND y = $1");
  assert.match(translate('INSERT OR IGNORE INTO app_events(id) VALUES (?)').sql, /ON CONFLICT DO NOTHING RETURNING seq/);
  assert.match(translate('INSERT OR REPLACE INTO snapshots(id, ts) VALUES (?,?)').sql, /ON CONFLICT \(id\) DO UPDATE SET ts = excluded.ts/);
});

test('postgres: reopening keeps data; numbers, order and special text survive', opts, async () => {
  const schema = rnd('s');
  let s = open(schema);
  const id = s.createSession({ symbol: 'TEST', initialCapital: 10000.1, targetCapital: null });
  const base = { sessionId: id, symbol: 'TEST', side: 'BUY', price: 0.1 + 0.2, fees: 0, ts: 1795454063654 };
  for (const x of ['b', 'a', 'c']) s.insertFill({ ...base, id: x, qty: 1.23456789, reason: "it's ؟ \u0000 ?" });
  s.setSetting('k', { ar: 'مرحبا', n: 2 ** 52 });
  s.close();
  s = open(schema);
  assert.deepEqual(s.migration.applied, []);
  assert.equal(s.getActiveSession().initialCapital, 10000.1);
  const f = s.listFills(id);
  assert.deepEqual(f.map((x) => x.id), ['b', 'a', 'c'], 'insertion order breaks ties');
  assert.equal(f[0].price, 0.1 + 0.2);
  assert.equal(s.getSetting('k').n, 2 ** 52);
  assert.throws(() => s.transaction(() => { s.setSetting('k', 1); throw new Error('x'); }), /x/);
  assert.equal(s.getSetting('k').ar, 'مرحبا');
  s.close();
  await admin((c) => c.query('DROP SCHEMA ' + schema + ' CASCADE'));
});

test('postgres: the same account cannot be open twice', opts, async () => {
  const schema = rnd('s');
  const a = open(schema);
  assert.throws(() => open(schema), /already open|timeout/);
  a.close();
  open(schema).close();
  await admin((c) => c.query('DROP SCHEMA ' + schema + ' CASCADE'));
});

test('postgres: customer roles cannot reach each other, the control schema or other logins', opts, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-prov-'));
  const p = new Provisioner({ url: PG, keyDir: dir, prefix: rnd('x').slice(0, 12) });
  const control = rnd('c');
  try {
    await admin((c) => c.query('CREATE SCHEMA ' + control + '; CREATE TABLE ' + control + '.users(x int)'));
    const ia = crypto.randomUUID(); const ib = crypto.randomUUID();
    const [A, B] = [await p.ensure(ia), await p.ensure(ib)];
    const a = new Store(null, { postgres: A }); const b = new Store(null, { postgres: B });
    a.setSetting('secret', 'of a');
    assert.equal(b.getSetting('secret'), null);
    for (const sql of ['SELECT * FROM ' + A.schema + '.settings', 'DELETE FROM ' + A.schema + '.fills', 'SELECT * FROM ' + control + '.users', 'CREATE SCHEMA nope', 'CREATE ROLE nope', 'SET ROLE ' + A.schema, 'CREATE TABLE public.nope(x int)', 'SELECT * FROM pg_authid']) assert.throws(() => b.db.query(sql), /permission denied|denied/, sql);
    a.close(); b.close();
    assert.equal((await p.ensure(ia)).url, A.url, 'repeatable');
    await assert.rejects(p.ensure('x; DROP ROLE y'), /Invalid/);
    await admin(async (c) => { for (const n of [A.schema, B.schema]) await c.query('DROP SCHEMA ' + n + ' CASCADE; DROP ROLE ' + n); await c.query('DROP SCHEMA ' + control + ' CASCADE'); });
  } finally { await p.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('postgres: a lost connection cancels an open trade and the next statement reconnects', opts, async () => {
  const schema = rnd('s');
  const c = makeAgent({ store: open(schema) });
  c.config.update({ risk: { ...require('../server/trading/riskProfiles').LEGACY_DEFAULTS, profile: 'CUSTOM' } });
  await startLive(c);
  const { agent, store } = c;
  const before = JSON.stringify(agent.portfolio.toJSON());
  // cut the connection from the server side in the middle of the trade
  const real = store.insertFill.bind(store);
  store.insertFill = (f) => {
    spawnSync(process.execPath, ['-e', "const {Client}=require('pg');(async()=>{const c=new Client(process.env.PG_TEST_URL);await c.connect();await c.query(\"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1\",['dt:" + schema + "']);await c.end()})()"], { cwd: path.join(__dirname, '..') });
    return real(f);
  };
  c.decider.push((s) => buyProposal(s));
  assert.equal((await agent.runAnalysis(manual)).status, 'EXECUTION_FAILED');
  assert.equal(JSON.stringify(agent.portfolio.toJSON()), before);
  store.insertFill = real;
  assert.equal(store.listFills(agent.session.id).length, 0);
  c.decider.push((s) => buyProposal(s));
  assert.equal((await agent.runAnalysis(manual)).status, 'EXECUTED');
  assert.equal(store.listFills(agent.session.id).length, 1);
  assert.equal(M.reconcileSession(store, store.getSession(agent.session.id)).ok, true);
  store.close();
  await admin((x) => x.query('DROP SCHEMA ' + schema + ' CASCADE'));
});

test('postgres: an unknown COMMIT outcome is fatal, never guessed', opts, async () => {
  const schema = rnd('s');
  let fatal = null;
  const s = open(schema, { onFatal: (m) => { fatal = m; } });
  const call = s.db.call.bind(s.db);
  s.db.call = (m, w) => { if (m.sql === 'COMMIT') { call(m, w); throw Object.assign(new Error('cut'), { lost: true }); } return call(m, w); };
  assert.throws(() => s.transaction(() => s.setSetting('k', 1)));
  assert.match(fatal, /COMMIT/);
  s.close();
  await admin((x) => x.query('DROP SCHEMA ' + schema + ' CASCADE'));
});

test('postgres: an unreachable server fails within its timeout', () => {
  const t = Date.now();
  assert.throws(() => new Store(null, { postgres: { url: 'postgres://x:y@127.0.0.1:1/z', schema: 'a', timeoutMs: 1000 } }));
  assert.ok(Date.now() - t < 5000);
});

test('postgres: killing the process at every write leaves a consistent account', { ...opts, timeout: 120000 }, async () => {
  for (const at of ['insertOrder:before', 'insertOrder:after', 'insertFill:before', 'insertFill:after', 'saveSessionState:after', 'commit:after']) {
    for (const side of ['BUY', 'SELL']) {
      const schema = rnd('k');
      const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'helpers', 'kill-child.js'), 'pg:' + schema, at, side], { encoding: 'utf8' });
      assert.match(r.stdout, /DYING/, r.stderr);
      const s = open(schema);
      const x = s.getActiveSession();
      assert.equal(M.reconcileSession(s, x).ok, true, at + ' ' + side);
      assert.equal(s.listOrders(x.id).filter((o) => o.status === 'FILLED').length, s.listFills(x.id).length);
      s.close();
      await admin((c) => c.query('DROP SCHEMA ' + schema + ' CASCADE'));
    }
  }
});

test('postgres: moving a hosted platform from SQLite keeps everything, refuses to start unmoved, and is repeatable', { ...opts, timeout: 120000 }, async () => {
  const { createGateway } = require('../server/saas/gateway');
  const { importAll } = require('../scripts/pg-import');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-move-'));
  const schema = rnd('c'); const prefix = rnd('x').slice(0, 12);
  const pw = crypto.randomBytes(12).toString('hex');
  const env = { SAAS_ADMIN_EMAIL: 'admin@example.com', SAAS_ADMIN_PASSWORD: pw };
  const pgEnv = { ...env, SAAS_DATABASE_URL: PG, SAAS_DATABASE_SCHEMA: schema, SAAS_TENANT_PREFIX: prefix };
  const make = (e) => createGateway({ port: 0, dataDir: dir, env: e, supervisor: { log: () => {}, backoffMs: 50 } });
  const call = async (port, p, body, cookie) => {
    const r = await fetch('http://127.0.0.1:' + port + p, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1', ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const d = await r.json();
    return { status: r.status, d, cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  const login = async (port) => (await call(port, '/account/login', { email: env.SAAS_ADMIN_EMAIL, password: pw })).cookie;
  try {
    let g = make(env);
    let port = await g.start();
    let ck = await login(port);
    assert.equal((await call(port, '/api/session/start', { symbol: 'NVDA', initialCapital: 5000, demo: true }, ck)).status, 200);
    await call(port, '/api/credentials', { name: 'TIINGO_API_KEY', value: 'not-a-real-key-123' }, ck);
    await call(port, '/api/sharia/ruling', { symbol: 'ABC', status: 'FAIL', source: 'هيئة' }, ck);
    const id = (await g.accounts.byEmail(env.SAAS_ADMIN_EMAIL)).id;
    await g.stop();

    const blocked = make(pgEnv);
    await assert.rejects(blocked.start(), /pg:import/);
    await blocked.tenants.stopAll();
    const before = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'tenants', id, 'terminal.db'))).digest('hex');
    const r = await importAll({ root: dir, url: PG, schema, prefix, log: () => {} });
    assert.deepEqual(r, { accounts: true, terminals: 1, failed: [] });
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'tenants', id, 'terminal.db'))).digest('hex'), before, 'SQLite untouched');
    assert.deepEqual(await importAll({ root: dir, url: PG, schema, prefix, log: () => {} }), { accounts: false, terminals: 0, failed: [] });

    g = make(pgEnv);
    port = await g.start();
    ck = await login(port);
    const s = (await call(port, '/api/state', null, ck)).d;
    assert.equal(s.tradingSession.initialCapital, 5000);
    assert.equal((await call(port, '/api/sharia', null, ck)).d.items.find((x) => x.symbol === 'ABC').ruling.source, 'هيئة');
    assert.ok((await call(port, '/api/credentials', null, ck)).d.find((c) => c.name === 'TIINGO_API_KEY').configured, 'encrypted keys still open');
    assert.equal((await call(port, '/api/sharia/ruling', { symbol: 'DEF', status: 'FAIL', source: 'board' }, ck)).status, 200, 'new rows after the move');
    await g.stop();
    await admin(async (c) => { const n = prefix + '_' + id.replace(/-/g, ''); await c.query('DROP SCHEMA ' + schema + ' CASCADE; DROP SCHEMA ' + n + ' CASCADE; DROP ROLE ' + n); });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('postgres: the platform works with a role that is not a superuser', opts, async () => {
  const { createGateway } = require('../server/saas/gateway');
  const role = rnd('app'); const db = rnd('db'); const pw = crypto.randomBytes(12).toString('hex');
  await admin(async (c) => { await c.query("CREATE ROLE " + role + " LOGIN CREATEROLE PASSWORD '" + pw + "'"); await c.query('CREATE DATABASE ' + db + " OWNER " + role + " ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0"); });
  const u = new URL(PG); u.username = role; u.password = pw; u.pathname = '/' + db;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-role-'));
  const prefix = rnd('x').slice(0, 12);
  const g = createGateway({ port: 0, dataDir: dir, env: { SAAS_ADMIN_EMAIL: 'admin@example.com', SAAS_ADMIN_PASSWORD: pw, SAAS_DATABASE_URL: u.toString(), SAAS_TENANT_PREFIX: prefix }, supervisor: { log: () => {} } });
  let id;
  try {
    await g.start();
    id = (await g.accounts.byEmail('admin@example.com')).id;
    assert.ok((await g.tenant(id)).port);
    await g.tenants.stop(id);
    assert.ok((await g.tenant(id)).port, 'second start sets the password again');
  } finally {
    await g.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    await admin(async (c) => { await c.query('DROP DATABASE ' + db + ' WITH (FORCE)'); if (id) await c.query('DROP ROLE IF EXISTS ' + prefix + '_' + id.replace(/-/g, '')); await c.query('DROP ROLE ' + role); });
  }
});
