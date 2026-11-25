'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../server/analysis/strength');
const H = require('../server/analysis/honest');
const Q = require('../server/lab/quant');
const { decide } = require('../server/opportunity/decide');
const { RiskManager } = require('../server/trading/risk');
const { read } = require('../server/lab/technical');
const { DEFAULTS } = require('../server/config');

const walk = (seed, n = 1000, drift = 0.0003, vol = 0.015) => { const r = H.rng(seed); let p = 100; return Array.from({ length: n }, () => (p *= 1 + drift + (r() + r() + r() - 1.5) * vol)); };
const bars = (c) => c.map((x, i) => ({ time: 1500000000 + i * 86400, open: i ? c[i - 1] : x, high: Math.max(x, i ? c[i - 1] : x) * 1.004, low: Math.min(x, i ? c[i - 1] : x) * 0.996, close: x, volume: 1e6 }));

test('strength: the strongest is first, a place needs enough peers, missing history is skipped', () => {
  const group = Array.from({ length: 20 }, (_, i) => `S${i}`); const closes = Object.fromEntries(group.map((s, i) => [s, walk(i + 1, 400, (i - 10) * 0.0006, 0.004)])); closes.SHORT = walk(1, 50);
  const spy = walk(99, 400, 0.0002, 0.004); const t = S.rank(closes, spy, group);
  assert.ok(t.S19.place > 0.85 && t.S0.place < 0.15); assert.equal(t.SHORT, undefined); assert.equal(t.S19.above200, true); assert.equal(t.S0.above200, false);
  assert.equal(S.rank({ S1: closes.S1 }, spy, ['S1']).S1.place, null);
});

test('strength: risk is halved under the long average and never raised', () => {
  const up = Array.from({ length: 260 }, (_, i) => 100 + i); const down = [...up].reverse();
  assert.deepEqual([S.marketState({}, up).factor, S.marketState({}, down).factor, S.marketState({}, up.slice(0, 50)).factor], [1, 0.5, 1]);
  assert.equal(S.marketState({}, up.slice(0, 50)).known, false);
});

test('strength: the same bet twice is refused; unknown data and the same symbol never are', () => {
  const a = walk(3, 200); const b = a.map((x) => x * 2); const z = walk(8, 200); const closes = { AAA: a, BBB: b, ZZZ: z }; const none = () => null;
  assert.ok(S.correlation(a, b) > 0.99); assert.ok(Math.abs(S.correlation(a, z)) < 0.4); assert.equal(S.correlation(a.slice(0, 10), b), null);
  const base = { symbol: 'AAA', equity: 100, closes, sectorOf: none };
  assert.equal(S.concentration({ ...base, held: [{ symbol: 'BBB', value: 45 }] }).pass, false);
  assert.equal(S.concentration({ ...base, held: [{ symbol: 'BBB', value: 30 }] }).pass, true);
  assert.equal(S.concentration({ ...base, held: [{ symbol: 'ZZZ', value: 90 }] }).pass, true);
  assert.equal(S.concentration({ ...base, held: [{ symbol: 'AAA', value: 90 }] }).pass, true);
  assert.equal(S.concentration({ ...base, held: [{ symbol: 'NEW', value: 90 }] }).pass, true);
  assert.equal(S.concentration({ symbol: 'NVDA', equity: 100, closes: {}, held: [{ symbol: 'AMD', value: 55 }] }).pass, false, 'same sector');
});

test('strength: closes are kept, a failing source changes nothing, one refresh at a time', async () => {
  let t = 0; let calls = 0; let fail = false; const group = Array.from({ length: 16 }, (_, i) => `S${i}`);
  const s = new S.StrengthService({ now: () => t, gapMs: 0, group, followed: () => ['S1'], fetchBars: async (x) => { calls++; if (fail) throw new Error('x'); return bars(walk(x.length + Number(x.slice(1) || 50), 300)); } });
  await Promise.all([s.refresh(), s.refresh()]); assert.equal(calls, 17); const before = s.of('S1').place; assert.ok(before !== null); assert.ok(s.market.known);
  await s.refresh(); assert.equal(calls, 17, 'nothing stale'); t += 7 * 3600000; fail = true; await s.refresh(); assert.equal(s.of('S1').place, before);
});

test('honest: rules on pure noise are never called proven', () => {
  let proven = 0; for (let i = 1; i <= 40; i++) if (H.compare(walk(i * 31, 1250, 0)).proven) proven++;
  assert.equal(proven, 0); assert.equal(H.compare(walk(1, 300)), null);
  const rising = H.compare(walk(77, 1250, 0.0025)); assert.ok(rising.rows.hold.yearly > 0.5); assert.ok(rising.notLuck === null || rising.notLuck < 0.9, 'a rising price is not skill: ' + rising.notLuck); assert.equal(rising.proven, false);
});

test('honest: a real effect beats random timing, holding has no timing score, and the locked part is separate', () => {
  const c = []; let p = 100; const r = H.rng(4); let d = 0.005; let left = 0; for (let i = 0; i < 3000; i++) { if (left-- <= 0) { d = d > 0 ? -0.004 : 0.005; left = 90 + Math.floor(r() * 260); } p *= 1 + d + (r() - 0.5) * 0.004; c.push(p); }
  const x = H.compare(c); assert.ok(x.rows.cross.timing > 0.95 && x.rows.cross.sharpe > x.rows.hold.sharpe); assert.equal(x.rows.hold.timing, null); assert.ok(x.lockedDays > 300); assert.notEqual(x.best, 'hold');
  const changed = H.compare([...c.slice(0, 252 + x.days + 1), ...c.slice(252 + x.days + 1).map((v) => v * 3)]); assert.equal(changed.best, x.best, 'the locked part does not choose');
});

test('honest: more tries make the same result less convincing', () => {
  const r = walk(5, 600).map((x, i, a) => (i ? x / a[i - 1] - 1 + 0.0012 : 0)).slice(1); const few = H.deflated(r, [1, 0.5]); const many = H.deflated(r, Array.from({ length: 200 }, (_, i) => 1 + Math.sin(i)));
  assert.ok(few > many); assert.equal(H.deflated(r.slice(0, 20), [1, 2]), null);
});

test('honest: a signal is compared with random days', () => {
  const r = Array.from({ length: 900 }, (_, i) => Math.sin(i) * 0.02);
  assert.ok(H.againstRandom(r, 0.015, 15) > 0.95); const mid = H.againstRandom(r, 0, 15); assert.ok(mid > 0.25 && mid < 0.75); assert.equal(H.againstRandom(r, 0.1, 3), null); assert.equal(H.againstRandom(r.slice(0, 50), 0.1, 15), null);
});

test('honest: said confidence becomes what really happened, only with enough results, and never decreases', () => {
  assert.deepEqual(H.calibrate([{ p: 0.5, hit: true }]), { ready: false, n: 1, need: 20 });
  const r = H.rng(2); const l = Array.from({ length: 400 }, () => { const p = 0.4 + r() * 0.5; return { p, hit: r() < p - 0.2 }; }); const k = H.calibrate(l);
  assert.ok(k.ready); assert.ok(Math.abs(k.at(0.85) - 0.63) < 0.12, String(k.at(0.85))); for (let i = 1; i < k.bins.length; i++) assert.ok(k.bins[i].real >= k.bins[i - 1].real); assert.ok(k.at(0) <= k.at(1));
});

test('forecast: a plan ends at the target or the stop, whichever is first; both on one day is the stop', () => {
  const flat = Array.from({ length: 40 }, () => ({ open: 100, high: 101, low: 99, close: 100, volume: 1 })); const at = (over) => { const b = flat.map((x) => ({ ...x })); Object.entries(over).forEach(([i, v]) => Object.assign(b[i], v)); return Q.barrier(b)(15); };
  assert.equal(at({ 17: { high: 110 } }), 1); assert.equal(at({ 17: { low: 90 } }), 0); assert.equal(at({ 17: { high: 110, low: 90 } }), 0); assert.equal(at({ 17: { low: 90 }, 18: { high: 110 } }), 0); assert.equal(at({}), 0); assert.equal(at({ 36: { high: 110 } }), 0, 'too late');
  const x = Q.targetFirst(bars(walk(12, 900)), null); assert.ok(x.available); assert.ok(x.chance >= 0 && x.chance <= 1); if (!x.edge) assert.equal(x.chance, x.usual);
});

test('signals: cheap in a falling trend is not a reason', () => {
  const fall = []; let p = 200; for (let i = 0; i < 260; i++) { p *= i > 240 ? 0.985 : 0.998; fall.push(p); } const d = read(bars(fall), { ar: 'x', en: 'x' });
  assert.equal(d.readings.find((r) => r.id === 'rsi').score, 0); assert.equal(d.readings.find((r) => r.id === 'stoch').score, 0); assert.ok(d.readings.find((r) => r.id === 'bands').score <= 0);
});

test('calls: strength counts, and a weak market or stock only makes the size smaller', () => {
  const T = (x) => ({ ar: x, en: x }); const DIP = { side: 'BUY', id: 'DIP', type: 'LIMIT', price: 100, stop: 95, target: 112, odds: { target: 0.4, stop: 0.4, neither: 0.2 }, why: T('x') };
  const base = { symbol: 'A', price: 101, bars: bars(walk(1, 260)), tech: { score: 0.8, agree: true, record: [], setups: [DIP], horizons: { days: { atr: 2, s50: 100, resistance: [{ price: 120 }] } } }, account: { equity: 100000, cash: 100000, riskPct: 0.5, maxPositionPct: 100 }, events: [], live: true, fresh: true, now: 1 };
  const place = (n, above200 = true) => ({ place: n, among: 40, above200 }); const e = (c) => c.evidence.find((x) => x.kind === 'strength');
  assert.equal(e(decide({ ...base, strength: place(1) })).score, 1); assert.equal(e(decide({ ...base, strength: place(0) })).score, -1); assert.equal(e(decide(base)), undefined);
  const full = decide({ ...base, strength: place(1) }).plan.size.qty; const weak = decide({ ...base, strength: place(1), market: { factor: 0.5, above: false } }); const both = decide({ ...base, strength: place(1, false), market: { factor: 0.5, above: false } });
  assert.ok(Math.abs(weak.plan.size.qty - full / 2) <= 1); assert.ok(both.plan.size.qty <= full / 4 + 1); assert.ok(weak.cautions.length); assert.equal(decide({ ...base, strength: place(1), crypto: true, market: { factor: 0.5, above: false } }).plan.size.qty >= full, true);
  assert.ok(decide({ ...base, crowd: { pass: false } }).cautions.some((c) => /same bet/.test(c.en)));
});

test('risk: the engine lowers the budget, never raises it, and refuses a second copy of one bet', () => {
  const r = new RiskManager(DEFAULTS.risk); const ctx = { proposal: { stopLoss: 98, takeProfit: 106, orderType: 'MARKET', snapshotPrice: 100, createdAt: 1 }, quote: { bid: 99.99, ask: 100.01, askSize: 100 }, market: { realtime: true, connected: true, stale: false, halted: false, session: 'REGULAR', quoteAgeMs: 1, feedLabel: 'x' }, account: { equity: 1000000, cash: 1000000, positionQty: 0, positionMark: 0, openPositions: 0 }, exec: DEFAULTS.execution, ai: DEFAULTS.ai, nowMs: 1 };
  const b = (f) => r.evaluateEntry({ ...ctx, riskFactor: f }).sizing.riskBudget; assert.equal(b(0.5), b(1) / 2); for (const f of [2, 0, -1, undefined, NaN]) assert.equal(b(f), b(1));
  const no = r.evaluateEntry({ ...ctx, crowd: { pass: false, detail: 'x' } }); assert.equal(no.approved, false); assert.ok(no.failed.some((x) => /same_bet/.test(x)));
});
