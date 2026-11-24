'use strict';
/**
 * Minimal Telegram Bot API client (POST JSON). The bot token is only ever placed in the request URL;
 * it is redacted from every error message this module produces.
 * SAFETY: only talks to api.telegram.org — it has nothing to do with brokerage or order placement.
 */
const API_BASE = 'https://api.telegram.org';

class TelegramError extends Error {
  constructor(message, { status = 0, kind = 'API', retryAfter = null, method = '' } = {}) {
    super(message);
    this.name = 'TelegramError';
    this.status = status; // Telegram error_code / HTTP status; 0 for network errors
    this.kind = kind; // 'API' | 'NETWORK' | 'NO_TOKEN' | 'TIMEOUT'
    this.retryAfter = retryAfter; // seconds (HTTP 429)
    this.method = method;
  }
}

/** Builds a redactor that removes the given token (and anything shaped like a bot token) from text. */
function makeRedactor(getTokenSync) {
  return function redact(input) {
    if (input == null) return input;
    let s = String(input);
    let tok = null;
    try { tok = getTokenSync(); } catch { tok = null; }
    if (tok && typeof tok === 'string' && tok.length >= 6) {
      s = s.split(tok).join('<REDACTED>');
      const enc = encodeURIComponent(tok);
      if (enc !== tok) s = s.split(enc).join('<REDACTED>');
    }
    s = s.replace(/bot\d{3,}(?::|%3A)[A-Za-z0-9_-]{10,}/gi, 'bot<REDACTED>');
    s = s.replace(/\b\d{6,}(?::|%3A)[A-Za-z0-9_-]{25,}/gi, '<REDACTED>');
    return s;
  };
}

function createApi({ getToken, fetchImpl, redact, defaultTimeoutMs = 20000 }) {
  let lastToken = null;
  const resolveToken = async () => {
    const t = await getToken();
    lastToken = t || null;
    return lastToken;
  };

  /**
   * call(method, params, { timeoutMs, signal }) -> result
   * Throws TelegramError (token-free message).
   */
  async function call(method, params = {}, { timeoutMs = defaultTimeoutMs, signal } = {}) {
    const token = await resolveToken();
    if (!token) throw new TelegramError('لم يتم إعداد رمز بوت تيليجرام.', { kind: 'NO_TOKEN', method });
    const f = fetchImpl || globalThis.fetch;
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    if (signal) { if (signal.aborted) ac.abort(); else signal.addEventListener('abort', onAbort, { once: true }); }
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
    let res;
    try {
      res = await f(`${API_BASE}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(params || {}),
        signal: ac.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      const aborted = e && (e.name === 'AbortError' || ac.signal.aborted);
      throw new TelegramError(redact(`Telegram ${method}: ${aborted ? 'request aborted/timed out' : 'network error: ' + (e && e.message)}`),
        { kind: aborted ? 'TIMEOUT' : 'NETWORK', method });
    }
    let data = null;
    try {
      if (typeof res.text === 'function') {
        const text = await res.text();
        data = text ? JSON.parse(text) : null;
      } else if (typeof res.json === 'function') {
        data = await res.json();
      }
    } catch {
      data = null;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    const httpStatus = Number(res.status) || (res.ok === false ? 500 : 200);
    if (!data || data.ok !== true) {
      const status = (data && Number(data.error_code)) || (httpStatus >= 400 ? httpStatus : 500);
      const desc = (data && data.description) || `HTTP ${httpStatus}`;
      const retryAfter = data && data.parameters && Number.isFinite(Number(data.parameters.retry_after)) ? Number(data.parameters.retry_after) : null;
      throw new TelegramError(redact(`Telegram ${method} failed (${status}): ${String(desc).slice(0, 300)}`), { status, kind: 'API', retryAfter, method });
    }
    return data.result;
  }

  return { call, getLastToken: () => lastToken };
}

module.exports = { createApi, makeRedactor, TelegramError, API_BASE };
