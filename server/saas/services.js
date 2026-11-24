'use strict';
/**
 * Service keys held by the operator, so customers never see or enter any. Set from the command line only
 * (scripts/services.js), encrypted at rest with a key kept in a separate file, and never sent to a browser.
 *
 * scope 'operator' (default): market data and AI keys serve the operator's own account only. 'everyone' also serves
 * customers; most data plans forbid redistribution, so the operator must hold a plan that allows it.
 * Public company filings and Telegram are not affected by the scope.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const SHARED = ['ALPACA_KEY_ID', 'ALPACA_SECRET_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'GEMINI_API_KEY', 'TIINGO_API_KEY'];
const NAMES = [...SHARED, 'SEC_USER_AGENT', 'TELEGRAM_BOT_TOKEN'];
const SCOPES = ['operator', 'everyone'];

class PlatformServices {
  constructor({ dir }) { this.file = path.join(dir, 'services.json'); this.keyFile = path.join(dir, 'services.key'); }

  key(create) {
    if (!fs.existsSync(this.keyFile)) {
      if (!create) throw new Error('services.key is missing: the saved service keys cannot be read');
      fs.mkdirSync(path.dirname(this.keyFile), { recursive: true });
      fs.writeFileSync(this.keyFile, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    }
    const k = Buffer.from(fs.readFileSync(this.keyFile, 'utf8').trim(), 'hex');
    if (k.length !== 32) throw new Error('services.key is damaged');
    return k;
  }

  load() {
    if (!fs.existsSync(this.file)) return { scope: 'operator', values: {} };
    const [iv, tag, data] = JSON.parse(fs.readFileSync(this.file, 'utf8')).sealed.split('.').map((x) => Buffer.from(x, 'hex'));
    const d = crypto.createDecipheriv('aes-256-gcm', this.key(false), iv);
    d.setAuthTag(tag);
    return JSON.parse(Buffer.concat([d.update(data), d.final()]).toString('utf8'));
  }

  save(s) {
    const k = this.key(!fs.existsSync(this.file));
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', k, iv);
    const d = Buffer.concat([c.update(JSON.stringify(s), 'utf8'), c.final()]);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ sealed: [iv, c.getAuthTag(), d].map((x) => x.toString('hex')).join('.') }), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  set(name, value) {
    if (!NAMES.includes(name)) throw new Error(`Unknown service key. Known: ${NAMES.join(', ')}`);
    const v = String(value || '').trim();
    if (!v || v.length > 512 || /[\r\n]/.test(v)) throw new Error('Empty or invalid value');
    const s = this.load();
    s.values[name] = v;
    this.save(s);
  }

  unset(name) { const s = this.load(); delete s.values[name]; this.save(s); }
  scope(x) { if (!SCOPES.includes(x)) throw new Error(`The scope is ${SCOPES.join(' or ')}`); const s = this.load(); s.scope = x; this.save(s); }
  /** One named account may use the keys, whatever the scope. */
  allow(email, on = true) { const e = String(email || '').trim().toLowerCase(); if (!/^\S+@\S+$/.test(e)) throw new Error('Give the e-mail of the account'); const s = this.load(); s.allow = [...new Set([...(s.allow || []).filter((x) => x !== e), ...(on ? [e] : [])])]; this.save(s); }
  describe() { const s = this.load(); return { scope: s.scope, allow: s.allow || [], set: NAMES.filter((n) => s.values[n]) }; }

  /** What one account's process receives. */
  forAccount(role, email = null) {
    const s = this.load();
    const named = !!email && (s.allow || []).includes(String(email).toLowerCase());
    const out = {};
    for (const n of NAMES) if (s.values[n] && (!SHARED.includes(n) || role === 'ADMIN' || named || s.scope === 'everyone')) out[n] = s.values[n];
    return out;
  }
}

module.exports = { PlatformServices, NAMES };
