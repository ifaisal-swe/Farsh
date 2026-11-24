'use strict';
/**
 * Simulated execution against REAL quotes. Never fills at the last trade price by default:
 *  - buys lift the ask, sells hit the bid
 *  - market orders add configurable base slippage
 *  - liquidity is modelled in tiers of the displayed touch size; each further tier walks the
 *    price by `impactPerTierBps`. Walking stops at the max-slippage cap (market) or limit price.
 *    Unfilled remainder => PARTIAL (market remainder cancelled; limit remainder may rest).
 *  - regulatory/commission fees are configurable
 */
const EPS = 1e-9;
const ceilCents = (x) => Math.ceil(x * 100 - 1e-7) / 100;
const round2 = (x) => Math.round(x * 100) / 100;

function computeFees(side, qty, price, cfg) {
  const commission = (cfg.commissionPerOrder || 0) + (cfg.commissionPerShare || 0) * qty + ((cfg.commissionPct || 0) / 100) * qty * price;
  let secFee = 0;
  let finraTaf = 0;
  if (side === 'SELL') {
    secFee = cfg.secFeeRate > 0 ? ceilCents(qty * price * cfg.secFeeRate) : 0;
    finraTaf = cfg.finraTafPerShare > 0 ? Math.min(ceilCents(qty * cfg.finraTafPerShare), cfg.finraTafMax || Infinity) : 0;
  }
  const total = round2(commission + secFee + finraTaf);
  return { commission: round2(commission), secFee, finraTaf, total };
}

function validQuote(q) {
  return q && q.bid > 0 && q.ask > 0 && q.ask >= q.bid && Number.isFinite(q.bid) && Number.isFinite(q.ask);
}

/**
 * @param {object} o
 * @param {'BUY'|'SELL'} o.side
 * @param {number} o.qty
 * @param {'MARKET'|'LIMIT'} o.type
 * @param {number} [o.limitPrice]
 * @param {{bid,ask,bidSize,askSize}} o.quote
 * @param {object} o.cfg execution config
 * @param {number} o.maxSlippagePct cap for market orders (% from touch)
 */
function simulateOrder({ side, qty, type = 'MARKET', limitPrice = null, quote, cfg, maxSlippagePct = 0.3, sizeUnit = 'shares' }) {
  const base = { side, requestedQty: qty, type, limitPrice, fills: [], filledQty: 0, avgPrice: null, fees: computeFees(side, 0, 0, cfg), liquidityAssumed: false };
  if (!(qty > 0)) return { ...base, status: 'REJECTED', reason: 'Quantity must be positive' };
  if (!validQuote(quote)) return { ...base, status: 'REJECTED', reason: 'No valid two-sided quote (missing, zero or crossed bid/ask)' };
  if (type === 'LIMIT' && !(limitPrice > 0)) return { ...base, status: 'REJECTED', reason: 'Limit order requires a positive limit price' };

  const dir = side === 'BUY' ? 1 : -1;
  const touch = side === 'BUY' ? quote.ask : quote.bid;
  const rawSize = side === 'BUY' ? quote.askSize : quote.bidSize;
  let tier = 0;
  let liquidityAssumed = false;
  if (rawSize > 0) tier = rawSize * (sizeUnit === 'round_lots' ? 100 : 1);
  else if (cfg.requireQuoteSize) return { ...base, status: 'REJECTED', reason: 'Insufficient liquidity information: quote has no displayed size' };
  else { tier = cfg.defaultTierSize || 100; liquidityAssumed = true; }

  const slip = type === 'MARKET' ? (cfg.slippageBps || 0) / 1e4 : 0;
  const impact = (cfg.impactPerTierBps || 0) / 1e4;
  const capPct = maxSlippagePct / 100;
  // Worst acceptable price: the limit for LIMIT orders, the slippage cap for MARKET orders.
  let bound;
  if (type === 'LIMIT') bound = limitPrice;
  else bound = side === 'BUY' ? touch * (1 + capPct) : touch * (1 - capPct);

  const fills = [];
  let remaining = qty;
  for (let t = 0; t < 200 && remaining > EPS; t++) {
    const px = touch * (1 + dir * (slip + t * impact));
    if (side === 'BUY' ? px > bound + 1e-12 : px < bound - 1e-12) break;
    const q = Math.min(remaining, tier);
    fills.push({ qty: q, price: px });
    remaining -= q;
  }
  const filledQty = fills.reduce((s, f) => s + f.qty, 0);
  if (filledQty <= EPS) {
    if (type === 'LIMIT') return { ...base, status: 'UNFILLED', reason: `Not marketable: ${side === 'BUY' ? `ask ${quote.ask} > limit ${limitPrice}` : `bid ${quote.bid} < limit ${limitPrice}`}`, liquidityAssumed };
    return { ...base, status: 'REJECTED', reason: `Fill would exceed max slippage ${maxSlippagePct}%`, liquidityAssumed };
  }
  const avgPrice = fills.reduce((s, f) => s + f.qty * f.price, 0) / filledQty;
  const fees = computeFees(side, filledQty, avgPrice, cfg);
  const mid = (quote.bid + quote.ask) / 2;
  return {
    ...base,
    status: remaining > EPS ? 'PARTIAL' : 'FILLED',
    reason: remaining > EPS ? `Only ${filledQty} of ${qty} filled within ${type === 'LIMIT' ? 'limit price' : `max slippage ${maxSlippagePct}%`} (displayed size ${liquidityAssumed ? 'unknown, assumed ' : ''}${tier}/tier)` : null,
    fills, filledQty, remainingQty: Math.max(0, remaining), avgPrice, fees, liquidityAssumed,
    touchPrice: touch, mid, spread: quote.ask - quote.bid,
    slippageVsTouch: (avgPrice - touch) * dir * filledQty,
    costVsMid: (avgPrice - mid) * dir * filledQty,
  };
}

module.exports = { simulateOrder, computeFees, validQuote };
