'use strict';
/**
 * Turns a VALIDATED AI proposal into the chart-analysis record the dashboard draws:
 *  - every AI price level is cross-checked against levels the application computed itself (swing zones,
 *    confirmed swings, session levels, VWAP, trading range, trend lines, break levels); levels with no
 *    match are kept but flagged "unverified" so the UI never presents them as app-confirmed facts;
 *  - the proposed entry / stop / target with the app-computed reward:risk;
 *  - the decision change versus the previous analysis (with the AI's stated reason).
 * Nothing here calls the AI; it only reshapes and checks what was already validated.
 */
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const r = (x, d = 4) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);

function candidates(snapshot, internals) {
  const out = [];
  const add = (price, kind, label, zone) => { if (isNum(price)) out.push({ price, kind, label, zoneLow: zone ? zone[0] : null, zoneHigh: zone ? zone[1] : null }); };
  const tech = internals && internals.tech;
  if (tech && tech.available) {
    for (const l of tech.levels.all) add(l.price, 'zone', l.rank || `${l.origin} zone`, [l.zoneLow, l.zoneHigh]);
    for (const p of tech.swings.points.slice(-40)) add(p.price, 'swing', p.type === 'H' ? 'swing high' : 'swing low');
    if (tech.range) { add(tech.range.high, 'range', 'range high'); add(tech.range.low, 'range', 'range low'); }
    for (const t of tech.trendlines) if (t.status === 'active') add(t.priceNow, 'trendline', t.kind === 'SUPPORT_UP' ? 'rising support line' : 'falling resistance line');
  }
  const lv = internals && internals.levels;
  if (lv && lv.breakout) add(lv.breakout.price, 'structure', lv.breakout.label);
  if (lv && lv.breakdown) add(lv.breakdown.price, 'structure', lv.breakdown.label);
  const sl = snapshot.market.sessionLevels || {};
  add(sl.intradayHigh, 'session', 'intraday high'); add(sl.intradayLow, 'session', 'intraday low');
  add(sl.prevSessionHigh, 'session', 'previous session high'); add(sl.prevSessionLow, 'session', 'previous session low');
  add(sl.regularOpen, 'session', 'regular-session open');
  if (sl.openingRange15m) { add(sl.openingRange15m.high, 'session', 'opening range high'); add(sl.openingRange15m.low, 'session', 'opening range low'); }
  const vw = snapshot.market.sessionVwap;
  if (vw && vw.available) add(vw.value, 'vwap', 'session VWAP');
  return out;
}

function buildChartAnalysis({ proposal: p, decisionId, at, tf, snapshot, internals, previous }) {
  const price = snapshot.market.lastPrice;
  const tech = internals && internals.tech;
  const atr = tech && tech.available ? tech.atr : null;
  const tol = Math.max(isNum(atr) ? atr * 0.25 : 0, isNum(price) ? price * 0.0015 : 0);
  const cands = candidates(snapshot, internals);
  const match = (v) => {
    if (!isNum(v)) return null;
    let best = null;
    for (const c of cands) {
      const inZone = isNum(c.zoneLow) && v >= c.zoneLow - tol && v <= c.zoneHigh + tol;
      const d = Math.abs(v - c.price);
      if ((inZone || d <= tol) && (!best || d < best.d)) best = { d, c };
    }
    return best ? { kind: best.c.kind, label: best.c.label, price: r(best.c.price), distancePct: isNum(price) ? r((best.d / price) * 100, 3) : null } : null;
  };
  const levels = [];
  const push = (kind, v, extra = {}) => { if (isNum(v)) { const m = match(v); levels.push({ kind, price: r(v), verified: !!m, match: m, ...extra }); } };
  for (const v of p.keyLevels.support || []) push('support', v);
  for (const v of p.keyLevels.resistance || []) push('resistance', v);
  push('breakout', p.keyLevels.breakout);
  push('breakdown', p.keyLevels.breakdown);
  if (isNum(p.watchLevel)) push('watch', p.watchLevel);
  let plan = null;
  const entry = p.isLimitEntry ? p.limitPrice : p.entryPrice;
  if (isNum(entry) && isNum(p.stopLoss) && isNum(p.takeProfit) && p.stopLoss < entry && p.takeProfit > entry) {
    plan = {
      kind: p.action === 'BUY' ? 'PROPOSED_ENTRY' : p.action === 'WAITING_FOR_PULLBACK' ? 'PROPOSED_LIMIT' : 'CONDITIONAL',
      orderType: p.orderType, entry: r(entry), stop: r(p.stopLoss), target: r(p.takeProfit), trailingStopPct: p.trailingStopPct,
      rewardToRisk: r((p.takeProfit - entry) / (entry - p.stopLoss), 2), stopMatch: match(p.stopLoss), targetMatch: match(p.takeProfit),
    };
  } else if (p.action === 'HOLD' && (isNum(p.stopLoss) || isNum(p.takeProfit))) {
    plan = { kind: 'ADJUST_PROTECTION', stop: r(p.stopLoss), target: r(p.takeProfit), trailingStopPct: p.trailingStopPct };
  }
  const forecast = p.expectedRange && (isNum(p.expectedRange.low) || isNum(p.expectedRange.high)) ? { low: r(p.expectedRange.low), high: r(p.expectedRange.high) } : null;
  let change = null;
  if (previous && previous.proposal) {
    const prevAction = previous.proposal.action;
    const reason = p.decisionChange && p.decisionChange.reason ? p.decisionChange.reason : null;
    change = {
      changed: prevAction !== p.action, from: prevAction, to: p.action, previousAt: previous.ts, previousDecisionId: previous.id,
      previousBias: previous.proposal.directionalBias, reason, aiFlaggedChange: p.decisionChange ? p.decisionChange.changed : null,
    };
  }
  return {
    decisionId, at, tf, symbol: snapshot.symbol, price: r(price), atr: r(atr), tolerance: r(tol),
    action: p.action, bias: p.directionalBias, trend: p.trend, confidence: p.confidence, strategy: p.strategy,
    levels, unverifiedLevels: levels.filter((l) => !l.verified).length, plan, forecast, change,
    explanation: p.chartExplanation || null,
  };
}

module.exports = { buildChartAnalysis };
