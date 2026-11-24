'use strict';
/**
 * Deterministic Arabic (Gulf-friendly) free-text intent parser. NO AI calls.
 * parseIntent(text, now) -> { intent, params } | { intent:'clarify', question, need, pending, options } | { intent:'unknown' }
 *
 * Intents: help, ai_usage{period,provider?}, report{kind}, why_trade{side,symbol}, ai_decision{symbol}, decisions, last_trades{count,side},
 * trade_count{period,outcome}, best_symbol{period}, worst_symbol{period}, orders{status,side}, news{symbol?}, exposure, buys{period},
 * sells{period}, cash, pnl{period}, stats{period}, positions, portfolio, risk, watchlist, ai, status, stock{symbol}.
 */
const TICKER_RE = /^[A-Z][A-Z0-9.]{0,9}$/;

// Latin words that are never tickers in a question.
const NOT_TICKERS = new Set([
  'ai', 'gemini', 'deepseek', 'openai', 'gpt', 'chatgpt', 'claude', 'llm', 'api', 'bot', 'usd', 'pnl', 'the', 'telegram',
  'ok', 'id', 'rsi', 'today', 'week', 'month', 'all', 'buy', 'sell', 'help', 'status', 'risk', 'cash', 'portfolio', 'tokens',
  'token', 'model', 'p', 'l', 'vs', 'and', 'or', 'of', 'to', 'in', 'on', 'is', 'a', 'an', 'my', 'me',
]);

const NUMBER_WORDS = {
  واحد: 1, واحده: 1, اثنين: 2, اثنتين: 2, اثنان: 2, ثنتين: 2, صفقتين: 2, ثلاث: 3, ثلاثه: 3, اربع: 4, اربعه: 4,
  خمس: 5, خمسه: 5, ست: 6, سته: 6, سبع: 7, سبعه: 7, ثمان: 8, ثماني: 8, ثمانيه: 8, تسع: 9, تسعه: 9, عشر: 10, عشره: 10,
};

function toWesternDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06F0));
}

/** Arabic normalization: tashkeel/tatweel removed, أإآ→ا, ى→ي, ة→ه, Eastern digits→Western, Latin lowercased. */
function normalize(text) {
  let s = toWesternDigits(text || '');
  s = s.replace(/[ؐ-ًؚ-ٰٟۖ-ۭ]/g, '');
  s = s.replace(/ـ/g, '');
  s = s.replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  s = s.replace(/؟/g, '?').replace(/،/g, ',').replace(/؛/g, ';');
  s = s.toLowerCase();
  s = s.replace(/[?!,;:()[\]{}"'«»\-_/\\]+/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Extracts uppercase tickers (validated) from raw text. */
function extractTickers(text) {
  const raw = toWesternDigits(text || '');
  const out = [];
  const re = /\$?([A-Za-z][A-Za-z0-9.]*)/g;
  let m;
  while ((m = re.exec(raw))) {
    // must not be glued to other Latin letters/digits on the left (regex is greedy on the right already)
    let tok = m[1].replace(/\.+$/, '');
    if (!tok || NOT_TICKERS.has(tok.toLowerCase())) continue;
    tok = tok.toUpperCase();
    if (TICKER_RE.test(tok) && !out.includes(tok)) out.push(tok);
  }
  return out;
}

function detectPeriod(n) {
  if (/(^| )(اليوم|هاليوم|today)( |$)/.test(n)) return 'today';
  if (/(الاسبوع|اسبوع|هالاسبوع|7 ايام|سبع ايام|سبعه ايام|week)/.test(n)) return 'week';
  if (/(الشهر|شهر|هالشهر|30 يوم|ثلاثين يوم|month)/.test(n)) return 'month';
  if (/(منذ البدايه|من البدايه|من اول|كل الوقت|الاجمالي|اجمالي|منذ الانطلاق|من بدينا|طول الفتره|من يوم بدينا|كل الفترات)/.test(n)) return 'all';
  return null;
}

function detectCount(n) {
  const d = n.match(/(^| )(\d{1,2})( |$)/);
  if (d) return Number(d[2]);
  for (const tok of n.split(' ')) {
    if (NUMBER_WORDS[tok]) return NUMBER_WORDS[tok];
  }
  return null;
}

const PERIOD_OPTIONS = [
  { label: 'اليوم', period: 'today' }, { label: 'هذا الأسبوع', period: 'week' },
  { label: 'هذا الشهر', period: 'month' }, { label: 'منذ البداية', period: 'all' },
];

function askPeriod(intent, params) {
  return {
    intent: 'clarify', need: 'period', question: 'لأي فترة تقصد؟ اختر من الأزرار:',
    pending: { intent, params },
    options: PERIOD_OPTIONS.map((o) => ({ label: o.label, intent, params: { ...params, period: o.period } })),
  };
}
function askSymbol(intent, params) {
  return {
    intent: 'clarify', need: 'symbol', question: 'أي سهم تقصد؟ أرسل رمز السهم (مثال: NVDA) أو اختر من الأزرار:',
    pending: { intent, params }, options: [],
  };
}

const has = (n, re) => re.test(n);

const RE = {
  help: /(^| )(مساعده|ساعدني|help|اوامر البوت|وش تقدر تسوي|ايش تقدر تسوي)( |$)|^(الاوامر|وش الاوامر|ايش الاوامر)$/,
  usage: /(استهلك|استهلاك|تكلفه|التكلفه|كلفه|كلفنا|صرفنا|مصروف|ميزانيه|الميزانيه|توكن|tokens?)/,
  aiWord: /(ذكاء|الذكاء|gemini|deepseek|openai|gpt|( |^)ai( |$)|النموذج|الموديل)/,
  report: /(تقرير|التقرير)/,
  why: /(^| )(ليش|لماذا|ليه|لمه|وش سبب|ايش سبب|ما سبب|سبب|وش السبب)( |$)/,
  sellVerb: /(باع|بعنا|بعت|بيع|مبيعات|بايع)/,
  buyVerb: /(اشتر|شراء|الشرا|مشتريات|شرينا|شريت)/,
  decisionOne: /(^| )(قرار|القرار|توصيه|التوصيه|رايه|راي)( |$)/,
  decisionMany: /(قرارات|القرارات|التوصيات)/,
  last: /(^| )(اخر|اخير|اخيره|الاخيره)( |$)/,
  tradeWord: /(صفقه|صفقات|صفقتين|الصفقات|عمليات|تنفيذات)/,
  how: /(^| )(كم|عدد)( |$)/,
  lossWord: /(خسرنا|خسرت|خاسره|خساره|خسران|الخاسره|خسر)/,
  winWord: /(ربحنا|ربحت|رابحه|الرابحه|ناجحه|ربح)/,
  bestSym: /((اكثر|افضل|اعلي|اكبر) (سهم|الاسهم|شركه))|(السهم الافضل)/,
  worstSym: /((اسوا|اضعف) (سهم|الاسهم))|((اكثر|اكبر) سهم خسر)/,
  pending: /(معلق|معلقه|المعلقه|pending|ما تنفذ|ما تنفذت)/,
  cash: /(سيوله|السيوله|كاش|الكاش|نقد|cash|الرصيد المتاح|رصيد متاح)/,
  pnl: /(ربح|ارباح|الارباح|خساره|خسرنا|خسرت|العائد|عائد|كسبنا|كسبت)/,
  stats: /(احصائيات|الاحصائيات|احصاءات|اداء|الاداء)/,
  positions: /(المراكز|مراكز|وش املك|ايش املك|اللي عندي|اللي نملك|المملوكه|اسهمي|ممتلكات)/,
  portfolio: /(محفظه|المحفظه|راس المال|قيمه الحساب|equity)/,
  risk: /(مخاطر|المخاطر|مخاطره|المخاطره|risk)/,
  watch: /(مراقبه|المراقبه|watchlist|قائمه الاسهم|الاسهم المراقبه)/,
  status: /(حاله|الحاله|الوضع|وضع|شغال|يشتغل|status|السوق مفتوح|جلسه السوق|السوق)/,
  orders: /(اوامر|الاوامر|طلبات)/,
  stockWord: /(سهم|سعر|السهم)/,
  deepseek: /(deepseek|ديب ?سيك)/,
  gemini: /(gemini|جيميني|جيمناي|جمناي)/,
  news: /(^| )(اخبار|الاخبار|خبر|الخبر|news)( |$)/,
  exposure: /(مستثمر|نسبه الاستثمار|(^| )(ال)?تعرض( |$))/,
  exposureQ: /(^| )(نسبه|كم|قديش|وش|ايش|ما)( |$)/,
};

function parseIntent(text, now = Date.now()) { // eslint-disable-line no-unused-vars
  const n = normalize(text);
  if (!n) return { intent: 'unknown' };
  const tickers = extractTickers(text);
  const symbol = tickers[0] || null;
  const period = detectPeriod(n);

  if (has(n, RE.help)) return { intent: 'help', params: {} };

  if (has(n, RE.usage) && (has(n, RE.aiWord) || has(n, RE.deepseek) || has(n, RE.gemini) || /استهلكنا|استهلاك/.test(n))) {
    const provider = has(n, RE.deepseek) && !has(n, RE.gemini) ? 'deepseek' : (has(n, RE.gemini) && !has(n, RE.deepseek) ? 'gemini' : null);
    return { intent: 'ai_usage', params: provider ? { period: period || 'today', provider } : { period: period || 'today' } };
  }

  if (has(n, RE.report)) {
    if (/(يومي|اليومي)/.test(n)) return { intent: 'report', params: { kind: 'daily' } };
    if (/(اسبوعي|الاسبوعي)/.test(n)) return { intent: 'report', params: { kind: 'weekly' } };
    if (/(شهري|الشهري)/.test(n)) return { intent: 'report', params: { kind: 'monthly' } };
    if (period === 'today') return { intent: 'report', params: { kind: 'daily' } };
    if (period === 'week') return { intent: 'report', params: { kind: 'weekly' } };
    if (period === 'month') return { intent: 'report', params: { kind: 'monthly' } };
  }

  if (has(n, RE.why) && (has(n, RE.sellVerb) || has(n, RE.buyVerb))) {
    const side = has(n, RE.sellVerb) ? 'SELL' : 'BUY';
    if (!symbol) return askSymbol('why_trade', { side });
    return { intent: 'why_trade', params: { side, symbol } };
  }

  if (has(n, RE.decisionMany) && !symbol) {
    const kind = has(n, RE.sellVerb) ? 'sell' : (has(n, RE.buyVerb) ? 'buy' : 'all');
    return { intent: 'decisions', params: { kind } };
  }
  if (has(n, RE.decisionOne) || has(n, RE.decisionMany)) {
    if (symbol) return { intent: 'ai_decision', params: { symbol } };
    return askSymbol('ai_decision', {});
  }

  if (has(n, RE.last) && has(n, RE.tradeWord)) {
    let count = detectCount(n);
    if (count == null && /صفقتين/.test(n)) count = 2;
    if (count == null) count = /(^| )(اخر صفقه)( |$)/.test(n) ? 1 : 5;
    count = Math.max(1, Math.min(count, 20));
    const side = has(n, RE.sellVerb) ? 'SELL' : (has(n, RE.buyVerb) ? 'BUY' : null);
    return { intent: 'last_trades', params: { count, side, symbol } };
  }

  if (has(n, RE.how) && has(n, RE.tradeWord)) {
    const outcome = has(n, RE.lossWord) ? 'loss' : (has(n, RE.winWord) ? 'win' : 'all');
    if (!period) return askPeriod('trade_count', { outcome });
    return { intent: 'trade_count', params: { period, outcome } };
  }

  if (has(n, RE.worstSym) || (has(n, RE.bestSym) && has(n, RE.lossWord))) return { intent: 'worst_symbol', params: { period: period || 'all' } };
  if (has(n, RE.bestSym)) return { intent: 'best_symbol', params: { period: period || 'all' } };

  if (has(n, RE.pending) && (has(n, RE.orders) || has(n, RE.buyVerb) || has(n, RE.sellVerb))) {
    const side = has(n, RE.sellVerb) ? 'SELL' : (has(n, RE.buyVerb) ? 'BUY' : null);
    return { intent: 'orders', params: { status: 'OPEN', side } };
  }

  if (has(n, RE.news)) return { intent: 'news', params: symbol ? { symbol } : {} };

  if (has(n, RE.exposure) && (has(n, RE.exposureQ) || has(n, RE.portfolio))) return { intent: 'exposure', params: {} };

  if (has(n, RE.buyVerb) && !has(n, RE.sellVerb)) {
    if (!period) return askPeriod('buys', {});
    return { intent: 'buys', params: { period } };
  }
  if (has(n, RE.sellVerb)) {
    if (!period) return askPeriod('sells', {});
    return { intent: 'sells', params: { period } };
  }

  if (has(n, RE.cash)) return { intent: 'cash', params: {} };

  if (has(n, RE.pnl) && !has(n, RE.stockWord)) {
    if (!period) return askPeriod('pnl', {});
    return { intent: 'pnl', params: { period } };
  }
  if (has(n, RE.pnl) && symbol) return { intent: 'stock', params: { symbol } };

  if (has(n, RE.stats)) return { intent: 'stats', params: { period: period || 'today' } };
  if (has(n, RE.positions)) return { intent: 'positions', params: {} };
  if (has(n, RE.portfolio)) return { intent: 'portfolio', params: {} };
  if (has(n, RE.risk)) return { intent: 'risk', params: {} };
  if (has(n, RE.watch)) return { intent: 'watchlist', params: {} };
  if (has(n, RE.aiWord) && !symbol) return { intent: 'ai', params: {} };
  if (has(n, RE.status) && !symbol) return { intent: 'status', params: {} };
  if (has(n, RE.orders)) return { intent: 'orders', params: { status: null, side: null } };
  if (symbol) return { intent: 'stock', params: { symbol } };
  if (has(n, RE.stockWord)) return askSymbol('stock', {});
  return { intent: 'unknown' };
}

module.exports = { parseIntent, normalize, extractTickers, detectPeriod, detectCount, TICKER_RE };
