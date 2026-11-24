'use strict';
/**
 * Candle construction from REAL provider data only.
 *
 *  - Older history per timeframe comes from the provider's historical bars endpoint.
 *  - The "live window" (from 04:00 ET of the current/last trading day) is built from 1-minute bars:
 *      official minute bars (REST + stream "b"/"u" messages) replace anything provisional;
 *      the still-forming minute is aggregated from genuine trade prints only.
 *  - Higher intraday timeframes in the live window are aggregated deterministically from those
 *    minute bars, so history and live candles follow the same timestamp/adjustment rules.
 *  - Nothing is interpolated: a minute with no trades simply has no bar.
 */
const { EventEmitter } = require('node:events');
const { TIMEFRAMES, bucketStart } = require('../util/time');
const { isRegularBar } = require('../analysis/structure');

function aggregate(minBars, tf) {
  const out = [];
  let cur = null;
  let pv = 0;
  let vwOk = true;
  for (const m of minBars) {
    const b = bucketStart(tf, m.time);
    if (!cur || cur.time !== b) {
      if (cur) { cur.vw = vwOk && cur.volume > 0 ? pv / cur.volume : null; out.push(cur); }
      cur = { time: b, open: m.open, high: m.high, low: m.low, close: m.close, volume: 0, trades: 0 };
      pv = 0; vwOk = true;
    }
    cur.high = Math.max(cur.high, m.high);
    cur.low = Math.min(cur.low, m.low);
    cur.close = m.close;
    cur.volume += m.volume || 0;
    cur.trades += m.trades || 0;
    if (m.vw > 0) pv += m.vw * (m.volume || 0); else vwOk = false;
    if (m.provisional) cur.provisional = true;
  }
  if (cur) { cur.vw = vwOk && cur.volume > 0 ? pv / cur.volume : null; out.push(cur); }
  return out;
}

class CandleStore extends EventEmitter {
  constructor({ symbol, graceMs = 4000 }) {
    super();
    this.symbol = symbol;
    this.history = {};
    this.minutes = new Map();
    this.minutesStart = null;
    this.partial = null;
    this.liveDaily = null;
    this.graceMs = graceMs;
    this.lastClosed = {};
    this.trackedTfs = new Set(['1m']);
  }

  track(tf) { this.trackedTfs.add(tf); }

  setHistory(tf, bars, nowMs = Date.now()) {
    this.history[tf] = [...bars].sort((a, b) => a.time - b.time);
    if (tf === '1d') {
      const last = this.history['1d'][this.history['1d'].length - 1];
      if (last && last.time === bucketStart('1d', Math.floor(nowMs / 1000))) this.liveDaily = { ...last };
    }
  }

  /**
   * Load the live window of 1-minute bars. If the newest REST bar is the still-forming minute,
   * it becomes the provisional partial (to be replaced by the official bar for that minute).
   */
  setMinutes(bars, coverageStartSec, loadedAtMs = Date.now()) {
    this.minutes.clear();
    this.partial = null;
    this.minutesStart = coverageStartSec;
    const currentMinute = Math.floor(loadedAtMs / 60000) * 60;
    for (const b of bars) {
      if (b.time < coverageStartSec) continue;
      if (b.time >= currentMinute) this.partial = { ...b, provisional: true };
      else this.minutes.set(b.time, { ...b, official: true });
    }
    for (const tf of Object.keys(TIMEFRAMES)) {
      if (tf === '1d') continue;
      this.lastClosed[tf] = bucketStart(tf, Math.floor((loadedAtMs - this.graceMs) / 1000)) - TIMEFRAMES[tf].sec;
    }
  }

  /**
   * Backfill: merge official minute bars fetched from the provider (e.g. after a stream outage or at
   * session start) without discarding anything already held. Returns the number of minutes added
   * or upgraded from provisional to official. Nothing is synthesized for minutes without trades.
   */
  mergeMinutes(bars, loadedAtMs = Date.now()) {
    const currentMinute = Math.floor(loadedAtMs / 60000) * 60;
    let changed = 0;
    for (const b of bars || []) {
      if (this.minutesStart != null && b.time < this.minutesStart) continue;
      if (b.time >= currentMinute) {
        if (!this.partial || this.partial.time <= b.time) { this.partial = { ...b, provisional: true }; }
        continue;
      }
      const have = this.minutes.get(b.time);
      if (have && have.official) continue;
      this.minutes.set(b.time, { ...b, official: true, provisional: false });
      if (this.partial && this.partial.time <= b.time) this.partial = null;
      changed++;
    }
    if (this.minutesStart == null && bars && bars.length) this.minutesStart = bars[0].time;
    return changed;
  }

  /** Start time (sec) of the newest official minute bar held, or null. */
  lastOfficialMinute() {
    let t = null;
    for (const [k, v] of this.minutes) if (v.official && (t == null || k > t)) t = k;
    return t;
  }

  sortedMinutes() {
    const arr = [...this.minutes.values()].sort((a, b) => a.time - b.time);
    if (this.partial && !this.minutes.has(this.partial.time)) arr.push(this.partial);
    return arr;
  }

  /** Genuine trade print -> forming minute. Returns the updated minute bar or null if ignored. */
  onTrade({ price, size, ts }) {
    if (!(price > 0)) return null;
    const m = Math.floor(ts / 60000) * 60;
    if (this.minutesStart != null && m < this.minutesStart) return null;
    const official = this.minutes.get(m);
    if (official && official.official) return null; // late print: provider's updatedBars will correct
    if (this.partial && this.partial.time < m) {
      // previous minute ended; keep it (provisional) until the official bar arrives
      if (!this.minutes.has(this.partial.time)) this.minutes.set(this.partial.time, { ...this.partial, provisional: true });
      this.partial = null;
    }
    if (this.partial && this.partial.time > m) return null; // out-of-order older print
    if (!this.partial) {
      this.partial = { time: m, open: price, high: price, low: price, close: price, volume: size || 0, trades: 1, provisional: true };
    } else {
      this.partial.high = Math.max(this.partial.high, price);
      this.partial.low = Math.min(this.partial.low, price);
      this.partial.close = price;
      this.partial.volume += size || 0;
      this.partial.trades = (this.partial.trades || 0) + 1;
    }
    if (this.liveDaily && isRegularBar(m) && bucketStart('1d', m) === this.liveDaily.time) {
      this.liveDaily.high = Math.max(this.liveDaily.high, price);
      this.liveDaily.low = Math.min(this.liveDaily.low, price);
      this.liveDaily.close = price;
    }
    return this.partial;
  }

  /** Official minute bar (stream "b" or "u", or replay). */
  onMinuteBar(bar) {
    if (this.minutesStart == null) this.minutesStart = bar.time;
    this.minutes.set(bar.time, { ...bar, official: true, provisional: false });
    if (this.partial && this.partial.time <= bar.time) this.partial = null;
  }

  onDailyBar(bar) { this.liveDaily = { ...bar }; }

  liveBars(tf) {
    const mins = this.sortedMinutes();
    if (tf === '1m') return mins;
    return aggregate(mins, tf);
  }

  getBars(tf) {
    if (tf === '1d') {
      const hist = (this.history['1d'] || []).filter((b) => !this.liveDaily || b.time < this.liveDaily.time);
      if (this.liveDaily) return [...hist, this.liveDaily];
      // no daily feed: derive today's regular-session bar from minute data, if we have it
      const reg = this.sortedMinutes().filter((b) => isRegularBar(b.time));
      if (reg.length) {
        const day = bucketStart('1d', reg[reg.length - 1].time);
        const todays = reg.filter((b) => b.time >= day);
        const agg = aggregate(todays, '1d');
        if (agg.length && !hist.some((b) => b.time === agg[0].time)) return [...hist, { ...agg[0], derived: 'from minute bars' }];
      }
      return hist;
    }
    const live = this.minutesStart != null ? this.liveBars(tf) : [];
    const liveStart = live.length ? Math.min(bucketStart(tf, this.minutesStart), live[0].time) : Infinity;
    const hist = (this.history[tf] || []).filter((b) => b.time < liveStart);
    return [...hist, ...live];
  }

  currentBar(tf) {
    const bars = this.getBars(tf);
    return bars.length ? bars[bars.length - 1] : null;
  }

  /** Completed bars only (excludes the bucket still forming at `nowMs`). */
  completedBars(tf, nowMs = Date.now()) {
    const bars = this.getBars(tf);
    const cur = bucketStart(tf, Math.floor(nowMs / 1000));
    return bars.filter((b) => b.time < cur);
  }

  /**
   * Bucket rollover detection driven by the clock (+ grace for the official minute bar).
   * Emits 'barClose' { tf, bar } once per closed bucket for tracked timeframes.
   */
  checkRollovers(nowMs = Date.now()) {
    const closed = [];
    const t = Math.floor((nowMs - this.graceMs) / 1000);
    for (const tf of this.trackedTfs) {
      if (tf === '1d') continue;
      const prevBucket = bucketStart(tf, t) - TIMEFRAMES[tf].sec;
      if (this.lastClosed[tf] == null) { this.lastClosed[tf] = prevBucket; continue; }
      if (prevBucket > this.lastClosed[tf]) {
        this.lastClosed[tf] = prevBucket;
        const bar = this.getBars(tf).find((b) => b.time === prevBucket) || null;
        const evt = { tf, bucket: prevBucket, bar };
        closed.push(evt);
        this.emit('barClose', evt);
      }
    }
    return closed;
  }

  /** First regular-session minute of the current live window (IPO seasoning). */
  firstRegularMinute() {
    const reg = this.sortedMinutes().filter((b) => isRegularBar(b.time));
    return reg.length ? reg[0].time : null;
  }
}

module.exports = { CandleStore, aggregate };
