'use strict';
/**
 * Event -> Arabic notification templates (deterministic, no AI) and the persistent send worker.
 */
const F = require('./format');
const { PRIORITY } = require('./store');

const { esc, money, signedMoney, price, pct, qty, label } = F;

const CATEGORY = {
  FILL_EXECUTED: 'trades', ORDER_PENDING: 'trades', ORDER_CANCELLED: 'trades', ORDER_EXPIRED: 'trades', ORDER_REJECTED: 'trades', PROPOSAL: 'trades',
  OPPORTUNITY: 'ai', DECISION_CHANGED: 'ai', AI_STATE: 'ai', AI_PAUSED_ERROR: 'ai', AI_PROVIDER_DOWN: 'ai', AI_PROVIDER_RECOVERED: 'ai',
  RISK_LIMIT: 'risk', SHARIA_STATUS: 'risk',
  NEWS_MATERIAL: 'news',
  DATA_UNRELIABLE: 'data', DATA_RECOVERED: 'data', ENGINE_STARTED: 'data', ENGINE_UNCLEAN_RESTART: 'data', ENGINE_CHECK_FAILED: 'data',
  MARKET_SESSION: 'market', MONITORING_STARTED: 'market', MONITORING_STOPPED: 'market',
  SYMBOL_ADDED: 'watchlist', SYMBOL_REMOVED: 'watchlist', MONITORING_PAUSED: 'watchlist', MONITORING_RESUMED: 'watchlist',
  BREAKOUT: 'breakouts',
  MONITORING_MODE: 'monitoring', HIGH_VOLATILITY: 'monitoring',
};
/** Always sent when notifications.enabled is true, even if their category flag is off (always high priority). */
const MANDATORY = new Set(['FILL_EXECUTED', 'RISK_LIMIT', 'AI_PAUSED_ERROR', 'AI_PROVIDER_DOWN', 'ENGINE_UNCLEAN_RESTART', 'ENGINE_CHECK_FAILED']);
/** Used when the event carries no valid priority. */
const DEFAULT_PRIORITY = {
  FILL_EXECUTED: 'high', RISK_LIMIT: 'high', AI_PAUSED_ERROR: 'high', AI_PROVIDER_DOWN: 'high', ENGINE_UNCLEAN_RESTART: 'high', ENGINE_CHECK_FAILED: 'high',
  AI_PROVIDER_RECOVERED: 'low', ENGINE_STARTED: 'low', MONITORING_STARTED: 'normal', MONITORING_STOPPED: 'normal',
};
/** Informational events whose priority is fixed regardless of what the emitter sent. */
const FIXED_PRIORITY = { AI_PROVIDER_RECOVERED: 'low', ENGINE_STARTED: 'low', MONITORING_MODE: 'low', HIGH_VOLATILITY: 'low' };

const PAPER = '🧪 تداول ورقي فقط — لا توجد أموال أو أوامر حقيقية.';
const VIRTUAL = 'صفقة افتراضية';
const IMPACT = F.L.impact;
const SAFE_ID = /^[A-Za-z0-9_.-]{1,48}$/;
/** Title of an executed SELL that was triggered by a protective order. */
const PROTECTIVE_TITLE = { STOP: '🛑 تم تنفيذ وقف الخسارة', TRAILING_STOP: '📉 تم تنفيذ الوقف المتحرك', TAKE_PROFIT: '🎯 تم تنفيذ جني الأرباح' };

const ln = (k, v) => `• ${k}: ${v}`;
const timeLine = (ts, tz) => `🕒 ${F.dateTime(ts, tz)} (${F.tzLabel(tz)})`;
const sym = (s) => (s ? `<b>${esc(s)}</b>` : F.NA);
const link = (url, text) => (typeof url === 'string' && /^https?:\/\//i.test(url) ? `<a href="${esc(url)}">${esc(text)}</a>` : esc(text));
const kb = (...rows) => ({ inline_keyboard: rows.filter((r) => r && r.length).map((r) => r.map(([text, data]) => ({ text, callback_data: data }))) });

/** Display name of an AI provider from event data ({ provider: 'deepseek', name: 'DeepSeek' }). */
function providerName(d) {
  const id = d && d.provider ? String(d.provider).toLowerCase() : null;
  if (id && F.L.aiProvider[id]) return `<b>${F.L.aiProvider[id]}</b>`;
  return d && d.name ? `<b>${esc(F.clip(d.name, 40))}</b>` : '';
}

function orderTypeText(o) {
  if (o.type === 'LIMIT') return `${label('orderType', 'LIMIT')} عند ${price(o.limitPrice)}`;
  return label('orderType', o.type);
}

/**
 * Renders one event. Returns { text, replyMarkup } or null for unknown types.
 * `redact` scrubs secrets from free-text error messages.
 */
function renderEvent(ev, { tz = F.DEFAULT_TZ, redact = (s) => s } = {}) {
  const d = ev.data || {};
  const ts = ev.ts;
  const lines = [];
  let markup = null;
  switch (ev.type) {
    case 'FILL_EXECUTED': {
      const f = d.fill || {};
      const isSell = f.side === 'SELL';
      const partial = !!d.partial;
      const what = isSell ? 'بيع' : 'شراء';
      const protective = isSell ? PROTECTIVE_TITLE[f.kind] : null;
      if (protective) lines.push(`<b>${protective}${partial ? ' (تنفيذ جزئي)' : ''} — ${VIRTUAL}</b>`);
      else lines.push(`${isSell ? '🔴' : '🟢'} <b>تم تنفيذ ${partial ? 'جزء من ' : ''}صفقة ${what} — ${VIRTUAL}</b>`);
      lines.push(protective
        ? '<i>نُفذ البيع آليًا بواسطة أمر حماية مسجل مسبقًا في المحفظة الافتراضية (تداول ورقي).</i>'
        : '<i>صفقة منفذة في المحفظة الافتراضية (تداول ورقي)</i>');
      lines.push('');
      lines.push(ln('السهم', sym(f.symbol || ev.symbol)));
      lines.push(ln('الكمية', qty(f.qty)));
      lines.push(ln('سعر التنفيذ', price(f.price)));
      const notional = F.isNum(f.notional) ? f.notional : (F.isNum(f.qty) && F.isNum(f.price) ? f.qty * f.price : null);
      lines.push(ln('القيمة الإجمالية', money(notional)));
      lines.push(ln('الرسوم', money(f.fees)));
      if (isSell) {
        lines.push(ln('متوسط سعر الشراء (التكلفة)', price(f.costBasisPrice)));
        lines.push(ln('الربح/الخسارة المحققة', signedMoney(f.realizedPnl)));
        lines.push(ln('العائد على الصفقة', pct(f.returnPct)));
        const trig = F.exitTriggerOf(f);
        lines.push(ln('سبب البيع', trig ? F.exitTriggerText(trig) : label('source', f.kind)));
        if (trig === 'AI' && f.aiProvider) lines.push(ln('مزود التحليل', F.providerLabel(f.aiProvider)));
      } else {
        lines.push(ln('مصدر القرار', label('source', f.kind)));
        if (f.kind === 'AI' || f.aiProvider) lines.push(ln('مزود التحليل', F.providerLabel(f.aiProvider)));
        const notional0 = F.isNum(f.notional) ? f.notional : (F.isNum(f.qty) && F.isNum(f.price) ? f.qty * f.price : null);
        if (F.isNum(notional0)) lines.push(ln('التكلفة الإجمالية مع الرسوم', money(notional0 + (F.isNum(f.fees) ? f.fees : 0))));
      }
      if (f.strategy) lines.push(ln('الاستراتيجية', esc(f.strategy)));
      if (f.reason) lines.push(ln('السبب', esc(F.clip(f.reason, 300))));
      if (partial) lines.push('ℹ️ تنفيذ جزئي: قد يكون جزء من الأمر ما زال معلقًا.');
      lines.push('');
      lines.push(ln('السيولة بعد التنفيذ', money(d.cash)));
      lines.push(ln('قيمة المحفظة', money(d.equity)));
      if (f.id != null) lines.push(ln('رقم التنفيذ', `<code>${esc(f.id)}</code>`));
      if (f.orderId != null) lines.push(ln('رقم الأمر', `<code>${esc(f.orderId)}</code>`));
      lines.push(timeLine(f.ts || ts, tz));
      lines.push(PAPER);
      const rows = [];
      if (f.id != null && SAFE_ID.test(String(f.id))) rows.push(['📋 تفاصيل الصفقة', `td:${f.id}`]);
      rows.push(['💼 المحفظة', 'pf']);
      markup = kb(rows);
      break;
    }
    case 'OPPORTUNITY': {
      const sell = d.action === 'SELL' || d.action === 'SELL_PART';
      lines.push(sell ? `🔔 <b>${d.action === 'SELL' ? 'وقت البيع' : 'وقت بيع جزء'}</b>` : `✨ <b>فرصة ${d.action === 'BUY' ? 'شراء الآن' : 'شراء عند سعر محدد'}</b>`);
      lines.push('');
      lines.push(ln('السهم', sym(ev.symbol)));
      lines.push(ln('السعر الآن', price(d.price)));
      if (!sell && F.isNum(d.entry)) { lines.push(ln('شراء عند', price(d.entry))); lines.push(ln('وقف الخسارة', price(d.stop))); lines.push(ln('الهدف', price(d.target))); }
      if (d.why && d.why.ar) lines.push(ln('السبب', esc(F.clip(d.why.ar, 300))));
      lines.push('لا ربح مضمون، والوقف يحدد خسارتك.');
      lines.push(timeLine(ts, tz));
      lines.push(PAPER);
      break;
    }
    case 'ORDER_PENDING':
    case 'ORDER_CANCELLED':
    case 'ORDER_EXPIRED':
    case 'ORDER_REJECTED': {
      const o = d.order || {};
      const partly = F.isNum(o.filledQty) && o.filledQty > 0;
      const titles = {
        ORDER_PENDING: '⏳ <b>أمر معلق — لم يُنفذ بعد</b>',
        ORDER_CANCELLED: `🚫 <b>أمر ملغى — ${partly ? 'لم يُنفذ الجزء المتبقي' : 'لم يُنفذ'}</b>`,
        ORDER_EXPIRED: `⌛ <b>أمر منتهي الصلاحية — ${partly ? 'لم يُنفذ الجزء المتبقي' : 'لم يُنفذ'}</b>`,
        ORDER_REJECTED: '⛔ <b>أمر مرفوض — لم يُنفذ</b>',
      };
      lines.push(titles[ev.type]);
      lines.push(`🏷️ ${VIRTUAL} (تداول ورقي)`);
      lines.push('<i>هذا إشعار بحالة أمر ورقي وليس صفقة منفذة.</i>');
      lines.push('');
      lines.push(ln('السهم', sym(o.symbol || ev.symbol)));
      lines.push(ln('الاتجاه', label('side', o.side)));
      lines.push(ln('نوع الأمر', orderTypeText(o)));
      lines.push(ln('الكمية المطلوبة', qty(o.qty)));
      if (partly) lines.push(ln('الكمية المنفذة سابقًا', `${qty(o.filledQty)} بمتوسط ${price(o.avgFillPrice)}`));
      lines.push(ln('المصدر', label('source', o.source)));
      if (o.reason) lines.push(ln('السبب', esc(F.clip(o.reason, 300))));
      if (o.rejectReason) lines.push(ln('سبب الرفض', esc(F.clip(o.rejectReason, 300))));
      if (o.id != null) lines.push(ln('رقم الأمر', `<code>${esc(o.id)}</code>`));
      lines.push(timeLine(o.updatedAt || o.createdAt || ts, tz));
      lines.push(PAPER);
      markup = kb([['📑 الأوامر', 'o:all:0']]);
      break;
    }
    case 'PROPOSAL': {
      lines.push('💡 <b>اقتراح من الذكاء الاصطناعي (لم يُنفذ)</b>');
      lines.push('<i>هذا اقتراح فقط، ولم تُنفذ أي صفقة؛ أي تنفيذ لاحق يخضع لفحوصات إدارة المخاطر.</i>');
      lines.push('');
      lines.push(ln('السهم', sym(ev.symbol)));
      lines.push(ln('الإجراء المقترح', label('action', d.action)));
      lines.push(ln('سعر الدخول المقترح', price(d.entry)));
      lines.push(ln('وقف الخسارة', price(d.stop)));
      lines.push(ln('الهدف', price(d.target)));
      lines.push(ln('درجة الثقة', F.isNum(d.confidence) ? `${F.num(d.confidence, 0)}% (ليست احتمالًا معايرًا)` : F.NA));
      if (d.rationale) lines.push(ln('المبررات المسجلة', esc(F.clip(d.rationale, 400))));
      if (d.decisionId != null) lines.push(ln('رقم القرار', `<code>${esc(d.decisionId)}</code>`));
      lines.push(timeLine(ts, tz));
      lines.push(PAPER);
      if (ev.symbol) markup = kb([['📈 السهم', `sk:${ev.symbol}`]]);
      break;
    }
    case 'RISK_LIMIT':
      lines.push('⚠️ <b>تنبيه إدارة المخاطر</b>');
      if (ev.symbol) lines.push(ln('السهم', sym(ev.symbol)));
      if (d.kind) lines.push(ln('نوع الحد', esc(d.kind)));
      lines.push(esc(redact(d.message || 'تم بلوغ أحد حدود المخاطر.')));
      lines.push(timeLine(ts, tz));
      lines.push(PAPER);
      markup = kb([['⚠️ إدارة المخاطر', 'rk']]);
      break;
    case 'DATA_UNRELIABLE':
      lines.push('📡 <b>تنبيه: بيانات السوق غير موثوقة حاليًا</b>');
      if (ev.symbol) lines.push(ln('السهم', sym(ev.symbol)));
      if (d.label) lines.push(ln('مصدر البيانات', esc(d.label)));
      if (d.detail) lines.push(ln('التفاصيل', esc(F.clip(redact(d.detail), 300))));
      lines.push(timeLine(ts, tz));
      break;
    case 'DATA_RECOVERED':
      lines.push('📶 <b>عادت بيانات السوق إلى وضعها الطبيعي</b>');
      if (ev.symbol) lines.push(ln('السهم', sym(ev.symbol)));
      if (d.label) lines.push(ln('مصدر البيانات', esc(d.label)));
      if (d.detail) lines.push(ln('التفاصيل', esc(F.clip(redact(d.detail), 300))));
      lines.push(timeLine(ts, tz));
      break;
    case 'AI_PAUSED_ERROR':
      lines.push('🛑 <b>تم إيقاف الذكاء الاصطناعي مؤقتًا بسبب خطأ</b>');
      if (d.code) lines.push(ln('رمز الخطأ', `<code>${esc(d.code)}</code>`));
      if (d.message) lines.push(ln('التفاصيل', esc(F.clip(redact(d.message), 300))));
      lines.push('أوامر الحماية (وقف الخسارة وجني الأرباح) للمراكز المفتوحة تبقى فعّالة.');
      lines.push(timeLine(ts, tz));
      markup = kb([['🤖 الذكاء الاصطناعي', 'ai'], ['📡 الحالة', 'sts']]);
      break;
    case 'DECISION_CHANGED':
      lines.push('🔄 <b>تغيّر قرار الذكاء الاصطناعي</b>');
      lines.push(ln('السهم', sym(ev.symbol)));
      lines.push(ln('القرار', `من «${label('action', d.from)}» إلى «${label('action', d.to)}»`));
      if (F.isNum(d.confidence)) lines.push(ln('درجة الثقة', `${F.num(d.confidence, 0)}% (ليست احتمالًا معايرًا)`));
      if (d.reason) lines.push(ln('السبب المسجل', esc(F.clip(d.reason, 400))));
      lines.push(timeLine(ts, tz));
      if (ev.symbol) markup = kb([['📈 السهم', `sk:${ev.symbol}`]]);
      break;
    case 'NEWS_MATERIAL':
      lines.push('📰 <b>خبر مؤثر</b>');
      if (ev.symbol) lines.push(ln('السهم', sym(ev.symbol)));
      lines.push(ln('العنوان', link(d.url, F.clip(d.title || F.NA, 300))));
      if (d.source) lines.push(ln('المصدر', esc(d.source)));
      if (d.impact) lines.push(ln('التأثير المتوقع', IMPACT[d.impact] || esc(d.impact)));
      lines.push(timeLine(ts, tz));
      break;
    case 'MARKET_SESSION':
      lines.push('🕒 <b>تغيّرت جلسة السوق</b>');
      lines.push(ln('من', label('session', d.from)));
      lines.push(ln('إلى', label('session', d.to)));
      lines.push(timeLine(ts, tz));
      break;
    case 'SYMBOL_ADDED':
      lines.push(`➕ <b>تمت إضافة سهم إلى قائمة المراقبة:</b> ${sym(ev.symbol)}`);
      lines.push(timeLine(ts, tz));
      break;
    case 'SYMBOL_REMOVED':
      lines.push(`➖ <b>تمت إزالة سهم من قائمة المراقبة:</b> ${sym(ev.symbol)}`);
      lines.push(timeLine(ts, tz));
      break;
    case 'MONITORING_PAUSED':
      lines.push(`⏸️ <b>تم إيقاف مراقبة السهم مؤقتًا:</b> ${sym(ev.symbol)}`);
      lines.push(timeLine(ts, tz));
      break;
    case 'MONITORING_RESUMED':
      lines.push(`▶️ <b>تم استئناف مراقبة السهم:</b> ${sym(ev.symbol)}`);
      lines.push(timeLine(ts, tz));
      break;
    case 'BREAKOUT': {
      const up = d.type !== 'BREAKDOWN';
      lines.push(up ? '🚀 <b>اختراق صاعد</b>' : '📉 <b>كسر هابط</b>');
      lines.push(ln('السهم', sym(ev.symbol)));
      lines.push(ln(up ? 'مستوى المقاومة' : 'مستوى الدعم', price(d.level)));
      lines.push(d.close != null ? ln('سعر الإغلاق', price(d.close)) : ln('السعر عند الاختراق', price(d.price)));
      lines.push('ℹ️ تنبيه فني فقط وليس أمر تداول.');
      lines.push(timeLine(ts, tz));
      break;
    }
    case 'MONITORING_MODE': {
      const title = { OPENING_INTENSIVE: '🔔 <b>بدأت المراقبة المكثفة للافتتاح</b>', CLOSING_INTENSIVE: '🔔 <b>بدأت المراقبة المكثفة قبل الإغلاق</b>', NORMAL_SESSION: '🔕 <b>عادت المراقبة إلى الوضع الاعتيادي</b>' }[d.to];
      if (!title) return null;
      lines.push(title);
      lines.push(ln('شدة المراقبة', label('monitorIntensity', d.intensity)));
      lines.push('ℹ️ المراقبة محلية؛ لا تغيّر حدود المخاطرة ولا تشغّل التداول الآلي.');
      lines.push(timeLine(ts, tz));
      markup = kb([['📡 المراقبة', 'mn']]);
      break;
    }
    case 'HIGH_VOLATILITY': {
      const target = ev.symbol ? sym(ev.symbol) : 'السوق ككل';
      lines.push(d.active ? `⚡ <b>تفعيل وضع التقلب المرتفع:</b> ${target}` : `🔕 <b>انتهاء وضع التقلب المرتفع:</b> ${target}`);
      if (d.active) lines.push('رُفعت شدة المراقبة المحلية مؤقتًا؛ حدود المخاطرة لم تتغير.');
      lines.push(timeLine(ts, tz));
      markup = kb([['📡 المراقبة', 'mn']]);
      break;
    }
    case 'SHARIA_STATUS': {
      const names = { PASS: 'مجتاز للفحص', FAIL: 'غير متوافق', UNKNOWN: 'غير محسوم' };
      lines.push(`${d.status === 'PASS' ? '✅' : '⚠️'} <b>تغيّرت حالة الفحص الشرعي:</b> ${sym(ev.symbol)}`);
      lines.push(ln('من', names[d.prev] || F.NA));
      lines.push(ln('إلى', names[d.status] || F.NA));
      if (d.status !== 'PASS') lines.push('لن تُفتح مراكز شراء جديدة في هذا السهم.');
      if (d.held && d.status !== 'PASS') lines.push('لديك مركز مفتوح فيه. لم يُبَع شيء تلقائيًا؛ القرار لك.');
      lines.push('<i>فحص آلي أولي وليس فتوى.</i>');
      lines.push(timeLine(ts, tz));
      break;
    }
    case 'AI_STATE':
      lines.push('🤖 <b>تغيّرت حالة الذكاء الاصطناعي</b>');
      lines.push(ln('من', label('aiState', d.from)));
      lines.push(ln('إلى', label('aiState', d.to)));
      if (d.by) lines.push(ln('بواسطة', F.byLabel(d.by)));
      lines.push(timeLine(ts, tz));
      break;
    case 'AI_PROVIDER_DOWN': {
      const name = providerName(d);
      lines.push(`⚠️ <b>تم إيقاف مزود الذكاء الاصطناعي ${name} مؤقتًا بعد أخطاء</b>`);
      if (d.code) lines.push(ln('رمز الخطأ', `<code>${esc(d.code)}</code>${F.L.errorCode[d.code] ? ` (${F.L.errorCode[d.code]})` : ''}`));
      if (d.reason) lines.push(ln('السبب', esc(F.clip(redact(String(d.reason)), 300))));
      lines.push(ln('متوقف حتى', F.isNum(d.until) ? `${F.time(d.until, tz)} (${F.date(d.until, tz)})` : F.NA));
      lines.push('سيُستخدم المزود الآخر إن كان متاحًا؛ مراقبة السوق وأوامر الحماية مستمرة.');
      lines.push(timeLine(ts, tz));
      markup = kb([['🤖 الذكاء الاصطناعي', 'ai'], ['📡 الحالة', 'sts']]);
      break;
    }
    case 'AI_PROVIDER_RECOVERED':
      lines.push(`✅ <b>عاد مزود الذكاء الاصطناعي ${providerName(d)} إلى العمل</b>`);
      lines.push(timeLine(ts, tz));
      break;
    case 'ENGINE_UNCLEAN_RESTART':
      lines.push('⚠️ <b>أُعيد تشغيل محرك التداول بعد توقف غير متوقع</b>');
      lines.push('• تمت استعادة المحفظة والمراكز المفتوحة من قاعدة البيانات.');
      lines.push('• لم تُنفذ أي صفقة بأسعار فترة التوقف.');
      if (F.isNum(d.previousStartedAt)) lines.push(ln('بداية التشغيل السابق', F.dateTime(d.previousStartedAt, tz)));
      lines.push('يُنصح بمراجعة حالة النظام والمحفظة.');
      lines.push(timeLine(ts, tz));
      lines.push(PAPER);
      markup = kb([['📡 الحالة', 'sts'], ['💼 المحفظة', 'pf']]);
      break;
    case 'ENGINE_CHECK_FAILED': {
      lines.push('🛑 <b>فشلت فحوصات بدء التشغيل</b>');
      lines.push('لم يُستأنف التداول الآلي بالذكاء الاصطناعي.');
      const problems = (Array.isArray(d.problems) ? d.problems : []).filter(Boolean).slice(0, 10);
      if (problems.length) {
        lines.push('<b>المشكلات:</b>');
        for (const p of problems) lines.push(`• ${esc(F.clip(redact(String(p)), 200))}`);
      }
      lines.push('بيانات السوق وأوامر الحماية للمراكز المفتوحة مستمرة؛ راجع الحالة ثم استأنف يدويًا عبر /resumeai.');
      lines.push(timeLine(ts, tz));
      markup = kb([['📡 الحالة', 'sts'], ['🤖 الذكاء الاصطناعي', 'ai']]);
      break;
    }
    case 'ENGINE_STARTED':
      lines.push('🟢 <b>بدأ تشغيل الخادم</b>');
      lines.push(timeLine(ts, tz));
      break;
    case 'MONITORING_STARTED':
    case 'MONITORING_STOPPED': {
      const stopped = ev.type === 'MONITORING_STOPPED';
      lines.push(stopped ? '⏸ <b>تم إيقاف مراقبة السوق مؤقتًا</b>' : '▶️ <b>تم استئناف مراقبة السوق</b>');
      lines.push(stopped
        ? 'لا تحليل للذكاء الاصطناعي ولا تنبيهات سوق؛ بيانات السوق وأوامر الحماية للمراكز المفتوحة تبقى فعّالة.'
        : 'عاد النظام إلى مراقبة الأسهم وتحليلها وفق حدود المخاطر الحالية.');
      if (d.by) lines.push(ln('بواسطة', F.byLabel(d.by)));
      lines.push(timeLine(ts, tz));
      markup = kb([['📡 الحالة', 'sts']]);
      break;
    }
    default:
      return null;
  }
  return { text: F.fit(lines.join('\n')), replyMarkup: markup };
}

// ---------------------------------------------------------------- worker
const CHAT_SPACING_MS = 1100;
const GLOBAL_PER_SEC = 20;
const MAX_ATTEMPTS = 6;
const MAX_429_ATTEMPTS = 30;

function createWorker({ tgStore, api, now, setTimeoutImpl, log, isEnabled, redact }) {
  const lastSentByChat = new Map();
  const recentSends = [];
  let pausedUntil = 0;
  let running = false;
  let draining = false;
  let gen = 0;
  let timer = null;

  async function sendRow(row) {
    const t = now();
    lastSentByChat.set(row.chat_id, t);
    recentSends.push(t);
    try {
      const params = { chat_id: row.chat_id, text: row.text, parse_mode: 'HTML', disable_web_page_preview: true };
      if (row.reply_markup) { try { params.reply_markup = JSON.parse(row.reply_markup); } catch { /* ignore */ } }
      await api.call('sendMessage', params);
      tgStore.markSent(row.id, now());
      return true;
    } catch (e) {
      const msg = redact(e && e.message ? e.message : String(e));
      const status = e && e.status;
      const tNow = now();
      if (status === 429) {
        const ra = Math.max(1, Number(e.retryAfter) || 1);
        pausedUntil = Math.max(pausedUntil, tNow + ra * 1000);
        if (row.attempts + 1 >= MAX_429_ATTEMPTS) tgStore.markFailed(row.id, msg);
        else tgStore.markRetry(row.id, tNow + ra * 1000, msg);
        log('warn', `telegram: rate limited (429), retrying notification #${row.id} after ${ra}s`);
      } else if (e && e.kind !== 'NO_TOKEN' && (status === 0 || status == null || status >= 500 || e.kind === 'NETWORK' || e.kind === 'TIMEOUT')) {
        if (row.attempts + 1 >= MAX_ATTEMPTS) {
          tgStore.markFailed(row.id, msg);
          log('warn', `telegram: notification #${row.id} failed after ${MAX_ATTEMPTS} attempts: ${msg}`);
        } else {
          const delay = Math.min(1000 * 2 ** row.attempts, 10 * 60 * 1000);
          tgStore.markRetry(row.id, tNow + delay, msg);
        }
      } else if (e && e.kind === 'NO_TOKEN') {
        tgStore.defer(row.id, tNow + 60000);
      } else {
        tgStore.markFailed(row.id, msg);
        log('warn', `telegram: notification #${row.id} rejected by Telegram: ${msg}`);
      }
      return false;
    }
  }

  /** Sends every due notification allowed by the per-chat / global rate limits right now. */
  async function drainOnce() {
    if (draining) return 0;
    draining = true;
    let attempts = 0;
    try {
      for (;;) {
        const t = now();
        if (t < pausedUntil) break;
        while (recentSends.length && recentSends[0] <= t - 1000) recentSends.shift();
        if (recentSends.length >= GLOBAL_PER_SEC) break;
        const due = tgStore.dueNotifications(t, 1000);
        if (!due.length) break;
        const row = due.find((r) => (lastSentByChat.has(r.chat_id) ? lastSentByChat.get(r.chat_id) + CHAT_SPACING_MS <= t : true));
        if (!row) break;
        await sendRow(row);
        attempts++;
      }
    } finally {
      draining = false;
    }
    return attempts;
  }

  function schedule(delay) {
    const my = ++gen;
    if (timer) { try { clearTimeout(timer); } catch { /* fake timer */ } }
    timer = setTimeoutImpl(() => {
      if (my !== gen || !running) return;
      tick();
    }, Math.max(0, delay));
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    try {
      if (isEnabled()) await drainOnce();
    } catch (e) {
      log('warn', `telegram: notification worker error: ${redact(e && e.message)}`);
    }
    if (!running) return;
    const t = now();
    let delay = 5000;
    const next = tgStore.nextAttemptAt();
    if (next != null) delay = Math.min(delay, Math.max(250, next - t));
    if (pausedUntil > t) delay = Math.max(delay, pausedUntil - t);
    schedule(delay);
  }

  return {
    start() { if (running) return; running = true; schedule(0); },
    stop() { running = false; gen++; if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } timer = null; } },
    kick() { if (running) schedule(0); },
    drainOnce,
    isRunning: () => running,
  };
}

module.exports = { renderEvent, createWorker, CATEGORY, MANDATORY, DEFAULT_PRIORITY, FIXED_PRIORITY, PRIORITY, CHAT_SPACING_MS, GLOBAL_PER_SEC, MAX_ATTEMPTS, SAFE_ID };
