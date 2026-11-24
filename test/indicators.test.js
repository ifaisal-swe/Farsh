'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const I = require('../server/analysis/indicators');
const S = require('../server/analysis/structure');
const { detectSignals } = require('../server/analysis/signals');
const { approx } = require('./helpers/fixtures');

const bar = (t, o, h, l, c, v = 100, vw) => ({ time: t, open: o, high: h, low: l, close: c, volume: v, vw });

test('SMA: window average, null until enough data', () => {
  const s = I.sma([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3);
  assert.deepEqual(s.slice(0, 2), [null, null]);
  approx(s[2], 2); approx(s[9], 9);
});

test('EMA: SMA seed then recursive smoothing', () => {
  const e = I.ema([1, 2, 3, 4, 5], 3);
  assert.equal(e[1], null);
  approx(e[2], 2); approx(e[3], 3); approx(e[4], 4);
  const flat = I.ema(new Array(30).fill(7), 9);
  approx(flat[29], 7);
});

test('RSI: monotonic up = 100, monotonic down = 0, symmetric = 50', () => {
  const up = Array.from({ length: 30 }, (_, i) => 100 + i);
  const down = Array.from({ length: 30 }, (_, i) => 100 - i);
  const alt = Array.from({ length: 31 }, (_, i) => (i % 2 ? 101 : 100));
  approx(I.rsi(up, 14)[29], 100);
  approx(I.rsi(down, 14)[29], 0);
  approx(I.rsi(alt, 14)[14], 50, 1e-9);
  assert.equal(I.rsi(up, 14)[13], null);
});

test('RSI: Wilder smoothing matches hand calculation', () => {
  const closes = [10, 11, 10.5, 11.5, 12, 11.8, 12.4, 12.1, 12.9, 13.2, 12.8, 13.5, 13.4, 14, 13.7, 14.2];
  const n = 14;
  let g = 0; let l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n; let al = l / n;
  const first = 100 - 100 / (1 + ag / al);
  const d = closes[15] - closes[14];
  ag = (ag * 13 + Math.max(d, 0)) / 14; al = (al * 13 + Math.max(-d, 0)) / 14;
  const second = 100 - 100 / (1 + ag / al);
  const r = I.rsi(closes, 14);
  approx(r[14], first, 1e-9); approx(r[15], second, 1e-9);
});

test('MACD: zero on a flat series, defined after 26/34 bars', () => {
  const m = I.macd(new Array(40).fill(50));
  assert.equal(m.macd[24], null);
  approx(m.macd[25], 0); approx(m.signal[33], 0); approx(m.hist[39], 0);
  assert.equal(m.signal[32], null);
});

test('ATR: constant true range', () => {
  const bars = Array.from({ length: 20 }, (_, i) => bar(i, 10, 11, 9, 10));
  const a = I.atr(bars, 14);
  assert.equal(a[12], null);
  approx(a[13], 2); approx(a[19], 2);
  // gap increases true range
  const tr = I.trueRange([bar(0, 10, 11, 9, 10), bar(1, 13, 14, 12.5, 13)]);
  approx(tr[1], 4); // |14 - 10|
});

test('Bollinger: collapse on constant, k*sd otherwise', () => {
  const b = I.bollinger(new Array(25).fill(5), 20, 2);
  approx(b.upper[24], 5); approx(b.lower[24], 5);
  const vals = [...new Array(19).fill(10), 20];
  const b2 = I.bollinger(vals, 20, 2);
  const mean = (19 * 10 + 20) / 20;
  const sd = Math.sqrt((19 * (10 - mean) ** 2 + (20 - mean) ** 2) / 20);
  approx(b2.upper[19], mean + 2 * sd, 1e-9);
});

test('VWAP: anchored per session and excludes non-session bars', () => {
  const bars = [bar(1, 0, 0, 0, 0, 100, 10), bar(2, 0, 0, 0, 0, 300, 20), bar(3, 0, 0, 0, 0, 100, 50), bar(4, 0, 0, 0, 0, 100, 30)];
  const sess = (t) => ({ key: t <= 2 ? 'd1' : 'd2', include: t !== 3 });
  const v = I.vwap(bars, sess);
  approx(v[0], 10); approx(v[1], (10 * 100 + 20 * 300) / 400);
  assert.equal(v[2], null); // excluded bar (e.g. pre-market) not counted
  approx(v[3], 30); // reset at new session
});

test('Relative volume & volume MA', () => {
  const vols = [...new Array(20).fill(100), 300];
  approx(I.relativeVolume(vols, 20)[20], 3);
  assert.equal(I.relativeVolume(vols, 20)[19], null);
});

test('Unavailable indicators are flagged, never fabricated (new listing)', () => {
  const bars = Array.from({ length: 30 }, (_, i) => bar(i * 60, 10 + i * 0.1, 10.2 + i * 0.1, 9.9 + i * 0.1, 10.1 + i * 0.1));
  const lv = I.latestValues(bars, () => ({ key: 'x', include: true }));
  assert.equal(lv.sma200.available, false);
  assert.equal(lv.sma200.value, null);
  assert.match(lv.sma200.reason, /needs 200 bars, have 30/);
  assert.equal(lv.sma20.available, true);
  assert.equal(lv.ema50.available, false);
});

test('Structure: swings, S/R clustering, consolidation, signals run on real bars', () => {
  const bars = [];
  const pattern = [10, 10.2, 10.5, 11, 10.5, 10.2, 10, 10.2, 10.5, 11, 10.6, 10.2, 10, 10.3, 10.6, 11.02, 10.5, 10.2, 10, 10.1];
  pattern.forEach((p, i) => bars.push(bar(i * 60, p, p + 0.05, p - 0.05, p)));
  const sw = S.findSwings(bars, 2);
  assert.ok(sw.highs.length >= 2 && sw.lows.length >= 1);
  const sr = S.supportResistance(bars, 10.5, 0.2);
  assert.ok(sr.resistance.length >= 1 && sr.resistance[0].price > 10.5);
  assert.ok(sr.resistance[0].touches >= 2, 'equal highs cluster into one level');
  const cons = S.consolidation(bars, 0.5, 12);
  assert.equal(cons.isConsolidating, true);
  const series = I.computeSeries(bars);
  const sig = detectSignals({ bars, series, sr, levels: S.keyBreakLevels(10.5, sr, {}, cons), cons });
  assert.ok(Array.isArray(sig) && sig.every((s) => typeof s.active === 'boolean'));
});
