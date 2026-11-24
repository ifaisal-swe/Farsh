'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { RiskManager } = require('../server/trading/risk');
const { DEFAULTS } = require('../server/config');
const { T0 } = require('./helpers/fixtures');

const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
// These tests exercise the engine mechanics with the pre-profile limits (1% risk, 25% allocation, R:R 1.5).
const LIMITS = { ...JSON.parse(JSON.stringify(DEFAULTS.risk)), ...LEGACY_DEFAULTS, profile: 'CUSTOM' };
const EXEC = { ...DEFAULTS.execution };
const AI = { proposalMaxAgeSec: 120, maxPriceDriftPct: 0.5 };
const MARKET_OK = { realtime: true, feedLabel: 'LIVE — TEST', connected: true, stale: false, staleReasons: [], quoteAgeMs: 200, halted: false, session: 'REGULAR' };
const Q = { bid: 99.98, ask: 100.02, bidSize: 500, askSize: 500 };
const ACCT = { equity: 10000, cash: 10000, positionQty: 0, positionMark: 0, openPositions: 0 };
const prop = (o = {}) => ({ stopLoss: 99, takeProfit: 103, positionSizePct: 100, orderType: 'MARKET', limitPrice: null, snapshotPrice: 100, createdAt: T0, ...o });
const evalEntry = (rm, o = {}) => rm.evaluateEntry({ proposal: prop(o.p), quote: o.q || Q, market: { ...MARKET_OK, ...(o.m || {}) }, account: { ...ACCT, ...(o.a || {}) }, ipo: o.ipo || {}, exec: { ...EXEC, ...(o.e || {}) }, ai: AI, nowMs: o.now || T0 + 5000 });
const failed = (r, name) => r.checks.some((c) => c.name === name && !c.pass);

test('sizing: smallest of risk budget, allocation cap, cash and AI request wins', () => {
  const rm = new RiskManager(LIMITS);
  const r = evalEntry(rm);
  assert.equal(r.approved, true);
  // allocation 25% of 10k = 2500 / ~100.04 = 24 sh ; risk 1% = $100 / ~1.06 = 94 sh
  assert.equal(r.qty, 24);
  assert.equal(r.sizing.limitingFactor, 'byAllocation');
  const r2 = evalEntry(rm, { p: { stopLoss: 95, takeProfit: 115 } });
  // risk per share ~5.06 -> 19 sh by risk < 24 by allocation
  assert.equal(r2.qty, 19);
  assert.equal(r2.sizing.limitingFactor, 'byRisk');
  assert.ok(r2.sizing.riskAtStop <= 100 + 1e-9, 'never risks more than 1% of equity');
  const r3 = evalEntry(rm, { p: { positionSizePct: 5 } });
  assert.equal(r3.qty, 4); assert.equal(r3.sizing.limitingFactor, 'byProposal');
});

test('sizing: small account can only afford what the limits allow (no fractional by default)', () => {
  const rm = new RiskManager(LIMITS);
  const r = evalEntry(rm, { a: { equity: 500, cash: 500 }, q: { bid: 89.95, ask: 90, askSize: 100, bidSize: 100 }, p: { stopLoss: 88.5, takeProfit: 94, snapshotPrice: 89.97 } });
  // 25% of 500 = 125 -> 1 share
  assert.equal(r.qty, 1);
  const rf = evalEntry(rm, { a: { equity: 500, cash: 500 }, e: { fractionalShares: true, fractional: true }, q: { bid: 89.95, ask: 90, askSize: 100, bidSize: 100 }, p: { stopLoss: 88.5, takeProfit: 94, snapshotPrice: 89.97 } });
  assert.ok(rf.qty > 1 && rf.qty < 1.4);
  const tiny = evalEntry(rm, { a: { equity: 50, cash: 50 }, p: {} });
  assert.equal(tiny.approved, false);
  assert.ok(failed(tiny, 'position_size'));
});

test('rejects poor reward:risk, wide spread, tight stops, invalid levels', () => {
  const rm = new RiskManager(LIMITS);
  assert.ok(failed(evalEntry(rm, { p: { takeProfit: 101 } }), 'reward_to_risk'));
  assert.ok(failed(evalEntry(rm, { q: { bid: 99, ask: 100.02, bidSize: 1, askSize: 1 }, p: { snapshotPrice: 99.5 } }), 'max_spread'));
  assert.ok(failed(evalEntry(rm, { p: { stopLoss: 99.99, takeProfit: 100.2 } }), 'stop_distance'));
  assert.ok(failed(evalEntry(rm, { p: { stopLoss: 101 } }), 'order_levels'));
});

test('rejects on stale / disconnected / delayed data, halts, closed market', () => {
  const rm = new RiskManager(LIMITS);
  assert.ok(failed(evalEntry(rm, { m: { stale: true, staleReasons: ['Quote not updated for 30s'] } }), 'data_fresh'));
  assert.ok(failed(evalEntry(rm, { m: { connected: false } }), 'feed_connected'));
  assert.ok(failed(evalEntry(rm, { m: { realtime: false, feedLabel: 'DELAYED — 15 MINUTES' } }), 'feed_realtime'));
  assert.ok(failed(evalEntry(rm, { m: { halted: true } }), 'not_halted'));
  assert.ok(failed(evalEntry(rm, { m: { session: 'CLOSED' } }), 'session_open'));
  assert.ok(failed(evalEntry(rm, { q: { bid: 0, ask: 100 } }), 'valid_quote'));
});

test('stale proposal: too old or price drifted since snapshot', () => {
  const rm = new RiskManager(LIMITS);
  assert.ok(failed(evalEntry(rm, { now: T0 + 121000 }), 'proposal_fresh'));
  assert.ok(failed(evalEntry(rm, { p: { snapshotPrice: 99 } }), 'price_drift'));
});

test('daily loss limit pauses entries for the day; exits stay allowed', () => {
  const rm = new RiskManager(LIMITS);
  rm.onEquity(10000, T0);
  assert.deepEqual(rm.onEquity(9800, T0 + 1000), []);
  const ev = rm.onEquity(9690, T0 + 2000);
  assert.equal(ev[0].type, 'DAILY_LOSS_LIMIT');
  const r = evalEntry(rm, { now: T0 + 3000, p: { createdAt: T0 + 2500 } });
  assert.equal(r.approved, false);
  assert.ok(r.failed.some((f) => /DAILY LOSS LIMIT/.test(f)));
  const ex = rm.evaluateExit({ quote: Q, market: MARKET_OK, positionQty: 5, fraction: 1, exec: EXEC });
  assert.equal(ex.approved, true);
  assert.equal(ex.qty, 5);
  // next trading day clears the lock
  const ev2 = rm.onEquity(9690, T0 + 24 * 3600e3);
  assert.equal(ev2[0].type, 'DAILY_LOCK_CLEARED');
  assert.equal(rm.entryBlocks(T0 + 24 * 3600e3).length, 0);
});

test('max drawdown disables trading until cleared', () => {
  const rm = new RiskManager(LIMITS);
  rm.onEquity(10000, T0);
  rm.onEquity(11000, T0 + 1000);
  const ev = rm.onEquity(9890, T0 + 86400e3 * 3);
  assert.ok(ev.some((e) => e.type === 'MAX_DRAWDOWN'));
  assert.ok(rm.entryBlocks(T0 + 86400e3 * 3)[0].startsWith('TRADING DISABLED'));
  rm.clearDisable();
  assert.equal(rm.entryBlocks(T0 + 86400e3 * 3).length, 0);
});

test('consecutive losses trigger a cooldown', () => {
  const rm = new RiskManager(LIMITS);
  rm.onRoundTripClosed(-5, T0);
  rm.onRoundTripClosed(-5, T0);
  const ev = rm.onRoundTripClosed(-5, T0);
  assert.equal(ev[0].type, 'LOSS_COOLDOWN');
  assert.ok(rm.entryBlocks(T0 + 60000)[0].startsWith('LOSS COOLDOWN'));
  assert.equal(rm.entryBlocks(T0 + LIMITS.lossCooldownMin * 60000 + 1).length, 0);
  rm.onRoundTripClosed(-1, T0); rm.onRoundTripClosed(+3, T0);
  assert.equal(rm.state.consecutiveLosses, 0, 'a win resets the streak');
});

test('stop adjustments may only tighten; IPO mode adds stricter checks', () => {
  const rm = new RiskManager(LIMITS);
  const lower = rm.evaluateAdjust({ current: { stopLoss: 98, takeProfit: 105 }, proposed: { stopLoss: 97 }, quote: Q });
  assert.equal(lower.approved, false);
  const higher = rm.evaluateAdjust({ current: { stopLoss: 98, takeProfit: 105 }, proposed: { stopLoss: 99 }, quote: Q });
  assert.deepEqual(higher.changes, { stopLoss: 99 });
  const ipo = evalEntry(rm, { ipo: { active: true, minutesSinceFirstTrade: 5, atrPct: 6 } });
  assert.ok(failed(ipo, 'ipo_seasoning'));
  assert.ok(failed(ipo, 'ipo_volatility'));
  const ipoOk = evalEntry(rm, { ipo: { active: true, minutesSinceFirstTrade: 60, atrPct: 1 } });
  assert.equal(ipoOk.approved, true);
  assert.equal(ipoOk.qty, 12, 'IPO allocation factor halves the cap');
});
