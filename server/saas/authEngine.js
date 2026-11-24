'use strict';
/**
 * Better Auth as the sign-in and session engine of the hosted platform. It works on the existing tables through a small
 * adapter, so accounts created before it keep working. Our own rules stay in force inside it:
 * - session tokens are stored only as hashes; the raw token never reaches the database;
 * - the gate (suspension, two-factor) runs after the password is right and before a session exists;
 * - a session is created only if the account is still active and its password was not changed meanwhile;
 * - sign-up, e-mail changes and everything else of the library are unreachable: its HTTP handler is never mounted and
 *   the adapter refuses every write except creating and deleting sessions.
 */
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { hashPassword, verifyPassword } = require('../auth');

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ALIAS = 'sign-in@accounts.invalid'; // the real address is passed beside the library, never through it

class AuthEngine {
  /** db: control database. key: 32 bytes. rules: { now, idleMs, maxMs } read at each call. */
  constructor({ db, key, rules }) {
    Object.assign(this, { db, rules });
    this.secret = Buffer.from(crypto.hkdfSync('sha256', key, '', 'forsah-better-auth', 32)).toString('hex');
    this.scope = new AsyncLocalStorage();
    this.loading = null;
  }

  load() {
    if (!this.loading) this.loading = this.build().catch((e) => { this.loading = null; throw e; });
    return this.loading;
  }

  async build() {
    const [{ betterAuth }, { createAdapterFactory }, { bearer }] = await Promise.all([import('better-auth'), import('better-auth/adapters'), import('better-auth/plugins')]);
    return betterAuth({
      appName: 'Forsah', baseURL: 'http://127.0.0.1', secret: this.secret, database: this.adapter(createAdapterFactory),
      emailAndPassword: { enabled: true, disableSignUp: true, maxPasswordLength: 200, password: { hash: async (p) => hashPassword(p), verify: async ({ hash, password }) => verifyPassword(password, hash) } },
      session: { expiresIn: Math.ceil(this.rules.maxMs / 1000), disableSessionRefresh: true, cookieCache: { enabled: false } },
      databaseHooks: { session: { create: { before: async (s) => { const c = this.scope.getStore(); if (!c || !c.gate) return false; await c.gate(s.userId); return undefined; } } } },
      plugins: [bearer()], telemetry: { enabled: false }, logger: { disabled: true }, rateLimit: { enabled: false },
    });
  }

  adapter(createAdapterFactory) {
    const { rules, scope } = this;
    // a database failure is remembered, so the platform's own error comes out whatever the library makes of it
    const db = { q: async (sql, p) => { try { return await this.db.q(sql, p); } catch (e) { const c = scope.getStore(); if (c) c.error = c.error || e; throw e; } } };
    const refuse = async () => { throw new Error('not supported'); };
    const pick = (where, f) => { const w = (where || []).find((x) => x.field === f && (!x.operator || x.operator === 'eq')); return w && w.value !== undefined && w.value !== null ? String(w.value) : null; };
    const row = async (sql, p) => (await db.q(sql, p)).rows[0] || null;
    const user = (u) => u && { id: u.id, email: ALIAS, name: '', emailVerified: true, image: null, createdAt: new Date(Number(u.created_at)), updatedAt: new Date(Number(u.created_at)) };
    const account = (u) => u && { id: u.id, accountId: u.id, providerId: 'credential', userId: u.id, password: u.hash, createdAt: new Date(Number(u.created_at)), updatedAt: new Date(Number(u.created_at)) };
    const find = async ({ model, where }) => {
      const c = scope.getStore() || {};
      if (model === 'user') {
        if (pick(where, 'email') === ALIAS && c.email) return user(await row('SELECT * FROM users WHERE email = ?', [c.email]));
        const id = pick(where, 'id');
        return id ? user(await row('SELECT * FROM users WHERE id = ?', [id])) : null;
      }
      if (model === 'account') {
        const id = pick(where, 'userId'); if (!id) return null;
        const u = await row('SELECT * FROM users WHERE id = ?', [id]);
        if (u) c.hash = u.hash; // what the password is checked against; the session insert insists on the same value
        return account(u);
      }
      if (model === 'session') {
        const t = pick(where, 'token'); if (!t) return null;
        const n = rules.now();
        const s = await row("SELECT s.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.hash = ? AND u.status = 'ACTIVE'", [sha(t)]);
        if (!s || s.expires_at < n || n - s.seen_at > rules.idleMs) return null;
        c.seen = s.seen_at;
        // expressed on the library's clock, which may differ from the platform's
        return { id: s.hash, token: t, userId: s.user_id, expiresAt: new Date(Date.now() + (s.expires_at - n)), createdAt: new Date(Number(s.seen_at)), updatedAt: new Date(Number(s.seen_at)), ipAddress: '', userAgent: '' };
      }
      return null;
    };
    return createAdapterFactory({
      config: { adapterId: 'forsah', adapterName: 'Forsah accounts', usePlural: false, supportsJSON: false, supportsDates: true, supportsBooleans: true, supportsNumericIds: false, transaction: false, disableIdGeneration: true },
      adapter: () => ({
        findOne: find,
        findMany: async (q) => { const r = await find(q); return r ? [r] : []; },
        count: async (q) => ((await find(q)) ? 1 : 0),
        create: async ({ model, data }) => {
          const c = scope.getStore();
          if (model !== 'session' || !c || !c.passed || c.hash == null) throw new Error('not supported');
          const n = rules.now();
          const made = await db.q("INSERT INTO sessions SELECT CAST(? AS TEXT), id, CAST(? AS BIGINT), CAST(? AS BIGINT) FROM users WHERE id = ? AND status = 'ACTIVE' AND hash = ?", [sha(data.token), n, n + rules.maxMs, data.userId, c.hash]);
          if (made.count !== 1) throw new Error('account changed');
          return { ...data, id: sha(data.token) };
        },
        delete: async ({ model, where }) => { const t = pick(where, 'token'); if (model === 'session' && t) await db.q('DELETE FROM sessions WHERE hash = ?', [sha(t)]); },
        update: refuse, updateMany: refuse, deleteMany: refuse,
      }),
    });
  }

  /** Resolves to a session token, or null when the sign-in is refused. Errors of the gate and the database pass through. */
  async signIn(email, password, gate) {
    const auth = await this.load();
    const c = { email, hash: null, passed: false, error: null };
    c.gate = async (id) => { try { await gate(id); c.passed = true; } catch (e) { c.error = e; throw e; } };
    return this.scope.run(c, async () => {
      try { const r = await auth.api.signInEmail({ body: { email: ALIAS, password }, headers: new Headers() }); return c.passed && r && r.token ? r.token : null; } catch (e) {
        if (c.error) throw c.error;
        return null;
      }
    });
  }

  /** { userId, seenAt } of a valid session, or null. */
  async session(token) {
    if (!/^[\w-]{1,200}$/.test(token)) return null;
    const auth = await this.load();
    const c = {};
    return this.scope.run(c, async () => {
      let r;
      try { r = await auth.api.getSession({ headers: new Headers({ authorization: `Bearer ${token}` }) }); } catch (e) { throw c.error || e; }
      return r && r.session && r.session.token === token ? { userId: r.session.userId, seenAt: c.seen } : null;
    });
  }
}

module.exports = { AuthEngine };
