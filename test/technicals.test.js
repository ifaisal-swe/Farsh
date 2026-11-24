'use strict';
/** Chart technicals: confirmed swings without look-ahead, levels, patterns with exact conditions, AI-level verification. */
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../server/analysis/technicals');
const { validateProposal } = require('../server/ai/proposal');
const { buildChartAnalysis } = require('../server/analysis/chartAnalysis');
const { systemPrompt } = require('../server/ai/prompt');

const bar = (i, o, h, l, c, v = 1000) => ({ time: 1_800_000_000 + i * 60, open: o, high: h, low: l, close: c, volume: v });

function wave(n = 240, seed = 3) {
  let s = seed;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const out = [];
  let p = 50;
  for (let i = 0; i < n; i++) {
    const o = p;
    const c = o + Math.sin(i / 9) * 0.35 + (rnd() - 0.5) * 0.2;
    out.push(bar(i, o, Math.max(o, c) + rnd() * 0.15, Math.min(o, c) - rnd() * 0.15, c, 800 + Math.round(rnd() * 1500)));
    p = c;
  }
  return out;
}

test('swings: confirmed only after k bars, with confirmation time; no repainting with more data', () => {
  const bars = wave();
  const full = T.analyze(bars, { tfSec: 60 });
  assert.ok(full.swings.highs.length > 3 && full.swings.lows.length > 3);
  for (const p of full.swings.points) {
    assert.equal(p.confirmedIndex, p.index + 3);
    assert.equal(p.confirmedAt, bars[p.index + 3].time + 60, 'confirmed at the close of the 3rd bar after the pivot');
  }
  for (const cut of [60, 120, 200]) {
    const part = T.analyze(bars.slice(0, cut), { tfSec: 60 });
    const known = full.swings.points.filter((p) => p.confirmedIndex < cut).map((p) => `${p.type}${p.index}:${p.label}`);
    assert.deepEqual(part.swings.points.map((p) => `${p.type}${p.index}:${p.label}`), known, `prefix ${cut} identical`);
    for (const pr of part.swings.provisional) assert.ok(pr.index >= cut - 3, 'provisional pivots are never confirmed ones');
  }
});

test('swing labels HH/HL/LH/LL follow the previous confirmed swing of the same type', () => {
  const full = T.analyze(wave(), { tfSec: 60 });
  for (const list of [full.swings.highs, full.swings.lows]) {
    for (let i = 1; i < list.length; i++) {
      const p = list[i];
      if (p.label === 'EQ') continue;
      const up = p.price > list[i - 1].price;
      assert.equal(p.label, p.type === 'H' ? (up ? 'HH' : 'LH') : (up ? 'HL' : 'LL'));
    }
  }
});

test('break events only use swing levels confirmed before the breaking bar', () => {
  const bars = wave(300, 9);
  const a = T.analyze(bars, { tfSec: 60 });
  assert.ok(a.events.length > 0);
  for (const e of a.events) {
    const src = a.swings.points.find((p) => p.time === e.swingTime && (e.type === 'BREAKOUT' ? p.type === 'H' : p.type === 'L'));
    assert.ok(src.confirmedIndex <= e.index - 1, 'level known before the event bar');
    if (e.type === 'BREAKOUT') assert.ok(bars[e.index].close > e.level && bars[e.index - 1].close <= e.level);
    else assert.ok(bars[e.index].close < e.level && bars[e.index - 1].close >= e.level);
  }
});

test('levels: supports below price, resistances above, ranked S1/S2 and R1/R2 with reaction counts', () => {
  const bars = wave();
  const a = T.analyze(bars, { tfSec: 60, session: { prevSessionHigh: 60, prevSessionLow: 40 } });
  const px = a.price;
  assert.ok(a.levels.supports.every((l) => l.price <= px && l.status === 'active'));
  assert.ok(a.levels.resistances.every((l) => l.price >= px && l.status === 'active'));
  if (a.levels.supports[0]) assert.equal(a.levels.supports[0].rank, 'S1');
  for (const l of a.levels.all) {
    assert.ok(l.strength >= 1 && l.strength <= 100);
    assert.equal(l.reactions, l.pivots.length);
    if (l.status === 'broken') assert.ok(Number.isFinite(l.brokenAt));
  }
});

test('candlestick patterns are only labelled when their mathematical conditions hold', () => {
  // decline, then a hammer: long lower wick, small body at the top, tiny upper wick
  const bars = [];
  for (let i = 0; i < 20; i++) { const o = 100 - i * 0.5; bars.push(bar(i, o, o + 0.1, o - 0.6, o - 0.5)); }
  bars.push(bar(20, 90.0, 90.32, 88.6, 90.3));
  bars.push(bar(21, 90.3, 91.2, 90.2, 91.0)); // confirmation: closes above the hammer high
  const pats = T.patterns(bars, T.atrSeries(bars, 14));
  const h = pats.find((p) => p.code === 'HAMMER');
  assert.ok(h, 'hammer detected');
  assert.ok(h.conditions.lowerWickToBody >= 2);
  assert.equal(h.priorTrend, 'DOWN');
  assert.equal(h.confirmation.status, 'CONFIRMED');
  assert.equal(h.confirmation.at, bars[21].time);
  // same candle after a RISE is not a hammer
  const up = [];
  for (let i = 0; i < 20; i++) { const o = 80 + i * 0.5; up.push(bar(i, o, o + 0.6, o - 0.1, o + 0.5)); }
  up.push(bar(20, 90.0, 90.32, 88.6, 90.3));
  assert.equal(T.patterns(up, T.atrSeries(up, 14)).some((p) => p.code === 'HAMMER'), false);
  // bullish engulfing requires the body to cover the previous body
  const eng = [];
  for (let i = 0; i < 20; i++) { const o = 100 - i * 0.4; eng.push(bar(i, o, o + 0.1, o - 0.5, o - 0.4)); }
  eng.push(bar(20, 92.0, 92.1, 91.0, 91.2));
  eng.push(bar(21, 91.1, 92.4, 91.0, 92.3));
  assert.ok(T.patterns(eng, T.atrSeries(eng, 14)).some((p) => p.code === 'BULLISH_ENGULFING'));
  eng[21] = bar(21, 91.1, 92.0, 91.0, 91.9); // does not close above the previous open
  assert.equal(T.patterns(eng, T.atrSeries(eng, 14)).some((p) => p.code === 'BULLISH_ENGULFING'), false);
});

test('candle anatomy: wick/body sizes and shape', () => {
  const a = T.anatomy(bar(0, 10, 10.6, 9.0, 10.5), { atr: 0.8 });
  assert.equal(a.direction, 'UP');
  assert.equal(a.shape, 'LONG_LOWER_WICK');
  assert.ok(Math.abs(a.lowerWick - 1.0) < 1e-9 && Math.abs(a.upperWick - 0.1) < 1e-9 && Math.abs(a.body - 0.5) < 1e-9);
  assert.equal(T.anatomy(bar(0, 10, 10.5, 9.5, 10.01)).shape, 'DOJI');
});

test('AI explanation fields are optional and parsed; AI levels are verified against app levels', () => {
  const base = {
    snapshot_id: 'snap_1', action: 'WAITING_FOR_BREAKOUT', confidence: 55, strategy: 'BREAKOUT', directional_bias: 'BULLISH', trend: 'UPTREND',
    key_levels: { support: [49.5, 30], resistance: [52], breakout: 52 }, watch_level: 52,
    decision_change: { previous_action: 'BUY', changed: true, reason: 'تراجع الزخم قرب المقاومة' },
    chart_explanation: { trend: 'صاعد', entry_conditions: 'إغلاق فوق 52 مع حجم' },
  };
  const v = validateProposal(JSON.stringify(base), { snapshotId: 'snap_1', symbol: 'X', price: 51, hasPosition: false });
  assert.equal(v.ok, true, v.errors.join());
  assert.equal(v.proposal.decisionChange.changed, true);
  assert.equal(v.proposal.decisionChange.previousAction, 'BUY');
  assert.equal(v.proposal.chartExplanation.entryConditions, 'إغلاق فوق 52 مع حجم');
  const old = validateProposal(JSON.stringify({ snapshot_id: 'snap_1', action: 'WAIT', confidence: 40 }), { snapshotId: 'snap_1', symbol: 'X', price: 51 });
  assert.equal(old.ok, true, 'responses without the new fields stay valid');
  assert.equal(old.proposal.chartExplanation, null);

  const tech = { available: true, atr: 0.4, levels: { all: [{ price: 49.5, zoneLow: 49.4, zoneHigh: 49.6, rank: 'S1', origin: 'support' }] }, swings: { points: [{ type: 'H', price: 52.02 }] }, range: null, trendlines: [] };
  const snapshot = { symbol: 'X', market: { lastPrice: 51, sessionLevels: {}, sessionVwap: { available: false } } };
  const ca = buildChartAnalysis({ proposal: v.proposal, decisionId: 'dec_1', at: 1, tf: '5m', snapshot, internals: { tech, levels: {} }, previous: { id: 'dec_0', ts: 0, proposal: { action: 'BUY', directionalBias: 'BULLISH' } } });
  const s1 = ca.levels.find((l) => l.price === 49.5);
  assert.equal(s1.verified, true);
  assert.equal(ca.levels.find((l) => l.price === 30).verified, false, 'invented level flagged unverified');
  assert.equal(ca.levels.find((l) => l.kind === 'breakout').verified, true, 'matches the confirmed swing high');
  assert.equal(ca.unverifiedLevels, 1);
  assert.equal(ca.change.changed, true);
  assert.equal(ca.change.from, 'BUY');
  assert.equal(ca.change.reason, 'تراجع الزخم قرب المقاومة');
});

test('prompt: Arabic output for text fields, English enums/keys, profile and verified-data rules', () => {
  const ar = systemPrompt({ autonomy: 'FULL', fractional: false, language: 'ar' });
  assert.match(ar, /Modern Standard Arabic/);
  assert.match(ar, /Keep ALL json keys, enum values/);
  assert.match(ar, /RISK PROFILE/);
  assert.match(ar, /VERIFIED CHART DATA/);
  assert.match(ar, /PREVIOUS ANALYSIS/);
  assert.match(ar, /"chart_explanation"/);
  assert.match(systemPrompt({ autonomy: 'FULL', fractional: false, language: 'en' }), /text value .* in English/);
});
