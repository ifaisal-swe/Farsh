'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { Accounts } = require('../server/saas/accounts');
const { hashPassword } = require('../server/auth');

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const pw = () => crypto.randomBytes(12).toString('hex');
async function make(o = {}) { const a = new Accounts(o); await a.init(); return a; }

test('auth: an account and a session from before Better Auth keep working', async () => {
  const a = await make(); const p = pw(); const n = Date.now(); const old = crypto.randomBytes(32).toString('base64url');
  await a.db.q('INSERT INTO users VALUES (?,?,?,?,?,?)', ['u1', "o'neil+x@example.com", hashPassword(p), 'USER', 'ACTIVE', n]);
  await a.db.q('INSERT INTO sessions VALUES (?,?,?,?)', [sha(old), 'u1', n, n + 1e6]);
  assert.equal((await a.session(old)).id, 'u1');
  const s = await a.login({ email: " O'Neil+x@example.com ", password: p });
  assert.equal((await a.session(s.token)).id, 'u1'); await a.logout(s.token); assert.equal(await a.session(s.token), null);
  await a.close();
});

test('auth: only hashes of tokens are stored, and a stolen hash or a forged token is useless', async () => {
  const a = await make(); const p = pw(); await a.ensureAdmin('a@example.com', p); const { token } = await a.login({ email: 'a@example.com', password: p });
  const rows = (await a.db.q('SELECT * FROM sessions')).rows; assert.equal(rows.length, 1); assert.equal(rows[0].hash, sha(token)); assert.ok(!JSON.stringify(rows).includes(token));
  for (const t of [sha(token), `${token}.x`, `${token}x`, '', null, 'a\nb', 'رمز', 'x'.repeat(500), encodeURIComponent(`${token}.=`), { a: 1 }, [token, token]]) assert.equal(await a.session(t).catch((e) => e), null, String(t));
  await a.close();
});

test('auth: idle and absolute limits, and the platform clock, still decide', async () => {
  let t = Date.now() + 400 * 86400000; const a = await make({ now: () => t }); const p = pw(); await a.ensureAdmin('a@example.com', p);
  const { token } = await a.login({ email: 'a@example.com', password: p }); assert.ok(await a.session(token));
  for (let i = 0; i < 13; i++) { t += 11 * 3600000; assert.ok(await a.session(token), `active at ${i}`); }
  for (let i = 0; i < 3; i++) t += 11 * 3600000; assert.equal(await a.session(token), null, 'idle');
  const b = (await a.login({ email: 'a@example.com', password: p })).token;
  for (let i = 0; i < 15; i++) { t += 11 * 3600000; await a.session(b); }
  t += 4 * 3600000; assert.equal(await a.session(b), null, 'seven days at most');
  await a.close();
});

test('auth: a password changed during sign-in, suspension and unusable passwords make no session', async () => {
  const a = await make(); const p = pw(); const u = await a.ensureAdmin('a@example.com', p);
  const has = a.hasTotp.bind(a);
  a.hasTotp = async (id) => { await a.db.q('UPDATE users SET hash = ? WHERE id = ?', [hashPassword(pw()), id]); return has(id); };
  await assert.rejects(a.login({ email: 'a@example.com', password: p, ip: '1' }), (e) => e.status === 401);
  a.hasTotp = has; await a.db.q('UPDATE users SET hash = ? WHERE id = ?', [hashPassword(p), u.id]);
  for (const x of [undefined, null, '', 5, { a: 1 }, 'x'.repeat(300)]) await assert.rejects(a.login({ email: 'a@example.com', password: x, ip: `i${typeof x}${String(x).length}` }), (e) => e.status === 401);
  await a.db.q("UPDATE users SET status = 'SUSPENDED'");
  await assert.rejects(a.login({ email: 'a@example.com', password: p, ip: '3' }), (e) => e.status === 401 && e.message === 'Wrong e-mail or password');
  assert.equal((await a.db.q('SELECT * FROM sessions')).rows.length, 0);
  await a.close();
});

test('auth: the library cannot register, edit or delete accounts behind the rules', async () => {
  const a = await make(); const p = pw(); await a.ensureAdmin('a@example.com', p); const { token } = await a.login({ email: 'a@example.com', password: p });
  const api = (await a.auth.load()).api; const headers = new Headers({ authorization: `Bearer ${token}` }); const before = JSON.stringify((await a.db.q('SELECT * FROM users')).rows);
  await assert.rejects(api.signUpEmail({ body: { email: 'new@example.com', password: pw(), name: 'x' }, headers: new Headers() }));
  await assert.rejects(api.signInEmail({ body: { email: 'a@example.com', password: p }, headers: new Headers() }));
  await assert.rejects(api.updateUser({ body: { name: 'x' }, headers }));
  await assert.rejects(api.changePassword({ body: { currentPassword: p, newPassword: pw() }, headers }));
  assert.equal(JSON.stringify((await a.db.q('SELECT * FROM users')).rows), before); assert.ok(await a.session(token));
  await a.close();
});

test('auth: parallel sign-ins never mix people', async () => {
  const a = await make(); const list = [];
  for (let i = 0; i < 6; i++) { const x = { email: `u${i}@example.com`, p: pw() }; x.id = (await a.create(x.email, x.p, 'USER')).id; list.push(x); }
  const out = await Promise.all(list.map((x) => a.login({ email: x.email, password: x.p, ip: x.email })));
  for (let i = 0; i < 6; i++) { assert.equal(out[i].user.id, list[i].id); assert.equal((await a.session(out[i].token)).id, list[i].id); }
  await a.close();
});
