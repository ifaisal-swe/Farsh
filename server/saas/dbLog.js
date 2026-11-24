'use strict';
/** Clear database messages for the server log only. Never prints a password and never reaches a visitor. */
const HINTS = {
  ENOTFOUND: 'the host name does not exist here: use the internal address of the database in DATABASE_URL',
  EAI_AGAIN: 'the host name could not be looked up: is the app on the same network as the database?',
  ECONNREFUSED: 'nothing listens at this host and port: is the database running, and is the port right?',
  ECONNRESET: 'the database closed the connection: it may require (or refuse) SSL',
  ETIMEDOUT: 'no answer: the address is not reachable from this container',
  EHOSTUNREACH: 'the address is not reachable from this container',
  '28P01': 'wrong user name or password in DATABASE_URL',
  28000: 'this user may not sign in from here',
  '3D000': 'this database does not exist: check the name at the end of DATABASE_URL',
  42501: 'this user has no permission: it must be able to create roles and schemas',
  53300: 'too many connections: an old copy of the app may still hold them',
  '55P03': 'a lock is held by another copy of the app',
  '57P03': 'the database is still starting',
  57014: 'the statement took too long: a lock may be held by another copy of the app',
};

/** Where a URL points, without the password. */
function target(url) {
  try {
    const u = new URL(url);
    return `${u.hostname || '(no host)'}:${u.port || 5432}${u.pathname || ''} as ${decodeURIComponent(u.username) || '(no user)'}, password ${u.password ? 'set' : 'MISSING'}${u.search ? ', options set' : ''}`;
  } catch { return 'DATABASE_URL is not a valid address (expected postgresql://user:password@host:5432/name, no quotes or spaces)'; }
}

function passwords(url) {
  try { const p = new URL(url).password; return [p, decodeURIComponent(p)].filter(Boolean); } catch { return [String(url)]; }
}

/** One line about a failure: code, message, hint. */
function explain(error, url) {
  const e = (error && error.cause) || error || {};
  const inner = Array.isArray(e.errors) && e.errors.length ? e.errors[0] : e;
  const code = inner.code || e.code || '';
  let text = String(inner.message || e.message || 'unknown error').replace(/\s+/g, ' ').replace(/(postgres(?:ql)?:\/\/)\S+/gi, '$1***');
  for (const p of passwords(url)) text = text.split(p).join('***');
  const hint = HINTS[code] || (/timeout/i.test(text) ? HINTS.ETIMEDOUT : /SSL/i.test(text) ? HINTS.ECONNRESET : '');
  return `${code ? `${code}: ` : ''}${text.slice(0, 300)}${hint ? ` -> ${hint}` : ''}`;
}

module.exports = { target, explain };
