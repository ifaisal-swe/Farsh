'use strict';
/**
 * Formatting helpers for Telegram (HTML parse mode). Western digits everywhere, Arabic labels,
 * dates in the configured timezone via Intl 'ar-u-nu-latn'. Unknown values are rendered as
 * "غير متاح" — never invented.
 */
const MAX_LEN = 4096;
const NA = 'غير متاح';
const INSUFFICIENT = 'بيانات غير كافية';
const DEFAULT_TZ = 'Asia/Riyadh';

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf4 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
const nfQty = new Intl.NumberFormat('en-US', { maximumFractionDigits: 4 });
const nfInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** $1,125.00 / -$12.40 */
function money(n) {
  if (!isNum(n)) return NA;
  const s = nf2.format(Math.abs(n));
  return (n < 0 && s !== '0.00' ? '-$' : '$') + s;
}
/** +$65.00 / -$12.40 / $0.00 */
function signedMoney(n) {
  if (!isNum(n)) return NA;
  const s = nf2.format(Math.abs(n));
  if (s === '0.00') return '$0.00';
  return (n > 0 ? '+$' : '-$') + s;
}
/** Stock price: 2 decimals, up to 4 for sub-dollar prices. */
function price(n) {
  if (!isNum(n)) return NA;
  const s = (Math.abs(n) < 1 ? nf4 : nf2).format(Math.abs(n));
  return (n < 0 ? '-$' : '$') + s;
}
/** +12.50% (signed) or 12.50% (unsigned). */
function pct(n, signed = true) {
  if (!isNum(n)) return NA;
  const s = nf2.format(Math.abs(n));
  if (!signed) return (n < 0 && s !== '0.00' ? '-' : '') + s + '%';
  if (s === '0.00') return '0.00%';
  return (n > 0 ? '+' : '-') + s + '%';
}
function qty(n) { return isNum(n) ? nfQty.format(n) : NA; }
function int(n) { return isNum(n) ? nfInt.format(n) : NA; }
function num(n, digits = 2) { return isNum(n) ? n.toFixed(digits) : NA; }

const TZ_LABELS = {
  'Asia/Riyadh': 'بتوقيت الرياض', 'Asia/Dubai': 'بتوقيت دبي', 'Asia/Kuwait': 'بتوقيت الكويت', 'Asia/Qatar': 'بتوقيت الدوحة',
  'Asia/Bahrain': 'بتوقيت البحرين', 'Asia/Muscat': 'بتوقيت مسقط', 'America/New_York': 'بتوقيت نيويورك', UTC: 'بالتوقيت العالمي UTC',
};
function tzLabel(tz) { return TZ_LABELS[tz] || `بتوقيت ${esc(tz)}`; }

function safeTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return DEFAULT_TZ; }
}

const dtfCache = new Map();
function dtf(locale, opts) {
  const k = locale + JSON.stringify(opts);
  if (!dtfCache.has(k)) dtfCache.set(k, new Intl.DateTimeFormat(locale, opts));
  return dtfCache.get(k);
}

function arParts(ts, tz) {
  const parts = dtf('ar-u-nu-latn', { timeZone: safeTz(tz), year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  return o;
}

/** "20 نوفمبر 2026" */
function date(ts, tz = DEFAULT_TZ) {
  if (!isNum(ts)) return NA;
  const p = arParts(ts, tz);
  return `${p.day} ${p.month} ${p.year}`;
}
/** "2:35 م" */
function time(ts, tz = DEFAULT_TZ) {
  if (!isNum(ts)) return NA;
  const p = arParts(ts, tz);
  return `${p.hour}:${p.minute} ${p.dayPeriod || ''}`.trim();
}
/** "20 نوفمبر 2026، 2:35 م" */
function dateTime(ts, tz = DEFAULT_TZ) {
  if (!isNum(ts)) return NA;
  return `${date(ts, tz)}، ${time(ts, tz)}`;
}

/** Numeric wall-clock parts in a timezone: { y, m, d, hh, mm, weekday(0=Sun), dateKey:'YYYY-MM-DD' } */
function localParts(ts, tz = DEFAULT_TZ) {
  const parts = dtf('en-US', { timeZone: safeTz(tz), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(ts));
  const o = {};
  for (const p of parts) o[p.type] = p.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[o.weekday];
  const hh = Number(o.hour) % 24;
  return { y: Number(o.year), m: Number(o.month), d: Number(o.day), hh, mm: Number(o.minute), weekday: wd, dateKey: `${o.year}-${o.month}-${o.day}` };
}

/** ms epoch of local midnight (approximate for DST-free zones; exact for Asia/Riyadh). */
function startOfLocalDay(ts, tz = DEFAULT_TZ) {
  const p = localParts(ts, tz);
  return ts - ((p.hh * 60 + p.mm) * 60 * 1000) - (new Date(ts).getUTCSeconds() * 1000) - new Date(ts).getUTCMilliseconds();
}

/** Keep a message under Telegram's 4096-char limit, cutting on a line boundary (tags never span lines in our templates). */
function fit(text, max = MAX_LEN) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  const budget = max - 2;
  let cut = s.lastIndexOf('\n', budget);
  if (cut < budget * 0.5) {
    // no good line boundary: fall back to plain text so we never break an HTML tag
    const plain = s.replace(/<[^>]*>/g, '');
    return plain.slice(0, budget) + '\n…';
  }
  return s.slice(0, cut) + '\n…';
}

/** Split long text into several messages on line boundaries. */
function split(text, max = MAX_LEN) {
  const out = [];
  let cur = '';
  for (const line of String(text).split('\n')) {
    const candidate = cur ? cur + '\n' + line : line;
    if (candidate.length > max) {
      if (cur) out.push(cur);
      cur = line.length > max ? fit(line, max) : line;
    } else cur = candidate;
  }
  if (cur) out.push(cur);
  return out;
}

/** Shorten free text (already plain) to n chars with an ellipsis. */
function clip(s, n = 300) {
  if (s == null) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------- Arabic labels
const L = {
  profile: { CONSERVATIVE: 'منخفضة', BALANCED: 'متوسطة', AGGRESSIVE: 'مرتفعة', VERY_AGGRESSIVE: 'مرتفعة جدًا', CUSTOM: 'مخصصة' },
  aiState: { RUNNING: 'يعمل', PAUSED: 'متوقف مؤقتًا', STOPPED: 'متوقف', IDLE: 'خامل' },
  orderStatus: { PENDING: 'معلق', FILLED: 'منفذ', PARTIALLY_FILLED: 'منفذ جزئيًا', REJECTED: 'مرفوض', CANCELLED: 'ملغى', EXPIRED: 'منتهي الصلاحية', OPEN: 'مفتوح' },
  side: { BUY: 'شراء', SELL: 'بيع' },
  source: { AI: 'الذكاء الاصطناعي', STOP: 'وقف الخسارة', TAKE_PROFIT: 'جني الأرباح', TRAILING_STOP: 'الوقف المتحرك', USER: 'يدوي (المستخدم)', PLAN: 'خطة المحفظة', GOAL: 'استثمار حددته', COMMAND: 'أمرك' },
  action: {
    BUY: 'شراء', SELL: 'بيع', HOLD: 'احتفاظ', WAIT: 'انتظار', EXIT: 'خروج', CLOSE: 'إغلاق', NONE: 'لا يوجد', NO_TRADE: 'لا تداول',
    WAITING_FOR_BREAKOUT: 'انتظار اختراق', WAITING_FOR_PULLBACK: 'انتظار ارتداد', EXIT_POSITION: 'خروج من المركز', REDUCE_POSITION: 'تقليص المركز',
  },
  trend: { UP: 'صاعد', DOWN: 'هابط', SIDEWAYS: 'عرضي' },
  session: { REGULAR: 'الجلسة الرسمية', PRE: 'ما قبل الافتتاح', POST: 'ما بعد الإغلاق', OVERNIGHT: 'الجلسة الليلية', CLOSED: 'السوق مغلق' },
  markKind: { TRADE: 'آخر صفقة', QUOTE: 'عرض/طلب', INDICATIVE: 'سعر استرشادي', DELAYED: 'سعر متأخر' },
  aiMode: { ECONOMY: 'اقتصادي', BALANCED: 'متوازن', DETAILED: 'تفصيلي' },
  apiStatus: { OK: 'يعمل', ERROR: 'خطأ', NO_KEY: 'لا يوجد مفتاح API' },
  symStatus: { ACTIVE: 'نشط', PAUSED: 'المراقبة متوقفة' },
  orderType: { MARKET: 'سوق', LIMIT: 'محدد السعر' },
  by: { USER: 'المستخدم', TELEGRAM: 'تيليجرام', SYSTEM: 'النظام', RISK: 'إدارة المخاطر', WEB: 'لوحة التحكم', DASHBOARD: 'لوحة التحكم' },
  weekday: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  // AI provider operating mode (which model(s) analyse) — distinct from the usage mode above (aiMode)
  aiProviderMode: { DEEPSEEK: 'DeepSeek فقط', GEMINI: 'Gemini فقط', AUTO: 'تلقائي', DUAL: 'تحليل مزدوج' },
  dualScope: { IMPORTANT: 'الأحداث المهمة فقط', ALL: 'جميع التحليلات' },
  providerState: { AVAILABLE: 'متاح', NOT_CONFIGURED: 'غير مضبوط', PAUSED_AFTER_ERRORS: 'متوقف مؤقتًا بعد أخطاء' },
  aiProvider: { deepseek: 'DeepSeek', gemini: 'Gemini', dual: 'تحليل مزدوج', rules: 'قواعد ثابتة' },
  monitorMode: {
    PRE_MARKET_PREPARATION: 'التحضير قبل الافتتاح', OPENING_INTENSIVE: 'مراقبة مكثفة للافتتاح', POST_OPEN_ACTIVE: 'مراقبة نشطة بعد الافتتاح', NORMAL_SESSION: 'مراقبة اعتيادية',
    HIGH_VOLATILITY: 'تقلب مرتفع', CLOSING_INTENSIVE: 'مراقبة مكثفة قبل الإغلاق', AFTER_HOURS: 'خارج الجلسة الرسمية', MARKET_CLOSED: 'السوق مغلق',
  },
  monitorIntensity: { MAXIMUM: 'قصوى', HIGH: 'عالية', ELEVATED: 'مرتفعة', NORMAL: 'عادية', LOW: 'منخفضة', IDLE: 'خاملة' },
  monitorProblem: { DATA: 'بيانات غير موثوقة', BASELINE: 'لا يوجد سجل كافٍ لقياس التقلب', AI: 'مزود الذكاء الاصطناعي متوقف مؤقتًا' },
  monitoringState: { ACTIVE: 'نشطة', PAUSED: 'متوقفة', ERROR: 'خطأ' },
  aiTradingState: { ACTIVE: 'نشط', PAUSED: 'متوقف', ERROR: 'خطأ', RISK_BLOCKED: 'محظور بحدود المخاطر' },
  serverState: { ONLINE: 'يعمل', DEGRADED: 'يعمل بأداء منقوص' },
  component: { database: 'قاعدة البيانات', engine: 'محرك التداول', alpaca: 'Alpaca', tiingo: 'Tiingo', deepseek: 'DeepSeek', gemini: 'Gemini', telegram: 'تيليجرام', news: 'الأخبار' },
  componentState: { ok: 'سليم', degraded: 'منقوص', error: 'خطأ', not_configured: 'غير مضبوط', idle: 'خامل', disabled: 'معطّل' },
  exitTrigger: { STOP_LOSS: 'وقف خسارة', TAKE_PROFIT: 'جني أرباح', TRAILING_STOP: 'وقف متحرك', MANUAL: 'إغلاق يدوي', AI: 'قرار الذكاء الاصطناعي' },
  dualPolicy: { AGREE_CONSERVATIVE: 'اتفق النموذجان', AGREE_NO_TRADE: 'اتفق النموذجان', DISAGREE_WAIT: 'اختلف النموذجان — لم تُنفذ أي صفقة' },
  uncertainty: { LOW: 'منخفض', MEDIUM: 'متوسط', HIGH: 'مرتفع' },
  impact: { HIGH: 'مرتفع', MEDIUM: 'متوسط', LOW: 'منخفض', POSITIVE: 'إيجابي', NEGATIVE: 'سلبي', NEUTRAL: 'محايد', MATERIAL: 'جوهري' },
  errorCode: {
    RATE_LIMIT: 'تجاوز حد الطلبات', QUOTA: 'نفاد الحصة لدى المزود', INVALID_KEY: 'مفتاح API غير صالح', NO_KEY: 'لا يوجد مفتاح API',
    INSUFFICIENT_BALANCE: 'رصيد غير كافٍ لدى المزود', NETWORK: 'خطأ في الشبكة', TIMEOUT: 'انتهت مهلة الاستجابة', SERVER: 'خطأ في خادم المزود',
    BAD_REQUEST: 'طلب غير صالح', BLOCKED: 'حُجبت الاستجابة', LENGTH: 'تجاوزت الاستجابة الطول المسموح', STREAM: 'انقطاع أثناء استلام الاستجابة', ERROR: 'خطأ',
  },
};
/** Label lookup; falls back to the escaped raw value or "غير متاح". */
function label(group, v) {
  if (v == null || v === '') return NA;
  const g = L[group] || {};
  return g[v] || esc(v);
}

const EXIT_ICON = { STOP_LOSS: '🛑', TAKE_PROFIT: '🎯', TRAILING_STOP: '📉', MANUAL: '✋', AI: '🤖' };
const FILL_KIND_TO_TRIGGER = { STOP: 'STOP_LOSS', TRAILING_STOP: 'TRAILING_STOP', TAKE_PROFIT: 'TAKE_PROFIT', USER: 'MANUAL', AI: 'AI' };
/** Exit trigger of a SELL fill (service field, or derived from the fill kind for older rows). */
function exitTriggerOf(f) {
  if (!f || f.side !== 'SELL') return null;
  return f.exitTrigger || FILL_KIND_TO_TRIGGER[f.kind] || null;
}
function exitTriggerText(t) { return t ? `${EXIT_ICON[t] || '•'} ${label('exitTrigger', t)}` : NA; }
/** AI provider that produced a decision / trade: deepseek|gemini|dual|rules, null → "—". */
function providerLabel(p) {
  if (p == null || p === '') return '—';
  const k = String(p).toLowerCase();
  return L.aiProvider[k] || esc(p);
}
function byLabel(by) {
  if (by == null || by === '') return NA;
  return L.by[String(by).toUpperCase()] || esc(by);
}

// Known engine / health reasons (English in the service) → Arabic; anything else is shown escaped.
const REASONS = [
  [/^paused by user$/i, 'أوقفها المستخدم'], [/^no monitored symbols$/i, 'لا توجد أسهم مراقبة'], [/^market data unavailable$/i, 'بيانات السوق غير متاحة'],
  [/^stopped$/i, 'تم الإيقاف'], [/^paused$/i, 'متوقف مؤقتًا'], [/^not started$/i, 'لم يبدأ بعد'], [/^market monitoring paused$/i, 'مراقبة السوق متوقفة'],
  [/^no AI provider key configured$/i, 'لا يوجد مفتاح لأي مزود ذكاء اصطناعي'], [/^risk limit reached$/i, 'تم بلوغ أحد حدود المخاطر'],
  [/^No AI provider available/i, 'لا يوجد مزود ذكاء اصطناعي متاح حاليًا'], [/^(DeepSeek|Gemini) unavailable/i, (m) => `${m[1]} غير متاح حاليًا`],
  [/^TRADING DISABLED/i, 'التداول معطّل بسبب حدود المخاطر'], [/^DAILY LOSS LIMIT/i, 'تم بلوغ حد الخسارة اليومية'], [/^LOSS COOLDOWN/i, 'فترة تهدئة بعد خسارة'],
  [/entries per day reached/i, 'تم بلوغ الحد الأقصى لعدد الصفقات اليومية'],
  [/^database integrity$/i, 'سلامة قاعدة البيانات'], [/^engine$/i, 'محرك التداول'], [/^market data$/i, 'بيانات السوق'], [/^Telegram$/i, 'تيليجرام'],
];
/** Arabic text for a service reason string ("a; b" lists are translated item by item). Output is HTML-safe. */
function reasonText(r, max = 200) {
  if (r == null || r === '') return NA;
  return String(r).split(/;\s*/).filter(Boolean).map((part) => {
    for (const [re, ar] of REASONS) {
      const m = re.exec(part.trim());
      if (m) return typeof ar === 'function' ? ar(m) : ar;
    }
    return esc(clip(part, max));
  }).join('؛ ');
}

module.exports = {
  MAX_LEN, NA, INSUFFICIENT, DEFAULT_TZ, isNum, esc, money, signedMoney, price, pct, qty, int, num,
  tzLabel, safeTz, date, time, dateTime, localParts, startOfLocalDay, fit, split, clip, L, label,
  exitTriggerOf, exitTriggerText, providerLabel, byLabel, reasonText,
};
