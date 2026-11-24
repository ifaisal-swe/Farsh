'use strict';
/**
 * Operator's service keys, entered here and nowhere else (no web page accepts or shows them):
 *   node scripts/services.js list
 *   node scripts/services.js set ALPACA_KEY_ID       (asks for the value without showing it)
 *   node scripts/services.js unset ALPACA_KEY_ID
 *   node scripts/services.js scope operator|everyone
 *   node scripts/services.js allow|deny EMAIL        (one account may use the keys)
 *   node scripts/services.js setup                   (asks for each key; Enter skips)
 *   node scripts/services.js check                   (tests the saved keys with one read-only request each)
 * Restart the platform afterwards.
 */
const path = require('node:path');
const { PlatformServices, NAMES } = require('../server/saas/services');

const dir = path.resolve(process.env.SAAS_DATA_DIR || path.join(__dirname, '..', 'data', 'saas'));
const s = new PlatformServices({ dir });
const [cmd, arg] = process.argv.slice(2);

function hidden(prompt) {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const { stdin } = process;
    let v = '';
    if (!stdin.isTTY) { stdin.on('data', (d) => { v += d; }); stdin.on('end', () => resolve(v)); return; }
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    const on = (d) => {
      for (const ch of d.replace(/\x1b\[20[01]~/g, '')) {
        if (ch === '\r' || ch === '\n') { stdin.off('data', on); stdin.setRawMode(false); stdin.pause(); process.stdout.write('\n'); resolve(v); return; }
        if (ch === '\u0003') process.exit(130);
        v = ch === '\u007f' || ch === '\b' ? v.slice(0, -1) : v + ch;
      }
    };
    stdin.on('data', on);
  });
}

/** One read-only request per service. Prints the result and never a key. */
async function check() {
  const v = s.load().values;
  const get = async (url, headers) => { const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'the key was refused' : `answered ${r.status}`); return r.json(); };
  const alpaca = { 'APCA-API-KEY-ID': v.ALPACA_KEY_ID, 'APCA-API-SECRET-KEY': v.ALPACA_SECRET_KEY };
  const jobs = [
    ['Live prices', v.ALPACA_KEY_ID && v.ALPACA_SECRET_KEY, async () => { const d = await get('https://data.alpaca.markets/v2/stocks/NVDA/trades/latest?feed=iex', alpaca); return `NVDA ${d.trade.p} at ${d.trade.t}`; }],
    ['AI analysts (OpenRouter)', v.OPENROUTER_API_KEY, async () => {
      const d = await get('https://openrouter.ai/api/v1/key', { Authorization: `Bearer ${v.OPENROUTER_API_KEY}` });
      const m = await get('https://openrouter.ai/api/v1/models', {});
      const want = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-v4.1-flash-1017';
      if (!m.data.some((x) => x.id === want)) throw new Error(`answered, but it does not offer ${want}`);
      return `key accepted, ${want} available${d.data && d.data.limit_remaining != null ? `, ${d.data.limit_remaining} credit left on this key` : ''}`;
    }],
    ['AI (DeepSeek)', v.DEEPSEEK_API_KEY, async () => { const d = await get('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${v.DEEPSEEK_API_KEY}` }); return d.is_available === false ? 'key accepted, but the balance is empty' : 'key accepted'; }],
    ['AI (Gemini)', v.GEMINI_API_KEY, async () => { await get('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { 'x-goog-api-key': v.GEMINI_API_KEY }); return 'key accepted'; }],
    ['Sharia check', v.SEC_USER_AGENT, async () => { await get('https://data.sec.gov/submissions/CIK0001045810.json', { 'User-Agent': v.SEC_USER_AGENT }); return 'connected'; }],
    ['Telegram', v.TELEGRAM_BOT_TOKEN, async () => { const d = await get(`https://api.telegram.org/bot${v.TELEGRAM_BOT_TOKEN}/getMe`, {}); return `connected as @${d.result.username}`; }],
  ];
  for (const [name, set, run] of jobs) {
    if (!set) { console.log(`-    ${name}: not set`); continue; }
    // only our own messages: a network error can carry the address, and Telegram's contains the token
    try { console.log(`OK   ${name}: ${await run()}`); } catch (e) { console.log(`FAIL ${name}: ${/^(the key was|answered)/.test(e.message) ? e.message : 'could not be reached'}`); }
  }
}

const ASK = [['OPENROUTER_API_KEY', 'OpenRouter key, for the AI analysts'], ['ALPACA_KEY_ID', 'Alpaca key ID (optional)'], ['ALPACA_SECRET_KEY', 'Alpaca secret key (optional)'], ['DEEPSEEK_API_KEY', 'DeepSeek key (optional)'], ['GEMINI_API_KEY', 'Gemini key (optional)'], ['SEC_USER_AGENT', 'Your name and contact e-mail, for company filings (optional)'], ['TELEGRAM_BOT_TOKEN', 'Telegram bot token (optional)']];

(async () => {
  if (cmd === 'check') { await check(); return; }
  if (cmd === 'setup') {
    const have = s.describe().set;
    console.log('Paste each value and press Enter. Nothing is shown while you paste. Enter alone skips.\n');
    for (const [n, label] of ASK) { const v = (await hidden(`${label}${have.includes(n) ? ' [already set]' : ''}: `)).trim(); if (v) s.set(n, v); }
    console.log('\nTesting:');
    await check();
    return;
  }
  if (cmd === 'list') { const d = s.describe(); console.log(`scope: ${d.scope}${d.allow.length ? `, also allowed: ${d.allow.join(', ')}` : ''}`); for (const n of NAMES) console.log(`${n}: ${d.set.includes(n) ? 'set' : 'not set'}`); return; }
  if (cmd === 'set' && NAMES.includes(arg)) { s.set(arg, await hidden(`${arg}: `)); console.log('Saved (encrypted). Restart the platform.'); return; }
  if (cmd === 'unset' && NAMES.includes(arg)) { s.unset(arg); console.log('Removed. Restart the platform.'); return; }
  if (cmd === 'allow' || cmd === 'deny') { s.allow(arg, cmd === 'allow'); console.log(`${cmd === 'allow' ? 'Allowed' : 'Removed'}: ${arg}. Restart the platform.`); return; }
  if (cmd === 'scope') { s.scope(arg); if (arg === 'everyone') console.log('Customers will now be served by these keys. Make sure every plan allows it: most market data plans forbid redistribution.'); return; }
  console.error(`Usage: services.js list | set NAME | unset NAME | allow|deny EMAIL | setup | check | scope operator|everyone\nNames: ${NAMES.join(', ')}`);
  process.exitCode = 2;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
