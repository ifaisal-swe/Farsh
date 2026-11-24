'use strict';
/**
 * Interactive bot: authorization, commands, inline-button routing (strict whitelist), free-text intents,
 * and the confirmation flow (one-time nonces) for every state-changing action.
 * PAPER TRADING ONLY: the only state-changing calls are the service controls listed in ACTIONS
 * (AI pause/resume/stop, AI provider mode, market monitoring pause/resume, risk profile, watchlist).
 * Nothing here can place, change or cancel an order.
 */
const crypto = require('node:crypto');
const F = require('./format');
const S = require('./screens');
const { parseIntent, TICKER_RE } = require('./intents');

const { esc, label, NA } = F;

const UNAUTH_TEXT = '⛔ غير مصرح لك باستخدام هذا البوت.';
const NO_CONTROL_TEXT = '⛔ هذا الإجراء يتطلب مستخدمًا مصرحًا له بالتحكم. يمكنك استعراض البيانات فقط.';
const INVALID_TEXT = 'طلب غير صالح';
const NONCE_TTL_MS = 2 * 60 * 1000;
const CONV_TTL_MS = 5 * 60 * 1000;
const UNAUTH_REPLY_INTERVAL_MS = 10 * 60 * 1000;

// ------------------------------------------------------------------ callback whitelist
const SYM = '(?:[A-Z0-9]{2,6}\\/USD|[A-Z][A-Z0-9.]{0,9})';
const CALLBACK_ROUTES = [
  ['menu', /^m$/],
  ['help', /^h$/],
  ['noop', /^noop$/],
  ['pf', /^pf(?::(pos|td))?$/],
  ['fills', new RegExp(`^(b|s):(t|7|30|a):(\\d{1,3})(?::(${SYM}))?$`)],
  ['fillsx', /^(b|s):(sym|pend)$/],
  ['orders', /^o:(all|buy|sell|open|fill|canc|rej|exp):(\d{1,3})$/],
  ['trades', new RegExp(`^tr:(t|7|30|a):(a|b|s):(\\d{1,3})(?::(${SYM}))?$`)],
  ['tradesSym', /^tr:sym$/],
  ['td', /^td:([A-Za-z0-9_.-]{1,48})$/],
  ['stats', /^st:(t|w|m|a)$/],
  ['report', /^rp:(d|w|m)$/],
  ['stock', new RegExp(`^sk:(${SYM})(?::(f|d|t|n))?$`)],
  ['watch', /^w(?::(add|rm|pa|re|det))?$/],
  ['watchAct', new RegExp(`^wa:(add|rm|pa|re):(${SYM})$`)],
  ['ai', /^ai(?::(u|ds|gm))?$/],
  ['aiMode', /^aim:(DEEPSEEK|GEMINI|AUTO|DUAL)$/],
  ['mon', /^mon:(pause|resume)$/],
  ['news', /^nw$/],
  ['decisions', new RegExp(`^d:(a|b|s):(\\d{1,3})(?::(${SYM}))?$`)],
  ['decisionsSym', /^d:sym$/],
  ['risk', /^rk(?::(d))?$/],
  ['riskProfile', /^rk:p:(CONSERVATIVE|BALANCED|AGGRESSIVE|VERY_AGGRESSIVE)$/],
  ['status', /^sts$/],
  ['monitor', /^mn$/],
  ['ctl', /^ctl:(pause|resume|stop)$/],
  ['notif', /^n$/],
  ['settings', /^cfg$/],
  ['confirm', /^y:([A-Za-z0-9_-]{16})$/],
  ['cancel', /^x:([A-Za-z0-9_-]{16})$/],
  ['qPeriod', /^q:(pnl|buy|sell|tcl|tcw|tca|bs|ws|st):(today|week|month|all)$/],
  ['qSym', new RegExp(`^q:(wys|wyb|aid|stk):(${SYM})$`)],
];

/** Strict whitelist: returns { route, m } or null. Never more than 64 bytes. */
function parseCallbackData(data) {
  if (typeof data !== 'string' || !data.length || Buffer.byteLength(data, 'utf8') > 64) return null;
  for (const [route, re] of CALLBACK_ROUTES) {
    const m = re.exec(data);
    if (m) return { route, m };
  }
  return null;
}

/** [[label, data], ...] rows -> Telegram inline keyboard (drops anything not on the whitelist). */
function toInlineKeyboard(keyboard, onDrop = () => {}) {
  const rows = [];
  for (const row of keyboard || []) {
    const r = [];
    for (const btn of row || []) {
      const [text, data] = btn;
      if (parseCallbackData(data)) r.push({ text: String(text).slice(0, 64), callback_data: data });
      else onDrop(data);
    }
    if (r.length) rows.push(r);
  }
  return { inline_keyboard: rows };
}

function normTicker(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim().replace(/^\$/, '').toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}

function stripHtml(s) {
  return String(s).replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/** Authorization levels from the fresh telegram config. */
function authorize(cfg, chat, from) {
  const chatId = chat && chat.id != null ? String(chat.id) : null;
  const userId = from && from.id != null ? String(from.id) : null;
  const chats = (cfg.authorizedChatIds || []).map(String);
  const users = (cfg.authorizedUserIds || []).map(String);
  const isPrivate = chat && chat.type === 'private';
  const canRead = !!chatId && (chats.includes(chatId) || (isPrivate && !!userId && users.includes(userId)));
  let canWrite = false;
  if (canRead && userId) {
    if (users.length) canWrite = users.includes(userId);
    else canWrite = !!isPrivate && chats.includes(chatId) && chatId === userId;
  }
  return { canRead, canWrite };
}

// ------------------------------------------------------------------ sensitive actions
const AI_STATE_TEXT = (st) => `حالة الذكاء الاصطناعي الآن: «${label('aiState', st && st.aiState)}»`;
const hasSym = (st, s) => !!(st && Array.isArray(st.symbols) && st.symbols.some((x) => x && x.symbol === s));
const AI_MODES = ['DEEPSEEK', 'GEMINI', 'AUTO', 'DUAL'];
const AI_MODE_BODY = {
  DEEPSEEK: ['سيُستخدم DeepSeek وحده لتحليل الأسهم المراقبة.'],
  GEMINI: ['سيُستخدم Gemini وحده لتحليل الأسهم المراقبة.'],
  AUTO: ['سيختار النظام المزود المتاح تلقائيًا، مع التحويل إلى المزود الآخر عند الأخطاء إن كان ذلك مفعّلًا.'],
  DUAL: ['سيحلل النموذجان (DeepSeek وGemini) القرارات معًا؛ وعند اختلافهما لا تُنفذ أي صفقة.', '💰 قد ترتفع تكلفة الاستهلاك لأن كل تحليل قد يستخدم نموذجين.'],
};
const monState = (st) => (st && st.operating && st.operating.monitoring ? st.operating.monitoring.state : null);
const MON_STATE_TEXT = (st) => `حالة مراقبة السوق الآن: «${label('monitoringState', monState(st))}»`;

const ACTIONS = {
  PAUSE_AI: {
    method: 'pauseAi', args: () => [], title: () => '⏸️ إيقاف الذكاء الاصطناعي مؤقتًا',
    body: () => [
      'سيتوقف الذكاء الاصطناعي عن تحليل الأسهم واقتراح صفقات جديدة.',
      '🛡️ أوامر الحماية للمراكز المفتوحة (وقف الخسارة وجني الأرباح) تبقى فعّالة.',
      'يمكنك الاستئناف لاحقًا عبر /resumeai.',
    ],
    verify: async (ctx, p, st) => ({ ok: st && st.aiState === 'PAUSED', text: AI_STATE_TEXT(st) }),
  },
  RESUME_AI: {
    method: 'resumeAi', args: () => [], title: () => '▶️ استئناف الذكاء الاصطناعي',
    body: () => ['سيستأنف الذكاء الاصطناعي تحليل الأسهم المراقبة وفق حدود المخاطر الحالية.', '🧪 جميع الصفقات ورقية فقط.'],
    verify: async (ctx, p, st) => ({ ok: st && st.aiState === 'RUNNING', text: AI_STATE_TEXT(st) }),
  },
  STOP_AI: {
    method: 'stopAi', args: () => [], title: () => '⏹️ إيقاف الذكاء الاصطناعي',
    body: () => ['سيتم إيقاف الذكاء الاصطناعي، ولن يتم تحليل أي سهم أو اقتراح صفقات جديدة حتى تعيد تشغيله عبر /resumeai.'],
    verify: async (ctx, p, st) => ({ ok: st && st.aiState === 'STOPPED', text: AI_STATE_TEXT(st) }),
  },
  SET_RISK: {
    method: 'setRiskProfile', args: (p) => [p.profile], title: (p) => `⚠️ تغيير مستوى المخاطرة إلى «${label('profile', p.profile)}»`,
    body: () => [],
    verify: async (ctx, p) => {
      const r = await ctx.svc('risk');
      return { ok: !!r && r.profile === p.profile, text: `مستوى المخاطرة الآن: «${label('profile', r && r.profile)}»` };
    },
  },
  ADD_SYMBOL: {
    method: 'addSymbol', args: (p) => [p.symbol], title: (p) => `➕ إضافة ${esc(p.symbol)} إلى قائمة المراقبة`,
    body: () => ['سيبدأ النظام بمتابعة بيانات السهم وتحليله وفق الإعدادات الحالية (تداول ورقي فقط).'],
    verify: async (ctx, p, st) => ({ ok: hasSym(st, p.symbol), text: hasSym(st, p.symbol) ? `${esc(p.symbol)} ضمن الأسهم المراقبة الآن.` : `${esc(p.symbol)} لا يظهر ضمن الأسهم المراقبة حتى الآن.` }),
  },
  REMOVE_SYMBOL: {
    method: 'removeSymbol', args: (p) => [p.symbol], title: (p) => `➖ إزالة ${esc(p.symbol)} من قائمة المراقبة`,
    body: () => ['لا يمكن إزالة السهم إذا كان لديه مركز مفتوح أو أمر معلق.'],
    verify: async (ctx, p, st) => ({ ok: !hasSym(st, p.symbol), text: hasSym(st, p.symbol) ? `${esc(p.symbol)} ما زال ضمن الأسهم المراقبة.` : `${esc(p.symbol)} لم يعد ضمن الأسهم المراقبة.` }),
  },
  PAUSE_SYMBOL: {
    method: 'pauseSymbol', args: (p) => [p.symbol], title: (p) => `⏸️ إيقاف مراقبة ${esc(p.symbol)} مؤقتًا`,
    body: () => ['لن يتم تحليل السهم أو اقتراح صفقات جديدة عليه حتى تستأنف المراقبة.'],
    verify: async (ctx, p) => {
      const wl = (await ctx.svc('watchlist')) || [];
      const w = wl.find((x) => x.symbol === p.symbol);
      return { ok: !!w && w.status === 'PAUSED', text: `حالة مراقبة ${esc(p.symbol)}: ${w ? label('symStatus', w.status) : NA}` };
    },
  },
  RESUME_SYMBOL: {
    method: 'resumeSymbol', args: (p) => [p.symbol], title: (p) => `▶️ استئناف مراقبة ${esc(p.symbol)}`,
    body: () => ['سيعود النظام إلى متابعة السهم وتحليله.'],
    verify: async (ctx, p) => {
      const wl = (await ctx.svc('watchlist')) || [];
      const w = wl.find((x) => x.symbol === p.symbol);
      return { ok: !!w && w.status === 'ACTIVE', text: `حالة مراقبة ${esc(p.symbol)}: ${w ? label('symStatus', w.status) : NA}` };
    },
  },
  SET_AI_MODE: {
    method: 'setAiMode', args: (p) => [p.mode, 'telegram'], title: (p) => `🤖 تغيير وضع الذكاء الاصطناعي إلى «${label('aiProviderMode', p.mode)}»`,
    valid: (p) => !!p && AI_MODES.includes(p.mode),
    body: (p) => [
      ...(AI_MODE_BODY[p.mode] || []),
      '🛡️ حدود المخاطر وأوامر الحماية للمراكز المفتوحة لا تتغير.',
      '🧪 جميع الصفقات ورقية فقط.',
    ],
    verify: async (ctx, p, st) => ({ ok: !!st && st.aiMode === p.mode, text: `وضع الذكاء الاصطناعي الآن: «${label('aiProviderMode', st && st.aiMode)}»` }),
  },
  PAUSE_MONITORING: {
    method: 'pauseMonitoring', args: () => ['telegram'], title: () => '⏸ إيقاف مراقبة السوق مؤقتًا',
    body: () => [
      'سيتوقف تحليل الذكاء الاصطناعي وتنبيهات السوق لجميع الأسهم المراقبة، ولن تُقترح صفقات جديدة.',
      '🛡️ بيانات السوق للمراكز المفتوحة وأوامر الحماية (وقف الخسارة وجني الأرباح) تبقى فعّالة.',
      'يمكنك الاستئناف لاحقًا من شاشة الحالة /status.',
    ],
    verify: async (ctx, p, st) => ({ ok: monState(st) === 'PAUSED', text: MON_STATE_TEXT(st) }),
  },
  RESUME_MONITORING: {
    method: 'resumeMonitoring', args: () => ['telegram'], title: () => '▶️ استئناف مراقبة السوق',
    body: () => ['سيعود النظام إلى مراقبة الأسهم وتحليلها وفق حدود المخاطر الحالية.', '🧪 جميع الصفقات ورقية فقط.'],
    verify: async (ctx, p, st) => ({ ok: monState(st) === 'ACTIVE', text: MON_STATE_TEXT(st) }),
  },
};
const FOLLOW_UP = {
  PAUSE_AI: 'ai', RESUME_AI: 'ai', STOP_AI: 'ai', SET_AI_MODE: 'aiMode', SET_RISK: 'risk', PAUSE_MONITORING: 'status', RESUME_MONITORING: 'status',
};

// free-text clarification button codes
const Q_PERIOD = {
  pnl: ['pnl', {}], buy: ['buys', {}], sell: ['sells', {}], tcl: ['trade_count', { outcome: 'loss' }], tcw: ['trade_count', { outcome: 'win' }],
  tca: ['trade_count', { outcome: 'all' }], bs: ['best_symbol', {}], ws: ['worst_symbol', {}], st: ['stats', {}],
};
const Q_SYM = { wys: ['why_trade', { side: 'SELL' }], wyb: ['why_trade', { side: 'BUY' }], aid: ['ai_decision', {}], stk: ['stock', {}] };
function qPeriodCode(intent, params) {
  for (const [c, [i, p]] of Object.entries(Q_PERIOD)) if (i === intent && (!p.outcome || p.outcome === params.outcome)) return c;
  return null;
}
function qSymCode(intent, params) {
  for (const [c, [i, p]] of Object.entries(Q_SYM)) if (i === intent && (!p.side || p.side === params.side)) return c;
  return null;
}

function createBot({ tgStore, api, service, getConfig, now, log, redact, getQueueStatus }) {
  const conv = new Map(); // chatId -> { purpose, userId, expiresAt, intent?, params? }
  const unauthReplies = new Map(); // chatId -> last reply ts
  let botUsername = null;

  const tgCfg = () => (((getConfig && getConfig()) || {}).telegram) || {};

  async function svc(name, ...args) {
    const fn = service && service[name];
    if (typeof fn !== 'function') throw new Error(`service method unavailable: ${name}`);
    return await fn.apply(service, args);
  }

  /** Screens (which always carry the home button) are edited in place; notifications/reports are left intact. */
  function isScreenMessage(m) {
    const kb = m && m.reply_markup && m.reply_markup.inline_keyboard;
    return Array.isArray(kb) && kb.some((row) => Array.isArray(row) && row.some((b) => b && b.callback_data === 'm'));
  }

  function makeCtx({ chat, from, messageId = null, cq = null }) {
    const cfg = tgCfg();
    const tz = F.safeTz((cfg.reports && cfg.reports.timezone) || F.DEFAULT_TZ);
    return {
      chat, chatId: String(chat.id), chatType: chat.type, from, userId: from && from.id != null ? String(from.id) : null,
      messageId, isCallback: !!cq, editable: !!cq && isScreenMessage(cq.message), cq, answered: false, cfg, tz, auth: authorize(cfg, chat, from),
      svc, redact, isTicker: (s) => typeof s === 'string' && TICKER_RE.test(s),
    };
  }

  function audit(ctx, action, params, result) {
    try { tgStore.audit({ ts: now(), userId: ctx.userId, chatId: ctx.chatId, action, params, result }); } catch (e) { log('warn', `telegram: audit failed: ${redact(e.message)}`); }
  }

  // ---------------------------------------------------------------- output
  async function answer(ctx, text, alert = false) {
    if (!ctx.cq || ctx.answered) return;
    ctx.answered = true;
    try {
      await api.call('answerCallbackQuery', { callback_query_id: ctx.cq.id, ...(text ? { text: String(text).slice(0, 190), show_alert: !!alert } : {}) });
    } catch (e) { log('warn', `telegram: answerCallbackQuery failed: ${redact(e.message)}`); }
  }

  async function show(ctx, screen, { forceNew = false } = {}) {
    const text = F.fit(screen.text);
    const reply_markup = toInlineKeyboard(screen.keyboard, (d) => log('warn', `telegram: dropped non-whitelisted button data "${String(d).slice(0, 70)}"`));
    const base = { chat_id: ctx.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup };
    if (ctx.isCallback && ctx.editable && ctx.messageId != null && !forceNew) {
      try {
        await api.call('editMessageText', { ...base, message_id: ctx.messageId });
        return;
      } catch (e) {
        if (/not modified/i.test(e.message || '')) return;
        if (/parse entities/i.test(e.message || '')) {
          try { await api.call('editMessageText', { chat_id: ctx.chatId, message_id: ctx.messageId, text: F.fit(stripHtml(text)), reply_markup }); return; } catch { /* fall through */ }
        }
      }
    }
    try {
      await api.call('sendMessage', base);
    } catch (e) {
      if (/parse entities/i.test(e.message || '')) { await api.call('sendMessage', { chat_id: ctx.chatId, text: F.fit(stripHtml(text)), reply_markup }); return; }
      throw e;
    }
  }

  async function screen(ctx, fn) {
    try {
      const s = await fn();
      await show(ctx, s);
    } catch (e) {
      log('warn', `telegram: screen error: ${redact(e && e.message)}`);
      try {
        await show(ctx, { text: '⚠️ تعذر جلب البيانات حاليًا. حاول مرة أخرى بعد قليل.', keyboard: [S.HOME] });
      } catch (e2) { log('warn', `telegram: send failed: ${redact(e2 && e2.message)}`); }
    }
  }

  // ---------------------------------------------------------------- authorization
  async function denyUnauthorized(ctx, kind, params) {
    audit(ctx, 'UNAUTHORIZED', { kind, ...params }, 'DENIED');
    log('info', `telegram: unauthorized ${kind} from chat ${ctx.chatId} user ${ctx.userId}`);
    if (ctx.isCallback) { await answer(ctx, UNAUTH_TEXT, true); return; }
    const t = now();
    const last = unauthReplies.get(ctx.chatId);
    if (last != null && t - last < UNAUTH_REPLY_INTERVAL_MS) return;
    if (unauthReplies.size > 5000) unauthReplies.clear();
    unauthReplies.set(ctx.chatId, t);
    try { await api.call('sendMessage', { chat_id: ctx.chatId, text: UNAUTH_TEXT }); } catch (e) { log('warn', `telegram: send failed: ${redact(e.message)}`); }
  }

  async function denyControl(ctx, action, params) {
    audit(ctx, action, params, 'DENIED_NO_CONTROL_PERMISSION');
    if (ctx.isCallback) { await answer(ctx, NO_CONTROL_TEXT, true); return; }
    await show(ctx, { text: NO_CONTROL_TEXT, keyboard: [S.HOME] });
  }

  // ---------------------------------------------------------------- confirmation flow
  async function requestConfirm(ctx, action, params = {}) {
    const def = ACTIONS[action];
    if (!def) return;
    if (!ctx.auth.canWrite) return denyControl(ctx, action, params);
    if (def.valid && !def.valid(params)) { await answer(ctx, INVALID_TEXT); return; }
    let body = def.body(params);
    if (action === 'SET_RISK') {
      try {
        const pv = await svc('previewRiskProfile', params.profile);
        body = riskPreviewLines(pv);
      } catch (e) {
        log('warn', `telegram: previewRiskProfile failed: ${redact(e.message)}`);
        body = ['تعذر عرض معاينة أثر التغيير حاليًا.', 'لن يتم إغلاق أي مركز تلقائيًا.'];
      }
    }
    try { tgStore.pruneNonces(now()); } catch { /* housekeeping only */ }
    const nonce = crypto.randomBytes(12).toString('base64url');
    tgStore.createNonce({ nonce, userId: ctx.userId, chatId: ctx.chatId, action, params, now: now(), ttlMs: NONCE_TTL_MS });
    audit(ctx, action, params, 'CONFIRM_REQUESTED');
    const text = [
      '🔐 <b>تأكيد العملية</b>', '',
      `العملية المطلوبة: <b>${def.title(params)}</b>`,
      ...body.map((l) => (l ? l : '')), '',
      '⏱️ صلاحية طلب التأكيد دقيقتان.',
      'اضغط «تأكيد» للمتابعة أو «إلغاء» للتراجع.',
    ].join('\n');
    await show(ctx, { text, keyboard: [[['✅ تأكيد', `y:${nonce}`], ['❌ إلغاء', `x:${nonce}`]], S.HOME] });
  }

  function riskPreviewLines(pv) {
    const lines = [];
    if (pv && pv.limits) { lines.push(''); lines.push('<b>الحدود الجديدة</b>'); lines.push(...S.limitsLines(pv.limits)); }
    const findings = (pv && pv.findings) || [];
    if (findings.length) {
      lines.push('');
      lines.push('<b>الأثر على المراكز الحالية</b>');
      for (const f of findings) lines.push(`${f.ok ? '✅' : '⚠️'} ${esc(f.text)}`);
    }
    const red = (pv && pv.reduceSuggestions) || [];
    if (red.length) {
      lines.push('');
      lines.push('<b>تقليل مقترح (اختياري — لن يُنفذ تلقائيًا)</b>');
      for (const r of red) lines.push(`• ${esc(r.symbol)}: الكمية المقترحة للتقليل ${F.qty(r.qty)}`);
    }
    lines.push('');
    lines.push('ℹ️ لن يتم إغلاق أي مركز تلقائيًا؛ الحدود الجديدة تُطبق على القرارات القادمة.');
    return lines;
  }

  async function handleConfirm(ctx, nonce) {
    const row = tgStore.getNonce(nonce);
    if (!row || row.chat_id !== ctx.chatId) { await answer(ctx, INVALID_TEXT); return; }
    if (!ctx.auth.canWrite) { await denyControl(ctx, row.action, row.params); return; }
    if (row.user_id !== ctx.userId) {
      audit(ctx, row.action, row.params, 'DENIED_OTHER_USER_NONCE');
      await answer(ctx, '⛔ هذا التأكيد خاص بالمستخدم الذي طلب العملية.', true);
      return;
    }
    const t = now();
    if (!tgStore.consumeNonce(nonce, t)) {
      const fresh = tgStore.getNonce(nonce);
      if (fresh && fresh.used_at != null) {
        audit(ctx, row.action, row.params, 'ALREADY_HANDLED');
        await answer(ctx, 'ℹ️ تمت معالجة هذا الطلب مسبقًا.', true);
        return;
      }
      audit(ctx, row.action, row.params, 'EXPIRED');
      await answer(ctx, '⌛ انتهت صلاحية طلب التأكيد.', true);
      await show(ctx, { text: '⌛ انتهت صلاحية طلب التأكيد (دقيقتان)، ولم يتم تنفيذ أي إجراء.\nأعد طلب العملية إذا كنت ما زلت ترغب بها.', keyboard: [S.HOME] });
      return;
    }
    await answer(ctx, '⏳ جارٍ التنفيذ…');
    const def = ACTIONS[row.action];
    if (!def || (def.valid && !def.valid(row.params))) { audit(ctx, row.action, row.params, 'INVALID'); await show(ctx, { text: INVALID_TEXT, keyboard: [S.HOME] }); return; }
    let result = null;
    let error = null;
    try { result = await svc(def.method, ...def.args(row.params)); } catch (e) { error = e; }
    const ok = !error && !!result && result.ok !== false;
    let verification = null;
    try {
      const st = await svc('status');
      verification = await def.verify(ctx, row.params, st);
    } catch (e) {
      verification = { ok: false, text: 'تعذر التحقق من الحالة بعد التنفيذ.' };
    }
    const lines = [];
    if (ok) {
      lines.push(`✅ <b>تمت العملية: ${def.title(row.params)}</b>`);
      if (result.message) lines.push(esc(F.clip(redact(result.message), 600)));
      if (verification) lines.push(verification.ok ? `✔️ تم التحقق: ${verification.text}` : `⚠️ لم يتم تأكيد التغيير بعد: ${verification.text}`);
    } else {
      const msg = error ? redact(error.message || String(error)) : redact((result && result.message) || 'رفضت المنصة الطلب.');
      lines.push(`❌ <b>تعذر تنفيذ العملية: ${def.title(row.params)}</b>`);
      lines.push(esc(F.clip(msg, 600)));
      if (verification) lines.push(`ℹ️ ${verification.text}`);
    }
    lines.push('');
    lines.push(S.PAPER_NOTE);
    const msgForAudit = ok ? `OK${verification && !verification.ok ? ' (UNVERIFIED)' : ''}` : `FAILED: ${error ? (error.message || String(error)) : ((result && result.message) || 'not ok')}`;
    audit(ctx, row.action, row.params, msgForAudit);
    const follow = {
      ai: [['📡 الحالة', 'sts'], ['🤖 الذكاء الاصطناعي', 'ai']],
      aiMode: [['🤖 الذكاء الاصطناعي', 'ai'], ['📊 الاستهلاك', 'ai:u']],
      risk: [['⚠️ إدارة المخاطر', 'rk']],
      status: [['📡 حالة النظام', 'sts']],
    }[FOLLOW_UP[row.action]] || [['📈 الأسهم المراقبة', 'w']];
    await show(ctx, { text: lines.join('\n'), keyboard: [follow, S.HOME] });
  }

  async function handleCancel(ctx, nonce) {
    const row = tgStore.getNonce(nonce);
    if (!row || row.chat_id !== ctx.chatId) { await answer(ctx, INVALID_TEXT); return; }
    if (row.user_id !== ctx.userId && !ctx.auth.canWrite) { await answer(ctx, NO_CONTROL_TEXT, true); return; }
    if (tgStore.consumeNonce(nonce, now())) {
      audit(ctx, row.action, row.params, 'CANCELLED');
      await answer(ctx, 'تم الإلغاء');
      await show(ctx, { text: '❌ تم إلغاء العملية، ولم يتم تنفيذ أي تغيير.', keyboard: [S.HOME] });
      return;
    }
    const fresh = tgStore.getNonce(nonce);
    if (fresh && fresh.used_at != null) { await answer(ctx, 'ℹ️ تمت معالجة هذا الطلب مسبقًا.', true); return; }
    await answer(ctx, '⌛ انتهت صلاحية الطلب.', true);
    await show(ctx, { text: '⌛ انتهت صلاحية طلب التأكيد، ولم يتم تنفيذ أي إجراء.', keyboard: [S.HOME] });
  }

  // ---------------------------------------------------------------- conversation state (ticker prompts)
  function setConv(ctx, state) {
    if (conv.size > 2000) conv.clear();
    conv.set(ctx.chatId, { ...state, userId: ctx.userId, expiresAt: now() + CONV_TTL_MS });
  }
  function getConv(ctx) {
    const st = conv.get(ctx.chatId);
    if (!st) return null;
    if (st.expiresAt < now()) { conv.delete(ctx.chatId); return null; }
    if (st.userId !== ctx.userId) return null;
    return st;
  }

  async function askTicker(ctx, purpose, title, { side = null, buttons = null, extra = {} } = {}) {
    setConv(ctx, { purpose, ...extra });
    if (buttons) {
      const lines = [title, '', 'أرسل رمز السهم (مثال: NVDA)' + (buttons.length ? ' أو اختر من الأزرار:' : '.')];
      return show(ctx, { text: lines.join('\n'), keyboard: [...buttons, S.HOME] });
    }
    return screen(ctx, () => S.askSymbol(ctx, { title, side, dataFn: (s) => dataForPurpose(purpose, s, extra) }));
  }

  function dataForPurpose(purpose, s, extra = {}) {
    switch (purpose) {
      case 'b': return `b:a:0:${s}`;
      case 's': return `s:a:0:${s}`;
      case 'tr': return `tr:a:a:0:${s}`;
      case 'd': return `d:a:0:${s}`;
      case 'stock': return `sk:${s}`;
      case 'add': case 'rm': case 'pa': case 're': return `wa:${purpose}:${s}`;
      case 'intent': { const c = qSymCode(extra.intent, extra.params || {}); return c ? `q:${c}:${s}` : `sk:${s}`; }
      default: return `sk:${s}`;
    }
  }

  async function watchSymbolPicker(ctx, op) {
    if (!ctx.auth.canWrite && op !== 'det') return denyControl(ctx, { add: 'ADD_SYMBOL', rm: 'REMOVE_SYMBOL', pa: 'PAUSE_SYMBOL', re: 'RESUME_SYMBOL' }[op], {});
    if (op === 'add') return askTicker(ctx, 'add', '➕ <b>إضافة سهم إلى المراقبة</b>', { buttons: [] });
    let wl = [];
    try { wl = (await svc('watchlist')) || []; } catch { wl = []; }
    let list = wl;
    if (op === 'pa') list = wl.filter((w) => w.status !== 'PAUSED');
    if (op === 're') list = wl.filter((w) => w.status === 'PAUSED');
    const syms = list.map((w) => w.symbol).filter((s) => TICKER_RE.test(String(s || ''))).slice(0, 12);
    const purpose = op === 'det' ? 'stock' : op;
    const titles = { rm: '➖ <b>إزالة سهم من المراقبة</b>', pa: '⏸️ <b>إيقاف مراقبة سهم</b>', re: '▶️ <b>استئناف مراقبة سهم</b>', det: '🔎 <b>تفاصيل سهم</b>' };
    return askTicker(ctx, purpose, titles[op], { buttons: S.symbolButtons(syms, (s) => dataForPurpose(purpose, s)) });
  }

  async function handleConvInput(ctx, st, text) {
    const t = normTicker(text);
    if (!t) {
      if (/[؀-ۿ]/.test(text)) { conv.delete(ctx.chatId); return handleFreeText(ctx, text); }
      return show(ctx, { text: '⚠️ رمز السهم غير صالح. أرسل رمزًا مثل NVDA، أو اكتب /cancel للإلغاء.', keyboard: [S.HOME] });
    }
    conv.delete(ctx.chatId);
    switch (st.purpose) {
      case 'b': return screen(ctx, () => S.fillsList(ctx, { side: 'BUY', pcode: 'a', page: 0, symbol: t }));
      case 's': return screen(ctx, () => S.fillsList(ctx, { side: 'SELL', pcode: 'a', page: 0, symbol: t }));
      case 'tr': return screen(ctx, () => S.tradesList(ctx, { pcode: 'a', sideCode: 'a', page: 0, symbol: t }));
      case 'd': return screen(ctx, () => S.decisionsList(ctx, { kind: 'a', page: 0, symbol: t }));
      case 'stock': return screen(ctx, () => S.stock(ctx, t));
      case 'add': return requestConfirm(ctx, 'ADD_SYMBOL', { symbol: t });
      case 'rm': return requestConfirm(ctx, 'REMOVE_SYMBOL', { symbol: t });
      case 'pa': return requestConfirm(ctx, 'PAUSE_SYMBOL', { symbol: t });
      case 're': return requestConfirm(ctx, 'RESUME_SYMBOL', { symbol: t });
      case 'intent': return answerIntent(ctx, st.intent, { ...(st.params || {}), symbol: t });
      default: return screen(ctx, () => S.stock(ctx, t));
    }
  }

  // ---------------------------------------------------------------- free text (deterministic intents)
  async function handleFreeText(ctx, text) {
    const r = parseIntent(text, now());
    if (r.intent === 'unknown') {
      if (ctx.chatType !== 'private') return; // never spam groups with "didn't understand"
      return show(ctx, {
        text: '🤔 لم أفهم سؤالك.\nجرّب مثلًا: «كم ربحي اليوم؟» أو «اعرض آخر خمس صفقات» أو «ليش باع سهم NVDA؟».\nلعرض جميع الأوامر اكتب /help',
        keyboard: [[['❓ المساعدة', 'h']], S.HOME],
      });
    }
    if (r.intent === 'clarify') return clarify(ctx, r);
    return answerIntent(ctx, r.intent, r.params || {});
  }

  async function clarify(ctx, r) {
    const { intent, params } = r.pending || {};
    if (r.need === 'period') {
      const c = qPeriodCode(intent, params || {});
      const opts = (r.options || []).map((o) => [o.label, `q:${c}:${o.params.period}`]);
      const rows = [];
      for (let i = 0; i < opts.length; i += 2) rows.push(opts.slice(i, i + 2));
      return show(ctx, { text: `🗓️ ${esc(r.question)}`, keyboard: [...rows, S.HOME] });
    }
    return askTicker(ctx, 'intent', `🔎 ${esc(r.question)}`, { extra: { intent, params: params || {} } });
  }

  async function answerIntent(ctx, intent, params = {}) {
    const P = params;
    const run = (fn) => screen(ctx, fn);
    switch (intent) {
      case 'help': return show(ctx, S.help());
      case 'ai_usage': return run(() => (P.provider === 'deepseek' || P.provider === 'gemini' ? S.providerUsage(ctx, P.provider) : S.aiUsage(ctx)));
      case 'exposure': return run(() => exposureAnswer(ctx));
      case 'news': return P.symbol ? run(() => S.stockNews(ctx, P.symbol)) : run(() => S.news(ctx));
      case 'report': return run(() => S.report(ctx, P.kind));
      case 'why_trade': return run(() => whyTrade(ctx, P));
      case 'ai_decision': return run(() => aiDecision(ctx, P.symbol));
      case 'decisions': return run(() => S.decisionsList(ctx, { kind: { buy: 'b', sell: 's' }[P.kind] || 'a', page: 0 }));
      case 'last_trades': return run(() => lastTrades(ctx, P));
      case 'trade_count': return run(() => tradeCount(ctx, P));
      case 'best_symbol': return run(() => bestSymbol(ctx, P.period || 'all', false));
      case 'worst_symbol': return run(() => bestSymbol(ctx, P.period || 'all', true));
      case 'orders':
        if (P.status === 'OPEN' && P.side) return run(() => S.pendingOrders(ctx, P.side));
        return run(() => S.ordersList(ctx, { filter: P.status === 'OPEN' ? 'open' : 'all', page: 0 }));
      case 'buys': return run(() => S.fillsList(ctx, { side: 'BUY', pcode: S.FILL_CODE_FROM_STATS[P.period] || 'a', page: 0 }));
      case 'sells': return run(() => S.fillsList(ctx, { side: 'SELL', pcode: S.FILL_CODE_FROM_STATS[P.period] || 'a', page: 0 }));
      case 'cash': return run(() => cashAnswer(ctx));
      case 'pnl': return run(() => pnlAnswer(ctx, P.period || 'today'));
      case 'stats': return run(() => S.stats(ctx, P.period || 'today'));
      case 'positions': return run(() => S.positions(ctx));
      case 'portfolio': return run(() => S.portfolio(ctx));
      case 'risk': return run(() => S.risk(ctx));
      case 'watchlist': return run(() => S.watchlist(ctx));
      case 'ai': return run(() => S.aiScreen(ctx));
      case 'status': return run(() => S.status(ctx));
      case 'stock': return P.symbol ? run(() => S.stock(ctx, P.symbol)) : askTicker(ctx, 'stock', '🔎 <b>تفاصيل سهم</b>');
      default: return show(ctx, { text: 'لم أفهم الطلب. اكتب /help لعرض الأوامر.', keyboard: [S.HOME] });
    }
  }

  async function pnlAnswer(ctx, period) {
    let pp;
    let ins = {};
    if (period === 'today') pp = (await svc('todayPerformance')) || {};
    else { const s = (await svc('stats', { period })) || {}; pp = s.portfolio || {}; ins = s.insufficient || {}; }
    const lines = [`💰 <b>الربح/الخسارة — ${S.STATS_LABEL[period] || esc(period)}</b>`, ''];
    lines.push(`• صافي الربح/الخسارة: <b>${S.metric(ins, 'netPnl', pp.netPnl, F.signedMoney)}</b>`);
    lines.push(`• العائد: ${S.metric(ins, 'netReturnPct', pp.netReturnPct, (x) => F.pct(x))}`);
    lines.push(`• الربح المحقق: ${S.metric(ins, 'realizedPnl', pp.realizedPnl, F.signedMoney)}`);
    lines.push(`• الربح غير المحقق: ${S.metric(ins, 'unrealizedPnl', pp.unrealizedPnl, F.signedMoney)}`);
    lines.push(`• قيمة المحفظة: ${S.metric(ins, 'endEquity', pp.endEquity, F.money)}`);
    lines.push('');
    lines.push(S.PAPER_NOTE);
    return { text: lines.join('\n'), keyboard: [[['📊 الإحصائيات', `st:${S.STATS_CODE[period] || 't'}`], ['💼 المحفظة', 'pf']], S.HOME] };
  }

  async function cashAnswer(ctx) {
    const p = (await svc('portfolio')) || {};
    const lines = ['💵 <b>السيولة المتاحة</b>', ''];
    lines.push(`• السيولة المتاحة: <b>${F.money(p.cash)}</b>`);
    lines.push(`• قيمة المحفظة: ${F.money(p.equity)}`);
    lines.push(`• القيمة المستثمرة: ${F.money(p.positionValue)}`);
    lines.push(`• نسبة التعرض: ${F.pct(p.exposurePct, false)}`);
    lines.push('');
    lines.push(S.PAPER_NOTE);
    return { text: lines.join('\n'), keyboard: [[['💼 المحفظة', 'pf']], S.HOME] };
  }

  async function exposureAnswer(ctx) {
    const p = (await svc('portfolio')) || {};
    const lines = ['📊 <b>نسبة المحفظة المستثمرة</b>', ''];
    lines.push(`• نسبة التعرض (المستثمر من قيمة المحفظة): <b>${F.pct(p.exposurePct, false)}</b>`);
    lines.push(`• القيمة المستثمرة: ${F.money(p.positionValue)}`);
    lines.push(`• قيمة المحفظة: ${F.money(p.equity)}`);
    lines.push(`• السيولة المتاحة: ${F.money(p.cash)}`);
    if (F.isNum(p.reservedCash)) lines.push(`• النقد المحجوز لأوامر معلقة: ${F.money(p.reservedCash)}`);
    lines.push(`• عدد المراكز المفتوحة: ${F.int(p.positionsCount)}`);
    lines.push('');
    lines.push(S.PAPER_NOTE);
    return { text: lines.join('\n'), keyboard: [[['💼 المحفظة', 'pf'], ['📂 تفاصيل المراكز', 'pf:pos']], S.HOME] };
  }

  async function tradeCount(ctx, { period, outcome }) {
    const s = (await svc('stats', { period })) || {};
    const tr = s.trading || {};
    const ins = s.insufficient || {};
    const name = outcome === 'loss' ? 'losses' : (outcome === 'win' ? 'wins' : 'roundTrips');
    const title = { loss: 'عدد الصفقات الخاسرة', win: 'عدد الصفقات الرابحة', all: 'عدد الصفقات المكتملة' }[outcome] || 'عدد الصفقات';
    const lines = [`${outcome === 'loss' ? '📉' : '📈'} <b>${title} — ${S.STATS_LABEL[period] || esc(period)}</b>`, ''];
    lines.push(`• ${title}: <b>${S.metric(ins, name, tr[name], F.int)}</b>`);
    lines.push(`• إجمالي الصفقات المكتملة: ${S.metric(ins, 'roundTrips', tr.roundTrips, F.int)}`);
    lines.push(`• الرابحة / الخاسرة: ${S.metric(ins, 'wins', tr.wins, F.int)} / ${S.metric(ins, 'losses', tr.losses, F.int)}`);
    lines.push(`• نسبة الصفقات الرابحة: ${S.metric(ins, 'winRatePct', tr.winRatePct, (x) => F.pct(x, false))}`);
    lines.push('');
    lines.push('ℹ️ الصفقة المكتملة = عملية شراء أُغلقت ببيع.');
    return { text: lines.join('\n'), keyboard: [[['📊 الإحصائيات', `st:${S.STATS_CODE[period] || 't'}`]], S.HOME] };
  }

  async function bestSymbol(ctx, period, worst) {
    const s = (await svc('stats', { period })) || {};
    const by = (s.bySymbol || []).filter((x) => x && x.symbol && F.isNum(x.realizedPnl)).sort((a, b) => b.realizedPnl - a.realizedPnl);
    const per = S.STATS_LABEL[period] || esc(period);
    const lines = [`${worst ? '📉' : '🏆'} <b>${worst ? 'أكثر سهم خسرنا منه' : 'أكثر سهم ربحنا منه'} — ${per}</b>`, ''];
    if (!by.length) {
      lines.push('لا توجد صفقات مغلقة كافية لتحديد ذلك (بيانات غير كافية).');
    } else {
      const pick = worst ? by[by.length - 1] : by[0];
      if (!worst && pick.realizedPnl <= 0) lines.push(`لا يوجد سهم رابح بعد (لم يتحقق ربح محقق من أي سهم في هذه الفترة). أفضل نتيجة: <b>${esc(pick.symbol)}</b> ${F.signedMoney(pick.realizedPnl)}`);
      else if (worst && pick.realizedPnl >= 0) lines.push(`لم تُسجل خسارة محققة في أي سهم في هذه الفترة. أضعف نتيجة: <b>${esc(pick.symbol)}</b> ${F.signedMoney(pick.realizedPnl)}`);
      else lines.push(`<b>${esc(pick.symbol)}</b> — الربح/الخسارة المحققة: ${F.signedMoney(pick.realizedPnl)} (عدد الصفقات: ${F.int(pick.trades)})`);
      lines.push('');
      lines.push('<b>الترتيب حسب الربح المحقق</b>');
      const list = worst ? by.slice().reverse() : by;
      list.slice(0, 5).forEach((x, i) => lines.push(`${i + 1}) ${esc(x.symbol)}: ${F.signedMoney(x.realizedPnl)} (عدد الصفقات: ${F.int(x.trades)})`));
    }
    return { text: lines.join('\n'), keyboard: [[['📊 الإحصائيات', `st:${S.STATS_CODE[period] || 'a'}`]], S.HOME] };
  }

  async function whyTrade(ctx, { side, symbol }) {
    const isSell = side === 'SELL';
    const res = (await svc('fills', { side, symbol, period: 'all', limit: 1, offset: 0 })) || {};
    const f0 = (res.items || [])[0];
    if (!f0) {
      return { text: `ℹ️ لا توجد عملية ${isSell ? 'بيع' : 'شراء'} منفذة مسجلة لسهم <b>${esc(symbol)}</b>.`, keyboard: [[['📈 السهم', `sk:${symbol}`]], S.HOME] };
    }
    let f = null;
    try { f = await svc('fill', f0.id); } catch { f = null; }
    f = f || { ...f0, decision: null };
    const lines = [`❓ <b>لماذا ${isSell ? 'باع' : 'اشترى'} البوت سهم ${esc(symbol)}؟</b>`, ''];
    lines.push(`آخر عملية ${isSell ? 'بيع' : 'شراء'} منفذة: ${F.dateTime(f.ts, ctx.tz)}`);
    lines.push(`• الكمية: ${F.qty(f.qty)} بسعر ${F.price(f.price)}`);
    if (isSell) {
      lines.push(`• متوسط سعر الشراء: ${F.price(f.costBasisPrice)}`);
      lines.push(`• الربح المحقق: ${F.signedMoney(f.realizedPnl)} (${F.pct(f.returnPct)})`);
    }
    lines.push(`• المحفز: ${label('source', f.kind)}`);
    if (['STOP', 'TAKE_PROFIT', 'TRAILING_STOP'].includes(f.kind)) lines.push('  (نُفذ تلقائيًا بواسطة أمر حماية مسجل مسبقًا)');
    if (f.reason) lines.push(`• السبب المسجل: ${esc(F.clip(f.reason, 400))}`);
    lines.push('');
    lines.push(...S.decisionBlock(f.decision));
    lines.push('');
    lines.push(`🕒 ${F.tzLabel(ctx.tz)}`);
    const kb = [];
    if (f.id != null && /^[A-Za-z0-9_.-]{1,48}$/.test(String(f.id))) kb.push(['🔎 تفاصيل الصفقة', `td:${f.id}`]);
    kb.push(['📈 السهم', `sk:${symbol}`]);
    return { text: lines.join('\n'), keyboard: [kb, S.HOME] };
  }

  async function aiDecision(ctx, symbol) {
    const res = (await svc('decisions', { symbol, kind: 'all', limit: 1, offset: 0 })) || {};
    const d = (res.items || [])[0];
    if (!d) return { text: `ℹ️ لا يوجد قرار مسجل للذكاء الاصطناعي على سهم <b>${esc(symbol)}</b>.`, keyboard: [[['📈 السهم', `sk:${symbol}`]], S.HOME] };
    // the provider recorded on the decision itself; older rows without it fall back to the current provider label
    let prov = d.provider ? F.providerLabel(d.provider) : null;
    if (!prov) { try { const a = await svc('ai'); prov = a && a.provider ? esc(a.provider) : null; } catch { prov = null; } }
    const lines = [`🤖 <b>آخر قرار مسجل على ${esc(symbol)}${prov ? ` (${prov})` : ''}</b>`, ''];
    lines.push(`• الوقت: ${F.dateTime(d.ts, ctx.tz)} (${F.tzLabel(ctx.tz)})`);
    lines.push(`• القرار: من «${label('action', d.previousAction)}» إلى «${label('action', d.action)}»`);
    if (d.model) lines.push(`• النموذج: ${esc(d.model)}`);
    if (d.changeReason) lines.push(`• سبب التغيير: ${esc(F.clip(d.changeReason, 400))}`);
    lines.push(...S.dualLines(d.dual, '• ').map((l, i) => (i === 0 ? l : `  ${l.trim()}`)));
    lines.push(`• النتيجة: ${S.decisionStatus(d)}`);
    lines.push(`• المبررات المسجلة: ${d.rationale ? esc(F.clip(d.rationale, 1200)) : NA}`);
    const ev = (d.evidence || []).slice(0, 5);
    if (ev.length) { lines.push('• الأدلة:'); for (const e of ev) lines.push(`  ◦ ${esc(F.clip(e, 220))}`); }
    lines.push(`• رقم القرار: <code>${esc(d.id)}</code>`);
    lines.push('');
    lines.push('ℹ️ هذا هو النص المسجل وقت القرار؛ لم يتم طلب تحليل جديد.');
    return { text: lines.join('\n'), keyboard: [[['🗂️ قرارات السهم', `d:a:0:${symbol}`], ['📈 السهم', `sk:${symbol}`]], S.HOME] };
  }

  async function lastTrades(ctx, { count = 5, side = null, symbol = null }) {
    const res = (await svc('fills', { side: side || null, symbol: symbol || null, period: 'all', limit: count, offset: 0 })) || {};
    const items = (res.items || []).slice(0, count);
    const lines = [`📋 <b>آخر ${F.int(count)} صفقات منفذة</b>${symbol ? ` — ${esc(symbol)}` : ''}`, ''];
    if (!items.length) lines.push('لا توجد صفقات منفذة بعد.');
    items.forEach((f, i) => { lines.push(...S.fillLines(f, i + 1, ctx.tz, { detailed: true })); lines.push(''); });
    lines.push(`🕒 الأوقات ${F.tzLabel(ctx.tz)}`);
    lines.push(S.PAPER_NOTE);
    return { text: lines.join('\n'), keyboard: [[['📋 سجل الصفقات', 'tr:a:a:0']], S.HOME] };
  }

  // ---------------------------------------------------------------- commands
  async function runCommand(ctx, cmd, arg) {
    const tick = () => normTicker(arg.split(/\s+/)[0] || '');
    switch (cmd) {
      case 'start': case 'menu': return show(ctx, S.mainMenu());
      case 'help': return show(ctx, S.help());
      case 'portfolio': return screen(ctx, () => S.portfolio(ctx));
      case 'positions': return screen(ctx, () => S.positions(ctx));
      case 'buys': return screen(ctx, () => S.fillsList(ctx, { side: 'BUY', pcode: 'a', page: 0 }));
      case 'sells': return screen(ctx, () => S.fillsList(ctx, { side: 'SELL', pcode: 'a', page: 0 }));
      case 'orders': return screen(ctx, () => S.ordersList(ctx, { filter: 'all', page: 0 }));
      case 'trades': return screen(ctx, () => S.tradesList(ctx, { pcode: 'a', sideCode: 'a', page: 0 }));
      case 'stats': return screen(ctx, () => S.stats(ctx, 'today'));
      case 'daily': return screen(ctx, () => S.report(ctx, 'daily'));
      case 'weekly': return screen(ctx, () => S.report(ctx, 'weekly'));
      case 'monthly': return screen(ctx, () => S.report(ctx, 'monthly'));
      case 'stock': {
        const t = tick();
        if (t) return screen(ctx, () => S.stock(ctx, t));
        if (arg) return show(ctx, { text: '⚠️ رمز السهم غير صالح. مثال: /stock NVDA', keyboard: [S.HOME] });
        return askTicker(ctx, 'stock', '🔎 <b>تفاصيل سهم</b>');
      }
      case 'watchlist': return screen(ctx, () => S.watchlist(ctx));
      case 'news': return screen(ctx, () => S.news(ctx));
      case 'addstock': case 'removestock': case 'pause': case 'resume': {
        const op = { addstock: 'add', removestock: 'rm', pause: 'pa', resume: 're' }[cmd];
        const action = { add: 'ADD_SYMBOL', rm: 'REMOVE_SYMBOL', pa: 'PAUSE_SYMBOL', re: 'RESUME_SYMBOL' }[op];
        if (!ctx.auth.canWrite) return denyControl(ctx, action, { symbol: arg.slice(0, 12) || null });
        const t = tick();
        if (t) return requestConfirm(ctx, action, { symbol: t });
        if (arg) return show(ctx, { text: `⚠️ رمز السهم غير صالح. مثال: /${cmd} NVDA`, keyboard: [S.HOME] });
        return watchSymbolPicker(ctx, op);
      }
      case 'ai': return screen(ctx, () => S.aiScreen(ctx));
      case 'decisions': return screen(ctx, () => S.decisionsList(ctx, { kind: 'a', page: 0 }));
      case 'risk': return screen(ctx, () => S.risk(ctx));
      case 'status': return screen(ctx, () => S.status(ctx));
      case 'monitoring': return screen(ctx, () => S.monitoring(ctx));
      case 'pauseai': return requestConfirm(ctx, 'PAUSE_AI', {});
      case 'resumeai': return requestConfirm(ctx, 'RESUME_AI', {});
      case 'stopai': return requestConfirm(ctx, 'STOP_AI', {});
      case 'notifications': return show(ctx, S.notifications(ctx, safeQueueStatus()));
      case 'settings': return show(ctx, S.settings(ctx));
      case 'cancel': conv.delete(ctx.chatId); return show(ctx, { text: 'تم الإلغاء.', keyboard: [S.HOME] });
      default:
        if (ctx.chatType !== 'private') return;
        return show(ctx, { text: 'أمر غير معروف. اكتب /help لعرض الأوامر المتاحة.', keyboard: [S.HOME] });
    }
  }

  function safeQueueStatus() { try { return getQueueStatus ? getQueueStatus() : null; } catch { return null; } }

  // ---------------------------------------------------------------- callback routing
  async function routeCallback(ctx, { route, m }) {
    const run = (fn) => screen(ctx, fn);
    switch (route) {
      case 'menu': return show(ctx, S.mainMenu());
      case 'help': return show(ctx, S.help());
      case 'noop': return answer(ctx);
      case 'pf': return run(() => (m[1] === 'pos' ? S.positions(ctx) : (m[1] === 'td' ? S.todayPerf(ctx) : S.portfolio(ctx))));
      case 'fills': return run(() => S.fillsList(ctx, { side: m[1] === 's' ? 'SELL' : 'BUY', pcode: m[2], page: Number(m[3]), symbol: m[4] || null }));
      case 'fillsx':
        if (m[2] === 'pend') return run(() => S.pendingOrders(ctx, m[1] === 's' ? 'SELL' : 'BUY'));
        return askTicker(ctx, m[1], m[1] === 's' ? '🔴 <b>عمليات البيع حسب السهم</b>' : '🟢 <b>عمليات الشراء حسب السهم</b>', { side: m[1] === 's' ? 'SELL' : 'BUY' });
      case 'orders': return run(() => S.ordersList(ctx, { filter: m[1], page: Number(m[2]) }));
      case 'trades': return run(() => S.tradesList(ctx, { pcode: m[1], sideCode: m[2], page: Number(m[3]), symbol: m[4] || null }));
      case 'tradesSym': return askTicker(ctx, 'tr', '📋 <b>سجل الصفقات حسب السهم</b>');
      case 'td': return run(() => S.tradeDetails(ctx, m[1]));
      case 'stats': return run(() => S.stats(ctx, S.STATS_PERIODS[m[1]]));
      case 'report': return run(() => S.report(ctx, { d: 'daily', w: 'weekly', m: 'monthly' }[m[1]]));
      case 'stock': {
        const sym = m[1];
        if (m[2] === 'f') return run(() => S.stockAnalysis(ctx, sym));
        if (m[2] === 'd') return run(() => S.decisionsList(ctx, { kind: 'a', page: 0, symbol: sym }));
        if (m[2] === 't') return run(() => S.tradesList(ctx, { pcode: 'a', sideCode: 'a', page: 0, symbol: sym }));
        if (m[2] === 'n') return run(() => S.stockNews(ctx, sym));
        return run(() => S.stock(ctx, sym));
      }
      case 'watch':
        if (!m[1]) return run(() => S.watchlist(ctx));
        return watchSymbolPicker(ctx, m[1]);
      case 'watchAct': {
        const action = { add: 'ADD_SYMBOL', rm: 'REMOVE_SYMBOL', pa: 'PAUSE_SYMBOL', re: 'RESUME_SYMBOL' }[m[1]];
        return requestConfirm(ctx, action, { symbol: m[2] });
      }
      case 'ai':
        if (m[1] === 'ds' || m[1] === 'gm') return run(() => S.providerUsage(ctx, m[1] === 'ds' ? 'deepseek' : 'gemini'));
        return run(() => (m[1] === 'u' ? S.aiUsage(ctx) : S.aiScreen(ctx)));
      case 'aiMode': return requestConfirm(ctx, 'SET_AI_MODE', { mode: m[1] });
      case 'mon': return requestConfirm(ctx, m[1] === 'pause' ? 'PAUSE_MONITORING' : 'RESUME_MONITORING', {});
      case 'news': return run(() => S.news(ctx));
      case 'decisions': return run(() => S.decisionsList(ctx, { kind: m[1], page: Number(m[2]), symbol: m[3] || null }));
      case 'decisionsSym': return askTicker(ctx, 'd', '🤖 <b>قرارات الذكاء الاصطناعي حسب السهم</b>');
      case 'risk': return run(() => (m[1] === 'd' ? S.riskDetails(ctx) : S.risk(ctx)));
      case 'riskProfile': return requestConfirm(ctx, 'SET_RISK', { profile: m[1] });
      case 'status': return run(() => S.status(ctx));
      case 'monitor': return run(() => S.monitoring(ctx));
      case 'ctl': return requestConfirm(ctx, { pause: 'PAUSE_AI', resume: 'RESUME_AI', stop: 'STOP_AI' }[m[1]], {});
      case 'notif': return show(ctx, S.notifications(ctx, safeQueueStatus()));
      case 'settings': return show(ctx, S.settings(ctx));
      case 'confirm': return handleConfirm(ctx, m[1]);
      case 'cancel': return handleCancel(ctx, m[1]);
      case 'qPeriod': { const [intent, extra] = Q_PERIOD[m[1]]; return answerIntent(ctx, intent, { ...extra, period: m[2] }); }
      case 'qSym': { conv.delete(ctx.chatId); const [intent, extra] = Q_SYM[m[1]]; return answerIntent(ctx, intent, { ...extra, symbol: m[2] }); }
      default: return answer(ctx, INVALID_TEXT);
    }
  }

  // ---------------------------------------------------------------- entry points
  async function onMessage(msg) {
    if (!msg || !msg.chat || msg.chat.id == null) return;
    if (msg.from && msg.from.is_bot) return;
    const text = typeof msg.text === 'string' ? msg.text.trim() : '';
    if (!text) return;
    const ctx = makeCtx({ chat: msg.chat, from: msg.from });
    if (!ctx.cfg.enabled) return;
    const cm = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s+([\s\S]*))?$/.exec(text);
    if (cm && cm[2] && botUsername && cm[2].toLowerCase() !== botUsername.toLowerCase()) return; // addressed to another bot
    if (!ctx.auth.canRead) return denyUnauthorized(ctx, 'MESSAGE', { command: cm ? cm[1].slice(0, 32) : null });
    if (cm) {
      conv.delete(ctx.chatId);
      return runCommand(ctx, cm[1].toLowerCase(), (cm[3] || '').trim().slice(0, 200));
    }
    const st = getConv(ctx);
    if (st) return handleConvInput(ctx, st, text.slice(0, 500));
    return handleFreeText(ctx, text.slice(0, 500));
  }

  async function onCallback(cq) {
    if (!cq || !cq.id) return;
    const msg = cq.message;
    const chat = msg && msg.chat;
    if (!chat || chat.id == null) {
      try { await api.call('answerCallbackQuery', { callback_query_id: cq.id, text: INVALID_TEXT }); } catch { /* ignore */ }
      return;
    }
    const ctx = makeCtx({ chat, from: cq.from, messageId: msg.message_id, cq });
    try {
      if (!ctx.cfg.enabled) return;
      const parsed = parseCallbackData(cq.data);
      if (!parsed) { await answer(ctx, INVALID_TEXT); return; }
      if (!ctx.auth.canRead) { await denyUnauthorized(ctx, 'CALLBACK', { route: parsed.route }); return; }
      await routeCallback(ctx, parsed);
    } finally {
      await answer(ctx);
    }
  }

  async function handleUpdate(update) {
    try {
      if (!update || typeof update !== 'object') return;
      if (update.callback_query) return await onCallback(update.callback_query);
      if (update.message) return await onMessage(update.message);
    } catch (e) {
      log('error', `telegram: failed to handle update: ${redact(e && e.message)}`);
    }
  }

  return {
    handleUpdate,
    setBotUsername: (u) => { botUsername = u || null; },
    _conv: conv,
  };
}

module.exports = { createBot, parseCallbackData, toInlineKeyboard, authorize, normTicker, ACTIONS, CALLBACK_ROUTES, UNAUTH_TEXT, NONCE_TTL_MS };
