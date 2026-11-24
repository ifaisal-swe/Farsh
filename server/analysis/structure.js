'use strict';
/**
 * Market structure from real bars: swings, support/resistance clusters, session ranges,
 * consolidation, trend structure, breakout / breakdown reference levels. Deterministic.
 */
const { etDateStr, etMinuteOfDay } = require('../util/time');

const REG_OPEN_MIN = 9 * 60 + 30;
const REG_CLOSE_MIN = 16 * 60;

function isRegularBar(timeSec) {
  const m = etMinuteOfDay(timeSec * 1000);
  return m >= REG_OPEN_MIN && m < REG_CLOSE_MIN;
}

/** Confirmed pivots: k bars on each side (left strictly lower/higher, right lower-or-equal). */
function findSwings(bars, k = 3) {
  const highs = [];
  const lows = [];
  for (let i = k; i < bars.length - k; i++) {
    let isH = true;
    let isL = true;
    for (let j = i - k; j <= i + k && (isH || isL); j++) {
      if (j === i) continue;
      if (j < i) {
        if (bars[j].high >= bars[i].high) isH = false;
        if (bars[j].low <= bars[i].low) isL = false;
      } else {
        if (bars[j].high > bars[i].high) isH = false;
        if (bars[j].low < bars[i].low) isL = false;
      }
    }
    if (isH) highs.push({ time: bars[i].time, price: bars[i].high, index: i });
    if (isL) lows.push({ time: bars[i].time, price: bars[i].low, index: i });
  }
  return { highs, lows };
}

function clusterLevels(points, tolerance) {
  const sorted = [...points].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const p of sorted) {
    const c = clusters[clusters.length - 1];
    if (c && Math.abs(p.price - c.sum / c.touches) <= tolerance) {
      c.sum += p.price; c.touches++; c.lastTime = Math.max(c.lastTime, p.time);
      c.min = Math.min(c.min, p.price); c.max = Math.max(c.max, p.price);
    } else {
      clusters.push({ sum: p.price, touches: 1, lastTime: p.time, min: p.price, max: p.price });
    }
  }
  return clusters.map((c) => ({
    price: c.sum / c.touches, touches: c.touches, lastTime: c.lastTime, zoneLow: c.min, zoneHigh: c.max,
  }));
}

function supportResistance(bars, price, atrValue) {
  if (!bars.length || !Number.isFinite(price)) return { support: [], resistance: [] };
  const { highs, lows } = findSwings(bars, 3);
  const tol = atrValue && atrValue > 0 ? atrValue * 0.5 : price * 0.003;
  const clusters = clusterLevels([...highs, ...lows], tol);
  const lastTime = bars[bars.length - 1].time;
  const span = Math.max(1, lastTime - bars[0].time);
  const scored = clusters.map((c) => ({
    ...c, strength: Number((c.touches + (1 - (lastTime - c.lastTime) / span)).toFixed(2)),
  }));
  const resistance = scored.filter((c) => c.price > price).sort((a, b) => a.price - b.price).slice(0, 3);
  const support = scored.filter((c) => c.price < price).sort((a, b) => b.price - a.price).slice(0, 3);
  return { support, resistance, swingHighs: highs.slice(-5), swingLows: lows.slice(-5) };
}

/** Today's and the previous session's ranges from intraday bars (+ daily bars when available). */
function sessionLevels(intradayBars, dailyBars, nowMs) {
  const out = {
    sessionDate: null, intradayHigh: null, intradayLow: null, regularOpen: null,
    prevSessionHigh: null, prevSessionLow: null, prevClose: null,
    openingRangeHigh: null, openingRangeLow: null, openingRangeMinutes: 15, openingRangeComplete: false,
    source: {},
  };
  if (intradayBars.length) {
    const lastDate = etDateStr(intradayBars[intradayBars.length - 1].time * 1000);
    out.sessionDate = lastDate;
    const today = intradayBars.filter((b) => etDateStr(b.time * 1000) === lastDate);
    const todayReg = today.filter((b) => isRegularBar(b.time));
    const src = todayReg.length ? todayReg : today;
    if (src.length) {
      out.intradayHigh = Math.max(...src.map((b) => b.high));
      out.intradayLow = Math.min(...src.map((b) => b.low));
      out.source.intraday = todayReg.length ? 'regular session' : 'extended hours only';
    }
    if (todayReg.length) {
      out.regularOpen = todayReg[0].open;
      const orEnd = todayReg[0].time + out.openingRangeMinutes * 60;
      const orBars = todayReg.filter((b) => b.time < orEnd);
      out.openingRangeHigh = Math.max(...orBars.map((b) => b.high));
      out.openingRangeLow = Math.min(...orBars.map((b) => b.low));
      out.openingRangeComplete = (nowMs || Date.now()) / 1000 >= orEnd;
    }
    const prev = intradayBars.filter((b) => etDateStr(b.time * 1000) < lastDate && isRegularBar(b.time));
    if (prev.length) {
      const prevDate = etDateStr(prev[prev.length - 1].time * 1000);
      const p = prev.filter((b) => etDateStr(b.time * 1000) === prevDate);
      out.prevSessionHigh = Math.max(...p.map((b) => b.high));
      out.prevSessionLow = Math.min(...p.map((b) => b.low));
      out.prevClose = p[p.length - 1].close;
      out.source.prevSession = `intraday bars ${prevDate}`;
    }
  }
  if (dailyBars && dailyBars.length) {
    const todayStr = out.sessionDate || etDateStr(nowMs || Date.now());
    const prevDaily = dailyBars.filter((b) => etDateStr(b.time * 1000) < todayStr);
    if (prevDaily.length) {
      const d = prevDaily[prevDaily.length - 1];
      out.prevSessionHigh = d.high; out.prevSessionLow = d.low; out.prevClose = d.close;
      out.source.prevSession = `daily bar ${etDateStr(d.time * 1000)}`;
    }
  }
  return out;
}

function consolidation(bars, atrValue, lookback = 12, maxAtrMultiple = 2.5) {
  if (bars.length < lookback || !atrValue) return { isConsolidating: false, available: false, lookback };
  const w = bars.slice(-lookback);
  const high = Math.max(...w.map((b) => b.high));
  const low = Math.min(...w.map((b) => b.low));
  return {
    available: true, lookback, high, low, rangeAtr: (high - low) / atrValue,
    isConsolidating: high - low <= maxAtrMultiple * atrValue,
  };
}

function trendStructure(swings, emaValues) {
  const h = swings.swingHighs || [];
  const l = swings.swingLows || [];
  let structure = 'INSUFFICIENT_DATA';
  if (h.length >= 2 && l.length >= 2) {
    const hh = h[h.length - 1].price > h[h.length - 2].price;
    const hl = l[l.length - 1].price > l[l.length - 2].price;
    if (hh && hl) structure = 'UPTREND (higher highs & higher lows)';
    else if (!hh && !hl) structure = 'DOWNTREND (lower highs & lower lows)';
    else structure = 'RANGE / TRANSITION';
  }
  let emaStack = 'UNAVAILABLE';
  const { ema9, ema21, ema50 } = emaValues || {};
  if ([ema9, ema21, ema50].every((v) => Number.isFinite(v))) {
    if (ema9 > ema21 && ema21 > ema50) emaStack = 'BULLISH (EMA9>EMA21>EMA50)';
    else if (ema9 < ema21 && ema21 < ema50) emaStack = 'BEARISH (EMA9<EMA21<EMA50)';
    else emaStack = 'MIXED';
  }
  return { structure, emaStack };
}

function keyBreakLevels(price, sr, sess, cons) {
  const above = [];
  const below = [];
  const add = (v, label) => {
    if (!Number.isFinite(v)) return;
    if (v > price) above.push({ price: v, label });
    else if (v < price) below.push({ price: v, label });
  };
  if (sr.resistance[0]) add(sr.resistance[0].price, 'nearest resistance');
  if (sr.support[0]) add(sr.support[0].price, 'nearest support');
  if (cons && cons.isConsolidating) { add(cons.high, 'consolidation high'); add(cons.low, 'consolidation low'); }
  add(sess.intradayHigh, 'intraday high'); add(sess.intradayLow, 'intraday low');
  add(sess.prevSessionHigh, 'previous session high'); add(sess.prevSessionLow, 'previous session low');
  if (sess.openingRangeComplete) { add(sess.openingRangeHigh, 'opening range high'); add(sess.openingRangeLow, 'opening range low'); }
  above.sort((a, b) => a.price - b.price);
  below.sort((a, b) => b.price - a.price);
  return { breakout: above[0] || null, breakdown: below[0] || null };
}

module.exports = {
  isRegularBar, findSwings, clusterLevels, supportResistance, sessionLevels, consolidation, trendStructure, keyBreakLevels,
};
