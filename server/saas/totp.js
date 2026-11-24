'use strict';
/** RFC 6238 time-based one-time codes (SHA-1, 6 digits, 30 s), as used by common authenticator apps. */
const crypto = require('node:crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  return (bits.match(/.{1,5}/g) || []).map((x) => B32[parseInt(x.padEnd(5, '0'), 2)]).join('');
}

function fromBase32(s) {
  const bits = [...s].map((c) => B32.indexOf(c).toString(2).padStart(5, '0')).join('');
  return Buffer.from((bits.match(/.{8}/g) || []).map((x) => parseInt(x, 2)));
}

function codeAt(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac('sha1', fromBase32(secret)).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}

/** Returns the matched time step (store it: a step must never be accepted twice), or null. */
function verify(secret, code, nowMs, lastStep = 0) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const cur = Math.floor(nowMs / 30000);
  for (const s of [cur - 1, cur, cur + 1]) {
    if (s > lastStep && crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(String(code)))) return s;
  }
  return null;
}

module.exports = { newSecret: () => base32(crypto.randomBytes(20)), codeAt, verify, base32 };
