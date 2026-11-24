'use strict';
const crypto = require('node:crypto');

function newId(prefix = 'id') {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`;
}

function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }

/** Mask a secret for display: never reveals more than the last 4 characters. */
function maskSecret(s) {
  if (!s) return '';
  const str = String(s);
  if (str.length <= 8) return '••••';
  return `${str.slice(0, 3)}…${str.slice(-4)}`;
}

/** Replaces any registered secret values in text/objects (defence in depth for logs). */
class Redactor {
  constructor() { this.secrets = new Set(); }
  register(value) { if (value && String(value).length >= 6) this.secrets.add(String(value)); }
  clear() { this.secrets.clear(); }
  redactString(text) {
    let out = String(text);
    for (const s of this.secrets) if (out.includes(s)) out = out.split(s).join(maskSecret(s));
    out = out.replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/g, '$1[REDACTED]');
    return out;
  }
  redact(obj) {
    if (obj == null) return obj;
    if (typeof obj === 'string') return this.redactString(obj);
    try { return JSON.parse(this.redactString(JSON.stringify(obj))); } catch { return obj; }
  }
}

const round = (x, d = 2) => {
  if (x == null || !Number.isFinite(x)) return x;
  const f = 10 ** d;
  return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
};
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

module.exports = { newId, sha1, maskSecret, Redactor, round, clamp, isNum };
