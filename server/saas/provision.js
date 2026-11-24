'use strict';
/**
 * One PostgreSQL schema and login role per customer. A customer's role owns only its own schema: it has no rights on
 * the control schema or on another customer's. Passwords are derived from a key FILE (never stored in the database)
 * and set again at every start. The URL given here must belong to a role that may create roles and schemas.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const UUID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

class Provisioner {
  constructor({ url, keyDir, key = null, prefix = 't' }) {
    const { Pool } = require('pg');
    if (!/^[a-z][a-z0-9_]{0,15}$/.test(prefix)) throw new Error('Invalid prefix');
    this.url = url;
    this.prefix = prefix;
    this.pool = new Pool({ connectionString: url, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    this.pool.on('error', () => {});
    this.key = key || this.loadKey(keyDir);
  }

  loadKey(keyDir) {
    fs.mkdirSync(keyDir, { recursive: true });
    const f = path.join(keyDir, 'tenant-db.key');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
    const k = Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
    if (k.length !== 32) throw new Error('tenant-db.key is damaged');
    return k;
  }

  /** Has this account ever been opened? */
  async exists(id) { return (await this.pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [this.name(id)])).rowCount === 1; }

  name(id) {
    if (!UUID.test(String(id))) throw new Error('Invalid account id');
    return `${this.prefix}_${id.replace(/-/g, '')}`;
  }

  async ensure(id) {
    const n = this.name(id); // letters, digits and underscores only
    const password = crypto.createHmac('sha256', this.key).update(n).digest('hex');
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(727003)');
      const has = (await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [n])).rowCount === 1;
      // a role that is not a superuser may set these attributes only when it creates the role
      await c.query(has ? `ALTER ROLE ${n} PASSWORD '${password}'` : `CREATE ROLE ${n} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3 PASSWORD '${password}'`);
      // a non-superuser owner needs membership to create a schema for the role
      const me = (await c.query('SELECT rolsuper, current_user AS u FROM pg_roles WHERE rolname = current_user')).rows[0];
      if (!me.rolsuper) await c.query(`GRANT ${n} TO CURRENT_USER`);
      await c.query(`CREATE SCHEMA IF NOT EXISTS ${n} AUTHORIZATION ${n}`);
      await c.query(`REVOKE ALL ON SCHEMA ${n} FROM PUBLIC`);
      await c.query('REVOKE ALL ON SCHEMA public FROM PUBLIC');
      await c.query(`ALTER ROLE ${n} SET search_path TO ${n}`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
    const u = new URL(this.url);
    u.username = n;
    u.password = password;
    return { url: u.toString(), schema: n };
  }

  /** Erases one schema and its role. */
  drop(id) { return this.erase(this.name(id)); }

  /** Erases everything this prefix ever created. */
  async dropAll() {
    const r = await this.pool.query('SELECT rolname FROM pg_roles WHERE rolname ~ $1', [`^${this.prefix}_[0-9a-f]{32}$`]);
    for (const x of r.rows) await this.erase(x.rolname);
  }

  async erase(n) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT pg_advisory_xact_lock(727003)');
      await c.query(`DROP SCHEMA IF EXISTS ${n} CASCADE`);
      await c.query(`DROP ROLE IF EXISTS ${n}`);
      await c.query('COMMIT');
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
  }

  async close() { await this.pool.end(); }
}

module.exports = { Provisioner };
