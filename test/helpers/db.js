'use strict';
/** Throwaway PostgreSQL schemas for tests. PG_TEST_URL must point at a disposable server. */
const crypto = require('node:crypto');
const path = require('node:path');
const { afterEach, beforeEach, after } = require('node:test');
const { Client } = require('pg');
const { Store } = require('../../server/db');
const { Accounts } = require('../../server/saas/accounts');

const URL = process.env.PG_TEST_URL;
if (!URL) throw new Error('PG_TEST_URL must point at a disposable PostgreSQL server (see README, Tests)');

const random = (p = 's') => p + crypto.randomBytes(8).toString('hex');
const made = new Set(); // schemas to erase at the end of the file
let open = []; // stores of the running test

/** A schema that disappears when it is closed. */
const temp = () => ({ url: URL, schema: random(), createSchema: true, dropOnClose: true });
/** A schema that survives closing: the same name (a path is fine) opens the same data. */
function named(name) {
  const schema = `f${crypto.createHash('sha256').update(path.resolve(String(name))).digest('hex').slice(0, 24)}`;
  made.add(schema);
  return { url: URL, schema, createSchema: true };
}
function track(s) { open.push(s); return s; }
const tempStore = () => track(new Store(temp()));
const openStore = (name) => track(new Store(named(name)));
async function makeAccounts(o = {}) { const schema = random('t'); made.add(schema); const a = new Accounts({ url: URL, schema, ...o }); await a.init(); return a; }
/** Settings of a hosted platform in its own corner of the test server. */
function platformEnv() { const schema = random('t'); made.add(schema); return { DATABASE_URL: URL, SAAS_DATABASE_SCHEMA: schema, SAAS_TENANT_PREFIX: random('x').slice(0, 11) }; }

beforeEach(() => { open = []; });
afterEach(() => { for (const s of open) s.close(); open = []; });
after(async () => {
  const c = new Client(URL);
  await c.connect();
  for (const s of made) await c.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`).catch(() => {});
  await c.end();
});

module.exports = { URL, temp, named, tempStore, openStore, makeAccounts, platformEnv, random };
