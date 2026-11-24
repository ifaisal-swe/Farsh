'use strict';
/**
 * Accounts for the hosted platform, on PostgreSQL (database.js). Registration is CLOSED: an account can
 * only be created from a single-use, expiring invitation bound to one e-mail address. Only hashes of passwords,
 * session tokens and invitation tokens are stored. EVERY method that touches the database is asynchronous: callers
 * must await it (an un-awaited promise is truthy and would pass a check); test/accounts.test.js enforces this.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { hashPassword, verifyPassword, LoginLimiter } = require('../auth');
const { PostgresDatabase } = require('./database');
const totp = require('./totp');
const { AuthEngine } = require('./authEngine');
const { TABLES: CONNECTIONS } = require('./oauth');

const DAY = 86400000;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,180}\.[a-z]{2,}$/;
const fail = (status, message) => Object.assign(new Error(message), { status });

const TABLES = [
  'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, created_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, seen_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS invites (hash TEXT PRIMARY KEY, email TEXT NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT)',
  'CREATE TABLE IF NOT EXISTS resets (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS totp (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, secret TEXT NOT NULL, confirmed BIGINT NOT NULL, last_step BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS invite_requests (email TEXT PRIMARY KEY, created_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS telegram_codes (hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS telegram_chats (chat_id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL REFERENCES users(id) ON DELETE CASCADE, linked_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS audit (id TEXT PRIMARY KEY, ts BIGINT NOT NULL, actor TEXT, action TEXT NOT NULL, target TEXT, ip TEXT)',
];
// the audit trail can only grow
const SCHEMA = [...TABLES, ...CONNECTIONS,
    "CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''audit is append-only''; END'",
    'CREATE OR REPLACE TRIGGER audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit FOR EACH STATEMENT EXECUTE FUNCTION audit_append_only()'];

class Accounts {
  constructor({ url, schema = 'control', keyDir = null, key = null, now = Date.now, idleMs = DAY / 2, maxMs = 7 * DAY, inviteMs = 7 * DAY }) {
    if (!url) throw Object.assign(new Error('DATABASE_URL must be set (PostgreSQL)'), { code: 'CONFIG' });
    this.db = new PostgresDatabase(url, { schema });
    Object.assign(this, { now, idleMs, maxMs, inviteMs });
    this.limiter = new LoginLimiter({ now });
    this.requests = new LoginLimiter({ now, global: 200 }); // separate, so a flood of requests can never lock anyone out of login
    this.key = key || this.loadKey(keyDir);
    this.auth = new AuthEngine({ db: this.db, key: this.key, rules: this }); // Better Auth: sign-in and sessions
  }

  async init() {
    await this.db.migrate(SCHEMA);
    const t = (await this.db.q('SELECT secret FROM totp LIMIT 1')).rows[0];
    if (t) { try { this.open(t.secret); } catch { throw Object.assign(new Error('two-factor secrets in the database were saved with another key: restore the earlier accounts.key or TERMINAL_MASTER_KEY'), { status: 503, code: 'CONFIG' }); } }
    await this.auth.load();
  }

  /** Two-factor secrets are encrypted at rest; the key is a file, never in the database. */
  loadKey(dir) {
    if (!dir) return crypto.randomBytes(32);
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, 'accounts.key');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    if (k.length !== 32) throw new Error('accounts.key is damaged');
    return k;
  }

  seal(text) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const d = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), d].map((x) => x.toString('hex')).join('.');
  }

  open(sealed) {
    const [iv, tag, d] = sealed.split('.').map((x) => Buffer.from(x, 'hex'));
    const c = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    c.setAuthTag(tag);
    return Buffer.concat([c.update(d), c.final()]).toString('utf8');
  }

  /** Counts an attempt BEFORE any waiting, so parallel requests cannot slip past the limit. Returns an undo function. */
  attempt(...keys) {
    for (const k of keys) if (this.limiter.blockedFor(k) > 0) throw fail(429, 'Too many attempts. Try again later');
    for (const k of keys) this.limiter.fail(k);
    return () => { for (const k of keys) { this.limiter.success(k); this.limiter.all.pop(); } };
  }

  email(x) {
    const e = String(x || '').trim().toLowerCase();
    if (!EMAIL.test(e)) throw fail(400, 'Enter a valid e-mail address');
    return e;
  }

  password(x) {
    if (typeof x !== 'string' || x.length < 12 || x.length > 200) throw fail(400, 'The password must have 12 to 200 characters');
    return x;
  }

  async one(sql, params, h = this.db) { return (await h.q(sql, params)).rows[0] || null; }

  async audit(action, { actor = null, target = null, ip = null } = {}, h = this.db) {
    await h.q('INSERT INTO audit VALUES (?,?,?,?,?,?)', [crypto.randomUUID(), this.now(), actor, action, target, ip]);
  }

  // ------------------------------------------------------------------ users
  async create(email, password, role, h = this.db) {
    const u = { id: crypto.randomUUID(), email: this.email(email), role, status: 'ACTIVE' };
    await h.q('INSERT INTO users VALUES (?,?,?,?,?,?)', [u.id, u.email, hashPassword(this.password(password)), role, u.status, this.now()]);
    return u;
  }

  /** The operator account from the environment; an existing account is never changed. */
  async ensureAdmin(email, password) {
    const e = this.email(email);
    return (await this.byEmail(e)) || this.create(e, password, 'ADMIN');
  }

  async byEmail(e) { return this.one('SELECT * FROM users WHERE email = ?', [e]); }
  async byId(id, h = this.db) { return this.one('SELECT * FROM users WHERE id = ?', [String(id || '')], h); }
  async users() {
    const r = await this.db.q('SELECT u.id, u.email, u.role, u.status, u.created_at AS "createdAt", t.confirmed AS totp FROM users u LEFT JOIN totp t ON t.user_id = u.id ORDER BY u.created_at, u.id');
    return r.rows.map((u) => ({ ...u, totp: u.totp === 1 }));
  }
  async active() { return (await this.users()).filter((u) => u.status === 'ACTIVE'); }

  async customer(id) {
    const u = await this.byId(id);
    if (!u || u.role === 'ADMIN') throw fail(404, 'Not found');
    return u;
  }

  async setStatus(id, status, by = {}) {
    if (!['ACTIVE', 'SUSPENDED'].includes(status)) throw fail(400, 'Unknown status');
    const u = await this.byId(id);
    if (!u) throw fail(404, 'Not found');
    if (u.role === 'ADMIN') throw fail(400, 'The operator account cannot be suspended');
    await this.db.tx(async (t) => {
      await t.q('UPDATE users SET status = ? WHERE id = ?', [status, id]);
      if (status === 'SUSPENDED') await t.q('DELETE FROM sessions WHERE user_id = ?', [id]);
      await this.audit(`status:${status}`, { ...by, target: id }, t);
    });
  }

  // ------------------------------------------------------------------ invitations
  async invite(email, by = {}) {
    const e = this.email(email);
    if (await this.byEmail(e)) throw fail(409, 'This e-mail already has an account');
    const t = token();
    const expiresAt = this.now() + this.inviteMs;
    await this.db.tx(async (h) => {
      await h.q('DELETE FROM invites WHERE email = ? AND used_at IS NULL', [e]); // only the newest one works
      await h.q('INSERT INTO invites VALUES (?,?,?,?,NULL)', [sha(t), e, this.now(), expiresAt]);
      await h.q('DELETE FROM invite_requests WHERE email = ?', [e]);
      await this.audit('invite', { ...by, target: e }, h);
    });
    return { email: e, token: t, expiresAt };
  }

  async invites() { return (await this.db.q('SELECT email, expires_at AS "expiresAt" FROM invites WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at', [this.now()])).rows; }

  async revokeInvite(email, by = {}) {
    const e = this.email(email);
    await this.db.q('DELETE FROM invites WHERE email = ? AND used_at IS NULL', [e]);
    await this.audit('invite:revoke', { ...by, target: e });
  }

  /** Anyone may ask for an invitation. The answer never reveals whether the address is known. */
  async requestInvite(email, ip = '') {
    const e = this.email(email);
    if (this.requests.blockedFor(ip) > 0) throw fail(429, 'Too many attempts. Try again later');
    this.requests.fail(ip);
    if (await this.byEmail(e)) return;
    const n = await this.one('SELECT COUNT(*) AS n FROM invite_requests');
    if (Number(n.n) >= 1000) return;
    await this.db.q('INSERT INTO invite_requests VALUES (?,?) ON CONFLICT (email) DO NOTHING', [e, this.now()]);
  }

  async inviteRequests() { return (await this.db.q('SELECT email, created_at AS "createdAt" FROM invite_requests ORDER BY created_at')).rows; }

  async dropRequest(email, by = {}) {
    const e = this.email(email);
    await this.db.q('DELETE FROM invite_requests WHERE email = ?', [e]);
    await this.audit('request:drop', { ...by, target: e });
  }

  // ------------------------------------------------------------------ telegram
  async telegramCode(userId) {
    const t = token();
    await this.db.tx(async (h) => {
      await h.q('DELETE FROM telegram_codes WHERE user_id = ? OR expires_at < ?', [userId, this.now()]);
      await h.q('INSERT INTO telegram_codes VALUES (?,?,?)', [sha(t), userId, this.now() + 900000]);
    });
    return t;
  }

  /** Uses a code once. The chat leaves any other account it was linked to. */
  async telegramLink(code, chatId) {
    return this.db.tx(async (h) => {
      const r = await this.one("DELETE FROM telegram_codes WHERE hash = ? AND expires_at > ? AND user_id IN (SELECT id FROM users WHERE status = 'ACTIVE') RETURNING user_id", [sha(code), this.now()], h);
      if (!r) return null;
      const old = await h.q('SELECT user_id FROM telegram_chats WHERE chat_id = ? AND user_id <> ?', [chatId, r.user_id]);
      await h.q('DELETE FROM telegram_chats WHERE chat_id = ? OR user_id = ?', [chatId, r.user_id]);
      await h.q('INSERT INTO telegram_chats VALUES (?,?,?)', [chatId, r.user_id, this.now()]);
      await this.audit('telegram:link', { actor: r.user_id }, h);
      return { userId: r.user_id, released: old.rows.map((x) => x.user_id) };
    });
  }

  async telegramChat(userId) { const r = await this.one('SELECT chat_id FROM telegram_chats WHERE user_id = ?', [userId]); return r ? r.chat_id : null; }
  async telegramOwner(chatId) { const r = await this.one("SELECT c.user_id FROM telegram_chats c JOIN users u ON u.id = c.user_id WHERE c.chat_id = ? AND u.status = 'ACTIVE'", [chatId]); return r ? r.user_id : null; }
  async telegramUnlink(userId) { await this.db.q('DELETE FROM telegram_chats WHERE user_id = ?', [userId]); await this.audit('telegram:unlink', { actor: userId }); }

  async register({ token: t, email, password, ip = '' }) {
    const e = this.email(email);
    this.password(password);
    const ok = this.attempt(ip);
    const u = await this.db.tx(async (h) => {
      // claiming the invitation is one statement: two requests can never use it twice
      const used = await h.q('UPDATE invites SET used_at = ? WHERE hash = ? AND email = ? AND used_at IS NULL AND expires_at > ?', [this.now(), sha(t || ''), e, this.now()]);
      if (used.count !== 1) throw fail(403, 'Registration is by invitation only: this invitation is not valid');
      const x = await this.create(e, password, 'USER', h);
      await this.audit('register', { actor: x.id, ip }, h);
      return x;
    });
    ok();
    return u;
  }

  // ------------------------------------------------------------------ sessions
  async login({ email, password, code, ip = '' }) {
    const ok = this.attempt(ip);
    const n = this.now();
    await this.db.q('DELETE FROM sessions WHERE expires_at < ? OR seen_at < ?', [n, n - this.idleMs]);
    let u = null;
    // an unusable password is replaced by a random one, so the answer takes as long as for any other wrong password
    const usable = typeof password === 'string' && password && password.length <= 200;
    const t = await this.auth.signIn(String(email || '').trim().toLowerCase(), usable ? password : token(), async (id) => {
      u = await this.byId(id);
      if (!u || u.status !== 'ACTIVE') throw fail(401, 'Wrong e-mail or password');
      if (!(await this.hasTotp(u.id))) return;
      if (!code) { ok(); throw fail(401, 'Two-factor code required'); }
      const okCode = this.attempt(`code:${u.id}`);
      if ((await this.useCode(u.id, code)) !== true) throw fail(401, 'Wrong code');
      okCode();
    });
    if (!t || !u) throw fail(401, 'Wrong e-mail or password');
    await this.audit('login', { actor: u.id, ip });
    ok();
    return { token: t, user: u };
  }

  async session(t) {
    if (!t || t.length > 200) return null;
    const n = this.now();
    const r = await this.auth.session(t);
    const u = r && (await this.byId(r.userId));
    if (!u || u.status !== 'ACTIVE') return null;
    if (n - r.seenAt > 300000) await this.db.q('UPDATE sessions SET seen_at = ? WHERE hash = ?', [n, sha(t)]);
    return { id: u.id, email: u.email, role: u.role };
  }

  async logout(t) { if (t) await this.db.q('DELETE FROM sessions WHERE hash = ?', [sha(t)]); }

  // ------------------------------------------------------------------ password
  /** Re-check of the password before a sensitive change; rate limited per account. */
  async reauth(id, password) {
    const ok = this.attempt(`reauth:${id}`);
    const u = await this.byId(id);
    if (!u || typeof password !== 'string' || password.length > 200 || !verifyPassword(password, u.hash)) throw fail(403, 'Wrong password');
    ok();
    return u;
  }

  async setPassword(id, next, h) {
    await h.q('UPDATE users SET hash = ? WHERE id = ?', [hashPassword(this.password(next)), id]);
    await h.q('DELETE FROM sessions WHERE user_id = ?', [id]);
    await h.q('DELETE FROM resets WHERE user_id = ?', [id]);
  }

  async changePassword(id, current, next, ip = null) {
    this.password(next);
    await this.reauth(id, current);
    await this.db.tx(async (t) => { await this.setPassword(id, next, t); await this.audit('password', { actor: id, ip }, t); });
  }

  /** Operator-issued reset link (valid one hour). It does not switch two-factor login off. */
  async resetLink(id, by = {}) {
    await this.customer(id);
    const t = token();
    await this.db.tx(async (h) => {
      await h.q('DELETE FROM resets WHERE user_id = ?', [id]);
      await h.q('INSERT INTO resets VALUES (?,?,?)', [sha(t), id, this.now() + 3600000]);
      await this.audit('reset:link', { ...by, target: id }, h);
    });
    return { token: t };
  }

  async reset({ token: t, password, ip = '' }) {
    this.password(password);
    const ok = this.attempt(ip);
    await this.db.tx(async (h) => {
      const r = await this.one('DELETE FROM resets WHERE hash = ? AND expires_at > ? RETURNING user_id', [sha(t || ''), this.now()], h);
      if (!r) throw fail(403, 'This reset link is not valid');
      await this.setPassword(r.user_id, password, h);
      await this.audit('reset', { actor: r.user_id, ip }, h);
    });
    ok();
  }

  // ------------------------------------------------------------------ two-factor
  async hasTotp(id) { return !!(await this.one('SELECT 1 AS x FROM totp WHERE user_id = ? AND confirmed = 1', [id])); }

  /** True exactly once per code. */
  async useCode(id, code) {
    const r = await this.one('SELECT secret, last_step FROM totp WHERE user_id = ?', [id]);
    const step = r ? totp.verify(this.open(r.secret), code, this.now(), r.last_step) : null;
    if (step == null) return false;
    return (await this.db.q('UPDATE totp SET last_step = ? WHERE user_id = ? AND last_step < ?', [step, id, step])).count === 1;
  }

  async totpBegin(id, password) {
    await this.reauth(id, password);
    const secret = totp.newSecret();
    const r = await this.db.q('INSERT INTO totp VALUES (?,?,0,0) ON CONFLICT (user_id) DO UPDATE SET secret = excluded.secret, last_step = 0 WHERE totp.confirmed = 0', [id, this.seal(secret)]);
    if (r.count !== 1) throw fail(409, 'Two-factor login is already on');
    return { secret };
  }

  async checkCode(id, code) {
    const ok = this.attempt(`code:${id}`);
    if ((await this.useCode(id, code)) !== true) throw fail(403, 'Wrong code');
    ok();
  }

  async totpConfirm(id, code) {
    await this.checkCode(id, code);
    await this.db.q('UPDATE totp SET confirmed = 1 WHERE user_id = ?', [id]);
    await this.audit('totp:on', { actor: id });
  }

  async totpDisable(id, password, code) {
    await this.reauth(id, password);
    await this.checkCode(id, code);
    await this.db.q('DELETE FROM totp WHERE user_id = ?', [id]);
    await this.audit('totp:off', { actor: id });
  }

  /** Operator action for a customer who lost the authenticator. */
  async clearTotp(id, by = {}) {
    await this.customer(id);
    await this.db.q('DELETE FROM totp WHERE user_id = ?', [id]);
    await this.audit('totp:clear', { ...by, target: id });
  }

  async close() { await this.db.close(); }
}

module.exports = { Accounts, SCHEMA };
