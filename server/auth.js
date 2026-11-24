'use strict';
/**
 * Single-user dashboard authentication.
 *
 * - Password from DASHBOARD_PASSWORD (hashed in memory at start) or DASHBOARD_PASSWORD_HASH
 *   (`npm run hash-password`), verified with scrypt + timingSafeEqual.
 * - Sessions: 32 random bytes in an HttpOnly, SameSite=Strict cookie (Secure in production);
 *   only the SHA-256 of the token is stored (table auth_sessions), so a database copy cannot be
 *   used to log in. Idle and absolute expiry; sessions survive restarts.
 * - Login rate limiting per client IP and globally (single instance → in memory).
 * - No secret URL, no LocalStorage tokens.
 */
const crypto = require('node:crypto');

const COOKIE = 'dt_session';
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

function hashPassword(password, { N = SCRYPT.N, r = SCRYPT.r, p = SCRYPT.p } = {}) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, SCRYPT.keylen, { N, r, p, maxmem: 64 * 1024 * 1024 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(String(stored || ''));
  if (!m) return false;
  const [, N, r, p, saltB64, hashB64] = m;
  const expected = Buffer.from(hashB64, 'base64');
  let got;
  try { got = crypto.scryptSync(String(password), Buffer.from(saltB64, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }); } catch { return false; }
  return got.length === expected.length && crypto.timingSafeEqual(got, expected);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!k || out[k] !== undefined) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

class LoginLimiter {
  constructor({ perIp = 5, windowMs = 15 * 60000, lockMs = 15 * 60000, global = 30, now = Date.now } = {}) {
    Object.assign(this, { perIp, windowMs, lockMs, global, now });
    this.ips = new Map();
    this.all = [];
  }
  /** ms the client must wait, or 0 */
  blockedFor(ip) {
    const t = this.now();
    const e = this.ips.get(ip);
    if (e && e.lockedUntil > t) return e.lockedUntil - t;
    this.all = this.all.filter((x) => t - x < this.windowMs);
    if (this.all.length >= this.global) return this.windowMs - (t - this.all[0]);
    return 0;
  }
  fail(ip) {
    const t = this.now();
    const e = this.ips.get(ip) || { fails: [], lockedUntil: 0 };
    e.fails = e.fails.filter((x) => t - x < this.windowMs);
    e.fails.push(t);
    if (e.fails.length >= this.perIp) { e.lockedUntil = t + this.lockMs; e.fails = []; }
    this.ips.set(ip, e);
    this.all.push(t);
    if (this.ips.size > 5000) this.ips.clear();
  }
  success(ip) { this.ips.delete(ip); }
}

class AuthManager {
  /**
   * @param {object} o { store, runtime, now, log }
   */
  constructor({ store, runtime, now = Date.now, log = () => {} }) {
    this.store = store;
    this.rt = runtime;
    this.now = now;
    this.log = log;
    this.required = !!runtime.authRequired;
    this.hash = runtime.passwordHash || (runtime.password ? hashPassword(runtime.password) : null);
    this.limiter = new LoginLimiter({ now });
    this.idleMs = runtime.sessionIdleHours * 3600000;
    this.maxMs = runtime.sessionMaxDays * 86400000;
    this.lastPurge = 0;
  }

  enabled() { return this.required && !!this.hash; }

  cookieOptions(req) {
    const secure = this.rt.secureCookies || !!(req && req.secure);
    return { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: this.maxMs };
  }

  /** @returns {{ ok: true, token, expiresAt } | { ok: false, status, error, retryAfterSec? }} */
  login(password, { ip = 'unknown', userAgent = '' } = {}) {
    const wait = this.limiter.blockedFor(ip);
    if (wait > 0) return { ok: false, status: 429, error: 'Too many login attempts — try again later', retryAfterSec: Math.ceil(wait / 1000) };
    if (!this.hash) return { ok: false, status: 503, error: 'Login is not configured on this server' };
    if (typeof password !== 'string' || password.length > 1024 || !verifyPassword(password, this.hash)) {
      this.limiter.fail(ip);
      this.log('warn', `Dashboard login failed from ${ip}`);
      return { ok: false, status: 401, error: 'Wrong password' };
    }
    this.limiter.success(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    const t = this.now();
    this.store.insertAuthSession({ tokenHash: sha256(token), createdAt: t, lastSeenAt: t, expiresAt: t + this.maxMs, ip, userAgent: String(userAgent).slice(0, 200) });
    this.log('ok', `Dashboard login from ${ip}`);
    return { ok: true, token, expiresAt: t + this.maxMs };
  }

  /** Session for a raw cookie header (or null). Idle sessions expire; activity is recorded at most every 5 min. */
  sessionFrom(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE];
    if (!token || token.length > 200) return null;
    const t = this.now();
    if (t - this.lastPurge > 3600000) { this.lastPurge = t; try { this.store.purgeAuthSessions(t, this.idleMs); } catch { /* ignore */ } }
    const h = sha256(token);
    const s = this.store.getAuthSession(h);
    if (!s) return null;
    if (s.expiresAt < t || t - s.lastSeenAt > this.idleMs) { try { this.store.deleteAuthSession(h); } catch { /* ignore */ } return null; }
    if (t - s.lastSeenAt > 5 * 60000) { try { this.store.touchAuthSession(h, t); } catch { /* ignore */ } }
    return { ...s, tokenHash: h };
  }

  logout(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE];
    if (token) { try { this.store.deleteAuthSession(sha256(token)); } catch { /* ignore */ } }
  }

  logoutAll() { return this.store.deleteAllAuthSessions(); }
}

module.exports = { AuthManager, hashPassword, verifyPassword, parseCookies, LoginLimiter, COOKIE };
