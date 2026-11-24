'use strict';
/**
 * Credential handling. Secrets live ONLY on the backend:
 *  - environment variables / .env take precedence (never written anywhere by the app)
 *  - keys entered in the Settings UI are encrypted with AES-256-GCM before being stored in PostgreSQL.
 *    The master key comes from TERMINAL_MASTER_KEY or data/master.key (created with owner-only
 *    permissions where the OS supports it). This protects against casual disclosure (DB copies,
 *    screenshots, logs) — not against someone with full access to your user account.
 * The frontend only ever receives masked values.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { maskSecret } = require('./util/misc');

const CREDENTIALS = {
  DEEPSEEK_API_KEY: { label: 'DeepSeek API key', why: 'Authenticates AI market analysis requests to api.deepseek.com.' },
  ALPACA_KEY_ID: { label: 'Alpaca API key ID', why: 'Real-time & historical market data, news, market clock (read-only).' },
  ALPACA_SECRET_KEY: { label: 'Alpaca API secret', why: 'Pairs with the key ID. Used read-only; no orders are ever sent.' },
  SEC_USER_AGENT: { label: 'SEC EDGAR User-Agent', why: 'SEC fair-access policy requires "Name email@example.com" to query EDGAR filings.' },
  OPENROUTER_API_KEY: { label: 'OpenRouter API key', why: 'Authenticates the analysts\' requests to openrouter.ai.' },
  GEMINI_API_KEY: { label: 'Google Gemini API key', why: 'Authenticates AI market analysis requests to generativelanguage.googleapis.com (when the AI provider is Gemini).' },
  TIINGO_API_KEY: { label: 'Tiingo API token', why: 'Optional extended-hours / overnight reference prices from Tiingo (read-only).' },
  TELEGRAM_BOT_TOKEN: { label: 'Telegram bot token', why: 'Lets the terminal send notifications and answer your Telegram commands. Never shown again after saving.' },
};

class SecretStore {
  constructor({ store, dataDir, env = process.env, redactor }) {
    this.store = store;
    this.env = env;
    this.redactor = redactor;
    this.key = this.loadKey(dataDir);
    for (const n of Object.keys(CREDENTIALS)) { const v = this.get(n); if (v && redactor) redactor.register(v); }
  }

  loadKey(dataDir) {
    const hex = this.env.TERMINAL_MASTER_KEY;
    if (hex && /^[0-9a-fA-F]{64}$/.test(hex)) return Buffer.from(hex, 'hex');
    if (!dataDir) return crypto.randomBytes(32); // tests / in-memory
    const file = path.join(dataDir, 'master.key');
    fs.mkdirSync(dataDir, { recursive: true });
    if (fs.existsSync(file)) {
      const k = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
      if (k.length === 32) return k;
    }
    const k = crypto.randomBytes(32);
    fs.writeFileSync(file, k.toString('hex'), { mode: 0o600 });
    return k;
  }

  static isKnown(name) { return Object.prototype.hasOwnProperty.call(CREDENTIALS, name); }

  set(name, value) {
    if (!SecretStore.isKnown(name)) throw new Error(`Unknown credential ${name}`);
    const v = String(value || '').trim();
    if (!v) throw new Error('Empty value');
    if (v.length > 512 || /[\r\n]/.test(v)) throw new Error('Invalid credential format');
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([c.update(v, 'utf8'), c.final()]);
    this.store.setCredential(name, { iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex') });
    if (this.redactor) this.redactor.register(v);
  }

  delete(name) { if (SecretStore.isKnown(name)) this.store.deleteCredential(name); }

  get(name) {
    const e = this.env[name];
    if (e && String(e).trim()) return String(e).trim();
    const row = this.store.getCredential(name);
    if (!row) return null;
    try {
      const d = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(row.iv, 'hex'));
      d.setAuthTag(Buffer.from(row.tag, 'hex'));
      return Buffer.concat([d.update(Buffer.from(row.data, 'hex')), d.final()]).toString('utf8');
    } catch {
      return null; // master key changed / corrupted -> treat as not configured
    }
  }

  source(name) {
    const e = this.env[name];
    if (e && String(e).trim()) return 'environment';
    return this.store.getCredential(name) ? 'encrypted local store' : null;
  }

  describe() {
    return Object.entries(CREDENTIALS).map(([name, meta]) => {
      const v = this.get(name);
      const isUa = name === 'SEC_USER_AGENT';
      return { name, label: meta.label, why: meta.why, configured: !!v, source: this.source(name), masked: v ? (isUa ? `${v.split(' ')[0]} …` : maskSecret(v)) : '' };
    });
  }
}

module.exports = { SecretStore, CREDENTIALS };
