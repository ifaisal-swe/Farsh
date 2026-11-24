'use strict';
/**
 * Lets the operator connect an AI assistant (Claude, ChatGPT, Gemini, Grok) to the team tools: OAuth 2.1 with PKCE,
 * public clients, dynamic registration and rotating refresh tokens. Only hashes of codes and tokens are stored. A token
 * opens the team tools and nothing else: never trading, settings, keys or accounts.
 */
const crypto = require('node:crypto');

const HOUR = 3600000; const DAY = 24 * HOUR;
const SCOPE = 'team';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const token = (p) => `${p}_${crypto.randomBytes(32).toString('base64url')}`;
const fail = (status, code, message) => Object.assign(new Error(message || code), { status, oauth: code });

const TABLES = [
  'CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirects TEXT NOT NULL, created_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES oauth_clients(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, redirect TEXT NOT NULL, challenge TEXT NOT NULL, grant_id TEXT NOT NULL, expires_at BIGINT NOT NULL, used_at BIGINT)',
  'CREATE TABLE IF NOT EXISTS oauth_grants (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, client_id TEXT, name TEXT NOT NULL, created_at BIGINT NOT NULL, seen_at BIGINT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, grant_id TEXT NOT NULL REFERENCES oauth_grants(id) ON DELETE CASCADE, expires_at BIGINT NOT NULL, used_at BIGINT)',
];

/** An https address, or a program on the person's own computer. */
function redirectOk(u) {
  try {
    const x = new URL(u);
    if (x.hash || x.username || x.password || String(u).length > 500) return false;
    return x.protocol === 'https:' || (x.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(x.hostname));
  } catch { return false; }
}
/** Loopback programs pick a free port each time (RFC 8252); everything else must match exactly. */
function sameRedirect(saved, asked) {
  if (saved === asked) return true;
  try { const a = new URL(saved); const b = new URL(asked); return a.protocol === 'http:' && redirectOk(saved) && redirectOk(asked) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && b.protocol === 'http:'; } catch { return false; }
}
const cleanName = (s) => String(s || '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, 60) || 'AI assistant';

class OAuth {
  constructor({ accounts, issuer, now = Date.now }) { Object.assign(this, { accounts, issuer, now }); this.db = accounts.db; this.resource = `${issuer}/mcp`; this.hits = new Map(); }

  limit(key, max, per = HOUR) {
    const t = this.now(); if (this.hits.size > 5000) this.hits.clear();
    const l = (this.hits.get(key) || []).filter((x) => t - x < per);
    if (l.length >= max) throw fail(429, 'slow_down', 'Too many requests');
    l.push(t); this.hits.set(key, l);
  }

  resourceMetadata() { return { resource: this.resource, authorization_servers: [this.issuer], scopes_supported: [SCOPE], bearer_methods_supported: ['header'], resource_name: 'Forsah team' }; }
  serverMetadata() {
    return { issuer: this.issuer, authorization_endpoint: `${this.issuer}/connect`, token_endpoint: `${this.issuer}/oauth/token`, registration_endpoint: `${this.issuer}/oauth/register`, revocation_endpoint: `${this.issuer}/oauth/revoke`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], scopes_supported: [SCOPE], authorization_response_iss_parameter_supported: true };
  }

  async register(b, ip) {
    this.limit(`reg:${ip}`, 20);
    const list = b && Array.isArray(b.redirect_uris) ? b.redirect_uris : [];
    if (!list.length || list.length > 8 || !list.every(redirectOk)) throw fail(400, 'invalid_redirect_uri');
    const t = this.now(); const id = crypto.randomUUID(); const name = cleanName(b.client_name);
    // registrations nobody approved are forgotten
    await this.db.q('DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT client_id FROM oauth_grants WHERE client_id IS NOT NULL)', [t - 7 * DAY]);
    await this.db.q('INSERT INTO oauth_clients VALUES (?,?,?,?)', [id, name, JSON.stringify(list), t]);
    return { client_id: id, client_id_issued_at: Math.floor(t / 1000), client_name: name, redirect_uris: list, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPE };
  }

  /** Checks what an assistant asks for. Never redirects an unknown client. */
  async request(q) {
    const c = (await this.db.q('SELECT * FROM oauth_clients WHERE id = ?', [String(q.client_id || '')])).rows[0];
    if (!c) throw fail(400, 'invalid_client', 'This assistant is not known. Connect it again.');
    const redirect = String(q.redirect_uri || '');
    if (!JSON.parse(c.redirects).some((r) => sameRedirect(r, redirect))) throw fail(400, 'invalid_request', 'The return address does not match.');
    if (q.response_type !== 'code' || q.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43,128}$/.test(String(q.code_challenge || ''))) throw fail(400, 'invalid_request', 'The request is incomplete.');
    if (q.resource && String(q.resource).replace(/\/$/, '') !== this.resource && String(q.resource).replace(/\/$/, '') !== this.issuer) throw fail(400, 'invalid_target', 'The request is for another service.');
    return { client: c, redirect, host: new URL(redirect).host };
  }

  back(redirect, params, state) {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries({ ...params, iss: this.issuer, ...(state ? { state: String(state).slice(0, 1000) } : {}) })) u.searchParams.set(k, v);
    return u.toString();
  }

  async approve(user, q, ip) {
    const { client, redirect } = await this.request(q);
    const t = this.now(); const code = token('fc'); const grant = crypto.randomUUID();
    await this.db.tx(async (h) => {
      await h.q('INSERT INTO oauth_grants VALUES (?,?,?,?,?,?)', [grant, user.id, client.id, client.name, t, t]);
      await h.q('INSERT INTO oauth_codes VALUES (?,?,?,?,?,?,?,?)', [sha(code), client.id, user.id, redirect, String(q.code_challenge), grant, t + 120000, null]);
      await this.accounts.audit('assistant:connect', { actor: user.id, target: grant, ip }, h);
    });
    return this.back(redirect, { code }, q.state);
  }

  async deny(q) { const { redirect } = await this.request(q); return this.back(redirect, { error: 'access_denied' }, q.state); }

  async issue(h, grant) {
    const t = this.now(); const access = token('fa'); const refresh = token('fr');
    await h.q('INSERT INTO oauth_tokens VALUES (?,?,?,?,?)', [sha(access), 'access', grant, t + HOUR, null]);
    await h.q('INSERT INTO oauth_tokens VALUES (?,?,?,?,?)', [sha(refresh), 'refresh', grant, t + 60 * DAY, null]);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: SCOPE };
  }

  async exchange(b, ip) {
    this.limit(`tok:${ip}`, 300);
    const t = this.now(); let stolen = null; let out = null;
    if (b.grant_type === 'authorization_code') {
      out = await this.db.tx(async (h) => {
        const c = (await h.q('SELECT * FROM oauth_codes WHERE hash = ? FOR UPDATE', [sha(b.code || '')])).rows[0];
        if (!c) return null;
        if (c.used_at) { stolen = c.grant_id; return null; }
        const proof = crypto.createHash('sha256').update(String(b.code_verifier || '')).digest('base64url');
        await h.q('UPDATE oauth_codes SET used_at = ? WHERE hash = ?', [t, c.hash]);
        if (c.expires_at < t || c.client_id !== String(b.client_id || '') || c.redirect !== String(b.redirect_uri || '') || proof !== c.challenge) return null;
        return this.issue(h, c.grant_id);
      });
    } else if (b.grant_type === 'refresh_token') {
      out = await this.db.tx(async (h) => {
        const r = (await h.q("SELECT o.*, g.client_id FROM oauth_tokens o JOIN oauth_grants g ON g.id = o.grant_id WHERE o.hash = ? AND o.kind = 'refresh' FOR UPDATE OF o", [sha(b.refresh_token || '')])).rows[0];
        if (!r || r.client_id !== String(b.client_id || '')) return null;
        if (r.used_at) { if (t - r.used_at > 60000) stolen = r.grant_id; return null; }
        if (r.expires_at < t) return null;
        await h.q('UPDATE oauth_tokens SET used_at = ? WHERE hash = ?', [t, r.hash]);
        await h.q('DELETE FROM oauth_tokens WHERE grant_id = ? AND expires_at < ?', [r.grant_id, t]);
        return this.issue(h, r.grant_id);
      });
    } else throw fail(400, 'unsupported_grant_type');
    if (stolen) await this.db.q('DELETE FROM oauth_grants WHERE id = ?', [stolen]); // used twice: the whole connection ends
    if (!out) throw fail(400, 'invalid_grant');
    return out;
  }

  async revoke(b) { const r = (await this.db.q('SELECT grant_id FROM oauth_tokens WHERE hash = ?', [sha(b.token || '')])).rows[0]; if (r) await this.db.q('DELETE FROM oauth_grants WHERE id = ?', [r.grant_id]); }

  /** The person a token belongs to, or null. Only the operator may connect an assistant. */
  async user(bearer) {
    if (!bearer || bearer.length > 200) return null;
    const t = this.now();
    const r = (await this.db.q("SELECT o.expires_at, g.id, g.user_id, g.name, g.seen_at FROM oauth_tokens o JOIN oauth_grants g ON g.id = o.grant_id WHERE o.hash = ? AND o.kind IN ('access', 'personal')", [sha(bearer)])).rows[0];
    if (!r || r.expires_at < t) return null;
    const u = await this.accounts.byId(r.user_id);
    if (!u || u.status !== 'ACTIVE' || u.role !== 'ADMIN') return null;
    if (t - r.seen_at > 60000) await this.db.q('UPDATE oauth_grants SET seen_at = ? WHERE id = ?', [t, r.id]);
    return { id: u.id, grant: r.id, name: r.name };
  }

  /** A long-lived key for programs that cannot sign in (shown once). */
  async personal(user, name, ip) {
    const t = this.now(); const key = token('fp'); const grant = crypto.randomUUID(); const expiresAt = t + 90 * DAY;
    await this.db.tx(async (h) => {
      if ((await h.q('SELECT id FROM oauth_grants WHERE user_id = ?', [user.id])).count >= 30) throw Object.assign(new Error('Too many connections; remove one first'), { status: 400 });
      await h.q('INSERT INTO oauth_grants VALUES (?,?,?,?,?,?)', [grant, user.id, null, cleanName(name), t, t]);
      await h.q('INSERT INTO oauth_tokens VALUES (?,?,?,?,?)', [sha(key), 'personal', grant, expiresAt, null]);
      await this.accounts.audit('assistant:key', { actor: user.id, target: grant, ip }, h);
    });
    return { key, expiresAt };
  }

  async list(user) { return (await this.db.q('SELECT id, name, client_id AS "client", created_at AS "createdAt", seen_at AS "seenAt" FROM oauth_grants g WHERE user_id = ? AND EXISTS (SELECT 1 FROM oauth_tokens o WHERE o.grant_id = g.id) ORDER BY seen_at DESC', [user.id])).rows.map((x) => ({ id: x.id, name: x.name, key: !x.client, createdAt: x.createdAt, seenAt: x.seenAt })); }
  async remove(user, id, ip) { await this.db.q('DELETE FROM oauth_grants WHERE id = ? AND user_id = ?', [String(id || ''), user.id]); await this.accounts.audit('assistant:remove', { actor: user.id, target: String(id || '').slice(0, 60), ip }); }
}

module.exports = { OAuth, TABLES, redirectOk, sameRedirect, SCOPE };
