'use strict';
/**
 * Runtime settings resolved from the environment (Railway Variables, .env or the shell).
 *
 * - Local use (default): binds to 127.0.0.1, data in ./data/terminal.db, login optional.
 * - Production / Railway: binds to 0.0.0.0 on $PORT, data on the persistent volume, login REQUIRED.
 *
 * Nothing here is ever sent to the browser.
 */
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const RAILWAY_MARKERS = ['RAILWAY_ENVIRONMENT_ID', 'RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT', 'RAILWAY_SERVICE_ID', 'RAILWAY_PROJECT_ID'];
/** Railway sends deploy-time healthchecks with this Host header (docs.railway.com/reference/healthchecks). */
const RAILWAY_HEALTHCHECK_HOST = 'healthcheck.railway.app';

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
  const onRailway = RAILWAY_MARKERS.some((k) => env[k]);
  const production = env.NODE_ENV === 'production' || onRailway;
  const host = env.HOST || (production ? '0.0.0.0' : cfgServer.host || '127.0.0.1');
  const port = Number(env.PORT) || cfgServer.port || 8787;
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH || null;
  const dataDir = path.resolve(env.DATA_DIR || volume || path.join(ROOT, 'data'));
  const remote = !LOOPBACK.has(host);
  const password = env.DASHBOARD_PASSWORD || '';
  const passwordHash = env.DASHBOARD_PASSWORD_HASH || '';
  const baseUrl = env.APP_BASE_URL || (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : null);
  const publicHosts = [...new Set([hostOf(env.APP_BASE_URL), hostOf(env.RAILWAY_PUBLIC_DOMAIN), ...list(env.ALLOWED_HOSTS).map(hostOf)].filter(Boolean))];
  const authRequired = remote || !!(password || passwordHash) || truthy(env.REQUIRE_LOGIN);
  return {
    production, onRailway, host, port, remote, databaseUrl: env.DATABASE_URL || null, databaseSchema: env.DATABASE_SCHEMA || 'terminal', persistentPath: !!(volume || env.DATA_DIR), dataDir,
    baseUrl, publicHosts, healthcheckHost: RAILWAY_HEALTHCHECK_HOST,
    authRequired, password, passwordHash,
    // behind Railway's proxy the client IP / scheme come from X-Forwarded-* (one hop)
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
  if (rt.remote && !rt.publicHosts.length) warnings.push('APP_BASE_URL / RAILWAY_PUBLIC_DOMAIN not set: only localhost Host headers will be accepted until a public domain is configured');
  if (rt.onRailway && !rt.persistentPath) warnings.push('No Railway volume detected (RAILWAY_VOLUME_MOUNT_PATH) and no DATA_DIR: the encryption keys would be lost on every redeploy');
  return { errors, warnings };
}

module.exports = { resolveRuntime, validateRuntime, hostOf, LOOPBACK, ROOT, RAILWAY_HEALTHCHECK_HOST, truthy };
