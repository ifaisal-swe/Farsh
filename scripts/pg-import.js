'use strict';
/**
 * Moves the hosted platform from SQLite to PostgreSQL. STOP THE PLATFORM FIRST.
 *   SAAS_DATA_DIR=... SAAS_DATABASE_URL=postgres://... npm run pg:import
 *
 * Each database is copied in one transaction and compared row by row (count and SHA-256); trading accounts are also
 * reconciled (fills replayed against balances) before the commit. Anything different rolls that database back.
 * The SQLite files are never changed: a `.migrated` marker is written next to each one. Safe to run again.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const sha = (rows) => crypto.createHash('sha256').update(rows.map((r) => JSON.stringify(Object.keys(r).sort().map((k) => [k, r[k]]))).sort().join('\n')).digest('hex');
const tablesOf = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map((r) => r.name);
const mark = (file) => fs.writeFileSync(`${file}.migrated`, new Date().toISOString());

/** Opens a private copy, so the original (including its WAL) is never touched. */
function openCopy(file, tmp) {
  const to = path.join(tmp, crypto.randomUUID());
  for (const ext of ['', '-wal']) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, to + ext);
  const db = new DatabaseSync(to);
  const check = db.prepare('PRAGMA quick_check').all().map((r) => Object.values(r)[0]);
  if (check.length !== 1 || check[0] !== 'ok') throw new Error(`${file}: integrity check failed`);
  return db;
}

async function importAccounts({ file, url, schema, keyDir, tmp, log }) {
  const { Accounts } = require('../server/saas/accounts');
  if (!fs.existsSync(file) || fs.existsSync(`${file}.migrated`)) return false;
  const src = openCopy(file, tmp);
  const a = new Accounts({ url, schema, keyDir });
  try {
    await a.init();
    if ((await a.db.q('SELECT 1 AS x FROM users LIMIT 1')).count) throw new Error('the control schema already contains accounts');
    const have = new Set(tablesOf(src));
    await a.db.tx(async (t) => {
      // sessions are not moved: everybody signs in again
      for (const name of ['users', 'invites', 'resets', 'totp', 'audit']) {
        if (!have.has(name)) continue;
        const rows = src.prepare(`SELECT * FROM ${name}`).all().map((r) => ({ ...r }));
        for (const r of rows) await t.q(`INSERT INTO ${name}(${Object.keys(r).join(', ')}) VALUES (${Object.keys(r).map(() => '?').join(', ')})`, Object.values(r));
        const out = (await t.q(`SELECT * FROM ${name}`)).rows;
        if (out.length !== rows.length || sha(out) !== sha(rows)) throw new Error(`accounts: table ${name} differs after the copy`);
        log(`accounts.${name}: ${rows.length} rows verified`);
        if (name === 'totp') for (const r of out) a.open(r.secret); // the key file must fit
      }
    });
    mark(file);
    return true;
  } finally { src.close(); await a.close(); }
}

function importTerminal({ file, target, tmp, log }) {
  if (!fs.existsSync(file) || fs.existsSync(`${file}.migrated`)) return false;
  const { Store } = require('../server/db');
  const { createTgStore } = require('../server/telegram/store');
  const { reconcileSession } = require('../server/maintenance');
  const src = openCopy(file, tmp);
  let dst = null;
  try {
    const version = src.prepare('PRAGMA user_version').get().user_version;
    dst = new Store(null, { postgres: { ...target, onFatal: (m) => { throw new Error(m); } } });
    if (version !== dst.migration.to) throw new Error(`${file} has schema v${version}; open it once with this program version first (needs v${dst.migration.to})`);
    createTgStore(dst);
    if (dst.getActiveSession() || dst.db.prepare('SELECT 1 AS x FROM settings LIMIT 1').get()) throw new Error(`schema ${target.schema} already contains data`);
    dst.transaction(() => {
      for (const name of tablesOf(src)) {
        if (!dst.hasTable(name)) throw new Error(`unknown table ${name}`);
        const rows = src.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all().map((r) => ({ ...r }));
        if (rows.length) {
          const cols = Object.keys(rows[0]);
          // the plain statement: identity values must be kept, not generated
          const sql = `INSERT INTO ${name}(${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`;
          for (const r of rows) dst.db.query(sql, cols.map((c) => r[c]));
          const out = dst.db.query(`SELECT ${cols.join(', ')} FROM ${name}`).rows;
          if (out.length !== rows.length || sha(out) !== sha(rows)) throw new Error(`table ${name} differs after the copy`);
        }
        log(`${target.schema}.${name}: ${rows.length} rows verified`);
      }
      for (const r of dst.db.query("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = current_schema() AND is_identity = 'YES'").rows) {
        dst.db.query(`SELECT setval(pg_get_serial_sequence('${r.t}', '${r.c}'), GREATEST((SELECT COALESCE(MAX(${r.c}), 0) FROM ${r.t}), 1), (SELECT COUNT(*) > 0 FROM ${r.t}))`);
      }
      for (const { id } of dst.db.query('SELECT id FROM sessions').rows) {
        const rec = reconcileSession(dst, dst.getSession(id));
        if (!rec.ok) throw new Error(`session ${id} does not reconcile: ${rec.problems.join('; ')}`);
      }
    });
    mark(file);
    return true;
  } finally { src.close(); if (dst) dst.close(); }
}

async function importAll({ root, url, schema = 'control', prefix = 't', log = console.log }) {
  const { Provisioner } = require('../server/saas/provision');
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'dt-import-'));
  const prov = new Provisioner({ url, keyDir: root, prefix });
  const out = { accounts: false, terminals: 0, failed: [] };
  try {
    out.accounts = await importAccounts({ file: path.join(root, 'accounts.db'), url, schema, keyDir: root, tmp, log });
    const dir = path.join(root, 'tenants');
    for (const id of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
      const file = path.join(dir, id, 'terminal.db');
      if (!fs.existsSync(file) || fs.existsSync(`${file}.migrated`)) continue;
      try { if (importTerminal({ file, target: await prov.ensure(id), tmp, log })) out.terminals++; } catch (e) { out.failed.push({ id, error: e.message }); log(`FAILED ${id}: ${e.message}`); }
    }
    return out;
  } finally { await prov.close(); fs.rmSync(tmp, { recursive: true, force: true }); }
}

module.exports = { importAll };

if (require.main === module) {
  const { SAAS_DATA_DIR, SAAS_DATABASE_URL, SAAS_DATABASE_SCHEMA, SAAS_TENANT_PREFIX } = process.env;
  if (!SAAS_DATA_DIR || !SAAS_DATABASE_URL) { console.error('Set SAAS_DATA_DIR and SAAS_DATABASE_URL'); process.exit(78); }
  importAll({ root: path.resolve(SAAS_DATA_DIR), url: SAAS_DATABASE_URL, schema: SAAS_DATABASE_SCHEMA || 'control', prefix: SAAS_TENANT_PREFIX || 't' })
    .then((r) => { console.log(JSON.stringify(r)); process.exit(r.failed.length ? 1 : 0); }, (e) => { console.error(e.message); process.exit(1); });
}
