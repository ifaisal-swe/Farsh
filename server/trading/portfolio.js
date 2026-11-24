'use strict';
/**
 * Paper portfolio accounting (long-only, cash account, no leverage/margin/shorting).
 *
 * Invariant (tested): equity - initialCapital === realizedPnl + unrealizedPnl
 *   - avgPrice is the volume-weighted fill price (fees excluded, shown as "average entry price")
 *   - buy fees are carried with the position and allocated pro-rata when shares are sold
 *   - realized P&L of a sale = qty*(sellPrice-avgPrice) - sellFees - allocatedBuyFees
 */
const EPS = 1e-9;
const r8 = (x) => Math.round(x * 1e8) / 1e8;

class PortfolioError extends Error {}

class Portfolio {
  constructor(state = {}) {
    if (!(state.initialCapital > 0)) throw new PortfolioError('initialCapital must be > 0');
    this.initialCapital = state.initialCapital;
    this.cash = state.cash != null ? state.cash : state.initialCapital;
    this.positions = state.positions ? JSON.parse(JSON.stringify(state.positions)) : {};
    this.realizedPnl = state.realizedPnl || 0;
    this.feesPaid = state.feesPaid || 0;
    this.fillCount = state.fillCount || 0;
    this.roundTrips = state.roundTrips ? [...state.roundTrips] : [];
    this.openRoundTrips = state.openRoundTrips ? JSON.parse(JSON.stringify(state.openRoundTrips)) : {};
  }

  position(symbol) {
    const p = this.positions[symbol];
    return p && p.qty > EPS ? p : null;
  }

  openPositionCount() {
    return Object.values(this.positions).filter((p) => p.qty > EPS).length;
  }

  /** Apply a simulated fill. Throws on anything that would violate a cash/long-only account. */
  applyFill({ symbol, side, qty, price, fees = 0, ts = Date.now() }) {
    if (!symbol) throw new PortfolioError('symbol required');
    if (!(qty > 0) || !Number.isFinite(qty)) throw new PortfolioError(`invalid quantity ${qty}`);
    if (!(price > 0) || !Number.isFinite(price)) throw new PortfolioError(`invalid price ${price}`);
    if (!(fees >= 0)) throw new PortfolioError(`invalid fees ${fees}`);
    let realized = 0;
    let closedRoundTrip = null;
    let pos = this.positions[symbol];

    if (side === 'BUY') {
      const cost = qty * price + fees;
      if (cost > this.cash + 1e-6) throw new PortfolioError(`insufficient cash: need ${cost.toFixed(2)}, have ${this.cash.toFixed(2)} (no margin)`);
      if (!pos || pos.qty <= EPS) {
        pos = { qty: 0, avgPrice: 0, buyFees: 0, openedAt: ts };
        this.openRoundTrips[symbol] = { symbol, openedAt: ts, realized: 0, fees: 0, maxCost: 0, buys: 0, sells: 0 };
      }
      const newQty = pos.qty + qty;
      pos.avgPrice = r8((pos.avgPrice * pos.qty + price * qty) / newQty);
      pos.qty = r8(newQty);
      pos.buyFees = r8(pos.buyFees + fees);
      this.positions[symbol] = pos;
      this.cash = r8(this.cash - cost);
      const rt = this.openRoundTrips[symbol];
      rt.fees = r8(rt.fees + fees);
      rt.maxCost = Math.max(rt.maxCost, pos.qty * pos.avgPrice);
      rt.buys++;
    } else if (side === 'SELL') {
      if (!pos || pos.qty <= EPS) throw new PortfolioError(`no ${symbol} position to sell (long-only, short selling disabled)`);
      if (qty > pos.qty + 1e-9) throw new PortfolioError(`cannot sell ${qty} > held ${pos.qty} (short selling disabled)`);
      const sellQty = Math.min(qty, pos.qty);
      const allocBuyFees = pos.qty > 0 ? pos.buyFees * (sellQty / pos.qty) : 0;
      realized = r8(sellQty * (price - pos.avgPrice) - fees - allocBuyFees);
      this.cash = r8(this.cash + sellQty * price - fees);
      pos.buyFees = r8(pos.buyFees - allocBuyFees);
      pos.qty = r8(pos.qty - sellQty);
      this.realizedPnl = r8(this.realizedPnl + realized);
      const rt = this.openRoundTrips[symbol] || { symbol, openedAt: ts, realized: 0, fees: 0, maxCost: 0, buys: 0, sells: 0 };
      rt.realized = r8(rt.realized + realized);
      rt.fees = r8(rt.fees + fees);
      rt.sells++;
      if (pos.qty <= EPS) {
        pos.qty = 0; pos.buyFees = 0;
        closedRoundTrip = { ...rt, closedAt: ts, pnl: rt.realized, returnPct: rt.maxCost > 0 ? (rt.realized / rt.maxCost) * 100 : 0 };
        this.roundTrips.push(closedRoundTrip);
        delete this.openRoundTrips[symbol];
        delete this.positions[symbol];
      } else {
        this.openRoundTrips[symbol] = rt;
      }
    } else {
      throw new PortfolioError(`invalid side ${side}`);
    }
    this.feesPaid = r8(this.feesPaid + fees);
    this.fillCount++;
    return { realized, closedRoundTrip, position: this.position(symbol) ? { ...this.positions[symbol] } : null };
  }

  /** marks: { [symbol]: price } — last valid trade price (or mid when no trade exists). */
  valuation(marks = {}) {
    let positionValue = 0;
    let unrealized = 0;
    let costBasis = 0;
    for (const [sym, p] of Object.entries(this.positions)) {
      if (p.qty <= EPS) continue;
      const m = marks[sym] > 0 ? marks[sym] : p.avgPrice; // no mark: carry at cost (flagged by caller)
      positionValue += p.qty * m;
      costBasis += p.qty * p.avgPrice;
      unrealized += p.qty * (m - p.avgPrice) - p.buyFees;
    }
    const equity = this.cash + positionValue;
    return {
      initialCapital: this.initialCapital,
      cash: this.cash,
      investedCapital: costBasis,
      positionValue,
      equity,
      realizedPnl: this.realizedPnl,
      unrealizedPnl: unrealized,
      totalPnl: equity - this.initialCapital,
      totalReturnPct: ((equity - this.initialCapital) / this.initialCapital) * 100,
      exposurePct: equity > 0 ? (positionValue / equity) * 100 : 0,
      feesPaid: this.feesPaid,
    };
  }

  toJSON() {
    return {
      initialCapital: this.initialCapital, cash: this.cash, positions: this.positions, realizedPnl: this.realizedPnl,
      feesPaid: this.feesPaid, fillCount: this.fillCount, roundTrips: this.roundTrips, openRoundTrips: this.openRoundTrips,
    };
  }

  static fromJSON(obj) { return new Portfolio(obj); }
}

module.exports = { Portfolio, PortfolioError };
