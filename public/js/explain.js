/* Plain-language explanations of APP-COMPUTED chart data (candles, patterns, levels, swings, structure).
 * Every sentence is built from actual numbers; nothing here predicts prices. */
(function () {
  'use strict';
  const I = window.I18N;
  const ar = () => I.lang === 'ar';
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const n = (x, d = 2) => (isNum(x) ? I.iso(x.toFixed(d)) : '—');
  const px = (x) => (isNum(x) ? I.iso(x.toFixed(Math.abs(x) >= 1 ? 2 : 4)) : '—');
  const pct = (x, d = 1) => (isNum(x) ? I.iso(`${x.toFixed(d)}%`) : '—');
  const L = (a, e) => (ar() ? a : e);

  const RANK_AR = { S1: 'دعم أول', S2: 'دعم ثانٍ', S3: 'دعم ثالث', S4: 'دعم رابع', R1: 'مقاومة أولى', R2: 'مقاومة ثانية', R3: 'مقاومة ثالثة', R4: 'مقاومة رابعة' };
  const RANK_EN = { S1: 'Support 1', S2: 'Support 2', S3: 'Support 3', S4: 'Support 4', R1: 'Resistance 1', R2: 'Resistance 2', R3: 'Resistance 3', R4: 'Resistance 4' };
  function levelName(l) {
    if (l.rank) return ar() ? RANK_AR[l.rank] : RANK_EN[l.rank];
    if (l.status === 'broken') return l.origin === 'support' ? L('دعم سابق مكسور', 'Broken former support') : L('مقاومة سابقة مكسورة', 'Broken former resistance');
    return l.role === 'support' ? L('مستوى دعم', 'Support level') : l.role === 'resistance' ? L('مستوى مقاومة', 'Resistance level') : L('مستوى فني', 'Technical level');
  }
  function strengthWord(s) {
    if (s >= 60) return L('قوي', 'strong');
    if (s >= 35) return L('متوسط', 'moderate');
    return L('ضعيف', 'weak');
  }
  const SRC = {
    swings: ['قمم/قيعان مؤكدة', 'confirmed swings'], prevSessionHigh: ['أعلى سعر في الجلسة السابقة', 'previous session high'],
    prevSessionLow: ['أدنى سعر في الجلسة السابقة', 'previous session low'], volumeConcentration: ['منطقة تركز حجم التداول', 'volume concentration'],
  };
  const when = (sec) => (isNum(sec) ? `${U.etDate(sec * 1000)} ${U.etHM(sec * 1000)}` : '—');

  function level(l, price) {
    const rows = [
      [L('السعر', 'Price'), px(l.price)],
      [L('المنطقة', 'Zone'), `${px(l.zoneLow)} – ${px(l.zoneHigh)}`],
      [L('تقدير القوة', 'Strength estimate'), `${I.iso(String(l.strength))}/100 (${strengthWord(l.strength)})`],
      [L('ردود الفعل المؤكدة', 'Confirmed reactions'), I.iso(String(l.reactions))],
      [L('عدد مرات اختبار المنطقة', 'Visits to the zone'), I.iso(String(l.interactions))],
      [L('آخر تفاعل', 'Last interaction'), when(l.lastInteraction)],
      [L('الحالة', 'Status'), l.status === 'broken' ? L(`غير فعّال — كُسر بإغلاق في ${when(l.brokenAt)}`, `Invalidated — broken by a close at ${when(l.brokenAt)}`) : L('فعّال', 'Active')],
      [L('الأساس', 'Basis'), l.sources.map((s) => (SRC[s] ? SRC[s][ar() ? 0 : 1] : s)).join(L('، ', ', '))],
    ];
    if (isNum(price)) rows.push([L('المسافة من السعر الحالي', 'Distance from price'), pct(((l.price - price) / price) * 100, 2)]);
    return {
      title: `${levelName(l)} ${px(l.price)}`, rows,
      note: L('الدعم والمقاومة مناطق تفاعل فيها السعر سابقًا؛ لا تضمن حدوث ردة فعل مستقبلية.', 'Support and resistance are areas where price reacted before; they do not guarantee a future reaction.'),
    };
  }

  function swing(p) {
    const lab = p.label === 'EQ' ? (p.type === 'H' ? 'EQH' : 'EQL') : (p.label || p.type);
    const name = I.en('swing', lab);
    const prev = isNum(p.prevPrice) ? L(` مقارنة بالسابقة ${px(p.prevPrice)}`, ` vs previous ${px(p.prevPrice)}`) : '';
    return {
      title: `${name} ${px(p.price)}`,
      text: L(`${p.type === 'H' ? 'قمة' : 'قاع'} محلية مؤكدة عند ${px(p.price)}${prev}. تشكلت في ${when(p.time)} وتأكدت عند إغلاق الشمعة الثالثة بعدها (${when(p.confirmedAt)}) — لم تكن معروفة قبل ذلك.`,
        `Confirmed local ${p.type === 'H' ? 'top' : 'bottom'} at ${px(p.price)}${prev}. Formed at ${when(p.time)} and confirmed when the 3rd candle after it closed (${when(p.confirmedAt)}) — it was not known before then.`),
    };
  }

  function provisional(p) {
    return L(`${p.type === 'H' ? 'قمة' : 'قاع'} مؤقت(ة) غير مؤكد(ة) عند ${px(p.price)} — يحتاج ${I.iso(String(p.barsToConfirm))} شمعة مكتملة إضافية دون تجاوزه للتأكيد.`,
      `Provisional ${p.type === 'H' ? 'top' : 'bottom'} at ${px(p.price)} — needs ${p.barsToConfirm} more completed candle(s) without being exceeded to be confirmed.`);
  }

  function breakEvent(e) {
    const up = e.type === 'BREAKOUT';
    return {
      title: up ? L('اختراق المقاومة', 'Breakout') : L('كسر الدعم', 'Breakdown'),
      text: L(`${up ? 'أغلقت الشمعة فوق' : 'أغلقت الشمعة دون'} ${up ? 'القمة' : 'القاع'} المؤكدة ${px(e.level)} عند ${px(e.close)} في ${when(e.time)}. الحجم النسبي ${isNum(e.relVol) ? `${n(e.relVol)}x` : 'غير متاح'} — ${e.volumeConfirmed ? 'مدعوم بحجم أعلى من المتوسط (≥1.5x).' : 'غير مدعوم بحجم مرتفع، فالتأكيد أضعف.'}`,
        `A candle closed ${up ? 'above' : 'below'} the confirmed swing ${up ? 'high' : 'low'} ${px(e.level)} at ${px(e.close)} on ${when(e.time)}. Relative volume ${isNum(e.relVol) ? `${n(e.relVol)}x` : 'n/a'} — ${e.volumeConfirmed ? 'backed by above-average volume (≥1.5x).' : 'not backed by high volume, so the confirmation is weaker.'}`),
    };
  }

  function trendline(t) {
    const up = t.kind === 'SUPPORT_UP';
    return {
      title: up ? L('خط اتجاه صاعد (دعم)', 'Rising trend line (support)') : L('خط اتجاه هابط (مقاومة)', 'Falling trend line (resistance)'),
      text: L(`يمر عبر ${up ? 'القاعين' : 'القمتين'} المؤكدين ${px(t.from.price)} و${px(t.to.price)}. ${t.status === 'broken' ? `كُسر بإغلاق في ${when(t.brokenAt)}.` : `قيمته الحالية نحو ${px(t.priceNow)}، ولامسه السعر ${I.iso(String(t.touches))} مرة.`}`,
        `Drawn through the confirmed swing ${up ? 'lows' : 'highs'} ${px(t.from.price)} and ${px(t.to.price)}. ${t.status === 'broken' ? `Broken by a close at ${when(t.brokenAt)}.` : `Currently near ${px(t.priceNow)}; touched ${t.touches} time(s).`}`),
    };
  }

  function range(r) {
    return {
      title: L('نطاق تداول', 'Trading range'),
      text: L(`تحرك السعر بين ${px(r.low)} و${px(r.high)} خلال آخر ${I.iso(String(r.bars))} شمعة (ارتفاع النطاق ${n(r.heightAtr, 1)}× ATR). الخروج بإغلاق خارج النطاق قد يشير إلى بداية حركة جديدة.`,
        `Price moved between ${px(r.low)} and ${px(r.high)} over the last ${r.bars} candles (range height ${n(r.heightAtr, 1)}× ATR). A close outside the range may mark the start of a new move.`),
    };
  }

  const PAT = {
    HAMMER: {
      why: (c) => L(`ظل سفلي يساوي ${n(c.lowerWickToBody, 1)} ضعف الجسم، وظل علوي ${pct(c.upperWickPctOfRange)} فقط من المدى، والجسم ${pct(c.bodyPctOfRange)} من المدى، بعد هبوط بمقدار ${n(Math.abs(c.priorMoveAtr), 1)}× ATR خلال 5 شموع.`, `Lower wick ${n(c.lowerWickToBody, 1)}× the body, upper wick only ${pct(c.upperWickPctOfRange)} of the range, body ${pct(c.bodyPctOfRange)}, after a ${n(Math.abs(c.priorMoveAtr), 1)}× ATR decline over 5 candles.`),
      meaning: () => L('رفض للأسعار المنخفضة وظهور طلب، وقد يسبق ارتدادًا صاعدًا.', 'Rejection of lower prices and emerging demand; may precede a bounce.'),
    },
    SHOOTING_STAR: {
      why: (c) => L(`ظل علوي يساوي ${n(c.upperWickToBody, 1)} ضعف الجسم، وظل سفلي ${pct(c.lowerWickPctOfRange)} فقط، والجسم ${pct(c.bodyPctOfRange)} من المدى، بعد صعود بمقدار ${n(c.priorMoveAtr, 1)}× ATR.`, `Upper wick ${n(c.upperWickToBody, 1)}× the body, lower wick only ${pct(c.lowerWickPctOfRange)}, body ${pct(c.bodyPctOfRange)}, after a ${n(c.priorMoveAtr, 1)}× ATR advance.`),
      meaning: () => L('رفض للأسعار المرتفعة وظهور عرض (بيع)، وقد يسبق تراجعًا.', 'Rejection of higher prices and emerging supply; may precede a pullback.'),
    },
    DOJI: {
      why: (c) => L(`الجسم ${pct(c.bodyPctOfRange)} فقط من مدى الشمعة، والمدى ${n(c.rangeAtr, 2)}× ATR، بعد حركة ${c.priorMoveAtr > 0 ? 'صاعدة' : 'هابطة'} بمقدار ${n(Math.abs(c.priorMoveAtr), 1)}× ATR.`, `Body only ${pct(c.bodyPctOfRange)} of the range, range ${n(c.rangeAtr, 2)}× ATR, after a ${c.priorMoveAtr > 0 ? 'rise' : 'decline'} of ${n(Math.abs(c.priorMoveAtr), 1)}× ATR.`),
      meaning: () => L('تردد وتوازن بين المشترين والبائعين بعد حركة اتجاهية؛ قد يسبق تباطؤ الحركة أو انعكاسها.', 'Indecision after a directional move; may precede a pause or a reversal.'),
    },
    BULLISH_ENGULFING: {
      why: (c) => L(`جسم الشمعة الصاعدة يغطي جسم الشمعة الهابطة السابقة بالكامل (${n(c.bodyRatio, 2)} ضعف حجمها) بعد هبوط بمقدار ${n(Math.abs(c.priorMoveAtr), 1)}× ATR.`, `The bullish body fully covers the previous bearish body (${n(c.bodyRatio, 2)}× its size) after a ${n(Math.abs(c.priorMoveAtr), 1)}× ATR decline.`),
      meaning: () => L('تحول السيطرة إلى المشترين خلال شمعتين؛ إشارة انعكاس صاعد محتملة.', 'Control shifts to buyers within two candles; a possible bullish reversal.'),
    },
    BEARISH_ENGULFING: {
      why: (c) => L(`جسم الشمعة الهابطة يغطي جسم الشمعة الصاعدة السابقة بالكامل (${n(c.bodyRatio, 2)} ضعف حجمها) بعد صعود بمقدار ${n(c.priorMoveAtr, 1)}× ATR.`, `The bearish body fully covers the previous bullish body (${n(c.bodyRatio, 2)}× its size) after a ${n(c.priorMoveAtr, 1)}× ATR advance.`),
      meaning: () => L('تحول السيطرة إلى البائعين؛ إشارة انعكاس هابط محتملة.', 'Control shifts to sellers; a possible bearish reversal.'),
    },
    MORNING_STAR: {
      why: (c) => L(`شمعة هابطة كبيرة (${n(c.firstBodyAtr, 1)}× ATR)، ثم شمعة صغيرة (${pct(c.middleToFirstBody * 100, 0)} من جسم الأولى)، ثم شمعة صاعدة أغلقت فوق منتصف جسم الأولى، بعد هبوط.`, `A large bearish candle (${n(c.firstBodyAtr, 1)}× ATR), a small candle (${pct(c.middleToFirstBody * 100, 0)} of the first body), then a bullish candle closing above the first body's midpoint, after a decline.`),
      meaning: () => L('نمط انعكاس صاعد من ثلاث شموع يدل على تراجع ضغط البيع.', 'A three-candle bullish reversal showing fading selling pressure.'),
    },
    EVENING_STAR: {
      why: (c) => L(`شمعة صاعدة كبيرة (${n(c.firstBodyAtr, 1)}× ATR)، ثم شمعة صغيرة (${pct(c.middleToFirstBody * 100, 0)} من جسم الأولى)، ثم شمعة هابطة أغلقت دون منتصف جسم الأولى، بعد صعود.`, `A large bullish candle (${n(c.firstBodyAtr, 1)}× ATR), a small candle (${pct(c.middleToFirstBody * 100, 0)} of the first body), then a bearish candle closing below the first body's midpoint, after an advance.`),
      meaning: () => L('نمط انعكاس هابط من ثلاث شموع يدل على تراجع ضغط الشراء.', 'A three-candle bearish reversal showing fading buying pressure.'),
    },
  };

  function pattern(p, ctx = {}) {
    const d = PAT[p.code];
    const near = ctx.near;
    const context = [];
    context.push(L(`الاتجاه قبل النمط: ${p.priorTrend === 'UP' ? 'صاعد' : p.priorTrend === 'DOWN' ? 'هابط' : 'غير واضح'}.`, `Trend before the pattern: ${p.priorTrend === 'UP' ? 'up' : p.priorTrend === 'DOWN' ? 'down' : 'unclear'}.`));
    if (near) context.push(L(`أقرب مستوى: ${near.name} عند ${px(near.price)} (${near.touched ? 'لامسته الشمعة' : `على بعد ${pct(near.distancePct, 2)}`}).`, `Nearest level: ${near.name} at ${px(near.price)} (${near.touched ? 'touched by the candle' : `${pct(near.distancePct, 2)} away`}).`));
    const conf = p.confirmation.status;
    const confText = I.en('confirmation', conf) + (p.confirmation.at && conf !== 'AWAITING_NEXT_BAR' ? L(` (${when(p.confirmation.at)})`, ` (${when(p.confirmation.at)})`) : '');
    const needs = conf === 'CONFIRMED' ? L('حصل على تأكيد أولي، ويبقى بحاجة إلى متابعة السعر والحجم.', 'Initial confirmation received; still needs follow-through in price and volume.')
      : L(`يحتاج إلى تأكيد إضافي: ${p.direction === 'BULLISH' ? `إغلاق فوق ${px(p.high)}` : p.direction === 'BEARISH' ? `إغلاق دون ${px(p.low)}` : 'حركة واضحة تالية'}.`,
        `Needs additional confirmation: ${p.direction === 'BULLISH' ? `a close above ${px(p.high)}` : p.direction === 'BEARISH' ? `a close below ${px(p.low)}` : 'a clear follow-up move'}.`);
    return {
      name: I.en('pattern', p.code), where: when(p.time), why: d ? d.why(p.conditions) : '', meaning: d ? d.meaning() : '',
      context: context.join(' '), confirmation: confText, needs,
      disclaimer: L('أنماط الشموع ليست تنبؤات مضمونة؛ هي دلائل احتمالية تحتاج إلى سياق وتأكيد.', 'Candlestick patterns are not guaranteed predictions; they are probabilistic clues that need context and confirmation.'),
    };
  }

  const SHAPE = {
    LONG_LOWER_WICK: {
      UP: [(a) => L('شمعة صاعدة ذات ظل سفلي طويل', 'Bullish candle with a long lower wick'), (a) => L(`تُظهر هذه الشمعة أن السعر انخفض خلال الفترة إلى ${px(a.low)}، ثم ارتفع ليغلق عند ${px(a.close)} قرب أعلى نطاقها. قد يشير ذلك إلى ظهور طلب عند مستويات أقل، لكن الشمعة وحدها لا تؤكد انعكاس الاتجاه.`, `Price fell to ${px(a.low)} during the period, then rose to close at ${px(a.close)} near the top of its range. This may indicate demand at lower prices, but a single candle does not confirm a trend reversal.`)],
      DOWN: [(a) => L('شمعة هابطة ذات ظل سفلي طويل', 'Bearish candle with a long lower wick'), (a) => L(`هبط السعر إلى ${px(a.low)} ثم استعاد جزءًا كبيرًا من انخفاضه قبل الإغلاق عند ${px(a.close)}. يدل الظل السفلي على شراء عند الانخفاض، لكن إغلاق الشمعة دون افتتاحها يعني أن البائعين احتفظوا بالأفضلية في هذه الفترة.`, `Price dropped to ${px(a.low)} then recovered much of the fall before closing at ${px(a.close)}. The lower wick shows buying on the dip, but closing below the open means sellers kept the edge in this period.`)],
    },
    LONG_UPPER_WICK: {
      UP: [(a) => L('شمعة صاعدة ذات ظل علوي طويل', 'Bullish candle with a long upper wick'), (a) => L(`ارتفع السعر إلى ${px(a.high)} لكنه تراجع قبل الإغلاق عند ${px(a.close)}. قد يشير الظل العلوي إلى بيع عند المستويات المرتفعة رغم إغلاق الشمعة فوق افتتاحها.`, `Price rose to ${px(a.high)} but slipped back to close at ${px(a.close)}. The upper wick may reflect selling at higher prices even though the candle closed above its open.`)],
      DOWN: [(a) => L('شمعة هابطة ذات ظل علوي طويل', 'Bearish candle with a long upper wick'), (a) => L(`صعد السعر إلى ${px(a.high)} ثم رُفض وأغلق عند ${px(a.close)} قرب أدنى نطاقها. قد يعكس ذلك ضغط بيع عند المستويات الأعلى، لكنه لا يؤكد وحده انعكاسًا هابطًا.`, `Price rallied to ${px(a.high)}, was rejected, and closed at ${px(a.close)} near the low of its range. This may reflect selling pressure higher up, but it does not confirm a bearish reversal on its own.`)],
    },
    DOJI: { ANY: [(a) => L('شمعة دوجي (تردد)', 'Doji (indecision)'), (a) => L(`تقارب سعر الافتتاح (${px(a.open)}) وسعر الإغلاق (${px(a.close)})؛ الجسم ${pct(a.bodyPct)} فقط من المدى. يعكس ذلك توازنًا مؤقتًا بين المشترين والبائعين، وأهميتها تعتمد على موقعها من الاتجاه والمستويات.`, `Open (${px(a.open)}) and close (${px(a.close)}) are nearly equal; the body is only ${pct(a.bodyPct)} of the range. It reflects a temporary balance between buyers and sellers; its importance depends on trend and location.`)] },
    MARUBOZU: {
      UP: [(a) => L('شمعة صاعدة قوية شبه خالية من الظلال', 'Strong bullish candle with almost no wicks'), (a) => L(`افتُتحت قرب أدنى سعر وأُغلقت قرب أعلى سعر؛ الجسم ${pct(a.bodyPct)} من المدى. يدل ذلك على سيطرة واضحة للمشترين خلال هذه الفترة.`, `Opened near the low and closed near the high; the body is ${pct(a.bodyPct)} of the range — clear buyer control during the period.`)],
      DOWN: [(a) => L('شمعة هابطة قوية شبه خالية من الظلال', 'Strong bearish candle with almost no wicks'), (a) => L(`افتُتحت قرب أعلى سعر وأُغلقت قرب أدنى سعر؛ الجسم ${pct(a.bodyPct)} من المدى. يدل ذلك على سيطرة واضحة للبائعين خلال هذه الفترة.`, `Opened near the high and closed near the low; the body is ${pct(a.bodyPct)} of the range — clear seller control during the period.`)],
    },
    STRONG_BODY: {
      UP: [(a) => L('شمعة صاعدة ذات جسم كبير', 'Bullish candle with a large body'), (a) => L(`أغلق السعر عند ${px(a.close)} مرتفعًا عن الافتتاح ${px(a.open)}؛ الجسم ${pct(a.bodyPct)} من المدى، ما يدل على زخم شرائي واضح في هذه الفترة.`, `Closed at ${px(a.close)}, above the ${px(a.open)} open; the body is ${pct(a.bodyPct)} of the range — clear buying momentum in this period.`)],
      DOWN: [(a) => L('شمعة هابطة ذات جسم كبير', 'Bearish candle with a large body'), (a) => L(`أغلق السعر عند ${px(a.close)} منخفضًا عن الافتتاح ${px(a.open)}؛ الجسم ${pct(a.bodyPct)} من المدى، ما يدل على زخم بيعي واضح في هذه الفترة.`, `Closed at ${px(a.close)}, below the ${px(a.open)} open; the body is ${pct(a.bodyPct)} of the range — clear selling momentum in this period.`)],
    },
    SPINNING_TOP: { ANY: [(a) => L('قمة دوّارة (جسم صغير وظلان)', 'Spinning top (small body, two wicks)'), (a) => L(`جسم صغير (${pct(a.bodyPct)}) مع ظل علوي ${pct(a.upperPct)} وظل سفلي ${pct(a.lowerPct)} من المدى؛ يشير ذلك إلى تذبذب وتردد دون سيطرة واضحة لأي طرف.`, `Small body (${pct(a.bodyPct)}) with a ${pct(a.upperPct)} upper and ${pct(a.lowerPct)} lower wick — back-and-forth trading with no clear control.`)] },
    NORMAL: {
      UP: [(a) => L('شمعة صاعدة', 'Bullish candle'), (a) => L(`افتُتحت عند ${px(a.open)} وأُغلقت أعلى عند ${px(a.close)}؛ الجسم ${pct(a.bodyPct)} من المدى.`, `Opened at ${px(a.open)} and closed higher at ${px(a.close)}; the body is ${pct(a.bodyPct)} of the range.`)],
      DOWN: [(a) => L('شمعة هابطة', 'Bearish candle'), (a) => L(`افتُتحت عند ${px(a.open)} وأُغلقت أدنى عند ${px(a.close)}؛ الجسم ${pct(a.bodyPct)} من المدى.`, `Opened at ${px(a.open)} and closed lower at ${px(a.close)}; the body is ${pct(a.bodyPct)} of the range.`)],
    },
    FLAT: { ANY: [() => L('شمعة بلا حركة سعرية', 'Candle without price movement'), () => L('لم يتغير السعر خلال هذه الفترة (افتتاح = أعلى = أدنى = إغلاق).', 'Price did not move in this period (open = high = low = close).')] },
  };

  function candle(a, ctx = {}) {
    const s = SHAPE[a.shape] || SHAPE.NORMAL;
    const v = s[a.direction] || s.ANY || s.UP;
    const extras = [];
    if (isNum(a.rangeAtr)) {
      if (a.rangeAtr >= 1.5) extras.push(L(`مدى الشمعة ${n(a.rangeAtr, 1)}× متوسط المدى الحقيقي (ATR) — أوسع من المعتاد.`, `Range ${n(a.rangeAtr, 1)}× ATR — wider than usual.`));
      else if (a.rangeAtr <= 0.5) extras.push(L(`مدى الشمعة ${n(a.rangeAtr, 1)}× ATR — أضيق من المعتاد.`, `Range ${n(a.rangeAtr, 1)}× ATR — narrower than usual.`));
    }
    if (isNum(ctx.relVol)) extras.push(L(`حجم التداول ${n(ctx.relVol, 2)}× متوسط آخر 20 شمعة.`, `Volume ${n(ctx.relVol, 2)}× the average of the previous 20 candles.`));
    if (a.near) {
      const nm = a.near.rank ? (ar() ? RANK_AR[a.near.rank] : RANK_EN[a.near.rank]) : (a.near.origin === 'support' ? L('مستوى دعم', 'support level') : a.near.origin === 'resistance' ? L('مستوى مقاومة', 'resistance level') : L('مستوى فني', 'technical level'));
      const where = a.near.closeVsLevel === 'ABOVE' ? L('وأغلقت فوقه', 'and closed above it') : a.near.closeVsLevel === 'BELOW' ? L('وأغلقت دونه', 'and closed below it') : L('وأغلقت داخل منطقته', 'and closed inside its zone');
      extras.push(a.near.touched ? L(`لامست الشمعة ${nm} عند ${px(a.near.price)} ${where}.`, `The candle touched ${nm} at ${px(a.near.price)} ${where}.`)
        : L(`أقرب مستوى: ${nm} عند ${px(a.near.price)} (على بعد ${pct(a.near.distancePct, 2)}).`, `Nearest level: ${nm} at ${px(a.near.price)} (${pct(a.near.distancePct, 2)} away).`));
    }
    return { title: v[0](a), body: v[1](a), extras };
  }

  // ------------------------------------------------------------ chart explanation sections (computed part)
  function sections(tech, ind, opts = {}) {
    const out = {};
    if (!tech || !tech.available) return null;
    const st = tech.structure;
    const parts = [I.en('structure', st.code)];
    if (ind) {
      const { ema9, ema21, ema50, vwap, close } = ind;
      if ([ema9, ema21, ema50].every(isNum)) {
        if (ema9 > ema21 && ema21 > ema50) parts.push(L('المتوسطات المتحركة الأسية مرتبة صعوديًا (EMA9 > EMA21 > EMA50).', 'EMAs are stacked bullishly (EMA9 > EMA21 > EMA50).'));
        else if (ema9 < ema21 && ema21 < ema50) parts.push(L('المتوسطات المتحركة الأسية مرتبة هبوطيًا (EMA9 < EMA21 < EMA50).', 'EMAs are stacked bearishly (EMA9 < EMA21 < EMA50).'));
        else parts.push(L('ترتيب المتوسطات المتحركة الأسية مختلط.', 'EMA stack is mixed.'));
      }
      if (isNum(vwap) && isNum(close)) parts.push(close >= vwap ? L(`السعر ${px(close)} فوق VWAP ${px(vwap)}.`, `Price ${px(close)} is above VWAP ${px(vwap)}.`) : L(`السعر ${px(close)} دون VWAP ${px(vwap)}.`, `Price ${px(close)} is below VWAP ${px(vwap)}.`));
    }
    out.trend = parts.join(' ');
    const lh = st.lastHigh || tech.swings.highs[tech.swings.highs.length - 1];
    const ll = st.lastLow || tech.swings.lows[tech.swings.lows.length - 1];
    const sw = [];
    if (lh) sw.push(L(`آخر قمة مؤكدة ${px(lh.price)} (${I.en('swing', lh.label === 'EQ' ? 'EQH' : (lh.label || 'H'))}) في ${when(lh.time)}.`, `Latest confirmed high ${px(lh.price)} (${I.en('swing', lh.label === 'EQ' ? 'EQH' : (lh.label || 'H'))}) at ${when(lh.time)}.`));
    if (ll) sw.push(L(`آخر قاع مؤكد ${px(ll.price)} (${I.en('swing', ll.label === 'EQ' ? 'EQL' : (ll.label || 'L'))}) في ${when(ll.time)}.`, `Latest confirmed low ${px(ll.price)} (${I.en('swing', ll.label === 'EQ' ? 'EQL' : (ll.label || 'L'))}) at ${when(ll.time)}.`));
    const seq = { UPTREND: L('تسلسل القمم والقيعان الأعلى يدعم هيكلًا صاعدًا.', 'Higher highs and higher lows support a bullish structure.'), DOWNTREND: L('تسلسل القمم والقيعان الأدنى يدل على هيكل هابط.', 'Lower highs and lower lows point to a bearish structure.'), CONTRACTING: L('القمم تنخفض والقيعان ترتفع: نطاق يضيق قد يسبق حركة قوية.', 'Highs falling and lows rising: a tightening range that may precede a larger move.'), EXPANDING: L('قمة أعلى وقاع أدنى: تقلب متسع دون اتجاه واضح.', 'Higher high and lower low: widening swings without a clear direction.') }[st.code];
    if (seq) sw.push(seq);
    for (const p of tech.swings.provisional) sw.push(provisional(p));
    out.swings = sw.join(' ') || L('لا توجد قمم أو قيعان مؤكدة كافية.', 'Not enough confirmed highs and lows.');
    const lv = [];
    for (const l of [...tech.levels.resistances.slice(0, 2), ...tech.levels.supports.slice(0, 2)]) {
      lv.push(L(`${levelName(l)} ${px(l.price)} (ردود فعل مؤكدة: ${I.iso(String(l.reactions))}، القوة ${strengthWord(l.strength)}).`, `${levelName(l)} ${px(l.price)} (${l.reactions} confirmed reaction(s), ${strengthWord(l.strength)}).`));
    }
    for (const l of tech.levels.broken) lv.push(L(`${levelName(l)} ${px(l.price)} — غير فعّال منذ ${when(l.brokenAt)}.`, `${levelName(l)} ${px(l.price)} — invalidated since ${when(l.brokenAt)}.`));
    out.levels = lv.join(' ') || L('لا توجد مستويات دعم أو مقاومة فعّالة قريبة.', 'No active support or resistance nearby.');
    const recent = tech.patterns.filter((p) => p.index >= tech.bars - 20).slice(-3);
    const cd = recent.map((p) => L(`${I.en('pattern', p.code)} في ${when(p.time)} — ${I.en('confirmation', p.confirmation.status)}.`, `${I.en('pattern', p.code)} at ${when(p.time)} — ${I.en('confirmation', p.confirmation.status)}.`));
    if (tech.lastCandle) cd.push(L(`آخر شمعة مكتملة: ${candle(tech.lastCandle).title}.`, `Last completed candle: ${candle(tech.lastCandle).title}.`));
    out.candles = cd.join(' ');
    const v = tech.volume;
    if (v && v.available) {
      const vv = [];
      if (isNum(v.upDownRatio)) vv.push(v.upDownRatio >= 1.15 ? L(`متوسط حجم الشموع الصاعدة أعلى من الهابطة (${n(v.upDownRatio)}×) خلال آخر ${I.iso(String(v.bars))} شمعة — الحجم يدعم الحركة الصاعدة.`, `Up-candle volume averages ${n(v.upDownRatio)}× down-candle volume over the last ${v.bars} candles — volume supports the upside.`)
        : v.upDownRatio <= 0.87 ? L(`متوسط حجم الشموع الهابطة أعلى من الصاعدة (${n(1 / v.upDownRatio)}×) — الحجم يدعم ضغط البيع.`, `Down-candle volume averages ${n(1 / v.upDownRatio)}× up-candle volume — volume supports selling pressure.`)
          : L('حجم الشموع الصاعدة والهابطة متقارب — لا يؤكد الحجم اتجاهًا واضحًا.', 'Up and down candle volume are similar — volume does not confirm a direction.'));
      if (isNum(v.recentVsPrior)) vv.push(L(`حجم آخر 5 شموع ${n(v.recentVsPrior)}× ما قبلها.`, `Last 5 candles traded ${n(v.recentVsPrior)}× the volume of the prior ones.`));
      if (opts.partialVolume) vv.push(L('ملاحظة: حجم IEX يمثل جزءًا صغيرًا من حجم السوق الكلي.', 'Note: IEX volume is a small share of total market volume.'));
      out.volume = vv.join(' ');
    }
    const r1 = tech.levels.resistances[0];
    const s1 = tech.levels.supports[0];
    out.bull = r1 ? L(`يصبح الصعود أرجح بإغلاق فوق ${levelName(r1)} ${px(r1.zoneHigh)} مع حجم أعلى من المتوسط${s1 ? ` وبقاء السعر فوق ${px(s1.zoneLow)}` : ''}.`, `The bullish case strengthens on a close above ${levelName(r1)} ${px(r1.zoneHigh)} on above-average volume${s1 ? `, with price holding above ${px(s1.zoneLow)}` : ''}.`) : '';
    out.bear = s1 ? L(`يصبح الهبوط أرجح بإغلاق دون ${levelName(s1)} ${px(s1.zoneLow)}${r1 ? ` أو برفض متكرر قرب ${px(r1.price)}` : ''}.`, `The bearish case strengthens on a close below ${levelName(s1)} ${px(s1.zoneLow)}${r1 ? ` or repeated rejection near ${px(r1.price)}` : ''}.`) : '';
    return out;
  }

  function profile(id, limits) {
    const name = I.T(`profile_${id}`);
    const head = id === 'CUSTOM' ? I.T('profile_head_custom') : I.T('profile_head', { name });
    const desc = limits ? I.T('profile_desc', { risk: I.iso(limits.maxRiskPerTradePct), daily: I.iso(limits.maxDailyLossPct), dd: I.iso(limits.maxDrawdownPct), alloc: I.iso(limits.maxPositionPct), rr: I.iso(limits.minRewardRisk) }) : '';
    return { name, head, desc };
  }

  window.EX = { level, levelName, swing, provisional, breakEvent, trendline, range, pattern, candle, sections, profile, strengthWord, when };
})();
