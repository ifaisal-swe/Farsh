'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createTerminal, csvEscape } = require('../server/app');
const { Store } = require('../server/db');
const { SecretStore } = require('../server/secrets');
const { Redactor } = require('../server/util/misc');
const { ActivityLog } = require('../server/activity');
const { ConfigManager, validatePatch } = require('../server/config');

function raw(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('server: localhost-only Host check, CSRF header, secrets never returned', async () => {
  const secret = 'sk-live-supersecret-123456789';
  const t = createTerminal({ dbFile: ':memory:', port: 0, env: { DEEPSEEK_API_KEY: secret } });
  const port = await t.start();
  const ok = await raw(port, { path: '/api/state', headers: { Host: `localhost:${port}` } });
  assert.equal(ok.status, 200);
  const evil = await raw(port, { path: '/api/state', headers: { Host: 'evil.example.com' } });
  assert.equal(evil.status, 403, 'DNS-rebinding style Host rejected');
  const noHdr = await raw(port, { method: 'POST', path: '/api/ai/pause', headers: { Host: `localhost:${port}`, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(noHdr.status, 403);
  const xorigin = await raw(port, { method: 'POST', path: '/api/ai/pause', headers: { Host: `localhost:${port}`, Origin: 'https://evil.example.com', 'X-Terminal-Client': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(xorigin.status, 403);
  const settings = await raw(port, { path: '/api/settings', headers: { Host: `localhost:${port}` } });
  assert.equal(settings.body.includes(secret), false, 'full key never sent to the browser');
  assert.ok(settings.body.includes('sk-…6789'));
  t.activity.info('AI', `debug ${secret}`);
  assert.equal(JSON.stringify(t.activity.recent(5)).includes(secret), false, 'keys redacted from logs');
  const reset = await raw(port, { method: 'POST', path: '/api/session/reset', headers: { Host: `localhost:${port}`, 'X-Terminal-Client': '1', 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(reset.status, 400, 'reset requires explicit confirmation');
  const badCfg = await raw(port, { method: 'POST', path: '/api/settings', headers: { Host: `localhost:${port}`, 'X-Terminal-Client': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ risk: { maxRiskPerTradePct: 50 } }) });
  assert.equal(badCfg.status, 400);
  const csv = await raw(port, { path: '/api/export/trades.csv', headers: { Host: `localhost:${port}` } });
  assert.match(csv.body, /^id,order_id,time_utc/);
  const js = await raw(port, { path: '/api/export/activity.json', headers: { Host: `localhost:${port}` } });
  assert.ok(JSON.parse(js.body).activity.length > 0);
  await t.stop();
});

test('credentials are encrypted at rest (never plaintext in the database file)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-sec-'));
  const file = path.join(dir, 'db.sqlite');
  const store = new Store(file);
  const s = new SecretStore({ store, dataDir: dir, env: {}, redactor: new Redactor() });
  s.set('DEEPSEEK_API_KEY', 'sk-plaintext-should-not-appear-42');
  assert.equal(s.get('DEEPSEEK_API_KEY'), 'sk-plaintext-should-not-appear-42');
  store.close();
  const bytes = fs.readFileSync(file).toString('latin1') + (fs.existsSync(`${file}-wal`) ? fs.readFileSync(`${file}-wal`).toString('latin1') : '');
  assert.equal(bytes.includes('sk-plaintext-should-not-appear-42'), false);
  const store2 = new Store(file);
  const s2 = new SecretStore({ store: store2, dataDir: dir, env: {}, redactor: new Redactor() });
  assert.equal(s2.get('DEEPSEEK_API_KEY'), 'sk-plaintext-should-not-appear-42', 'readable after restart with the same master key');
  assert.equal(s2.describe().find((c) => c.name === 'DEEPSEEK_API_KEY').masked, 'sk-…r-42');
  assert.throws(() => s2.set('NOT_A_KEY', 'x'));
  store2.close();
});

test('database persistence: settings, sessions, activity survive reopen', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'att-db-'));
  const file = path.join(dir, 'db.sqlite');
  const store = new Store(file);
  const cfg = new ConfigManager(store);
  cfg.update({ risk: { maxRiskPerTradePct: 0.5 } });
  const id = store.createSession({ symbol: 'ANT', initialCapital: 500, targetCapital: 1000 });
  store.saveSessionState(id, { aiState: 'RUNNING', portfolio: { initialCapital: 500, cash: 410 } });
  new ActivityLog({ store, getSessionId: () => id }).info('SYSTEM', 'persist me');
  store.close();
  const s2 = new Store(file);
  assert.equal(new ConfigManager(s2).get().risk.maxRiskPerTradePct, 0.5);
  const sess = s2.getActiveSession();
  assert.equal(sess.symbol, 'ANT'); assert.equal(sess.aiState, 'RUNNING'); assert.equal(sess.portfolio.cash, 410);
  assert.ok(s2.listActivity(id).some((e) => e.message === 'persist me'));
  s2.endSession(id);
  assert.equal(s2.getActiveSession(), null);
  s2.close();
});

test('config validation bounds and CSV injection protection', () => {
  assert.deepEqual(validatePatch({ risk: { maxRiskPerTradePct: 2 } }), []);
  assert.ok(validatePatch({ risk: { maxRiskPerTradePct: 9 } }).length);
  assert.ok(validatePatch({ ai: { autonomy: 'YOLO' } }).length);
  assert.ok(validatePatch({ server: { host: '0.0.0.0' } }).length, 'server binding is not editable from the UI');
  assert.ok(validatePatch({ ai: { model: 'x; rm -rf' } }).length);
  assert.equal(csvEscape('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(csvEscape('a,b'), '"a,b"');
});
