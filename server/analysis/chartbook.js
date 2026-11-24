'use strict';
/**
 * Everything the chart workspace draws, computed from the bars alone: averages, bands, indicator panes, candle
 * patterns with how each one did on this symbol before, support and resistance, Fibonacci levels and an estimate of
 * money flow. Pure functions; nothing here decides a trade.
 */
const Ind = require('./indicators');
const Tech = require('./technicals');

const ok = Number.isFinite;
const PERIODS = [10, 20, 50, 100, 200];
const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400, '1w': 604800 };

function stochastic(bars, n = 14, smooth = 3) {
  const raw = bars.map((b, i) => { if (i < n - 1) return null; let hi = -Infinity; let lo = Infinity; for (let j = i - n + 1; j <= i; j++) { hi = Math.max(hi, bars[j].high); lo = Math.min(lo, bars[j].low); } return hi > lo ? ((b.close - lo) / (hi - lo)) * 100 : 50; });
  const avg = (a) => a.map((_, i) => { const w = a.slice(Math.max(0, i - smooth + 1), i + 1); return w.length === smooth && w.every(ok) ? w.reduce((x, y) => x + y, 0) / smooth : null; });
  const k = avg(raw);
  return { k, d: avg(k) };
}

/** Money flow index: RSI weighted by traded value. */
function mfi(bars, n = 14) {
  const tp = bars.map((b) => (b.high + b.low + b.close) / 3);
  return bars.map((_, i) => {
    if (i < n) return null;
    let up = 0; let dn = 0;
    for (let j = i - n + 1; j <= i; j++) { const f = tp[j] * (bars[j].volume || 0); if (tp[j] > tp[j - 1]) up += f; else if (tp[j] < tp[j - 1]) dn += f; }
    return up + dn > 0 ? (100 * up) / (up + dn) : null;
  });
}

/** Estimated money in and out of each bar: its traded value times where it closed in its range (-1..1). */
function flow(bars) {
  return bars.map((b) => { const r = b.high - b.low; const v = (b.volume || 0) * ((b.high + b.low + b.close) / 3); return r > 0 ? v * ((2 * b.close - b.high - b.low) / r) : 0; });
}

/** Share of the traded value of the last n bars that the estimate counts as coming in (0..1). */
function inflowShare(bars, n = 20) {
  const b = bars.slice(-n); let pos = 0; let neg = 0;
  for (const x of flow(b)) if (x > 0) pos += x; else neg -= x;
  return pos + neg > 0 ? pos / (pos + neg) : null;
}

/** How each pattern did here: the move over the next bars from the following open, against any ordinary bar. */
function patternRecord(bars, found, ahead = 5) {
  const n = bars.length; const ret = (i) => bars[i + ahead].close / bars[i + 1].open - 1;
  let base = 0; let up = 0; let all = 0;
  for (let i = 20; i + ahead < n; i++) { const r = ret(i); if (ok(r)) { base += r; all++; if (r > 0) up++; } }
  if (all < 60) return {};
  base /= all; up /= all;
  const out = {};
  for (const p of found) {
    if (p.index + ahead >= n) continue;
    const r = ret(p.index); if (!ok(r)) continue;
    const x = out[p.code] || (out[p.code] = { times: 0, right: 0, sum: 0, direction: p.direction });
    x.times++; x.sum += r; if (p.direction === 'BEARISH' ? r < 0 : r > 0) x.right++;
  }
  for (const x of Object.values(out)) { x.average = x.sum / x.times; delete x.sum; x.rate = x.right / x.times; x.usual = base; x.usualRate = x.direction === 'BEARISH' ? 1 - up : up; x.ahead = ahead; x.useful = x.times >= 12 && x.rate > x.usualRate + 0.05; }
  return out;
}

/** Retracement levels of the largest move inside the recent bars. */
function fibonacci(bars, look = 120) {
  const w = bars.slice(-look); if (w.length < 30) return null;
  let hi = 0; let lo = 0;
  w.forEach((b, i) => { if (b.high > w[hi].high) hi = i; if (b.low < w[lo].low) lo = i; });
  const top = w[hi].high; const bottom = w[lo].low; if (!(top > bottom)) return null;
  const up = lo < hi; // the move that the pullback measures
  return { up, top, bottom, levels: [0.236, 0.382, 0.5, 0.618, 0.786].map((r) => ({ ratio: r, price: up ? top - (top - bottom) * r : bottom + (top - bottom) * r })) };
}

function build(input, { tf = '1d', price = null } = {}) {
  const bars = (input || []).filter((b) => [b.open, b.high, b.low, b.close].every(ok));
  if (bars.length < 30) return { tf, bars: bars.map(slim), available: false };
  const c = bars.map((b) => b.close); const sec = TF_SEC[tf] || 86400;
  const r = (x) => (ok(x) ? Math.round(x * 10000) / 10000 : null); const R = (a) => a.map(r);
  const m = Ind.macd(c); const bb = Ind.bollinger(c, 20, 2); const st = stochastic(bars);
  const averages = {};
  for (const n of PERIODS) { averages[`sma${n}`] = R(Ind.sma(c, n)); averages[`ema${n}`] = R(Ind.ema(c, n)); }
  const t = Tech.analyze(bars, { tfSec: sec, price });
  const found = t.available ? t.patterns : [];
  const zone = (z) => ({ price: r(z.price), low: r(z.zoneLow), high: r(z.zoneHigh), touches: z.reactions ?? null, rank: z.rank });
  return {
    tf, available: true, bars: bars.map(slim), averages, bands: { upper: R(bb.upper), mid: R(bb.mid), lower: R(bb.lower) },
    rsi: R(Ind.rsi(c, 14)), macd: { line: R(m.macd), signal: R(m.signal), hist: R(m.hist) }, stoch: { k: R(st.k), d: R(st.d) }, mfi: R(mfi(bars)), flow: flow(bars).map(Math.round),
    inflow: inflowShare(bars), patterns: found.slice(-60).map((p) => ({ code: p.code, direction: p.direction, time: p.time, startTime: p.startTime, high: r(p.high), low: r(p.low), status: p.confirmation.status })), record: patternRecord(bars, found),
    support: t.available ? t.levels.supports.map(zone) : [], resistance: t.available ? t.levels.resistances.map(zone) : [], fib: fibonacci(bars), atr: r(t.atr),
  };
}
const slim = (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });

module.exports = { build, stochastic, mfi, flow, inflowShare, patternRecord, fibonacci, PERIODS };
