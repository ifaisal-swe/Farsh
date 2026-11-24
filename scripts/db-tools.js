'use strict';
/**
 * Database tools (safe to run while the app is running: they never modify the source database).
 *
 *   node scripts/db-tools.js check  [--db data/terminal.db]
 *       integrity check, record counts and accounting reconciliation (cash/positions vs recorded fills)
 *
 *   node scripts/db-tools.js backup [--db data/terminal.db] [--out data/backups]
 *       consistent single-file copy (SQLite VACUUM INTO) + verification
 *
 *   node scripts/db-tools.js export-for-railway [--db data/terminal.db] [--out railway-import/trading.db]
 *       the same verified copy, named for the Railway import path (see DEPLOYMENT.md, "Migrate your data")
 *
 * Never commit the produced files: they contain your trading history (they are git-ignored).
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Portfolio } = require('../server/trading/portfolio');
const { inspectDatabaseFile, stamp } = require('../server/maintenance');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const ROOT = path.join(__dirname, '..');
const dbFile = path.resolve(opt('db', process.env.DATABASE_PATH || path.join(ROOT, 'data', 'terminal.db')));

function reconcileReadOnly(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const s = db.prepare('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get();
    if (!s) return { ok: true, note: 'no active session' };
    const stored = s.portfolio_json ? JSON.parse(s.portfolio_json) : null;
    const fills = db.prepare('SELECT json FROM fills WHERE session_id = ? ORDER BY ts ASC').all(s.id).map((r) => JSON.parse(r.json));
    const replay = new Portfolio({ initialCapital: (stored && stored.initialCapital) || s.initial_capital });
    const problems = [];
    for (const f of fills) { try { replay.applyFill({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fees: f.fees || 0, ts: f.ts }); } catch (e) { problems.push(`fill ${f.id}: ${e.message}`); } }
    if (stored && Math.abs(stored.cash - replay.cash) > 0.01) problems.push(`cash ${stored.cash.toFixed(2)} stored vs ${replay.cash.toFixed(2)} from fills`);
    if (stored) {
      for (const sym of new Set([...Object.keys(stored.positions || {}), ...Object.keys(replay.positions)])) {
        const a = ((stored.positions || {})[sym] || {}).qty || 0; const b = (replay.positions[sym] || {}).qty || 0;
        if (Math.abs(a - b) > 1e-6) problems.push(`${sym}: ${a} stored vs ${b} from fills`);
      }
    }
    return { ok: !problems.length, sessionId: s.id, symbol: s.symbol, fills: fills.length, cash: stored ? stored.cash : s.initial_capital, problems };
  } finally { db.close(); }
}

function consistentCopy(src, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (fs.existsSync(out)) throw new Error(`${out} already exists — choose another --out`);
  const db = new DatabaseSync(src);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
  } finally { db.close(); }
  const info = inspectDatabaseFile(out);
  if (!info.ok) throw new Error(`copy failed verification: ${info.error}`);
  return info;
}

function main() {
  if (!['check', 'backup', 'export-for-railway'].includes(cmd)) {
    console.log('Usage: node scripts/db-tools.js <check|backup|export-for-railway> [--db file] [--out path]');
    process.exit(2);
  }
  if (!fs.existsSync(dbFile)) { console.error(`Database not found: ${dbFile}`); process.exit(1); }
  if (cmd === 'check') {
    const info = inspectDatabaseFile(dbFile);
    console.log(`Database: ${dbFile}`);
    console.log(`Integrity: ${info.ok ? 'OK' : `FAILED — ${info.error}`}  (schema v${info.version})`);
    console.log('Records:', JSON.stringify(info.counts));
    const rec = reconcileReadOnly(dbFile);
    console.log(`Accounting: ${rec.ok ? 'OK' : 'MISMATCH'}${rec.sessionId ? ` — session #${rec.sessionId} (${rec.symbol}), ${rec.fills} fill(s), cash $${Number(rec.cash).toFixed(2)}` : ` — ${rec.note}`}`);
    for (const p of rec.problems || []) console.log(`  - ${p}`);
    process.exit(info.ok && rec.ok ? 0 : 1);
  }
  const out = path.resolve(cmd === 'backup' ? path.join(opt('out', path.join(path.dirname(dbFile), 'backups')), `manual-${stamp()}.db`) : opt('out', path.join(ROOT, 'railway-import', 'trading.db')));
  const info = consistentCopy(dbFile, out);
  const rec = reconcileReadOnly(out);
  console.log(`Verified copy written: ${out} (${(fs.statSync(out).size / 1048576).toFixed(2)} MB)`);
  console.log('Records:', JSON.stringify(info.counts));
  console.log(`Accounting: ${rec.ok ? 'OK' : `MISMATCH — ${rec.problems.join('; ')}`}`);
  if (cmd === 'export-for-railway') {
    console.log('\nNext (see DEPLOYMENT.md): upload it to the volume as import/trading.db, e.g.');
    console.log(`  railway volume files upload "${out}" /import/trading.db`);
    console.log('then redeploy; the app imports it once on start (after backing up the database already on the volume).');
  }
}

main();
