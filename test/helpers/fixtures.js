'use strict';
const { EventEmitter } = require('node:events');
const { aggregate } = require('../../server/market/candles');
const { etWallToUtcMs } = require('../../server/util/time');

/** Wednesday 2026-11-18, 11:00 ET (regular session). */
const T0 = etWallToUtcMs('2026-11-18', 11, 0);

function approx(a, b, eps = 1e-6) {
  if (Math.abs(a - b) > eps) throw new Error(`expected ${b}, got ${a} (eps ${eps})`);
}

/** Deterministic 1-minute bars (real-looking OHLCV) for a day, ending before `endMs`. */
function makeMinuteBars({ date = '2026-11-18', fromH = 9, fromM = 30, endMs = T0, start = 100, drift = 0.01, seed = 1 } = {}) {
  let x = seed;
  const rnd = () => { x = (x * 16807) % 2147483647; return x / 2147483647; };
  const out = [];
  let px = start;
  for (let t = etWallToUtcMs(date, fromH, fromM) / 1000; t * 1000 < endMs; t += 60) {
    const o = px;
    const c = o + drift + (rnd() - 0.5) * 0.08;
    const h = Math.max(o, c) + rnd() * 0.05;
    const l = Math.min(o, c) - rnd() * 0.05;
    out.push({ time: t, open: o, high: h, low: l, close: c, volume: Math.round(1000 + rnd() * 2000), vw: (h + l + c) / 3, trades: 20 });
    px = c;
  }
  return out;
}

function makeDailyBars(n = 300, endDate = '2026-11-17', start = 80) {
  const out = [];
  const end = etWallToUtcMs(endDate, 0, 0) / 1000;
  let px = start;
  for (let i = n - 1; i >= 0; i--) {
    const t = end - i * 86400;
    const o = px; const c = px * 1.001;
    out.push({ time: t, open: o, high: c * 1.01, low: o * 0.99, close: c, volume: 1e6 });
    px = c;
  }
  return out;
}

class FakeProvider extends EventEmitter {
  constructor({ clock, minutes, daily, mode = 'LIVE', realtime = true } = {}) {
    super();
    this.clock = clock;
    this.minutes = minutes || makeMinuteBars();
    this.daily = daily || makeDailyBars();
    this.mode = mode;
    this.realtime = realtime;
    this.subscribed = [];
  }
  get name() { return 'fake'; }
  feedInfo() { return { provider: 'FAKE', feed: 'test', realtime: this.realtime, label: this.realtime ? 'LIVE — TEST FEED' : 'DELAYED — TEST', note: '', mode: this.mode }; }
  connect() { this.emit('connection', { state: 'SUBSCRIBED', detail: 'test feed' }); }
  disconnect() { this.emit('connection', { state: 'DISCONNECTED', detail: 'closed' }); }
  subscribe(s) { this.subscribed.push(...s); }
  unsubscribe() {}
  async fetchBars(sym, tf) { return tf === '1d' ? this.daily : (tf === '1m' ? this.minutes : aggregate(this.minutes, tf)); }
  async fetchMinuteWindow(sym, startMs) { return this.minutes.filter((b) => b.time * 1000 >= startMs); }
  async fetchSnapshot() { return null; }
  async fetchSnapshots() { return {}; }
  async fetchAsset(symbol) { return { symbol, name: 'Testco Holdings Inc', exchange: 'NASDAQ', status: 'active', tradable: true, fractionable: true }; }
  async fetchCalendar() { return null; }
  async fetchNews() { return []; }
  quote(bid, ask, size = 500) { const t = this.clock.now(); this.emit('quote', { symbol: 'TEST', bid, ask, bidSize: size, askSize: size, ts: t, receivedAt: t }); }
  trade(price, size = 100) { const t = this.clock.now(); this.emit('trade', { symbol: 'TEST', price, size, ts: t, receivedAt: t }); }
}

/** Scripted decider: returns queued responses (functions of the snapshot). */
class ScriptedDecider {
  constructor() { this.kind = 'scripted'; this.label = 'SCRIPTED TEST DECIDER'; this.queue = []; this.seen = []; }
  push(fn) { this.queue.push(fn); }
  async decide(snapshot) {
    this.seen.push(snapshot);
    const fn = this.queue.shift() || ((s) => ({ snapshot_id: s.id, action: 'WAIT', confidence: 40, rationale: 'default wait' }));
    const out = fn(snapshot);
    return { content: typeof out === 'string' ? out : JSON.stringify(out), usage: null, latencyMs: 1, model: this.label };
  }
}

const buyProposal = (s, { stopOff = 1, tpOff = 3, size = 25 } = {}) => {
  const ask = s.market.quote.ask;
  return {
    snapshot_id: s.id, action: 'BUY', strategy: 'BREAKOUT', directional_bias: 'BULLISH', trend: 'UPTREND', sentiment: 'BULLISH', confidence: 65,
    order: { type: 'MARKET', limit_price: null }, entry_price: ask, stop_loss: +(ask - stopOff).toFixed(2), take_profit: +(ask + tpOff).toFixed(2),
    position_size_pct_of_equity: size, evidence: ['test evidence'], rationale: 'test buy', invalidation: 'below stop',
  };
};

const silentFetch = async () => ({ ok: false, status: 503, text: async () => '', json: async () => ({}), headers: new Map() });

module.exports = { T0, approx, makeMinuteBars, makeDailyBars, FakeProvider, ScriptedDecider, buyProposal, silentFetch };
