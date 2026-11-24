'use strict';
/**
 * Plain wording for customers of the hosted platform. Notifications are written here in short sentences; every other
 * screen passes through plainText(), which drops technical lines (providers, models, identifiers, system state, raw
 * reasons) and is applied to everything the bot sends. Technical screens and buttons are not offered at all.
 */
const F = require('./format');
const { esc } = F;

const TECH = /مزود|النموذج|نموذج|رقم (?:القرار|الأمر|التنفيذ)|الخادم|قاعدة البيانات|محرك|الميزانية|ميزانية|استهلاك|استهلك|التكلفة التقديرية|التحويل إلى|رمز الخطأ|درجة الثقة|الاستراتيجية|الإستراتيجية|السبب المسجل|المبررات|طلبات|شدة المراقبة|التكيفية|المتصل|اتصال|مصدر القرار|زمن|لقطة|تخزين|معايرًا|\bAPI\b|deepseek|gemini|alpaca|tiingo|sqlite|postgres|server|token|\bmodel\b|<code>/i;
const HIDDEN_COMMANDS = new Set(['ai', 'decisions', 'status', 'monitoring', 'settings']);
const ALIAS = { pauseauto: 'pauseai', resumeauto: 'resumeai', stopauto: 'stopai' };
const HIDDEN_DATA = /^(?:ai(?::|$)|aim:|d:|sts$|mn$|mon:|cfg$|td:)/;
const soften = (s) => s.replace(/محفز الخروج/g, 'سبب البيع').replace(/الذكاء الاصطناعي/g, 'التداول الآلي').replace(/إيقاف الذكاء /g, 'إيقاف التداول الآلي ').replace(/استئناف الذكاء/g, 'استئناف التداول الآلي')
  .replace(/\s*عبر \/\w+/g, '').replace(/\/(pause|resume|stop)ai\b/g, '/$1auto').replace(/هذا البوت|البوت/g, 'فرصة').replace(/النظام/g, 'المنصة').replace(/تداول ورقي فقط — لا يتم إرسال أي أوامر حقيقية إلى أي وسيط/g, 'تداول ورقي فقط');
// ordinary text has no Latin words: only symbols such as NVDA, BTC/USD, USD and commands
const LATIN = /(?<![/\w@.])[A-Za-z]*[a-z][A-Za-z]{2,}|\b[A-Z]+_[A-Z_]+\b/;

function plainLine(line) {
  if (/<a href=/.test(line)) return soften(line); // a news headline in its own language
  const cmd = /^\s*(?:•\s*)?\/(\w+)/.exec(line);
  if (cmd && HIDDEN_COMMANDS.has(cmd[1])) return null;
  const bare = line.replace(/<\/?(?:b|i|u)>/g, '').replace(/&\w+;/g, ' ');
  if (TECH.test(bare) || LATIN.test(bare.replace(/\/\w+/g, ' '))) return null;
  return soften(line);
}

function plainText(text) {
  const out = [];
  for (const l of String(text).split('\n')) {
    const p = plainLine(l);
    if (p == null || (!p.trim() && (!out.length || !out[out.length - 1].trim()))) continue;
    out.push(p);
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? out.join('\n') : 'لا تفاصيل لعرضها الآن. افتح فرصة لمتابعة محفظتك.';
}

function plainMarkup(m) {
  if (!m || !m.inline_keyboard) return m;
  const rows = m.inline_keyboard.map((r) => r.filter((x) => !HIDDEN_DATA.test(x.callback_data || '')).map((x) => ({ ...x, text: soften(x.text) }))).filter((r) => r.length);
  return { inline_keyboard: rows.length ? rows : [[{ text: '🏠 القائمة الرئيسية', callback_data: 'm' }]] };
}

/** What a customer may ask for; anything technical leads back to the menu. */
function plainUpdate(u) {
  if (u && u.callback_query && HIDDEN_DATA.test(u.callback_query.data || '')) return { ...u, callback_query: { ...u.callback_query, data: 'm' } };
  const m = u && u.message && /^\/(\w+)(.*)$/s.exec(u.message.text || '');
  if (!m) return u;
  const c = m[1].toLowerCase();
  const to = ALIAS[c] || (HIDDEN_COMMANDS.has(c) ? 'start' : null);
  return to ? { ...u, message: { ...u.message, text: `/${to}` } } : u;
}

function plainCommands(list) {
  const back = Object.fromEntries(Object.entries(ALIAS).map(([a, b]) => [b, a]));
  return list.filter(([c]) => !HIDDEN_COMMANDS.has(c)).map(([c, d]) => [back[c] || c, soften(d)]);
}

const SESSION = { REGULAR: 'مفتوح', PRE: 'قبل الافتتاح', POST: 'بعد الإغلاق', OVERNIGHT: 'في الجلسة الليلية', CLOSED: 'مغلق' };
const SHARIA = { PASS: 'مجتاز', FAIL: 'غير متوافق', UNKNOWN: 'غير محسوم' };
const STATE = { RUNNING: 'يعمل', PAUSED: 'متوقف مؤقتًا', STOPPED: 'متوقف', IDLE: 'لم يبدأ' };
const WHY = { STOP: 'وقف الخسارة', TRAILING_STOP: 'الوقف المتحرك', TAKE_PROFIT: 'بلوغ الهدف', USER: 'قرارك', AI: 'التداول الآلي', PLAN: 'خطة المحفظة', GOAL: 'استثمار حددته', COMMAND: 'أمرك' };
const PAPER = '🧪 تداول ورقي';

/** One short notification, or null when it is not for the reader. */
function plainEvent(ev, { tz = F.DEFAULT_TZ, demo = false } = {}) {
  const d = ev.data || {};
  const s = `<b>${esc(ev.symbol || '')}</b>`;
  const at = `🕒 ${F.dateTime(ev.ts, tz)}`;
  const say = (...x) => ({ text: [...x.filter(Boolean), demo ? '⚠️ أسعار تجريبية غير حقيقية' : null, at].filter(Boolean).join('\n'), replyMarkup: null });
  switch (ev.type) {
    case 'FILL_EXECUTED': {
      const f = d.fill || {};
      const sell = f.side === 'SELL';
      return { ...say(`${sell ? '🔴 بيع' : '🟢 شراء'}: ${F.qty(f.qty)} من <b>${esc(f.symbol || ev.symbol || '')}</b> بسعر ${F.price(f.price)}`, sell ? `الربح أو الخسارة: ${F.signedMoney(f.realizedPnl)}` : null, sell && WHY[f.kind] ? `السبب: ${WHY[f.kind]}` : null, `قيمة المحفظة: ${F.money(d.equity)}`, PAPER), replyMarkup: { inline_keyboard: [[{ text: '💼 المحفظة', callback_data: 'pf' }]] } };
    }
    case 'ORDER_PENDING': return say(`⏳ أمر ${s} ينتظر السعر المطلوب`, PAPER);
    case 'ORDER_CANCELLED': return say(`🚫 أُلغي أمر ${s}`, PAPER);
    case 'ORDER_EXPIRED': return say(`⌛ انتهت مدة أمر ${s} دون تنفيذ`, PAPER);
    case 'ORDER_REJECTED': return say(`⛔ لم يجتز أمر ${s} ضوابط المخاطر، فلم يُنفذ`, PAPER);
    case 'PROPOSAL': return say(`💡 اقتراح في ${s}: ${F.label('action', d.action)}`, F.isNum(d.stop) ? `وقف الخسارة: ${F.price(d.stop)}` : null, F.isNum(d.target) ? `الهدف: ${F.price(d.target)}` : null, 'اقتراح فقط، لم يُنفذ شيء.', PAPER);
    case 'DECISION_CHANGED': return say(`🔄 تغيّر الرأي في ${s} إلى: ${F.label('action', d.to)}`);
    case 'RISK_LIMIT': return say('⚠️ بلغت أحد حدود المخاطر، وتوقف الشراء لحمايتك', PAPER);
    case 'SHARIA_STATUS': return say(`${d.status === 'PASS' ? '✅' : '⚠️'} حالة ${s} الشرعية الآن: ${SHARIA[d.status] || F.NA}`, d.status !== 'PASS' ? 'لن يُشترى حتى تتغيّر حالته.' : null, d.held && d.status !== 'PASS' ? 'تملكه الآن. لم يُبع شيء، والقرار لك.' : null, 'فحص آلي أولي.');
    case 'NEWS_MATERIAL': return say(`📰 خبر مؤثر في ${s}`, /^https?:\/\//i.test(d.url || '') ? `<a href="${esc(d.url)}">${esc(F.clip(d.title || '', 300))}</a>` : esc(F.clip(d.title || '', 300)));
    case 'MARKET_SESSION': return say(`🕒 السوق الآن ${SESSION[d.to] || F.NA}`);
    case 'SYMBOL_ADDED': return say(`➕ أُضيف ${s} إلى المتابعة`);
    case 'SYMBOL_REMOVED': return say(`➖ أُزيل ${s} من المتابعة`);
    case 'MONITORING_PAUSED': return say(`⏸️ توقفت متابعة ${s} مؤقتًا`);
    case 'MONITORING_RESUMED': return say(`▶️ عادت متابعة ${s}`);
    case 'MONITORING_STOPPED': return say('⏸ توقفت متابعة السوق مؤقتًا. مراكزك تبقى محمية');
    case 'MONITORING_STARTED': return say('▶️ عادت متابعة السوق');
    case 'BREAKOUT': return say(d.type === 'BREAKDOWN' ? `📉 كسر ${s} مستوى مهمًا نزولًا` : `🚀 تجاوز ${s} مستوى مهمًا صعودًا`, F.isNum(d.level) ? `المستوى: ${F.price(d.level)}` : null, 'تنبيه فقط وليس توصية.');
    case 'HIGH_VOLATILITY': return say(`${d.active ? '⚡ حركة قوية في' : '🔕 هدأت حركة'} ${ev.symbol ? s : 'السوق'}`);
    case 'AI_STATE': return say(`🤖 التداول الآلي: ${STATE[d.to] || F.NA}`);
    case 'AI_PAUSED_ERROR': case 'ENGINE_CHECK_FAILED': return say('⏸️ توقف التداول الآلي مؤقتًا', 'مراكزك تبقى محمية.');
    case 'DATA_UNRELIABLE': return say('📡 الأسعار غير مؤكدة الآن، والشراء متوقف حتى تعود');
    case 'DATA_RECOVERED': return say('📶 عادت الأسعار');
    case 'ENGINE_UNCLEAN_RESTART': return say('⚠️ استُعيدت محفظتك بعد انقطاع', 'لم تُنفذ أي صفقة خلاله.');
    default: return null;
  }
}

/** Wraps the Telegram client so that nothing technical can leave, whichever screen produced it. */
function plainApi(api) {
  const call = (method, params = {}, o) => {
    if (!['sendMessage', 'editMessageText', 'answerCallbackQuery'].includes(method)) return api.call(method, params, o);
    const p = { ...params };
    if (typeof p.text === 'string') p.text = plainText(p.text);
    if (p.reply_markup) p.reply_markup = plainMarkup(p.reply_markup);
    return api.call(method, p, o);
  };
  return { ...api, call };
}

module.exports = { plainText, plainMarkup, plainUpdate, plainCommands, plainEvent, plainApi, TECH, LATIN };
