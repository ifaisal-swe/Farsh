'use strict';
/**
 * Screen renderers. Each returns { text, keyboard } where keyboard is rows of [label, callbackData].
 * All numbers come from the service; unknown values are shown as "غير متاح" / "بيانات غير كافية".
 * Nothing here triggers AI analysis or places orders — read-only service calls only.
 */
const F = require('./format');

const { esc, money, signedMoney, price, pct, qty, int, label, NA, INSUFFICIENT } = F;

const HOME = [['🏠 القائمة الرئيسية', 'm']];
const PAPER_NOTE = '🧪 تداول ورقي فقط — لا يتم إرسال أي أوامر حقيقية إلى أي وسيط.';
const PAGE = 5;
const ORDERS_PAGE = 8;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,48}$/;

const FILL_PERIODS = { t: 'today', 7: '7d', 30: '30d', a: 'all' };
const FILL_PERIOD_LABEL = { t: 'اليوم', 7: 'آخر 7 أيام', 30: 'آخر 30 يومًا', a: 'جميع الفترات' };
const STATS_PERIODS = { t: 'today', w: 'week', m: 'month', a: 'all' };
const STATS_CODE = { today: 't', week: 'w', month: 'm', all: 'a' };
const STATS_LABEL = { today: 'اليوم', week: 'هذا الأسبوع', month: 'هذا الشهر', all: 'منذ البداية' };
const FILL_CODE_FROM_STATS = { today: 't', week: '7', month: '30', all: 'a' };
const REPORT_TITLE = { daily: '🗓️ التقرير اليومي', weekly: '🗓️ التقرير الأسبوعي', monthly: '🗓️ التقرير الشهري' };
const PROFILES = ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE', 'VERY_AGGRESSIVE'];

const ln = (k, v) => `• ${k}: ${v}`;
const mark = (on, text) => (on ? `✔️ ${text}` : text);
const b = (s) => `<b>${s}</b>`;
const code = (s) => `<code>${esc(s)}</code>`;
const tzNote = (tz) => `🕒 الأوقات ${F.tzLabel(tz)}`;
const when = (ts, tz) => (F.isNum(ts) ? F.dateTime(ts, tz) : NA);
const link = (url, text) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));
const yesNo = (v) => (v == null ? NA : (v ? 'نعم' : 'لا'));
const freshText = (fresh) => (fresh == null ? NA : (fresh ? '✅ بيانات حديثة' : '⚠️ بيانات غير حديثة'));
const current = (on, text) => (on ? `✅ ${text}` : text);

const STATE_ICON = { ACTIVE: '🟢', PAUSED: '⏸️', ERROR: '🔴', RISK_BLOCKED: '⛔', ONLINE: '🟢', DEGRADED: '🟠' };
/** "🟢 نشطة" for monitoringState / aiTradingState / serverState values. */
function stateText(group, v) {
  if (v == null || v === '') return NA;
  return `${STATE_ICON[v] ? `${STATE_ICON[v]} ` : ''}${label(group, v)}`;
}
const COMPONENT_ORDER = ['database', 'engine', 'alpaca', 'tiingo', 'deepseek', 'gemini', 'telegram', 'news'];
const COMPONENT_ICON = { ok: '✅', degraded: '⚠️', error: '❌', not_configured: '⚪', idle: '💤', disabled: '⛔' };
const AI_PROVIDER_MODES = ['DEEPSEEK', 'GEMINI', 'AUTO', 'DUAL'];
const BUDGET_NOTE = 'ℹ️ الميزانية حد إنفاق مضبوط داخل التطبيق وليست رصيدًا مؤكدًا لدى المزود.';
const ms = (x) => (F.isNum(x) ? `${int(x)} مللي ثانية` : NA);

function pager(prefix, page, total, perPage, suffix = '') {
  const pages = Math.max(1, Math.ceil((Number(total) || 0) / perPage));
  if (pages <= 1) return [];
  const row = [];
  if (page > 0) row.push(['◀️ السابق', `${prefix}:${page - 1}${suffix}`]);
  row.push([`${Math.min(page + 1, pages)} / ${pages}`, 'noop']);
  if (page < pages - 1) row.push(['التالي ▶️', `${prefix}:${page + 1}${suffix}`]);
  return [row];
}

/** metric value respecting `insufficient` flags. */
function metric(insufficient, name, value, fmt) {
  const ins = insufficient || {};
  if (ins[name]) return INSUFFICIENT;
  if (value == null || (typeof value === 'number' && !Number.isFinite(value))) return NA;
  return fmt(value);
}

// ------------------------------------------------------------------ main menu / help
function mainMenu() {
  const text = [
    '📊 <b>فرصة | المضاربة الذكية</b>',
    'مرحبًا بك في لوحة التحكم بالمحفظة الافتراضية.',
    'يمكنك متابعة أداء المحفظة والصفقات وقرارات الذكاء الاصطناعي مباشرة من تيليجرام.',
    '',
    '🧪 <b>تداول ورقي فقط:</b> جميع الصفقات افتراضية، ولا يتم إرسال أي أوامر حقيقية إلى أي وسيط.',
    '',
    'اختر من القائمة أو اكتب سؤالك مباشرة، مثل: «كم ربحي اليوم؟»',
  ].join('\n');
  const keyboard = [
    [['💼 المحفظة', 'pf'], ['📈 الأسهم المراقبة', 'w']],
    [['🟢 أوامر الشراء', 'b:a:0'], ['🔴 أوامر البيع', 's:a:0']],
    [['📋 سجل الصفقات', 'tr:a:a:0'], ['📊 الإحصائيات', 'st:t']],
    [['🤖 الذكاء الاصطناعي', 'ai'], ['⚠️ إدارة المخاطر', 'rk']],
    [['📰 الأخبار', 'nw'], ['🔔 الإشعارات', 'n']],
    [['⚙️ الإعدادات', 'cfg']],
  ];
  return { text, keyboard };
}

const COMMANDS = [
  ['start', 'القائمة الرئيسية'],
  ['help', 'قائمة الأوامر والمساعدة'],
  ['portfolio', 'ملخص المحفظة الافتراضية'],
  ['buys', 'عمليات الشراء المنفذة'],
  ['sells', 'عمليات البيع المنفذة'],
  ['orders', 'الأوامر وحالاتها (معلقة، منفذة، ملغاة، مرفوضة)'],
  ['trades', 'سجل الصفقات المنفذة'],
  ['stats', 'الإحصائيات حسب الفترة'],
  ['daily', 'التقرير اليومي'],
  ['weekly', 'التقرير الأسبوعي'],
  ['monthly', 'التقرير الشهري'],
  ['stock', 'تفاصيل سهم — مثال: /stock NVDA'],
  ['watchlist', 'الأسهم المراقبة'],
  ['news', 'آخر الأخبار المسجلة للأسهم المراقبة'],
  ['addstock', 'إضافة سهم للمراقبة — مثال: /addstock AMD'],
  ['removestock', 'إزالة سهم من المراقبة'],
  ['pause', 'إيقاف مراقبة سهم مؤقتًا'],
  ['resume', 'استئناف مراقبة سهم'],
  ['ai', 'الذكاء الاصطناعي: الوضع والمزودون والاستهلاك'],
  ['decisions', 'قرارات الذكاء الاصطناعي المسجلة'],
  ['risk', 'إدارة المخاطر ومستوى المخاطرة'],
  ['status', 'حالة النظام والسوق'],
  ['monitoring', 'المراقبة التكيفية: وضع الجلسة وشدتها'],
  ['pauseai', 'إيقاف الذكاء الاصطناعي مؤقتًا'],
  ['resumeai', 'استئناف الذكاء الاصطناعي'],
  ['stopai', 'إيقاف الذكاء الاصطناعي'],
  ['notifications', 'إعدادات الإشعارات'],
  ['settings', 'الإعدادات'],
];

function help() {
  const lines = ['❓ <b>المساعدة — قائمة الأوامر</b>', ''];
  for (const [c, d] of COMMANDS) lines.push(`/${c} — ${esc(d)}`);
  lines.push('');
  lines.push('💬 <b>يمكنك أيضًا الكتابة بالعربي، مثل:</b>');
  for (const q of ['كم ربحي اليوم؟', 'وش الأسهم اللي اشتراها البوت اليوم؟', 'عطني كل أوامر البيع هذا الأسبوع', 'ليش باع سهم NVDA؟', 'اعرض آخر خمس صفقات',
    'كم استهلكنا من الذكاء الاصطناعي اليوم؟', 'كم استهلاك DeepSeek اليوم؟', 'وش آخر قرار على AMD؟', 'كم نسبة المحفظة المستثمرة؟']) lines.push(`• ${esc(q)}`);
  lines.push('');
  lines.push('🔐 العمليات التي تغيّر الحالة تتطلب تأكيدًا وصلاحية تحكم.');
  lines.push(PAPER_NOTE);
  return { text: lines.join('\n'), keyboard: [HOME] };
}

// ------------------------------------------------------------------ portfolio
async function portfolio(ctx) {
  const p = await ctx.svc('portfolio');
  if (!p) return { text: '💼 <b>المحفظة الافتراضية</b>\nلا تتوفر بيانات المحفظة حاليًا.', keyboard: [HOME] };
  const lines = ['💼 <b>المحفظة الافتراضية</b>', ''];
  lines.push(ln('رأس المال الابتدائي', money(p.initialCapital)));
  lines.push(ln('القيمة الحالية', b(money(p.equity))));
  lines.push(ln('السيولة المتاحة', money(p.cash)));
  lines.push(ln('النقد المحجوز', `${money(p.reservedCash)}${F.isNum(p.reservedCash) && p.reservedCash > 0 ? ' (لأوامر شراء محددة معلقة)' : ''}`));
  lines.push(ln('القيمة المستثمرة', `${money(p.positionValue)}${F.isNum(p.costBasis) ? ` (التكلفة: ${money(p.costBasis)})` : ''}`));
  lines.push(ln('الربح المحقق', signedMoney(p.realizedPnl)));
  lines.push(ln('الربح غير المحقق', signedMoney(p.unrealizedPnl)));
  lines.push(ln('إجمالي الأرباح', b(signedMoney(p.totalPnl))));
  lines.push(ln('العائد الإجمالي', pct(p.totalReturnPct)));
  lines.push(ln('الرسوم', money(p.feesPaid)));
  lines.push(ln('نسبة التعرض', pct(p.exposurePct, false)));
  lines.push(ln('الأسهم المملوكة', int(p.positionsCount)));
  lines.push(ln('الأسهم المراقبة', int(p.watchlistCount)));
  lines.push(ln('مستوى المخاطرة', label('profile', p.riskProfile)));
  lines.push(ln('حالة الذكاء الاصطناعي', label('aiState', p.aiState)));
  lines.push(ln('حالة مراقبة السوق', stateText('monitoringState', p.monitoringState)));
  lines.push(ln('حالة التداول الآلي', stateText('aiTradingState', p.aiTradingState)));
  const v = p.valuation || {};
  if (v.stale) {
    const syms = (v.staleSymbols || []).map(esc).join('، ');
    lines.push('');
    lines.push(`⚠️ التقييم يعتمد على أسعار غير حديثة لـ: ${syms || NA}`);
  }
  if (p.hasSession === false) { lines.push(''); lines.push('ℹ️ لا توجد جلسة تداول نشطة حاليًا.'); }
  lines.push('');
  if (F.isNum(v.asOf)) lines.push(`🕒 آخر تقييم: ${when(v.asOf, ctx.tz)} (${F.tzLabel(ctx.tz)})`);
  lines.push(PAPER_NOTE);
  return {
    text: lines.join('\n'),
    keyboard: [[['📂 تفاصيل المراكز', 'pf:pos'], ['📅 أداء اليوم', 'pf:td']], [['📊 الإحصائيات', 'st:t'], ['🔄 تحديث', 'pf']], HOME],
  };
}

async function positions(ctx) {
  const p = await ctx.svc('portfolio');
  const list = (p && p.positions) || [];
  const lines = ['📂 <b>تفاصيل المراكز المفتوحة</b>', ''];
  if (!list.length) lines.push('لا توجد مراكز مفتوحة حاليًا.');
  list.forEach((x, i) => {
    lines.push(`${b(`${i + 1})`)} ${b(esc(x.symbol))}`);
    lines.push(`   الكمية: ${qty(x.qty)} | متوسط السعر: ${price(x.avgPrice)}`);
    const kind = x.markKind ? ` (${label('markKind', x.markKind)})` : '';
    lines.push(`   سعر التقييم: ${price(x.mark)}${kind}${x.markStale ? ' ⚠️ غير حديث' : ''}`);
    if (F.isNum(x.markTs)) lines.push(`   وقت السعر: ${when(x.markTs, ctx.tz)}`);
    lines.push(`   القيمة السوقية: ${money(x.marketValue)}`);
    lines.push(`   الربح غير المحقق: ${signedMoney(x.unrealizedPnl)} (${pct(x.unrealizedPct)})`);
    lines.push(`   وقف الخسارة: ${price(x.stop)} | جني الأرباح: ${price(x.takeProfit)}`);
  });
  if (p && p.valuation && p.valuation.stale) { lines.push(''); lines.push(`⚠️ التقييم يعتمد على أسعار غير حديثة لـ: ${(p.valuation.staleSymbols || []).map(esc).join('، ') || NA}`); }
  lines.push('');
  lines.push(tzNote(ctx.tz));
  const symRows = [];
  const syms = list.map((x) => x.symbol).filter((s) => ctx.isTicker(s)).slice(0, 6);
  for (let i = 0; i < syms.length; i += 3) symRows.push(syms.slice(i, i + 3).map((s) => [`📈 ${s}`, `sk:${s}`]));
  return { text: lines.join('\n'), keyboard: [...symRows, [['🔄 تحديث', 'pf:pos'], ['💼 المحفظة', 'pf']], HOME] };
}

function periodPortfolioLines(pp, ins) {
  const lines = [];
  lines.push(ln('قيمة البداية', metric(ins, 'startEquity', pp.startEquity, money)));
  lines.push(ln('القيمة الحالية', metric(ins, 'endEquity', pp.endEquity, money)));
  lines.push(ln('صافي الربح/الخسارة', b(metric(ins, 'netPnl', pp.netPnl, signedMoney))));
  lines.push(ln('العائد', metric(ins, 'netReturnPct', pp.netReturnPct, (x) => pct(x))));
  lines.push(ln('الربح المحقق', metric(ins, 'realizedPnl', pp.realizedPnl, signedMoney)));
  lines.push(ln('الربح غير المحقق', metric(ins, 'unrealizedPnl', pp.unrealizedPnl, signedMoney)));
  lines.push(ln('السيولة', metric(ins, 'cash', pp.cash, money)));
  lines.push(ln('المستثمر', metric(ins, 'invested', pp.invested, money)));
  return lines;
}

async function todayPerf(ctx) {
  const pp = (await ctx.svc('todayPerformance')) || {};
  const lines = ['📅 <b>أداء اليوم</b>', '', ...periodPortfolioLines(pp, {}), '', tzNote(ctx.tz), PAPER_NOTE];
  return { text: lines.join('\n'), keyboard: [[['📊 الإحصائيات', 'st:t'], ['💼 المحفظة', 'pf']], HOME] };
}

// ------------------------------------------------------------------ fills (buys / sells)
function fillLines(f, n, tz, { sell = false, detailed = false } = {}) {
  const lines = [];
  const sideTxt = detailed ? `${f.side === 'SELL' ? '🔴 بيع' : '🟢 شراء'} ` : '';
  lines.push(`${b(`${n})`)} ${sideTxt}${b(esc(f.symbol))} — ${F.date(f.ts, tz)}، ${F.time(f.ts, tz)}`);
  const notional = F.isNum(f.notional) ? f.notional : (F.isNum(f.qty) && F.isNum(f.price) ? f.qty * f.price : null);
  lines.push(`   الكمية: ${qty(f.qty)} | سعر التنفيذ: ${price(f.price)}`);
  lines.push(`   الإجمالي: ${money(notional)} | الحالة: ✅ منفذ${detailed ? ` | الرسوم: ${money(f.fees)}` : ''}`);
  if (sell || (detailed && f.side === 'SELL')) {
    lines.push(`   متوسط سعر الشراء: ${price(f.costBasisPrice)}`);
    lines.push(`   الربح/الخسارة المحققة: ${signedMoney(f.realizedPnl)} (${pct(f.returnPct)})`);
    const trig = F.exitTriggerOf(f);
    lines.push(`   محفز الخروج: ${trig ? b(F.exitTriggerText(trig)) : label('source', f.kind)}`);
    if (trig === 'AI' && f.aiProvider) lines.push(`   مزود التحليل: ${F.providerLabel(f.aiProvider)}`);
  } else {
    const total = F.isNum(notional) ? notional + (F.isNum(f.fees) ? f.fees : 0) : null;
    if (!detailed) lines.push(`   الرسوم: ${money(f.fees)} | التكلفة الإجمالية: ${b(money(total))}`);
    else lines.push(`   التكلفة الإجمالية مع الرسوم: ${money(total)}`);
    lines.push(`   المصدر: ${label('source', f.kind)} | مزود التحليل: ${F.providerLabel(f.aiProvider)}`);
  }
  if (detailed && f.strategy) lines.push(`   الاستراتيجية: ${esc(f.strategy)}`);
  if (f.reason) lines.push(`   السبب: ${esc(F.clip(f.reason, 160))}`);
  const ids = [`رقم التنفيذ: ${code(f.id)}`];
  if (detailed && f.orderId != null) ids.push(`الأمر: ${code(f.orderId)}`);
  if (detailed && f.decisionId != null) ids.push(`القرار: ${code(f.decisionId)}`);
  lines.push(`   ${ids.join(' | ')}`);
  return lines;
}

async function fillsList(ctx, { side, pcode = 'a', page = 0, symbol = null }) {
  const period = FILL_PERIODS[pcode] || 'all';
  const res = (await ctx.svc('fills', { side, symbol: symbol || null, period, limit: PAGE, offset: page * PAGE })) || {};
  const items = res.items || [];
  const total = F.isNum(res.total) ? res.total : items.length;
  const isSell = side === 'SELL';
  const p = isSell ? 's' : 'b';
  const lines = [isSell ? '🔴 <b>عمليات البيع المنفذة</b>' : '🟢 <b>عمليات الشراء المنفذة</b>'];
  lines.push(`الفترة: ${FILL_PERIOD_LABEL[pcode]}${symbol ? ` — السهم: ${b(esc(symbol))}` : ''} | العدد: ${int(total)}`);
  lines.push('');
  if (!items.length) lines.push(`لا توجد عمليات ${isSell ? 'بيع' : 'شراء'} منفذة في هذه الفترة.`);
  items.forEach((f, i) => { lines.push(...fillLines(f, page * PAGE + i + 1, ctx.tz, { sell: isSell })); lines.push(''); });
  lines.push(tzNote(ctx.tz));
  lines.push(PAPER_NOTE);
  const sfx = symbol ? `:${symbol}` : '';
  const keyboard = [
    [[mark(pcode === 't', 'اليوم'), `${p}:t:0${sfx}`], [mark(pcode === '7', 'آخر 7 أيام'), `${p}:7:0${sfx}`], [mark(pcode === '30', 'آخر 30 يومًا'), `${p}:30:0${sfx}`]],
    [[mark(pcode === 'a' && !symbol, 'جميع الأوامر'), `${p}:a:0`], [mark(!!symbol, '🔎 حسب السهم'), `${p}:sym`], ['⏳ الأوامر المعلقة', `${p}:pend`]],
    ...pager(`${p}:${pcode}`, page, total, PAGE, sfx),
    HOME,
  ];
  return { text: lines.join('\n'), keyboard };
}

async function recentSymbols(ctx, side) {
  const out = [];
  try {
    const res = await ctx.svc('fills', { side: side || null, symbol: null, period: 'all', limit: 30, offset: 0 });
    for (const f of (res && res.items) || []) if (ctx.isTicker(f.symbol) && !out.includes(f.symbol)) out.push(f.symbol);
  } catch { /* ignore */ }
  if (out.length < 8) {
    try {
      const wl = await ctx.svc('watchlist');
      for (const w of wl || []) if (ctx.isTicker(w.symbol) && !out.includes(w.symbol)) out.push(w.symbol);
    } catch { /* ignore */ }
  }
  return out.slice(0, 9);
}

function symbolButtons(symbols, dataFn) {
  const rows = [];
  for (let i = 0; i < symbols.length; i += 3) rows.push(symbols.slice(i, i + 3).map((s) => [s, dataFn(s)]));
  return rows;
}

async function askSymbol(ctx, { title, dataFn, side = null, includeWatch = true }) {
  const syms = includeWatch ? await recentSymbols(ctx, side) : [];
  const lines = [title, '', 'أرسل رمز السهم (مثال: NVDA)' + (syms.length ? ' أو اختر من الأزرار:' : '.')];
  return { text: lines.join('\n'), keyboard: [...symbolButtons(syms, dataFn), HOME] };
}

// ------------------------------------------------------------------ orders
const ORDER_FILTERS = {
  all: { label: 'الكل' }, buy: { side: 'BUY', label: 'الشراء' }, sell: { side: 'SELL', label: 'البيع' }, open: { status: 'OPEN', label: 'المعلقة' },
  fill: { status: 'FILLED', label: 'المنفذة' }, canc: { status: 'CANCELLED', label: 'الملغاة' }, rej: { status: 'REJECTED', label: 'المرفوضة' },
  exp: { status: 'EXPIRED', label: 'المنتهية' },
};
const ORDER_GROUPS = [
  ['PENDING', '⏳ <b>أوامر معلقة — لم تُنفذ بعد</b>'],
  ['PARTIALLY_FILLED', '◐ <b>منفذة جزئيًا — الباقي معلق</b>'],
  ['FILLED', '✅ <b>أوامر منفذة</b>'],
  ['CANCELLED', '🚫 <b>أوامر ملغاة — لم تُنفذ</b>'],
  ['EXPIRED', '⌛ <b>أوامر منتهية الصلاحية — لم تُنفذ</b>'],
  ['REJECTED', '⛔ <b>أوامر مرفوضة — لم تُنفذ</b>'],
];

function orderLines(o, tz) {
  const lines = [];
  const type = o.type === 'LIMIT' ? `محدد عند ${price(o.limitPrice)}` : label('orderType', o.type);
  lines.push(`• ${b(esc(o.symbol))} ${label('side', o.side)} — ${type} — الكمية: ${qty(o.qty)}`);
  if (F.isNum(o.filledQty) && o.filledQty > 0) lines.push(`   المنفذ: ${qty(o.filledQty)} من ${qty(o.qty)} بمتوسط ${price(o.avgFillPrice)}`);
  lines.push(`   الحالة: ${label('orderStatus', o.status)} | المصدر: ${label('source', o.source)}`);
  lines.push(`   التاريخ: ${when(o.createdAt, tz)}`);
  if (o.reason) lines.push(`   السبب: ${esc(F.clip(o.reason, 140))}`);
  if (o.rejectReason) lines.push(`   سبب الرفض: ${esc(F.clip(o.rejectReason, 140))}`);
  lines.push(`   رقم الأمر: ${code(o.id)}`);
  return lines;
}

function renderOrderItems(items, tz) {
  const lines = [];
  const known = new Set(ORDER_GROUPS.map((g) => g[0]));
  for (const [status, title] of ORDER_GROUPS) {
    const g = items.filter((o) => o.status === status);
    if (!g.length) continue;
    lines.push(title);
    for (const o of g) lines.push(...orderLines(o, tz));
    lines.push('');
  }
  const other = items.filter((o) => !known.has(o.status));
  if (other.length) {
    lines.push('<b>أوامر أخرى</b>');
    for (const o of other) lines.push(...orderLines(o, tz));
    lines.push('');
  }
  return lines;
}

const ORDER_NOTE = 'ℹ️ الأمر طلب تداول ورقي ولا يعني التنفيذ؛ الصفقات المنفذة فعليًا تظهر في «سجل الصفقات».';

async function ordersList(ctx, { filter = 'all', page = 0 }) {
  const f = ORDER_FILTERS[filter] || ORDER_FILTERS.all;
  const res = (await ctx.svc('orders', { side: f.side || null, status: f.status || null, period: 'all', symbol: null, limit: ORDERS_PAGE, offset: page * ORDERS_PAGE })) || {};
  const items = res.items || [];
  const total = F.isNum(res.total) ? res.total : items.length;
  const lines = ['📑 <b>الأوامر</b>', `الفلتر: ${f.label} | العدد: ${int(total)}`, ORDER_NOTE, ''];
  if (!items.length) lines.push('لا توجد أوامر مطابقة.');
  lines.push(...renderOrderItems(items, ctx.tz));
  lines.push(tzNote(ctx.tz));
  lines.push(PAPER_NOTE);
  const keyboard = [
    [[mark(filter === 'buy', '🟢 الشراء'), 'o:buy:0'], [mark(filter === 'sell', '🔴 البيع'), 'o:sell:0'], [mark(filter === 'open', '⏳ المعلقة'), 'o:open:0']],
    [[mark(filter === 'fill', '✅ المنفذة'), 'o:fill:0'], [mark(filter === 'canc', '🚫 الملغاة'), 'o:canc:0'], [mark(filter === 'rej', '⛔ المرفوضة'), 'o:rej:0']],
    [[mark(filter === 'all', '📑 الكل'), 'o:all:0'], [mark(filter === 'exp', '⌛ المنتهية'), 'o:exp:0']],
    ...pager(`o:${filter}`, page, total, ORDERS_PAGE),
    HOME,
  ];
  return { text: lines.join('\n'), keyboard };
}

async function pendingOrders(ctx, side) {
  const res = (await ctx.svc('orders', { side, status: 'OPEN', period: 'all', symbol: null, limit: 10, offset: 0 })) || {};
  const items = res.items || [];
  const lines = [`⏳ <b>أوامر ${side === 'SELL' ? 'البيع' : 'الشراء'} المعلقة</b>`, ORDER_NOTE, ''];
  if (!items.length) lines.push('لا توجد أوامر معلقة حاليًا.');
  lines.push(...renderOrderItems(items, ctx.tz));
  lines.push(tzNote(ctx.tz));
  const p = side === 'SELL' ? 's' : 'b';
  return { text: lines.join('\n'), keyboard: [[[side === 'SELL' ? '🔴 عمليات البيع المنفذة' : '🟢 عمليات الشراء المنفذة', `${p}:a:0`], ['📑 كل الأوامر', 'o:all:0']], HOME] };
}

// ------------------------------------------------------------------ trades (all fills)
async function tradesList(ctx, { pcode = 'a', sideCode = 'a', page = 0, symbol = null }) {
  const period = FILL_PERIODS[pcode] || 'all';
  const side = sideCode === 'b' ? 'BUY' : (sideCode === 's' ? 'SELL' : null);
  const res = (await ctx.svc('fills', { side, symbol: symbol || null, period, limit: PAGE, offset: page * PAGE })) || {};
  const items = res.items || [];
  const total = F.isNum(res.total) ? res.total : items.length;
  const sideLabel = side === 'BUY' ? 'الشراء' : (side === 'SELL' ? 'البيع' : 'الكل');
  const lines = ['📋 <b>سجل الصفقات المنفذة</b>', `الفترة: ${FILL_PERIOD_LABEL[pcode]} | النوع: ${sideLabel}${symbol ? ` | السهم: ${b(esc(symbol))}` : ''} | العدد: ${int(total)}`, ''];
  if (!items.length) lines.push('لا توجد صفقات منفذة مطابقة.');
  items.forEach((f, i) => { lines.push(...fillLines(f, page * PAGE + i + 1, ctx.tz, { detailed: true })); lines.push(''); });
  lines.push(tzNote(ctx.tz));
  lines.push(PAPER_NOTE);
  const sfx = symbol ? `:${symbol}` : '';
  const details = items.map((f, i) => [f, i]).filter(([f]) => f.id != null && SAFE_ID.test(String(f.id))).map(([f, i]) => [`🔎 ${page * PAGE + i + 1}`, `td:${f.id}`]);
  const keyboard = [
    [[mark(pcode === 't', 'اليوم'), `tr:t:${sideCode}:0${sfx}`], [mark(pcode === '7', '7 أيام'), `tr:7:${sideCode}:0${sfx}`], [mark(pcode === '30', '30 يومًا'), `tr:30:${sideCode}:0${sfx}`], [mark(pcode === 'a', 'كل الفترات'), `tr:a:${sideCode}:0${sfx}`]],
    [[mark(sideCode === 'a', 'شراء وبيع'), `tr:${pcode}:a:0${sfx}`], [mark(sideCode === 'b', '🟢 شراء'), `tr:${pcode}:b:0${sfx}`], [mark(sideCode === 's', '🔴 بيع'), `tr:${pcode}:s:0${sfx}`], [mark(!!symbol, '🔎 حسب السهم'), 'tr:sym']],
  ];
  if (details.length) keyboard.push(details);
  keyboard.push(...pager(`tr:${pcode}:${sideCode}`, page, total, PAGE, sfx));
  keyboard.push(HOME);
  return { text: lines.join('\n'), keyboard };
}

async function tradeDetails(ctx, id) {
  const f = await ctx.svc('fill', id);
  if (!f) return { text: 'لم يتم العثور على هذه الصفقة.', keyboard: [[['📋 سجل الصفقات', 'tr:a:a:0']], HOME] };
  const lines = ['🔎 <b>تفاصيل الصفقة المنفذة</b>', ''];
  lines.push(ln('السهم', b(esc(f.symbol))));
  lines.push(ln('النوع', f.side === 'SELL' ? '🔴 بيع' : '🟢 شراء'));
  lines.push(ln('التاريخ', when(f.ts, ctx.tz)));
  lines.push(ln('الكمية', qty(f.qty)));
  lines.push(ln('سعر التنفيذ', price(f.price)));
  lines.push(ln('الإجمالي', money(F.isNum(f.notional) ? f.notional : (F.isNum(f.qty) && F.isNum(f.price) ? f.qty * f.price : null))));
  lines.push(ln('الرسوم', money(f.fees)));
  if (f.side === 'SELL') {
    lines.push(ln('متوسط سعر الشراء', price(f.costBasisPrice)));
    lines.push(ln('الربح المحقق', signedMoney(f.realizedPnl)));
    lines.push(ln('العائد', pct(f.returnPct)));
    const trig = F.exitTriggerOf(f);
    if (trig) lines.push(ln('محفز الخروج', b(F.exitTriggerText(trig))));
  } else {
    const n = F.isNum(f.notional) ? f.notional : (F.isNum(f.qty) && F.isNum(f.price) ? f.qty * f.price : null);
    lines.push(ln('التكلفة الإجمالية مع الرسوم', money(F.isNum(n) ? n + (F.isNum(f.fees) ? f.fees : 0) : null)));
  }
  lines.push(ln('المصدر / المحفز', label('source', f.kind)));
  lines.push(ln('مزود التحليل', `${F.providerLabel(f.aiProvider)}${f.aiModel ? ` (${esc(f.aiModel)})` : ''}`));
  if (f.strategy) lines.push(ln('الاستراتيجية', esc(f.strategy)));
  if (f.riskProfile) lines.push(ln('مستوى المخاطرة وقت التنفيذ', label('profile', f.riskProfile)));
  if (f.reason) lines.push(ln('السبب', esc(F.clip(f.reason, 400))));
  lines.push(ln('رقم التنفيذ', code(f.id)));
  if (f.orderId != null) lines.push(ln('رقم الأمر', code(f.orderId)));
  if (f.decisionId != null) lines.push(ln('رقم القرار', code(f.decisionId)));
  lines.push('');
  lines.push(...decisionBlock(f.decision));
  lines.push('');
  lines.push(tzNote(ctx.tz));
  lines.push(PAPER_NOTE);
  const kb = [[['📋 سجل الصفقات', 'tr:a:a:0']]];
  if (ctx.isTicker(f.symbol)) kb[0].push([`📈 ${f.symbol}`, `sk:${f.symbol}`]);
  kb.push(HOME);
  return { text: lines.join('\n'), keyboard: kb };
}

function decisionBlock(dec) {
  const lines = ['🤖 <b>قرار الذكاء الاصطناعي المرتبط (مسجل)</b>'];
  if (!dec) { lines.push('لا يوجد قرار مسجل مرتبط بهذه الصفقة (قد تكون نُفذت بأمر حماية أو يدويًا).'); return lines; }
  lines.push(ln('القرار', label('action', dec.action)));
  lines.push(ln('المبررات', dec.rationale ? esc(F.clip(dec.rationale, 900)) : NA));
  const ev = (dec.evidence || []).slice(0, 5);
  if (ev.length) { lines.push('الأدلة:'); for (const e of ev) lines.push(`  ◦ ${esc(F.clip(e, 200))}`); }
  if (dec.id != null) lines.push(ln('رقم القرار', code(dec.id)));
  return lines;
}

// ------------------------------------------------------------------ stats
async function stats(ctx, period = 'today') {
  const s = (await ctx.svc('stats', { period })) || {};
  const ins = s.insufficient || {};
  const pp = s.portfolio || {};
  const tr = s.trading || {};
  const rk = s.risk || {};
  const ai = s.ai || {};
  const lines = [`📊 <b>الإحصائيات — ${STATS_LABEL[period] || esc(period)}</b>`];
  if (F.isNum(s.from) || F.isNum(s.to)) lines.push(`الفترة: من ${when(s.from, ctx.tz)} إلى ${when(s.to, ctx.tz)} (${F.tzLabel(ctx.tz)})`);
  lines.push('');
  lines.push('💼 <b>أداء المحفظة</b>');
  lines.push(...periodPortfolioLines(pp, ins));
  lines.push('');
  lines.push('📈 <b>أداء التداول</b>');
  lines.push(ln('الصفقات المكتملة (شراء ثم بيع)', metric(ins, 'roundTrips', tr.roundTrips, int)));
  lines.push(ln('الرابحة / الخاسرة', `${metric(ins, 'wins', tr.wins, int)} / ${metric(ins, 'losses', tr.losses, int)}`));
  lines.push(ln('نسبة الصفقات الرابحة', metric(ins, 'winRatePct', tr.winRatePct, (x) => pct(x, false))));
  lines.push(ln('متوسط الربح', metric(ins, 'avgWin', tr.avgWin, signedMoney)));
  lines.push(ln('متوسط الخسارة', metric(ins, 'avgLoss', tr.avgLoss, signedMoney)));
  lines.push(ln('أكبر ربح', metric(ins, 'largestWin', tr.largestWin, signedMoney)));
  lines.push(ln('أكبر خسارة', metric(ins, 'largestLoss', tr.largestLoss, signedMoney)));
  lines.push(ln('معامل الربح', metric(ins, 'profitFactor', tr.profitFactor, (x) => F.num(x, 2))));
  lines.push(ln('متوسط مدة الاحتفاظ', metric(ins, 'avgHoldingMinutes', tr.avgHoldingMinutes, (x) => `${F.num(x, 0)} دقيقة`)));
  lines.push(ln('متوسط عائد الصفقة', metric(ins, 'avgTradeReturnPct', tr.avgTradeReturnPct, (x) => pct(x))));
  lines.push(ln('الرسوم', metric(ins, 'fees', tr.fees, money)));
  lines.push(ln('عمليات الشراء / البيع', `${metric(ins, 'buyCount', tr.buyCount, int)} / ${metric(ins, 'sellCount', tr.sellCount, int)}`));
  lines.push(ln('حجم التداول', metric(ins, 'volume', tr.volume, money)));
  lines.push('');
  lines.push('🛡️ <b>إحصائيات المخاطر</b>');
  lines.push(ln('أقصى تراجع', metric(ins, 'maxDrawdownPct', rk.maxDrawdownPct, (x) => pct(x, false))));
  lines.push(ln('التراجع الحالي', metric(ins, 'currentDrawdownPct', rk.currentDrawdownPct, (x) => pct(x, false))));
  lines.push(ln('أقصى تعرض لمركز', metric(ins, 'maxPositionExposurePct', rk.maxPositionExposurePct, (x) => pct(x, false))));
  lines.push(ln('التعرض الحالي', metric(ins, 'currentExposurePct', rk.currentExposurePct, (x) => pct(x, false))));
  lines.push(ln('مستوى المخاطرة', label('profile', rk.profile)));
  lines.push(ln('حد الخسارة اليومية', metric(ins, 'dailyLossLimitPct', rk.dailyLossLimitPct, (x) => pct(x, false))));
  lines.push(ln('المتبقي من حد الخسارة اليومية', metric(ins, 'remainingDailyLossPct', rk.remainingDailyLossPct, (x) => pct(x, false))));
  lines.push(ln('أطول سلسلة أرباح / خسائر', `${metric(ins, 'maxConsecutiveWins', rk.maxConsecutiveWins, int)} / ${metric(ins, 'maxConsecutiveLosses', rk.maxConsecutiveLosses, int)}`));
  const cs = rk.currentStreak;
  lines.push(ln('السلسلة الحالية', ins.currentStreak ? INSUFFICIENT : (cs && F.isNum(cs.count) ? `${cs.type === 'LOSS' ? 'صفقات خاسرة' : 'صفقات رابحة'} متتالية × ${int(cs.count)}` : NA)));
  lines.push('');
  lines.push('🤖 <b>أداء الذكاء الاصطناعي</b>');
  lines.push(ln('القرارات', metric(ins, 'decisions', ai.decisions, int)));
  lines.push(ln('الاقتراحات', metric(ins, 'proposals', ai.proposals, int)));
  lines.push(ln('المقبولة / المرفوضة', `${metric(ins, 'accepted', ai.accepted, int)} / ${metric(ins, 'rejected', ai.rejected, int)}`));
  lines.push(ln('الصفقات المنفذة', metric(ins, 'executedTrades', ai.executedTrades, int)));
  lines.push(ln('قرارات انتظار / احتفاظ', `${metric(ins, 'waits', ai.waits, int)} / ${metric(ins, 'holds', ai.holds, int)}`));
  lines.push(ln('طلبات الذكاء الاصطناعي', metric(ins, 'requests', ai.requests, int)));
  lines.push(ln('طلبات DeepSeek', `${metric(ins, 'deepseekRequests', ai.deepseekRequests, int)}${F.isNum(ai.deepseekCostUsd) ? ` (${money(ai.deepseekCostUsd)})` : ''}`));
  lines.push(ln('طلبات Gemini', `${metric(ins, 'geminiRequests', ai.geminiRequests, int)}${F.isNum(ai.geminiCostUsd) ? ` (${money(ai.geminiCostUsd)})` : ''}`));
  lines.push(ln('التكلفة التقديرية للذكاء الاصطناعي', metric(ins, 'costUsd', ai.costUsd, money)));
  lines.push(ln('الحالة', label('aiState', ai.status)));
  lines.push('ℹ️ درجة الثقة ليست احتمالًا معايرًا، ونسبة الصفقات الرابحة ليست مقياسًا لدقة تنبؤات الذكاء الاصطناعي.');
  const by = (s.bySymbol || []).filter((x) => x && F.isNum(x.realizedPnl)).sort((a, c) => c.realizedPnl - a.realizedPnl).slice(0, 5);
  if (by.length) {
    lines.push('');
    lines.push('🏷️ <b>الربح المحقق حسب السهم</b>');
    for (const x of by) lines.push(`• ${b(esc(x.symbol))}: ${signedMoney(x.realizedPnl)} (عدد الصفقات: ${int(x.trades)})`);
  }
  lines.push('');
  lines.push(PAPER_NOTE);
  const keyboard = [
    [[mark(period === 'today', 'اليوم'), 'st:t'], [mark(period === 'week', 'هذا الأسبوع'), 'st:w']],
    [[mark(period === 'month', 'هذا الشهر'), 'st:m'], [mark(period === 'all', 'منذ البداية'), 'st:a']],
    HOME,
  ];
  return { text: lines.join('\n'), keyboard };
}

// ------------------------------------------------------------------ reports
function renderReport(r, tz, { forNotification = false } = {}) {
  r = r || {};
  const s = r.stats || {};
  const ins = s.insufficient || {};
  const pp = s.portfolio || {};
  const tr = s.trading || {};
  const rk = s.risk || {};
  const lines = [`<b>${REPORT_TITLE[r.kind] || '🗓️ التقرير'} — ${F.date(F.isNum(r.to) ? r.to : Date.now(), tz)}</b>`];
  lines.push(`الفترة: من ${when(r.from, tz)} إلى ${when(r.to, tz)} (${F.tzLabel(tz)})`);
  lines.push('');
  lines.push('💼 <b>المحفظة</b>');
  lines.push(ln('قيمة البداية → النهاية', `${metric(ins, 'startEquity', pp.startEquity, money)} → ${metric(ins, 'endEquity', pp.endEquity, money)}`));
  lines.push(ln('صافي الربح/الخسارة', b(metric(ins, 'netPnl', pp.netPnl, signedMoney))));
  lines.push(ln('العائد', metric(ins, 'netReturnPct', pp.netReturnPct, (x) => pct(x))));
  lines.push(ln('المحقق / غير المحقق', `${metric(ins, 'realizedPnl', pp.realizedPnl, signedMoney)} / ${metric(ins, 'unrealizedPnl', pp.unrealizedPnl, signedMoney)}`));
  lines.push(ln('السيولة', metric(ins, 'cash', pp.cash, money)));
  lines.push('');
  lines.push('📈 <b>التداول</b>');
  lines.push(ln('عمليات الشراء / البيع', `${metric(ins, 'buyCount', tr.buyCount, int)} / ${metric(ins, 'sellCount', tr.sellCount, int)}`));
  lines.push(ln('الصفقات المكتملة', metric(ins, 'roundTrips', tr.roundTrips, int)));
  lines.push(ln('الرابحة / الخاسرة', `${metric(ins, 'wins', tr.wins, int)} / ${metric(ins, 'losses', tr.losses, int)}`));
  lines.push(ln('نسبة الصفقات الرابحة', metric(ins, 'winRatePct', tr.winRatePct, (x) => pct(x, false))));
  lines.push(ln('معامل الربح', metric(ins, 'profitFactor', tr.profitFactor, (x) => F.num(x, 2))));
  lines.push(ln('الرسوم', metric(ins, 'fees', tr.fees, money)));
  lines.push('');
  lines.push('🛡️ <b>المخاطر</b>');
  lines.push(ln('أقصى تراجع', metric(ins, 'maxDrawdownPct', rk.maxDrawdownPct, (x) => pct(x, false))));
  lines.push(ln('التعرض الحالي', metric(ins, 'currentExposurePct', rk.currentExposurePct, (x) => pct(x, false))));
  lines.push(ln('مستوى المخاطرة', label('profile', rk.profile)));
  lines.push('');
  lines.push(ln('🏆 أفضل سهم', r.topContributor ? `${b(esc(r.topContributor.symbol))} ${signedMoney(r.topContributor.pnl)}` : NA));
  lines.push(ln('📉 أضعف سهم', r.worstContributor ? `${b(esc(r.worstContributor.symbol))} ${signedMoney(r.worstContributor.pnl)}` : NA));
  const hl = (r.aiHighlights || []).slice(0, 5);
  if (hl.length) {
    lines.push('');
    lines.push('🤖 <b>أبرز قرارات الذكاء الاصطناعي (مسجلة)</b>');
    for (const h of hl) lines.push(`• ${b(esc(h.symbol))} (${F.time(h.ts, tz)}): من «${label('action', h.from)}» إلى «${label('action', h.to)}»${h.reason ? ` — ${esc(F.clip(h.reason, 140))}` : ''}`);
  }
  const re = (r.riskEvents || []).slice(0, 5);
  if (re.length) {
    lines.push('');
    lines.push('⚠️ <b>أحداث المخاطر</b>');
    for (const e of re) lines.push(`• ${F.time(e.ts, tz)} — ${esc(F.clip(e.message, 160))}`);
  }
  const ne = (r.newsEvents || []).slice(0, 5);
  if (ne.length) {
    lines.push('');
    lines.push('📰 <b>أخبار مؤثرة</b>');
    for (const n of ne) lines.push(`• ${n.symbol ? b(esc(n.symbol)) + ': ' : ''}${esc(F.clip(n.title, 160))}`);
  }
  lines.push('');
  lines.push('ℹ️ نسبة الصفقات الرابحة ليست مقياسًا لدقة تنبؤات الذكاء الاصطناعي.');
  lines.push(PAPER_NOTE);
  const text = F.fit(lines.join('\n'));
  const statsCode = { daily: 't', weekly: 'w', monthly: 'm' }[r.kind] || 't';
  const keyboard = forNotification
    ? [[['📊 الإحصائيات', 'st:' + statsCode], ['💼 المحفظة', 'pf']]]
    : [[[mark(r.kind === 'daily', 'اليومي'), 'rp:d'], [mark(r.kind === 'weekly', 'الأسبوعي'), 'rp:w'], [mark(r.kind === 'monthly', 'الشهري'), 'rp:m']], HOME];
  return { text, keyboard };
}

async function report(ctx, kind) {
  const r = await ctx.svc('report', kind);
  if (!r) return { text: 'لا تتوفر بيانات كافية لإعداد التقرير حاليًا.', keyboard: [HOME] };
  return renderReport({ kind, ...r }, ctx.tz);
}

// ------------------------------------------------------------------ stock
async function stock(ctx, symbol) {
  const s = await ctx.svc('stock', symbol);
  if (!s) {
    return { text: `لا تتوفر بيانات عن السهم ${b(esc(symbol))}.\nتأكد من الرمز، أو أضفه إلى قائمة المراقبة عبر /addstock ${esc(symbol)}`, keyboard: [[['📈 الأسهم المراقبة', 'w']], HOME] };
  }
  const lines = [`📈 <b>${esc(s.symbol || symbol)}</b>${s.name ? ` — ${esc(s.name)}` : ''}`, ''];
  lines.push(ln('المراقبة', s.monitored ? `نعم (${label('symStatus', s.status)})` : 'غير مراقب'));
  lines.push(ln('السعر', `${b(price(s.price))}${s.priceKind ? ` (${label('markKind', s.priceKind)})` : ''}`));
  lines.push(ln('مزود البيانات', `${s.provider ? esc(s.provider) : NA} — ${freshText(s.fresh)}`));
  lines.push(ln('وقت السعر', `${when(s.priceTs, ctx.tz)} (${F.tzLabel(ctx.tz)})`));
  lines.push(ln('التغير', pct(s.changePct)));
  lines.push(ln('الاتجاه', label('trend', s.trend)));
  lines.push(ln('الدعم / المقاومة', `${price(s.support)} / ${price(s.resistance)}`));
  lines.push(ln('مؤشر RSI', F.isNum(s.rsi) ? F.num(s.rsi, 1) : NA));
  lines.push('');
  lines.push('🤖 <b>آخر قرار مسجل للذكاء الاصطناعي</b>');
  lines.push(ln('القرار', label('action', s.aiAction)));
  lines.push(ln('الوقت', when(s.aiAt, ctx.tz)));
  lines.push(ln('درجة الثقة', F.isNum(s.aiConfidence) ? `${F.num(s.aiConfidence, 0)}% (ليست احتمالًا معايرًا)` : NA));
  lines.push('');
  if (s.position && F.isNum(s.position.qty) && s.position.qty !== 0) {
    lines.push('📌 <b>المركز الحالي</b>');
    lines.push(ln('الكمية', qty(s.position.qty)));
    lines.push(ln('متوسط السعر', price(s.position.avgPrice)));
    lines.push(ln('الربح غير المحقق', `${signedMoney(s.position.unrealizedPnl)} (${pct(s.position.unrealizedPct)})`));
  } else {
    lines.push('📌 لا يوجد مركز مفتوح في هذا السهم.');
  }
  lines.push('');
  lines.push('ℹ️ هذه الشاشة لا تطلب تحليلًا جديدًا من الذكاء الاصطناعي؛ المعروض هو آخر قرار مسجل.');
  const S = s.symbol && ctx.isTicker(s.symbol) ? s.symbol : symbol;
  return {
    text: lines.join('\n'),
    keyboard: [
      [['🧠 التحليل الكامل', `sk:${S}:f`], ['🗂️ آخر القرارات', `sk:${S}:d`]],
      [['📋 صفقات السهم', `sk:${S}:t`], ['📰 الأخبار', `sk:${S}:n`]],
      [['🔄 تحديث', `sk:${S}`]],
      HOME,
    ],
  };
}

async function stockAnalysis(ctx, symbol) {
  const s = await ctx.svc('stock', symbol);
  let latest = null;
  try {
    const d = await ctx.svc('decisions', { symbol, kind: 'all', limit: 1, offset: 0 });
    latest = d && d.items && d.items[0];
  } catch { latest = null; }
  const lines = [`🧠 <b>التحليل المسجل — ${esc(symbol)}</b>`, ''];
  if (!s && !latest) lines.push('لا يوجد تحليل مسجل لهذا السهم.');
  if (s) {
    lines.push(ln('القرار', label('action', s.aiAction)));
    lines.push(ln('الوقت', when(s.aiAt, ctx.tz)));
    lines.push(ln('درجة الثقة', F.isNum(s.aiConfidence) ? `${F.num(s.aiConfidence, 0)}% (ليست احتمالًا معايرًا)` : NA));
    lines.push('');
    lines.push('<b>المبررات المسجلة:</b>');
    lines.push(s.aiRationale ? esc(F.clip(s.aiRationale, 2000)) : 'لا توجد مبررات مسجلة.');
  }
  if (latest && (latest.evidence || []).length) {
    lines.push('');
    lines.push('<b>الأدلة (من آخر قرار مسجل):</b>');
    for (const e of latest.evidence.slice(0, 8)) lines.push(`◦ ${esc(F.clip(e, 250))}`);
  }
  lines.push('');
  lines.push('ℹ️ هذا نص مسجل من آخر تحليل؛ لم يتم إنشاء تحليل جديد.');
  lines.push(tzNote(ctx.tz));
  return { text: lines.join('\n'), keyboard: [[['📈 السهم', `sk:${symbol}`], ['🗂️ آخر القرارات', `sk:${symbol}:d`]], HOME] };
}

async function stockNews(ctx, symbol) {
  const list = (await ctx.svc('stockNews', symbol)) || [];
  const lines = [`📰 <b>أخبار ${esc(symbol)}</b>`, ''];
  if (!list.length) lines.push('لا توجد أخبار مسجلة لهذا السهم.');
  list.slice(0, 8).forEach((n, i) => {
    lines.push(`${b(`${i + 1})`)} ${link(n.url, F.clip(n.title || NA, 200))}`);
    lines.push(`   ${when(n.ts, ctx.tz)}${n.source ? ` — ${esc(n.source)}` : ''}${n.impact ? ` — التأثير: ${label('impact', n.impact)}` : ''}`);
    if (n.aiNote) lines.push(`   ملاحظة مسجلة: ${esc(F.clip(n.aiNote, 200))}`);
  });
  lines.push('');
  lines.push(tzNote(ctx.tz));
  return { text: lines.join('\n'), keyboard: [[['📈 السهم', `sk:${symbol}`]], HOME] };
}

/** Latest recorded news across all monitored symbols (database only; no AI call). */
async function news(ctx) {
  const list = (await ctx.svc('news', { limit: 10 })) || [];
  const lines = ['📰 <b>آخر الأخبار</b>', ''];
  if (!list.length) lines.push('لا توجد أخبار مسجلة بعد.');
  list.slice(0, 10).forEach((n, i) => {
    const symTxt = n.symbol ? b(esc(n.symbol)) : 'عام / اقتصاد كلي';
    lines.push(`${b(`${i + 1})`)} ${symTxt} — ${link(n.url, F.clip(n.title || NA, 220))}`);
    lines.push(`   🕒 ${when(n.ts, ctx.tz)}${n.source ? ` | المصدر: ${esc(F.clip(n.source, 60))}` : ''}${n.official ? ' (رسمي ✅)' : ''}`);
    lines.push(`   التأثير: ${n.impact ? label('impact', n.impact) : NA}`);
    if (n.aiNote) lines.push(`   🤖 ملاحظة الذكاء الاصطناعي (مسجلة): ${esc(F.clip(n.aiNote, 220))}`);
    lines.push('');
  });
  lines.push('ℹ️ الأخبار من قاعدة البيانات؛ لم يُطلب أي تحليل جديد من الذكاء الاصطناعي.');
  lines.push(tzNote(ctx.tz));
  const syms = [...new Set(list.map((n) => n.symbol).filter((s) => ctx.isTicker(s)))].slice(0, 6);
  const symRows = symbolButtons(syms, (s) => `sk:${s}:n`).map((r) => r.map(([s, d]) => [`📰 ${s}`, d]));
  return { text: lines.join('\n'), keyboard: [...symRows, [['🔄 تحديث', 'nw']], HOME] };
}

// ------------------------------------------------------------------ watchlist
async function watchlist(ctx) {
  const list = (await ctx.svc('watchlist')) || [];
  const lines = [`📈 <b>الأسهم المراقبة</b> (${int(list.length)})`, ''];
  if (!list.length) lines.push('لا توجد أسهم في قائمة المراقبة.');
  list.forEach((w, i) => {
    lines.push(`${b(`${i + 1})`)} ${b(esc(w.symbol))} — ${label('symStatus', w.status)}`);
    lines.push(`   السعر: ${price(w.price)} (${pct(w.changePct)}) | الاتجاه: ${label('trend', w.trend)}`);
    lines.push(`   قرار الذكاء الاصطناعي: ${label('action', w.aiAction)}`);
    if (F.isNum(w.positionQty) && w.positionQty !== 0) lines.push(`   المركز: الكمية ${qty(w.positionQty)} | ربح غير محقق: ${signedMoney(w.unrealizedPnl)}`);
    lines.push(`   البيانات: ${freshText(w.fresh)}${w.provider ? ` — ${esc(w.provider)}` : ''}${F.isNum(w.dataTs) ? ` — ${F.time(w.dataTs, ctx.tz)}` : ''}`);
    lines.push('');
  });
  lines.push('');
  lines.push(tzNote(ctx.tz));
  return {
    text: lines.join('\n'),
    keyboard: [
      [['➕ إضافة سهم', 'w:add'], ['➖ إزالة سهم', 'w:rm']],
      [['⏸️ إيقاف مراقبة سهم', 'w:pa'], ['▶️ استئناف المراقبة', 'w:re']],
      [['🔎 تفاصيل سهم', 'w:det']],
      HOME,
    ],
  };
}

// ------------------------------------------------------------------ AI + decisions
const PROVIDER_IDS = ['deepseek', 'gemini'];
const PROVIDER_NAME = { deepseek: 'DeepSeek', gemini: 'Gemini' };
const PROVIDER_ICON = { deepseek: '🔷', gemini: '🔶' };
const PROVIDER_STATE_ICON = { AVAILABLE: '✅', NOT_CONFIGURED: '⚪', PAUSED_AFTER_ERRORS: '⏸️' };

function errorCodeText(c) {
  if (c == null || c === '') return '';
  return F.L.errorCode[c] ? `${code(c)} (${F.L.errorCode[c]})` : code(c);
}

/** "متاح" / "غير مضبوط" / "متوقف مؤقتًا بعد أخطاء حتى 2:35 م" */
function providerStateText(x, tz) {
  if (!x || !x.state) return NA;
  let t = `${PROVIDER_STATE_ICON[x.state] ? `${PROVIDER_STATE_ICON[x.state]} ` : ''}${label('providerState', x.state)}`;
  if (x.state === 'PAUSED_AFTER_ERRORS' && F.isNum(x.openUntil)) t += ` حتى ${F.time(x.openUntil, tz)}`;
  return t;
}

/** One block per AI provider (DeepSeek / Gemini) from ai().providers[id]. */
function providerLines(id, x, ctx, { usageOnly = false } = {}) {
  const lines = [`${PROVIDER_ICON[id] || '•'} <b>${PROVIDER_NAME[id] || esc((x && x.name) || id)}</b>`];
  if (!x) { lines.push(ln('الحالة', NA)); return lines; }
  if (!usageOnly) lines.push(ln('الحالة', providerStateText(x, ctx.tz)));
  lines.push(ln('النموذج', x.model ? code(x.model) : NA));
  lines.push(ln('الطلبات اليوم / هذا الشهر', `${int(x.requestsToday)} / ${int(x.requestsMonth)}`));
  if (F.isNum(x.errorsToday) && x.errorsToday > 0) lines.push(ln('أخطاء اليوم', int(x.errorsToday)));
  lines.push(ln('التكلفة التقديرية اليوم / هذا الشهر', `${money(x.costTodayUsd)} / ${money(x.costMonthUsd)}`));
  if (F.isNum(x.dailyBudgetUsd)) lines.push(ln('ميزانية المزود اليومية / المتبقي', `${money(x.dailyBudgetUsd)} / ${money(x.remainingBudgetUsd)}`));
  lines.push(ln('متوسط زمن الاستجابة', ms(x.avgLatencyMs)));
  if (F.isNum(x.successRate)) lines.push(ln('نسبة نجاح الطلبات', pct(x.successRate * 100, false)));
  if (usageOnly && F.isNum(x.lastSuccessAt)) lines.push(ln('آخر طلب ناجح', when(x.lastSuccessAt, ctx.tz)));
  if (x.lastErrorCode || x.lastError) {
    const msg = x.lastError ? esc(F.clip(ctx.redact(String(x.lastError)), 160)) : '';
    lines.push(ln('آخر خطأ', [errorCodeText(x.lastErrorCode), msg].filter(Boolean).join(' — ')));
  }
  return lines;
}

function aiModeButtons(mode) {
  return [
    [[current(mode === 'DEEPSEEK', 'DeepSeek فقط'), 'aim:DEEPSEEK'], [current(mode === 'GEMINI', 'Gemini فقط'), 'aim:GEMINI']],
    [[current(mode === 'AUTO', 'تلقائي'), 'aim:AUTO'], [current(mode === 'DUAL', 'تحليل مزدوج'), 'aim:DUAL']],
  ];
}

async function aiScreen(ctx) {
  const a = (await ctx.svc('ai')) || {};
  const mode = a.aiMode || null;
  const lines = ['🤖 <b>الذكاء الاصطناعي</b>', ''];
  lines.push(ln('الحالة', label('aiState', a.state)));
  lines.push(ln('وضع الذكاء الاصطناعي', b(label('aiProviderMode', mode))));
  if (mode === 'DUAL' && a.dualScope) lines.push(ln('نطاق التحليل المزدوج', label('dualScope', a.dualScope)));
  lines.push(ln('التحويل إلى المزود الآخر عند الخطأ', a.fallback == null ? NA : (a.fallback ? '✅ مفعّل' : '❌ معطّل')));
  lines.push(ln('نمط الاستخدام', label('aiMode', a.mode)));
  const at = a.operating && a.operating.aiTrading;
  if (at) lines.push(ln('التداول الآلي', `${stateText('aiTradingState', at.state)}${at.reason ? ` — ${F.reasonText(at.reason)}` : ''}`));
  lines.push(ln('الأسهم المراقبة', int(a.symbolsMonitored)));
  lines.push('');
  if (a.providers && typeof a.providers === 'object') {
    for (const id of PROVIDER_IDS) { lines.push(...providerLines(id, a.providers[id], ctx)); lines.push(''); }
  } else {
    lines.push(ln('المزود / النموذج', `${a.provider ? esc(a.provider) : NA}${a.model ? ` / ${esc(a.model)}` : ''}`));
    lines.push(ln('حالة الاتصال بالـ API', label('apiStatus', a.apiStatus)));
    lines.push('');
  }
  lines.push('💰 <b>التكلفة الإجمالية (كل المزودين)</b>');
  lines.push(ln('التكلفة التقديرية اليوم', money(a.costTodayUsd)));
  lines.push(ln('التكلفة التقديرية هذا الشهر', money(a.costMonthUsd)));
  lines.push(ln('الميزانية اليومية العامة', money(a.dailyBudgetUsd)));
  lines.push(ln('المتبقي من الميزانية اليومية', money(a.remainingBudgetUsd)));
  lines.push(BUDGET_NOTE);
  lines.push('');
  const ld = a.lastDecision;
  if (ld) {
    const who = `${F.providerLabel(ld.provider)}${ld.model ? ` (${esc(ld.model)})` : ''}`;
    lines.push(ln('آخر تحليل', `${b(esc(ld.symbol))} — ${label('action', ld.action)} — ${who} — ${when(ld.ts, ctx.tz)}`));
  } else {
    lines.push(ln('آخر تحليل', F.isNum(a.lastAnalysisAt) ? when(a.lastAnalysisAt, ctx.tz) : 'لا يوجد تحليل مسجل بعد'));
  }
  if (a.lastError) lines.push(ln('آخر خطأ', esc(F.clip(ctx.redact(String(a.lastError)), 200))));
  lines.push('');
  lines.push('لتغيير وضع الذكاء الاصطناعي اختر من الأزرار (يتطلب تأكيدًا وصلاحية تحكم):');
  lines.push(tzNote(ctx.tz));
  return {
    text: lines.join('\n'),
    keyboard: [...aiModeButtons(mode), ...aiButtons(), [['⏸️ إيقاف مؤقت', 'ctl:pause'], ['▶️ استئناف', 'ctl:resume'], ['⏹️ إيقاف', 'ctl:stop']], HOME],
  };
}

function usageLines(a) {
  const lines = [
    '📊 <b>استهلاك الذكاء الاصطناعي (كل المزودين)</b>',
    ln('الطلبات اليوم / هذا الشهر', `${int(a.requestsToday)} / ${int(a.requestsMonth)}`),
    ln('الرموز اليوم (إدخال / إخراج)', `${int(a.inputTokensToday)} / ${int(a.outputTokensToday)}`),
    ln('التكلفة التقديرية اليوم', money(a.costTodayUsd)),
    ln('التكلفة التقديرية هذا الشهر', money(a.costMonthUsd)),
    ln('الميزانية اليومية', money(a.dailyBudgetUsd)),
    ln('المتبقي من الميزانية', money(a.remainingBudgetUsd)),
    ln('طلبات تم تجنبها اليوم لتوفير التكلفة', int(a.avoidedToday)),
  ];
  if (a.providers && typeof a.providers === 'object') {
    lines.push('');
    lines.push('<b>حسب المزود (اليوم | هذا الشهر)</b>');
    for (const id of PROVIDER_IDS) {
      const x = a.providers[id];
      if (!x) continue;
      lines.push(`• ${PROVIDER_NAME[id]}: ${int(x.requestsToday)} طلب — ${money(x.costTodayUsd)} | ${int(x.requestsMonth)} طلب — ${money(x.costMonthUsd)}`);
    }
  }
  lines.push(BUDGET_NOTE);
  return lines;
}

function aiButtons() {
  return [
    [['🗂️ آخر القرارات', 'd:a:0'], ['🔎 حسب السهم', 'd:sym']],
    [['🟢 قرارات الشراء', 'd:b:0'], ['🔴 قرارات البيع', 'd:s:0']],
    [['📊 استهلاك الذكاء الاصطناعي', 'ai:u']],
  ];
}

async function aiUsage(ctx) {
  const a = (await ctx.svc('ai')) || {};
  const lines = [...usageLines(a), '', ln('الحالة', label('aiState', a.state)), ln('وضع الذكاء الاصطناعي', label('aiProviderMode', a.aiMode)), '', tzNote(ctx.tz)];
  return { text: lines.join('\n'), keyboard: [[['🔷 DeepSeek', 'ai:ds'], ['🔶 Gemini', 'ai:gm']], [['🤖 الذكاء الاصطناعي', 'ai']], HOME] };
}

/** Usage of one provider (from ai().providers[id]); falls back to the combined usage screen for an older service. */
async function providerUsage(ctx, id) {
  const a = (await ctx.svc('ai')) || {};
  const x = a.providers && a.providers[id];
  if (!x) return aiUsage(ctx);
  const lines = [`📊 <b>استهلاك ${PROVIDER_NAME[id]}</b>`, ''];
  lines.push(ln('الحالة', providerStateText(x, ctx.tz)));
  lines.push(...providerLines(id, x, ctx, { usageOnly: true }).slice(1));
  lines.push('');
  lines.push(ln('التكلفة التقديرية لكل المزودين اليوم', money(a.costTodayUsd)));
  lines.push(BUDGET_NOTE);
  lines.push('');
  lines.push(tzNote(ctx.tz));
  const other = id === 'deepseek' ? ['🔶 Gemini', 'ai:gm'] : ['🔷 DeepSeek', 'ai:ds'];
  return { text: lines.join('\n'), keyboard: [[other, ['📊 كل المزودين', 'ai:u']], [['🤖 الذكاء الاصطناعي', 'ai']], HOME] };
}

/** Dual-analysis summary of a recorded decision ({ policy, uncertainty, deepseek, gemini }). */
function dualLines(dual, indent = '   ') {
  if (!dual || !dual.policy) return [];
  const lines = [`${indent}🔀 التحليل المزدوج: ${label('dualPolicy', dual.policy)}`];
  const parts = [];
  if (dual.deepseek) parts.push(`DeepSeek: ${label('action', dual.deepseek)}`);
  if (dual.gemini) parts.push(`Gemini: ${label('action', dual.gemini)}`);
  if (dual.uncertainty) parts.push(`عدم اليقين المشترك: ${label('uncertainty', dual.uncertainty)}`);
  if (parts.length) lines.push(`${indent}   ${parts.join(' | ')}`);
  return lines;
}

function decisionMetaLines(d, indent = '   ') {
  const lines = [];
  if (d.provider || d.model) lines.push(`${indent}المزود / النموذج: ${F.providerLabel(d.provider)}${d.model ? ` (${esc(d.model)})` : ''}`);
  if (d.changeReason) lines.push(`${indent}سبب التغيير: ${esc(F.clip(d.changeReason, 220))}`);
  lines.push(...dualLines(d.dual, indent));
  return lines;
}

function decisionStatus(d) {
  if (d.executed) return '✅ نُفذت صفقة ورقية';
  if (d.rejected) return `⛔ رُفض${(d.rejectReasons || []).length ? `: ${esc(F.clip(d.rejectReasons.join('؛ '), 200))}` : ''}`;
  if (d.proposedTrade) return '💡 اقتراح لم يُنفذ';
  return 'بدون اقتراح صفقة';
}

async function decisionsList(ctx, { kind = 'a', page = 0, symbol = null }) {
  const k = { a: 'all', b: 'buy', s: 'sell' }[kind] || 'all';
  const res = (await ctx.svc('decisions', { symbol: symbol || null, kind: k, limit: PAGE, offset: page * PAGE })) || {};
  const items = res.items || [];
  const total = F.isNum(res.total) ? res.total : items.length;
  const kindLabel = { all: 'الكل', buy: 'قرارات الشراء', sell: 'قرارات البيع' }[k];
  const lines = ['🤖 <b>قرارات الذكاء الاصطناعي</b>', `الفلتر: ${kindLabel}${symbol ? ` | السهم: ${b(esc(symbol))}` : ''} | العدد: ${int(total)}`, ''];
  if (!items.length) lines.push('لا توجد قرارات مسجلة مطابقة.');
  items.forEach((d, i) => {
    lines.push(`${b(`${page * PAGE + i + 1})`)} ${b(esc(d.symbol))} — ${when(d.ts, ctx.tz)}`);
    lines.push(`   القرار: من «${label('action', d.previousAction)}» إلى «${label('action', d.action)}»`);
    lines.push(...decisionMetaLines(d));
    lines.push(`   النتيجة: ${decisionStatus(d)}`);
    lines.push(`   المبررات المسجلة: ${d.rationale ? esc(F.clip(d.rationale, 260)) : NA}`);
    const ev = (d.evidence || []).slice(0, 2);
    for (const e of ev) lines.push(`   ◦ ${esc(F.clip(e, 140))}`);
    const notes = (d.news || []).map((n) => n && n.note).filter(Boolean).slice(0, 2);
    if (notes.length) lines.push(`   📰 ملاحظات الأخبار: ${esc(F.clip(notes.join('؛ '), 220))}`);
    lines.push(`   رقم القرار: ${code(d.id)}`);
    lines.push('');
  });
  lines.push('ℹ️ المعروض هو النص المسجل وقت القرار؛ درجة الثقة ليست احتمالًا معايرًا.');
  lines.push(tzNote(ctx.tz));
  const sfx = symbol ? `:${symbol}` : '';
  return { text: lines.join('\n'), keyboard: [...aiButtons(), ...pager(`d:${kind}`, page, total, PAGE, sfx), HOME] };
}

// ------------------------------------------------------------------ risk
function limitsLines(l) {
  l = l || {};
  return [
    ln('أقصى مخاطرة للصفقة', pct(l.maxRiskPerTradePct, false)),
    ln('حد الخسارة اليومية', pct(l.maxDailyLossPct, false)),
    ln('أقصى تراجع', pct(l.maxDrawdownPct, false)),
    ln('أقصى حجم للمركز', pct(l.maxPositionPct, false)),
    ln('أدنى نسبة عائد إلى مخاطرة', F.isNum(l.minRewardRisk) ? F.num(l.minRewardRisk, 2) : NA),
    ln('أقصى عدد للمراكز المفتوحة', int(l.maxOpenPositions)),
  ];
}

async function risk(ctx) {
  const r = (await ctx.svc('risk')) || {};
  const lines = ['⚠️ <b>إدارة المخاطر</b>', ''];
  lines.push(ln('مستوى المخاطرة الحالي', b(label('profile', r.profile))));
  lines.push(ln('التداول', r.tradingAllowed == null ? NA : (r.tradingAllowed ? '✅ مسموح' : '⛔ موقوف مؤقتًا')));
  lines.push('');
  lines.push('<b>الحدود</b>');
  lines.push(...limitsLines(r.limits));
  lines.push('');
  lines.push('<b>الوضع الحالي</b>');
  lines.push(ln('ربح/خسارة اليوم', pct(r.dayPnlPct)));
  lines.push(ln('المتبقي من حد الخسارة اليومية', pct(r.remainingDailyLossPct, false)));
  lines.push(ln('التراجع الحالي', pct(r.drawdownPct, false)));
  lines.push(ln('نسبة التعرض', pct(r.exposurePct, false)));
  const blocks = r.blocks || [];
  if (blocks.length) { lines.push(''); lines.push('<b>قيود نشطة</b>'); for (const x of blocks) lines.push(`• ${esc(x)}`); }
  lines.push('');
  lines.push('لتغيير مستوى المخاطرة اختر من الأزرار (يتطلب تأكيدًا وصلاحية تحكم):');
  return {
    text: lines.join('\n'),
    keyboard: [
      [[mark(r.profile === 'CONSERVATIVE', '🟢 منخفضة'), 'rk:p:CONSERVATIVE'], [mark(r.profile === 'BALANCED', '🟡 متوسطة'), 'rk:p:BALANCED']],
      [[mark(r.profile === 'AGGRESSIVE', '🟠 مرتفعة'), 'rk:p:AGGRESSIVE'], [mark(r.profile === 'VERY_AGGRESSIVE', '🔴 مرتفعة جدًا'), 'rk:p:VERY_AGGRESSIVE']],
      [['📋 تفاصيل المخاطر', 'rk:d']],
      HOME,
    ],
  };
}

async function riskDetails(ctx) {
  const s = (await ctx.svc('stats', { period: 'all' })) || {};
  const ins = s.insufficient || {};
  const rk = s.risk || {};
  const lines = ['📋 <b>تفاصيل المخاطر (منذ البداية)</b>', ''];
  lines.push(ln('أقصى تراجع', metric(ins, 'maxDrawdownPct', rk.maxDrawdownPct, (x) => pct(x, false))));
  lines.push(ln('التراجع الحالي', metric(ins, 'currentDrawdownPct', rk.currentDrawdownPct, (x) => pct(x, false))));
  lines.push(ln('أقصى تعرض لمركز', metric(ins, 'maxPositionExposurePct', rk.maxPositionExposurePct, (x) => pct(x, false))));
  lines.push(ln('التعرض الحالي', metric(ins, 'currentExposurePct', rk.currentExposurePct, (x) => pct(x, false))));
  lines.push(ln('حد الخسارة اليومية', metric(ins, 'dailyLossLimitPct', rk.dailyLossLimitPct, (x) => pct(x, false))));
  lines.push(ln('المتبقي من حد الخسارة اليومية', metric(ins, 'remainingDailyLossPct', rk.remainingDailyLossPct, (x) => pct(x, false))));
  lines.push(ln('أطول سلسلة أرباح / خسائر', `${metric(ins, 'maxConsecutiveWins', rk.maxConsecutiveWins, int)} / ${metric(ins, 'maxConsecutiveLosses', rk.maxConsecutiveLosses, int)}`));
  lines.push('');
  lines.push('ℹ️ أوامر وقف الخسارة وجني الأرباح تُدار آليًا داخل المحفظة الافتراضية.');
  return { text: lines.join('\n'), keyboard: [[['⚠️ إدارة المخاطر', 'rk']], HOME] };
}

// ------------------------------------------------------------------ status / notifications / settings
async function status(ctx) {
  const s = (await ctx.svc('status')) || {};
  const m = s.market || {};
  const op = s.operating || {};
  const mon = op.monitoring || null;
  const at = op.aiTrading || null;
  const srv = s.server || null;
  const withReason = (group, x) => `${stateText(group, x.state)}${x.reason ? ` — ${F.reasonText(x.reason)}` : ''}`;
  const lines = ['📡 <b>حالة النظام</b>', ''];
  lines.push(ln('الخادم', srv && srv.state ? stateText('serverState', srv.state) : NA));
  const reasons = (srv && Array.isArray(srv.reasons) ? srv.reasons : []).filter(Boolean);
  if (srv && srv.state === 'DEGRADED' && reasons.length) lines.push(`   الأسباب: ${reasons.slice(0, 6).map((r) => F.reasonText(ctx.redact(String(r)), 120)).join('، ')}`);
  lines.push(ln('مراقبة السوق', mon ? withReason('monitoringState', mon) : NA));
  lines.push(ln('التداول الآلي', at ? withReason('aiTradingState', at) : NA));
  lines.push(ln('وضع الذكاء الاصطناعي', label('aiProviderMode', s.aiMode)));
  lines.push(ln('الذكاء الاصطناعي', label('aiState', s.aiState)));
  lines.push(ln('السوق', m.label ? esc(m.label) : label('session', m.session)));
  lines.push(ln('جلسة التداول الورقي', s.hasSession == null ? NA : (s.hasSession ? 'نشطة' : 'لا توجد جلسة نشطة')));
  lines.push(ln('المراكز المفتوحة', int(s.positionsCount)));
  lines.push(ln('قيمة المحفظة', money(s.equity)));
  lines.push('');
  const comps = s.components && typeof s.components === 'object' ? s.components : null;
  if (comps) {
    lines.push('<b>مكونات النظام</b>');
    const keys = [...COMPONENT_ORDER.filter((k) => comps[k]), ...Object.keys(comps).filter((k) => !COMPONENT_ORDER.includes(k) && comps[k])];
    for (const k of keys) {
      const c = comps[k] || {};
      const detail = (c.state === 'degraded' || c.state === 'error') && c.detail ? ` — ${esc(F.clip(ctx.redact(String(c.detail)), 140))}` : '';
      lines.push(`• ${label('component', k)}: ${COMPONENT_ICON[c.state] ? `${COMPONENT_ICON[c.state]} ` : ''}${label('componentState', c.state)}${detail}`);
    }
  } else {
    lines.push('ℹ️ تفاصيل مكونات النظام غير متاحة حاليًا.');
  }
  const syms = s.symbols || [];
  if (syms.length) {
    lines.push('');
    lines.push('<b>بيانات الأسهم</b>');
    for (const x of syms.slice(0, 25)) lines.push(`• ${b(esc(x.symbol))} — ${x.dataLabel ? esc(x.dataLabel) : NA} (${freshText(x.fresh)})`);
  }
  lines.push('');
  lines.push('ℹ️ إيقاف مراقبة السوق يوقف التحليل وتنبيهات السوق فقط؛ أوامر الحماية للمراكز المفتوحة تبقى فعّالة.');
  lines.push(PAPER_NOTE);
  const monPaused = !!mon && (mon.pausedByUser != null ? !!mon.pausedByUser : mon.state === 'PAUSED');
  return {
    text: lines.join('\n'),
    keyboard: [
      [monPaused ? ['▶️ استئناف مراقبة السوق', 'mon:resume'] : ['⏸ إيقاف مراقبة السوق', 'mon:pause']],
      [['⏸️ إيقاف الذكاء مؤقتًا', 'ctl:pause'], ['▶️ استئناف الذكاء', 'ctl:resume']],
      [['⏹️ إيقاف الذكاء الاصطناعي', 'ctl:stop'], ['📡 المراقبة التكيفية', 'mn']],
      [['🔄 تحديث', 'sts']],
      HOME,
    ],
  };
}

/** Adaptive monitoring summary. Market monitoring and AI trading are separate states and shown separately. */
async function monitoring(ctx) {
  const s = (await ctx.svc('monitoring')) || {};
  const ai = s.ai || {};
  const ses = s.session || {};
  const lines = ['📡 <b>المراقبة التكيفية للسوق</b>', ''];
  lines.push(ln('مراقبة السوق', s.monitoring ? stateText('monitoringState', s.monitoring.state) : NA));
  lines.push(ln('التداول الآلي (حالة منفصلة)', s.aiTrading ? stateText('aiTradingState', s.aiTrading.state) : NA));
  lines.push(ln('المراقبة التكيفية', s.enabled == null ? NA : (s.enabled ? '✅ مفعّلة' : '⛔ معطّلة')));
  lines.push(ln('جلسة السوق', ses.code ? label('session', ses.code) : NA));
  if (ses.earlyClose) lines.push('   ⏰ إغلاق مبكر اليوم');
  if (s.enabled) {
    lines.push(ln('وضع المراقبة', `${b(label('monitorMode', s.mode))}${s.baseMode && s.baseMode !== s.mode ? ` (الأساس: ${label('monitorMode', s.baseMode)})` : ''}`));
    lines.push(ln('شدة المراقبة', label('monitorIntensity', s.intensity)));
    lines.push(ln('الانتقال التالي', s.next ? `${label('monitorMode', s.next.mode)} — ${when(s.next.at, ctx.tz)}` : NA));
  }
  lines.push(ln('الأسهم المراقبة', int(s.trackedSymbols)));
  const hv = Array.isArray(s.highVolatility) ? s.highVolatility : [];
  if (hv.length) lines.push(ln('تقلب مرتفع الآن', hv.map((x) => b(esc(x.symbol))).join('، ')));
  if (s.marketWide) lines.push(ln('حركة عامة في السوق', esc(F.clip(s.marketWide.detail || '', 80))));
  if (s.entryBlock) lines.push('⛔ لا تُفتح صفقات جديدة في الدقائق الأخيرة قبل الإغلاق.');
  lines.push('');
  lines.push('<b>نشاط الذكاء الاصطناعي اليوم</b>');
  lines.push(ln('إجمالي الطلبات', int(ai.requestsToday)));
  lines.push(ln('تحليلات بسبب أحداث السوق', int(ai.eventAnalysesToday)));
  lines.push(ln('طلبات مُنعت (تهدئة/حدود/ميزانية)', int(ai.preventedToday)));
  lines.push(ln('أحداث عالية الأولوية', int(s.counters && s.counters.highPriority)));
  const syms = Array.isArray(s.symbols) ? s.symbols : [];
  if (syms.length) {
    lines.push('', '<b>الأسهم</b>');
    for (const x of syms.slice(0, 20)) lines.push(`• ${b(esc(x.symbol))} — ${label('monitorMode', x.mode)} (${freshText(x.fresh)})`);
  }
  const problems = Array.isArray(s.problems) ? s.problems : [];
  lines.push('', '<b>مشكلات المراقبة والبيانات</b>');
  if (!problems.length) lines.push('• لا توجد مشكلات حالية.');
  for (const p of problems.slice(0, 8)) lines.push(`• ${p.symbol ? `${b(esc(p.symbol))}: ` : ''}${label('monitorProblem', p.code)}`);
  lines.push('');
  lines.push('ℹ️ شدة المراقبة لا تعني المزيد من الصفقات: حدود المخاطرة والميزانية كما هي.');
  lines.push(PAPER_NOTE);
  return { text: lines.join('\n'), keyboard: [[['📡 حالة النظام', 'sts'], ['🔄 تحديث', 'mn']], HOME] };
}

const NOTIF_LABELS = [
  ['trades', 'الصفقات والأوامر والاقتراحات'], ['ai', 'الذكاء الاصطناعي'], ['risk', 'المخاطر'], ['news', 'الأخبار'],
  ['data', 'جودة البيانات'], ['market', 'جلسات السوق'], ['watchlist', 'قائمة المراقبة'], ['breakouts', 'الاختراقات'], ['monitoring', 'أوضاع المراقبة والتقلب'],
];

function notifications(ctx, q) {
  const n = (ctx.cfg && ctx.cfg.notifications) || {};
  const lines = ['🔔 <b>الإشعارات</b>', ''];
  lines.push(ln('الإشعارات', n.enabled ? '✅ مفعّلة' : '❌ معطّلة'));
  for (const [k, l] of NOTIF_LABELS) lines.push(ln(l, n[k] === false ? '❌' : '✅'));
  lines.push('');
  lines.push('ℹ️ إشعارات تنفيذ الصفقات وحدود المخاطر وإيقاف الذكاء الاصطناعي أو أحد مزوديه بسبب خطأ، وإعادة تشغيل المحرك بعد توقف غير متوقع، وفشل فحوصات بدء التشغيل، تُرسل دائمًا عند تفعيل الإشعارات.');
  if (q) {
    lines.push('');
    lines.push(ln('في الانتظار', int(q.queued)));
    lines.push(ln('فشل إرسالها', int(q.failed)));
    lines.push(ln('أُرسلت اليوم', int(q.sentToday)));
  }
  lines.push('');
  lines.push('لتعديل الإشعارات استخدم صفحة الإعدادات في المنصة.');
  return { text: lines.join('\n'), keyboard: [[['🔄 تحديث', 'n'], ['⚙️ الإعدادات', 'cfg']], HOME] };
}

function settings(ctx) {
  const c = ctx.cfg || {};
  const r = c.reports || {};
  const lines = ['⚙️ <b>الإعدادات</b>', ''];
  lines.push(ln('البوت', c.enabled ? '✅ مفعّل' : '❌ معطّل'));
  lines.push(ln('المحادثات المصرح لها', int((c.authorizedChatIds || []).length)));
  lines.push(ln('المستخدمون المصرح لهم بالتحكم', int((c.authorizedUserIds || []).length)));
  lines.push(ln('صلاحيتك', ctx.auth && ctx.auth.canWrite ? 'قراءة وتحكم (مع تأكيد)' : 'قراءة فقط'));
  lines.push('');
  lines.push('<b>التقارير المجدولة</b>');
  lines.push(ln('اليومي', r.daily ? '✅' : '❌'));
  lines.push(ln('الأسبوعي', r.weekly ? `✅ (يوم ${F.L.weekday[F.isNum(r.weeklyDay) ? r.weeklyDay : 5] || NA})` : '❌'));
  lines.push(ln('الشهري', r.monthly ? '✅ (آخر يوم في الشهر)' : '❌'));
  lines.push(ln('وقت الإرسال', `${esc(r.time || '—')} ${F.tzLabel(ctx.tz)}`));
  lines.push('');
  lines.push('لتعديل الإعدادات استخدم صفحة الإعدادات في المنصة.');
  lines.push(PAPER_NOTE);
  return { text: lines.join('\n'), keyboard: [[['🔔 الإشعارات', 'n'], ['⚠️ إدارة المخاطر', 'rk']], [['📡 حالة النظام', 'sts'], ['❓ المساعدة', 'h']], HOME] };
}

module.exports = {
  HOME, PAPER_NOTE, PAGE, ORDERS_PAGE, FILL_PERIODS, STATS_PERIODS, STATS_CODE, STATS_LABEL, FILL_CODE_FROM_STATS, PROFILES, COMMANDS,
  mainMenu, help, portfolio, positions, todayPerf, fillsList, fillLines, askSymbol, recentSymbols, symbolButtons, ordersList, pendingOrders,
  tradesList, tradeDetails, decisionBlock, stats, renderReport, report, stock, stockAnalysis, stockNews, news, watchlist, aiScreen, aiUsage, usageLines,
  providerUsage, providerLines, aiModeButtons, dualLines, decisionMetaLines, stateText, BUDGET_NOTE, AI_PROVIDER_MODES,
  decisionsList, decisionStatus, risk, riskDetails, limitsLines, status, monitoring, notifications, settings, metric, periodPortfolioLines, ORDER_NOTE,
};
