'use strict';
/**
 * Strict validation of AI output BEFORE it can influence simulated trading.
 * Anything malformed, inconsistent, or referencing the wrong snapshot is rejected.
 */
const ACTIONS = ['BUY', 'SELL', 'HOLD', 'WAIT', 'REDUCE_POSITION', 'EXIT_POSITION', 'NO_TRADE', 'WAITING_FOR_BREAKOUT', 'WAITING_FOR_PULLBACK'];
const STRATEGIES = ['MOMENTUM', 'BREAKOUT', 'SUPPORT_BOUNCE', 'RESISTANCE_REJECTION', 'VWAP', 'TREND_FOLLOWING', 'PULLBACK', 'MEAN_REVERSION', 'NEWS_DRIVEN', 'OPENING_RANGE_BREAKOUT', 'NONE'];
const BIAS = ['BULLISH', 'BEARISH', 'NEUTRAL', 'UNCERTAIN'];
const TRENDS = ['UPTREND', 'DOWNTREND', 'RANGE', 'UNCLEAR'];
const EXIT_ACTIONS = ['SELL', 'REDUCE_POSITION', 'EXIT_POSITION'];

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const norm = (s) => String(s == null ? '' : s).trim().toUpperCase().replace(/[\s-]+/g, '_');
const str = (s, max) => (s == null ? '' : String(s)).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').slice(0, max);
const numOrNull = (x) => {
  if (x == null || x === '') return null;
  const n = typeof x === 'string' ? Number(x.replace(/[$,%\s]/g, '')) : x;
  return isNum(n) ? n : NaN;
};

function extractJson(text) {
  if (text == null) throw new Error('Empty AI response');
  let t = String(text).trim();
  if (!t) throw new Error('Empty AI response (DeepSeek returns blank content when it cannot produce valid JSON)');
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('No JSON object found in AI response');
  return JSON.parse(t.slice(a, b + 1));
}

/**
 * @param {string|object} raw  model output
 * @param {object} ctx { snapshotId, symbol, price, hasPosition }
 * @returns {{ok:boolean, proposal?:object, errors:string[], warnings:string[]}}
 */
function validateProposal(raw, ctx) {
  const errors = [];
  const warnings = [];
  let o;
  try { o = typeof raw === 'string' ? extractJson(raw) : raw; } catch (e) { return { ok: false, errors: [`JSON parse failed: ${e.message}`], warnings }; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: ['AI output is not a JSON object'], warnings };

  if (o.snapshot_id !== ctx.snapshotId) errors.push(`snapshot_id "${str(o.snapshot_id, 60)}" does not match the analysed snapshot ${ctx.snapshotId}`);
  const action = norm(o.action);
  if (!ACTIONS.includes(action)) errors.push(`Unknown action "${str(o.action, 40)}"`);
  let strategy = norm(o.strategy || 'NONE');
  if (!STRATEGIES.includes(strategy)) { warnings.push(`Unknown strategy "${str(o.strategy, 40)}" -> NONE`); strategy = 'NONE'; }
  let bias = norm(o.directional_bias || 'UNCERTAIN');
  if (!BIAS.includes(bias)) { warnings.push(`Unknown bias "${str(o.directional_bias, 30)}" -> UNCERTAIN`); bias = 'UNCERTAIN'; }
  let sentiment = norm(o.sentiment || bias);
  if (!BIAS.includes(sentiment)) sentiment = 'UNCERTAIN';
  let trend = norm(o.trend || 'UNCLEAR');
  if (!TRENDS.includes(trend)) trend = 'UNCLEAR';

  let confidence = numOrNull(o.confidence);
  if (!isNum(confidence)) { errors.push('confidence must be a number 0-100'); confidence = 0; }
  else if (confidence > 0 && confidence <= 1) { warnings.push('confidence given as a fraction; scaled to 0-100'); confidence *= 100; }
  if (confidence < 0 || confidence > 100) errors.push('confidence must be within 0-100');

  const fields = {};
  for (const k of ['entry_price', 'stop_loss', 'take_profit', 'trailing_stop_pct', 'position_size_pct_of_equity', 'reduce_fraction', 'reward_to_risk', 'watch_level']) {
    const v = numOrNull(o[k]);
    if (Number.isNaN(v)) { errors.push(`${k} must be a number or null`); fields[k] = null; } else fields[k] = v;
  }
  const order = o.order && typeof o.order === 'object' ? o.order : {};
  let orderType = norm(order.type || 'MARKET');
  if (!['MARKET', 'LIMIT'].includes(orderType)) { warnings.push(`Unknown order type "${str(order.type, 20)}" -> MARKET`); orderType = 'MARKET'; }
  const limitPrice = numOrNull(order.limit_price);
  if (Number.isNaN(limitPrice)) errors.push('order.limit_price must be a number or null');

  const px = ctx.price;
  const near = (v) => isNum(v) && isNum(px) && px > 0 && Math.abs(v - px) / px <= 0.25;
  const isLimitWait = action === 'WAITING_FOR_PULLBACK' && orderType === 'LIMIT' && isNum(limitPrice);
  if (action === 'BUY' || isLimitWait) {
    const entry = isLimitWait ? limitPrice : fields.entry_price;
    if (!isNum(entry) || entry <= 0) errors.push('BUY requires a positive entry_price');
    if (!isNum(fields.stop_loss) || fields.stop_loss <= 0) errors.push('BUY requires a positive stop_loss');
    if (!isNum(fields.take_profit) || fields.take_profit <= 0) errors.push('BUY requires a positive take_profit');
    if (isNum(entry) && isNum(fields.stop_loss) && isNum(fields.take_profit) && !(fields.stop_loss < entry && entry < fields.take_profit)) {
      errors.push(`BUY levels must satisfy stop_loss < entry < take_profit (got ${fields.stop_loss} / ${entry} / ${fields.take_profit})`);
    }
    if (isNum(entry) && isNum(px) && !near(entry)) errors.push(`entry ${entry} is more than 25% away from the current price ${px} — rejected as implausible`);
    if (orderType === 'LIMIT' && !isNum(limitPrice)) errors.push('LIMIT order requires order.limit_price');
    if (fields.position_size_pct_of_equity != null && !(fields.position_size_pct_of_equity > 0 && fields.position_size_pct_of_equity <= 100)) errors.push('position_size_pct_of_equity must be within (0, 100]');
  }
  if (action === 'REDUCE_POSITION') {
    if (!(fields.reduce_fraction > 0 && fields.reduce_fraction <= 1)) errors.push('REDUCE_POSITION requires reduce_fraction within (0, 1]');
  }
  if (EXIT_ACTIONS.includes(action) && !ctx.hasPosition) warnings.push(`${action} proposed but no position is held — will be treated as no-op`);
  if (fields.trailing_stop_pct != null && !(fields.trailing_stop_pct > 0 && fields.trailing_stop_pct <= 20)) errors.push('trailing_stop_pct must be within (0, 20]');

  const levelsIn = o.key_levels && typeof o.key_levels === 'object' ? o.key_levels : {};
  const nums = (arr) => (Array.isArray(arr) ? arr.map(numOrNull).filter(isNum).slice(0, 6) : []);
  const evidence = Array.isArray(o.evidence) ? o.evidence.slice(0, 12).map((e) => str(e, 300)).filter(Boolean) : [];
  if (!evidence.length) warnings.push('No supporting evidence listed');
  const newsAssessment = Array.isArray(o.news_assessment) ? o.news_assessment.slice(0, 20).map((n) => ({
    newsId: str(n && n.news_id, 80), impact: BIAS.includes(norm(n && n.impact)) ? norm(n.impact) : 'UNCERTAIN', note: str(n && n.note, 300),
  })).filter((n) => n.newsId) : [];
  const er = o.expected_range && typeof o.expected_range === 'object' ? o.expected_range : {};
  // Optional explanation fields (absent in older responses — never required for validity).
  const dc = o.decision_change && typeof o.decision_change === 'object' ? o.decision_change : null;
  const decisionChange = dc ? {
    previousAction: ACTIONS.includes(norm(dc.previous_action)) ? norm(dc.previous_action) : null,
    changed: dc.changed === true || dc.changed === 'true',
    reason: str(dc.reason, 600),
  } : null;
  const ce = o.chart_explanation && typeof o.chart_explanation === 'object' ? o.chart_explanation : null;
  const chartExplanation = ce ? Object.fromEntries(['trend', 'swings', 'levels', 'candles', 'volume', 'entry_conditions', 'exit_conditions']
    .map((k) => [k.replace(/_([a-z])/g, (m, c) => c.toUpperCase()), str(ce[k], 700)])) : null;

  const proposal = {
    snapshotId: ctx.snapshotId, symbol: ctx.symbol, action, strategy, directionalBias: bias, sentiment, trend, confidence: Math.round(confidence),
    marketCondition: str(o.market_condition, 600), uncertainty: str(o.uncertainty, 500),
    orderType: isLimitWait ? 'LIMIT' : orderType, limitPrice: isNum(limitPrice) ? limitPrice : null,
    entryPrice: isLimitWait ? limitPrice : fields.entry_price, stopLoss: fields.stop_loss, takeProfit: fields.take_profit,
    trailingStopPct: fields.trailing_stop_pct, positionSizePct: fields.position_size_pct_of_equity, reduceFraction: fields.reduce_fraction,
    rewardToRiskClaimed: fields.reward_to_risk, watchLevel: fields.watch_level,
    bullCase: str(o.bull_case, 600), bearCase: str(o.bear_case, 600), baseCase: str(o.base_case, 600),
    keyLevels: { support: nums(levelsIn.support), resistance: nums(levelsIn.resistance), breakout: isNum(numOrNull(levelsIn.breakout)) ? numOrNull(levelsIn.breakout) : null, breakdown: isNum(numOrNull(levelsIn.breakdown)) ? numOrNull(levelsIn.breakdown) : null },
    expectedRange: { low: isNum(numOrNull(er.low)) ? numOrNull(er.low) : null, high: isNum(numOrNull(er.high)) ? numOrNull(er.high) : null },
    invalidation: str(o.invalidation, 500), evidence, newsAssessment, nextAction: str(o.next_action, 300), rationale: str(o.rationale, 800),
    isLimitEntry: isLimitWait || (action === 'BUY' && orderType === 'LIMIT'),
    decisionChange, chartExplanation,
  };
  return { ok: errors.length === 0, proposal, errors, warnings };
}

/** Key used to detect duplicate proposals (same action and same levels, rounded). */
function proposalKey(p) {
  const r = (x) => (isNum(x) ? x.toFixed(2) : '-');
  return [p.symbol, p.action, r(p.entryPrice), r(p.stopLoss), r(p.takeProfit), r(p.limitPrice), r(p.reduceFraction)].join('|');
}

module.exports = { validateProposal, extractJson, proposalKey, ACTIONS, STRATEGIES, EXIT_ACTIONS };
