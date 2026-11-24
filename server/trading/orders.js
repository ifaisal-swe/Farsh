'use strict';
/**
 * Simulated protective orders (stop-loss, take-profit, trailing stop) and resting LIMIT entries.
 * Evaluated deterministically on every real trade/quote update — independent of the AI, and
 * still active while the AI is paused or stopped.
 */
const { newId } = require('../util/misc');

class OrderManager {
  constructor(state = {}) {
    this.protective = state.protective ? JSON.parse(JSON.stringify(state.protective)) : {};
    this.pending = state.pending ? JSON.parse(JSON.stringify(state.pending)) : [];
  }

  setProtection(symbol, { stopLoss, takeProfit, trailingStopPct = null, highWater = null, proposalId = null, entryPrice = null }) {
    this.protective[symbol] = {
      stopLoss, initialStop: stopLoss, takeProfit, trailingStopPct, highWater, proposalId, entryPrice,
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    return this.protective[symbol];
  }

  getProtection(symbol) { return this.protective[symbol] || null; }

  adjustProtection(symbol, changes) {
    const p = this.protective[symbol];
    if (!p) return null;
    if (changes.stopLoss != null && changes.stopLoss >= p.stopLoss) p.stopLoss = changes.stopLoss; // tighten only
    if (changes.takeProfit != null) p.takeProfit = changes.takeProfit;
    if (changes.trailingStopPct != null) p.trailingStopPct = changes.trailingStopPct;
    p.updatedAt = Date.now();
    return p;
  }

  clearProtection(symbol) { delete this.protective[symbol]; }

  effectiveStop(symbol) {
    const p = this.protective[symbol];
    if (!p) return null;
    let stop = p.stopLoss;
    if (p.trailingStopPct > 0 && p.highWater > 0) stop = Math.max(stop, p.highWater * (1 - p.trailingStopPct / 100));
    return stop;
  }

  /**
   * Check protective orders against the latest real market data.
   * Returns at most one trigger: { kind: 'STOP'|'TRAILING_STOP'|'TAKE_PROFIT', level, triggerPrice, triggeredBy }
   */
  evaluate(symbol, { bid, ask, last, lastTs, nearPct = 0 }, positionQty) {
    const p = this.protective[symbol];
    if (!p || !(positionQty > 0)) return null;
    if (last > 0 && (!p.highWater || last > p.highWater)) p.highWater = last;
    const trailStop = p.trailingStopPct > 0 && p.highWater > 0 ? p.highWater * (1 - p.trailingStopPct / 100) : null;
    const stop = Math.max(p.stopLoss || 0, trailStop || 0);
    const kind = trailStop && trailStop > p.stopLoss ? 'TRAILING_STOP' : 'STOP';
    if (stop > 0) {
      if (bid > 0 && bid <= stop) return { kind, level: stop, triggerPrice: bid, triggeredBy: 'bid' };
      if (last > 0 && last <= stop) return { kind, level: stop, triggerPrice: last, triggeredBy: 'trade', lastTs };
    }
    if (p.takeProfit > 0) {
      // a price a hair under the target counts as reached, but never one below what was paid
      const near = p.takeProfit * (1 - (p.nearPct != null ? p.nearPct : nearPct) / 100);
      const goal = p.entryPrice > 0 && near <= p.entryPrice ? p.takeProfit : near;
      if (bid > 0 && bid >= goal) return { kind: 'TAKE_PROFIT', level: goal, triggerPrice: bid, triggeredBy: 'bid' };
      if (last > 0 && last >= goal) return { kind: 'TAKE_PROFIT', level: goal, triggerPrice: last, triggeredBy: 'trade', lastTs };
    }
    return null;
  }

  /** Distance of price to stop/target as % of the entry->level distance (for "approaching" triggers). */
  proximity(symbol, price) {
    const p = this.protective[symbol];
    if (!p || !(price > 0) || !(p.entryPrice > 0)) return null;
    const stop = this.effectiveStop(symbol);
    const out = {};
    if (stop > 0 && p.entryPrice > stop) out.toStopPct = ((price - stop) / (p.entryPrice - stop)) * 100;
    if (p.takeProfit > p.entryPrice) out.toTargetPct = ((p.takeProfit - price) / (p.takeProfit - p.entryPrice)) * 100;
    return out;
  }

  addPending(order) {
    const o = { id: newId('ord'), status: 'PENDING', filledQty: 0, createdAt: Date.now(), ...order };
    this.pending.push(o);
    return o;
  }

  cancelPending(id, reason = 'cancelled') {
    const o = this.pending.find((x) => x.id === id);
    if (o) { o.status = 'CANCELLED'; o.cancelReason = reason; }
    this.pending = this.pending.filter((x) => x.status === 'PENDING');
    return o;
  }

  cancelAll(symbol, reason) {
    const cancelled = this.pending.filter((x) => x.symbol === symbol && x.status === 'PENDING');
    for (const o of cancelled) { o.status = 'CANCELLED'; o.cancelReason = reason; }
    this.pending = this.pending.filter((x) => x.status === 'PENDING');
    return cancelled;
  }

  pendingFor(symbol) { return this.pending.filter((o) => o.symbol === symbol && o.status === 'PENDING'); }

  /** Resting BUY LIMIT entries: fillable when ask <= limit; expired after expiresAt. */
  checkPending(symbol, quote, nowMs) {
    const actions = [];
    for (const o of this.pendingFor(symbol)) {
      if (o.expiresAt && nowMs >= o.expiresAt) actions.push({ order: o, action: 'EXPIRE' });
      else if (quote && quote.ask > 0 && quote.ask <= o.limitPrice) actions.push({ order: o, action: 'FILLABLE' });
    }
    return actions;
  }

  toJSON() { return { protective: this.protective, pending: this.pending }; }
}

module.exports = { OrderManager };
