'use strict';
/**
 * Deterministic risk-validation layer. The AI only PROPOSES; this module decides whether a
 * proposal may become a simulated order, and how large it may be. The AI cannot override it.
 *
 * Hard limits (configurable): risk per trade, daily loss, max drawdown, position allocation,
 * consecutive-loss cooldown, max open positions, spread, slippage, reward:risk, trades per day,
 * data freshness / halts / session, proposal staleness and price drift, IPO mode.
 * The capital target never increases risk.
 */
const { etDateStr } = require('../util/time');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

class RiskManager {
  constructor(limits, state = {}) {
    this.limits = limits;
    this.state = {
      dayKey: null, dayStartEquity: null, peakEquity: null, consecutiveLosses: 0, cooldownUntil: 0,
      tradesToday: 0, disabled: null, dailyLocked: null, ...state,
    };
  }

  setLimits(limits) { this.limits = limits; }

  /** Feed the latest equity. Returns transition events (e.g. a hard limit just triggered). */
  onEquity(equity, nowMs) {
    const L = this.limits;
    const s = this.state;
    const events = [];
    const day = etDateStr(nowMs);
    if (s.dayKey !== day) {
      s.dayKey = day; s.dayStartEquity = equity; s.tradesToday = 0;
      if (s.dailyLocked) events.push({ type: 'DAILY_LOCK_CLEARED', message: 'New trading day: daily loss lock cleared.' });
      s.dailyLocked = null;
    }
    if (!isNum(s.peakEquity) || equity > s.peakEquity) s.peakEquity = equity;
    const dayPnlPct = s.dayStartEquity > 0 ? ((equity - s.dayStartEquity) / s.dayStartEquity) * 100 : 0;
    const ddPct = s.peakEquity > 0 ? ((s.peakEquity - equity) / s.peakEquity) * 100 : 0;
    if (!s.dailyLocked && dayPnlPct <= -L.maxDailyLossPct) {
      s.dailyLocked = { at: nowMs, dayKey: day, reason: `Daily loss ${dayPnlPct.toFixed(2)}% reached the ${L.maxDailyLossPct}% limit` };
      events.push({ type: 'DAILY_LOSS_LIMIT', message: `${s.dailyLocked.reason}. New entries paused until the next trading day.` });
    }
    if (!s.disabled && ddPct >= L.maxDrawdownPct) {
      s.disabled = { at: nowMs, kind: 'DRAWDOWN', reason: `Drawdown ${ddPct.toFixed(2)}% from peak reached the ${L.maxDrawdownPct}% limit` };
      events.push({ type: 'MAX_DRAWDOWN', message: `${s.disabled.reason}. Trading disabled until you reset or raise the limit.` });
    }
    return events;
  }

  onRoundTripClosed(pnl, nowMs) {
    const L = this.limits;
    const s = this.state;
    const events = [];
    if (pnl < 0) {
      s.consecutiveLosses++;
      if (s.consecutiveLosses >= L.maxConsecutiveLosses) {
        s.cooldownUntil = nowMs + L.lossCooldownMin * 60000;
        events.push({ type: 'LOSS_COOLDOWN', message: `${s.consecutiveLosses} consecutive losing trades: entry cooldown for ${L.lossCooldownMin} min.` });
        s.consecutiveLosses = 0;
      }
    } else if (pnl > 0) {
      s.consecutiveLosses = 0;
    }
    return events;
  }

  onEntryFill() { this.state.tradesToday++; }

  /** Clear the drawdown kill-switch (explicit user action only). */
  clearDisable() { this.state.disabled = null; }

  entryBlocks(nowMs) {
    const L = this.limits;
    const s = this.state;
    const blocks = [];
    if (s.disabled) blocks.push(`TRADING DISABLED: ${s.disabled.reason}`);
    if (s.dailyLocked && s.dailyLocked.dayKey === etDateStr(nowMs)) blocks.push(`DAILY LOSS LIMIT: ${s.dailyLocked.reason}`);
    if (s.cooldownUntil > nowMs) blocks.push(`LOSS COOLDOWN until ${new Date(s.cooldownUntil).toISOString()}`);
    if (s.dayKey === etDateStr(nowMs) && s.tradesToday >= L.maxTradesPerDay) blocks.push(`Max ${L.maxTradesPerDay} entries per day reached`);
    return blocks;
  }

  status(equity, nowMs) {
    const s = this.state;
    return {
      tradingAllowed: this.entryBlocks(nowMs).length === 0,
      blocks: this.entryBlocks(nowMs),
      dayStartEquity: s.dayStartEquity,
      dayPnlPct: s.dayStartEquity > 0 ? ((equity - s.dayStartEquity) / s.dayStartEquity) * 100 : 0,
      peakEquity: s.peakEquity,
      drawdownPct: s.peakEquity > 0 ? ((s.peakEquity - equity) / s.peakEquity) * 100 : 0,
      consecutiveLosses: s.consecutiveLosses,
      cooldownUntil: s.cooldownUntil > nowMs ? s.cooldownUntil : null,
      tradesToday: s.tradesToday,
      disabled: s.disabled,
      dailyLocked: s.dailyLocked,
      limits: this.limits,
    };
  }

  /** Expected per-share / fixed transaction costs of a round trip (paper simulation cost model). */
  static costModel(exec, stop, target, entry = null) {
    const e = exec || {};
    const cps = e.commissionPerShare || 0;
    const pct = (px) => (isNum(px) ? px * ((e.commissionPct || 0) / 100) : 0);
    const sellFees = (px) => (isNum(px) ? px * (e.secFeeRate || 0) : 0) + (e.finraTafPerShare || 0);
    return {
      entryPerShare: cps + pct(isNum(entry) ? entry : stop),
      exitAtStopPerShare: cps + pct(stop) + sellFees(stop),
      exitAtTargetPerShare: cps + pct(target) + sellFees(target),
      stopSlipPerShare: isNum(stop) ? stop * ((e.slippageBps || 0) / 1e4) : 0,
      fixed: 2 * (e.commissionPerOrder || 0),
    };
  }

  /**
   * Evaluate an EXISTING position (and the account) against the current limits — used right after the
   * risk profile changes. Nothing is sold automatically: the result explains what exceeds the new limits
   * and how many shares would have to be sold to comply.
   * pos: { qty, avgPrice }, mark: current price, stop: effective protective stop, exec: execution cfg.
   */
  reviewExposure({ equity, pos, mark, stop, exec, nowMs, fractional = false }) {
    const L = this.limits;
    const findings = [];
    const add = (code, ok, params) => findings.push({ code, ok: !!ok, params });
    const blocks = this.entryBlocks(nowMs);
    const st = this.status(equity, nowMs);
    add('daily_loss', st.dayPnlPct > -L.maxDailyLossPct, { dayPnlPct: st.dayPnlPct, limit: L.maxDailyLossPct });
    add('drawdown', st.drawdownPct < L.maxDrawdownPct, { drawdownPct: st.drawdownPct, limit: L.maxDrawdownPct });
    let reduceQty = 0;
    const roundUp = (x) => (fractional ? Math.ceil(x * 10000) / 10000 : Math.ceil(x - 1e-9));
    if (pos && pos.qty > 0 && isNum(mark) && mark > 0 && equity > 0) {
      const value = pos.qty * mark;
      const allocPct = (value / equity) * 100;
      const allocOk = allocPct <= L.maxPositionPct + 1e-9;
      let allocReduce = 0;
      if (!allocOk) allocReduce = roundUp((value - (equity * L.maxPositionPct) / 100) / mark);
      add('allocation', allocOk, { valuePct: allocPct, limit: L.maxPositionPct, value, maxValue: (equity * L.maxPositionPct) / 100, reduceQty: allocReduce });
      let riskReduce = 0;
      if (isNum(stop) && stop > 0 && stop < mark) {
        const c = RiskManager.costModel(exec, stop, null);
        const perShare = mark - stop + c.stopSlipPerShare + c.exitAtStopPerShare;
        const risk = pos.qty * perShare + c.fixed / 2;
        const budget = (equity * L.maxRiskPerTradePct) / 100;
        const ok = risk <= budget + 1e-6;
        if (!ok) riskReduce = Math.min(pos.qty, roundUp((risk - budget) / perShare));
        add('risk_to_stop', ok, { risk, riskPct: (risk / equity) * 100, limit: L.maxRiskPerTradePct, budget, reduceQty: riskReduce });
        if (isNum(L.maxStopDistancePct)) {
          const distPct = ((mark - stop) / mark) * 100;
          add('stop_distance', distPct <= L.maxStopDistancePct + 1e-9, { distPct, limit: L.maxStopDistancePct, suggestedStop: mark * (1 - L.maxStopDistancePct / 100) });
        }
      } else {
        add('risk_to_stop', false, { noStop: true });
      }
      reduceQty = Math.min(pos.qty, Math.max(allocReduce, riskReduce));
    }
    add('open_positions', true, { open: pos && pos.qty > 0 ? 1 : 0, limit: L.maxOpenPositions });
    return {
      compliant: findings.every((f) => f.ok), findings, reduceQty, entryBlocks: blocks,
      note: 'No position is closed automatically because the risk profile changed. Stricter limits apply immediately to new trades; protective stops stay active.',
    };
  }

  /** Common market/data checks used for every order (entries AND exits). */
  static marketChecks(market, quote, extendedHoursEnabled) {
    const checks = [];
    const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
    add('feed_realtime', market.realtime, market.realtime ? `${market.feedLabel}` : `Feed is not real-time (${market.feedLabel}) — simulated execution disabled`);
    add('feed_connected', market.connected, market.connected ? 'Stream connected' : 'Market data stream disconnected');
    add('data_fresh', !market.stale, market.stale ? `Stale data: ${(market.staleReasons || []).join('; ')}` : `Quote age ${Math.round(market.quoteAgeMs)} ms`);
    add('not_halted', !market.halted, market.halted ? `Trading halted: ${market.haltReason || 'status halt'}` : 'No halt reported');
    const sessOk = market.session === 'REGULAR' || (extendedHoursEnabled && (market.session === 'PRE' || market.session === 'POST'));
    add('session_open', sessOk, `Session ${market.session}${!sessOk ? ' — simulated orders only during ' + (extendedHoursEnabled ? 'pre/regular/post' : 'regular') + ' hours' : ''}`);
    const qOk = quote && quote.bid > 0 && quote.ask > 0 && quote.ask >= quote.bid;
    add('valid_quote', qOk, qOk ? `bid ${quote.bid} / ask ${quote.ask}` : 'No valid two-sided quote');
    return checks;
  }

  /**
   * Validate and size a BUY (new position or add-on).
   * ctx: { proposal, quote, market, account, ipo, exec, ai, nowMs }
   *  proposal: { stopLoss, takeProfit, positionSizePct, orderType, limitPrice, snapshotPrice, createdAt }
   *  account: { equity, cash, positionQty, positionMark, openPositions }
   */
  evaluateEntry(ctx) {
    const L = this.limits;
    const { proposal: p, quote, market, account, ipo = {}, exec, ai, nowMs } = ctx;
    const checks = RiskManager.marketChecks(market, quote, exec.extendedHours);
    const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
    if (ctx.sharia) add('sharia', ctx.sharia.pass, ctx.sharia.detail);
    if (ctx.lab) add('analysis', ctx.lab.pass, ctx.lab.detail);
    for (const b of this.entryBlocks(nowMs)) add('account_limits', false, b);
    if (!this.entryBlocks(nowMs).length) add('account_limits', true, 'No daily-loss / drawdown / cooldown block');
    if (market.session !== 'REGULAR' && p.orderType !== 'LIMIT') add('extended_hours_limit_only', false, 'Outside regular hours only LIMIT orders are simulated');

    const qOk = quote && quote.bid > 0 && quote.ask > 0;
    const mid = qOk ? (quote.bid + quote.ask) / 2 : null;
    const spreadPct = qOk ? ((quote.ask - quote.bid) / mid) * 100 : null;
    const maxSpread = ipo.active ? Math.min(L.maxSpreadPct, L.ipoMode.maxSpreadPct) : L.maxSpreadPct;
    add('max_spread', qOk && spreadPct <= maxSpread, qOk ? `Spread ${spreadPct.toFixed(3)}% (limit ${maxSpread}%)` : 'n/a');
    if (qOk && (quote.askSize === 0)) add('displayed_liquidity', false, 'Ask size is zero');

    // Proposal freshness (the decision must reference a recent snapshot of a similar market).
    // (Skipped when a previously validated resting LIMIT order becomes fillable.)
    const ageSec = (nowMs - p.createdAt) / 1000;
    if (!ctx.skipFreshness) add('proposal_fresh', ageSec <= ai.proposalMaxAgeSec, `Proposal age ${ageSec.toFixed(1)}s (limit ${ai.proposalMaxAgeSec}s)`);
    if (!ctx.skipFreshness && qOk && isNum(p.snapshotPrice)) {
      const drift = (Math.abs(mid - p.snapshotPrice) / p.snapshotPrice) * 100;
      add('price_drift', drift <= ai.maxPriceDriftPct, `Price moved ${drift.toFixed(3)}% since snapshot (limit ${ai.maxPriceDriftPct}%)`);
    }

    // Order levels
    const isLimit = p.orderType === 'LIMIT';
    const fillEst = !qOk ? null : isLimit ? Math.min(p.limitPrice, quote.ask) : quote.ask * (1 + (exec.slippageBps || 0) / 1e4);
    const stop = p.stopLoss;
    const target = p.takeProfit;
    const levelsOk = isNum(stop) && isNum(target) && isNum(fillEst) && stop > 0 && stop < fillEst && target > fillEst;
    add('order_levels', levelsOk, levelsOk ? `stop ${stop} < est. fill ${fillEst.toFixed(4)} < target ${target}` : `Invalid levels: stop=${stop}, est. fill=${fillEst}, target=${target}`);
    if (isLimit) {
      const limOk = isNum(p.limitPrice) && p.limitPrice > 0 && qOk && p.limitPrice <= quote.ask * (1 + L.maxSlippagePct / 100);
      add('limit_price', limOk, limOk ? `limit ${p.limitPrice}` : `Limit ${p.limitPrice} invalid or above ask+max slippage`);
    }
    let rr = null;
    // Expected transaction costs per share: entry commission, exit commission + SEC fee + FINRA TAF (sells),
    // and the market-order slippage expected on a stop exit. Fixed per-order commissions are charged twice.
    const costs = RiskManager.costModel(exec, stop, target, fillEst);
    if (levelsOk) {
      const riskPs = fillEst - stop;
      const costRiskPs = riskPs + costs.entryPerShare + costs.exitAtStopPerShare + costs.stopSlipPerShare;
      rr = (target - fillEst - costs.entryPerShare - costs.exitAtTargetPerShare) / costRiskPs;
      add('reward_to_risk', rr >= L.minRewardRisk, `R:R ${rr.toFixed(2)} after estimated costs (min ${L.minRewardRisk})`);
      const distPct = (riskPs / fillEst) * 100;
      const spreadAbs = quote.ask - quote.bid;
      const distOk = distPct >= L.minStopDistancePct && riskPs >= L.minStopDistanceSpreads * spreadAbs;
      add('stop_distance', distOk, `Stop distance ${distPct.toFixed(3)}% / ${(spreadAbs > 0 ? riskPs / spreadAbs : Infinity).toFixed(1)} spreads (min ${L.minStopDistancePct}% and ${L.minStopDistanceSpreads} spreads)`);
      if (isNum(L.maxStopDistancePct)) add('stop_distance_max', distPct <= L.maxStopDistancePct, `Stop ${distPct.toFixed(2)}% below the entry (profile maximum ${L.maxStopDistancePct}%)`);
    }
    const hasPos = account.positionQty > 0;
    add('max_open_positions', hasPos || account.openPositions < L.maxOpenPositions, `${account.openPositions} open (limit ${L.maxOpenPositions})`);

    if (ipo.active) {
      const minsOk = isNum(ipo.minutesSinceFirstTrade) && ipo.minutesSinceFirstTrade >= L.ipoMode.minMinutesAfterFirstTrade;
      add('ipo_seasoning', minsOk, `IPO mode: ${isNum(ipo.minutesSinceFirstTrade) ? ipo.minutesSinceFirstTrade.toFixed(0) : 'unknown'} min since first observed trade (min ${L.ipoMode.minMinutesAfterFirstTrade})`);
      const atrOk = isNum(ipo.atrPct) && ipo.atrPct <= L.ipoMode.maxAtrPct;
      add('ipo_volatility', atrOk, `IPO mode: ATR ${isNum(ipo.atrPct) ? ipo.atrPct.toFixed(2) + '%' : 'unavailable'} of price (max ${L.ipoMode.maxAtrPct}%)`);
    }

    // Position sizing (deterministic; the smallest constraint wins)
    let qty = 0;
    const sizing = {};
    if (levelsOk) {
      const perShareRisk = fillEst - stop + costs.stopSlipPerShare + costs.entryPerShare + costs.exitAtStopPerShare;
      const riskBudget = account.equity * (L.maxRiskPerTradePct / 100);
      const existingRisk = hasPos ? account.positionQty * Math.max(0, account.positionMark - stop) : 0;
      const allocFactor = ipo.active ? L.ipoMode.allocationFactor : 1;
      const allocCap = account.equity * (L.maxPositionPct / 100) * allocFactor;
      const existingValue = hasPos ? account.positionQty * account.positionMark : 0;
      const feeBuffer = (exec.commissionPerOrder || 0) + 0.05;
      sizing.riskBudget = riskBudget;
      sizing.perShareRisk = perShareRisk;
      sizing.fixedCosts = costs.fixed;
      sizing.byRisk = Math.max(0, (riskBudget - existingRisk - costs.fixed) / perShareRisk);
      sizing.byAllocation = Math.max(0, (allocCap - existingValue) / fillEst);
      sizing.byCash = Math.max(0, (account.cash * 0.995 - feeBuffer) / (fillEst * (1 + (exec.commissionPerShare || 0) / fillEst + (exec.commissionPct || 0) / 100)));
      sizing.byProposal = isNum(p.positionSizePct) && p.positionSizePct > 0 ? (account.equity * p.positionSizePct / 100) / fillEst : Infinity;
      sizing.allocationCap = allocCap;
      let q = Math.min(sizing.byRisk, sizing.byAllocation, sizing.byCash, sizing.byProposal);
      q = (exec.fractionalShares || exec.fractional) ? Math.floor(q * 10000) / 10000 : Math.floor(q + 1e-9);
      sizing.limitingFactor = ['byRisk', 'byAllocation', 'byCash', 'byProposal'].reduce((a, k) => (sizing[k] < sizing[a] ? k : a), 'byRisk');
      qty = q;
      const minQty = (exec.fractionalShares || exec.fractional) ? 0.0001 : 1;
      add('position_size', qty >= minQty, qty >= minQty
        ? `${qty} sh (limit: ${sizing.limitingFactor}; risk budget $${riskBudget.toFixed(2)}, ${(perShareRisk).toFixed(4)}/sh risk, alloc cap $${allocCap.toFixed(2)})`
        : `Size rounds to ${qty} sh: risk budget $${riskBudget.toFixed(2)} / $${perShareRisk.toFixed(3)} per share, allocation cap $${allocCap.toFixed(2)}, cash $${account.cash.toFixed(2)}${(exec.fractionalShares || exec.fractional) ? '' : ' (fractional shares disabled)'}`);
      if (qty >= minQty) {
        // Actual capital at risk if the stop is hit: price distance + expected slippage + all fees.
        sizing.riskAtStop = qty * perShareRisk + costs.fixed + existingRisk;
        sizing.riskPctOfEquity = (sizing.riskAtStop / account.equity) * 100;
        add('risk_per_trade', sizing.riskAtStop <= riskBudget + 1e-6,
          `Risk at stop $${sizing.riskAtStop.toFixed(2)} = ${sizing.riskPctOfEquity.toFixed(3)}% of equity incl. estimated costs (limit ${L.maxRiskPerTradePct}% = $${riskBudget.toFixed(2)})`);
        const valueAfter = existingValue + qty * fillEst;
        add('max_allocation', valueAfter <= allocCap + 1e-6,
          `Position value after entry $${valueAfter.toFixed(2)} = ${((valueAfter / account.equity) * 100).toFixed(2)}% of equity (limit ${(L.maxPositionPct * allocFactor).toFixed(2)}%)`);
      }
    }
    const failed = checks.filter((c) => !c.pass);
    return {
      approved: failed.length === 0, qty: failed.length ? 0 : qty, checks, failed: failed.map((c) => `${c.name}: ${c.detail}`),
      sizing, rr, fillEstimate: fillEst, spreadPct,
      resized: failed.length === 0 && isNum(sizing.byProposal) && sizing.byProposal !== Infinity && qty < Math.floor(sizing.byProposal),
    };
  }

  /** SELL / REDUCE / EXIT validation. Exits are never blocked by loss limits — only by data/market state. */
  evaluateExit({ quote, market, positionQty, fraction = 1, exec }) {
    const checks = RiskManager.marketChecks(market, quote, exec.extendedHours);
    const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
    add('has_position', positionQty > 0, positionQty > 0 ? `${positionQty} sh held` : 'No position to sell (short selling disabled)');
    const f = Math.min(1, Math.max(0, fraction));
    let qty = positionQty * f;
    qty = (exec.fractionalShares || exec.fractional) ? Math.floor(qty * 10000) / 10000 : Math.floor(qty + 1e-9);
    if (f >= 0.999) qty = positionQty;
    if (qty <= 0 && positionQty > 0) qty = Math.min(positionQty, (exec.fractionalShares || exec.fractional) ? positionQty : 1);
    add('exit_quantity', qty > 0, `${qty} sh (${(f * 100).toFixed(0)}% of position)`);
    const failed = checks.filter((c) => !c.pass);
    return { approved: failed.length === 0, qty, checks, failed: failed.map((c) => `${c.name}: ${c.detail}`) };
  }

  /** Protective-order adjustments: stops may only be tightened (raised) on a long position. */
  evaluateAdjust({ current, proposed, quote }) {
    const checks = [];
    const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
    const changes = {};
    if (isNum(proposed.stopLoss)) {
      const ok = proposed.stopLoss >= (current.stopLoss || 0) && quote && proposed.stopLoss < quote.bid;
      add('stop_tighten_only', ok, ok ? `Stop ${current.stopLoss} -> ${proposed.stopLoss}` : `Rejected stop ${proposed.stopLoss}: must be >= current ${current.stopLoss} and below bid ${quote && quote.bid}`);
      if (ok && proposed.stopLoss !== current.stopLoss) changes.stopLoss = proposed.stopLoss;
    }
    if (isNum(proposed.takeProfit)) {
      const ok = quote && proposed.takeProfit > quote.ask;
      add('target_above_market', ok, ok ? `Target ${current.takeProfit} -> ${proposed.takeProfit}` : `Rejected target ${proposed.takeProfit}: must be above ask`);
      if (ok && proposed.takeProfit !== current.takeProfit) changes.takeProfit = proposed.takeProfit;
    }
    if (isNum(proposed.trailingStopPct)) {
      const ok = proposed.trailingStopPct >= 0.1 && proposed.trailingStopPct <= 20;
      add('trailing_range', ok, ok ? `Trailing stop ${proposed.trailingStopPct}%` : 'Trailing stop must be 0.1–20%');
      if (ok) changes.trailingStopPct = proposed.trailingStopPct;
    }
    return { approved: Object.keys(changes).length > 0, changes, checks };
  }

  toJSON() { return this.state; }
}

module.exports = { RiskManager };
