'use strict';
/**
 * Market data without keys (READ-ONLY), the approach used by open-source projects such as OpenBB and yfinance:
 *   stocks: Yahoo chart endpoint (candles) and Nasdaq quote endpoint (last price, bid, ask). Both are undocumented and
 *           meant for personal use; they can change or refuse at any time.
 *   crypto: Coinbase Exchange public market data (REST candles, WebSocket ticker), which needs no authentication.
 *
 * Rules kept here: plain requests under a generic client name, a low fixed rate, one request at a time. A refusal
 * (403/429) means waiting longer, never working around it. While nothing arrives the state is not SUBSCRIBED, the
 * quote ages past its limit and no simulated order can fill.
 */
const { EventEmitter } = require('node:events');
const { fetchJson } = require('../util/http');
const { TIMEFRAMES, etDateStr, etWallToUtcMs, addDays, bucketStart } = require('../util/time');
const { aggregate } = require('./candles');

const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart/';
const NASDAQ = 'https://api.nasdaq.com/api/quote/';
const HEADERS = { 'User-Agent': 'market-data-client/1.0' };
// source interval and range per timeframe; the rest is aggregated from finer bars so every bucket follows the same rules
const RANGE = { '1m': ['1m', '5d'], '3m': ['1m', '5d'], '5m': ['5m', '1mo'], '15m': ['15m', '1mo'], '30m': ['15m', '1mo'], '1h': ['15m', '1mo'], '1d': ['1d', '5y'] };
const money = (x) => { const n = Number(String(x == null ? '' : x).replace(/[$,]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const notFound = (s) => Object.assign(new Error(`Symbol ${s} not found`), { status: 404 });
const refused = (e) => [401, 403, 429].includes(e && e.status);

// ---------------------------------------------------------------- exchange calendar (NYSE rules)
const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const dow = (s) => new Date(`${s}T00:00:00Z`).getUTCDay();
const nth = (y, m, day, n) => { const first = dow(iso(y, m, 1)); return iso(y, m, 1 + ((day - first + 7) % 7) + (n - 1) * 7); };
const lastMonday = (y, m) => { const end = new Date(Date.UTC(y, m, 0)).getUTCDate(); const s = iso(y, m, end); return iso(y, m, end - ((dow(s) + 6) % 7)); };
function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100;
  const h = (19 * a + b - Math.floor(b / 4) - Math.floor((b - Math.floor((b + 8) / 25) + 1) / 3) + 15) % 30;
  const l = (32 + 2 * (b % 4) + 2 * Math.floor(c / 4) - h - (c % 4)) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return iso(y, Math.floor(n / 31), (n % 31) + 1);
}
/** Full closures of a year. A Saturday holiday moves to Friday (not New Year's Day), a Sunday one to Monday. */
function holidays(y) {
  const moved = (m, d, sat = true) => { const s = iso(y, m, d); return dow(s) === 0 ? addDays(s, 1) : dow(s) === 6 ? (sat ? addDays(s, -1) : null) : s; };
  return new Set([moved(1, 1, false), nth(y, 1, 1, 3), nth(y, 2, 1, 3), addDays(easter(y), -2), lastMonday(y, 5), moved(6, 19), moved(7, 4), nth(y, 9, 1, 1), nth(y, 11, 4, 4), moved(12, 25)].filter(Boolean));
}
/** 13:00 closes: the day after Thanksgiving, Christmas Eve and 3 July when they are trading days. */
const earlyCloses = (y) => new Set([addDays(nth(y, 11, 4, 4), 1), iso(y, 12, 24), iso(y, 7, 3)]);
function calendarRows(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) {
    const y = Number(d.slice(0, 4));
    if (dow(d) === 0 || dow(d) === 6 || holidays(y).has(d)) continue;
    const early = earlyCloses(y).has(d);
    out.push({ date: d, open: '09:30', close: early ? '13:00' : '16:00', session_open: '0400', session_close: early ? '1700' : '2000' });
  }
  return out;
}

/** "Nov 23, 2026 4:49 PM ET" -> milliseconds (start of that minute), or null. */
function nasdaqTime(s) {
  const m = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) (\d{1,2}):(\d{2}) (AM|PM)/.exec(String(s || ''));
  if (!m) return null;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1]) + 1;
  return mon ? etWallToUtcMs(iso(Number(m[3]), mon, Number(m[2])), (Number(m[4]) % 12) + (m[6] === 'PM' ? 12 : 0), Number(m[5])) : null;
}

function yahooBars(result) {
  const q = result.indicators.quote[0];
  const gran = result.meta.dataGranularity;
  const step = { '1m': 60, '5m': 300, '15m': 900 }[gran];
  const out = new Map();
  (result.timestamp || []).forEach((t, i) => {
    if (![q.open[i], q.high[i], q.low[i], q.close[i]].every((x) => typeof x === 'number' && x > 0)) return;
    const time = gran === '1d' ? bucketStart('1d', t) : Math.floor(t / step) * step;
    const had = out.get(time); // the forming bar is repeated with the current second
    if (had) { had.high = Math.max(had.high, q.high[i]); had.low = Math.min(had.low, q.low[i]); had.close = q.close[i]; had.volume = Math.max(had.volume, q.volume[i] || 0); return; }
    out.set(time, { time, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] || 0, vw: null, trades: 0 });
  });
  return [...out.values()].sort((a, b) => a.time - b.time);
}

class Polled extends EventEmitter {
  constructor({ fetchImpl, now = Date.now } = {}) { super(); Object.assign(this, { fetchImpl, now, mode: 'LIVE', symbols: new Set(), state: 'DISCONNECTED', active: true }); }
  setState(state, detail = '') { if (this.state === state) return; this.state = state; this.emit('connection', { state, detail }); }
  setMarketActive(a) { this.active = !!a; }
  verifySubscription() { return false; }
  forceReconnect() { return false; }
  async json(url) { return (await fetchJson(url, { headers: HEADERS, timeoutMs: 12000, fetchImpl: this.fetchImpl })).data; }
  async fetchNews() { return []; }
}

class PublicStockProvider extends Polled {
  constructor(o = {}) {
    super(o);
    this.pollMs = o.pollMs || 6000;
    this.seen = new Map(); // symbol -> { key, bar, barsAt }
    this.kind = new Map(); // symbol -> stocks | etf
    this.cache = new Map();
    this.refusals = 0;
  }

  get name() { return 'public'; }
  feedInfo() { return { provider: 'Public', feed: 'public', name: 'PUBLIC', realtime: true, label: 'LIVE — PUBLIC SOURCES', note: 'Candles from Yahoo, last price and bid/ask from Nasdaq, read every few seconds without keys. Personal use.', mode: 'LIVE' }; }

  async chart(symbol, interval, range) {
    const key = `${symbol}|${interval}|${range}`;
    const c = this.cache.get(key);
    if (c && this.now() - c.at < 20000) return c.p;
    const p = this.json(`${YAHOO}${encodeURIComponent(symbol.replace('.', '-'))}?interval=${interval}&range=${range}&includePrePost=true`).then((d) => { const r = d && d.chart && d.chart.result && d.chart.result[0]; if (!r) throw notFound(symbol); return r; });
    this.cache.set(key, { at: this.now(), p });
    if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    p.catch(() => this.cache.delete(key));
    return p;
  }

  async quote(symbol) {
    for (const k of this.kind.has(symbol) ? [this.kind.get(symbol)] : ['stocks', 'etf']) {
      const d = await this.json(`${NASDAQ}${encodeURIComponent(symbol)}/info?assetclass=${k}`);
      const x = d && d.data && d.data.primaryData;
      if (!x) continue;
      this.kind.set(symbol, k);
      return { price: money(x.lastSalePrice), bid: money(x.bidPrice), ask: money(x.askPrice), bidSize: money(x.bidSize) || 0, askSize: money(x.askSize) || 0, live: x.isRealTime === true, at: nasdaqTime(x.lastTradeTimestamp) };
    }
    throw notFound(symbol);
  }

  connect() { this.closed = false; this.setState('CONNECTING', 'public sources'); if (!this.loop) this.loop = this.run().finally(() => { this.loop = null; }); }
  disconnect() { this.closed = true; if (this.wake) this.wake(); this.setState('DISCONNECTED', 'closed by application'); }
  subscribe(list) { for (const s of list) this.symbols.add(s); this.emit('subscribed', { trades: [...this.symbols], quotes: [...this.symbols], bars: [...this.symbols] }); }
  unsubscribe(list) { for (const s of list) { this.symbols.delete(s); this.seen.delete(s); } }
  pause(ms) { return new Promise((r) => { const t = setTimeout(r, ms); if (t.unref) t.unref(); this.wake = () => { clearTimeout(t); r(); }; }); }

  async run() {
    while (!this.closed) {
      const t0 = this.now();
      for (const s of [...this.symbols]) {
        if (this.closed) return;
        try { await this.poll(s); this.refusals = 0; this.setState('SUBSCRIBED', 'public sources'); } catch (e) {
          this.emit('error', { code: e.status || 'PUBLIC', message: `Public price source: ${e.message}` });
          if (refused(e)) { this.refusals++; this.setState('RECONNECTING', 'the source asked us to wait'); await this.pause(Math.min(1800000, 60000 * 2 ** (this.refusals - 1))); } else if (e.status !== 404) this.setState('RECONNECTING', 'no answer');
        }
        await this.pause(250);
      }
      // a closed market needs no frequent reading
      const every = this.active ? Math.max(this.pollMs, this.symbols.size * 1200) : 60000;
      await this.pause(Math.max(500, every - (this.now() - t0)));
    }
  }

  async poll(symbol) {
    const st = this.seen.get(symbol) || { key: '', bar: 0, barsAt: 0 };
    this.seen.set(symbol, st);
    const q = await this.quote(symbol);
    const at = this.now();
    this.emit('heartbeat', { at, rttMs: null });
    // the bid and ask are current as of this answer; the source gives them no time of their own
    if (q.live && q.bid && q.ask) this.emit('quote', { symbol, bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, ts: at, receivedAt: at });
    if (q.price && q.at) {
      const key = `${q.price}|${q.at}`;
      if (key !== st.key) { st.key = key; this.emit('trade', { symbol, price: q.price, size: 0, ts: Math.min(at, q.at + 59999), exchange: 'PUBLIC', conditions: [], receivedAt: at }); }
    }
    if (at - st.barsAt >= 30000) {
      st.barsAt = at;
      const cur = Math.floor(at / 60000) * 60;
      const bars = yahooBars(await this.chart(symbol, '1m', '1d')).filter((b) => b.time < cur);
      for (const b of bars.slice(-5)) { if (b.time > st.bar) { if (st.bar) this.emit('bar', { symbol, ...b, receivedAt: at }); st.bar = b.time; } else this.emit('updatedBar', { symbol, ...b, receivedAt: at }); }
    }
  }

  async fetchBars(symbol, tf, { limit = 500 } = {}) {
    const [interval, range] = RANGE[tf];
    const bars = yahooBars(await this.chart(symbol, interval, range));
    return (interval === tf ? bars : aggregate(bars, tf)).slice(-limit);
  }

  async fetchMinuteWindow(symbol, startMs) { return yahooBars(await this.chart(symbol, '1m', '5d')).filter((b) => b.time * 1000 >= startMs); }

  async fetchSnapshot(symbol) {
    const days = yahooBars(await this.chart(symbol, '1d', '1mo'));
    const q = await this.quote(symbol);
    const now = new Date(this.now()).toISOString();
    const bar = (b) => (b ? { t: new Date(b.time * 1000).toISOString(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume } : null);
    const last = days[days.length - 1];
    const today = last && etDateStr(last.time * 1000) === etDateStr(this.now());
    return { latestTrade: q.price && q.at ? { p: q.price, s: 0, t: new Date(q.at).toISOString() } : null, latestQuote: q.live && q.bid && q.ask ? { bp: q.bid, ap: q.ask, bs: q.bidSize, as: q.askSize, t: now } : null, dailyBar: bar(last), prevDailyBar: bar(days[days.length - (today ? 2 : 2)]) };
  }

  async fetchSnapshots(list) { const o = {}; for (const s of list) { try { o[s] = await this.fetchSnapshot(s); } catch { /* left out */ } } return o; }
  async fetchAsset(symbol) { const { meta } = await this.chart(symbol, '1d', '1mo'); if (!['EQUITY', 'ETF'].includes(meta.instrumentType) || meta.currency !== 'USD') throw notFound(symbol); return { symbol, name: meta.longName || meta.shortName || symbol, exchange: meta.fullExchangeName || '', status: 'active', tradable: true, fractionable: false }; }
  async fetchCalendar(a, b) { return calendarRows(a, b); }
}

class PublicCryptoProvider extends Polled {
  constructor(o = {}) { super(o); this.WS = o.WebSocketImpl || require('ws'); this.rest = 'https://api.exchange.coinbase.com'; this.url = 'wss://ws-feed.exchange.coinbase.com'; this.tries = 0; this.last = new Map(); }
  get name() { return 'public-crypto'; }
  feedInfo() { return { provider: 'Public', feed: 'public-crypto', name: 'PUBLIC CRYPTO', realtime: true, label: 'LIVE — PUBLIC CRYPTO', note: 'Coinbase Exchange public market data. Prices on other exchanges can differ.', mode: 'LIVE' }; }
  id(s) { return s.replace('/', '-'); }

  connect() {
    this.closed = false;
    clearTimeout(this.retry);
    if (this.ws) return;
    this.setState('CONNECTING', this.url);
    const ws = new this.WS(this.url, { headers: HEADERS });
    this.ws = ws;
    ws.on('open', () => { this.alive = Date.now(); this.ask('subscribe', [...this.symbols]); this.ping = setInterval(() => { if (Date.now() - this.alive > 45000) ws.terminate(); else { try { ws.ping(); } catch { /* closing */ } } }, 15000); });
    ws.on('pong', () => { this.alive = Date.now(); this.emit('heartbeat', { at: this.alive, rttMs: null }); });
    ws.on('message', (raw) => { let m; try { m = JSON.parse(raw.toString()); } catch { return; } this.alive = Date.now(); this.onMessage(m, Date.now()); });
    ws.on('error', (e) => this.emit('error', { message: `Public crypto source: ${e.message}` }));
    ws.on('close', () => {
      clearInterval(this.ping);
      this.ws = null;
      if (this.closed) return;
      const delayMs = Math.min(60000, 1000 * 2 ** this.tries++);
      this.setState('RECONNECTING', 'connection closed');
      this.emit('reconnectScheduled', { attempt: this.tries, delayMs, marketActive: true, reason: null });
      this.retry = setTimeout(() => this.connect(), delayMs);
    });
  }

  ask(type, list) { if (this.ws && this.ws.readyState === 1 && list.length) this.ws.send(JSON.stringify({ type, product_ids: list.map((s) => this.id(s)), channels: ['ticker'] })); }
  subscribe(list) { for (const s of list) this.symbols.add(s); this.ask('subscribe', list); }
  unsubscribe(list) { for (const s of list) this.symbols.delete(s); this.ask('unsubscribe', list); }
  disconnect() { this.closed = true; clearTimeout(this.retry); clearInterval(this.ping); if (this.ws) { try { this.ws.close(); } catch { /* closed */ } } this.ws = null; this.setState('DISCONNECTED', 'closed by application'); }

  onMessage(m, receivedAt) {
    if (m.type === 'subscriptions') { this.tries = 0; this.setState('SUBSCRIBED', 'ticker'); const all = [...this.symbols]; this.emit('subscribed', { trades: all, quotes: all, bars: all }); return; }
    if (m.type === 'error') { this.emit('error', { message: `Public crypto source: ${m.message || 'error'}` }); return; }
    if (m.type !== 'ticker') return;
    const symbol = String(m.product_id).replace('-', '/');
    const ts = Date.parse(m.time);
    const n = (x) => Number(x);
    if (!this.symbols.has(symbol) || !(n(m.price) > 0) || !Number.isFinite(ts)) return;
    if (n(m.best_bid) > 0 && n(m.best_ask) > 0) this.emit('quote', { symbol, bid: n(m.best_bid), ask: n(m.best_ask), bidSize: n(m.best_bid_size) || 0, askSize: n(m.best_ask_size) || 0, ts, receivedAt });
    this.emit('trade', { symbol, price: n(m.price), size: n(m.last_size) || 0, ts, exchange: 'COINBASE', conditions: [], id: m.trade_id, receivedAt });
    // minute bars are built from every ticker print
    const time = Math.floor(ts / 60000) * 60;
    const b = this.last.get(symbol);
    if (b && b.time < time) { this.emit('bar', { symbol, ...b, receivedAt }); this.last.delete(symbol); }
    const c = this.last.get(symbol);
    const p = n(m.price);
    if (!c) this.last.set(symbol, { time, open: p, high: p, low: p, close: p, volume: n(m.last_size) || 0, vw: null, trades: 1 });
    else { c.high = Math.max(c.high, p); c.low = Math.min(c.low, p); c.close = p; c.volume += n(m.last_size) || 0; c.trades++; }
  }

  async candles(symbol, gran, startMs, endMs) {
    const rows = await this.json(`${this.rest}/products/${this.id(symbol)}/candles?granularity=${gran}&start=${new Date(startMs).toISOString()}&end=${new Date(endMs).toISOString()}`);
    return (Array.isArray(rows) ? rows : []).map(([time, low, high, open, close, volume]) => ({ time, open, high, low, close, volume, vw: null, trades: 0 })).sort((a, b) => a.time - b.time);
  }

  async fetchBars(symbol, tf, { limit = 500 } = {}) {
    const src = { '1m': 60, '3m': 60, '5m': 300, '15m': 900, '30m': 900, '1h': 3600, '1d': 86400 }[tf];
    const need = Math.min(1200, Math.ceil(limit * (TIMEFRAMES[tf].sec / src)));
    const out = new Map();
    for (let end = this.now(), left = need; left > 0; left -= 290) { const n = Math.min(290, left); for (const b of await this.candles(symbol, src, end - n * src * 1000, end)) out.set(b.time, b); end -= n * src * 1000; }
    const bars = [...out.values()].sort((a, b) => a.time - b.time);
    if (tf === '1d') return bars.map((b) => ({ ...b, time: bucketStart('1d', b.time + 43200) })).slice(-limit);
    return (src === TIMEFRAMES[tf].sec ? bars : aggregate(bars, tf)).slice(-limit);
  }

  async fetchMinuteWindow(symbol, startMs) {
    const out = [];
    const from = Math.max(startMs, this.now() - 86400000);
    for (let s = from; s < this.now(); s += 290 * 60000) out.push(...await this.candles(symbol, 60, s, Math.min(this.now(), s + 290 * 60000)));
    return [...new Map(out.map((b) => [b.time, b])).values()];
  }

  async fetchSnapshot(symbol) {
    const t = await this.json(`${this.rest}/products/${this.id(symbol)}/ticker`);
    const days = await this.candles(symbol, 86400, this.now() - 4 * 86400000, this.now());
    const bar = (b) => (b ? { t: new Date(b.time * 1000).toISOString(), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume } : null);
    return { latestTrade: { p: Number(t.price), s: Number(t.size), t: t.time }, latestQuote: { bp: Number(t.bid), ap: Number(t.ask), bs: 0, as: 0, t: t.time }, dailyBar: bar(days.at(-1)), prevDailyBar: bar(days.at(-2)) };
  }

  async fetchSnapshots(list) { const o = {}; for (const s of list) { try { o[s] = await this.fetchSnapshot(s); } catch { /* left out */ } } return o; }
  async fetchAsset(symbol) { const p = await this.json(`${this.rest}/products/${this.id(symbol)}`); if (!p || p.trading_disabled) throw notFound(symbol); return { symbol, name: symbol, exchange: 'CRYPTO', status: 'active', tradable: true, fractionable: true }; }
  async fetchCalendar() { return []; }
}

module.exports = { PublicStockProvider, PublicCryptoProvider, calendarRows, holidays, nasdaqTime, yahooBars };
