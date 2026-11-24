'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', 'web', 'app');
const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? files(path.join(d, x.name)) : /\.(vue|ts)$/.test(x.name) ? [path.join(d, x.name)] : []));
const TECH = /\b(alpaca|deepseek|gemini|tiingo|openai|sec|api|apis|json|csv|http|https|websocket|server|backend|database|postgres\w*|sqlite|docker|engine|user-agent|token|chat id|encrypted|encryption|session id|config|iex|ema|sma|vwap|bollinger)\b|خادم|قاعدة بيانات|قاعدة البيانات|المحرك|محرك|مشفر|تشفير|مفاتيح|واجهة برمجية|معرّف المحادثة|البوت/i;

test('pages: no technical wording reaches a reader', () => {
  let seen = 0;
  for (const f of files(ROOT)) {
    const s = fs.readFileSync(f, 'utf8');
    const texts = [];
    for (const m of s.matchAll(/L\(\s*(['"`])((?:\\.|(?!\1).)*)\1\s*,\s*(['"`])((?:\\.|(?!\3).)*)\3\s*\)/g)) texts.push(m[2], m[4]);
    for (const m of s.matchAll(/\[(['"])((?:\\.|(?!\1).)*)\1,\s*(['"])((?:\\.|(?!\3).)*)\3\]/g)) if (/[\u0600-\u06ff]/.test(m[2])) texts.push(m[2], m[4]);
    for (const t of texts) { seen++; assert.doesNotMatch(t, TECH, path.basename(f) + ': ' + t); }
    const tpl = /<template>[\s\S]*<\/template>/.exec(s);
    // nothing raw from the server is printed
    if (tpl) assert.doesNotMatch(tpl[0], /<code|\.message \}\}|rejectReason|\.detail \}\}|\.label \|\||e\.category|\/terminal/, path.basename(f));
  }
  assert.ok(seen > 250, 'the check reads the page texts');
});
