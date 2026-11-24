'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Accounts } = require('../server/saas/accounts');
const { PostgresDatabase } = require('../server/saas/database');
const totp = require('../server/saas/totp');

const PG = process.env.PG_TEST_URL;
const pw = () => crypto.randomBytes(12).toString('hex');
const status = (n) => (e) => e.status === n;
const count = (rs, ok) => rs.filter((r) => (r.status === 'fulfilled') === ok).length;

for (const kind of ['sqlite', 'postgres']) {
  const opts = { skip: kind === 'postgres' && !PG ? 'PG_TEST_URL is not set' : false };
  const run = (name, fn) => test('accounts (' + kind + '): ' + name, opts, async () => {
    let t = Date.parse('2026-11-23T12:00:00Z');
    const a = new Accounts({ ...(kind === 'postgres' ? { url: PG, schema: 't' + crypto.randomBytes(6).toString('hex') } : {}), now: () => t });
    await a.init();
    await a.init(); // repeatable
    try { await fn(a, (ms) => { t += ms; }); } finally {
      if (kind === 'postgres') await a.db.q('DROP SCHEMA ' + a.db.schema + ' CASCADE');
      await a.close();
    }
  });
  const member = async (a, email = 'u@example.com') => { const p = pw(); const i = await a.invite(email); return { ...(await a.register({ token: i.token, email, password: p, ip: 'x' })), password: p }; };

  run('one invitation creates one account, even with parallel requests', async (a) => {
    const i = await a.invite('u@example.com');
    const rs = await Promise.allSettled(Array.from({ length: 4 }, (_, n) => a.register({ token: i.token, email: 'u@example.com', password: pw(), ip: 'ip' + n })));
    assert.equal(count(rs, true), 1);
    assert.equal((await a.users()).length, 1);
    await assert.rejects(a.invite('u@example.com'), status(409));
  });

  run('a reset link works once in parallel and ends sessions; times survive as exact numbers', async (a, wait) => {
    const u = await member(a);
    const s = await a.login({ email: u.email, password: u.password, ip: 'x' });
    assert.equal((await a.session(s.token)).id, u.id);
    assert.equal((await a.users())[0].createdAt, Date.parse('2026-11-23T12:00:00Z'));
    const l = await a.resetLink(u.id);
    const rs = await Promise.allSettled([1, 2, 3].map((n) => a.reset({ token: l.token, password: pw(), ip: 'r' + n })));
    assert.equal(count(rs, true), 1);
    assert.equal(await a.session(s.token), null);
    const l2 = await a.resetLink(u.id);
    wait(3600001);
    await assert.rejects(a.reset({ token: l2.token, password: pw(), ip: 'z' }), status(403));
  });

  run('a two-factor code works once in parallel, and login needs it', async (a) => {
    const u = await member(a);
    const { secret } = await a.totpBegin(u.id, u.password);
    const step = Math.floor(a.now() / 30000);
    await a.totpConfirm(u.id, totp.codeAt(secret, step));
    await assert.rejects(a.totpBegin(u.id, u.password), status(409));
    await assert.rejects(a.login({ email: u.email, password: u.password, ip: 'x' }), status(401));
    await assert.rejects(a.login({ email: u.email, password: u.password, code: '000000', ip: 'x' }), status(401));
    const rs = await Promise.allSettled([1, 2, 3].map((n) => a.login({ email: u.email, password: u.password, code: totp.codeAt(secret, step + 1), ip: 'p' + n })));
    assert.equal(count(rs, true), 1);
  });

  run('parallel wrong passwords cannot exceed the limit', async (a) => {
    const u = await member(a);
    const rs = await Promise.allSettled(Array.from({ length: 12 }, () => a.login({ email: u.email, password: 'wrong', ip: 'attacker' })));
    assert.equal(rs.filter((r) => r.reason.status === 401).length, 5);
    assert.equal(rs.filter((r) => r.reason.status === 429).length, 7);
    for (let n = 0; n < 40; n++) await a.login({ email: u.email, password: u.password, ip: 'office' }); // good logins never count
  });

  run('suspension ends sessions, a failed step rolls everything back, the audit only grows', async (a) => {
    const u = await member(a);
    const s = await a.login({ email: u.email, password: u.password, ip: 'x' });
    const real = a.audit;
    a.audit = async () => { throw Object.assign(new Error('x'), { status: 503 }); };
    await assert.rejects(a.setStatus(u.id, 'SUSPENDED'), status(503));
    a.audit = real;
    assert.ok(await a.session(s.token), 'nothing changed');
    await a.setStatus(u.id, 'SUSPENDED', { actor: 'admin' });
    assert.equal(await a.session(s.token), null);
    await assert.rejects(a.login({ email: u.email, password: u.password, ip: 'y' }), status(401));
    assert.ok((await a.db.q('SELECT * FROM audit')).count >= 4);
    await assert.rejects(a.db.q('DELETE FROM audit'));
    await assert.rejects(a.db.q("UPDATE audit SET action = 'x'"));
  });
}

test('accounts: an unreachable database fails closed with 503 and reveals nothing', async () => {
  const a = new Accounts({ url: 'postgres://u:topsecret@127.0.0.1:1/none' });
  await assert.rejects(a.session('x'), (e) => e.status === 503 && !/topsecret|ECONN|127/.test(e.message));
  await assert.rejects(a.login({ email: 'a@example.com', password: 'x', ip: 'x' }), status(503));
  await a.close();
  assert.throws(() => new PostgresDatabase('postgres://x', { schema: 'a;drop' }));
});

test('accounts: the gateway awaits every account call', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'saas', 'gateway.js'), 'utf8');
  const names = Object.getOwnPropertyNames(Accounts.prototype).filter((n) => Accounts.prototype[n].constructor.name === 'AsyncFunction');
  assert.ok(names.length > 20);
  for (const line of src.split('\n')) {
    for (const m of line.matchAll(/(.{0,20})\baccounts\.(\w+)\(/g)) if (names.includes(m[2])) assert.match(m[1], /await $|async \(req\) => $/, line.trim());
    for (const m of line.matchAll(/(.{0,10})\b(userOf|me)\((req)\)/g)) if (!/const (userOf|me)/.test(m[0])) assert.match(m[1], /await $/, line.trim());
  }
});
