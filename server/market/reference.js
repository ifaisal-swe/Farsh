'use strict';
/**
 * Reference-price router for hours the execution feed (Alpaca IEX/SIP stream) does not cover: early
 * pre-market, late after-hours and the 20:00–04:00 ET overnight session. Documented sources (read 2026-11-20):
 *
 *  - Alpaca  GET /v2/stocks/snapshots?feed=overnight  (free): latestQuote = real-time INDICATIVE quote derived
 *            from Blue Ocean ATS; latestTrade = 15-minute DELAYED trade. feed=boats (Algo Trader Plus) = real
 *            BOATS quotes/trades. The v1beta1 overnight/boats WebSocket streams are documented, but Alpaca staff
 *            reported them inactive and the status page does not list them, so this module polls REST.
 *  - Alpaca  GET /v2/stocks/{sym}/bars?feed=boats&timeframe=1Min (free: 15-minute delayed) — actual BOATS
 *            overnight candles, labelled DELAYED.
 *  - Tiingo  GET /tiingo/equity/intraday?tickers=..  24x5 consolidated REFERENCE price (derived: tngoLast /
 *            lqRefPrice + liquidity bid/ask), free Starter plan 50 requests/hour — one request covers all symbols.
 *
 * Nothing here is ever used as an execution quote: the agent stores it in MarketState.reference, labelled
 * INDICATIVE / DELAYED / QUOTE / TRADE with its provider, and simulated execution stays suspended.
 */
const { EventEmitter } = require('node:events');
const { fetchJson } = require('../util/http');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

class ReferencePriceService extends EventEmitter {
  constructor({ getCfg, getSecret, getSession, fetchImpl, now = () => Date.now(), log = () => {} }) {
    super();
    this.getCfg = getCfg;
    this.getSecret = getSecret;
    this.getSession = getSession; // () => MarketCalendar.info(now) of the main symbol
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.log = log;
    this.symbols = new Set();
    this.timer = null;
    this.lastPoll = { alpaca: 0, tiingo: 0 };
    this.disabledUntil = { alpaca: 0, tiingo: 0 };
    this.status = { alpaca: { lastOkAt: null, lastError: null }, tiingo: { lastOkAt: null, lastError: null } };
    this.bars = new Map(); // symbol -> { fetchedAt, bars }
    this.inFlight = false;
  }

  setSymbols(list) { this.symbols = new Set(list.filter(Boolean)); }

  start() {
    this.stop();
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, 15000);
    if (this.timer.unref) this.timer.unref();
  }

  stop() { clearInterval(this.timer); this.timer = null; }

  /** Active when the execution feed is not expected to carry data but a market session exists. */
  wanted() {
    const ov = this.getCfg().market.overnight || {};
    if (!ov.enabled || ov.provider === 'none' || !this.symbols.size) return false;
    const si = this.getSession();
    if (!si) return false;
    if (si.session === 'OVERNIGHT') return true;
    return (si.session === 'PRE' || si.session === 'POST') && si.feed && !si.feed.active;
  }

  chooseProvider() {
    const cfg = this.getCfg();
    const ov = cfg.market.overnight || {};
    const now = this.now();
    const alpacaOk = !!(this.getSecret('ALPACA_KEY_ID') && this.getSecret('ALPACA_SECRET_KEY')) && now >= this.disabledUntil.alpaca;
    const tiingoOk = !!this.getSecret('TIINGO_API_KEY') && cfg.tiingo && cfg.tiingo.enabled && now >= this.disabledUntil.tiingo;
    if (ov.provider === 'alpaca') return alpacaOk ? 'alpaca' : null;
    if (ov.provider === 'tiingo') return tiingoOk ? 'tiingo' : null;
    return alpacaOk ? 'alpaca' : (tiingoOk ? 'tiingo' : null);
  }

  async tick() {
    if (this.inFlight || !this.wanted()) return;
    const primary = this.chooseProvider();
    if (!primary) return;
    const cfg = this.getCfg();
    const auto = ((cfg.market.overnight || {}).provider || 'auto') === 'auto';
    const canTiingo = !!(this.getSecret('TIINGO_API_KEY') && cfg.tiingo && cfg.tiingo.enabled && this.now() >= this.disabledUntil.tiingo);
    const due = (prov) => {
      const sec = prov === 'alpaca' ? (cfg.market.overnight.pollSec || 60) : (cfg.tiingo.pollSec || 90);
      return this.now() - this.lastPoll[prov] >= sec * 1000;
    };
    const poll = async (prov) => {
      if (!due(prov)) return null;
      this.lastPoll[prov] = this.now();
      try {
        const out = prov === 'alpaca' ? await this.pollAlpaca() : await this.pollTiingo();
        this.status[prov] = { lastOkAt: this.now(), lastError: out.length ? null : 'No reference prices returned for subscribed symbols' };
        return out;
      } catch (e) {
        this.status[prov] = { ...this.status[prov], lastError: e.message };
        // Failing auth/subscription: do not retry until the provider can plausibly recover.
        if ([400, 401, 402, 403, 404, 409, 422].includes(e.status)) this.disabledUntil[prov] = this.now() + 30 * 60000;
        if (e.status === 429) this.disabledUntil[prov] = this.now() + 5 * 60000;
        this.emit('providerError', { provider: prov, message: e.message, status: e.status });
        return null;
      }
    };
    if (!due(primary)) return;
    this.inFlight = true;
    try {
      const first = await poll(primary);
      const references = first || [];
      // An authenticated Alpaca connection is not proof of overnight coverage for every ticker.
      // In AUTO mode ask Tiingo for the missing symbols (or all symbols if Alpaca failed).
      if (auto && primary === 'alpaca' && canTiingo && references.length < this.symbols.size) {
        const second = await poll('tiingo');
        if (second) {
          const covered = new Set(references.map((r) => r.symbol));
          for (const r of second) if (!covered.has(r.symbol)) references.push(r);
        }
      }
      for (const r of references) this.emit('reference', r);
    } finally { this.inFlight = false; }
  }

  alpacaHeaders() { return { 'APCA-API-KEY-ID': this.getSecret('ALPACA_KEY_ID'), 'APCA-API-SECRET-KEY': this.getSecret('ALPACA_SECRET_KEY') }; }

  async pollAlpaca() {
    const m = this.getCfg().market;
    const feed = (m.overnight && m.overnight.alpacaFeed) || 'overnight';
    const u = new URL('/v2/stocks/snapshots', m.dataBaseUrl);
    u.searchParams.set('symbols', [...this.symbols].join(','));
    u.searchParams.set('feed', feed);
    const { data } = await fetchJson(u.toString(), { headers: this.alpacaHeaders(), timeoutMs: 15000, fetchImpl: this.fetchImpl });
    const out = [];
    const provider = feed === 'boats' ? 'Alpaca BOATS (Blue Ocean ATS)' : 'Alpaca overnight (derived from BOATS)';
    const receivedAt = this.now();
    for (const sym of this.symbols) {
      const s = data && data[sym];
      if (!s) continue;
      const q = s.latestQuote;
      const t = s.latestTrade;
      if (q && q.bp > 0 && q.ap > 0) out.push({ symbol: sym, price: (q.bp + q.ap) / 2, bid: q.bp, ask: q.ap, ts: Date.parse(q.t), kind: feed === 'boats' ? 'QUOTE' : 'INDICATIVE', provider, receivedAt });
      else if (t && t.p > 0) out.push({ symbol: sym, price: t.p, ts: Date.parse(t.t), kind: feed === 'boats' ? 'TRADE' : 'DELAYED', provider, receivedAt });
    }
    return out.filter((r) => Number.isFinite(r.ts));
  }

  async pollTiingo() {
    const cfg = this.getCfg();
    const u = new URL('/tiingo/equity/intraday', cfg.tiingo.baseUrl || 'https://api.tiingo.com');
    u.searchParams.set('tickers', [...this.symbols].map((s) => s.toLowerCase()).join(','));
    const { data } = await fetchJson(u.toString(), { headers: { Authorization: `Token ${this.getSecret('TIINGO_API_KEY')}`, 'Content-Type': 'application/json' }, timeoutMs: 15000, fetchImpl: this.fetchImpl });
    const receivedAt = this.now();
    return (Array.isArray(data) ? data : []).map((r) => {
      const price = isNum(r.tngoLast) ? r.tngoLast : (isNum(r.lqRefPrice) ? r.lqRefPrice : null);
      return { symbol: String(r.ticker || '').toUpperCase(), price, bid: isNum(r.lqBidPrice) ? r.lqBidPrice : null, ask: isNum(r.lqAskPrice) ? r.lqAskPrice : null, ts: Date.parse(r.timestamp), kind: 'INDICATIVE', provider: 'Tiingo 24x5 (derived reference price)', receivedAt };
    }).filter((r) => r.price > 0 && Number.isFinite(r.ts) && this.symbols.has(r.symbol));
  }

  /**
   * Actual BOATS overnight 1-minute candles from Alpaca (free plan: at least 15 minutes delayed), cached
   * 5 minutes per symbol. Returns [] when unavailable. Bars are flagged { session:'OVERNIGHT', delayed }.
   */
  async overnightBars(symbol, { startMs, endMs }) {
    const cfg = this.getCfg();
    if (!(cfg.market.overnight && cfg.market.overnight.enabled) || !(this.getSecret('ALPACA_KEY_ID') && this.getSecret('ALPACA_SECRET_KEY'))) return [];
    if (this.now() < this.disabledUntil.alpaca) return [];
    const key = `${symbol}|${startMs}`;
    const c = this.bars.get(key);
    if (c && this.now() - c.fetchedAt < 5 * 60000) return c.bars;
    const delayed = (cfg.market.overnight.alpacaFeed || 'overnight') !== 'boats';
    const end = Math.min(endMs, this.now() - (delayed ? 16 * 60000 : 0));
    if (end <= startMs) return [];
    const u = new URL(`/v2/stocks/${encodeURIComponent(symbol)}/bars`, cfg.market.dataBaseUrl);
    for (const [k, v] of Object.entries({ timeframe: '1Min', start: new Date(startMs).toISOString(), end: new Date(end).toISOString(), feed: 'boats', limit: 1000, sort: 'asc', adjustment: cfg.market.adjustment })) u.searchParams.set(k, String(v));
    try {
      const { data } = await fetchJson(u.toString(), { headers: this.alpacaHeaders(), timeoutMs: 15000, fetchImpl: this.fetchImpl });
      const bars = ((data && data.bars) || []).map((b) => ({ time: Math.floor(Date.parse(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, session: 'OVERNIGHT', source: 'BOATS', delayed }));
      this.bars.set(key, { fetchedAt: this.now(), bars });
      return bars;
    } catch (e) {
      this.status.alpaca = { ...this.status.alpaca, lastError: `overnight bars: ${e.message}` };
      this.bars.set(key, { fetchedAt: this.now(), bars: [] });
      return [];
    }
  }

  summary() {
    return { active: this.wanted(), provider: this.chooseProvider(), symbols: [...this.symbols], status: this.status };
  }
}

module.exports = { ReferencePriceService };
