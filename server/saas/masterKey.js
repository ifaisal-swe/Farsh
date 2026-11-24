'use strict';
/**
 * One secret in the environment (TERMINAL_MASTER_KEY, 64 hex characters) instead of key files: every other key is
 * derived from it, so the hosted platform needs no data folder. Losing or changing it makes two-factor secrets and
 * saved keys unreadable.
 */
const crypto = require('node:crypto');

function masterKey(env) {
  const v = String(env.TERMINAL_MASTER_KEY || '').trim();
  if (!v) return null;
  if (!/^[0-9a-f]{64}$/i.test(v)) throw Object.assign(new Error('TERMINAL_MASTER_KEY must be 64 hex characters (0-9, a-f)'), { code: 'CONFIG' });
  return Buffer.from(v, 'hex');
}
const derive = (master, label) => Buffer.from(crypto.hkdfSync('sha256', master, '', `forsah-${label}`, 32));

module.exports = { masterKey, derive };
