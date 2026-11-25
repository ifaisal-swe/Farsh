'use strict';
/**
 * Pre-deployment check (run with the variables you will set on your host, or with --production to
 * simulate them). It never prints secret values.
 *
 *   npm run preflight                 checks the current environment / .env
 *   npm run preflight -- --production as if NODE_ENV=production (public dashboard, login required)
 */
const fs = require('node:fs');
const path = require('node:path');

const envFile = path.join(__dirname, '..', '.env');
const env = { ...process.env };
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) env[m[1]] = v;
  }
}
if (process.argv.includes('--production')) env.NODE_ENV = 'production';

const { resolveRuntime, validateRuntime } = require('../server/runtime');
const { DEFAULTS, validatePatch } = require('../server/config');

const rt = resolveRuntime(env, DEFAULTS.server);
const v = validateRuntime(rt);
const set = (k) => !!(env[k] && String(env[k]).trim());
const rows = [];
const ok = (m) => rows.push(['OK  ', m]);
const warn = (m) => rows.push(['WARN', m]);
const fail = (m) => rows.push(['FAIL', m]);

for (const e of v.errors) fail(e);
for (const w of v.warnings) warn(w);
ok(`bind ${rt.host}:${rt.port}, data folder ${rt.dataDir}, login ${rt.authRequired ? 'required' : 'off (local only)'}`);
if (rt.production && !rt.persistentPath) warn('No DATA_DIR: set it to a folder on a persistent volume (e.g. /data) or the encryption keys are lost on redeploy');
if (!(set('ALPACA_KEY_ID') || set('ALPACA_API_KEY')) || !(set('ALPACA_SECRET_KEY') || set('ALPACA_API_SECRET'))) warn('Alpaca keys not set as variables (they can also be saved in Settings → Credentials, encrypted on the volume)');
else ok('Alpaca keys present');
if (!set('DEEPSEEK_API_KEY') && !set('GEMINI_API_KEY')) warn('No AI key variable (DEEPSEEK_API_KEY or GEMINI_API_KEY); can also be saved in Settings');
else ok(`AI keys: ${['DEEPSEEK_API_KEY', 'GEMINI_API_KEY'].filter(set).join(', ')}`);
if (set('TELEGRAM_BOT_TOKEN')) ok(`Telegram token present; chat ids: ${set('TELEGRAM_CHAT_ID') ? 'from TELEGRAM_CHAT_ID' : 'set them in Settings → Telegram'}`);
else warn('TELEGRAM_BOT_TOKEN not set (Telegram stays off until a token is saved)');
if (rt.production && !set('TERMINAL_MASTER_KEY')) warn('TERMINAL_MASTER_KEY not set: a random key is created in the data folder (keys saved in Settings then depend on that file — keep the volume)');
if (rt.databaseUrl) ok('DATABASE_URL present'); else fail('DATABASE_URL must be set (PostgreSQL)');
const errs = validatePatch({});
if (errs.length) fail(`config/default.json: ${errs.join('; ')}`); else ok('config/default.json valid');

for (const [lvl, m] of rows) console.log(`[${lvl}] ${m}`);
const failed = rows.some(([l]) => l === 'FAIL');
console.log(failed ? '\nPreflight FAILED — fix the items above before deploying.' : '\nPreflight passed.');
process.exit(failed ? 1 : 0);
