'use strict';
// Worker of db-postgres.js: owns the single PostgreSQL connection and answers one message at a time.
const { workerData: d } = require('node:worker_threads');
const { Client, types } = require('pg');

const num = (v) => Number(v);
const parsers = { getTypeParser: (oid, f) => (oid === 20 || oid === 1700 ? num : types.getTypeParser(oid, f)) };
let client = null;
let dead = false;

async function connect() {
  client = new Client({ connectionString: d.url, types: parsers, connectionTimeoutMillis: d.timeoutMs, statement_timeout: d.timeoutMs, lock_timeout: d.timeoutMs, idle_in_transaction_session_timeout: d.timeoutMs * 2, keepAlive: true, application_name: `dt:${d.schema}` });
  client.on('error', () => { dead = true; });
  client.on('end', () => { dead = true; });
  await client.connect();
  if ((await client.query('SHOW server_encoding')).rows[0].server_encoding !== 'UTF8') throw new Error('The PostgreSQL database must use UTF8 encoding');
  if (d.createSchema) await client.query(`CREATE SCHEMA IF NOT EXISTS ${d.schema}`);
  await client.query(`SET search_path TO ${d.schema}`);
  await client.query('SET synchronous_commit TO on');
  // the previous process of this customer may still be closing: wait a little for its lock
  for (let i = 0; ; i++) {
    const r = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 727002)) AS ok', [d.schema]);
    if (r.rows[0].ok) return;
    if (i >= 15) throw new Error('this account is already open in another process');
    await new Promise((x) => { setTimeout(x, 200); });
  }
}

let tail = Promise.resolve();
d.port.on('message', (m) => {
  tail = tail.then(async () => {
    let out;
    try {
      if (m.connect) { await connect(); out = { rows: [], count: 0 }; }
      else if (m.end) { await client.end(); out = { rows: [], count: 0 }; }
      else if (dead) throw Object.assign(new Error('connection lost'), { gone: true });
      else { const r = await client.query(m.sql, m.params); out = { rows: r.rows, count: r.rowCount || 0 }; }
    } catch (e) {
      // SQLSTATE present and connection alive = an ordinary statement error; anything else means the connection is gone
      const lost = dead || !e.code || !/^[0-9A-Z]{5}$/.test(e.code) || /^(08|57P|25P03)/.test(e.code);
      out = { err: e.message || 'connection failed', code: e.code, lost };
    }
    d.port.postMessage({ ...out, id: m.id });
    Atomics.add(d.sig, 0, 1);
    Atomics.notify(d.sig, 0);
  });
});
