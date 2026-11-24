'use strict';
/**
 * Deterministic pattern detectors over completed real bars. Each detector returns
 * { id, active, detail }. They are evidence for the AI and triggers for the scheduler,
 * never trading decisions on their own.
 */
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

function detectSignals({ bars, series, sr, levels, cons }) {
  const out = [];
  const n = bars.length;
  const push = (id, active, detail) => out.push({ id, active: !!active, detail: detail || '' });
  if (n < 3) {
    push('insufficient_data', true, `Only ${n} completed bars available — pattern detection disabled.`);
    return out;
  }
  const b = bars[n - 1];
  const p = bars[n - 2];
  const range = b.high - b.low;
  const body = Math.abs(b.close - b.open);
  const relVol = series.relVol[n - 1];
  const atr = series.atr14[n - 1];
  const rsi = series.rsi14[n - 1];
  const hist = series.macdHist[n - 1];
  const histPrev = series.macdHist[n - 2];
  const res = sr.resistance[0] ? sr.resistance[0].price : null;
  const sup = sr.support[0] ? sr.support[0].price : null;
  const bo = levels.breakout;
  const bd = levels.breakdown;

  // Breakout / breakdown: the latest bar's close crosses the most recent CONFIRMED swing level
  // (swings need 3 bars on each side, so the level was known before this bar closed).
  const swingHighBefore = (sr.swingHighs || []).filter((s) => s.time < b.time).map((s) => s.price);
  const swingLowBefore = (sr.swingLows || []).filter((s) => s.time < b.time).map((s) => s.price);
  const lastSwingHigh = swingHighBefore.length ? swingHighBefore[swingHighBefore.length - 1] : null;
  const lastSwingLow = swingLowBefore.length ? swingLowBefore[swingLowBefore.length - 1] : null;

  const brokeUp = isNum(lastSwingHigh) && p.close <= lastSwingHigh && b.close > lastSwingHigh;
  push('bullish_breakout', brokeUp && isNum(relVol) && relVol >= 1.5,
    brokeUp ? `Close ${b.close.toFixed(2)} crossed above swing high ${lastSwingHigh.toFixed(2)} (relVol ${isNum(relVol) ? relVol.toFixed(2) : 'n/a'})` : '');
  const brokeDown = isNum(lastSwingLow) && p.close >= lastSwingLow && b.close < lastSwingLow;
  push('bearish_breakdown', brokeDown && isNum(relVol) && relVol >= 1.5,
    brokeDown ? `Close ${b.close.toFixed(2)} crossed below swing low ${lastSwingLow.toFixed(2)} (relVol ${isNum(relVol) ? relVol.toFixed(2) : 'n/a'})` : '');

  // Failed breakout: one of the previous 3 bars closed above the last swing high, now back below.
  let failed = false;
  if (isNum(lastSwingHigh) && n >= 4) {
    const recent = bars.slice(n - 4, n - 1);
    failed = recent.some((x) => x.close > lastSwingHigh) && b.close < lastSwingHigh;
  }
  push('failed_breakout', failed, failed ? `Price closed back below ${lastSwingHigh.toFixed(2)} after closing above it` : '');

  const bullEngulf = p.close < p.open && b.close > b.open && b.close >= p.open && b.open <= p.close;
  const bearEngulf = p.close > p.open && b.close < b.open && b.close <= p.open && b.open >= p.close;
  const macdFlipUp = isNum(hist) && isNum(histPrev) && histPrev < 0 && hist >= 0;
  const macdFlipDown = isNum(hist) && isNum(histPrev) && histPrev > 0 && hist <= 0;
  const revUp = (isNum(rsi) && rsi < 35 && (bullEngulf || macdFlipUp));
  const revDown = (isNum(rsi) && rsi > 65 && (bearEngulf || macdFlipDown));
  push('potential_bullish_reversal', revUp, revUp ? `RSI ${rsi.toFixed(1)} with ${bullEngulf ? 'bullish engulfing' : 'MACD histogram turning positive'}` : '');
  push('potential_bearish_reversal', revDown, revDown ? `RSI ${rsi.toFixed(1)} with ${bearEngulf ? 'bearish engulfing' : 'MACD histogram turning negative'}` : '');

  const closePos = range > 0 ? (b.close - b.low) / range : 0.5;
  const strongBuy = range > 0 && b.close > b.open && closePos >= 0.8 && body / range >= 0.6 && isNum(relVol) && relVol >= 1.5;
  const strongSell = range > 0 && b.close < b.open && closePos <= 0.2 && body / range >= 0.6 && isNum(relVol) && relVol >= 1.5;
  push('strong_buying_pressure', strongBuy, strongBuy ? `Wide bullish bar closing in top ${(100 - closePos * 100).toFixed(0)}% on ${relVol.toFixed(2)}x volume` : '');
  push('strong_selling_pressure', strongSell, strongSell ? `Wide bearish bar closing near low on ${relVol.toFixed(2)}x volume` : '');

  let volUp = false;
  let volDetail = '';
  if (isNum(atr) && n > 11 && isNum(series.atr14[n - 11])) {
    const r = atr / series.atr14[n - 11];
    volUp = r >= 1.3;
    volDetail = `ATR14 ${atr.toFixed(3)} vs ${series.atr14[n - 11].toFixed(3)} ten bars ago (${r.toFixed(2)}x)`;
  }
  push('increasing_volatility', volUp, volUp ? volDetail : '');
  push('abnormal_volume', isNum(relVol) && relVol >= 2.5, isNum(relVol) && relVol >= 2.5 ? `Relative volume ${relVol.toFixed(2)}x the 20-bar average` : '');

  const tol = isNum(atr) ? atr * 0.3 : b.close * 0.002;
  const upperWick = b.high - Math.max(b.open, b.close);
  const lowerWick = Math.min(b.open, b.close) - b.low;
  const rejRes = isNum(res) && Math.abs(b.high - res) <= tol && range > 0 && upperWick / range >= 0.5 && b.close < res;
  const rejResAlt = !rejRes && isNum(bo && bo.price) && Math.abs(b.high - bo.price) <= tol && range > 0 && upperWick / range >= 0.5;
  push('rejection_near_resistance', rejRes || rejResAlt, rejRes ? `Upper wick rejected near resistance ${res.toFixed(2)}` : (rejResAlt ? `Upper wick rejected near ${bo.label} ${bo.price.toFixed(2)}` : ''));
  const reactSup = isNum(sup) && Math.abs(b.low - sup) <= tol && range > 0 && lowerWick / range >= 0.5 && b.close > sup;
  const reactSupAlt = !reactSup && isNum(bd && bd.price) && Math.abs(b.low - bd.price) <= tol && range > 0 && lowerWick / range >= 0.5;
  push('reaction_near_support', reactSup || reactSupAlt, reactSup ? `Lower wick bounced from support ${sup.toFixed(2)}` : (reactSupAlt ? `Lower wick bounced near ${bd.label} ${bd.price.toFixed(2)}` : ''));

  return out;
}

module.exports = { detectSignals };
