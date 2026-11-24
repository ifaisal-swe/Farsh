'use strict';
/**
 * Database safety: integrity checks, accounting reconciliation, consistent backups (VACUUM INTO),
 * one-time import of an existing database into the Railway volume, retention, and crash detection.
 *
 * Nothing here ever invents or rewrites trading records: reconciliation only REPORTS mismatches.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Portfolio } = require('./trading/portfolio');

const REQUIRED_TABLES = ['settings', 'sessions', 'fills', 'decisions'];
const stamp = (ms = Date.now()) => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** Replay every fill of a session through a fresh portfolio and compare with the stored balances. */
function reconcileSession(store, session) {
  if (!session) return { ok: true, session: null, note: 'no active session' };
  const stored = session.portfolio;
  const initial = (stored && stored.initialCapital) || session.initialCapital;
  const fills = store.listFills(session.id);
  const replay = new Portfolio({ initialCapital: initial });
  const problems = [];
  for (const f of fills) {
    try { replay.applyFill({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fees: f.fees || 0, ts: f.ts }); } catch (e) { problems.push(`fill ${f.id}: ${e.message}`); }
  }
  if (!stored) return { ok: problems.length === 0, sessionId: session.id, fills: fills.length, problems, note: 'no stored portfolio yet' };
  const tol = 0.01;
  const diffCash = +(stored.cash - replay.cash).toFixed(6);
  if (Math.abs(diffCash) > tol) problems.push(`cash ${stored.cash.toFixed(2)} stored vs ${replay.cash.toFixed(2)} from ${fills.length} fill(s)`);
  const syms = new Set([...Object.keys(stored.positions || {}), ...Object.keys(replay.positions)]);
  for (const s of syms) {
    const a = (stored.positions || {})[s]; const b = replay.positions[s];
    const qa = a && a.qty > 1e-9 ? a.qty : 0; const qb = b && b.qty > 1e-9 ? b.qty : 0;
    if (Math.abs(qa - qb) > 1e-6) problems.push(`${s} position ${qa} stored vs ${qb} from fills`);
  }
  const diffPnl = +((stored.realizedPnl || 0) - replay.realizedPnl).toFixed(6);
  if (Math.abs(diffPnl) > tol) problems.push(`realized P&L ${Number(stored.realizedPnl || 0).toFixed(2)} stored vs ${replay.realizedPnl.toFixed(2)} from fills`);
  return { ok: problems.length === 0, sessionId: session.id, fills: fills.length, cash: stored.cash, replayCash: replay.cash, problems };
}

/** Open a database file read-only and check it is a usable terminal database. */
function inspectDatabaseFile(file) {
  if (!fs.existsSync(file)) return { ok: false, error: 'file not found' };
  const head = Buffer.alloc(16);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, head, 0, 16, 0); } finally { fs.closeSync(fd); }
  if (head.toString('latin1') !== 'SQLite format 3\u0000') return { ok: false, error: 'not an SQLite database' };
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const check = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const missing = REQUIRED_TABLES.filter((t) => !tables.has(t));
    const counts = {};
    for (const t of ['sessions', 'fills', 'orders', 'decisions', 'watchlist', 'ai_usage']) if (tables.has(t)) counts[t] = db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
    const version = db.prepare('PRAGMA user_version').get().user_version;
    const ok = check.length === 1 && check[0] === 'ok' && !missing.length;
    return { ok, check, missing, counts, version, error: ok ? null : (missing.length ? `missing tables: ${missing.join(', ')}` : `integrity check: ${check.slice(0, 3).join('; ')}`) };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { try { if (db) db.close(); } catch { /* ignore */ } }
}

/** Copy of the live database (consistent snapshot) + verification. */
function createBackup(store, dir, label = 'manual') {
  const file = path.join(dir, `${label}-${stamp()}.db`);
  store.backupTo(file);
  const info = inspectDatabaseFile(file);
  if (!info.ok) throw new Error(`Backup written but failed verification: ${info.error}`);
  return { file, bytes: fs.statSync(file).size, counts: info.counts };
}

function listBackups(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.db')).map((f) => {
      const st = fs.statSync(path.join(dir, f));
      return { name: f, bytes: st.size, mtime: st.mtimeMs };
    }).sort((a, b) => b.mtime - a.mtime);
  } catch { return []; }
}

/** Keep the newest `keep` scheduled backups (manual and pre-migration/pre-import copies are never deleted here). */
function pruneBackups(dir, keep) {
  const sched = listBackups(dir).filter((b) => b.name.startsWith('scheduled-'));
  const removed = [];
  for (const b of sched.slice(keep)) { try { fs.unlinkSync(path.join(dir, b.name)); removed.push(b.name); } catch { /* ignore */ } }
  return removed;
}

/**
 * One-time import of an existing terminal database (e.g. the local data/terminal.db) into the data
 * directory, BEFORE the live database is opened. Place the file at <dataDir>/import/trading.db
 * (e.g. `railway volume files upload`). Rules:
 *  - the file must pass an integrity check and look like a terminal database;
 *  - the current database is backed up first;
 *  - if the current database already holds trading data, DB_IMPORT_CONFIRM=overwrite is required;
 *  - the import file is renamed afterwards so it is never applied twice.
 */
function applyPendingImport({ dbFile, importDir, backupDir, confirm = '', log = () => {} }) {
  const src = path.join(importDir, 'trading.db');
  if (!fs.existsSync(src)) return { applied: false };
  const info = inspectDatabaseFile(src);
  if (!info.ok) {
    const bad = `${src}.rejected-${stamp()}`;
    try { fs.renameSync(src, bad); } catch { /* ignore */ }
    log('error', `Database import rejected (${info.error}); file kept as ${path.basename(bad)}`);
    return { applied: false, error: info.error };
  }
  let current = null;
  if (fs.existsSync(dbFile)) current = inspectDatabaseFile(dbFile);
  const hasData = current && current.counts && ((current.counts.fills || 0) > 0 || (current.counts.sessions || 0) > 0);
  if (hasData && confirm !== 'overwrite') {
    log('error', `Database import NOT applied: the current database already contains ${current.counts.sessions || 0} session(s) and ${current.counts.fills || 0} fill(s). Set DB_IMPORT_CONFIRM=overwrite to replace it (a backup is taken first).`);
    return { applied: false, error: 'confirmation required', current: current.counts, incoming: info.counts };
  }
  fs.mkdirSync(backupDir, { recursive: true });
  let backup = null;
  if (fs.existsSync(dbFile)) {
    // the live DB is not open yet: copy the main file plus any WAL/SHM side files
    backup = path.join(backupDir, `pre-import-${stamp()}.db`);
    fs.copyFileSync(dbFile, backup);
    for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, backup + ext);
  }
  for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + ext); } catch { /* not present */ } }
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.copyFileSync(src, dbFile);
  const after = inspectDatabaseFile(dbFile);
  if (!after.ok || JSON.stringify(after.counts) !== JSON.stringify(info.counts)) throw new Error(`Imported database failed verification after copy (${after.error || 'record counts differ'})`);
  fs.renameSync(src, `${src}.imported-${stamp()}`);
  log('ok', `Database imported: ${JSON.stringify(info.counts)} (previous database backed up${backup ? ` to ${path.basename(backup)}` : ' — none existed'})`);
  return { applied: true, counts: info.counts, backup };
}

/** Crash detection: a run that did not reach a graceful stop leaves cleanShutdown=false behind. */
function markRunStart(store, now) {
  const prev = store.getSetting('runtime.run', null);
  store.setSetting('runtime.run', { startedAt: now, cleanShutdown: false, pid: process.pid });
  return prev && prev.cleanShutdown === false ? { unclean: true, previousStartedAt: prev.startedAt } : { unclean: false, previousStartedAt: prev ? prev.startedAt : null };
}
function markCleanShutdown(store, now) {
  const prev = store.getSetting('runtime.run', {}) || {};
  store.setSetting('runtime.run', { ...prev, cleanShutdown: true, stoppedAt: now });
}

module.exports = { reconcileSession, inspectDatabaseFile, createBackup, listBackups, pruneBackups, applyPendingImport, markRunStart, markCleanShutdown, stamp };
