'use strict';
/**
 * Minimal HTTP helper around global fetch with timeouts.
 * SAFETY: any request to an Alpaca host must be a GET (read-only market data / clock / assets).
 * This makes it impossible for this codebase to place, modify or cancel brokerage orders.
 */
class HttpError extends Error {
  constructor(message, { status = 0, body = null, url = '' } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

function assertReadOnlyBrokerRequest(url, method) {
  let host = '';
  try { host = new URL(url).hostname; } catch { throw new HttpError(`Invalid URL: ${url}`); }
  const m = String(method || 'GET').toUpperCase();
  if (/(^|\.)alpaca\.markets$/i.test(host) && m !== 'GET') {
    throw new HttpError(`Blocked ${m} to ${host}: this application is paper-trading only and never sends brokerage requests other than read-only GETs.`);
  }
  if (/(^|\.)alpaca\.markets$/i.test(host) && /\/v2\/(orders|positions)/i.test(new URL(url).pathname)) {
    throw new HttpError('Blocked access to brokerage order/position endpoints: paper-trading only.');
  }
}

async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 15000, fetchImpl } = {}) {
  assertReadOnlyBrokerRequest(url, method);
  const f = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res;
  try {
    res = await f(url, {
      method, headers: { Accept: 'application/json', ...headers },
      body: body == null ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new HttpError(`Request timed out after ${timeoutMs} ms`, { url, status: 0 });
    throw new HttpError(`Network error: ${e.message}`, { url, status: 0 });
  }
  let text = '';
  try { text = await res.text(); } finally { clearTimeout(timer); }
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) {
    const msg = (data && (data.message || (data.error && (data.error.message || data.error)))) || text || res.statusText;
    throw new HttpError(`HTTP ${res.status}: ${typeof msg === 'string' ? msg.slice(0, 300) : JSON.stringify(msg).slice(0, 300)}`, { status: res.status, body: data, url });
  }
  return { data, headers: res.headers, status: res.status };
}

async function fetchText(url, { headers = {}, timeoutMs = 15000, fetchImpl } = {}) {
  assertReadOnlyBrokerRequest(url, 'GET');
  const f = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await f(url, { headers, signal: ac.signal });
    const text = await res.text();
    if (!res.ok) throw new HttpError(`HTTP ${res.status} from ${new URL(url).hostname}`, { status: res.status, url });
    return text;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (e.name === 'AbortError') throw new HttpError(`Request timed out after ${timeoutMs} ms`, { url });
    throw new HttpError(`Network error: ${e.message}`, { url });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { HttpError, fetchJson, fetchText, assertReadOnlyBrokerRequest };
