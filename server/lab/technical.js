'use strict';
/**
 * Technical analysis of one symbol over three horizons (hours, days, weeks): readings with a plain meaning and a
 * practical step, how each signal did on this symbol before, and ready orders. Pure functions of the bars; a signal's
 * record uses only what was known at the time and buys at the next day's open.
 */
const Ind = require('../analysis/indicators');
const { findSwings, supportResistance, trendStructure } = require('../analysis/structure');
const { odds, tidy } = require('../invest/levels');
const { rng } = require('./quant');

const ok = Number.isFinite;
const end = (a) => a[a.length - 1];
const T = (ar, en) => ({ ar, en });
const clamp = (x, a = -1, b = 1) => Math.min(b, Math.max(a, x));

function weekly(bars) {
  const out = []; let key = null;
  for (const b of bars) { const k = Math.floor((Math.floor(b.time / 86400) + 3) / 7); if (k !== key) { out.push({ ...b }); key = k; } else { const w = end(out); w.high = Math.max(w.high, b.high); w.low = Math.min(w.low, b.low); w.close = b.close; w.volume = (w.volume || 0) + (b.volume || 0); } }
  return out;
}

/** Wilder's trend strength: 0-100, with the direction in plus/minus. */
function adx(bars, n = 14) {
  if (bars.length < n * 2 + 1) return null;
  let tr = 0; let up = 0; let dn = 0; let dxs = 0; let a = null; let pdi = 0; let mdi = 0;
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i]; const p = bars[i - 1];
    const t = Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close));
    const u = b.high - p.high; const d = p.low - b.low; const pu = u > d && u > 0 ? u : 0; const pd = d > u && d > 0 ? d : 0;
    if (i <= n) { tr += t; up += pu; dn += pd; } else { tr += t - tr / n; up += pu - up / n; dn += pd - dn / n; }
    if (i < n) continue;
    pdi = tr > 0 ? (100 * up) / tr : 0; mdi = tr > 0 ? (100 * dn) / tr : 0;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (i < n * 2) { dxs += dx; if (i === n * 2 - 1) a = dxs / n; } else a = (a * (n - 1) + dx) / n;
  }
  return { adx: a, plus: pdi, minus: mdi };
}

function stochastic(bars, n = 14) { const w = bars.slice(-n); const h = Math.max(...w.map((b) => b.high)); const l = Math.min(...w.map((b) => b.low)); return h > l ? (100 * (end(bars).close - l)) / (h - l) : 50; }
function obv(bars) { let v = 0; return bars.map((b, i) => { if (i) v += b.close > bars[i - 1].close ? b.volume || 0 : b.close < bars[i - 1].close ? -(b.volume || 0) : 0; return v; }); }

/** Reversal and continuation shapes of the last completed bars. */
function shapes(bars) {
  const out = []; const n = bars.length; if (n < 25) return out;
  const b = bars[n - 1]; const p = bars[n - 2]; const body = Math.abs(b.close - b.open); const range = b.high - b.low || 1e-9;
  const low10 = Math.min(...bars.slice(-11, -1).map((x) => x.low)); const high10 = Math.max(...bars.slice(-11, -1).map((x) => x.high));
  if (p.close < p.open && b.close > b.open && b.close > p.open && b.open <= p.close) out.push({ id: 'engulf_up', s: 0.5, t: T('شمعة ابتلاعية صاعدة: غلب المشترون يوم أمس كله', 'Bullish engulfing: buyers outweighed the whole day before') });
  if (p.close > p.open && b.close < b.open && b.close < p.open && b.open >= p.close) out.push({ id: 'engulf_down', s: -0.5, t: T('شمعة ابتلاعية هابطة: غلب البائعون يوم أمس كله', 'Bearish engulfing: sellers outweighed the whole day before') });
  if (body < range * 0.35 && Math.min(b.open, b.close) - b.low > range * 0.55 && b.low <= low10 * 1.005) out.push({ id: 'hammer', s: 0.4, t: T('مطرقة عند القاع: رُفض السعر المنخفض', 'Hammer near a low: the lower price was rejected') });
  if (body < range * 0.35 && b.high - Math.max(b.open, b.close) > range * 0.55 && b.high >= high10 * 0.995) out.push({ id: 'star', s: -0.4, t: T('نجمة ساقطة عند القمة: رُفض السعر المرتفع', 'Shooting star near a high: the higher price was rejected') });
  const sw = findSwings(bars.slice(-90), 3); const a = end(Ind.atr(bars, 14)) || range;
  const [l1, l2] = sw.lows.slice(-2); const [h1, h2] = sw.highs.slice(-2);
  if (l1 && l2 && l2.index - l1.index >= 6 && Math.abs(l1.price - l2.price) < a * 0.6 && b.close > l2.price + a) out.push({ id: 'double_bottom', s: 0.6, t: T('قاع مزدوج: ارتد السعر مرتين من المستوى نفسه', 'Double bottom: the price bounced twice from the same level') });
  if (h1 && h2 && h2.index - h1.index >= 6 && Math.abs(h1.price - h2.price) < a * 0.6 && b.close < h2.price - a) out.push({ id: 'double_top', s: -0.6, t: T('قمة مزدوجة: توقف السعر مرتين عند المستوى نفسه', 'Double top: the price stalled twice at the same level') });
  return out;
}

function read(bars, unit) {
  if (!bars || bars.length < 60) return null;
  const c = bars.map((b) => b.close); const px = end(c);
  const s20 = end(Ind.sma(c, 20)); const s50 = end(Ind.sma(c, 50)); const s200 = end(Ind.sma(c, 200)); const s20was = Ind.sma(c, 20)[c.length - 6];
  const rsi = end(Ind.rsi(c, 14)); const m = Ind.macd(c); const hist = end(m.hist); const before = m.hist[m.hist.length - 4];
  const a = end(Ind.atr(bars, 14)); const bb = Ind.bollinger(c, 20, 2); const up = end(bb.upper); const lo = end(bb.lower);
  const widths = bb.width.filter(ok).slice(-120); const tight = widths.length > 40 ? widths.filter((x) => x < end(widths)).length / widths.length : null;
  const d = adx(bars); const st = stochastic(bars); const o = obv(bars); const oDir = (end(o) - o[Math.max(0, o.length - 21)]) / ((bars.slice(-20).reduce((x, b) => x + (b.volume || 0), 0)) || 1);
  const vols = bars.slice(-21, -1).map((b) => b.volume || 0); const rv = (end(bars).volume || 0) / ((vols.reduce((x, y) => x + y, 0) / vols.length) || 1);
  const sr = supportResistance(bars.slice(-250), px, a); const tr = trendStructure(sr, {});
  const R = []; const add = (group, id, score, value, name, what, todo) => R.push({ group, id, score: Math.round(clamp(score) * 100) / 100, value, name, what, todo });
  if (ok(s50)) {
    const over = [s20, s50, s200].filter(ok); const above = over.filter((x) => px > x).length; const sc = (above / over.length) * 2 - 1;
    add('trend', 'averages', sc, `${above}/${over.length}`, T('المتوسطات المتحركة 20 و50 و200', 'Moving averages 20, 50, 200'), sc > 0.3 ? T('السعر فوق معظم المتوسطات، فالاتجاه صاعد', 'The price is above most averages, so the direction is up') : sc < -0.3 ? T('السعر تحت معظم المتوسطات، فالاتجاه هابط', 'The price is below most averages, so the direction is down') : T('السعر بين المتوسطات، فلا اتجاه واضح', 'The price sits between the averages, so there is no clear direction'), sc > 0.3 ? T('فضّل الشراء عند النزول إلى المتوسط، لا بعد قفزة', 'Prefer buying a dip to the average, not after a jump') : sc < -0.3 ? T('لا تشترِ قبل أن يعود فوق متوسط 50', 'Do not buy before it returns above the 50 average') : T('انتظر الخروج من هذا النطاق', 'Wait for it to leave this range'));
    add('trend', 'slope', ok(s20was) ? ((s20 / s20was - 1) * 100) / 2 : 0, `${((s20 / s20was - 1) * 100).toFixed(1)}%`, T('ميل المتوسط 20', 'Slope of the 20 average'), s20 > s20was ? T('المتوسط يرتفع', 'The average is rising') : T('المتوسط ينخفض', 'The average is falling'), s20 > s20was ? T('الزخم مع المشترين الآن', 'Momentum is with buyers now') : T('لا تستعجل، فالبائعون أقوى الآن', 'Do not hurry; sellers are stronger now'));
  }
  if (d && ok(d.adx)) { const dir = d.plus > d.minus ? 1 : -1; add('trend', 'strength', d.adx < 20 ? 0 : dir * Math.min(1, d.adx / 45), d.adx.toFixed(0), T('قوة الاتجاه (ADX)', 'Trend strength (ADX)'), d.adx < 20 ? T('لا يوجد اتجاه قوي، والسعر يتحرك في نطاق', 'There is no strong trend; the price moves in a range') : dir > 0 ? T('اتجاه صاعد قوي', 'A strong upward trend') : T('اتجاه هابط قوي', 'A strong downward trend'), d.adx < 20 ? T('في النطاق: اشترِ قرب الدعم وبِع قرب المقاومة', 'In a range: buy near support and sell near resistance') : dir > 0 ? T('امشِ مع الاتجاه، وارفع الوقف معه', 'Go with the trend and raise the stop with it') : T('تجنب الشراء ضد اتجاه هابط قوي', 'Avoid buying against a strong fall')); }
  const up2 = tr.structure.startsWith('UP'); const dn2 = tr.structure.startsWith('DOWN');
  add('trend', 'swings', up2 ? 0.7 : dn2 ? -0.7 : 0, '', T('القمم والقيعان', 'Highs and lows'), up2 ? T('قمم وقيعان أعلى من سابقتها', 'Higher highs and higher lows') : dn2 ? T('قمم وقيعان أدنى من سابقتها', 'Lower highs and lower lows') : T('القمم والقيعان غير منتظمة', 'Highs and lows are mixed'), up2 ? T('الاتجاه قائم ما لم ينكسر آخر قاع', 'The trend holds unless the last low breaks') : dn2 ? T('انتظر قمة أعلى من السابقة', 'Wait for a higher high') : T('انتظر حتى يتضح', 'Wait until it clears up'));
  if (ok(rsi)) add('momentum', 'rsi', rsi < 30 ? 0.35 : rsi > 70 ? -0.35 : (rsi - 50) / 50, rsi.toFixed(0), T('مؤشر القوة النسبية (RSI)', 'Relative strength index (RSI)'), rsi > 70 ? T('ارتفع بسرعة وقد يهدأ', 'It rose fast and may cool down') : rsi < 30 ? T('انخفض بسرعة وقد يرتد', 'It fell fast and may bounce') : rsi >= 50 ? T('المشترون أقوى قليلًا', 'Buyers are a little stronger') : T('البائعون أقوى قليلًا', 'Sellers are a little stronger'), rsi > 70 ? T('لا تلاحقه الآن، ومن يملكه يرفع الوقف', 'Do not chase it; holders raise the stop') : rsi < 30 ? T('انتظر يوم صعود يؤكد الارتداد', 'Wait for an up day that confirms a bounce') : T('لا إشارة وحدها، فانظر إلى الاتجاه', 'No signal alone; look at the trend'));
  if (ok(hist) && ok(before)) add('momentum', 'macd', clamp((hist / (a || 1)) * 3) * 0.6 + (hist > before ? 0.25 : -0.25), hist > 0 ? '+' : '−', T('تقارب المتوسطات (MACD)', 'MACD'), hist > 0 ? (hist > before ? T('الزخم صاعد ويزداد', 'Momentum is up and growing') : T('الزخم صاعد لكنه يضعف', 'Momentum is up but weakening')) : hist > before ? T('الزخم هابط لكنه يتحسن', 'Momentum is down but improving') : T('الزخم هابط ويزداد', 'Momentum is down and growing'), hist > 0 && hist > before ? T('يدعم الشراء إن كان الاتجاه صاعدًا', 'Supports buying if the trend is up') : hist > 0 ? T('لا تضف كمية جديدة الآن', 'Do not add more now') : hist > before ? T('راقب تحوله إلى الصعود', 'Watch for it to turn up') : T('انتظر', 'Wait'));
  add('momentum', 'stoch', st < 20 ? 0.25 : st > 80 ? -0.25 : 0, st.toFixed(0), T('موضع السعر من آخر 14 (Stochastic)', 'Place in the last 14 (Stochastic)'), st > 80 ? T('قرب أعلى ما بلغه', 'Near its recent top') : st < 20 ? T('قرب أدنى ما بلغه', 'Near its recent bottom') : T('في الوسط', 'In the middle'), st > 80 ? T('البداية هنا غالية', 'A start here is expensive') : st < 20 ? T('بداية أرخص، بشرط أن يثبت', 'A cheaper start, if it holds') : T('لا إشارة', 'No signal'));
  if (ok(up) && ok(lo)) add('volatility', 'bands', px > up ? -0.25 : px < lo ? 0.25 : 0, `${Math.round(((px - lo) / (up - lo || 1)) * 100)}%`, T('نطاق الحركة المعتادة (Bollinger)', 'Usual range (Bollinger)'), px > up ? T('خرج فوق نطاقه المعتاد', 'Above its usual range') : px < lo ? T('خرج تحت نطاقه المعتاد', 'Below its usual range') : T('داخل نطاقه المعتاد', 'Inside its usual range'), ok(tight) && tight < 0.15 ? T('النطاق ضيق جدًا، وقد تأتي حركة كبيرة. ضع أمرًا فوق المقاومة', 'The range is very tight and a big move may follow. Place an order above resistance') : px > up ? T('انتظر عودته إلى النطاق', 'Wait for it to come back inside') : T('لا إجراء', 'Nothing to do'));
  if (ok(a)) add('volatility', 'atr', 0, `${((a / px) * 100).toFixed(1)}%`, T('الحركة المعتادة (ATR)', 'Usual move (ATR)'), T(`يتحرك عادة نحو ${((a / px) * 100).toFixed(1)}% في كل ${unit.ar}`, `It usually moves about ${((a / px) * 100).toFixed(1)}% per ${unit.en}`), T('اجعل الوقف أبعد من هذه الحركة حتى لا يُضرب بلا سبب', 'Keep the stop further than this so noise does not hit it'));
  if (vols.some((v) => v > 0)) { const day = end(c) >= c[c.length - 2] ? 1 : -1; add('volume', 'flow', clamp(oDir * 1.5), `${oDir > 0 ? '+' : ''}${Math.round(oDir * 100)}%`, T('تدفق الكميات (OBV)', 'Volume flow (OBV)'), oDir > 0.08 ? T('كميات أيام الصعود أكبر', 'Up days carry more volume') : oDir < -0.08 ? T('كميات أيام النزول أكبر', 'Down days carry more volume') : T('الكميات متوازنة', 'Volume is balanced'), oDir > 0.08 ? T('الكميات تؤيد الصعود', 'Volume backs the rise') : oDir < -0.08 ? T('احذر ارتفاعًا بلا كميات', 'Beware of a rise without volume') : T('لا إشارة', 'No signal')); if (rv > 1.6) add('volume', 'burst', day * Math.min(0.6, rv / 5), `${rv.toFixed(1)}×`, T('كمية غير معتادة', 'Unusual volume'), day > 0 ? T('صعود بكمية كبيرة', 'A rise on heavy volume') : T('نزول بكمية كبيرة', 'A fall on heavy volume'), day > 0 ? T('اهتمام حقيقي، وانتظر ثبات السعر', 'Real interest; wait for the price to hold') : T('لا تلتقط سعرًا ينزل بكمية كبيرة', 'Do not catch a price falling on heavy volume')); }
  for (const s of shapes(bars)) add('pattern', s.id, s.s, '', T('شكل على الرسم', 'Chart shape'), s.t, s.s > 0 ? T('ينتظر تأكيدًا بإغلاق أعلى', 'Needs a higher close to confirm') : T('ينتظر تأكيدًا بإغلاق أدنى', 'Needs a lower close to confirm'));
  const W = { trend: 0.45, momentum: 0.25, volume: 0.15, pattern: 0.1, volatility: 0.05 };
  let score = 0; let weight = 0; const groups = {};
  for (const [g, w] of Object.entries(W)) { const l = R.filter((r) => r.group === g && r.id !== 'atr'); if (!l.length) continue; const v = l.reduce((x, r) => x + r.score, 0) / l.length; groups[g] = Math.round(v * 100) / 100; score += v * w; weight += w; }
  score = weight ? score / weight : 0;
  return { score: Math.round(score * 100) / 100, view: score > 0.45 ? 'STRONG_UP' : score > 0.15 ? 'UP' : score < -0.45 ? 'STRONG_DOWN' : score < -0.15 ? 'DOWN' : 'SIDE', groups, readings: R, atr: a, price: px, support: sr.support.map((x) => ({ price: tidy(x.price), touches: x.touches })), resistance: sr.resistance.map((x) => ({ price: tidy(x.price), touches: x.touches })), s20, s50, s200, adx: d ? d.adx : null };
}

// ---------------------------------------------------------------- how signals did on this symbol
function events(bars) {
  const c = bars.map((b) => b.close); const s20 = Ind.sma(c, 20); const s50 = Ind.sma(c, 50); const s200 = Ind.sma(c, 200); const rsi = Ind.rsi(c, 14); const h = Ind.macd(c).hist; const bb = Ind.bollinger(c, 20, 2); const a = Ind.atr(bars, 14);
  return {
    golden: [T('متوسط 50 يتجاوز متوسط 200', 'The 50 average crosses above the 200'), (i) => s50[i] > s200[i] && s50[i - 1] <= s200[i - 1]],
    macd: [T('تقاطع MACD للأعلى', 'MACD turns up'), (i) => h[i] > 0 && h[i - 1] <= 0],
    rsi: [T('RSI يعود فوق 30', 'RSI returns above 30'), (i) => rsi[i] >= 30 && rsi[i - 1] < 30],
    breakout: [T('تجاوز أعلى سعر في 20 يومًا', 'Breaks the 20-day high'), (i) => { if (i < 21) return false; const top = Math.max(...bars.slice(i - 20, i).map((b) => b.high)); return c[i] > top && c[i - 1] <= top; }],
    dip: [T('نزول إلى متوسط 50 في اتجاه صاعد', 'Dip to the 50 average in an uptrend'), (i) => s50[i] > s200[i] && bars[i].low <= s50[i] + 0.2 * a[i] && bars[i - 1].low > s50[i - 1] + 0.2 * a[i - 1] && c[i] > s50[i]],
    band: [T('إغلاق تحت النطاق المعتاد', 'Closes under the usual range'), (i) => c[i] < bb.lower[i] && c[i - 1] >= bb.lower[i - 1]],
    cross: [T('تجاوز متوسط 20 للأعلى', 'Crosses above the 20 average'), (i) => c[i] > s20[i] && c[i - 1] <= s20[i - 1]],
  };
}
function record(bars, ahead = 10) {
  if (bars.length < 260) return [];
  const ret = (i) => bars[i + ahead].close / bars[i + 1].open - 1;
  const first = 205; const lastI = bars.length - 1 - ahead; let base = 0; let n = 0; let up = 0;
  for (let i = first; i <= lastI; i++) { const r = ret(i); if (ok(r)) { base += r; n++; if (r > 0) up++; } }
  if (n < 50) return [];
  base /= n; up /= n;
  return Object.entries(events(bars)).map(([id, [name, f]]) => {
    const hits = []; let now = false; let next = first;
    for (let i = first; i < bars.length; i++) if (f(i)) { if (i >= bars.length - 3) now = true; if (i <= lastI && i >= next) { hits.push(ret(i)); next = i + ahead; } } // one at a time, so the same move is not counted twice
    const avg = hits.length ? hits.reduce((x, y) => x + y, 0) / hits.length : null;
    return { id, name, now, times: hits.length, won: hits.length ? hits.filter((x) => x > 0).length / hits.length : null, average: avg, usual: base, usualWon: up, useful: hits.length >= 12 && avg > base + 0.004 && hits.filter((x) => x > 0).length / hits.length > up };
  });
}

// ---------------------------------------------------------------- ready orders
function setups(d, w, bars, { held = 0, price }) {
  const px = price || d.price; const a = d.atr; const out = [];
  if (!(a > 0)) return out;
  const down = d.view.includes('DOWN') || (w && w.view === 'STRONG_DOWN');
  const strong = d.view === 'STRONG_DOWN';
  const push = (id, type, entry, stop, target, why, practice) => {
    if (!(stop > 0 && stop < entry && entry < target)) return;
    const o = odds(bars, { entry, stop, target, days: 20 }, { paths: 1500 });
    out.push({ id, side: 'BUY', type, price: tidy(entry), stop: tidy(stop), target: tidy(target), ratio: Math.round(((target - entry) / (entry - stop)) * 10) / 10, odds: o, against: down, why, practice });
  };
  const sup = d.support.find((x) => x.price < px - 0.3 * a); const res = d.resistance.find((x) => x.price > px + 0.3 * a);
  if (sup && !strong) { const e = sup.price + 0.1 * a; const s = sup.price - a; push('DIP', 'LIMIT', e, s, Math.max(res ? res.price - 0.1 * a : 0, e + 1.5 * (e - s)), T(`الدعم عند ${sup.price} أوقف النزول ${sup.touches} مرات`, `Support at ${sup.price} stopped falls ${sup.touches} times`), T('ضع أمر شراء ينتظر عند الدعم. إن كُسر الدعم فالفكرة خاطئة، ولذلك الوقف تحته.', 'Leave a buy order waiting at support. If support breaks the idea was wrong, so the stop sits under it.')); }
  if (res) { const e = res.price + 0.15 * a; const s = res.price - 1.2 * a; push('BREAK', 'STOP', e, s, e + 2 * (e - s), T(`المقاومة عند ${res.price} أوقفت الصعود ${res.touches} مرات`, `Resistance at ${res.price} stopped rises ${res.touches} times`), T('ضع أمر شراء ينتظر فوق المقاومة. لا يُنفذ إلا إذا أثبت السعر قوته.', 'Leave a buy order waiting above resistance. It runs only if the price proves its strength.')); }
  if (held > 0) { const s = (sup ? sup.price : d.s50 && d.s50 < px ? d.s50 : px - 2 * a) - 0.5 * a; if (s > 0 && s < px) out.push({ id: 'PROTECT', side: 'SELL', type: 'STOP', price: tidy(s), why: T('يحمي ما تملكه إذا كُسر الدعم', 'Protects what you hold if support breaks'), practice: T('ضع أمر بيع ينتظر تحت الدعم، وارفعه كلما ارتفع السعر.', 'Leave a sell order waiting under support and raise it as the price rises.') }); }
  return out;
}

function analyze({ daily, hourly, price, held = 0 }) {
  const d = read(daily, T('يوم', 'day'));
  if (!d) return null;
  const wb = weekly(daily); const w = read(wb, T('أسبوع', 'week')); const h = hourly && hourly.length >= 60 ? read(hourly, T('ساعة', 'hour')) : null;
  const parts = [[d, 0.5], [w, 0.35], [h, 0.15]].filter(([x]) => x); const tw = parts.reduce((x, [, k]) => x + k, 0);
  const score = parts.reduce((x, [p, k]) => x + p.score * k, 0) / tw;
  const signs = parts.map(([p]) => Math.sign(Math.abs(p.score) > 0.15 ? p.score : 0)); const agree = signs.every((s) => s === signs[0] && s !== 0);
  const steps = [];
  steps.push(score > 0.45 ? T('الاتجاه صاعد بوضوح. فضّل الشراء، لكن بسعر محدد لا بأي سعر.', 'The direction is clearly up. Prefer buying, but at a set price, not any price.') : score > 0.15 ? T('الميل صاعد. اشترِ عند النزول أو بعد تجاوز المقاومة.', 'It leans up. Buy a dip or after it passes resistance.') : score < -0.45 ? T('الاتجاه هابط بوضوح. لا تشترِ الآن.', 'The direction is clearly down. Do not buy now.') : score < -0.15 ? T('الميل هابط. لا شراء إلا بعد تجاوز المقاومة.', 'It leans down. Buy only after it passes resistance.') : T('لا اتجاه واضح. الانتظار قرار.', 'No clear direction. Waiting is a decision.'));
  if (!agree) steps.push(T('المُدد الثلاث غير متفقة، فقلّل المبلغ.', 'The three horizons disagree, so use a smaller amount.'));
  steps.push(T(`لا تضع الوقف أقرب من ${tidy(d.atr)} دولار من سعر البداية.`, `Do not put the stop closer than $${tidy(d.atr)} to the start.`));
  if (daily.length > 1 && Math.abs(end(daily).close / daily[daily.length - 2].close - 1) > 0.1) steps.push(T('تحرك السعر أكثر من 10% في يوم. المستويات القديمة أقل موثوقية الآن.', 'The price moved more than 10% in one day. Old levels are less reliable now.'));
  return { score: Math.round(score * 100) / 100, view: score > 0.45 ? 'STRONG_UP' : score > 0.15 ? 'UP' : score < -0.45 ? 'STRONG_DOWN' : score < -0.15 ? 'DOWN' : 'SIDE', agree, price: price || d.price, steps, horizons: { hours: h, days: d, weeks: w }, record: record(daily), setups: setups(d, w, daily, { held, price }) };
}

/** A past moment to practise on: the chart up to a day, the readings then, and what came next. */
function practice(daily, seed) {
  if (daily.length < 330) return null;
  const r = rng(seed); const i = 260 + Math.floor(r() * (daily.length - 260 - 16));
  const past = daily.slice(Math.max(0, i - 400), i + 1); const d = read(past, T('يوم', 'day'));
  const k = 100 / past[past.length - 1].close; const scale = (b) => ({ o: b.open * k, h: b.high * k, l: b.low * k, c: b.close * k });
  const next = daily.slice(i + 1, i + 16);
  return { bars: past.slice(-70).map(scale), next: next.map(scale), view: d.view, score: d.score, readings: d.readings.filter((x) => Math.abs(x.score) >= 0.2).sort((p, q) => Math.abs(q.score) - Math.abs(p.score)).slice(0, 5).map((x) => ({ name: x.name, what: x.what, score: x.score })), change: end(next).close / next[0].open - 1, worst: Math.min(...next.map((b) => b.low)) / next[0].open - 1, move: d.atr / d.price };
}

module.exports = { analyze, practice, read, record, setups, weekly, adx, shapes };
