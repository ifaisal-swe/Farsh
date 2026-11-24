'use strict';
/**
 * Deterministic REPLAY provider over historical 1-minute bars.
 *
 * No look-ahead: at virtual time T the provider only reveals bars that have CLOSED before T
 * (fetchBars / fetchMinuteWindow filter by the virtual clock) and news published before T.
 *
 * Explicit, labelled assumptions (historical quotes are not replayed):
 *   - intra-minute path is open -> (low,high or high,low by bar direction) -> close
 *   - quotes are synthesized as path price ± spreadBps/2
 */
const { EventEmitter } = require('node:events');
const { aggregate } = require('./candles');

class VirtualClock {
  constructor(startMs) { this.t = startMs; }
  now() { return this.t; }
  set(ms) { if (ms > this.t) this.t = ms; }
}

class ReplayProvider extends EventEmitter {
  constructor({ symbol, minuteBars, dailyBars = [], news = [], spreadBps = 5, warmupBars = 120, clock }) {
    super();
    this.symbol = symbol;
    this.all = [...minuteBars].sort((a, b) => a.time - b.time);
    this.daily = dailyBars;
    this.news = news;
    this.spreadBps = spreadBps;
    this.index = Math.min(warmupBars, this.all.length);
    this.clock = clock || new VirtualClock(this.index > 0 ? (this.all[this.index - 1].time + 60) * 1000 : this.all[0].time * 1000);
    this.mode = 'REPLAY';
    this.state = 'DISCONNECTED';
    this.symbols = new Set();
  }

  get name() { return 'replay'; }
  feedInfo() { return { provider: 'REPLAY', feed: 'historical 1m bars', realtime: true, label: `REPLAY — HISTORICAL BARS (quotes assumed ±${this.spreadBps / 2} bps)`, note: 'Deterministic replay. Quotes and intra-bar path are labelled assumptions.', mode: 'REPLAY' }; }

  connect() { this.state = 'SUBSCRIBED'; this.emit('connection', { state: 'SUBSCRIBED', detail: 'replay' }); }
  disconnect() { this.state = 'DISCONNECTED'; this.emit('connection', { state: 'DISCONNECTED', detail: 'replay ended' }); }
  subscribe(s) { for (const x of s) this.symbols.add(x); }
  unsubscribe() {}

  visibleMinutes() { const t = this.clock.now() / 1000; return this.all.filter((b) => b.time + 60 <= t); }

  async fetchBars(symbol, tf, { limit = 500 } = {}) {
    const vis = this.visibleMinutes();
    if (tf === '1d') return this.daily.filter((d) => d.time * 1000 + 86400000 <= this.clock.now()).slice(-limit);
    return (tf === '1m' ? vis : aggregate(vis, tf)).slice(-limit);
  }
  async fetchMinuteWindow(symbol, startMs) { return this.visibleMinutes().filter((b) => b.time * 1000 >= startMs); }
  async fetchSnapshot() { return null; }
  async fetchSnapshots() { return {}; }
  async fetchAsset(symbol) { return { symbol, name: `${symbol} (replay)`, status: 'active', tradable: true, exchange: 'REPLAY' }; }
  async fetchCalendar() { return null; }
  async fetchNews(symbol, { limit = 20 } = {}) {
    const t = this.clock.now();
    return this.news.filter((n) => Date.parse(n.created_at) <= t).slice(-limit);
  }

  hasNext() { return this.index < this.all.length; }

  /** Emit one historical minute (path ticks + official bar) and advance the virtual clock. */
  step() {
    if (!this.hasNext()) return null;
    const b = this.all[this.index++];
    const up = b.close >= b.open;
    const path = up ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close];
    const half = this.spreadBps / 2 / 1e4;
    path.forEach((px, i) => {
      const ts = b.time * 1000 + i * 15000;
      this.clock.set(ts);
      this.emit('quote', { symbol: this.symbol, bid: px * (1 - half), ask: px * (1 + half), bidSize: 500, askSize: 500, ts, receivedAt: ts, assumed: true });
      this.emit('trade', { symbol: this.symbol, price: px, size: Math.max(1, Math.round((b.volume || 4) / 4)), ts, receivedAt: ts, assumed: true });
    });
    this.clock.set((b.time + 60) * 1000);
    this.emit('bar', { symbol: this.symbol, ...b, receivedAt: this.clock.now() });
    return b;
  }
}

module.exports = { ReplayProvider, VirtualClock };
