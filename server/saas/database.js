'use strict';
/**
 * Small asynchronous database interface for the control plane (accounts, invitations, audit): SQLite for local use,
 * PostgreSQL when hosted. SQL uses `?` placeholders. q() resolves to { rows, count }; tx(fn) runs fn(handle) in one
 * transaction. Database errors carry a status (409 for a uniqueness conflict, otherwise 503) and never SQL details.
 */
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function dbError(e, conflict) {
  if (e && e.status) return e;
  return Object.assign(new Error(conflict ? 'This already exists' : 'The account service is unavailable. Try again shortly'), { status: conflict ? 409 : 503, cause: e });
}

class SqliteDatabase {
  constructor(file) {
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.kind = 'sqlite';
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
    this.tail = Promise.resolve();
  }

  /** One statement or transaction at a time: a statement can never slip into another caller's transaction. */
  run(task) {
    const p = this.tail.then(task);
    this.tail = p.catch(() => {});
    return p;
  }

  exec(sql, params) {
    try {
      const s = this.db.prepare(sql);
      if (/^\s*SELECT|\bRETURNING\b/i.test(sql)) { const rows = s.all(...params); return { rows, count: rows.length }; }
      return { rows: [], count: Number(s.run(...params).changes) };
    } catch (e) { throw dbError(e, /UNIQUE/.test(e.message)); }
  }

  q(sql, params = []) { return this.run(() => this.exec(sql, params)); }

  tx(fn) {
    return this.run(async () => {
      try { this.db.exec('BEGIN IMMEDIATE'); } catch (e) { throw dbError(e); }
      try {
        const r = await fn({ q: async (sql, params = []) => this.exec(sql, params) });
        this.db.exec('COMMIT');
        return r;
      } catch (e) { try { this.db.exec('ROLLBACK'); } catch { /* already rolled back */ } throw dbError(e); }
    });
  }

  async migrate(statements) { for (const s of statements.sqlite) this.db.exec(s); }
  async close() { await this.tail; this.db.close(); }
}

const numbered = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };

class PostgresDatabase {
  constructor(url, { schema = 'control', max = 10, timeoutMs = 5000 } = {}) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema)) throw new Error('Invalid schema name');
    const { Pool, types } = require('pg');
    this.kind = 'postgres';
    this.schema = schema;
    const parsers = { getTypeParser: (oid, f) => (oid === 20 ? (v) => { const x = Number(v); if (!Number.isSafeInteger(x)) throw new Error('integer out of range'); return x; } : types.getTypeParser(oid, f)) };
    this.pool = new Pool({ connectionString: url, max, types: parsers, connectionTimeoutMillis: timeoutMs, statement_timeout: timeoutMs, query_timeout: timeoutMs + 1000, idle_in_transaction_session_timeout: timeoutMs * 2, options: `-c search_path=${schema}` });
    this.pool.on('error', () => { /* a lost idle connection is replaced on the next query */ });
  }

  async on(c, sql, params) {
    try { const r = await c.query(numbered(sql), params); return { rows: r.rows, count: r.rowCount }; } catch (e) { throw dbError(e, e.code === '23505'); }
  }

  q(sql, params = []) { return this.on(this.pool, sql, params); }

  async tx(fn) {
    let c;
    try { c = await this.pool.connect(); } catch (e) { throw dbError(e); }
    let broken = null;
    try {
      await this.on(c, 'BEGIN', []);
      const r = await fn({ q: (sql, params = []) => this.on(c, sql, params) });
      await this.on(c, 'COMMIT', []);
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK'); } catch (x) { broken = x; }
      throw dbError(e);
    } finally { c.release(broken || undefined); }
  }

  async migrate(statements) {
    await this.tx(async (t) => {
      if ((await t.q('SHOW server_encoding')).rows[0].server_encoding !== 'UTF8') throw Object.assign(new Error('The PostgreSQL database must use UTF8 encoding'), { status: 503, code: 'CONFIG' });
      await t.q('SELECT pg_advisory_xact_lock(727001)'); // two starting servers never migrate at once
      await t.q(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      for (const s of statements.postgres) await t.q(s);
    });
  }

  async close() { await this.pool.end(); }
}

module.exports = { SqliteDatabase, PostgresDatabase };
