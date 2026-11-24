'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Portfolio } = require('../server/trading/portfolio');
const { simulateOrder, computeFees } = require('../server/trading/execution');
const { OrderManager } = require('../server/trading/orders');
const { computeMetrics, maxDrawdown } = require('../server/trading/metrics');
const { approx } = require('./helpers/fixtures');

const EXEC = { slippageBps: 2, impactPerTierBps: 5, defaultTierSize: 100, requireQuoteSize: false, commissionPerShare: 0, commissionPerOrder: 0, secFeeRate: 0.0000278, finraTafPerShare: 0.000166, finraTafMax: 8.3 };

// ---------------------------------------------------------------- portfolio accounting
test('portfolio: equity - initial == realized + unrealized through buys, partial sell, full exit', () => {
  const p = new Portfolio({ initialCapital: 1000 });
  p.applyFill({ symbol: 'X', side: 'BUY', qty: 4, price: 50, fees: 1 });
  p.applyFill({ symbol: 'X', side: 'BUY', qty: 6, price: 55, fees: 1 });
  approx(p.position('X').avgPrice, 53);
  approx(p.cash, 1000 - 200 - 330 - 2);
  const check = (mark) => {
    const v = p.valuation({ X: mark });
    approx(v.equity - 1000, v.realizedPnl + v.unrealizedPnl, 1e-6);
    return v;
  };
  check(54);
  const r = p.applyFill({ symbol: 'X', side: 'SELL', qty: 5, price: 60, fees: 0.5 });
  // realized = 5*(60-53) - 0.5 - 2*(5/10)
  approx(r.realized, 35 - 0.5 - 1);
  check(58);
  const r2 = p.applyFill({ symbol: 'X', side: 'SELL', qty: 5, price: 52, fees: 0.5 });
  approx(r2.realized, 5 * (52 - 53) - 0.5 - 1);
  assert.equal(p.position('X'), null);
  const v = check(1);
  approx(v.equity, 1000 + 33.5 - 6.5);
  assert.equal(p.roundTrips.length, 1);
  approx(p.roundTrips[0].pnl, 27);
  approx(p.feesPaid, 3);
});

test('portfolio: long-only cash account — no shorting, no margin', () => {
  const p = new Portfolio({ initialCapital: 100 });
  assert.throws(() => p.applyFill({ symbol: 'X', side: 'SELL', qty: 1, price: 10 }), /short selling disabled/);
  assert.throws(() => p.applyFill({ symbol: 'X', side: 'BUY', qty: 11, price: 10 }), /insufficient cash/);
  p.applyFill({ symbol: 'X', side: 'BUY', qty: 5, price: 10 });
  assert.throws(() => p.applyFill({ symbol: 'X', side: 'SELL', qty: 6, price: 10 }), /cannot sell/);
  assert.throws(() => p.applyFill({ symbol: 'X', side: 'BUY', qty: -1, price: 10 }), /invalid quantity/);
  assert.throws(() => p.applyFill({ symbol: 'X', side: 'BUY', qty: 1, price: NaN }), /invalid price/);
});

test('portfolio: serialization round trip preserves state', () => {
  const p = new Portfolio({ initialCapital: 500 });
  p.applyFill({ symbol: 'ANT', side: 'BUY', qty: 2, price: 90.12, fees: 0 });
  const q = Portfolio.fromJSON(JSON.parse(JSON.stringify(p.toJSON())));
  assert.deepEqual(q.valuation({ ANT: 91 }), p.valuation({ ANT: 91 }));
});

// ---------------------------------------------------------------- execution simulator
test('execution: market buy lifts the ask (+slippage), market sell hits the bid', () => {
  const q = { bid: 99.98, ask: 100.02, bidSize: 500, askSize: 500 };
  const b = simulateOrder({ side: 'BUY', qty: 10, type: 'MARKET', quote: q, cfg: EXEC, maxSlippagePct: 0.3 });
  assert.equal(b.status, 'FILLED');
  approx(b.avgPrice, 100.02 * 1.0002, 1e-9);
  assert.ok(b.avgPrice > q.ask, 'never fills at or below the ask / last price');
  const s = simulateOrder({ side: 'SELL', qty: 10, type: 'MARKET', quote: q, cfg: EXEC, maxSlippagePct: 0.3 });
  approx(s.avgPrice, 99.98 * 0.9998, 1e-9);
  assert.ok(s.fees.total > 0, 'regulatory fees on sells');
});

test('execution: partial fill when size exceeds liquidity within max slippage', () => {
  const q = { bid: 49.99, ask: 50, bidSize: 100, askSize: 100 };
  // tiers of 100 sh; each further tier +5 bps; max slippage 0.12% => tiers at +2bps, +7bps, +12bps allowed
  const r = simulateOrder({ side: 'BUY', qty: 1000, type: 'MARKET', quote: q, cfg: EXEC, maxSlippagePct: 0.12 });
  assert.equal(r.status, 'PARTIAL');
  assert.equal(r.filledQty, 300);
  approx(r.remainingQty, 700);
  assert.ok(r.avgPrice > 50 && r.avgPrice <= 50 * 1.0012 + 1e-9);
});

test('execution: limit orders do not fill when not marketable; rejections on bad quotes', () => {
  const q = { bid: 10, ask: 10.05, bidSize: 100, askSize: 100 };
  assert.equal(simulateOrder({ side: 'BUY', qty: 1, type: 'LIMIT', limitPrice: 10.0, quote: q, cfg: EXEC }).status, 'UNFILLED');
  const lim = simulateOrder({ side: 'BUY', qty: 1, type: 'LIMIT', limitPrice: 10.05, quote: q, cfg: EXEC });
  assert.equal(lim.status, 'FILLED'); approx(lim.avgPrice, 10.05);
  assert.equal(simulateOrder({ side: 'BUY', qty: 1, quote: { bid: 0, ask: 10 }, cfg: EXEC }).status, 'REJECTED');
  assert.equal(simulateOrder({ side: 'BUY', qty: 1, quote: { bid: 10.1, ask: 10 }, cfg: EXEC }).status, 'REJECTED');
  assert.equal(simulateOrder({ side: 'BUY', qty: 1, quote: null, cfg: EXEC }).status, 'REJECTED');
  const strict = simulateOrder({ side: 'BUY', qty: 1, quote: { bid: 10, ask: 10.01, askSize: 0 }, cfg: { ...EXEC, requireQuoteSize: true } });
  assert.equal(strict.status, 'REJECTED');
  assert.match(strict.reason, /liquidity information/);
});

test('execution: fee model (SEC + FINRA TAF rounded up to the cent, sells only)', () => {
  const f = computeFees('SELL', 100, 50, EXEC);
  approx(f.secFee, 0.14); // 5000 * 0.0000278 = 0.139 -> 0.14
  approx(f.finraTaf, 0.02); // 100 * 0.000166 = 0.0166 -> 0.02
  assert.equal(computeFees('BUY', 100, 50, EXEC).total, 0);
  approx(computeFees('SELL', 1e6, 1, EXEC).finraTaf, 8.3); // capped
});

// ---------------------------------------------------------------- protective orders
test('orders: stop-loss triggers on bid <= stop; take-profit on bid >= target', () => {
  const om = new OrderManager();
  om.setProtection('X', { stopLoss: 95, takeProfit: 110, entryPrice: 100 });
  assert.equal(om.evaluate('X', { bid: 96, ask: 96.1, last: 96 }, 10), null);
  const s = om.evaluate('X', { bid: 94.9, ask: 95, last: 95.2 }, 10);
  assert.equal(s.kind, 'STOP');
  const t = om.evaluate('X', { bid: 110.01, ask: 110.05, last: 110 }, 10);
  assert.equal(t.kind, 'TAKE_PROFIT');
  assert.equal(om.evaluate('X', { bid: 50, ask: 51, last: 50 }, 0), null, 'no position -> no trigger');
});

test('orders: trailing stop ratchets up with new highs, stops only tighten', () => {
  const om = new OrderManager();
  om.setProtection('X', { stopLoss: 95, takeProfit: 200, trailingStopPct: 2, highWater: 100, entryPrice: 100 });
  om.evaluate('X', { bid: 109.9, ask: 110, last: 110 }, 1);
  approx(om.effectiveStop('X'), 110 * 0.98);
  const trig = om.evaluate('X', { bid: 107.7, ask: 107.8, last: 107.8 }, 1);
  assert.equal(trig.kind, 'TRAILING_STOP');
  om.adjustProtection('X', { stopLoss: 90 });
  approx(om.getProtection('X').stopLoss, 95, 1e-9);
});

test('orders: resting limit becomes fillable at ask <= limit and expires', () => {
  const om = new OrderManager();
  const o = om.addPending({ symbol: 'X', side: 'BUY', qty: 1, limitPrice: 10, expiresAt: 1000 });
  assert.deepEqual(om.checkPending('X', { ask: 10.2 }, 500), []);
  assert.equal(om.checkPending('X', { ask: 9.99 }, 500)[0].action, 'FILLABLE');
  assert.equal(om.checkPending('X', { ask: 10.2 }, 1001)[0].action, 'EXPIRE');
  om.cancelPending(o.id);
  assert.equal(om.pendingFor('X').length, 0);
});

// ---------------------------------------------------------------- metrics
test('metrics: win rate, profit factor, drawdown are deterministic', () => {
  const valuation = { initialCapital: 1000, equity: 1050, cash: 1050, investedCapital: 0, positionValue: 0, realizedPnl: 50, unrealizedPnl: 0, totalPnl: 50, totalReturnPct: 5, feesPaid: 2 };
  const m = computeMetrics({ valuation, roundTrips: [{ pnl: 40 }, { pnl: -20 }, { pnl: 30 }], fillCount: 6, equityCurve: [{ equity: 1000 }, { equity: 1100 }, { equity: 990 }] });
  approx(m.winRatePct, 200 / 3, 1e-9);
  approx(m.profitFactor, 70 / 20);
  approx(m.averageWin, 35); approx(m.averageLoss, 20);
  approx(m.maxDrawdownPct, 10);
  assert.match(m.sampleWarning, /too few/);
  approx(maxDrawdown([{ equity: 100 }, { equity: 120 }, { equity: 90 }, { equity: 130 }]).pct, 25);
});
