'use strict';
/**
 * Alpaca Market Data provider (READ-ONLY). Docs checked 2026-11-19:
 *   stream:  wss://stream.data.alpaca.markets/v2/{iex|sip|delayed_sip}  (test: /v2/test, symbol FAKEPACA)
 *   REST:    https://data.alpaca.markets/v2/stocks/{sym}/bars|snapshot, /v1beta1/news
 *   info:    https://paper-api.alpaca.markets/v2/assets/{sym}, /v2/calendar, /v2/clock  (GET only)
 * No order endpoint is ever called — util/http.js blocks any non-GET request to *.alpaca.markets.
 *
 * Feed honesty:
 *   iex          real-time, but a SINGLE venue (IEX) — prices are real, volume is partial.
 *   sip          real-time consolidated tape (all US exchanges) — requires a paid Algo Trader Plus plan.
 *   delayed_sip  15-minute delayed consolidated data — shown as DELAYED; simulated trading is disabled.
 */
const { EventEmitter } = require('node:events');
const { fetchJson } = require('../util/http');
const { TIMEFRAMES, parseTs, etDateStr, addDays } = require('../util/time');

const FEEDS = {
  iex: { realtime: true, name: 'ALPACA IEX', label: 'LIVE — ALPACA IEX', historicalFeed: 'iex', note: 'Real-time from the IEX exchange only (single venue). Prices are genuine prints; volume covers only IEX (a small share of total US volume). For the full consolidated tape use SIP.' },
  sip: { realtime: true, name: 'ALPACA SIP', label: 'LIVE — ALPACA SIP', historicalFeed: 'sip', note: 'Real-time consolidated tape (all US exchanges). Requires an Alpaca Algo Trader Plus subscription.' },
  delayed_sip: { realtime: false, name: 'ALPACA SIP (15-MIN DELAYED)', label: 'DELAYED — 15 MINUTES (ALPACA SIP)', historicalFeed: 'sip', note: '15-minute delayed consolidated data. Charts update, but simulated execution is disabled because quotes are not current.' },
};

const STREAM_ERRORS = {
  400: 'invalid syntax', 401: 'not authenticated', 402: 'authentication failed (check key ID / secret)', 403: 'already authenticated',
  404: 'authentication timeout', 405: 'symbol limit exceeded', 406: 'connection limit exceeded (another app/tab may be using your Alpaca stream)',
  407: 'slow client', 409: 'insufficient subscription for this feed', 410: 'invalid subscribe action for this feed', 500: 'internal error',
};

const toBar = (b) => ({ time: Math.floor(parseTs(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vw: b.vw, trades: b.n });

class AlpacaProvider extends EventEmitter {
  constructor({ keyId, secretKey, feed = 'iex', cfg, WebSocketImpl, fetchImpl, adjustment = 'split' }) {
    super();
    if (!FEEDS[feed]) throw new Error(`Unknown Alpaca feed ${feed}`);
    this.keyId = keyId;
    this.secretKey = secretKey;
    this.feed = feed;
    this.cfg = cfg;
    this.adjustment = adjustment;
    this.WS = WebSocketImpl || require('ws');
    this.fetchImpl = fetchImpl;
    this.dataBase = cfg.dataBaseUrl;
    this.infoBase = cfg.tradingInfoBaseUrl;
    this.streamUrl = `${cfg.streamBaseUrl}/v2/${feed}`;
    this.ws = null;
    this.symbols = new Set();
    this.channels = { trades: true, quotes: true, bars: true, updatedBars: true, dailyBars: true, statuses: true, lulds: true };
    this.state = 'DISCONNECTED';
    this.closedByUser = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.nextAttemptAt = null;
    this.pingTimer = null;
    this.awaitingPong = false;
    this.lastPingAt = null;
    this.lastPongAt = null;
    this.fatal = null;
    this.marketActive = true; // false while the market/feed is closed: slower reconnect backoff
    this.subRetries = 0;
    this.verifying = false;
    this.mode = 'LIVE';
  }

  /** Exponential backoff with jitter; a closed market uses a much longer ceiling. */
  reconnectDelay(attempt, { marketActive = this.marketActive, fatalRetryable = false } = {}) {
    const base = this.cfg.reconnectBaseMs || 1000;
    const activeMax = this.cfg.reconnectMaxMs || 30000;
    const max = fatalRetryable ? Math.max(60000, activeMax) : (marketActive ? activeMax : (this.cfg.reconnectClosedMaxMs || 300000));
    return Math.min(max, base * 2 ** Math.min(Math.max(0, attempt - 1), 12));
  }

  /** Tell the provider whether data is expected now (market/feed open). Waking up reconnects at once. */
  setMarketActive(active) {
    const was = this.marketActive;
    this.marketActive = !!active;
    if (this.marketActive && !was && this.state === 'RECONNECTING' && !this.closedByUser && this.nextAttemptAt && this.nextAttemptAt - Date.now() > 2000) {
      clearTimeout(this.reconnectTimer);
      this.reconnectAttempts = 0;
      this.emit('info', { message: 'Market data expected now — reconnecting immediately instead of waiting for the closed-market backoff' });
      this.openSocket();
    }
  }

  /** Re-send the subscription; Alpaca answers with the full confirmed list (verifies the symbol is subscribed). */
  verifySubscription() {
    if (this.state !== 'SUBSCRIBED' || !this.symbols.size) return false;
    this.verifying = true;
    this.sendSubscribe([...this.symbols]);
    return true;
  }

  /** Drop the socket and reconnect through the normal backoff path (e.g. stream stopped delivering). */
  forceReconnect(reason) {
    if (this.closedByUser || !this.ws) return false;
    this.emit('info', { message: `Forcing stream reconnect: ${reason}` });
    try { this.ws.terminate(); } catch { /* ignore */ }
    return true;
  }

  get name() { return 'alpaca'; }
  feedInfo() { const f = FEEDS[this.feed]; return { provider: 'Alpaca', feed: this.feed, name: f.name, realtime: f.realtime, label: f.label, note: f.note, mode: 'LIVE' }; }

  headers() { return { 'APCA-API-KEY-ID': this.keyId, 'APCA-API-SECRET-KEY': this.secretKey }; }

  setState(state, detail = '') {
    this.state = state;
    this.emit('connection', { state, detail, url: this.streamUrl });
  }

  // ---------------- streaming ----------------
  connect() {
    this.closedByUser = false;
    this.fatal = null;
    this.openSocket();
  }

  openSocket() {
    clearTimeout(this.reconnectTimer);
    this.setState('CONNECTING', this.streamUrl);
    let ws;
    try {
      ws = new this.WS(this.streamUrl);
    } catch (e) {
      this.setState('ERROR', e.message);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.subRetries = 0;
    ws.on('open', () => this.setState('AUTHENTICATING', 'socket open, sending credentials'));
    ws.on('message', (raw) => this.onRaw(raw));
    ws.on('pong', () => {
      this.awaitingPong = false;
      this.lastPongAt = Date.now();
      this.emit('heartbeat', { at: this.lastPongAt, rttMs: this.lastPingAt ? this.lastPongAt - this.lastPingAt : null });
    });
    ws.on('error', (err) => this.emit('error', { message: `Stream error: ${err.message}` }));
    ws.on('close', (code, reason) => {
      this.stopPing();
      if (this.ws === ws) this.ws = null;
      if (this.closedByUser) { this.setState('DISCONNECTED', 'closed'); return; }
      const why = this.fatal ? this.fatal : `socket closed (${code}${reason && reason.length ? ` ${reason}` : ''})`;
      this.setState(this.fatal ? 'ERROR' : 'DISCONNECTED', why);
      if (!this.fatal || this.fatalRetryable) this.scheduleReconnect();
    });
  }

  scheduleReconnect() {
    if (this.closedByUser) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectAttempts++;
    const delay = this.reconnectDelay(this.reconnectAttempts, { fatalRetryable: this.fatalRetryable }) + Math.floor(Math.random() * 250);
    this.nextAttemptAt = Date.now() + delay;
    this.emit('reconnectScheduled', { attempt: this.reconnectAttempts, delayMs: delay, marketActive: this.marketActive, reason: this.fatal || null });
    this.setState('RECONNECTING', `attempt ${this.reconnectAttempts} in ${(delay / 1000).toFixed(1)}s${this.marketActive ? '' : ' (market closed — slow retry)'}`);
    this.reconnectTimer = setTimeout(() => { this.nextAttemptAt = null; this.fatal = null; this.fatalRetryable = false; this.openSocket(); }, delay);
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws) return;
      if (this.awaitingPong) {
        this.emit('error', { code: 'HEARTBEAT', message: 'Stream heartbeat lost (no pong) — reconnecting' });
        try { this.ws.terminate(); } catch { /* ignore */ }
        return;
      }
      this.awaitingPong = true;
      this.lastPingAt = Date.now();
      try { this.ws.ping(); } catch { /* ignore */ }
    }, this.cfg.pingIntervalMs || 20000);
  }

  stopPing() { clearInterval(this.pingTimer); this.pingTimer = null; this.awaitingPong = false; }

  send(obj) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj)); }

  onRaw(raw) {
    let msgs;
    try { msgs = JSON.parse(raw.toString()); } catch { this.emit('error', { message: 'Unparseable stream message' }); return; }
    if (!Array.isArray(msgs)) msgs = [msgs];
    const receivedAt = Date.now();
    for (const m of msgs) this.onMessage(m, receivedAt);
  }

  onMessage(m, receivedAt) {
    switch (m.T) {
      case 'success':
        if (m.msg === 'connected') this.send({ action: 'auth', key: this.keyId, secret: this.secretKey });
        else if (m.msg === 'authenticated') {
          this.reconnectAttempts = 0;
          this.setState('AUTHENTICATED', 'authenticated, subscribing');
          this.startPing();
          if (this.symbols.size) this.sendSubscribe([...this.symbols]);
          else this.setState('SUBSCRIBED', 'connected (no symbols)');
        }
        break;
      case 'subscription': {
        this.lastSubscription = m;
        const verify = this.verifying;
        this.verifying = false;
        const confirmed = (k, s) => Array.isArray(m[k]) && (m[k].includes(s) || m[k].includes('*'));
        const missing = [...this.symbols].filter((s) => !confirmed('trades', s) || !confirmed('quotes', s) || !confirmed('bars', s));
        if (missing.length) {
          // The server did not confirm what we asked for: never report this as subscribed.
          this.emit('error', { code: 'SUBSCRIPTION_MISMATCH', message: `Alpaca did not confirm the trades/quotes/bars subscription for ${missing.join(', ')}` });
          this.setState('AUTHENTICATED', `subscription not confirmed for ${missing.join(', ')}`);
          if (this.subRetries < 3) {
            this.subRetries++;
            setTimeout(() => { if (this.state === 'AUTHENTICATED' && this.ws) this.sendSubscribe([...this.symbols]); }, 2000 * this.subRetries);
          }
          break;
        }
        this.subRetries = 0;
        this.setState('SUBSCRIBED', `trades=${(m.trades || []).join(',')} quotes=${(m.quotes || []).join(',')} bars=${(m.bars || []).join(',')}${(m.statuses || []).length ? ' +statuses' : ''}`);
        this.emit('subscribed', { ...m, verify });
        break;
      }
      case 'error': {
        const desc = STREAM_ERRORS[m.code] || m.msg;
        this.emit('error', { code: m.code, message: `Alpaca stream error ${m.code}: ${desc}` });
        if (m.code === 402 || m.code === 409 && !this.lastSubAttemptHadOptional) {
          this.fatal = `${desc}`; this.fatalRetryable = false;
          try { this.ws.close(); } catch { /* ignore */ }
        } else if (m.code === 406) {
          this.fatal = desc; this.fatalRetryable = true;
          try { this.ws.close(); } catch { /* ignore */ }
        } else if ((m.code === 409 || m.code === 410) && this.lastSubAttemptHadOptional) {
          // statuses/LULD may not be available on this plan/feed: retry without optional channels
          this.channels.statuses = false; this.channels.lulds = false; this.channels.updatedBars = true;
          this.emit('info', { message: 'Halt/LULD status channels unavailable on this feed/plan — retrying subscription without them (halts will be read from the Nasdaq Trader feed).' });
          this.sendSubscribe([...this.symbols]);
        }
        break;
      }
      case 't':
        this.emit('trade', { symbol: m.S, price: m.p, size: m.s, ts: parseTs(m.t), exchange: m.x, conditions: m.c, id: m.i, tape: m.z, receivedAt });
        break;
      case 'q':
        this.emit('quote', { symbol: m.S, bid: m.bp, ask: m.ap, bidSize: m.bs, askSize: m.as, ts: parseTs(m.t), bidExchange: m.bx, askExchange: m.ax, conditions: m.c, receivedAt });
        break;
      case 'b': this.emit('bar', { symbol: m.S, ...toBar(m), receivedAt }); break;
      case 'u': this.emit('updatedBar', { symbol: m.S, ...toBar(m), receivedAt }); break;
      case 'd': this.emit('dailyBar', { symbol: m.S, ...toBar(m), receivedAt }); break;
      case 's':
        this.emit('status', { symbol: m.S, code: m.sc, message: m.sm, reasonCode: m.rc, reasonMessage: m.rm, ts: parseTs(m.t), receivedAt });
        break;
      case 'l': this.emit('luld', { symbol: m.S, up: m.u, down: m.d, indicator: m.i, ts: parseTs(m.t) }); break;
      case 'x': this.emit('tradeCancel', { symbol: m.S, id: m.i, action: m.a, price: m.p, size: m.s, ts: parseTs(m.t) }); break;
      case 'c': this.emit('correction', { symbol: m.S, origId: m.oi, corrId: m.ci, price: m.cp, size: m.cs, ts: parseTs(m.t) }); break;
      default: break;
    }
  }

  sendSubscribe(symbols) {
    const s = [...symbols];
    const msg = { action: 'subscribe', trades: s, quotes: s, bars: s };
    if (this.channels.updatedBars) msg.updatedBars = s;
    if (this.channels.dailyBars) msg.dailyBars = s;
    this.lastSubAttemptHadOptional = this.channels.statuses || this.channels.lulds;
    if (this.channels.statuses) msg.statuses = s;
    if (this.channels.lulds) msg.lulds = s;
    this.send(msg);
  }

  subscribe(symbols) {
    for (const s of symbols) this.symbols.add(s);
    if (this.state === 'AUTHENTICATED' || this.state === 'SUBSCRIBED') this.sendSubscribe(symbols);
  }

  unsubscribe(symbols) {
    for (const s of symbols) this.symbols.delete(s);
    if (this.ws && (this.state === 'SUBSCRIBED' || this.state === 'AUTHENTICATED')) {
      const msg = { action: 'unsubscribe', trades: symbols, quotes: symbols, bars: symbols, updatedBars: symbols, dailyBars: symbols };
      if (this.channels.statuses) msg.statuses = symbols;
      if (this.channels.lulds) msg.lulds = symbols;
      this.send(msg);
    }
  }

  disconnect() {
    this.closedByUser = true;
    clearTimeout(this.reconnectTimer);
    this.stopPing();
    if (this.ws) { try { this.ws.close(); } catch { /* ignore */ } }
    this.ws = null;
    this.setState('DISCONNECTED', 'closed by application');
  }

  // ---------------- REST (GET only) ----------------
  async get(base, pathname, params = {}) {
    const u = new URL(pathname, base);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== '') u.searchParams.set(k, String(v));
    const { data } = await fetchJson(u.toString(), { headers: this.headers(), timeoutMs: 20000, fetchImpl: this.fetchImpl });
    return data;
  }

  /** Latest `limit` bars ending now (or 16 min ago on the delayed feed), ascending. */
  async fetchBars(symbol, tf, { limit = 500, start, end } = {}) {
    const t = TIMEFRAMES[tf];
    const now = Date.now();
    const endMs = end || (this.feed === 'delayed_sip' ? now - 16 * 60000 : undefined);
    const startStr = start || addDays(etDateStr(now), -t.lookbackDays);
    const params = {
      timeframe: t.alpaca, start: startStr, end: endMs ? new Date(endMs).toISOString() : undefined,
      limit: Math.min(10000, limit), adjustment: this.adjustment, feed: FEEDS[this.feed].historicalFeed, sort: 'desc',
    };
    const data = await this.get(this.dataBase, `/v2/stocks/${encodeURIComponent(symbol)}/bars`, params);
    const bars = (data && data.bars) || [];
    return bars.map(toBar).reverse();
  }

  async fetchMinuteWindow(symbol, startMs) {
    const now = Date.now();
    const params = {
      timeframe: '1Min', start: new Date(startMs).toISOString(),
      end: this.feed === 'delayed_sip' ? new Date(now - 16 * 60000).toISOString() : undefined,
      limit: 10000, adjustment: this.adjustment, feed: FEEDS[this.feed].historicalFeed, sort: 'asc',
    };
    const data = await this.get(this.dataBase, `/v2/stocks/${encodeURIComponent(symbol)}/bars`, params);
    return ((data && data.bars) || []).map(toBar);
  }

  async fetchSnapshot(symbol) {
    const data = await this.get(this.dataBase, `/v2/stocks/${encodeURIComponent(symbol)}/snapshot`, { feed: this.feed });
    if (!data || (!data.latestTrade && !data.latestQuote && !data.dailyBar)) return null;
    return data;
  }

  async fetchSnapshots(symbols) {
    const data = await this.get(this.dataBase, '/v2/stocks/snapshots', { symbols: symbols.join(','), feed: this.feed });
    return data || {};
  }

  async fetchAsset(symbol) { return this.get(this.infoBase, `/v2/assets/${encodeURIComponent(symbol)}`); }
  async fetchCalendar(start, end) { return this.get(this.infoBase, '/v2/calendar', { start, end }); }
  async fetchClock() { return this.get(this.infoBase, '/v2/clock'); }

  async fetchNews(symbol, { limit = 20, start, end } = {}) {
    const data = await this.get(this.dataBase, '/v1beta1/news', {
      symbols: symbol, limit: Math.min(50, limit), sort: 'desc', start, end, include_content: 'false', exclude_contentless: 'false',
    });
    return (data && data.news) || [];
  }
}

module.exports = { AlpacaProvider, FEEDS, STREAM_ERRORS };
