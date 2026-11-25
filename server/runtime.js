'use strict';
/**
 * Runtime settings resolved from the environment (host variables, .env or the shell).
 *
 * - Local use (default): binds to 127.0.0.1, key files in ./data, login optional.
 * - Production (NODE_ENV=production): binds to 0.0.0.0 on $PORT, key files in DATA_DIR, login REQUIRED.
 *
 * Nothing here is ever sent to the browser.
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const list = (v) => String(v || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

function hostOf(url) {
  if (!url) return null;
  try { return new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`).host.toLowerCase(); } catch { return null; }
}

/**
 * @param {object} env  process.env (or a test object)
 * @param {object} cfgServer  config.server ({ host, port }) used for local defaults
 */
function resolveRuntime(env = process.env, cfgServer = { host: '127.0.0.1', port: 8787 }) {
  const production = env.NODE_ENV === 'production';
  const host = env.HOST || (production ? '0.0.0.0' : cfgServer.host || '127.0.0.1');
  const port = Number(env.PORT) || cfgServer.port || 8787;
  const dataDir = path.resolve(env.DATA_DIR || path.join(ROOT, 'data'));
  const remote = !LOOPBACK.has(host);
  const password = env.DASHBOARD_PASSWORD || '';
  const passwordHash = env.DASHBOARD_PASSWORD_HASH || '';
  const baseUrl = env.APP_BASE_URL || null;
  const publicHosts = [...new Set([hostOf(env.APP_BASE_URL), ...list(env.ALLOWED_HOSTS).map(hostOf)].filter(Boolean))];
  const authRequired = remote || !!(password || passwordHash) || truthy(env.REQUIRE_LOGIN);
  return {
    production, host, port, remote, databaseUrl: env.DATABASE_URL || null, databaseSchema: env.DATABASE_SCHEMA || 'terminal', persistentPath: !!env.DATA_DIR, dataDir,
    baseUrl, publicHosts,
    authRequired, password, passwordHash,
    // behind the reverse proxy the client IP / scheme come from X-Forwarded-* (one hop)
    trustProxy: production ? 1 : false,
    secureCookies: production || truthy(env.SECURE_COOKIES),
    sessionIdleHours: Number(env.SESSION_IDLE_HOURS) || 12,
    sessionMaxDays: Number(env.SESSION_MAX_DAYS) || 7,
    shutdownTimeoutMs: (Number(env.SHUTDOWN_TIMEOUT_SEC) || 25) * 1000,
  };
}

/** Problems that must stop a production start (a misconfigured public dashboard must never come up unprotected). */
function validateRuntime(rt) {
  const errors = [];
  const warnings = [];
  if (!Number.isInteger(rt.port) || rt.port < 0 || rt.port > 65535) errors.push(`PORT must be a valid TCP port (got ${rt.port})`);
  if (rt.remote && !rt.password && !rt.passwordHash) {
    errors.push('DASHBOARD_PASSWORD (or DASHBOARD_PASSWORD_HASH) must be set: the dashboard is reachable from the network and would otherwise be unprotected');
  }
  if (rt.password && rt.password.length < 12) errors.push('DASHBOARD_PASSWORD must be at least 12 characters long');
  if (rt.passwordHash && !/^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/.test(rt.passwordHash)) errors.push('DASHBOARD_PASSWORD_HASH has an invalid format (create it with: npm run hash-password)');
  if (rt.remote && !rt.publicHosts.length) warnings.push('APP_BASE_URL not set: only localhost Host headers will be accepted until a public domain is configured');
  return { errors, warnings };
}

module.exports = { resolveRuntime, validateRuntime, hostOf, LOOPBACK, ROOT, truthy };
