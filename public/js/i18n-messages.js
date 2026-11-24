/* Translation catalog for text produced by the server (activity log, data status, risk checks, reasons).
 * The server logs in English (its exports, tests and audit trail stay stable); the browser translates
 * every message through templates compiled to anchored regexes. Captured fragments are translated
 * recursively where marked ({x:tr}), numbers/tickers are bidi-isolated, and an unknown message falls back
 * to the original text (rendered left-to-right) rather than a guessed translation. */
(function () {
  'use strict';
  const I = window.I18N;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function compile(tpl) {
    const names = [];
    const kinds = [];
    let re = '';
    for (const p of tpl.split(/(\{\w+(?::\w+)?\})/)) {
      const m = /^\{(\w+)(?::(\w+))?\}$/.exec(p);
      if (m) { names.push(m[1]); kinds.push(m[2] || ''); re += m[2] === 'fld' ? '([A-Za-z0-9_.]+)' : m[2] === 'mlv' ? '([A-Za-z][A-Za-z -]*)' : '([\\s\\S]*?)'; } else re += esc(p);
    }
    return { re: new RegExp(`^${re}$`), names, kinds };
  }

  const durUnits = (s) => String(s).replace(/(\d+(?:\.\d+)?)\s?ms\b/g, '$1 مللي ث').replace(/(\d+(?:\.\d+)?)h\b/g, '$1 س').replace(/(\d+(?:\.\d+)?)m\b/g, '$1 د').replace(/(\d+(?:\.\d+)?)s\b/g, '$1 ث');
  const isoIfNum = (v) => (/\d/.test(v) && !/[؀-ۿ]/.test(v) && v.length < 48) || /^[A-Z][A-Z0-9.]{0,9}$/.test(v) ? I.iso(v) : v;
  const normAct = (v) => v.trim().replace(/\s+/g, '_').toUpperCase();

  const KIND = {
    '': (v) => isoIfNum(v),
    raw: (v) => v,
    tr: (v) => trf(v),
    fld: (v) => { const l = I.field && I.field(v); return l ? `«${l}»` : I.iso(v); },
    act: (v) => I.en('action', normAct(v), v),
    stat: (v) => I.en('market', v.trim(), v),
    aist: (v) => I.en('aiState', v.trim().toUpperCase(), v),
    dur: (v) => durUnits(v),
    mmode: (v) => I.en('monMode', v.trim(), v),
    mint: (v) => I.en('monIntensity', v.trim(), v),
    mev: (v) => MON_LABEL[v.trim()] || v,
    mevs: (v) => v.split(', ').map((k) => I.en('monEvent', k.trim(), k)).join('، '),
    mlv: (v) => MON_LEVEL[v.trim()] || v,
    strat: (v) => I.en('strategy', normAct(v), v),
    bias: (v) => I.en('bias', v.trim(), v),
    chk: (v) => v.split(' | ').map((x) => { const m = /^([a-z_]+): ([\s\S]*)$/.exec(x); return m ? `${I.en('check', m[1])}: ${trf(m[2])}` : trf(x); }).join(' | '),
    trg: (v) => v.split(' | ').map((x) => { const m = /^([A-Z_]+)(?:: ([\s\S]*))?$/.exec(x); return m ? `${I.en('trigger', m[1])}${m[2] ? `: ${trf(m[2])}` : ''}` : trf(x); }).join(' | '),
    list: (v) => v.split(/;\s*/).map(trf).join('؛ '),
    state: (v) => STATE[v.trim().toUpperCase()] || STATE[v.trim()] || v,
    lim: (v) => ({ risk: 'المخاطرة', allocation: 'التخصيص', cash: 'السيولة', proposal: 'طلب الذكاء الاصطناعي' }[v.trim()] || v),
    side: (v) => I.en('side', v.trim(), v),
    exitkind: (v) => ({ 'STOP-LOSS': 'وقف الخسارة', 'TRAILING STOP': 'الوقف المتحرك', 'TAKE-PROFIT': 'جني الأرباح', 'MANUAL CLOSE': 'إغلاق يدوي', AI: 'الذكاء الاصطناعي', STOP: 'وقف الخسارة', TRAILING_STOP: 'الوقف المتحرك', TAKE_PROFIT: 'جني الأرباح', USER: 'المستخدم' }[v.trim()] || v),
    prof: (v) => I.T(`profile_${v.trim()}`),
    basis: (v) => BASIS[v.trim()] || v,
    sig: (v) => SIGNAL[v.trim()] || v,
    ind: (v) => v.split(', ').map((k) => IND[k] || k).join('، '),
    lang: (v) => ({ Arabic: 'العربية', English: 'الإنجليزية' }[v] || v),
  };

  const STATE = {
    CONNECTING: 'جارٍ الاتصال', AUTHENTICATING: 'جارٍ المصادقة', AUTHENTICATED: 'تمت المصادقة', SUBSCRIBED: 'مشترك', DISCONNECTED: 'منقطع', RECONNECTING: 'جارٍ إعادة الاتصال',
    ERROR: 'خطأ', UNAVAILABLE: 'غير متاح', connecting: 'جارٍ الاتصال', authenticating: 'جارٍ المصادقة', authenticated: 'تمت المصادقة', subscribed: 'مشترك',
    disconnected: 'منقطع', reconnecting: 'جارٍ إعادة الاتصال', error: 'خطأ', unavailable: 'غير متاح', RUNNING: 'يعمل', PAUSED: 'متوقف مؤقتًا', STOPPED: 'متوقف', IDLE: 'خامل',
  };
  const MON_LABEL = {
    'Opening-range breakout': 'اختراق نطاق الافتتاح', 'Opening-range breakdown': 'كسر نطاق الافتتاح', 'Resistance breakout': 'اختراق مقاومة', 'Support breakdown': 'كسر دعم',
    'Late-session breakout': 'اختراق نهاية الجلسة', 'Late-session breakdown': 'كسر نهاية الجلسة', 'False breakout': 'اختراق كاذب', 'Rapid reversal': 'انعكاس سريع', 'Late-session reversal': 'انعكاس نهاية الجلسة',
    'Rapid price move': 'حركة سعرية سريعة', 'Momentum acceleration': 'تسارع الزخم', 'Short-term trend change': 'تغير الاتجاه القصير', 'Volume spike': 'قفزة في الحجم', 'Opening gap': 'فجوة افتتاح', 'Closing review of an open position': 'مراجعة مركز قبل الإغلاق',
  };
  const MON_LEVEL = {
    'the opening-range high': 'أعلى نطاق الافتتاح', 'the opening-range low': 'أدنى نطاق الافتتاح', 'the day high': 'أعلى سعر اليوم', 'the day low': 'أدنى سعر اليوم', 'the previous-session high': 'أعلى سعر الجلسة السابقة', 'the previous-session low': 'أدنى سعر الجلسة السابقة',
    'the pre-market high': 'أعلى سعر قبل الافتتاح', 'the pre-market low': 'أدنى سعر قبل الافتتاح', resistance: 'المقاومة', support: 'الدعم',
  };
  const BASIS = {
    'nearest resistance': 'أقرب مقاومة', 'nearest support': 'أقرب دعم', 'consolidation high': 'أعلى نطاق التماسك', 'consolidation low': 'أدنى نطاق التماسك',
    'intraday high': 'أعلى سعر خلال اليوم', 'intraday low': 'أدنى سعر خلال اليوم', 'previous session high': 'أعلى سعر في الجلسة السابقة', 'previous session low': 'أدنى سعر في الجلسة السابقة',
    'opening range high': 'أعلى نطاق الافتتاح', 'opening range low': 'أدنى نطاق الافتتاح',
  };
  const SIGNAL = {
    'bullish breakout': 'اختراق صاعد', 'bearish breakdown': 'كسر هابط', 'failed breakout': 'اختراق فاشل', 'potential bullish reversal': 'انعكاس صاعد محتمل',
    'potential bearish reversal': 'انعكاس هابط محتمل', 'strong buying pressure': 'ضغط شراء قوي', 'strong selling pressure': 'ضغط بيع قوي', 'increasing volatility': 'تزايد التقلب',
    'abnormal volume': 'حجم تداول غير عادي', 'rejection near resistance': 'رفض قرب المقاومة', 'reaction near support': 'ارتداد قرب الدعم', 'insufficient data': 'بيانات غير كافية',
  };
  const IND = {
    sma9: 'SMA9', sma20: 'SMA20', sma50: 'SMA50', sma200: 'SMA200', ema9: 'EMA9', ema21: 'EMA21', ema50: 'EMA50', rsi14: 'RSI14', macd: 'MACD', macdSignal: 'إشارة MACD',
    macdHist: 'هيستوغرام MACD', atr14: 'ATR14', bbUpper: 'بولينجر العلوي', bbMid: 'بولينجر الأوسط', bbLower: 'بولينجر السفلي', bbWidth: 'عرض بولينجر', volSma20: 'متوسط الحجم 20',
    relVol: 'الحجم النسبي', vwap: 'VWAP',
  };

  // ---------------------------------------------------------------- fragments (labels, reasons, details)
  const FRAG = [
    // adaptive monitoring
    ['{l:mev}: {d:tr}; attention {s}/100; also {x:mevs}', '{l}: {d} (درجة الانتباه {s}/100، مع: {x})'], ['{l:mev}: {d:tr}; attention {s}/100', '{l}: {d} (درجة الانتباه {s}/100)'],
    ['close {a} above {l:mlv} {b}, relative volume {r}x', 'إغلاق {a} فوق {l} {b}، الحجم النسبي {r}x'], ['close {a} below {l:mlv} {b}, relative volume {r}x', 'إغلاق {a} تحت {l} {b}، الحجم النسبي {r}x'],
    ['close {a} above {l:mlv} {b}, no volume baseline', 'إغلاق {a} فوق {l} {b} (لا سجل للحجم)'], ['close {a} below {l:mlv} {b}, no volume baseline', 'إغلاق {a} تحت {l} {b} (لا سجل للحجم)'],
    ['close {a} back below {l:mlv} {b}', 'إغلاق {a} عائدًا تحت {l} {b}'], ['close {a} back above {l:mlv} {b}', 'إغلاق {a} عائدًا فوق {l} {b}'],
    ['{a}% vs the previous close ({b} daily ATR)', '{a}% مقارنة بالإغلاق السابق ({b} من ATR اليومي)'], ['{a} in 5 minutes', '{a} خلال 5 دقائق'], ['3-minute momentum changed by {a}', 'تغيّر زخم 3 دقائق بمقدار {a}'],
    ['{a} advance with {b}% given back in {c} min', 'صعود {a} تراجع منه {b}% خلال {c} دقيقة'], ['{a} decline with {b}% given back in {c} min', 'هبوط {a} ارتد منه {b}% خلال {c} دقيقة'],
    ['EMA9/EMA21 crossed on 1-minute candles', 'تقاطع EMA9/EMA21 على شموع الدقيقة'], ['1-minute volume {a}x the typical minute', 'حجم الدقيقة {a}x المعتاد'], ['open position before the close', 'مركز مفتوح قبل الإغلاق'],
    ['range {a}x typical, volume {b}x', 'المدى {a}x المعتاد، الحجم {b}x'], ['range {a}x typical', 'المدى {a}x المعتاد'], ['forming candle range {a}x typical (provisional)', 'مدى الشمعة الجارية {a}x المعتاد (مبدئي)'],
    ['volatility normalised', 'عاد التقلب إلى طبيعته'], ['market data not reliable', 'بيانات السوق غير موثوقة'], ['no trades for 10 minutes', 'لا صفقات منذ 10 دقائق'], ['regular session ended', 'انتهت الجلسة الرسمية'], ['adaptive monitoring disabled', 'أُوقفت المراقبة التكيفية'],
    ['New positions are not opened in the last {n} minutes before the close', 'لا تُفتح صفقات جديدة في آخر {n} دقائق قبل الإغلاق'],
    ['New positions are not opened in the last {n} minutes before the close and no open position — analysis skipped', 'لا تُفتح صفقات جديدة في آخر {n} دقائق قبل الإغلاق ولا يوجد مركز مفتوح — تم تخطي التحليل'],
    ['not enough history for a volatility baseline', 'لا يوجد سجل كافٍ لقياس التقلب'], ['AI provider recovering until {t} ET', 'مزود الذكاء الاصطناعي يتعافى حتى {t} بتوقيت نيويورك'],
    // data status labels
    ['LIVE — ALPACA IEX', 'مباشر — ALPACA IEX'], ['LIVE — ALPACA SIP', 'مباشر — ALPACA SIP'], ['LIVE — ALPACA IEX ({s:stat})', 'مباشر — ALPACA IEX ({s})'], ['LIVE — ALPACA SIP ({s:stat})', 'مباشر — ALPACA SIP ({s})'],
    ['DELAYED — 15 MINUTES (ALPACA SIP)', 'متأخرة 15 دقيقة (ALPACA SIP)'], ['DEMO — SYNTHETIC DATA (NOT REAL)', 'تجريبي — بيانات اصطناعية (غير حقيقية)'],
    ['REPLAY — HISTORICAL BARS (quotes assumed ±{b} bps)', 'إعادة تشغيل — شموع تاريخية (الأسعار مفترضة ±{b} نقطة أساس)'],
    ['NO DATA PROVIDER', 'لا يوجد مزود بيانات'], ['MARKET CLOSED — LAST PRICE', 'السوق مغلق — آخر سعر'], ['{s:stat} — NO {f} DATA (LAST PRICE)', '{s} — لا توجد بيانات {f} (آخر سعر)'],
    ['{s:stat} — NO RECENT {f} QUOTE', '{s} — لا يوجد عرض سعر حديث من {f}'], ['CONNECTED — WAITING FOR MARKET DATA', 'متصل — بانتظار بيانات السوق'],
    ['CONNECTION LOST — RECONNECTING', 'انقطع الاتصال — جارٍ إعادة الاتصال'], ['MARKET CLOSED — RECONNECTING', 'السوق مغلق — جارٍ إعادة الاتصال'],
    ['CONNECTING — OPENING CONNECTION', 'جارٍ الاتصال — فتح الاتصال'], ['CONNECTING — AUTHENTICATING', 'جارٍ الاتصال — المصادقة'], ['CONNECTING — SUBSCRIBING', 'جارٍ الاتصال — الاشتراك'], ['CONNECTING — {x:state}', 'جارٍ الاتصال — {x}'],
    ['TRADING HALTED — {s}', 'التداول موقوف — {s}'], ['NO VALID BID/ASK — TRADING PAUSED', 'لا يوجد عرض/طلب صالح — التداول متوقف'], ['DATA DELAYED — TRADING PAUSED', 'البيانات متأخرة — التداول متوقف'],
    ['STALE DATA — TRADING PAUSED', 'بيانات قديمة — التداول متوقف'], ['REAL-TIME MARKET DATA UNAVAILABLE', 'بيانات السوق اللحظية غير متاحة'],
    // status details
    ['Synthetic prices for testing the interface', 'أسعار اصطناعية لاختبار الواجهة'], ['Historical replay', 'إعادة تشغيل تاريخية'],
    ['Delayed data is shown for reference only. Simulated execution is disabled.', 'تُعرض البيانات المتأخرة للمرجع فقط. التنفيذ المحاكى معطّل.'],
    ['Subscribed to {s}; waiting for the first trade/quote from the stream', 'تم الاشتراك في {s}؛ بانتظار أول صفقة أو عرض سعر من البث'],
    ['{s:stat}: extended-hours data on {f} is sparse', '{s}: بيانات الجلسات الممتدة على {f} قليلة'],
    ['Extended-hours activity on {f} is sparse. Simulated trading runs in the regular session only (enable extended hours in Settings to change this).', 'النشاط خارج الجلسة الرسمية على {f} قليل. التداول المحاكى يعمل في الجلسة الرسمية فقط (فعّل الجلسات الممتدة من الإعدادات لتغيير ذلك).'],
    ['Stream {s:state}: {d:tr}. New simulated trades are blocked until the stream is restored and fresh data arrives.', 'البث {s}: {d}. الصفقات المحاكاة الجديدة محظورة حتى يعود البث وتصل بيانات حديثة.'],
    ['Stream {s:state}. New simulated trades are blocked until the stream is restored and fresh data arrives.', 'البث {s}. الصفقات المحاكاة الجديدة محظورة حتى يعود البث وتصل بيانات حديثة.'],
    ['Halt reported', 'تم الإبلاغ عن إيقاف'], ['Market closed', 'السوق مغلق'], ['Unknown error', 'خطأ غير معروف'],
    // reason codes (REASON_TEXT) + freshness reasons
    ['market data stream not subscribed', 'بث بيانات السوق غير مشترك'], ['feed is not real-time', 'البث ليس لحظيًا'], ['no bid/ask quote received', 'لم يُستلم عرض/طلب'],
    ['latest bid/ask came from a REST snapshot, not the live stream', 'آخر عرض/طلب جاء من لقطة REST وليس من البث المباشر'],
    ['latest quote is not a valid two-sided market', 'آخر عرض سعر ليس سوقًا صالحًا من الجانبين'], ['latest bid/ask is older than the freshness limit', 'آخر عرض/طلب أقدم من حد الحداثة'],
    ['exchange timestamps lag the local clock', 'توقيتات البورصة متأخرة عن الساعة المحلية'],
    ['Market data stream {s:state} ({d:tr})', 'بث بيانات السوق {s} ({d})'], ['Market data stream {s:state}', 'بث بيانات السوق {s}'],
    ['Feed is {l:tr}, not real-time', 'البث {l} وليس لحظيًا'], ['No bid/ask quote received yet', 'لم يُستلم أي عرض/طلب بعد'],
    ['Latest quote is not a valid two-sided market', 'آخر عرض سعر ليس سوقًا صالحًا من الجانبين'],
    ['Latest bid/ask is {a:dur} old by exchange timestamp (limit {l:dur})', 'عمر آخر عرض/طلب {a} حسب توقيت البورصة (الحد {l})'],
    ['Latest bid/ask came from a REST snapshot — waiting for the live stream to deliver a quote', 'آخر عرض/طلب جاء من لقطة REST — بانتظار عرض سعر من البث المباشر'],
    ['Data delayed: exchange timestamps are {a:dur} behind the local clock', 'البيانات متأخرة: توقيتات البورصة متأخرة {a} عن الساعة المحلية'],
    // sessions & feed coverage
    ['Weekend', 'عطلة نهاية الأسبوع'], ['Market holiday (Alpaca calendar)', 'عطلة السوق (تقويم Alpaca)'], ['Not a trading day', 'ليس يوم تداول'], ['Before pre-market', 'قبل جلسة ما قبل الافتتاح'],
    ['After the extended-hours session', 'بعد انتهاء الجلسة الممتدة'], ['Alpaca market clock reports the market closed', 'ساعة سوق Alpaca تفيد بأن السوق مغلق'],
    ['{f} pre-market starts {t} ET', 'جلسة ما قبل الافتتاح على {f} تبدأ {t} بتوقيت نيويورك'], ['{f} post-market ended {t} ET', 'جلسة ما بعد الإغلاق على {f} انتهت {t} بتوقيت نيويورك'],
    ['The IEX exchange trades 08:00–09:30 (pre-market), 09:30–16:00 (regular) and 16:00–17:00 ET (post-market). The free Alpaca IEX feed carries no prints or quote changes outside those hours; on early-close days post-market is assumed to end 60 minutes after the close.',
      'تتداول بورصة IEX من 08:00 إلى 09:30 (ما قبل الافتتاح) ومن 09:30 إلى 16:00 (الجلسة الرسمية) ومن 16:00 إلى 17:00 بتوقيت نيويورك (ما بعد الإغلاق). لا يحمل بث IEX المجاني من Alpaca صفقات أو تغيرات أسعار خارج هذه الساعات؛ وفي أيام الإغلاق المبكر يُفترض انتهاء ما بعد الإغلاق بعد 60 دقيقة من الإغلاق.'],
    ['Real-time from the IEX exchange only (single venue). Prices are genuine prints; volume covers only IEX (a small share of total US volume). For the full consolidated tape use SIP.', 'بيانات لحظية من بورصة IEX فقط (منصة واحدة). الأسعار صفقات حقيقية؛ والحجم يغطي IEX فقط (حصة صغيرة من إجمالي حجم السوق الأمريكي). للحصول على الشريط الموحد الكامل استخدم SIP.'],
    ['Real-time consolidated tape (all US exchanges). Requires an Alpaca Algo Trader Plus subscription.', 'شريط موحد لحظي (جميع البورصات الأمريكية). يتطلب اشتراك Alpaca Algo Trader Plus.'],
    ['15-minute delayed consolidated data. Charts update, but simulated execution is disabled because quotes are not current.', 'بيانات موحدة متأخرة 15 دقيقة. يتحدث الشارت لكن التنفيذ المحاكى معطّل لأن الأسعار ليست حالية.'],
    ['Artificial random-walk prices for UI testing. Not market data.', 'أسعار عشوائية اصطناعية لاختبار الواجهة. ليست بيانات سوق.'],
    // risk blocks & limit events
    ['TRADING DISABLED: {r:tr}', 'التداول معطّل: {r}'], ['DAILY LOSS LIMIT: {r:tr}', 'حد الخسارة اليومية: {r}'], ['LOSS COOLDOWN until {t}', 'فترة تهدئة بعد الخسائر حتى {t}'],
    ['Max {n} entries per day reached', 'تم بلوغ الحد الأقصى {n} صفقات دخول في اليوم'],
    ['Daily loss {a}% reached the {b}% limit', 'الخسارة اليومية {a}% بلغت الحد {b}%'], ['Drawdown {a}% from peak reached the {b}% limit', 'التراجع من القمة {a}% بلغ الحد {b}%'],
    ['Daily loss {a}% reached the {b}% limit. New entries paused until the next trading day.', 'الخسارة اليومية {a}% بلغت الحد {b}%. أُوقفت صفقات الدخول الجديدة حتى يوم التداول التالي.'],
    ['Drawdown {a}% from peak reached the {b}% limit. Trading disabled until you reset or raise the limit.', 'التراجع من القمة {a}% بلغ الحد {b}%. التداول معطّل حتى إعادة الضبط أو رفع الحد.'],
    ['{n} consecutive losing trades: entry cooldown for {m} min.', '{n} صفقات خاسرة متتالية: فترة تهدئة للدخول مدتها {m} دقيقة.'],
    ['New trading day: daily loss lock cleared.', 'يوم تداول جديد: أُلغي قفل الخسارة اليومية.'],
    // risk check details
    ['Spread {a}% (limit {b}%)', 'الفارق {a}% (الحد {b}%)'], ['n/a', 'غير متاح'], ['Ask size is zero', 'حجم العرض صفر'],
    ['Proposal age {a}s (limit {b}s)', 'عمر الاقتراح {a} ث (الحد {b} ث)'], ['Price moved {a}% since snapshot (limit {b}%)', 'تحرك السعر {a}% منذ اللقطة (الحد {b}%)'],
    ['stop {s} < est. fill {f} < target {t}', 'الوقف {s} < سعر التنفيذ التقديري {f} < الهدف {t}'], ['Invalid levels: stop={s}, est. fill={f}, target={t}', 'مستويات غير صالحة: الوقف={s}، التنفيذ التقديري={f}، الهدف={t}'],
    ['limit {p}', 'السعر المحدد {p}'], ['Limit {p} invalid or above ask+max slippage', 'السعر المحدد {p} غير صالح أو أعلى من العرض + أقصى انزلاق'],
    ['R:R {a} after estimated costs (min {b})', 'العائد/المخاطرة {a} بعد التكاليف التقديرية (الحد الأدنى {b})'],
    ['Stop distance {a}% / {b} spreads (min {c}% and {d} spreads)', 'مسافة الوقف {a}% / {b} ضعف الفارق (الحد الأدنى {c}% و{d} ضعف الفارق)'],
    ['Stop {a}% below the entry (profile maximum {b}%)', 'الوقف أدنى من الدخول بـ {a}% (الحد الأقصى للمستوى {b}%)'],
    ['{n} open (limit {m})', '{n} مفتوح (الحد {m})'],
    ['IPO mode: {a} min since first observed trade (min {b})', 'وضع الإدراج الجديد: {a} دقيقة منذ أول صفقة مرصودة (الحد الأدنى {b})'],
    ['IPO mode: ATR {a} of price (max {b}%)', 'وضع الإدراج الجديد: ATR يساوي {a} من السعر (الحد الأقصى {b}%)'],
    ['{q} sh (limit: {l}; risk budget ${r}, {p}/sh risk, alloc cap ${c})', '{q} سهم (القيد: {l}؛ ميزانية المخاطرة ${r}، مخاطرة السهم {p}، سقف التخصيص ${c})'],
    ['Size rounds to {q} sh: risk budget ${r} / ${p} per share, allocation cap ${c}, cash ${h} (fractional shares disabled)', 'الحجم يُقرب إلى {q} سهم: ميزانية المخاطرة ${r} / ${p} للسهم، سقف التخصيص ${c}، السيولة ${h} (الأسهم الكسرية معطلة)'],
    ['Size rounds to {q} sh: risk budget ${r} / ${p} per share, allocation cap ${c}, cash ${h}', 'الحجم يُقرب إلى {q} سهم: ميزانية المخاطرة ${r} / ${p} للسهم، سقف التخصيص ${c}، السيولة ${h}'],
    ['Risk at stop ${a} = {b}% of equity incl. estimated costs (limit {c}% = ${d})', 'المخاطرة حتى الوقف ${a} = {b}% من رأس المال شاملة التكاليف التقديرية (الحد {c}% = ${d})'],
    ['Position value after entry ${a} = {b}% of equity (limit {c}%)', 'قيمة المركز بعد الدخول ${a} = {b}% من رأس المال (الحد {c}%)'],
    ['Feed is not real-time ({l:tr}) — simulated execution disabled', 'البث ليس لحظيًا ({l}) — التنفيذ المحاكى معطّل'], ['Stream connected', 'البث متصل'], ['Market data stream disconnected', 'بث بيانات السوق منقطع'],
    ['Stale data: {r:list}', 'بيانات قديمة: {r}'], ['Quote age {a} ms', 'عمر عرض السعر {a} مللي ثانية'], ['Trading halted: {r}', 'التداول موقوف: {r}'], ['No halt reported', 'لا يوجد إيقاف'],
    ['Session {s} — simulated orders only during regular hours', 'الجلسة {s} — الأوامر المحاكاة في الجلسة الرسمية فقط'], ['Session {s} — simulated orders only during pre/regular/post hours', 'الجلسة {s} — الأوامر المحاكاة في ساعات ما قبل/أثناء/بعد الجلسة فقط'], ['Session {s}', 'الجلسة {s}'],
    ['bid {b} / ask {a}', 'الطلب {b} / العرض {a}'], ['No valid two-sided quote', 'لا يوجد عرض سعر صالح من الجانبين'], ['No daily-loss / drawdown / cooldown block', 'لا يوجد حظر بسبب الخسارة اليومية أو التراجع أو التهدئة'],
    ['Outside regular hours only LIMIT orders are simulated', 'خارج الجلسة الرسمية تُحاكى الأوامر المحددة فقط'],
    ['{q} sh held', 'يُحتفظ بـ {q} سهم'], ['No position to sell (short selling disabled)', 'لا يوجد مركز للبيع (البيع على المكشوف معطّل)'], ['{q} sh ({p}% of position)', '{q} سهم ({p}% من المركز)'],
    ['Stop {a} -> {b}', 'الوقف {a} ← {b}'], ['Target {a} -> {b}', 'الهدف {a} ← {b}'], ['Trailing stop {a}%', 'الوقف المتحرك {a}%'], ['Trailing stop must be 0.1–20%', 'يجب أن يكون الوقف المتحرك بين 0.1 و20%'],
    ['Rejected stop {s}: must be >= current {c} and below bid {b}', 'رُفض الوقف {s}: يجب أن يكون ≥ الحالي {c} وأقل من الطلب {b}'], ['Rejected target {t}: must be above ask', 'رُفض الهدف {t}: يجب أن يكون أعلى من العرض'],
    // execution simulator
    ['Quantity must be positive', 'يجب أن تكون الكمية موجبة'], ['No valid two-sided quote (missing, zero or crossed bid/ask)', 'لا يوجد عرض سعر صالح (مفقود أو صفري أو متقاطع)'],
    ['Limit order requires a positive limit price', 'الأمر المحدد يتطلب سعرًا موجبًا'], ['Insufficient liquidity information: quote has no displayed size', 'معلومات السيولة غير كافية: لا يوجد حجم معروض'],
    ['Not marketable: ask {a} > limit {l}', 'غير قابل للتنفيذ: العرض {a} > السعر المحدد {l}'], ['Not marketable: bid {b} < limit {l}', 'غير قابل للتنفيذ: الطلب {b} < السعر المحدد {l}'],
    ['Fill would exceed max slippage {p}%', 'التنفيذ سيتجاوز أقصى انزلاق {p}%'], ['resting limit filled at target (trade printed {p})', 'نُفذ الأمر المحدد عند الهدف (سُجلت صفقة عند {p})'],
    // usage / budget
    ['Rate limit: {a}/{b} requests in the last minute', 'حد المعدل: {a}/{b} طلبات في آخر دقيقة'],
    ['Daily AI budget: spent ${a} of ${b}; next request may cost up to ${c}', 'ميزانية الذكاء الاصطناعي اليومية: أُنفق ${a} من ${b}؛ قد يكلف الطلب التالي حتى ${c}'],
    // gates
    ['No active session', 'لا توجد جلسة نشطة'], ['AI is {s:aist}', 'الذكاء الاصطناعي {s}'], ['Market data unavailable', 'بيانات السوق غير متاحة'],
    ['Monitoring paused for {s}', 'المراقبة متوقفة لـ {s}'], ['AI provider recovering from errors — next automatic attempt at {t} ET', 'مزود الذكاء الاصطناعي يتعافى من أخطاء — المحاولة التلقائية التالية {t} بتوقيت نيويورك'],
    ['Per-symbol limit: {s} {a}/{b} requests in the last hour ({m} mode)', 'حد السهم الواحد: {s} {a}/{b} طلبات في آخر ساعة (وضع {m})'],
    ['Daily AI request cap: {a}/{b} requests today ({m} mode)', 'الحد اليومي للطلبات: {a}/{b} طلبات اليوم (وضع {m})'], ['Monthly AI budget: spent ${a} of ${b}', 'الميزانية الشهرية: أُنفق ${a} من ${b}'],
    ['{p} API key not configured', 'مفتاح {p} غير مضبوط'], ['close {c} below AI support {s}', 'إغلاق {c} دون دعم الذكاء الاصطناعي {s}'], ['close {c} above AI resistance {s}', 'إغلاق {c} فوق مقاومة الذكاء الاصطناعي {s}'],
    ['symbol monitoring started', 'بدء مراقبة السهم'], ['monitoring resumed', 'استئناف المراقبة'], ['{n} open positions (new limit {m})', '{n} مراكز مفتوحة (الحد الجديد {m})'],
    ['{s} position is {a}% of equity (new limit {b}%)', 'مركز {s} يمثل {a}% من رأس المال (الحد الجديد {b}%)'],
    ['Gemini rejected the API key: {e}', 'رفض Gemini مفتاح API: {e}'], ['Gemini rate or spend limit reached (RESOURCE_EXHAUSTED): {e}', 'بلغ Gemini حد المعدل أو الإنفاق (RESOURCE_EXHAUSTED): {e}'],
    ['Gemini prepay credits depleted: {e}', 'نفد الرصيد المدفوع مسبقًا في Gemini: {e}'], ['Network error contacting Gemini: {e}', 'خطأ شبكة أثناء الاتصال بـ Gemini: {e}'],
    ['Market {s:stat} — AI analysis deferred until the trading session (saves API budget)', 'السوق {s} — أُجّل تحليل الذكاء الاصطناعي حتى جلسة التداول (توفيرًا لميزانية API)'],
    ['Waiting for reliable market data ({l:tr}: {r:list})', 'بانتظار بيانات سوق موثوقة ({l}: {r})'], ['Market halted — analysis deferred', 'السوق موقوف — أُجّل التحليل'],
    ['Entries blocked ({b:tr}) and no open position — analysis skipped', 'الدخول محظور ({b}) ولا يوجد مركز مفتوح — تم تخطي التحليل'],
    // AI display details
    ['Configure a symbol and capital, then START AI TRADING', 'حدد السهم ورأس المال ثم اضغط «بدء التداول الآلي»'], ['No new AI entries; protective orders active', 'لا صفقات دخول جديدة من الذكاء الاصطناعي؛ أوامر الحماية فعّالة'],
    ['Open position still protected', 'المركز المفتوح ما زال محميًا'], ['Next regular open {t} ET', 'الافتتاح الرسمي القادم {t} بتوقيت نيويورك'],
    ['DeepSeek API key not configured', 'مفتاح DeepSeek API غير مضبوط'], ['waiting', 'بانتظار DeepSeek'], ['thinking', 'النموذج يفكر'], ['answering', 'استلام القرار'], ['tool', 'أداة ويب'],
    // misc details
    ['Alpaca market data credentials are not configured. Enter your Alpaca key ID and secret in Settings → Credentials (a free Alpaca paper account provides real-time IEX data).', 'مفاتيح بيانات Alpaca غير مضبوطة. أدخل معرف المفتاح والسر في الإعدادات ← المفاتيح (حساب Alpaca الورقي المجاني يوفر بيانات IEX لحظية).'],
    ['Alpaca API credentials not configured', 'مفاتيح Alpaca API غير مضبوطة'],
    ['Alpaca rejected the credentials ({e}).', 'رفضت Alpaca المفاتيح ({e}).'], ['Stock symbol {s} not found', 'رمز السهم {s} غير موجود'],
    ['Not approved within 90s', 'لم تتم الموافقة خلال 90 ثانية'], ['identical proposal already executed', 'نُفذ اقتراح مطابق مسبقًا'],
    ['regular {n}s interval', 'فاصل دوري {n} ث'], ['user pressed START AI TRADING', 'ضغط المستخدم «بدء التداول الآلي»'], ['user requested analysis', 'طلب المستخدم التحليل'],
    ['session restored', 'استعادة الجلسة'], ['resumed', 'استئناف'], ['stock changed', 'تغيير السهم'], ['market data became reliable', 'أصبحت بيانات السوق موثوقة'],
    ['{tf} candle close', 'إغلاق شمعة {tf}'], ['{tf} close (replay)', 'إغلاق {tf} (إعادة تشغيل)'], ['entry filled', 'نُفذ الدخول'], ['{l:exitkind} exit', 'خروج ({l})'],
    ['price {p} broke above {b:basis} {v}', 'السعر {p} اخترق صعودًا {b} {v}'], ['price {p} broke below {b:basis} {v}', 'السعر {p} كسر هبوطًا {b} {v}'],
    ['price within {n}% of stop distance', 'السعر ضمن {n}% من مسافة الوقف'], ['price within {n}% of target distance', 'السعر ضمن {n}% من مسافة الهدف'],
    ['1m relative volume {x}x', 'الحجم النسبي لشمعة الدقيقة {x}x'], ['trading halt', 'إيقاف التداول'], ['halt lifted', 'رُفع الإيقاف'], ['session {s:stat}', 'الجلسة {s}'],
    ['risk profile {p:prof}', 'مستوى المخاطرة {p}'], ['DAILY_LOSS_LIMIT', 'حد الخسارة اليومية'], ['MAX_DRAWDOWN', 'أقصى تراجع'], ['LOSS_COOLDOWN', 'تهدئة الخسائر'],
    // signal details
    ['Close {c} crossed above swing high {h} (relVol {r})', 'أغلق السعر {c} فوق القمة المؤكدة {h} (الحجم النسبي {r})'], ['Close {c} crossed below swing low {l} (relVol {r})', 'أغلق السعر {c} دون القاع المؤكد {l} (الحجم النسبي {r})'],
    ['Price closed back below {p} after closing above it', 'عاد السعر للإغلاق دون {p} بعد الإغلاق فوقه'],
    ['RSI {r} with bullish engulfing', 'RSI {r} مع نمط ابتلاع صاعد'], ['RSI {r} with MACD histogram turning positive', 'RSI {r} مع تحول هيستوغرام MACD إلى موجب'],
    ['RSI {r} with bearish engulfing', 'RSI {r} مع نمط ابتلاع هابط'], ['RSI {r} with MACD histogram turning negative', 'RSI {r} مع تحول هيستوغرام MACD إلى سالب'],
    ['Wide bullish bar closing in top {p}% on {r}x volume', 'شمعة صاعدة واسعة تغلق في أعلى {p}% من مداها بحجم {r}x'], ['Wide bearish bar closing near low on {r}x volume', 'شمعة هابطة واسعة تغلق قرب القاع بحجم {r}x'],
    ['ATR14 {a} vs {b} ten bars ago ({r}x)', 'ATR14 {a} مقابل {b} قبل عشر شموع ({r}x)'], ['Relative volume {r}x the 20-bar average', 'الحجم النسبي {r}x متوسط 20 شمعة'],
    ['Upper wick rejected near resistance {p}', 'ظل علوي رافض قرب المقاومة {p}'], ['Upper wick rejected near {b:basis} {p}', 'ظل علوي رافض قرب {b} {p}'],
    ['Lower wick bounced from support {p}', 'ظل سفلي ارتد من الدعم {p}'], ['Lower wick bounced near {b:basis} {p}', 'ظل سفلي ارتد قرب {b} {p}'],
    ['Only {n} completed bars available — pattern detection disabled.', 'تتوفر {n} شموع مكتملة فقط — كشف الأنماط معطّل.'],
    // validator errors (AI output rejected before reaching the risk engine)
    ['snapshot_id "{a}" does not match the analysed snapshot {b}', 'معرّف اللقطة "{a}" لا يطابق اللقطة المحللة {b}'], ['JSON parse failed: {e}', 'فشل تحليل JSON: {e}'],
    ['AI output is not a JSON object', 'مخرجات الذكاء الاصطناعي ليست كائن JSON'], ['Unknown action "{a}"', 'إجراء غير معروف "{a}"'],
    ['confidence must be a number 0-100', 'يجب أن تكون الثقة رقمًا بين 0 و100'], ['confidence must be within 0-100', 'يجب أن تكون الثقة بين 0 و100'],
    ['{k} must be a number or null', 'يجب أن يكون {k} رقمًا أو null'], ['order.limit_price must be a number or null', 'يجب أن يكون order.limit_price رقمًا أو null'],
    ['BUY requires a positive entry_price', 'الشراء يتطلب entry_price موجبًا'], ['BUY requires a positive stop_loss', 'الشراء يتطلب stop_loss موجبًا'], ['BUY requires a positive take_profit', 'الشراء يتطلب take_profit موجبًا'],
    ['BUY levels must satisfy stop_loss < entry < take_profit (got {a} / {b} / {c})', 'يجب أن تحقق مستويات الشراء: الوقف < الدخول < الهدف (المستلم {a} / {b} / {c})'],
    ['entry {e} is more than 25% away from the current price {p} — rejected as implausible', 'سعر الدخول {e} يبعد أكثر من 25% عن السعر الحالي {p} — رُفض لعدم معقوليته'],
    ['LIMIT order requires order.limit_price', 'الأمر المحدد يتطلب order.limit_price'], ['REDUCE_POSITION requires reduce_fraction within (0, 1]', 'تقليص المركز يتطلب reduce_fraction ضمن (0، 1]'],
    ['trailing_stop_pct must be within (0, 20]', 'يجب أن يكون trailing_stop_pct ضمن (0، 20]'], ['position_size_pct_of_equity must be within (0, 100]', 'يجب أن يكون position_size_pct_of_equity ضمن (0، 100]'],
    ['Empty AI response (DeepSeek returns blank content when it cannot produce valid JSON)', 'استجابة فارغة من الذكاء الاصطناعي (يعيد DeepSeek محتوى فارغًا عندما يتعذر عليه إنتاج JSON صالح)'],
    ['Empty AI response', 'استجابة فارغة من الذكاء الاصطناعي'], ['No JSON object found in AI response', 'لا يوجد كائن JSON في استجابة الذكاء الاصطناعي'],
    // validator
    ['No supporting evidence listed', 'لم تُذكر أدلة داعمة'], ['confidence given as a fraction; scaled to 0-100', 'أُعطيت الثقة ككسر؛ حُوّلت إلى 0-100'],
    ['{a:act} proposed but no position is held — will be treated as no-op', 'اقتُرح {a} دون وجود مركز — سيُعامل كإجراء بلا أثر'],
    ['Unknown strategy "{s}" -> NONE', 'استراتيجية غير معروفة "{s}" ← لا توجد'], ['Unknown bias "{s}" -> UNCERTAIN', 'تحيز غير معروف "{s}" ← غير مؤكد'], ['Unknown order type "{s}" -> MARKET', 'نوع أمر غير معروف "{s}" ← سوق'],
    // rules baseline rationales
    ['Rules baseline: EMA stack bullish with RSI 50-70', 'القواعد الأساسية: ترتيب المتوسطات EMA صاعد مع RSI بين 50 و70'], ['Rules baseline: no setup', 'القواعد الأساسية: لا يوجد إعداد مناسب'],
    ['Rules baseline: price below EMA21', 'القواعد الأساسية: السعر دون EMA21'], ['Rules baseline: trend intact', 'القواعد الأساسية: الاتجاه ما زال قائمًا'],
    ['Indicators unavailable — insufficient data', 'المؤشرات غير متاحة — بيانات غير كافية'], ['Rules baseline evaluation (not AI)', 'تقييم بالقواعد الأساسية (ليس ذكاءً اصطناعيًا)'],
    ['Mechanical rules; no discretionary judgement', 'قواعد آلية؛ دون حكم تقديري'], ['RULES BASELINE (not AI)', 'القواعد الأساسية (ليست ذكاءً اصطناعيًا)'],
    ['Required indicators unavailable', 'المؤشرات المطلوبة غير متاحة'], ['EMA stack {s}', 'ترتيب EMA {s}'], ['bullish', 'صاعد'], ['not bullish', 'غير صاعد'],
    ['Close below {p}', 'إغلاق دون {p}'], ['AI entry', 'دخول بقرار الذكاء الاصطناعي'], ['AI {a:act}', '{a} بقرار الذكاء الاصطناعي'],
    ['User requested CLOSE PAPER POSITION', 'طلب المستخدم إغلاق المركز الورقي'], ['User reduced the position by {q} sh (risk profile review)', 'قلّص المستخدم المركز بمقدار {q} سهم (مراجعة مستوى المخاطرة)'],
    ['{k:exitkind} {l} triggered by {b} {p}', '{k} عند {l} نُفذ بسبب {b} {p}'], ['STOP LOSS {l} triggered by {b} {p}', 'وقف الخسارة {l} نُفذ بسبب {b} {p}'],
    ['TAKE PROFIT {l} triggered by {b} {p}', 'جني الأرباح {l} نُفذ بسبب {b} {p}'], ['TRAILING STOP {l} triggered by {b} {p}', 'الوقف المتحرك {l} نُفذ بسبب {b} {p}'],
    ['no losing trades yet (undefined)', 'لا صفقات خاسرة بعد (غير معرّف)'], ['no closed trades', 'لا صفقات مغلقة'],
    ['Only {n} closed trades — far too few to judge strategy profitability.', 'عدد الصفقات المغلقة {n} فقط — أقل بكثير من أن يُحكم به على ربحية الاستراتيجية.'],
    ['Buy & hold {n} sh at the ask when the session first traded', 'شراء واحتفاظ بـ {n} سهم بسعر العرض عند أول تداول للجلسة'],
    ['macro / monetary policy (affects all US equities)', 'اقتصاد كلي / سياسة نقدية (تؤثر في كل الأسهم الأمريكية)'], ['company investor-relations feed', 'مصدر علاقات المستثمرين للشركة'],
    ['official record for this symbol', 'سجل رسمي لهذا الرمز'], ['mentions "{x}"', 'يذكر "{x}"'], ['mentions ticker {x}', 'يذكر الرمز {x}'], ['no direct mention of the company', 'لا ذكر مباشر للشركة'],
    ['Market data expected now — reconnecting immediately instead of waiting for the closed-market backoff', 'بيانات السوق متوقعة الآن — إعادة الاتصال فورًا بدل انتظار تأخير السوق المغلق'],
    ['stream missing {s} updates that the REST snapshot has', 'البث يفقد تحديثات {s} الموجودة في لقطة REST'],
    ['{w} started', 'بدأت {w}'], ['pre-market', 'جلسة ما قبل الافتتاح'], ['open', 'الجلسة الرسمية'], ['after-hours', 'جلسة ما بعد الإغلاق'],
    ['stream outage of {d:dur}', 'انقطاع البث لمدة {d}'], ['position closed', 'أُغلق المركز'], ['AI stopped', 'أُوقف الذكاء الاصطناعي'], ['filled', 'نُفذ'], ['expired', 'انتهت صلاحيته'],
  ].map(([t, a]) => ({ ...compile(t), ar: a }));

  // ---------------------------------------------------------------- full messages
  const MSG = [
    // system / session
    ['Terminal ready. No active paper-trading session.', 'المنصة جاهزة. لا توجد جلسة تداول ورقي نشطة.'],
    ['AI Trading Terminal listening on {u} — PAPER TRADING ONLY (no brokerage orders are ever sent)', 'المنصة تعمل على {u} — تداول ورقي فقط (لا تُرسل أي أوامر إلى وسيط أبدًا)'],
    ['Restored paper session #{id} ({s}, {m}) from database: cash ${c}, {q} sh open', 'استُعيدت الجلسة الورقية #{id} ({s}، {m}) من قاعدة البيانات: السيولة ${c}، مركز مفتوح {q} سهم'],
    ['Restored paper session #{id} ({s}, {m}) from database: cash ${c}, flat', 'استُعيدت الجلسة الورقية #{id} ({s}، {m}) من قاعدة البيانات: السيولة ${c}، لا يوجد مركز'],
    ['AI was running before restart — resuming autonomous analysis.', 'كان الذكاء الاصطناعي يعمل قبل إعادة التشغيل — استئناف التحليل الذاتي.'],
    ['New PAPER session #{id}: {s}, initial capital ${c}, target ${t} (+{p}%, not guaranteed) — DEMO synthetic data', 'جلسة ورقية جديدة #{id}: {s}، رأس المال المبدئي ${c}، الهدف ${t} (+{p}%، غير مضمون) — بيانات تجريبية اصطناعية'],
    ['New PAPER session #{id}: {s}, initial capital ${c}, target ${t} (+{p}%, not guaranteed)', 'جلسة ورقية جديدة #{id}: {s}، رأس المال المبدئي ${c}، الهدف ${t} (+{p}%، غير مضمون)'],
    ['New PAPER session #{id}: {s}, initial capital ${c} — DEMO synthetic data', 'جلسة ورقية جديدة #{id}: {s}، رأس المال المبدئي ${c} — بيانات تجريبية اصطناعية'],
    ['New PAPER session #{id}: {s}, initial capital ${c}', 'جلسة ورقية جديدة #{id}: {s}، رأس المال المبدئي ${c}'],
    ['RESET SIMULATION: session #{id} archived (history kept in the database).', 'إعادة ضبط المحاكاة: أُرشفت الجلسة #{id} (السجل محفوظ في قاعدة البيانات).'],
    ['CHANGE STOCK: {a} → {b}. Session #{id} continues with carried equity ${e}.', 'تغيير السهم: {a} ← {b}. تستمر الجلسة #{id} برأس المال المرحّل ${e}.'],
    ['Capital settings: initial ${c}, target ${t} (target never increases risk)', 'إعدادات رأس المال: المبدئي ${c}، الهدف ${t} (الهدف لا يزيد المخاطرة أبدًا)'],
    ['Capital settings: initial ${c}, target none (target never increases risk)', 'إعدادات رأس المال: المبدئي ${c}، بلا هدف (الهدف لا يزيد المخاطرة أبدًا)'],
    ['Settings updated: {k} (risk profile is now CUSTOM)', 'حُدّثت الإعدادات: {k} (مستوى المخاطرة الآن «مخصص»)'], ['Settings updated: {k}', 'حُدّثت الإعدادات: {k}'],
    ['Interface language set to {a:lang}; new AI explanations will be written in {b:lang}', 'تم تعيين لغة الواجهة إلى {a}؛ ستُكتب تفسيرات الذكاء الاصطناعي الجديدة باللغة {b}'],
    ['Credential {n} saved (encrypted local store)', 'حُفظ المفتاح {n} (مخزن محلي مشفر)'], ['Credential {n} removed from local store', 'أُزيل المفتاح {n} من المخزن المحلي'],
    ['DeepSeek connection OK: {n} models available ({l})', 'اتصال DeepSeek يعمل: {n} نماذج متاحة ({l})'],
    ['Alpaca connection OK: market OPEN; data feed {f} (snapshot error: {e})', 'اتصال Alpaca يعمل: السوق مفتوح؛ البث {f} (خطأ اللقطة: {e})'], ['Alpaca connection OK: market CLOSED; data feed {f} (snapshot error: {e})', 'اتصال Alpaca يعمل: السوق مغلق؛ البث {f} (خطأ اللقطة: {e})'],
    ['Alpaca connection OK: market OPEN; data feed {f}', 'اتصال Alpaca يعمل: السوق مفتوح؛ البث {f}'], ['Alpaca connection OK: market CLOSED; data feed {f}', 'اتصال Alpaca يعمل: السوق مغلق؛ البث {f}'],
    ['User cleared the TRADING DISABLED (max drawdown) flag', 'ألغى المستخدم علامة «التداول معطّل» (أقصى تراجع)'],
    ['Unhandled error: {e}', 'خطأ غير معالج: {e}'],
    // market data
    ['Loading {s} (DEMO synthetic data)…', 'جارٍ تحميل {s} (بيانات تجريبية اصطناعية)…'], ['Loading {s} ({m})…', 'جارٍ تحميل {s} ({m})…'],
    ['REAL-TIME MARKET DATA UNAVAILABLE: {r:tr}', 'بيانات السوق اللحظية غير متاحة: {r}'],
    ['Market calendar loaded ({s})', 'تم تحميل تقويم السوق ({s})'], ['Trading calendar unavailable — using weekday estimate (holidays not detected)', 'تقويم التداول غير متاح — استخدام تقدير أيام الأسبوع (لا تُكتشف العطل)'],
    ['Trading calendar unavailable ({e}) — using weekday estimate', 'تقويم التداول غير متاح ({e}) — استخدام تقدير أيام الأسبوع'], ['Trading calendar refresh failed: {e}', 'فشل تحديث تقويم التداول: {e}'],
    ['Feed coverage: {n:tr}', 'تغطية البث: {n}'],
    ['Ticker verified: {s} — {n} ({x}, {st})', 'تم التحقق من الرمز: {s} — {n} ({x}، {st})'], ['Stock symbol {s} not found', 'رمز السهم {s} غير موجود'], ['Asset lookup failed: {e}', 'فشل البحث عن الأصل: {e}'],
    ['Stream error: {e}', 'خطأ في البث: {e}'], ['Stream heartbeat lost (no pong) — reconnecting', 'فُقد نبض البث (لا استجابة pong) — جارٍ إعادة الاتصال'], ['Unparseable stream message', 'رسالة بث غير قابلة للقراءة'],
    ['Alpaca did not confirm the trades/quotes/bars subscription for {x}', 'لم تؤكد Alpaca الاشتراك في الصفقات/الأسعار/الشموع لـ {x}'], ['Alpaca stream error {c}: {d}', 'خطأ بث Alpaca {c}: {d}'],
    ['Forcing stream reconnect: {r:tr}', 'فرض إعادة اتصال البث: {r}'],
    ['Halt/LULD status channels unavailable on this feed/plan — retrying subscription without them (halts will be read from the Nasdaq Trader feed).', 'قنوات الإيقاف/LULD غير متاحة على هذا البث/الخطة — إعادة الاشتراك بدونها (ستُقرأ الإيقافات من مصدر Nasdaq Trader).'],
    ['Trading status {c}: {m} ({r})', 'حالة التداول {c}: {m} ({r})'], ['Trading status {c}: {m}', 'حالة التداول {c}: {m}'],
    ['Market data connection lost ({d:tr}). Market is closed for this feed — reconnecting with a slow backoff.', 'انقطع اتصال بيانات السوق ({d}). السوق مغلق لهذا البث — إعادة الاتصال بتأخير بطيء.'],
    ['Market data connection lost ({d:tr}). New simulated trades are blocked; reconnecting with exponential backoff.', 'انقطع اتصال بيانات السوق ({d}). الصفقات المحاكاة الجديدة محظورة؛ إعادة الاتصال بتأخير متزايد.'],
    ['Market data stream error while reconnecting: {d}', 'خطأ في بث بيانات السوق أثناء إعادة الاتصال: {d}'], ['Connecting to market data stream ({d})', 'جارٍ الاتصال ببث بيانات السوق ({d})'],
    ['Market data socket open, authenticating…', 'اتصال بيانات السوق مفتوح، جارٍ المصادقة…'], ['Market data stream authenticated — {d}', 'تمت مصادقة بث بيانات السوق — {d}'], ['Market data stream authenticated', 'تمت مصادقة بث بيانات السوق'],
    ['Market data stream error: {d}', 'خطأ في بث بيانات السوق: {d}'],
    ['Reconnect attempt {n} in {s}s (market closed: slow retry) — {r:tr} — still unresolved after {d:dur}', 'محاولة إعادة الاتصال {n} بعد {s} ث (السوق مغلق: إعادة محاولة بطيئة) — {r} — ما زالت دون حل بعد {d}'],
    ['Reconnect attempt {n} in {s}s (market closed: slow retry) — still unresolved after {d:dur}', 'محاولة إعادة الاتصال {n} بعد {s} ث (السوق مغلق: إعادة محاولة بطيئة) — ما زالت دون حل بعد {d}'],
    ['Reconnect attempt {n} in {s}s — {r:tr} — still unresolved after {d:dur}', 'محاولة إعادة الاتصال {n} بعد {s} ث — {r} — ما زالت دون حل بعد {d}'],
    ['Reconnect attempt {n} in {s}s — still unresolved after {d:dur}', 'محاولة إعادة الاتصال {n} بعد {s} ث — ما زالت دون حل بعد {d}'],
    ['Reconnect attempt {n} in {s}s (market closed: slow retry) — {r:tr}', 'محاولة إعادة الاتصال {n} بعد {s} ث (السوق مغلق: إعادة محاولة بطيئة) — {r}'],
    ['Reconnect attempt {n} in {s}s (market closed: slow retry)', 'محاولة إعادة الاتصال {n} بعد {s} ث (السوق مغلق: إعادة محاولة بطيئة)'],
    ['Reconnect attempt {n} in {s}s — {r:tr}', 'محاولة إعادة الاتصال {n} بعد {s} ث — {r}'], ['Reconnect attempt {n} in {s}s', 'محاولة إعادة الاتصال {n} بعد {s} ث'],
    ['Subscription verified for {s} ({c})', 'تم التحقق من الاشتراك في {s} ({c})'],
    ['Market data stream restored after {d:dur} ({n} attempt): authenticated and subscribed {s} ({c}). Verifying incoming data and loading missed candles…', 'عاد بث بيانات السوق بعد {d} ({n} محاولة): تمت المصادقة والاشتراك في {s} ({c}). جارٍ التحقق من البيانات الواردة وتحميل الشموع الفائتة…'],
    ['Market data stream restored after {d:dur} ({n} attempts): authenticated and subscribed {s} ({c}). Verifying incoming data and loading missed candles…', 'عاد بث بيانات السوق بعد {d} ({n} محاولات): تمت المصادقة والاشتراك في {s} ({c}). جارٍ التحقق من البيانات الواردة وتحميل الشموع الفائتة…'],
    ['Recovery after reconnect failed: {e}', 'فشل الاستعادة بعد إعادة الاتصال: {e}'],
    ['Subscribed to {s}: {c} — waiting for the first live message', 'تم الاشتراك في {s}: {c} — بانتظار أول رسالة مباشرة'],
    ['Loaded {n} missing 1-minute candle(s) since {t} ET ({w:tr}) — official {f} bars', 'تم تحميل {n} شمعة دقيقة مفقودة منذ {t} بتوقيت نيويورك ({w}) — شموع {f} رسمية'],
    ['No missing candles since {t} ET ({w:tr}): the feed reported no trades in that period', 'لا شموع مفقودة منذ {t} بتوقيت نيويورك ({w}): لم يسجل البث صفقات في تلك الفترة'],
    ['Could not load missing candles ({w:tr}): {e}', 'تعذر تحميل الشموع المفقودة ({w}): {e}'],
    ['Snapshot refresh failed: {e}', 'فشل تحديث اللقطة: {e}'], ['Snapshot request failed: {e}', 'فشل طلب اللقطة: {e}'],
    ['MARKET HALTED: {s} trading halted ({r}). No simulated fills during the halt; pending orders stay pending.', 'السوق موقوف: أُوقف تداول {s} ({r}). لا تنفيذ محاكى أثناء الإيقاف؛ الأوامر المعلقة تبقى معلقة.'],
    ['{s} trading resumed', 'استؤنف تداول {s}'],
    ['Loaded {n} one-minute bars for the live window (from {t} ET {d})', 'تم تحميل {n} شمعة دقيقة لنافذة التداول الحالية (منذ {t} بتوقيت نيويورك {d})'],
    ['Historical 1-minute data failed: {e}', 'فشل تحميل بيانات الدقيقة التاريخية: {e}'],
    ['No daily history for {s} on this feed — long-term indicators unavailable', 'لا يوجد تاريخ يومي لـ {s} على هذا البث — المؤشرات طويلة الأجل غير متاحة'],
    ['Daily SMA200 unavailable: only {n} daily bars exist (newly listed stock — long-term indicators will not be fabricated)', 'SMA200 اليومي غير متاح: توجد {n} شموع يومية فقط (سهم حديث الإدراج — لن تُختلق المؤشرات طويلة الأجل)'],
    ['Daily SMA200 unavailable: only {n} daily bars exist', 'SMA200 اليومي غير متاح: توجد {n} شموع يومية فقط'],
    ['IPO / new-listing mode ACTIVE for {s}: stricter spread, volatility, seasoning and allocation checks', 'وضع الإدراج الجديد مفعّل لـ {s}: فحوصات أشد للفارق والتقلب ومهلة الإدراج والتخصيص'],
    ['IPO reference (configuration, not market data): offer price ${p} on {d}. Live price always comes from the data feed.', 'مرجع الاكتتاب (من الإعدادات وليس بيانات سوق): سعر الطرح ${p} في {d}. السعر الحي يأتي دائمًا من بث البيانات.'],
    ['Historical {tf} data loaded: {n} bars ({a} → {b})', 'تم تحميل البيانات التاريخية {tf}: {n} شمعة ({a} ← {b})'], ['Historical {tf} data loaded: {n} bars', 'تم تحميل البيانات التاريخية {tf}: {n} شمعة'],
    ['Historical {tf} data failed: {e}', 'فشل تحميل البيانات التاريخية {tf}: {e}'],
    ['No snapshot (last trade/quote) available yet for {s} on this feed', 'لا توجد لقطة (آخر صفقة/عرض) لـ {s} على هذا البث بعد'],
    ['Snapshot: last trade ${p} at {t} ET {d}; last bid/ask {b} / {a} at {t2} ET', 'لقطة: آخر صفقة ${p} عند {t} بتوقيت نيويورك {d}؛ آخر طلب/عرض {b} / {a} عند {t2} بتوقيت نيويورك'],
    ['Snapshot: last trade ${p} at {t} ET {d}', 'لقطة: آخر صفقة ${p} عند {t} بتوقيت نيويورك {d}'], ['Snapshot: last bid/ask {b} / {a} at {t2} ET', 'لقطة: آخر طلب/عرض {b} / {a} عند {t2} بتوقيت نيويورك'],
    ['Minute bar {t} ET corrected by provider (late trades)', 'صحّح المزود شمعة الدقيقة {t} بتوقيت نيويورك (صفقات متأخرة)'],
    ['Live data verified for {s}: first {k} received {d:dur} after subscribing (exchange time {t} ET)', 'تم التحقق من البيانات الحية لـ {s}: وصلت أول {k} بعد {d} من الاشتراك (توقيت البورصة {t} بتوقيت نيويورك)'],
    ['Live data verified for {s}: first {k} received {d:dur} after resubscribing (exchange time {t} ET)', 'تم التحقق من البيانات الحية لـ {s}: وصلت أول {k} بعد {d} من إعادة الاشتراك (توقيت البورصة {t} بتوقيت نيويورك)'],
    ['Receiving market data: {a} trades, {b} quotes, {c} minute bars in the last {d:dur}', 'تُستقبل بيانات السوق: {a} صفقة، {b} عرض سعر، {c} شمعة دقيقة خلال آخر {d}'],
    ['Still {l:tr} — unresolved for {d:dur}: {x:tr}', 'ما زالت الحالة {l} — دون حل منذ {d}: {x}'],
    ['Market data recovered — {l:tr} (was {p:tr} for {d:dur}); bid/ask {b} / {a}, quote age {q:dur} by exchange time', 'تعافت بيانات السوق — {l} (كانت {p} لمدة {d})؛ الطلب/العرض {b} / {a}، عمر العرض {q} حسب توقيت البورصة'],
    ['{l:tr}: bid/ask {b} / {a}, quote age {q:dur} by exchange time', '{l}: الطلب/العرض {b} / {a}، عمر العرض {q} حسب توقيت البورصة'],
    ['Market session: {s:stat} (estimated) ({r:tr}){f:tr}', 'جلسة السوق: {s} (تقديري) ({r}){f}'], ['Market session: {s:stat} (estimated){f:tr}', 'جلسة السوق: {s} (تقديري){f}'],
    ['Market session: {s:stat} ({r:tr}){f:tr}', 'جلسة السوق: {s} ({r}){f}'], ['Market session: {s:stat}{f:tr}', 'جلسة السوق: {s}{f}'],
    ['Market session changed: {a:stat} → {b:stat} ({r:tr}){f:tr}', 'تغيرت جلسة السوق: {a} ← {b} ({r}){f}'], ['Market session changed: {a:stat} → {b:stat}{f:tr}', 'تغيرت جلسة السوق: {a} ← {b}{f}'],
    ['Session start handling failed: {e}', 'فشلت معالجة بداية الجلسة: {e}'],
    ['New trading day {d}: loading the new live window and recent history', 'يوم تداول جديد {d}: تحميل نافذة التداول الجديدة والتاريخ الحديث'],
    ['Stream is {s:state} at session start — reconnecting now', 'البث {s} عند بداية الجلسة — إعادة الاتصال الآن'],
    ['Alpaca market clock: market OPEN; next close {t} ET', 'ساعة سوق Alpaca: السوق مفتوح؛ الإغلاق القادم {t} بتوقيت نيويورك'],
    ['Alpaca market clock: market CLOSED; next open {d} {t} ET', 'ساعة سوق Alpaca: السوق مغلق؛ الافتتاح القادم {d} {t} بتوقيت نيويورك'],
    ['Local clock differs from Alpaca\'s server clock by {s}s — data ages are measured against the local clock; please sync your system time', 'الساعة المحلية تختلف عن ساعة خادم Alpaca بـ {s} ث — تُقاس أعمار البيانات بالساعة المحلية؛ يرجى مزامنة وقت النظام'],
    ['Alpaca market clock available again', 'ساعة سوق Alpaca متاحة مجددًا'], ['Alpaca market clock unavailable ({e}) — using the trading calendar', 'ساعة سوق Alpaca غير متاحة ({e}) — استخدام تقويم التداول'],
    ['Feed diagnosis: {m:tr}', 'تشخيص البث: {m}'],
    ['Trades resumed after {n} minutes without trades on this feed ({a}–{b} ET); no candles exist for those minutes', 'استؤنفت الصفقات بعد {n} دقيقة بلا صفقات على هذا البث ({a}–{b} بتوقيت نيويورك)؛ لا توجد شموع لتلك الدقائق'],
    ['New 1-minute candle completed {t} ET: O {o} H {h} L {l} C {c} V {v} (provisional — official bar pending)', 'اكتملت شمعة جديدة مدتها دقيقة واحدة {t} بتوقيت نيويورك: افتتاح {o} أعلى {h} أدنى {l} إغلاق {c} حجم {v} (مؤقتة — بانتظار الشمعة الرسمية)'],
    ['New 1-minute candle completed {t} ET: O {o} H {h} L {l} C {c} V {v}', 'اكتملت شمعة جديدة مدتها دقيقة واحدة {t} بتوقيت نيويورك: افتتاح {o} أعلى {h} أدنى {l} إغلاق {c} حجم {v}'],
    ['Abnormal volume: last minute {x}x the 20-bar average', 'حجم تداول غير عادي: آخر دقيقة {x}x متوسط 20 شمعة'],
    ['No trades on this feed in minute {t} ET — no candle created (candles only come from real trades; further quiet minutes are summarised when trading resumes)', 'لا صفقات على هذا البث في الدقيقة {t} بتوقيت نيويورك — لم تُنشأ شمعة (الشموع تأتي من صفقات حقيقية فقط؛ تُلخّص الدقائق الهادئة التالية عند استئناف التداول)'],
    ['{tf} candle closed (C {c}) — scheduling analysis', 'أُغلقت شمعة {tf} (إغلاق {c}) — جدولة التحليل'], ['{tf} candle closed (no trades) — scheduling analysis', 'أُغلقت شمعة {tf} (بلا صفقات) — جدولة التحليل'],
    ['Feed changed to {f} — reconnecting', 'تغير البث إلى {f} — جارٍ إعادة الاتصال'],
    // news
    ['Significant news detected: "{t}" ({s}) — requesting AI re-evaluation', 'رُصد خبر مهم: «{t}» ({s}) — طلب إعادة تقييم من الذكاء الاصطناعي'],
    ['Checking latest company news: {n} relevant item(s) available ({m} officially confirmed)', 'جارٍ تحليل الأخبار الأخيرة: {n} خبر ذو صلة ({m} مؤكد رسميًا)'],
    ['{s}: {n} new relevant item(s) retrieved', '{s}: جُلب {n} خبر جديد ذي صلة'], ['News source {s} failed: {e}', 'فشل مصدر الأخبار {s}: {e}'], ['Database error storing news: {e}', 'خطأ في قاعدة البيانات أثناء حفظ الخبر: {e}'],
    // AI lifecycle
    ['AI analysis job failed: {e}', 'فشلت مهمة تحليل الذكاء الاصطناعي: {e}'],
    ['Analysis queued ({r}); next slot in {s}s (min interval)', 'أُضيف التحليل إلى قائمة الانتظار ({r})؛ الدور التالي بعد {s} ث (الحد الأدنى للفاصل)'],
    ['AI started but will wait: market data is unavailable', 'بدأ الذكاء الاصطناعي لكنه سينتظر: بيانات السوق غير متاحة'],
    ['START AI TRADING — autonomous paper trading enabled ({l:tr}, autonomy {a})', 'بدء التداول الآلي — تفعيل التداول الورقي الذاتي ({l}، الاستقلالية {a})'],
    ['No DeepSeek API key: DEMO session uses the deterministic RULES BASELINE (not AI).', 'لا يوجد مفتاح DeepSeek API: الجلسة التجريبية تستخدم القواعد الأساسية الحتمية (ليست ذكاءً اصطناعيًا).'],
    ['AI PAUSED — no new AI-driven entries. Protective stop/target orders and risk controls remain active.', 'أُوقف الذكاء الاصطناعي مؤقتًا — لا صفقات دخول جديدة منه. أوامر الحماية وضوابط المخاطر تبقى فعّالة.'],
    ['AI RESUMED', 'استؤنف الذكاء الاصطناعي'], ['Pending order {id} cancelled (AI stopped)', 'أُلغي الأمر المعلق {id} (أُوقف الذكاء الاصطناعي)'],
    ['AI STOPPED. Open paper position kept: {q} sh @ {p} — still protected by stop {s} / target {t}. Use CLOSE PAPER POSITION to exit.', 'أُوقف الذكاء الاصطناعي. احتُفظ بالمركز الورقي المفتوح: {q} سهم @ {p} — ما زال محميًا بوقف {s} / هدف {t}. استخدم «إغلاق المركز» للخروج.'],
    ['AI STOPPED. No open position.', 'أُوقف الذكاء الاصطناعي. لا يوجد مركز مفتوح.'],
    ['Analysis skipped: {g:tr}', 'تم تخطي التحليل: {g}'], ['AI ERROR: {p} API key is not configured (Settings → Credentials)', 'خطأ في الذكاء الاصطناعي: مفتاح {p} API غير مضبوط (الإعدادات ← المفاتيح)'],
    ['AI request avoided for {s}: market state unchanged since the analysis at {t} ET — reusing it until the next review at {t2} ET', 'تم تجنب طلب ذكاء اصطناعي لـ {s}: حالة السوق لم تتغير جوهريًا منذ تحليل {t} بتوقيت نيويورك — إعادة استخدامه حتى المراجعة التالية {t2}'],
    ['Symbol added to watchlist: {s} ({n} monitored)', 'أُضيف السهم إلى المراقبة: {s} ({n} أسهم مراقبة)'], ['Symbol removed from watchlist: {s} (its trade history is kept)', 'أُزيل السهم من المراقبة: {s} (سجل صفقاته محفوظ)'],
    ['AI monitoring paused for {s}: no new AI analysis or entries for this symbol; market data and protective orders stay active', 'أُوقفت مراقبة الذكاء الاصطناعي لـ {s}: لا تحليل ولا صفقات دخول جديدة لهذا السهم؛ بيانات السوق وأوامر الحماية مستمرة'],
    ['AI monitoring resumed for {s}', 'استُؤنفت مراقبة الذكاء الاصطناعي لـ {s}'], ['Could not resume monitoring {s}: {e}', 'تعذر استئناف مراقبة {s}: {e}'],
    ['Database migration: {n} earlier fill(s) linked to order records', 'ترحيل قاعدة البيانات: رُبط {n} تنفيذ سابق بسجلات أوامر'], ['Database migration failed: {e}', 'فشل ترحيل قاعدة البيانات: {e}'],
    ['Reference price source {p} unavailable: {e}', 'مصدر الأسعار المرجعية {p} غير متاح: {e}'], ['Database error saving order: {e}', 'خطأ في قاعدة البيانات أثناء حفظ الأمر: {e}'],
    ['Database error updating order: {e}', 'خطأ في قاعدة البيانات أثناء تحديث الأمر: {e}'], ['Database error saving AI cache: {e}', 'خطأ في قاعدة البيانات أثناء حفظ ذاكرة التحليل: {e}'],
    ['Gemini connection OK: {n} models available', 'اتصال Gemini يعمل: {n} نموذجًا متاحًا'], ['Tiingo connection OK: SPY reference {x}', 'اتصال Tiingo يعمل: السعر المرجعي لـ SPY {x}'],
    ['Adaptive monitoring active: {m:mmode} ({i:mint} intensity)', 'المراقبة التكيفية نشطة: {m} (شدة {i})'], ['Adaptive monitoring mode: {a:mmode} → {b:mmode} ({i:mint} intensity)', 'وضع المراقبة: {a} ← {b} (شدة {i})'],
    ['Adaptive monitoring is disabled (Settings) — the standard monitoring behaviour applies', 'المراقبة التكيفية معطّلة (الإعدادات) — تعمل المراقبة القياسية'], ['Adaptive monitoring error: {e}', 'خطأ في المراقبة التكيفية: {e}'],
    ['HIGH VOLATILITY monitoring activated for {s}: {r:tr}', 'تفعيل مراقبة التقلب المرتفع لـ {s}: {r}'], ['HIGH VOLATILITY monitoring ended for {s}: {r:tr} — back to {m:mmode}', 'انتهت مراقبة التقلب المرتفع لـ {s}: {r} — العودة إلى {m}'],
    ['Market-wide move detected: {d} in 15 minutes — elevated monitoring for all symbols', 'رُصدت حركة عامة في السوق: {d} خلال 15 دقيقة — رُفعت شدة مراقبة كل الأسهم'], ['Market-wide move ended — back to the session mode', 'انتهت الحركة العامة في السوق — العودة إلى وضع الجلسة'],
    ['Opening watchlist (unusual pre-market movement): {x}', 'قائمة متابعة الافتتاح (حركة غير معتادة قبل الافتتاح): {x}'], ['Opening watchlist: no unusual pre-market movement', 'قائمة متابعة الافتتاح: لا حركة غير معتادة قبل الافتتاح'],
    ['Closing phase: {n} open position(s), exposure {x}% of equity; no new entries in the last {m} minutes', 'مرحلة الإغلاق: {n} مركز مفتوح، الانكشاف {x}% من رأس المال؛ لا صفقات جديدة في آخر {m} دقائق'],
    ['Market event {s}: {l:mev} — priority {p}/100 ({d:tr})', 'حدث سوق {s}: {l} — أولوية {p}/100 ({d})'], ['Trade REJECTED: {r:tr}', 'رُفضت الصفقة: {r}'],
    ['Telegram: {m:tr}', 'تيليجرام: {m}'],
    ['AI mode set to {m} by {b}', 'تم تغيير وضع الذكاء الاصطناعي إلى {m} بواسطة {b}'],
    ['{p} paused after errors ({c}) until {t} ET: {e}', 'أُوقف {p} مؤقتًا بعد أخطاء ({c}) حتى {t} بتوقيت نيويورك: {e}'], ['{p} is answering again', 'عاد {p} للاستجابة'],
    ['{a} failed ({c}: {e}) — falling back to {b}', 'فشل {a} ({c}: {e}) — التحويل إلى {b}'], ['Analysis answered by {a} (fallback from {b})', 'أجاب {a} على التحليل (بديلًا عن {b})'],
    ['Dual analysis: DeepSeek {a} ({x}%) vs Gemini {b} ({y}%) — {r}; combined uncertainty {u}', 'تحليل مزدوج: DeepSeek {a} ({x}%) مقابل Gemini {b} ({y}%) — {r}؛ عدم اليقين المجمّع {u}'],
    ['disagreement: no trade, waiting for more evidence', 'اختلاف: لا صفقة، انتظار أدلة إضافية'], ['agreement', 'اتفاق'],
    ['AI request not sent — {r:tr}', 'لم يُرسل طلب الذكاء الاصطناعي — {r}'], ['No AI provider available — {r}', 'لا يوجد مزود ذكاء اصطناعي متاح — {r}'],
    ['Sending market snapshot {id} to {t} (~{n} input tokens est., reasoning {r})', 'إرسال لقطة السوق {id} إلى {t} (~{n} رمز إدخال تقديريًا، مستوى التفكير {r})'],
    ['{p} response received in {s}s — {i} in ({c} cached) / {o} out tokens ({r} reasoning), est. ${x}', 'وصل رد {p} خلال {s} ث — {i} إدخال ({c} من الذاكرة المؤقتة) / {o} إخراج ({r} تفكير)، تكلفة تقديرية ${x}'],
    ['Market monitoring PAUSED by {b}: no AI analysis or market alerts; market data and protective orders stay active', 'أُوقفت مراقبة السوق بواسطة {b}: لا تحليل بالذكاء الاصطناعي ولا تنبيهات سوق؛ بيانات السوق وأوامر الحماية مستمرة'],
    ['Market monitoring RESUMED by {b}', 'استُؤنفت مراقبة السوق بواسطة {b}'],
    ['Accounting check passed: cash and positions of session #{n} match its {f} recorded fill(s)', 'نجح فحص المحاسبة: النقد والمراكز في الجلسة #{n} مطابقة لـ {f} عملية تنفيذ مسجلة'],
    ['Accounting check FAILED: {p}', 'فشل فحص المحاسبة: {p}'],
    ['Startup complete: {n} symbol(s) restored, monitoring {m}, AI trading {a}, AI mode {x}', 'اكتمل بدء التشغيل: استُعيد {n} سهم، المراقبة {m}، التداول الآلي {a}، وضع الذكاء الاصطناعي {x}'],
    ['Shutting down: new proposals are refused; waiting for in-flight work, then saving state', 'جارٍ الإيقاف: تُرفض الاقتراحات الجديدة؛ انتظار العمل الجاري ثم حفظ الحالة'],
    ['AI Trading Terminal listening on {h} ({u}) — PAPER TRADING ONLY (no brokerage orders are ever sent){x}', 'المنصة تعمل على {h} ({u}) — تداول ورقي فقط (لا تُرسل أي أوامر إلى وسيط){x}'],
    [' — dashboard login required', ' — يلزم تسجيل الدخول للوحة'],
    ['Database schema upgraded v{a} → v{b}{x}', 'تمت ترقية مخطط قاعدة البيانات v{a} ← v{b}{x}'],
    ['Database backup created: {n} ({s} MB, verified)', 'تم إنشاء نسخة احتياطية: {n} ({s} ميغابايت، متحقق منها)'],
    ['Scheduled database backup {n} verified ({s} MB){x}', 'نسخة احتياطية مجدولة {n} متحقق منها ({s} ميغابايت){x}'], ['Scheduled database backup failed: {e}', 'فشل النسخ الاحتياطي المجدول: {e}'],
    ['Database backup downloaded from the dashboard', 'تم تنزيل نسخة من قاعدة البيانات من اللوحة'],
    ['Dashboard login from {ip}', 'تسجيل دخول إلى اللوحة من {ip}'], ['Dashboard login failed from {ip}', 'فشل تسجيل الدخول إلى اللوحة من {ip}'], ['All dashboard sessions signed out ({n})', 'تم تسجيل الخروج من كل جلسات اللوحة ({n})'],
    ['The previous run (started {t}) ended without a clean shutdown — state was restored from the database; no fills are reconstructed for the downtime', 'التشغيل السابق (بدأ {t}) انتهى دون إيقاف سليم — استُعيدت الحالة من قاعدة البيانات؛ لا تُعاد صياغة أي صفقات لفترة التوقف'],
    ['Pending LIMIT {s} {q} {sym} @ {p} expired while the application was offline — not filled (no fills are reconstructed for offline periods)', 'انتهت صلاحية أمر LIMIT {s} المعلق {q} {sym} @ {p} أثناء توقف التطبيق — لم يُنفذ (لا تُنشأ صفقات لفترات التوقف)'],
    ['AI was running before restart — resuming. Analyses and new entries wait for fresh, verified market data; decisions made before the restart are never executed.', 'كان الذكاء الاصطناعي يعمل قبل إعادة التشغيل — تم الاستئناف. تنتظر التحليلات والصفقات الجديدة بيانات سوق حديثة ومتحققًا منها؛ لا تُنفذ أي قرارات سابقة لإعادة التشغيل.'],
    ['AI was running before the restart but was NOT resumed: startup checks failed ({p}). Market data and protective orders stay active; resume manually after checking.', 'كان الذكاء الاصطناعي يعمل قبل إعادة التشغيل لكنه لم يُستأنف: فشلت فحوص البدء ({p}). بيانات السوق وأوامر الحماية مستمرة؛ استأنف يدويًا بعد التحقق.'],
    ['Duplicate entry blocked: decision {d} already has an order', 'مُنع دخول مكرر: القرار {d} لديه أمر بالفعل'], ['Proposal not executed: the server is shutting down', 'لم يُنفذ الاقتراح: الخادم قيد الإيقاف'],
    ['No AI provider key is configured: add a DeepSeek or Gemini API key (Settings → Credentials).', 'لا يوجد مفتاح لمزود ذكاء اصطناعي: أضف مفتاح DeepSeek أو Gemini (الإعدادات ← المفاتيح).'],
    ['AI ERROR: no AI provider key is configured — add a DeepSeek or Gemini key (Settings → Credentials)', 'خطأ: لا يوجد مفتاح لمزود ذكاء اصطناعي — أضف مفتاح DeepSeek أو Gemini (الإعدادات ← المفاتيح)'],
    ['AI ERROR — no AI provider is usable (key, balance or quota problem). Autonomous analysis paused; market monitoring and protective orders remain active.', 'خطأ — لا يوجد مزود ذكاء اصطناعي صالح للاستخدام (مشكلة مفتاح أو رصيد أو حصة). أُوقف التحليل الآلي؛ مراقبة السوق وأوامر الحماية مستمرة.'],
    ['Market monitoring is paused (system-wide)', 'مراقبة السوق متوقفة (على مستوى النظام)'], ['Server is shutting down', 'الخادم قيد الإيقاف'],
    ['{p} unavailable ({e}) — fallback to {b}', '{p} غير متاح ({e}) — التحويل إلى {b}'], ['dual analysis unavailable ({e}); {p} analyses alone', 'التحليل المزدوج غير متاح ({e})؛ يحلل {p} وحده'],
    ['Retention: removed {a} activity row(s), {b} event(s), {c} market snapshot(s); trades, orders and decisions are never pruned', 'الاحتفاظ بالبيانات: حُذف {a} سجل نشاط و{b} حدث و{c} لقطة سوق؛ الصفقات والأوامر والقرارات لا تُحذف أبدًا'],
    ['Database integrity check FAILED: {e} — AI trading will not resume automatically', 'فشل فحص سلامة قاعدة البيانات: {e} — لن يُستأنف التداول الآلي تلقائيًا'],
    ['Database imported: {x} (previous database backed up{y})', 'تم استيراد قاعدة البيانات: {x} (أُخذت نسخة من القاعدة السابقة{y})'],
    ['Invalid ticker format "{s:raw}"', 'صيغة الرمز غير صالحة: "{s}"'], ['{s} is already in the watchlist', '{s} موجود بالفعل في قائمة المراقبة'],
    ['Watchlist limit reached ({n} symbols; change market.maxSymbols in Settings)', 'بلغت قائمة المراقبة الحد الأقصى ({n} أسهم؛ يمكن تغييره من الإعدادات ← البيانات والأخبار)'],
    ['{s} is not in the watchlist', '{s} ليس في قائمة المراقبة'],
    ['{s} is the main symbol of this session and cannot be removed; pause its monitoring instead', '{s} هو السهم الرئيسي لهذه الجلسة ولا يمكن إزالته؛ يمكنك إيقاف مراقبته مؤقتًا بدلًا من ذلك'],
    ['{s} has an open paper position — close it first (removing a symbol never closes a position)', 'لدى {s} مركز ورقي مفتوح — أغلقه أولًا (إزالة السهم لا تغلق أي مركز)'],
    ['{s} has a pending order — it must fill, expire or be cancelled first', 'لدى {s} أمر معلق — يجب أن يُنفذ أو تنتهي صلاحيته أو يُلغى أولًا'],
    ['Close the open paper positions in {s} before changing the main symbol', 'أغلق المراكز الورقية المفتوحة في {s} قبل تغيير السهم الرئيسي'],
    ['DeepSeek API key', 'مفتاح DeepSeek API'], ['Alpaca API key ID', 'معرّف مفتاح Alpaca API'], ['Alpaca API secret', 'المفتاح السري لـ Alpaca API'], ['SEC EDGAR User-Agent', 'هوية SEC EDGAR (User-Agent)'],
    ['Google Gemini API key', 'مفتاح Google Gemini API'], ['Tiingo API token', 'رمز Tiingo API'], ['Telegram bot token', 'رمز بوت تيليجرام'],
    ['Authenticates AI market analysis requests to api.deepseek.com.', 'يوثّق طلبات تحليل السوق بالذكاء الاصطناعي إلى api.deepseek.com.'],
    ['Real-time & historical market data, news, market clock (read-only).', 'بيانات السوق اللحظية والتاريخية والأخبار وساعة السوق (قراءة فقط).'],
    ['Pairs with the key ID. Used read-only; no orders are ever sent.', 'يُستخدم مع معرّف المفتاح للقراءة فقط؛ لا تُرسل أي أوامر أبدًا.'],
    ['SEC fair-access policy requires "Name email@example.com" to query EDGAR filings.', 'تشترط سياسة SEC تعريفًا بصيغة "الاسم email@example.com" للاستعلام عن إفصاحات EDGAR.'],
    ['Authenticates AI market analysis requests to generativelanguage.googleapis.com (when the AI provider is Gemini).', 'يوثّق طلبات تحليل السوق إلى generativelanguage.googleapis.com (عندما يكون المزود Gemini).'],
    ['Optional extended-hours / overnight reference prices from Tiingo (read-only).', 'اختياري: أسعار مرجعية للساعات الممتدة والجلسة الليلية من Tiingo (قراءة فقط).'],
    ['Lets the terminal send notifications and answer your Telegram commands. Never shown again after saving.', 'يتيح للمنصة إرسال الإشعارات والرد على أوامرك في تيليجرام. لا يُعرض مجددًا بعد الحفظ.'],
    ['Telegram bot token is not configured', 'لم يُضبط رمز بوت تيليجرام'], ['Telegram module unavailable: {e}', 'وحدة تيليجرام غير متاحة: {e}'],
    ['Gemini API key not configured', 'لم يُضبط مفتاح Gemini'], ['Tiingo API token not configured', 'لم يُضبط رمز Tiingo'],
    ['Analysis started — trigger: {t:trg}', 'بدأ التحليل — المحفز: {t}'], ['Snapshot build failed: {e}', 'فشل بناء لقطة البيانات: {e}'],
    ['Recalculated indicators on {n} completed {tf} bars: RSI14 {r} | MACD hist {m} | ATR14 {a} | EMA9/21/50 {e} | VWAP {v} | RelVol {x}', 'جارٍ حساب مؤشرات التحليل الفني على {n} شمعة مكتملة ({tf}): RSI14 {r} | هيستوغرام MACD {m} | ATR14 {a} | EMA9/21/50 {e} | VWAP {v} | الحجم النسبي {x}'],
    ['Unavailable (insufficient data, not estimated): {k:ind}', 'غير متاح (بيانات غير كافية، ولا يُقدّر): {k}'],
    ['Signal {s:sig}: {d:tr}', 'إشارة {s}: {d}'],
    ['Price {p} approaching {b:basis} {v}', 'يقترب السعر {p} من {b} {v}'], ['Price {p} near {b:basis} {v}', 'السعر {p} قرب {b} {v}'],
    ['AI request not sent — {b:tr}', 'لم يُرسل طلب الذكاء الاصطناعي — {b}'],
    ['Sending market snapshot {id} to RULES BASELINE (not AI) (~{n} input tokens est., reasoning {r})', 'تم إرسال بيانات السوق (اللقطة {id}) إلى القواعد الأساسية (ليست ذكاءً اصطناعيًا)'],
    ['Sending market snapshot {id} to {l} (~{n} input tokens est., reasoning {r})', 'تم إرسال بيانات السوق إلى {l}: اللقطة {id} (~{n} رمز إدخال تقديريًا، مستوى التفكير {r})'],
    ['Model is reasoning (internal reasoning is not displayed or stored)…', 'النموذج يفكر (التفكير الداخلي لا يُعرض ولا يُخزّن)…'],
    ['DeepSeek server tool: {t}', 'أداة خادم DeepSeek: {t}'], ['AI request failed ({c}): {e}', 'فشل طلب الذكاء الاصطناعي ({c}): {e}'],
    ['AI ERROR — autonomous analysis paused until the DeepSeek issue is fixed. Protective orders remain active.', 'خطأ في الذكاء الاصطناعي — أُوقف التحليل الذاتي حتى تُحل مشكلة DeepSeek. أوامر الحماية تبقى فعّالة.'],
    ['AI response received in {s}s — {i} in ({c} cached) / {o} out tokens ({r} reasoning), est. ${u}', 'اكتمل تحليل الذكاء الاصطناعي خلال {s} ث — {i} رمز إدخال ({c} مخزن) / {o} رمز إخراج ({r} تفكير)، التكلفة التقديرية ${u}'],
    ['{l:tr} evaluated the snapshot', 'قيّم {l} لقطة البيانات'],
    ['AI response validation failed (response hit max_tokens — raise "Max output tokens" or lower reasoning effort): {e}', 'فشل التحقق من استجابة الذكاء الاصطناعي (بلغت الاستجابة الحد الأقصى للرموز — ارفع «أقصى رموز إخراج» أو اخفض مستوى التفكير): {e}'],
    ['AI response validation failed: {e:list}', 'فشل التحقق من استجابة الذكاء الاصطناعي: {e}'], ['Validator note: {w:tr}', 'ملاحظة المدقق: {w}'],
    ['{n} AI price level(s) did not match any level computed by the application — shown on the chart as unverified', '{n} من مستويات الذكاء الاصطناعي لم تطابق أي مستوى محسوب من التطبيق — تظهر على الشارت كمستويات غير مؤكدة'],
    ['Chart updated: {n} AI level(s) verified against application-computed levels', 'تم تحديث الشارت: تحقق {n} من مستويات الذكاء الاصطناعي مقابل المستويات المحسوبة من التطبيق'],
    ['Decision changed from {a:act} to {b:act} — {r}', 'تغير القرار من {a} إلى {b} — {r}'], ['Decision changed from {a:act} to {b:act} (no reason given by the model)', 'تغير القرار من {a} إلى {b} (لم يذكر النموذج سببًا)'],
    ['Chart analysis could not be built: {e}', 'تعذر بناء تحليل الشارت: {e}'],
    ['AI proposes {a:act} entry ~{e}, stop {s}, target {t} — {st:strat}, bias {b:bias}, confidence {c}%', 'القرار: {a} — دخول ~{e}، وقف {s}، هدف {t} — {st}، التحيز {b}، الثقة {c}%'],
    ['AI proposes {a:act} — {st:strat}, bias {b:bias}, confidence {c}%', 'القرار: {a} — {st}، التحيز {b}، الثقة {c}%'],
    ['Reason: {r:tr}', 'السبب: {r}'],
    ['Web research skipped — {b:tr}', 'تم تخطي بحث الويب — {b}'], ['Running DeepSeek web research (deepseek_web_search / deepseek_read_url) for {s}…', 'جارٍ بحث الويب عبر DeepSeek (deepseek_web_search / deepseek_read_url) عن {s}…'],
    ['Web tool: {t}', 'أداة ويب: {t}'], ['Web research complete in {s}s: {n} cited source(s), est. ${c}', 'اكتمل بحث الويب خلال {s} ث: {n} مصدر مذكور، التكلفة التقديرية ${c}'],
    ['DeepSeek web research unavailable: {e} (continuing with independently collected news)', 'بحث الويب عبر DeepSeek غير متاح: {e} (المتابعة بالأخبار المجموعة بشكل مستقل)'],
    ['No trade: {a:act} — next: {n:tr}', 'لا تداول: {a} — التالي: {n}'], ['No trade: {a:act}', 'لا تداول: {a}'],
    ['{a:act} ignored: no open position', 'تم تجاهل {a}: لا يوجد مركز مفتوح'],
    ['Duplicate proposal rejected (identical {a:act} already executed {s}s ago)', 'رُفض اقتراح مكرر ({a} مطابق نُفذ قبل {s} ث)'],
    ['Advisory mode: proposal recorded, not executed', 'الوضع الاستشاري: سُجل الاقتراح ولم يُنفذ'],
    ['Awaiting your approval (semi-autonomous mode, 90s): {a:act}', 'بانتظار موافقتك (الوضع شبه الذاتي، 90 ث): {a}'],
    ['User rejected proposal {a:act}', 'رفض المستخدم الاقتراح {a}'], ['User approved proposal {a:act}', 'وافق المستخدم على الاقتراح {a}'],
    ['Proposal {a:act} expired without user approval', 'انتهت صلاحية الاقتراح {a} دون موافقة المستخدم'],
    // risk & execution
    ['Validating proposal against risk limits…', 'جارٍ التحقق من الاقتراح مقابل حدود المخاطرة…'],
    ['Trade REJECTED by risk engine: {c:chk}', 'رفض محرك المخاطر الصفقة: {c}'],
    ['Market changed since the snapshot — stale proposal invalidated, re-assessing', 'تغير السوق منذ اللقطة — أُلغي الاقتراح القديم وجارٍ إعادة التقييم'],
    ['Trade accepted by risk engine: {q} sh (limited by {l:lim}; risk at stop ${r} = {p}% of equity; R:R {x}) — resized from AI request', 'قبل محرك المخاطر الصفقة: {q} سهم (القيد: {l}؛ المخاطرة حتى الوقف ${r} = {p}% من رأس المال؛ العائد/المخاطرة {x}) — عُدّل الحجم عن طلب الذكاء الاصطناعي'],
    ['Trade accepted by risk engine: {q} sh (limited by {l:lim}; risk at stop ${r} = {p}% of equity; R:R {x})', 'قبل محرك المخاطر الصفقة: {q} سهم (القيد: {l}؛ المخاطرة حتى الوقف ${r} = {p}% من رأس المال؛ العائد/المخاطرة {x})'],
    ['PAPER LIMIT BUY placed: {q} {s} @ {p} (ask {a}; expires {t} ET)', 'وُضع أمر شراء محدد ورقي: {q} {s} @ {p} (العرض {a}؛ ينتهي {t} بتوقيت نيويورك)'],
    ['PAPER BUY not filled: {r:tr}', 'لم يُنفذ الشراء الورقي: {r}'], ['Execution rejected by accounting: {e}', 'رفضت المحاسبة التنفيذ: {e}'],
    ['PAPER BUY executed: {q} {s} @ {p} (ask {a}, spread {sp}, slippage ${sl}, fees ${f}) — PARTIAL: {r:tr}', 'نُفذ شراء ورقي: {q} {s} @ {p} (العرض {a}، الفارق {sp}، الانزلاق ${sl}، الرسوم ${f}) — جزئي: {r}'],
    ['PAPER BUY executed: {q} {s} @ {p} (ask {a}, spread {sp}, slippage ${sl}, fees ${f})', 'نُفذ شراء ورقي: {q} {s} @ {p} (العرض {a}، الفارق {sp}، الانزلاق ${sl}، الرسوم ${f})'],
    ['Protective orders set: stop {s}, take-profit {t}, trailing {x}%', 'ضُبطت أوامر الحماية: وقف الخسارة {s}، جني الأرباح {t}، الوقف المتحرك {x}%'],
    ['Protective orders set: stop {s}, take-profit {t}', 'ضُبطت أوامر الحماية: وقف الخسارة {s}، جني الأرباح {t}'],
    ['Pending LIMIT BUY @ {p} is marketable (ask {a}) — re-validating risk', 'أمر الشراء المحدد المعلق @ {p} أصبح قابلًا للتنفيذ (العرض {a}) — إعادة التحقق من المخاطر'],
    ['Pending LIMIT BUY {q} @ {p} expired unfilled', 'انتهت صلاحية أمر الشراء المحدد المعلق {q} @ {p} دون تنفيذ'],
    ['{k:exitkind} exit cannot execute now: {c:chk} — order stays armed until data is reliable', 'خروج {k} لا يمكن تنفيذه الآن: {c} — يبقى الأمر مفعّلًا حتى تصبح البيانات موثوقة'],
    ['{k:exitkind} exit cannot execute now: {c:chk}', 'خروج {k} لا يمكن تنفيذه الآن: {c}'],
    ['PAPER SELL not filled ({k:exitkind}): {r:tr}', 'لم يُنفذ البيع الورقي ({k}): {r}'],
    ['PAPER SELL executed ({k:exitkind}): {q} {s} @ {p} (bid {b}, fees ${f}) — realized P&L ${x} — PARTIAL: {r:tr}', 'نُفذ بيع ورقي ({k}): {q} {s} @ {p} (الطلب {b}، الرسوم ${f}) — الربح/الخسارة المحققة ${x} — جزئي: {r}'],
    ['PAPER SELL executed ({k:exitkind}): {q} {s} @ {p} (bid {b}, fees ${f}) — realized P&L ${x}', 'نُفذ بيع ورقي ({k}): {q} {s} @ {p} (الطلب {b}، الرسوم ${f}) — الربح/الخسارة المحققة ${x}'],
    ['Round trip closed: P&L ${x} ({p}%)', 'أُغلقت الصفقة الكاملة: الربح/الخسارة ${x} ({p}%)'],
    ['RISK LIMIT: {m:tr}', 'حد المخاطرة: {m}'], ['Adjustment rejected: {d:tr}', 'رُفض التعديل: {d}'],
    ['Protective orders updated: {c}', 'حُدّثت أوامر الحماية: {c}'],
    ['Portfolio updated: equity ${e}, cash ${c}, {q} sh @ avg {p}, realized ${r}, return {x}%', 'تم تحديث المحفظة: القيمة ${e}، السيولة ${c}، {q} سهم بمتوسط {p}، المحقق ${r}، العائد {x}%'],
    ['Portfolio updated: equity ${e}, cash ${c}, flat, realized ${r}, return {x}%', 'تم تحديث المحفظة: القيمة ${e}، السيولة ${c}، لا يوجد مركز، المحقق ${r}، العائد {x}%'],
    ['Drawdown limit changed — trading-disabled flag cleared; it will re-trigger if the new limit is exceeded.', 'تغير حد التراجع — أُلغيت علامة تعطيل التداول؛ ستُفعّل مجددًا إذا تجاوز التراجع الحد الجديد.'],
    ['Daily loss limit changed — daily lock re-evaluated against the new limit.', 'تغير حد الخسارة اليومية — أُعيد تقييم القفل اليومي مقابل الحد الجديد.'],
    ['Risk profile changed: {a:prof} → {b:prof}. Limits now: risk per trade {r}%, daily loss {d}%, max drawdown {dd}%, max allocation {al}%, min R:R {rr}, max stop distance {sd}%, max open positions {op}. Applied to the risk engine immediately.',
      'تغير مستوى المخاطرة: {a} ← {b}. الحدود الآن: المخاطرة للصفقة {r}%، الخسارة اليومية {d}%، أقصى تراجع {dd}%، أقصى تخصيص {al}%، أدنى عائد/مخاطرة {rr}، أقصى مسافة للوقف {sd}%، أقصى مراكز متزامنة {op}. طُبّقت على محرك المخاطر فورًا.'],
    ['Exposure review after risk profile change: {p:tr}. Nothing was sold automatically — selling {q} sh would bring the position within the new limits. New entries must satisfy the new limits; protective stops stay active.',
      'مراجعة التعرض بعد تغيير مستوى المخاطرة: {p}. لم يُبع أي شيء تلقائيًا — بيع {q} سهم يعيد المركز ضمن الحدود الجديدة. يجب أن تستوفي الصفقات الجديدة الحدود الجديدة؛ أوامر وقف الخسارة تبقى فعّالة.'],
    ['Exposure review after risk profile change: {p:tr}. Nothing was sold automatically. New entries must satisfy the new limits; protective stops stay active.',
      'مراجعة التعرض بعد تغيير مستوى المخاطرة: {p}. لم يُبع أي شيء تلقائيًا. يجب أن تستوفي الصفقات الجديدة الحدود الجديدة؛ أوامر وقف الخسارة تبقى فعّالة.'],
    ['Exposure review after risk profile change: the open position is within the new limits.', 'مراجعة التعرض بعد تغيير مستوى المخاطرة: المركز المفتوح ضمن الحدود الجديدة.'],
    ['Pending limit orders will be re-validated against the new limits before they can fill.', 'ستُعاد مراجعة الأوامر المحددة المعلقة مقابل الحدود الجديدة قبل تنفيذها.'],
    // database
    ['Database error reading sessions: {e}', 'خطأ في قاعدة البيانات أثناء قراءة الجلسات: {e}'], ['Database error while saving session: {e}', 'خطأ في قاعدة البيانات أثناء حفظ الجلسة: {e}'],
    ['Database error saving snapshot: {e}', 'خطأ في قاعدة البيانات أثناء حفظ اللقطة: {e}'], ['Database error saving decision: {e}', 'خطأ في قاعدة البيانات أثناء حفظ القرار: {e}'],
    ['Database error updating decision: {e}', 'خطأ في قاعدة البيانات أثناء تحديث القرار: {e}'], ['Database error saving fill: {e}', 'خطأ في قاعدة البيانات أثناء حفظ التنفيذ: {e}'],
    ['Database error: {e}', 'خطأ في قاعدة البيانات: {e}'],
    ['Market data {s:state}: {d:tr}', 'بيانات السوق {s}: {d}'],
    // generic data-status lines (must stay last)
    ['{l:tr}: {d:tr}', '{l}: {d}'],
  ].map(([t, a]) => ({ ...compile(t), ar: a }));

  // exposure-review parts and feed diagnosis bodies (joined with "; ")
  const PARTS = [
    ['{p:fld} must be a list of numeric Telegram ids', 'يجب أن يكون {p} قائمة معرّفات تيليجرام رقمية (أرقام فقط، مفصولة بفواصل)'],
    ['{p:fld} must be an IANA timezone such as Asia/Riyadh', 'يجب أن يكون {p} منطقة زمنية صحيحة مثل Asia/Riyadh'],
    ['{p:fld} must be between {a} and {b}', 'يجب أن يكون {p} بين {a} و{b}'], ['{p:fld} must be one of {x:raw}', 'يجب أن يكون {p} أحد القيم: {x}'],
    ['{p:fld} has an invalid format', 'صيغة {p} غير صحيحة'], ['{p:fld} must be a number', 'يجب أن يكون {p} رقمًا'], ['{p:fld} must be true/false', 'يجب أن يكون {p} نعم/لا'],
    ['{p:fld} is not editable', 'لا يمكن تعديل {p}'], ['{p:fld} is not a known setting', '{p} ليس إعدادًا معروفًا'], ['{p:fld} has the wrong type', 'نوع قيمة {p} غير صحيح'],
    ['position is {a}% of equity (new limit {b}%)', 'المركز يمثل {a}% من رأس المال (الحد الجديد {b}%)'], ['position has no protective stop', 'المركز بلا وقف خسارة'],
    ['risk to stop ${a} = {b}% of equity (new limit {c}%)', 'المخاطرة حتى الوقف ${a} = {b}% من رأس المال (الحد الجديد {c}%)'],
    ['stop is {a}% below the price (new maximum {b}%)', 'الوقف أدنى من السعر بـ {a}% (الحد الأقصى الجديد {b}%)'],
    ['day P&L {a}% is beyond the new {b}% daily loss limit', 'أرباح/خسائر اليوم {a}% تتجاوز حد الخسارة اليومية الجديد {b}%'], ['drawdown {a}% is beyond the new {b}% limit', 'التراجع {a}% يتجاوز الحد الجديد {b}%'],
    ['the REST snapshot has a newer {s} quote ({a} ET) than the stream delivered ({b}) — the stream is not delivering {s2} updates; reconnecting', 'لقطة REST تحمل عرض سعر أحدث لـ {s} ({a} بتوقيت نيويورك) مما سلّمه البث ({b}) — البث لا يوصل تحديثات {s2}؛ جارٍ إعادة الاتصال'],
    ['the {f} feed is working ({r} quote {a:dur} ago), but {s} has had no {f2} quote change since {t} ({x}) — the stock currently has little or no activity on {f3}, a single venue with a small share of US volume; this is not a connection failure',
      'بث {f} يعمل (آخر عرض لـ {r} منذ {a})، لكن لم يتغير عرض {s} على {f2} منذ {t} ({x}) — السهم حاليًا قليل النشاط أو بلا نشاط على {f3}، وهي منصة واحدة بحصة صغيرة من حجم السوق الأمريكي؛ هذا ليس عطلًا في الاتصال'],
    ['the {f} feed is working ({r} quote {a:dur} ago), but {s} has had no {f2} quote change since {t} — the stock currently has little or no activity on {f3}, a single venue with a small share of US volume; this is not a connection failure',
      'بث {f} يعمل (آخر عرض لـ {r} منذ {a})، لكن لم يتغير عرض {s} على {f2} منذ {t} — السهم حاليًا قليل النشاط أو بلا نشاط على {f3}، وهي منصة واحدة بحصة صغيرة من حجم السوق الأمريكي؛ هذا ليس عطلًا في الاتصال'],
    ['no recent {f} activity even for {r} (last quote {a:dur} ago) — the {f2} feed or the market appears quiet', 'لا نشاط حديث على {f} حتى لـ {r} (آخر عرض منذ {a}) — يبدو بث {f2} أو السوق هادئًا'],
    ['no REST snapshot for {r} to compare against', 'لا توجد لقطة REST لـ {r} للمقارنة'], ['feed diagnosis via REST snapshot failed ({e})', 'فشل تشخيص البث عبر لقطة REST ({e})'],
    ['last trade ${p} at {t} ET {d}', 'آخر صفقة ${p} عند {t} بتوقيت نيويورك {d}'], ['{f} data resumes {d} {t} ET', 'تُستأنف بيانات {f} في {d} {t} بتوقيت نيويورك'],
    ['regular session opens {d} {t} ET', 'تفتح الجلسة الرسمية {d} {t} بتوقيت نيويورك'], ['the chart keeps the last real candles; nothing is generated while closed', 'يحتفظ الشارت بآخر الشموع الحقيقية؛ لا يُولّد شيء أثناء الإغلاق'],
    ['last bid/ask at {t} ET', 'آخر طلب/عرض عند {t} بتوقيت نيويورك'], ['new simulated trades are paused until a current bid/ask arrives', 'الصفقات المحاكاة الجديدة متوقفة حتى يصل عرض/طلب حالي'],
    [' — {f} data expected', ' — بيانات {f} متوقعة'], [' — no {f} data now ({r:tr})', ' — لا توجد بيانات {f} الآن ({r})'], [' — no {f} data now', ' — لا توجد بيانات {f} الآن'],
  ].map(([t, a]) => ({ ...compile(t), ar: a }));

  function fill(rule, m) {
    let out = rule.ar;
    rule.names.forEach((n, i) => {
      const fn = KIND[rule.kinds[i]] || KIND[''];
      const v = fn(m[i + 1]);
      out = out.split(`{${n}}`).join(v);
    });
    // keep currency signs, percent signs and "x" multipliers inside the left-to-right number isolate
    return out.replace(/\$⁦/g, '⁦$').replace(/-⁦\$/g, '⁦-$').replace(/⁩%/g, '%⁩').replace(/⁩x/g, 'x⁩');
  }
  function apply(rules, s) {
    for (const r of rules) { const m = r.re.exec(s); if (m) return fill(r, m); }
    return null;
  }
  /** Translate a fragment (label, reason, detail). Returns the original if unknown. */
  function trf(s) {
    if (I.lang !== 'ar' || s == null) return s;
    const str = String(s);
    if (!str.trim() || /[؀-ۿ]/.test(str)) return str;
    const a = apply(FRAG, str) || apply(PARTS, str);
    if (a != null) return a;
    if (str.includes(' · ')) { const parts = str.split(' · '); const t = parts.map((p) => apply(FRAG, p) || apply(PARTS, p)); if (t.every((x) => x != null)) return t.join(' · '); }
    if (str.includes('; ')) { const parts = str.split('; '); const t = parts.map((p) => apply(FRAG, p) || apply(PARTS, p)); if (t.every((x) => x != null)) return t.join('؛ '); }
    const full = apply(MSG, str);
    return full != null ? full : str;
  }
  const cache = new Map();
  /** Translate a full server message. Returns { text, translated }. */
  function msg(s) {
    if (I.lang !== 'ar' || s == null) return { text: s, translated: true };
    const str = String(s);
    if (cache.has(str)) return cache.get(str);
    let t = apply(MSG, str);
    if (t == null) { const f = trf(str); t = f !== str ? f : null; }
    const out = t == null ? { text: str, translated: false } : { text: t, translated: true };
    if (cache.size > 5000) cache.clear();
    cache.set(str, out);
    return out;
  }
  I.onChange(() => cache.clear());
  window.MSG = { msg, tr: trf, dur: (v) => (I.lang === 'ar' ? durUnits(v) : v) };
})();
