/**
 * Chart technicals — deterministic, look-ahead-free market structure computed from COMPLETED real bars.
 *
 *  - Confirmed swing highs / lows (pivot with k bars on each side). A pivot at bar i is only CONFIRMED once
 *    bar i+k has closed; `confirmedAt` is that close time. Pivots are a pure function of bars i-k..i+k, so
 *    later data never changes or repaints a confirmed point. The latest unconfirmed pivot is reported
 *    separately as a PROVISIONAL candidate.
 *  - HH / LH / HL / LL / EQ labels relative to the previous confirmed swing of the same type.
 *  - Support / resistance zones from clustered confirmed swings + previous-session high/low + volume
 *    concentration, with confirmed reaction counts, last interaction, strength estimate, active/broken status.
 *  - Breakout / breakdown events, each only against a swing level confirmed BEFORE the event bar.
 *  - Trend lines through the last two confirmed swing lows / highs; trading-range boxes.
 *  - Candlestick patterns with explicit mathematical conditions and a confirmation status.
 *  - Single-candle anatomy for the candle inspector.
 *
 * Output is language-neutral (codes + numbers). The UI turns it into Arabic/English text.
 * UMD wrapper: the same file is served to the browser (window.Technicals).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Technicals = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const last = (a) => (a.length ? a[a.length - 1] : null);

  /** Wilder ATR (aligned with input; null until enough bars). */
  function atrSeries(bars, n = 14) {
    const out = new Array(bars.length).fill(null);
    let prevAtr = null;
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const tr = i === 0 ? b.high - b.low : Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
      if (i < n) { sum += tr; if (i === n - 1) { prevAtr = sum / n; out[i] = prevAtr; } continue; }
      prevAtr = (prevAtr * (n - 1) + tr) / n;
      out[i] = prevAtr;
    }
    return out;
  }

  /** Relative volume vs the average of the PREVIOUS n bars (the current bar is not in its own baseline). */
  function relVolSeries(bars, n = 20) {
    const out = new Array(bars.length).fill(null);
    let sum = 0;
    for (let i = 0; i < bars.length; i++) {
      if (i >= n) {
        const avg = sum / n;
        out[i] = avg > 0 ? (bars[i].volume || 0) / avg : null;
        sum -= bars[i - n].volume || 0;
      }
      sum += bars[i].volume || 0;
    }
    return out;
  }

  // ------------------------------------------------------------------ swings
  function swings(bars, { k = 3, tfSec = 60, atr = null } = {}) {
    const n = bars.length;
    const points = [];
    for (let i = k; i < n - k; i++) {
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
      const conf = { confirmedIndex: i + k, confirmedAt: bars[i + k].time + tfSec };
      if (isH) points.push({ type: 'H', index: i, time: bars[i].time, price: bars[i].high, ...conf });
      if (isL) points.push({ type: 'L', index: i, time: bars[i].time, price: bars[i].low, ...conf });
    }
    const eqTol = (p) => Math.max(isNum(atr) ? atr * 0.05 : 0, p * 0.0003);
    let prevH = null;
    let prevL = null;
    for (const p of points) {
      if (p.type === 'H') {
        p.label = !prevH ? null : Math.abs(p.price - prevH.price) <= eqTol(p.price) ? 'EQ' : p.price > prevH.price ? 'HH' : 'LH';
        p.prevPrice = prevH ? prevH.price : null;
        prevH = p;
      } else {
        p.label = !prevL ? null : Math.abs(p.price - prevL.price) <= eqTol(p.price) ? 'EQ' : p.price > prevL.price ? 'HL' : 'LL';
        p.prevPrice = prevL ? prevL.price : null;
        prevL = p;
      }
    }
    // Provisional candidates: the newest bar that is a pivot on its left side and not exceeded since,
    // but without k completed bars on its right yet. Shown as "unconfirmed" — never used as a signal.
    const provisional = [];
    for (const type of ['H', 'L']) {
      for (let i = n - 1; i >= Math.max(k, n - k); i--) {
        let ok = true;
        for (let j = i - k; j < n && ok; j++) {
          if (j === i) continue;
          if (type === 'H') ok = j < i ? bars[j].high < bars[i].high : bars[j].high <= bars[i].high;
          else ok = j < i ? bars[j].low > bars[i].low : bars[j].low >= bars[i].low;
        }
        if (ok) {
          provisional.push({ type, index: i, time: bars[i].time, price: type === 'H' ? bars[i].high : bars[i].low, barsToConfirm: k - (n - 1 - i) });
          break;
        }
      }
    }
    return { k, highs: points.filter((p) => p.type === 'H'), lows: points.filter((p) => p.type === 'L'), points, provisional };
  }

  function structure(sw) {
    const h = sw.highs;
    const l = sw.lows;
    if (h.length < 2 || l.length < 2) return { code: 'INSUFFICIENT', highs: h.length, lows: l.length };
    const hl = last(h).label;
    const ll = last(l).label;
    let code = 'MIXED';
    if (hl === 'HH' && ll === 'HL') code = 'UPTREND';
    else if (hl === 'LH' && ll === 'LL') code = 'DOWNTREND';
    else if (hl === 'HH' && ll === 'LL') code = 'EXPANDING';
    else if (hl === 'LH' && ll === 'HL') code = 'CONTRACTING';
    else if (hl === 'EQ' || ll === 'EQ') code = 'RANGE';
    return { code, lastHigh: last(h), lastLow: last(l), prevHigh: h[h.length - 2], prevLow: l[l.length - 2] };
  }

  // ------------------------------------------------------------------ support / resistance
  function volumeConcentration(bars, bins = 24) {
    if (bars.length < 50) return null;
    const lo = Math.min(...bars.map((b) => b.low));
    const hi = Math.max(...bars.map((b) => b.high));
    if (!(hi > lo)) return null;
    const w = (hi - lo) / bins;
    const vol = new Array(bins).fill(0);
    let total = 0;
    for (const b of bars) {
      const v = b.volume || 0;
      if (!v) continue;
      const tp = (b.high + b.low + b.close) / 3;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((tp - lo) / w)));
      vol[idx] += v; total += v;
    }
    if (!total) return null;
    let best = 0;
    for (let i = 1; i < bins; i++) if (vol[i] > vol[best]) best = i;
    return { price: lo + (best + 0.5) * w, share: vol[best] / total, binLow: lo + best * w, binHigh: lo + (best + 1) * w, bars: bars.length };
  }

  function levels(bars, { sw, atr, price, session = {}, maxEach = 4 } = {}) {
    const n = bars.length;
    if (!n || !isNum(price)) return { tol: null, all: [], supports: [], resistances: [] };
    const tol = isNum(atr) && atr > 0 ? atr * 0.5 : price * 0.003;
    const buf = tol * 0.25;
    const pts = [...sw.points].sort((a, b) => a.price - b.price);
    const clusters = [];
    for (const p of pts) {
      const c = last(clusters);
      if (c && Math.abs(p.price - c.sum / c.pts.length) <= tol) { c.sum += p.price; c.pts.push(p); } else clusters.push({ sum: p.price, pts: [p] });
    }
    const out = [];
    for (const c of clusters) {
      const mean = c.sum / c.pts.length;
      const minP = Math.min(...c.pts.map((p) => p.price));
      const maxP = Math.max(...c.pts.map((p) => p.price));
      const half = Math.max(buf, (maxP - minP) / 2 + buf * 0.5);
      out.push({
        price: mean, zoneLow: Math.min(minP, mean - half), zoneHigh: Math.max(maxP, mean + half),
        reactions: c.pts.length, highs: c.pts.filter((p) => p.type === 'H').length, lows: c.pts.filter((p) => p.type === 'L').length,
        pivots: c.pts.map((p) => ({ time: p.time, type: p.type, price: p.price, confirmedAt: p.confirmedAt })),
        firstTime: Math.min(...c.pts.map((p) => p.time)), lastPivotTime: Math.max(...c.pts.map((p) => p.time)),
        lastConfirmedIndex: Math.max(...c.pts.map((p) => p.confirmedIndex)), sources: ['swings'],
      });
    }
    // Previous-session high/low and volume concentration: merged into a nearby swing zone, else their own level.
    const extra = [];
    if (isNum(session.prevSessionHigh)) extra.push({ price: session.prevSessionHigh, source: 'prevSessionHigh' });
    if (isNum(session.prevSessionLow)) extra.push({ price: session.prevSessionLow, source: 'prevSessionLow' });
    const vc = volumeConcentration(bars.slice(-300));
    if (vc && vc.share >= 0.08) extra.push({ price: vc.price, source: 'volumeConcentration', share: vc.share });
    for (const x of extra) {
      const near = out.find((l) => x.price >= l.zoneLow - buf && x.price <= l.zoneHigh + buf);
      if (near) { near.sources.push(x.source); if (x.share) near.volumeShare = x.share; continue; }
      out.push({
        price: x.price, zoneLow: x.price - buf, zoneHigh: x.price + buf, reactions: 0, highs: 0, lows: 0, pivots: [],
        firstTime: null, lastPivotTime: null, lastConfirmedIndex: -1, sources: [x.source], volumeShare: x.share || null,
      });
    }
    const lastTime = bars[n - 1].time;
    const span = Math.max(1, lastTime - bars[0].time);
    for (const l of out) {
      // interactions: separate visits of price into the zone (consecutive bars count once)
      let interactions = 0;
      let inside = false;
      let lastInteraction = null;
      for (let i = 0; i < n; i++) {
        const b = bars[i];
        const touch = b.low <= l.zoneHigh && b.high >= l.zoneLow;
        if (touch) { lastInteraction = b.time; if (!inside) interactions++; }
        inside = touch;
      }
      l.interactions = interactions;
      l.lastInteraction = lastInteraction;
      l.origin = l.reactions === 0 ? (l.sources[0] === 'prevSessionHigh' ? 'resistance' : l.sources[0] === 'prevSessionLow' ? 'support' : 'mixed')
        : (l.lows > l.highs ? 'support' : l.highs > l.lows ? 'resistance' : 'mixed');
      // broken: a CLOSE beyond the zone after the level became known (after its last pivot was confirmed)
      l.status = 'active';
      l.brokenAt = null;
      const from = Math.max(0, l.lastConfirmedIndex + 1);
      if (l.origin !== 'mixed') {
        for (let i = from; i < n; i++) {
          const c = bars[i].close;
          if ((l.origin === 'support' && c < l.zoneLow - buf) || (l.origin === 'resistance' && c > l.zoneHigh + buf)) { l.status = 'broken'; l.brokenAt = bars[i].time; break; }
        }
      }
      l.role = price > l.zoneHigh ? 'support' : price < l.zoneLow ? 'resistance' : 'at';
      const recency = lastInteraction ? Math.max(0, 1 - (lastTime - lastInteraction) / span) : 0;
      let s = Math.min(l.reactions, 5) * 11 + Math.min(interactions, 8) * 2.5 + recency * 15
        + (l.sources.includes('prevSessionHigh') || l.sources.includes('prevSessionLow') ? 8 : 0) + (l.sources.includes('volumeConcentration') ? 7 : 0);
      if (l.status === 'broken') s *= 0.5;
      l.strength = Math.max(1, Math.min(100, Math.round(s)));
      l.distancePct = ((l.price - price) / price) * 100;
      l.id = `lvl_${l.price.toFixed(4)}`;
      delete l.lastConfirmedIndex;
    }
    const active = out.filter((l) => l.status === 'active');
    const supports = active.filter((l) => l.role === 'support' || (l.role === 'at' && l.price <= price)).sort((a, b) => b.price - a.price).slice(0, maxEach);
    const resistances = active.filter((l) => l.role === 'resistance' || (l.role === 'at' && l.price > price)).sort((a, b) => a.price - b.price).slice(0, maxEach);
    supports.forEach((l, i) => { l.rank = `S${i + 1}`; });
    resistances.forEach((l, i) => { l.rank = `R${i + 1}`; });
    const broken = out.filter((l) => l.status === 'broken').sort((a, b) => Math.abs(a.distancePct) - Math.abs(b.distancePct)).slice(0, 2);
    return { tol, buf, all: out, supports, resistances, broken, volumeConcentration: vc };
  }

  // ------------------------------------------------------------------ breakouts / breakdowns
  function breakEvents(bars, sw, relVol) {
    const events = [];
    let hp = -1;
    let lp = -1;
    let usedH = -1;
    let usedL = -1;
    const H = sw.highs;
    const L = sw.lows;
    for (let j = 1; j < bars.length; j++) {
      while (hp + 1 < H.length && H[hp + 1].confirmedIndex <= j - 1) hp++;
      while (lp + 1 < L.length && L[lp + 1].confirmedIndex <= j - 1) lp++;
      const rv = relVol ? relVol[j] : null;
      if (hp >= 0 && hp !== usedH) {
        const lv = H[hp].price;
        if (bars[j - 1].close <= lv && bars[j].close > lv) {
          usedH = hp;
          events.push({ type: 'BREAKOUT', index: j, time: bars[j].time, level: lv, swingTime: H[hp].time, close: bars[j].close, relVol: rv, volumeConfirmed: isNum(rv) && rv >= 1.5 });
        }
      }
      if (lp >= 0 && lp !== usedL) {
        const lv = L[lp].price;
        if (bars[j - 1].close >= lv && bars[j].close < lv) {
          usedL = lp;
          events.push({ type: 'BREAKDOWN', index: j, time: bars[j].time, level: lv, swingTime: L[lp].time, close: bars[j].close, relVol: rv, volumeConfirmed: isNum(rv) && rv >= 1.5 });
        }
      }
    }
    return events.slice(-12);
  }

  // ------------------------------------------------------------------ trend lines
  function trendlines(bars, sw, tol) {
    const n = bars.length;
    const out = [];
    const buf = (tol || 0) * 0.25;
    const build = (a, b, kind) => {
      const slope = (b.price - a.price) / (b.index - a.index);
      const at = (i) => a.price + slope * (i - a.index);
      for (let i = a.index + 1; i < b.index; i++) {
        const c = bars[i].close;
        if ((kind === 'SUPPORT_UP' && c < at(i) - buf) || (kind === 'RESISTANCE_DOWN' && c > at(i) + buf)) return null; // not a valid line
      }
      let brokenIndex = null;
      for (let i = b.confirmedIndex + 1; i < n; i++) {
        const c = bars[i].close;
        if ((kind === 'SUPPORT_UP' && c < at(i) - buf) || (kind === 'RESISTANCE_DOWN' && c > at(i) + buf)) { brokenIndex = i; break; }
      }
      let touches = 0;
      for (let i = a.index; i < (brokenIndex == null ? n : brokenIndex); i++) {
        const v = at(i);
        if (kind === 'SUPPORT_UP' ? Math.abs(bars[i].low - v) <= buf * 2 : Math.abs(bars[i].high - v) <= buf * 2) touches++;
      }
      const end = brokenIndex == null ? n - 1 : brokenIndex;
      return {
        kind, from: { index: a.index, time: a.time, price: a.price }, to: { index: b.index, time: b.time, price: b.price },
        end: { index: end, time: bars[end].time, price: at(end) }, slopePerBar: slope, knownSince: b.confirmedAt,
        status: brokenIndex == null ? 'active' : 'broken', brokenAt: brokenIndex == null ? null : bars[brokenIndex].time,
        priceNow: brokenIndex == null ? at(n - 1) : null, touches,
      };
    };
    if (sw.lows.length >= 2) {
      const a = sw.lows[sw.lows.length - 2];
      const b = last(sw.lows);
      if (b.price > a.price) { const l = build(a, b, 'SUPPORT_UP'); if (l) out.push(l); }
    }
    if (sw.highs.length >= 2) {
      const a = sw.highs[sw.highs.length - 2];
      const b = last(sw.highs);
      if (b.price < a.price) { const l = build(a, b, 'RESISTANCE_DOWN'); if (l) out.push(l); }
    }
    return out;
  }

  // ------------------------------------------------------------------ trading range
  function tradingRange(bars, atr, { minBars = 12, maxBars = 90, maxAtrMult = 3 } = {}) {
    const n = bars.length;
    if (n < minBars || !isNum(atr) || atr <= 0) return null;
    let hi = -Infinity;
    let lo = Infinity;
    let start = n;
    for (let i = n - 1; i >= Math.max(0, n - maxBars); i--) {
      const h = Math.max(hi, bars[i].high);
      const l = Math.min(lo, bars[i].low);
      if (h - l > maxAtrMult * atr) break;
      hi = h; lo = l; start = i;
    }
    if (n - start < minBars) return null;
    return { startIndex: start, startTime: bars[start].time, endIndex: n - 1, endTime: bars[n - 1].time, high: hi, low: lo, bars: n - start, heightAtr: (hi - lo) / atr, maxAtrMult };
  }

  // ------------------------------------------------------------------ candles
  function parts(b) {
    const range = b.high - b.low;
    const body = Math.abs(b.close - b.open);
    const upper = b.high - Math.max(b.open, b.close);
    const lower = Math.min(b.open, b.close) - b.low;
    return { range, body, upper, lower, bull: b.close > b.open, bear: b.close < b.open };
  }

  /** Prior trend over `look` bars ending at bar `i` (inclusive), in ATR units. */
  function priorTrend(bars, i, atr, look = 5) {
    if (i - look < 0 || !isNum(atr) || atr <= 0) return { dir: 'UNKNOWN', moveAtr: null };
    const move = bars[i].close - bars[i - look].close;
    const m = move / atr;
    return { dir: m <= -0.8 ? 'DOWN' : m >= 0.8 ? 'UP' : 'FLAT', moveAtr: m };
  }

  const PATTERN_DIR = {
    HAMMER: 'BULLISH', SHOOTING_STAR: 'BEARISH', DOJI: 'NEUTRAL', BULLISH_ENGULFING: 'BULLISH', BEARISH_ENGULFING: 'BEARISH',
    MORNING_STAR: 'BULLISH', EVENING_STAR: 'BEARISH',
  };

  function patterns(bars, atrArr) {
    const out = [];
    const n = bars.length;
    for (let i = 1; i < n; i++) {
      const atr = atrArr[i];
      if (!isNum(atr) || atr <= 0) continue;
      const b = bars[i];
      const c = parts(b);
      if (c.range <= 0) continue;
      const found = [];
      const bodyPct = c.body / c.range;
      // Doji: open ≈ close (body ≤ 10% of range) on a bar of meaningful size (range ≥ 0.3 ATR), reported only
      // after a directional move (≥ 0.8 ATR over 5 bars) where indecision is informative.
      if (bodyPct <= 0.1 && c.range >= 0.3 * atr) {
        const t = priorTrend(bars, i - 1, atr);
        if (t.dir === 'UP' || t.dir === 'DOWN') found.push({ code: 'DOJI', from: i, cond: { bodyPctOfRange: bodyPct * 100, rangeAtr: c.range / atr, priorMoveAtr: t.moveAtr }, trend: t });
      }
      // Hammer (after a decline) / Shooting star (after an advance): small body at one end, long opposite wick
      if (bodyPct >= 0.08 && bodyPct <= 0.35 && c.range >= 0.5 * atr) {
        const t = priorTrend(bars, i - 1, atr);
        if (c.lower >= 2 * c.body && c.upper <= 0.15 * c.range && t.dir === 'DOWN') {
          found.push({ code: 'HAMMER', from: i, cond: { lowerWickToBody: c.lower / c.body, upperWickPctOfRange: (c.upper / c.range) * 100, bodyPctOfRange: bodyPct * 100, priorMoveAtr: t.moveAtr }, trend: t });
        }
        if (c.upper >= 2 * c.body && c.lower <= 0.15 * c.range && t.dir === 'UP') {
          found.push({ code: 'SHOOTING_STAR', from: i, cond: { upperWickToBody: c.upper / c.body, lowerWickPctOfRange: (c.lower / c.range) * 100, bodyPctOfRange: bodyPct * 100, priorMoveAtr: t.moveAtr }, trend: t });
        }
      }
      // Engulfing: the second body fully covers the first, opposite colours, after a move in the first's direction
      const p = bars[i - 1];
      const pc = parts(p);
      if (pc.body >= 0.1 * atr && c.body > pc.body) {
        const t = priorTrend(bars, i - 1, atr);
        if (pc.bear && c.bull && b.open <= p.close && b.close >= p.open && t.dir === 'DOWN') {
          found.push({ code: 'BULLISH_ENGULFING', from: i - 1, cond: { bodyRatio: c.body / pc.body, priorMoveAtr: t.moveAtr }, trend: t });
        }
        if (pc.bull && c.bear && b.open >= p.close && b.close <= p.open && t.dir === 'UP') {
          found.push({ code: 'BEARISH_ENGULFING', from: i - 1, cond: { bodyRatio: c.body / pc.body, priorMoveAtr: t.moveAtr }, trend: t });
        }
      }
      // Morning / evening star: long body, small middle body, strong reversal closing beyond the first body's midpoint
      if (i >= 2) {
        const a = bars[i - 2];
        const ac = parts(a);
        const mc = parts(bars[i - 1]);
        const t = priorTrend(bars, i - 2, atr);
        if (ac.body >= 0.6 * atr && mc.body <= 0.3 * ac.body) {
          const mid = (a.open + a.close) / 2;
          if (ac.bear && c.bull && b.close > mid && c.body >= 0.5 * ac.body && t.dir === 'DOWN') {
            found.push({ code: 'MORNING_STAR', from: i - 2, cond: { firstBodyAtr: ac.body / atr, middleToFirstBody: mc.body / ac.body, closeAboveMidpoint: b.close - mid, priorMoveAtr: t.moveAtr }, trend: t });
          }
          if (ac.bull && c.bear && b.close < mid && c.body >= 0.5 * ac.body && t.dir === 'UP') {
            found.push({ code: 'EVENING_STAR', from: i - 2, cond: { firstBodyAtr: ac.body / atr, middleToFirstBody: mc.body / ac.body, closeBelowMidpoint: mid - b.close, priorMoveAtr: t.moveAtr }, trend: t });
          }
        }
      }
      for (const f of found) {
        const dir = PATTERN_DIR[f.code];
        const hi = Math.max(...bars.slice(f.from, i + 1).map((x) => x.high));
        const lo = Math.min(...bars.slice(f.from, i + 1).map((x) => x.low));
        // Confirmation from the NEXT completed bar (recorded with its time; never back-dated).
        let confirmation = { status: 'AWAITING_NEXT_BAR', at: null };
        if (i + 1 < n) {
          const nx = bars[i + 1];
          if (dir === 'BULLISH') confirmation = nx.close > b.high ? { status: 'CONFIRMED', at: nx.time } : nx.close < lo ? { status: 'FAILED', at: nx.time } : { status: 'UNCONFIRMED', at: nx.time };
          else if (dir === 'BEARISH') confirmation = nx.close < b.low ? { status: 'CONFIRMED', at: nx.time } : nx.close > hi ? { status: 'FAILED', at: nx.time } : { status: 'UNCONFIRMED', at: nx.time };
          else confirmation = { status: 'NOT_APPLICABLE', at: nx.time };
        }
        out.push({
          id: `${f.code}_${b.time}`, code: f.code, direction: dir, index: i, time: b.time, startIndex: f.from, startTime: bars[f.from].time,
          high: hi, low: lo, conditions: f.cond, priorTrend: f.trend.dir, confirmation,
        });
      }
    }
    return out;
  }

  /** Single-candle anatomy for the inspector (numbers + a shape code; text is produced by the UI). */
  function anatomy(bar, { atr = null, levels: lv = null } = {}) {
    if (!bar) return null;
    const c = parts(bar);
    const pct = (x) => (c.range > 0 ? (x / c.range) * 100 : 0);
    let shape = 'NORMAL';
    if (c.range <= 0) shape = 'FLAT';
    else if (pct(c.body) <= 10) shape = 'DOJI';
    else if (c.lower >= 2 * c.body && pct(c.lower) >= 50) shape = 'LONG_LOWER_WICK';
    else if (c.upper >= 2 * c.body && pct(c.upper) >= 50) shape = 'LONG_UPPER_WICK';
    else if (pct(c.body) >= 85) shape = 'MARUBOZU';
    else if (pct(c.body) >= 60) shape = 'STRONG_BODY';
    else if (pct(c.body) <= 35 && pct(c.upper) >= 25 && pct(c.lower) >= 25) shape = 'SPINNING_TOP';
    let near = null;
    if (lv && lv.all && lv.all.length) {
      let best = null;
      for (const l of lv.all) {
        const touched = bar.low <= l.zoneHigh && bar.high >= l.zoneLow;
        const d = Math.abs(bar.close - l.price);
        if (!best || (touched && !best.touched) || (touched === best.touched && d < best.d)) best = { l, d, touched };
      }
      if (best) {
        const l = best.l;
        near = {
          price: l.price, zoneLow: l.zoneLow, zoneHigh: l.zoneHigh, origin: l.origin, status: l.status, rank: l.rank || null, touched: best.touched,
          closeVsLevel: bar.close > l.zoneHigh ? 'ABOVE' : bar.close < l.zoneLow ? 'BELOW' : 'INSIDE', distancePct: ((bar.close - l.price) / l.price) * 100,
          distanceAtr: isNum(atr) && atr > 0 ? (bar.close - l.price) / atr : null,
        };
      }
    }
    return {
      time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume || 0,
      direction: c.bull ? 'UP' : c.bear ? 'DOWN' : 'FLAT', range: c.range, body: c.body, upperWick: c.upper, lowerWick: c.lower,
      bodyPct: pct(c.body), upperPct: pct(c.upper), lowerPct: pct(c.lower), closePosPct: c.range > 0 ? ((bar.close - bar.low) / c.range) * 100 : 50,
      rangeAtr: isNum(atr) && atr > 0 ? c.range / atr : null, shape, near,
    };
  }

  /** Volume behaviour over the last `n` completed bars. */
  function volumeContext(bars, relVol, n = 20) {
    const w = bars.slice(-n);
    if (w.length < 5) return { available: false };
    const up = w.filter((b) => b.close > b.open);
    const dn = w.filter((b) => b.close < b.open);
    const avg = (a) => (a.length ? a.reduce((s, b) => s + (b.volume || 0), 0) / a.length : null);
    const recent = bars.slice(-5);
    const prior = bars.slice(-n, -5);
    const upAvg = avg(up);
    const downAvg = avg(dn);
    return {
      available: true, bars: w.length, upBars: up.length, downBars: dn.length, upAvg, downAvg,
      upDownRatio: upAvg && downAvg ? upAvg / downAvg : null,
      recentVsPrior: avg(recent) && avg(prior) ? avg(recent) / avg(prior) : null,
      lastRelVol: relVol ? last(relVol) : null,
    };
  }

  /**
   * Full analysis of completed bars.
   * opts: { tfSec, k, price (current price for level roles), session: { prevSessionHigh, prevSessionLow } }
   */
  function analyze(bars, { tfSec = 60, k = 3, price = null, session = {} } = {}) {
    const n = bars ? bars.length : 0;
    if (n < 2 * k + 1) return { available: false, reason: `needs at least ${2 * k + 1} completed bars, have ${n}`, bars: n };
    const atrArr = atrSeries(bars, 14);
    const atr = last(atrArr.filter(isNum)) || null;
    const relVol = relVolSeries(bars, 20);
    const px = isNum(price) ? price : bars[n - 1].close;
    const sw = swings(bars, { k, tfSec, atr });
    const lv = levels(bars, { sw, atr, price: px, session });
    return {
      available: true, bars: n, lastTime: bars[n - 1].time, price: px, atr, k,
      swings: sw, structure: structure(sw), levels: lv, events: breakEvents(bars, sw, relVol), trendlines: trendlines(bars, sw, lv.tol),
      range: tradingRange(bars, atr), patterns: patterns(bars, atrArr), volume: volumeContext(bars, relVol),
      lastCandle: anatomy(bars[n - 1], { atr, levels: lv }),
    };
  }

  /** Reference reward:risk geometry for a long entry at `entry` (not a recommendation). */
  function referenceRR(a, entry) {
    if (!a || !a.available || !isNum(entry)) return null;
    const s = a.levels.supports[0];
    const r = a.levels.resistances[0];
    if (!s || !r || !isNum(a.atr)) return null;
    const stop = s.zoneLow - 0.1 * a.atr;
    const target = r.zoneLow;
    if (!(stop < entry && target > entry)) return null;
    return { entry, stop, target, rewardToRisk: (target - entry) / (entry - stop), stopBasis: `${s.rank} zone low - 0.1 ATR`, targetBasis: `${r.rank} zone low` };
  }

  return { analyze, atrSeries, relVolSeries, swings, structure, levels, breakEvents, trendlines, tradingRange, patterns, anatomy, volumeContext, volumeConcentration, referenceRR, PATTERN_DIR };
});
