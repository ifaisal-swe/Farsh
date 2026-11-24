'use strict';
/** Deterministic performance statistics. */

function maxDrawdown(points) {
  let peak = -Infinity;
  let maxDd = 0;
  let maxDdAbs = 0;
  for (const p of points) {
    const e = p.equity;
    if (!Number.isFinite(e)) continue;
    if (e > peak) peak = e;
    if (peak > 0) {
      const dd = (peak - e) / peak;
      if (dd > maxDd) { maxDd = dd; maxDdAbs = peak - e; }
    }
  }
  return { pct: maxDd * 100, abs: maxDdAbs };
}

/**
 * @param {object} o
 * @param {object} o.valuation   Portfolio.valuation()
 * @param {Array}  o.roundTrips  closed round trips (flat -> long -> flat), pnl net of all fees
 * @param {number} o.fillCount
 * @param {Array}  o.equityCurve [{ts, equity}]
 */
function computeMetrics({ valuation, roundTrips = [], fillCount = 0, equityCurve = [] }) {
  const wins = roundTrips.filter((t) => t.pnl > 0);
  const losses = roundTrips.filter((t) => t.pnl < 0);
  const grossWin = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = -losses.reduce((s, t) => s + t.pnl, 0);
  const curve = [...equityCurve, { equity: valuation.equity }];
  const dd = maxDrawdown(curve);
  return {
    startingCapital: valuation.initialCapital,
    currentEquity: valuation.equity,
    availableCash: valuation.cash,
    investedCapital: valuation.investedCapital,
    openPositionValue: valuation.positionValue,
    realizedPnl: valuation.realizedPnl,
    unrealizedPnl: valuation.unrealizedPnl,
    totalPnl: valuation.totalPnl,
    totalReturnPct: valuation.totalReturnPct,
    executions: fillCount,
    closedTrades: roundTrips.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRatePct: roundTrips.length ? (wins.length / roundTrips.length) * 100 : null,
    averageWin: wins.length ? grossWin / wins.length : null,
    averageLoss: losses.length ? grossLoss / losses.length : null,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? null : null),
    profitFactorNote: grossLoss > 0 ? null : (grossWin > 0 ? 'no losing trades yet (undefined)' : 'no closed trades'),
    maxDrawdownPct: dd.pct,
    maxDrawdownAbs: dd.abs,
    tradingFees: valuation.feesPaid,
    sampleWarning: roundTrips.length < 30 ? `Only ${roundTrips.length} closed trades — far too few to judge strategy profitability.` : null,
  };
}

/**
 * Buy-and-hold benchmark with the same starting capital, entered at the first valid ask after
 * the session started (same fee model, same fractional-share rule).
 */
function benchmarkEquity(bench, mark) {
  if (!bench || !(bench.shares >= 0) || !(mark > 0)) return null;
  return bench.cashLeft + bench.shares * mark;
}

module.exports = { computeMetrics, maxDrawdown, benchmarkEquity };
