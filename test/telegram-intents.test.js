'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseIntent, normalize, extractTickers } = require('../server/telegram/intents');

const NOW = Date.UTC(2026, 10, 20, 10, 0, 0);
const p = (t) => parseIntent(t, NOW);

test('intents: normalization (tashkeel, tatweel, alef forms, ya/ta marbuta, Eastern digits, Latin case)', () => {
  assert.equal(normalize('أَرْبَاحـــي'), 'ارباحي');
  assert.equal(normalize('إآأ ى ة'), 'ااا ي ه');
  assert.equal(normalize('آخر ٣ صفقات'), 'اخر 3 صفقات');
  assert.equal(normalize('Gemini'), 'gemini');
  assert.deepEqual(extractTickers('ليش باع سهم NVDA؟'), ['NVDA']);
  assert.deepEqual(extractTickers('كم استهلكنا من Gemini اليوم؟'), []);
  assert.deepEqual(extractTickers('سعر $brk.b'), ['BRK.B']);
});

test('intents: period P&L', () => {
  assert.deepEqual(p('كم ربحي اليوم؟'), { intent: 'pnl', params: { period: 'today' } });
  assert.deepEqual(p('كم ربحنا اليوم؟'), { intent: 'pnl', params: { period: 'today' } });
  assert.deepEqual(p('كم ربحنا هذا الأسبوع'), { intent: 'pnl', params: { period: 'week' } });
  assert.deepEqual(p('كم ربحنا هالشهر'), { intent: 'pnl', params: { period: 'month' } });
});

test('intents: buys / sells with period', () => {
  assert.deepEqual(p('وش الأسهم اللي اشتراها البوت اليوم؟'), { intent: 'buys', params: { period: 'today' } });
  assert.deepEqual(p('عطني كل أوامر البيع هذا الأسبوع'), { intent: 'sells', params: { period: 'week' } });
});

test('intents: losing round trips, best symbol, cash', () => {
  assert.deepEqual(p('كم صفقة خسرنا هذا الشهر؟'), { intent: 'trade_count', params: { period: 'month', outcome: 'loss' } });
  assert.deepEqual(p('وش أكثر سهم ربحنا منه؟'), { intent: 'best_symbol', params: { period: 'all' } });
  assert.equal(p('وش أكثر سهم خسرنا منه؟').intent, 'worst_symbol');
  assert.deepEqual(p('كم باقي عندي سيولة؟'), { intent: 'cash', params: {} });
});

test('intents: why sold a ticker / latest AI decision for a ticker', () => {
  assert.deepEqual(p('ليش باع سهم NVDA؟'), { intent: 'why_trade', params: { side: 'SELL', symbol: 'NVDA' } });
  assert.deepEqual(p('ليش اشترى AMD'), { intent: 'why_trade', params: { side: 'BUY', symbol: 'AMD' } });
  assert.deepEqual(p('وش قرار الذكاء الاصطناعي على AMD؟'), { intent: 'ai_decision', params: { symbol: 'AMD' } });
});

test('intents: last N trades (digits and Arabic number words 1-10)', () => {
  assert.deepEqual(p('اعرض آخر خمس صفقات'), { intent: 'last_trades', params: { count: 5, side: null, symbol: null } });
  assert.equal(p('اعرض آخر ٣ صفقات').params.count, 3);
  const words = { واحدة: 1, اثنين: 2, ثلاث: 3, أربع: 4, خمسة: 5, ست: 6, سبع: 7, ثمان: 8, تسع: 9, عشر: 10 };
  for (const [w, n] of Object.entries(words)) assert.equal(p(`اعرض آخر ${w} صفقات`).params.count, n, w);
  assert.equal(p('اعرض آخر صفقتين').params.count, 2);
});

test('intents: AI usage today (provider name or generic)', () => {
  assert.deepEqual(p('كم استهلكنا من Gemini اليوم؟'), { intent: 'ai_usage', params: { period: 'today', provider: 'gemini' } });
  assert.deepEqual(p('كم استهلكنا من الذكاء الاصطناعي اليوم؟'), { intent: 'ai_usage', params: { period: 'today' } });
  assert.deepEqual(p('كم استهلاك DeepSeek اليوم؟'), { intent: 'ai_usage', params: { period: 'today', provider: 'deepseek' } });
  assert.deepEqual(p('كم استهلاك Gemini؟'), { intent: 'ai_usage', params: { period: 'today', provider: 'gemini' } });
  assert.deepEqual(p('كم تكلفة ديب سيك هذا الشهر'), { intent: 'ai_usage', params: { period: 'month', provider: 'deepseek' } });
  assert.deepEqual(p('كم استهلاك DeepSeek و Gemini اليوم'), { intent: 'ai_usage', params: { period: 'today' } }, 'both named → combined');
});

test('intents: best stock, last decision on a ticker, weekly loss, invested share, news', () => {
  assert.deepEqual(p('وش أكثر سهم ربحنا منه؟'), { intent: 'best_symbol', params: { period: 'all' } });
  assert.deepEqual(p('وش آخر قرار على AMD؟'), { intent: 'ai_decision', params: { symbol: 'AMD' } });
  assert.deepEqual(p('كم خسرت هذا الأسبوع؟'), { intent: 'pnl', params: { period: 'week' } });
  assert.deepEqual(p('كم نسبة المحفظة المستثمرة؟'), { intent: 'exposure', params: {} });
  assert.deepEqual(p('وش نسبة التعرض؟'), { intent: 'exposure', params: {} });
  assert.equal(p('استعرض المحفظة').intent, 'portfolio', '"استعرض" is not "التعرض"');
  assert.deepEqual(p('وش آخر الأخبار؟'), { intent: 'news', params: {} });
  assert.deepEqual(p('اخبار NVDA'), { intent: 'news', params: { symbol: 'NVDA' } });
  assert.equal(p('اخبرني عن المحفظة').intent, 'portfolio', '"اخبرني" is not news');
  assert.deepEqual(p('وش رأيك في الطقس'), { intent: 'unknown' });
});

test('intents: portfolio / positions / risk / status phrasings', () => {
  assert.equal(p('كيف المحفظة؟').intent, 'portfolio');
  assert.equal(p('وش الأسهم اللي عندي').intent, 'positions');
  assert.equal(p('المراكز المفتوحة').intent, 'positions');
  assert.equal(p('وش مستوى المخاطرة').intent, 'risk');
  assert.equal(p('هل البوت شغال؟').intent, 'status');
  assert.equal(p('الأوامر المعلقة').intent, 'orders');
  assert.equal(p('NVDA').intent, 'stock');
});

test('intents: missing period or ticker asks a clarifying question with options', () => {
  const a = p('كم ربحي؟');
  assert.equal(a.intent, 'clarify');
  assert.equal(a.need, 'period');
  assert.deepEqual(a.options.map((o) => o.params.period), ['today', 'week', 'month', 'all']);
  assert.ok(a.question.length > 0);
  const b = p('ليش باع؟');
  assert.equal(b.intent, 'clarify');
  assert.equal(b.need, 'symbol');
  assert.deepEqual(b.pending, { intent: 'why_trade', params: { side: 'SELL' } });
  assert.equal(p('وش قرار الذكاء الاصطناعي؟').need, 'symbol');
});

test('intents: unknown text', () => {
  assert.deepEqual(p('شلونك'), { intent: 'unknown' });
  assert.deepEqual(p(''), { intent: 'unknown' });
});
