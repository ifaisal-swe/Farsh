'use strict';
/**
 * DEMO provider — SYNTHETIC, ARTIFICIAL data for UI testing only.
 * Everything it produces is labelled "DEMO — SYNTHETIC DATA (NOT REAL)". It never produces news.
 * Demo sessions are stored separately (data_mode = 'DEMO') and never mixed with live sessions.
 */
const { EventEmitter } = require('node:events');
const { aggregate } = require('./candles');

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hashSeed = (s) => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
const gauss = (rnd) => { let u = 0; let v = 0; while (u === 0) u = rnd(); while (v === 0) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

class DemoProvider extends EventEmitter {
  constructor({ tickMs = 500, startPrice } = {}) {
    super();
    this.tickMs = tickMs;
    this.startPrice = startPrice;
    this.symbols = new Set();
    this.paths = new Map();
    this.timer = null;
    this.state = 'DISCONNECTED';
    this.mode = 'DEMO';
  }

  get name() { return 'demo'; }
  feedInfo() { return { provider: 'DEMO', feed: 'synthetic', realtime: true, label: 'DEMO — SYNTHETIC DATA (NOT REAL)', note: 'Artificial random-walk prices for UI testing. Not market data.', mode: 'DEMO' }; }

  path(symbol) {
    if (this.paths.has(symbol)) return this.paths.get(symbol);
    const rnd = mulberry32(hashSeed(symbol));
    const nowMin = Math.floor(Date.now() / 60000) * 60;
    const n = 3000;
    let px = this.startPrice || 50 + (hashSeed(symbol) % 200);
    const mins = [];
    for (let i = n; i >= 1; i--) {
      const t = nowMin - i * 60;
      const o = px;
      let h = o; let l = o; let c = o;
      for (let k = 0; k < 6; k++) { c = c * (1 + gauss(rnd) * 0.0006); h = Math.max(h, c); l = Math.min(l, c); }
      const v = Math.round(800 + rnd() * 4000);
      mins.push({ time: t, open: o, high: h, low: l, close: c, volume: v, vw: (h + l + c) / 3, trades: Math.round(v / 50) });
      px = c;
    }
    const days = [];
    let dp = mins[0].open;
    const today = Math.floor(Date.now() / 86400000) * 86400;
    for (let i = 300; i >= 1; i--) {
      const o = dp; const c = o * (1 + gauss(rnd) * 0.018);
      days.push({ time: today - i * 86400 + 5 * 3600, open: o, high: Math.max(o, c) * (1 + rnd() * 0.01), low: Math.min(o, c) * (1 - rnd() * 0.01), close: c, volume: Math.round(1e6 + rnd() * 3e6) });
      dp = c;
    }
    const scale = mins[0].open / days[days.length - 1].close;
    for (const d of days) { d.open *= scale; d.high *= scale; d.low *= scale; d.close *= scale; }
    const st = { rnd, mins, days, last: px, curMinute: null, bid: px - 0.01, ask: px + 0.01 };
    this.paths.set(symbol, st);
    return st;
  }

  connect() {
    this.setState('CONNECTING', 'demo generator');
    setTimeout(() => {
      this.setState('SUBSCRIBED', 'DEMO synthetic stream');
      this.timer = setInterval(() => this.tick(), this.tickMs);
    }, 50);
  }

  setState(state, detail) { this.state = state; this.emit('connection', { state, detail }); }

  tick() {
    const now = Date.now();
    for (const sym of this.symbols) {
      const st = this.path(sym);
      const burst = st.rnd() < 0.01 ? 4 : 1;
      st.last = Math.max(0.5, st.last * (1 + gauss(st.rnd) * 0.0004 * burst));
      const spread = Math.max(0.01, Math.round(st.last * 0.0004 * 100) / 100);
      st.bid = Math.round((st.last - spread / 2) * 100) / 100;
      st.ask = Math.round((st.bid + spread) * 100) / 100;
      const size = Math.round(10 + st.rnd() * 300);
      const minute = Math.floor(now / 60000) * 60;
      if (st.curMinute && st.curMinute.time < minute) {
        const b = st.curMinute;
        st.mins.push(b);
        this.emit('bar', { symbol: sym, ...b, receivedAt: now });
        st.curMinute = null;
      }
      if (!st.curMinute) st.curMinute = { time: minute, open: st.last, high: st.last, low: st.last, close: st.last, volume: 0, trades: 0 };
      const cm = st.curMinute;
      cm.high = Math.max(cm.high, st.last); cm.low = Math.min(cm.low, st.last); cm.close = st.last; cm.volume += size; cm.trades++;
      this.emit('quote', { symbol: sym, bid: st.bid, ask: st.ask, bidSize: 200, askSize: 200, ts: now, receivedAt: now });
      this.emit('trade', { symbol: sym, price: st.last, size, ts: now, exchange: 'DEMO', conditions: [], receivedAt: now });
    }
  }

  subscribe(symbols) { for (const s of symbols) { this.symbols.add(s); this.path(s); } this.emit('subscribed', { trades: [...this.symbols] }); }
  unsubscribe(symbols) { for (const s of symbols) this.symbols.delete(s); }
  disconnect() { clearInterval(this.timer); this.timer = null; this.setState('DISCONNECTED', 'stopped'); }

  async fetchBars(symbol, tf, { limit = 500 } = {}) {
    const st = this.path(symbol);
    if (tf === '1d') return st.days.slice(-limit);
    const bars = tf === '1m' ? st.mins : aggregate(st.mins, tf);
    return bars.slice(-limit);
  }
  async fetchMinuteWindow(symbol, startMs) { return this.path(symbol).mins.filter((b) => b.time * 1000 >= startMs); }
  async fetchSnapshot(symbol) {
    const st = this.path(symbol);
    const now = new Date().toISOString();
    return { symbol, latestTrade: { p: st.last, t: now }, latestQuote: { bp: st.bid, ap: st.ask, t: now }, demo: true };
  }
  async fetchSnapshots(symbols) { const o = {}; for (const s of symbols) o[s] = await this.fetchSnapshot(s); return o; }
  async fetchAsset(symbol) { return { symbol, name: `DEMO synthetic instrument (${symbol})`, exchange: 'DEMO', status: 'active', tradable: true, fractionable: true, demo: true }; }
  async fetchCalendar() { return null; }
  async fetchNews() { return []; }
}

module.exports = { DemoProvider, mulberry32 };
