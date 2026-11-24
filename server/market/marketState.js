'use strict';
/**
 * Live state of the selected symbol, with each piece of evidence tracked separately:
 *
 *   connection   CONNECTING -> AUTHENTICATING (socket open) -> AUTHENTICATED -> SUBSCRIBED
 *                (SUBSCRIBED only after the provider CONFIRMED the symbol's trades/quotes/bars),
 *                DISCONNECTED / RECONNECTING / ERROR / UNAVAILABLE
 *   lastTrade    last trade print           (exchange ts + receipt ts + source)
 *   lastQuote    last bid/ask (NBBO on SIP, IEX book on IEX)   (exchange ts + receipt ts + source)
 *   lastBar      last official minute bar   (bar end ts + receipt ts + source)
 *   heartbeat    WebSocket ping/pong         (connection diagnostics only)
 *
 * Market-data AGE is measured from EXCHANGE timestamps. Receipt timestamps are only used for
 * connection diagnostics (lag). An open WebSocket never makes old data "fresh".
 *
 * Two different questions are answered:
 *   freshness()  — is there execution-quality data right now (fresh, valid, streamed bid/ask)?
 *                  Session-agnostic. Simulated orders require stale === false.
 *   dataStatus() — what should the user see (LIVE / MARKET CLOSED / WAITING / STALE / RECONNECTING …),
 *                  which depends on the market session and the feed's coverage hours.
 */

const STREAM_UP = new Set(['AUTHENTICATING', 'AUTHENTICATED', 'SUBSCRIBED']);
const AUTHED = new Set(['AUTHENTICATED', 'SUBSCRIBED']);

/** Stable wording per reason code (no changing numbers — safe to use in logs and gate messages). */
const REASON_TEXT = {
  STREAM_NOT_READY: 'market data stream not subscribed',
  FEED_DELAYED: 'feed is not real-time',
  NO_QUOTE: 'no bid/ask quote received',
  QUOTE_NOT_STREAMED: 'latest bid/ask came from a REST snapshot, not the live stream',
  INVALID_QUOTE: 'latest quote is not a valid two-sided market',
  QUOTE_STALE: 'latest bid/ask is older than the freshness limit',
  DATA_LAGGING: 'exchange timestamps lag the local clock',
};

const fmtAge = (ms) => {
  if (ms == null) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 120) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 120) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
};

class MarketState {
  constructor({ symbol, cfg }) {
    this.symbol = symbol;
    this.cfg = cfg;
    this.feed = { provider: 'none', feed: 'none', realtime: false, label: 'NO DATA PROVIDER', note: '' };
    this.connection = { state: 'DISCONNECTED', since: Date.now(), detail: '' };
    this.everSubscribed = false;
    this.subscribedAt = null;
    this.subscription = null;
    this.sinceSubscribe = { trades: 0, quotes: 0, bars: 0, firstAt: null };
    this.heartbeat = { lastAt: null, rttMs: null };
    this.lastTrade = null;
    this.lastQuote = null;
    this.lastBar = null;
    this.halted = false;
    this.haltInfo = null;
    this.luld = null;
    this.lastMessageAt = 0;
    this.lastExchangeLagMs = null;
    this.firstTradeTs = null;
    this.counters = { trades: 0, quotes: 0, bars: 0 };
    this.unavailableReason = null;
  }

  setFeed(feed) { this.feed = { ...this.feed, ...feed }; }

  setConnection(state, detail = '', now = Date.now()) {
    if (state !== this.connection.state) {
      this.connection = { state, since: now, detail };
      if (state === 'SUBSCRIBED') {
        this.everSubscribed = true;
        this.subscribedAt = now;
        this.sinceSubscribe = { trades: 0, quotes: 0, bars: 0, firstAt: null };
      }
    } else this.connection.detail = detail;
  }

  /** Subscription confirmation as reported by the provider (lists of confirmed symbols per channel). */
  onSubscription(m, now = Date.now()) {
    const has = (k) => Array.isArray(m[k]) && (m[k].includes(this.symbol) || m[k].includes('*'));
    this.subscription = {
      trades: has('trades'), quotes: has('quotes'), bars: has('bars'), statuses: has('statuses'),
      raw: { trades: m.trades || [], quotes: m.quotes || [], bars: m.bars || [] }, confirmedAt: now,
    };
    return this.subscription;
  }

  onHeartbeat({ at, rttMs }) { this.heartbeat = { lastAt: at, rttMs }; }

  noteLag(exchangeTs, receivedAt) {
    if (Number.isFinite(exchangeTs) && Number.isFinite(receivedAt)) this.lastExchangeLagMs = receivedAt - exchangeTs;
  }

  noteStream(kind, receivedAt) {
    this.sinceSubscribe[kind]++;
    if (!this.sinceSubscribe.firstAt) this.sinceSubscribe.firstAt = receivedAt;
  }

  onTrade(t) {
    if (!(t.price > 0) || !(t.size >= 0)) return false;
    const source = t.source || 'stream';
    if (this.lastTrade && Number.isFinite(this.lastTrade.ts) && t.ts < this.lastTrade.ts) {
      // out-of-order / older print: counts as stream activity but does not replace the latest trade
      if (source === 'stream') { this.noteStream('trades', t.receivedAt); this.counters.trades++; }
      return false;
    }
    this.lastTrade = { price: t.price, size: t.size, ts: t.ts, exchange: t.exchange, conditions: t.conditions, receivedAt: t.receivedAt, source };
    if (!this.firstTradeTs) this.firstTradeTs = t.ts; // first trade observed by this process
    if (source === 'stream') {
      this.lastMessageAt = t.receivedAt;
      this.noteLag(t.ts, t.receivedAt);
      this.noteStream('trades', t.receivedAt);
    }
    this.counters.trades++;
    return true;
  }

  onQuote(q) {
    const source = q.source || 'stream';
    if (source !== 'stream' && this.lastQuote && this.lastQuote.ts >= q.ts) return false; // never replace newer data with an older snapshot
    this.lastQuote = {
      bid: q.bid, ask: q.ask, bidSize: q.bidSize, askSize: q.askSize, ts: q.ts, receivedAt: q.receivedAt,
      bidExchange: q.bidExchange, askExchange: q.askExchange, source,
      valid: q.bid > 0 && q.ask > 0 && q.ask >= q.bid,
    };
    if (source === 'stream') {
      this.lastMessageAt = q.receivedAt;
      this.noteLag(q.ts, q.receivedAt);
      this.noteStream('quotes', q.receivedAt);
    }
    this.counters.quotes++;
    return true;
  }

  /** Official minute bar (time = bar start, seconds). */
  onBar(b) {
    const source = b.source || 'stream';
    const endTs = (b.time + 60) * 1000;
    if (!this.lastBar || endTs >= this.lastBar.ts) this.lastBar = { time: b.time, close: b.close, volume: b.volume, ts: endTs, receivedAt: b.receivedAt, source };
    if (source === 'stream') { this.noteStream('bars', b.receivedAt); this.lastMessageAt = b.receivedAt || this.lastMessageAt; }
    this.counters.bars++;
  }

  /** Alpaca trading status: UTP H/P = halt/pause, T/Q = resumption; CTA 2 = halt, 3 = resume. */
  onStatus(s) {
    const code = String(s.code || '').toUpperCase();
    const haltCodes = ['H', 'P', '2'];
    const resumeCodes = ['T', '3'];
    if (haltCodes.includes(code)) {
      this.halted = true;
      this.haltInfo = { code, message: s.message, reasonCode: s.reasonCode, reason: s.reasonMessage || s.reasonCode, ts: s.ts, source: s.source || 'stream status' };
    } else if (resumeCodes.includes(code)) {
      this.halted = false;
      this.haltInfo = { ...(this.haltInfo || {}), resumedAt: s.ts, resumeCode: code };
    }
    return this.halted;
  }

  /** Halt reported by an external official feed (Nasdaq Trader halts RSS). */
  setExternalHalt(halted, info) {
    if (halted && !this.halted) { this.halted = true; this.haltInfo = { ...info, source: info.source || 'Nasdaq Trader trade halts feed' }; }
    if (!halted && this.halted && this.haltInfo && this.haltInfo.source && this.haltInfo.source.includes('Nasdaq')) { this.halted = false; this.haltInfo = { ...this.haltInfo, resumedAt: Date.now() }; }
  }

  /** Latest valid bid/ask (may be old — check freshness() before using it for execution). */
  quote() { return this.lastQuote && this.lastQuote.valid ? this.lastQuote : null; }

  /** Mark price for valuation/display only: last trade, else quote mid. Never an execution price. */
  mark() {
    if (this.lastTrade && this.lastTrade.price > 0) return this.lastTrade.price;
    const q = this.quote();
    return q ? (q.bid + q.ask) / 2 : null;
  }

  ages(now = Date.now()) {
    const age = (x) => (x && Number.isFinite(x.ts) ? Math.max(0, now - x.ts) : null);
    return { quoteAgeMs: age(this.lastQuote), tradeAgeMs: age(this.lastTrade), barAgeMs: age(this.lastBar) };
  }

  /**
   * Execution readiness (session-agnostic). stale === false only with a SUBSCRIBED real-time stream
   * and a valid bid/ask delivered by that stream whose EXCHANGE timestamp is within maxQuoteAgeMs.
   */
  freshness(now = Date.now()) {
    const reasons = [];
    const codes = [];
    const add = (code, msg) => { codes.push(code); reasons.push(msg); };
    const st = this.connection.state;
    if (st !== 'SUBSCRIBED') add('STREAM_NOT_READY', `Market data stream ${st.toLowerCase()}${this.connection.detail ? ` (${this.connection.detail})` : ''}`);
    if (!this.feed.realtime) add('FEED_DELAYED', `Feed is ${this.feed.label}, not real-time`);
    const { quoteAgeMs, tradeAgeMs, barAgeMs } = this.ages(now);
    const q = this.lastQuote;
    const limit = this.cfg.maxQuoteAgeMs;
    if (!q) add('NO_QUOTE', 'No bid/ask quote received yet');
    else if (!q.valid) add('INVALID_QUOTE', 'Latest quote is not a valid two-sided market');
    else if (quoteAgeMs > limit) add('QUOTE_STALE', `Latest bid/ask is ${fmtAge(quoteAgeMs)} old by exchange timestamp (limit ${fmtAge(limit)})`);
    else if (q.source !== 'stream') add('QUOTE_NOT_STREAMED', 'Latest bid/ask came from a REST snapshot — waiting for the live stream to deliver a quote');
    if (this.lastExchangeLagMs != null && this.lastExchangeLagMs > this.cfg.maxExchangeLagMs) {
      add('DATA_LAGGING', `Data delayed: exchange timestamps are ${fmtAge(this.lastExchangeLagMs)} behind the local clock`);
    }
    return { stale: codes.length > 0, reasons, codes, quoteAgeMs, tradeAgeMs, barAgeMs, exchangeLagMs: this.lastExchangeLagMs, connection: st };
  }

  /**
   * User-facing data status. `si` = MarketCalendar.info(now) (null = assume the feed is active).
   * opts: { extendedHours (simulated trading allowed outside RTH), waitGraceMs }
   */
  dataStatus(now = Date.now(), si = null, { extendedHours = false, waitGraceMs = 60000 } = {}) {
    const f = this.freshness(now);
    const feedName = (si && si.feed && si.feed.name && si.feed.name !== 'feed') ? si.feed.name : (this.feed.feed || '').toUpperCase() || 'FEED';
    const out = (code, label, tone, detail, extra = {}) => ({
      code, label, tone, detail: detail || '', tradable: !f.stale && code === 'LIVE', codes: f.codes, reasons: f.reasons, ...extra,
    });
    const mode = this.feed.mode;
    if (mode === 'DEMO') return { ...out('DEMO', 'DEMO — SYNTHETIC DATA (NOT REAL)', 'amber', f.stale ? f.reasons.join('; ') : 'Synthetic prices for testing the interface'), tradable: !f.stale };
    if (mode === 'REPLAY') return { ...out('REPLAY', this.feed.label, 'amber', f.stale ? f.reasons.join('; ') : 'Historical replay'), tradable: !f.stale };

    const st = this.connection.state;
    const closedForFeed = !!(si && si.feed && !si.feed.active);
    if (st === 'UNAVAILABLE' || st === 'ERROR') {
      return out('UNAVAILABLE', 'REAL-TIME MARKET DATA UNAVAILABLE', 'red', this.unavailableReason || this.connection.detail || 'Unknown error');
    }
    if (st !== 'SUBSCRIBED') {
      if (this.everSubscribed || st === 'RECONNECTING' || st === 'DISCONNECTED') {
        return out('RECONNECTING', closedForFeed ? 'MARKET CLOSED — RECONNECTING' : 'CONNECTION LOST — RECONNECTING', closedForFeed ? 'gray' : 'red',
          `Stream ${st.toLowerCase()}${this.connection.detail ? `: ${this.connection.detail}` : ''}. New simulated trades are blocked until the stream is restored and fresh data arrives.`);
      }
      const phase = { CONNECTING: 'OPENING CONNECTION', AUTHENTICATING: 'AUTHENTICATING', AUTHENTICATED: 'SUBSCRIBING' }[st] || st;
      return out('CONNECTING', `CONNECTING — ${phase}`, 'amber', this.connection.detail || '');
    }
    if (this.halted) return out('HALTED', `TRADING HALTED — ${this.symbol}`, 'red', (this.haltInfo && (this.haltInfo.reason || this.haltInfo.code)) || 'Halt reported');
    if (!this.feed.realtime) return out('DELAYED', this.feed.label, 'amber', 'Delayed data is shown for reference only. Simulated execution is disabled.');

    if (closedForFeed) {
      const label = si.session === 'CLOSED' ? 'MARKET CLOSED — LAST PRICE' : `${si.marketStatus} — NO ${feedName} DATA (LAST PRICE)`;
      return out('CLOSED', label, 'gray', si.feed.reason || si.reason || 'Market closed', { lastPriceTs: this.lastTrade ? this.lastTrade.ts : null });
    }
    const extended = !!(si && si.session !== 'REGULAR');
    if (!f.stale) return out('LIVE', extended ? `${this.feed.label} (${si.marketStatus})` : this.feed.label, 'green', extended ? `${si.marketStatus}: extended-hours data on ${feedName} is sparse` : '');

    const ss = this.sinceSubscribe;
    const noStreamData = ss.trades + ss.quotes + ss.bars === 0;
    if (noStreamData && this.subscribedAt != null && now - this.subscribedAt < waitGraceMs) {
      return out('WAITING', 'CONNECTED — WAITING FOR MARKET DATA', 'amber', `Subscribed to ${this.symbol}; waiting for the first trade/quote from the stream`);
    }
    if (extended && !extendedHours) {
      return out('QUIET', `${si.marketStatus} — NO RECENT ${feedName} QUOTE`, 'gray',
        `Extended-hours activity on ${feedName} is sparse. Simulated trading runs in the regular session only (enable extended hours in Settings to change this).`);
    }
    const primary = f.codes.find((c) => c !== 'STREAM_NOT_READY') || f.codes[0];
    const label = primary === 'INVALID_QUOTE' ? 'NO VALID BID/ASK — TRADING PAUSED'
      : primary === 'DATA_LAGGING' ? 'DATA DELAYED — TRADING PAUSED'
        : 'STALE DATA — TRADING PAUSED';
    return out('STALE', label, 'amber', f.reasons.join('; '));
  }

  /**
   * Reference prices from a secondary source (Alpaca overnight snapshots, Tiingo 24x5). They are shown with
   * their kind — INDICATIVE / DELAYED / TRADE / QUOTE — and are NEVER used for simulated execution or as
   * the bid/ask of the execution feed.
   */
  onReference(r) {
    if (!r || !(r.price > 0) || !Number.isFinite(r.ts)) return;
    if (this.reference && this.reference.ts > r.ts && this.reference.provider === r.provider) return;
    this.reference = { price: r.price, bid: r.bid || null, ask: r.ask || null, ts: r.ts, kind: r.kind, provider: r.provider, receivedAt: r.receivedAt || Date.now() };
  }

  /** What the shown price is: LIVE_TRADE | LIVE_QUOTE | INDICATIVE | DELAYED | MARKET_CLOSED | DATA_UNAVAILABLE. */
  dataKind(ds, now = Date.now()) {
    const ref = this.reference;
    const refFresh = ref && now - ref.ts < 15 * 60000 + 5 * 60000;
    // synthetic or replayed prices are never labelled as live market data
    if (ds.code === 'DEMO') return 'SYNTHETIC';
    if (ds.code === 'REPLAY') return 'REPLAY';
    if (ds.code === 'LIVE') {
      const t = this.lastTrade;
      return t && now - t.ts < 120000 ? 'LIVE_TRADE' : 'LIVE_QUOTE';
    }
    if (ds.code === 'DELAYED') return 'DELAYED';
    if (ds.code === 'CLOSED' || ds.code === 'QUIET') {
      if (refFresh) return ref.kind === 'INDICATIVE' ? 'INDICATIVE' : ref.kind === 'DELAYED' ? 'DELAYED' : 'LIVE_QUOTE';
      return 'MARKET_CLOSED';
    }
    if (ds.code === 'HALTED') return 'MARKET_CLOSED';
    return 'DATA_UNAVAILABLE';
  }

  /** Back-compat: the status code of dataStatus(). */
  feedStatus(now = Date.now(), si = null, opts = {}) { return this.dataStatus(now, si, opts).code; }

  toJSON(now = Date.now(), si = null, opts = {}) {
    const q = this.lastQuote;
    const spread = q && q.valid ? q.ask - q.bid : null;
    const mid = q && q.valid ? (q.ask + q.bid) / 2 : null;
    const st = this.connection.state;
    const freshness = this.freshness(now);
    const dataStatus = this.dataStatus(now, si, opts);
    return {
      symbol: this.symbol, feed: this.feed, connection: this.connection,
      link: {
        socketOpen: STREAM_UP.has(st), authenticated: AUTHED.has(st), subscribed: st === 'SUBSCRIBED',
        subscription: this.subscription, subscribedAt: this.subscribedAt, everSubscribed: this.everSubscribed,
        sinceSubscribe: this.sinceSubscribe, heartbeat: this.heartbeat, lastMessageAt: this.lastMessageAt || null,
      },
      lastTrade: this.lastTrade, quote: q, lastBar: this.lastBar,
      spread, spreadPct: spread != null && mid ? (spread / mid) * 100 : null, mid,
      halted: this.halted, haltInfo: this.haltInfo, luld: this.luld, freshness,
      dataStatus, feedStatus: dataStatus.code, counters: this.counters, unavailableReason: this.unavailableReason,
      reference: this.reference || null, dataKind: this.dataKind(dataStatus, now),
    };
  }
}

module.exports = { MarketState, REASON_TEXT, fmtAge };
