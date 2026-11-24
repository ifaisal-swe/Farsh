'use strict';
/**
 * Start, stop and target prices for one investment. Rules produce the prices and the allowed range around them; the
 * analysts may move a price only inside that range. Chances come from replayed past days with their average removed.
 */
const { rng } = require('../lab/quant');

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const tidy = (x) => (x >= 1000 ? Math.round(x * 10) / 10 : x >= 1 ? Math.round(x * 100) / 100 : Number(x.toPrecision(4)));
const median = (l) => { const s = [...l].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function atr(bars, n = 14) {
  const b = bars.slice(-(n + 1));
  const tr = b.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - b[i].close), Math.abs(x.low - b[i].close)));
  return tr.reduce((a, c) => a + c, 0) / (tr.length || 1);
}

/** bars: daily. days: trading days the person gives it. goalPct: the gain asked for, or null to let the rules choose. */
function suggest(bars, price, { days = 20, goalPct = null, verdict = 'UNKNOWN' } = {}) {
  if (!bars || bars.length < 40 || !(price > 0)) return null;
  const a = atr(bars);
  if (!(a > 0)) return null;
  const last = bars.slice(-20);
  const sma = last.reduce((s, b) => s + b.close, 0) / last.length;
  const low = Math.min(...bars.slice(-10).map((b) => b.low));
  const stretched = price > sma + 1.5 * a;
  const wait = stretched || verdict === 'AVOID';
  const bounds = { entry: [price - Math.min(2 * a, price * 0.2), price * 1.003] };
  const entry = wait ? clamp(Math.max(sma, price - a), ...bounds.entry) : price * 1.002; // a little room, so a small rise does not miss the start
  if (wait) bounds.entry[1] = entry; // the analysts may ask for a lower start here, never a higher one
  const width = a * clamp(1.5 + Math.sqrt(days) / 5, 1.8, 3.5);
  const belowLow = low - 0.2 * a;
  const natural = entry - belowLow >= 1.2 * a && entry - belowLow <= 3.5 * a;
  const stop = clamp(natural ? belowLow : entry - width, entry * 0.6, entry - a);
  const target = goalPct ? entry * (1 + goalPct / 100) : entry + 2 * (entry - stop);
  bounds.stopAtr = [1, 4]; bounds.rr = [1.2, 4];
  return { price, atr: a, entry: tidy(entry), stop: tidy(stop), target: tidy(target), bounds, days, goalPct, why: { entry: verdict === 'AVOID' ? 'AVOID' : stretched ? 'STRETCHED' : 'NOW', stop: natural ? 'LOW' : 'RANGE', target: goalPct ? 'GOAL' : 'TWICE' } };
}

/** The analysts' prices, taken as the middle answer and kept inside the allowed range. */
function adopt(s, answers) {
  const ok = (answers || []).filter((x) => x && [x.entry, x.stop, x.target].every((n) => Number.isFinite(n) && n > 0) && x.stop < x.entry && x.entry < x.target);
  if (!ok.length) return s;
  const entry = clamp(median(ok.map((x) => x.entry)), ...s.bounds.entry);
  const stop = clamp(median(ok.map((x) => x.stop)), Math.max(entry * 0.6, entry - s.bounds.stopAtr[1] * s.atr), entry - s.bounds.stopAtr[0] * s.atr);
  const risk = entry - stop;
  const target = s.goalPct ? entry * (1 + s.goalPct / 100) : clamp(median(ok.map((x) => x.target)), entry + s.bounds.rr[0] * risk, entry + s.bounds.rr[1] * risk);
  return { ...s, entry: tidy(entry), stop: tidy(stop), target: tidy(target), byAI: true, why: { entry: s.why.entry === 'NOW' ? 'ANALYSTS' : s.why.entry, stop: 'ANALYSTS', target: s.goalPct ? 'GOAL' : 'ANALYSTS' } };
}

/** How often the target, the stop, or neither comes first. The stop wins a day that touches both. */
function odds(bars, { entry, stop, target, days }, { paths = 3000, seed = 9 } = {}) {
  const h = bars.slice(-500);
  if (h.length < 60) return null;
  const r = h.slice(1).map((b, i) => [b.close / h[i].close, b.high / h[i].close, b.low / h[i].close]).filter((x) => x.every((n) => Number.isFinite(n) && n > 0.3 && n < 3));
  const m = Math.exp(r.reduce((a, x) => a + Math.log(x[0]), 0) / r.length);
  const rand = rng(seed); let t = 0; let s = 0; let sum = 0;
  for (let p = 0; p < paths; p++) {
    let px = entry; let i = Math.floor(rand() * r.length); let end = null;
    for (let d = 0; d < days && end == null; d++) {
      i = rand() < 0.1 ? Math.floor(rand() * r.length) : (i + 1) % r.length;
      const [c, hi, lo] = r[i].map((x) => (px * x) / m);
      if (lo <= stop) { s++; end = Math.min(stop, hi); } else if (hi >= target) { t++; end = target; } else px = c;
    }
    sum += (end == null ? px : end) / entry - 1;
  }
  return { target: t / paths, stop: s / paths, neither: (paths - t - s) / paths, average: sum / paths };
}

module.exports = { suggest, adopt, odds, atr, tidy };
