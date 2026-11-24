'use strict';
/**
 * Small asynchronous PostgreSQL interface for the control plane (accounts, invitations, audit). SQL uses `?` placeholders. q() resolves to { rows, count }; tx(fn) runs fn(handle) in one
 * transaction. Database errors carry a status (409 for a uniqueness conflict, otherwise 503) and never SQL details.
 */
function dbError(e, conflict) {
  if (e && e.status) return e;
  return Object.assign(new Error(conflict ? 'This already exists' : 'The account service is unavailable. Try again shortly'), { status: conflict ? 409 : 503, cause: e });
}

const numbered = (sql) => { let n = 0; return sql.replace(/\?/g, () => `$${++n}`); };

class PostgresDatabase {
  constructor(url, { schema = 'control', max = 10, timeoutMs = 5000 } = {}) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(schema)) throw new Error('Invalid schema name');
    const { Pool, types } = require('pg');
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
      for (const s of statements) await t.q(s);
    });
  }

  async close() { await this.pool.end(); }
}

module.exports = { PostgresDatabase };
