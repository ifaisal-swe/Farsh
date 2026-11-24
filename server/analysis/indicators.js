/**
 * Technical indicators — pure, deterministic functions over real OHLCV bars.
 * Output arrays are aligned with the input; `null` means "not enough data" (never invented).
 * UMD wrapper: the same file is served to the browser (window.Indicators) for chart overlays.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Indicators = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

  function sma(values, n) {
    const out = new Array(values.length).fill(null);
    if (n <= 0) return out;
    let sum = 0;
    let valid = 0;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) { sum = 0; valid = 0; continue; }
      sum += v; valid++;
      if (valid > n) { sum -= values[i - n]; valid = n; }
      if (valid === n) out[i] = sum / n;
    }
    return out;
  }

  /** EMA seeded with the SMA of the first n values (standard). Handles leading nulls. */
  function ema(values, n) {
    const out = new Array(values.length).fill(null);
    const k = 2 / (n + 1);
    let start = values.findIndex(isNum);
    if (start < 0) return out;
    let prev = null;
    let seedSum = 0;
    let count = 0;
    for (let i = start; i < values.length; i++) {
      const v = values[i];
      if (!isNum(v)) { prev = null; seedSum = 0; count = 0; continue; }
      if (prev === null) {
        seedSum += v; count++;
        if (count === n) { prev = seedSum / n; out[i] = prev; }
      } else {
        prev = v * k + prev * (1 - k);
        out[i] = prev;
      }
    }
    return out;
  }

  /** Wilder RSI. */
  function rsi(closes, n = 14) {
    const out = new Array(closes.length).fill(null);
    if (closes.length <= n) return out;
    let gain = 0;
    let loss = 0;
    for (let i = 1; i <= n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgG = gain / n;
    let avgL = loss / n;
    const calc = () => (avgL === 0 ? (avgG === 0 ? 50 : 100) : 100 - 100 / (1 + avgG / avgL));
    out[n] = calc();
    for (let i = n + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      avgG = (avgG * (n - 1) + (d > 0 ? d : 0)) / n;
      avgL = (avgL * (n - 1) + (d < 0 ? -d : 0)) / n;
      out[i] = calc();
    }
    return out;
  }

  function macd(closes, fast = 12, slow = 26, signal = 9) {
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const line = closes.map((_, i) => (isNum(ef[i]) && isNum(es[i]) ? ef[i] - es[i] : null));
    const sig = ema(line, signal);
    const hist = line.map((v, i) => (isNum(v) && isNum(sig[i]) ? v - sig[i] : null));
    return { macd: line, signal: sig, hist };
  }

  function trueRange(bars) {
    return bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const pc = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });
  }

  /** Wilder ATR: first value is the mean of the first n true ranges. */
  function atr(bars, n = 14) {
    const out = new Array(bars.length).fill(null);
    if (bars.length < n) return out;
    const tr = trueRange(bars);
    let a = 0;
    for (let i = 0; i < n; i++) a += tr[i];
    a /= n;
    out[n - 1] = a;
    for (let i = n; i < bars.length; i++) { a = (a * (n - 1) + tr[i]) / n; out[i] = a; }
    return out;
  }

  /** Bollinger Bands with population standard deviation. */
  function bollinger(closes, n = 20, k = 2) {
    const mid = sma(closes, n);
    const upper = new Array(closes.length).fill(null);
    const lower = new Array(closes.length).fill(null);
    const width = new Array(closes.length).fill(null);
    for (let i = n - 1; i < closes.length; i++) {
      if (!isNum(mid[i])) continue;
      let s = 0;
      for (let j = i - n + 1; j <= i; j++) s += (closes[j] - mid[i]) ** 2;
      const sd = Math.sqrt(s / n);
      upper[i] = mid[i] + k * sd;
      lower[i] = mid[i] - k * sd;
      width[i] = mid[i] !== 0 ? (upper[i] - lower[i]) / mid[i] : null;
    }
    return { mid, upper, lower, width };
  }

  /**
   * Session-anchored VWAP. sessionOf(timeSec, bar) -> { key, include } decides the anchor (e.g. ET date)
   * and whether the bar belongs to the anchored session (e.g. regular trading hours only).
   * Uses the bar's own VWAP (bar.vw) when the provider supplies it, else the typical price.
   */
  function vwap(bars, sessionOf) {
    const out = new Array(bars.length).fill(null);
    let key = null;
    let pv = 0;
    let vol = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const s = sessionOf ? sessionOf(b.time, b) : { key: 'all', include: true };
      if (s.key !== key) { key = s.key; pv = 0; vol = 0; }
      if (!s.include) continue;
      const px = isNum(b.vw) && b.vw > 0 ? b.vw : (b.high + b.low + b.close) / 3;
      const v = isNum(b.volume) ? b.volume : 0;
      pv += px * v;
      vol += v;
      out[i] = vol > 0 ? pv / vol : null;
    }
    return out;
  }

  /** Relative volume: current volume / mean of the previous n volumes. */
  function relativeVolume(volumes, n = 20) {
    const out = new Array(volumes.length).fill(null);
    for (let i = n; i < volumes.length; i++) {
      let s = 0;
      for (let j = i - n; j < i; j++) s += volumes[j];
      const avg = s / n;
      out[i] = avg > 0 ? volumes[i] / avg : null;
    }
    return out;
  }

  /** All overlay series for a bar array (used by the chart and the snapshot builder). */
  function computeSeries(bars, sessionOf) {
    const closes = bars.map((b) => b.close);
    const volumes = bars.map((b) => b.volume || 0);
    const m = macd(closes);
    const bb = bollinger(closes, 20, 2);
    return {
      sma9: sma(closes, 9), sma20: sma(closes, 20), sma50: sma(closes, 50), sma200: sma(closes, 200),
      ema9: ema(closes, 9), ema21: ema(closes, 21), ema50: ema(closes, 50),
      rsi14: rsi(closes, 14), macd: m.macd, macdSignal: m.signal, macdHist: m.hist,
      atr14: atr(bars, 14), bbUpper: bb.upper, bbMid: bb.mid, bbLower: bb.lower, bbWidth: bb.width,
      volSma20: sma(volumes, 20), relVol: relativeVolume(volumes, 20), vwap: vwap(bars, sessionOf),
    };
  }

  const REQUIRED = {
    sma9: 9, sma20: 20, sma50: 50, sma200: 200, ema9: 9, ema21: 21, ema50: 50, rsi14: 15,
    macd: 26, macdSignal: 34, macdHist: 34, atr14: 14, bbUpper: 20, bbMid: 20, bbLower: 20, bbWidth: 20,
    volSma20: 20, relVol: 21, vwap: 1,
  };

  /** Latest value of every indicator with explicit availability (never fabricated). */
  function latestValues(bars, sessionOf, series) {
    const s = series || computeSeries(bars, sessionOf);
    const last = bars.length - 1;
    const out = { barsAvailable: bars.length };
    for (const k of Object.keys(s)) {
      const v = last >= 0 ? s[k][last] : null;
      const needed = REQUIRED[k] || 1;
      out[k] = isNum(v)
        ? { value: v, available: true }
        : { value: null, available: false, reason: bars.length < needed ? `needs ${needed} bars, have ${bars.length}` : 'not applicable for current bar/session' };
    }
    return out;
  }

  return { sma, ema, rsi, macd, atr, trueRange, bollinger, vwap, relativeVolume, computeSeries, latestValues, REQUIRED };
});
