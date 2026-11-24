'use strict';
const { tempStore } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Store } = require('../server/db');
const { createTelegram } = require('../server/telegram');
const { parseCallbackData, CALLBACK_ROUTES } = require('../server/telegram/bot');
const { renderEvent } = require('../server/telegram/notifier');
const F = require('../server/telegram/format');

const TOKEN = '123456789:AAH-secretTokenValue_abcdefghijklmnopqrs';
const T0 = Date.UTC(2026, 10, 20, 10, 0, 0); // Fri 20 Nov 2026, 13:00 Asia/Riyadh
const PRIVATE = { id: 111, type: 'private' };
const OWNER = { id: 111, is_bot: false, first_name: 'Owner' };
const GROUP = { id: -100500, type: 'supergroup' };
const MEMBER = { id: 222, is_bot: false, first_name: 'Member' };
const STRANGER_CHAT = { id: 999, type: 'private' };
const STRANGER = { id: 999, is_bot: false, first_name: 'X' };

// ------------------------------------------------------------------ fakes
function makeConfig(over = {}) {
  return {
    telegram: {
      enabled: true,
      authorizedChatIds: ['111', '-100500'],
      authorizedUserIds: ['111'],
      notifications: { enabled: true, trades: true, ai: true, risk: true, news: true, data: true, market: true, watchlist: true, breakouts: true },
      reports: { daily: true, weekly: false, monthly: false, time: '20:00', timezone: 'Asia/Riyadh', weeklyDay: 5 },
      ...over,
    },
  };
}

function makeFetch(handler) {
  const calls = [];
  let mid = 100;
  const f = async (url, opts = {}) => {
    const method = String(url).split('/').pop();
    const params = JSON.parse(opts.body || '{}');
    calls.push({ url, method, params });
    const r = handler ? await handler(method, params, url) : undefined;
    let status = 200;
    let body;
    if (r && r.body) { body = r.body; status = r.status || (body.ok ? 200 : (body.error_code || 400)); } else {
      const defaults = { sendMessage: { message_id: ++mid }, getUpdates: [], getMe: { id: 1, username: 'dar_test_bot' } };
      body = { ok: true, result: r && Object.prototype.hasOwnProperty.call(r, 'result') ? r.result : (Object.prototype.hasOwnProperty.call(defaults, method) ? defaults[method] : true) };
    }
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  f.calls = calls;
  f.of = (m) => calls.filter((c) => c.method === m);
  f.reset = () => { calls.length = 0; };
  return f;
}

function fill(id, side, symbol, extra = {}) {
  return {
    id, orderId: `O-${id}`, symbol, side, qty: 10, price: 125.5, fees: 1, notional: 1255, ts: T0 - 3600 * 1000,
    realizedPnl: side === 'SELL' ? 55 : null, costBasisPrice: side === 'SELL' ? 120 : null, returnPct: side === 'SELL' ? 4.58 : null,
    kind: side === 'SELL' ? 'STOP' : 'AI', strategy: 'BREAKOUT', decisionId: side === 'SELL' ? null : `D-${id}`, reason: side === 'SELL' ? 'stop hit at 120' : 'breakout entry', riskProfile: 'BALANCED',
    aiProvider: side === 'BUY' ? 'deepseek' : null, aiModel: side === 'BUY' ? 'deepseek-chat' : null, exitTrigger: side === 'SELL' ? 'STOP_LOSS' : null,
    ...extra,
  };
}

const PROVIDERS = () => ({
  deepseek: {
    id: 'deepseek', name: 'DeepSeek', model: 'deepseek-chat', configured: true, state: 'AVAILABLE', openUntil: null, lastErrorCode: null, lastError: null,
    requestsToday: 30, errorsToday: 0, costTodayUsd: 0.3, requestsMonth: 600, costMonthUsd: 6, dailyBudgetUsd: 1.5, remainingBudgetUsd: 1.2,
    avgLatencyMs: 1800, successRate: 0.98, lastSuccessAt: T0,
  },
  gemini: {
    id: 'gemini', name: 'Gemini', model: 'gemini-x', configured: true, state: 'PAUSED_AFTER_ERRORS', openUntil: T0 + 30 * 60000, lastErrorCode: 'RATE_LIMIT',
    lastError: '429 Too Many Requests', requestsToday: 14, errorsToday: 3, costTodayUsd: 0.12, requestsMonth: 300, costMonthUsd: 2.1, dailyBudgetUsd: null,
    remainingBudgetUsd: null, avgLatencyMs: 2400, successRate: 0.9, lastSuccessAt: T0 - 60000,
  },
});

const NEWS = [
  { id: 'N1', symbol: 'NVDA', ts: T0 - 60000, source: 'Reuters', title: 'NVDA beats <estimates>', url: 'https://example.com/n1', impact: 'HIGH', official: false, aiNote: 'earnings beat' },
  { id: 'N2', symbol: null, ts: T0 - 120000, source: 'Federal Reserve', title: 'FOMC statement', url: 'https://example.com/n2', impact: 'MEDIUM', official: true, aiNote: null },
];

const COMPONENTS = () => ({
  database: { state: 'ok', detail: 'PostgreSQL schema v9' }, engine: { state: 'ok', detail: '3 symbol(s) monitored' },
  alpaca: { state: 'error', detail: 'UNAVAILABLE' }, tiingo: { state: 'not_configured', detail: 'optional Tiingo token not set' },
  deepseek: { state: 'ok', detail: 'deepseek-chat' }, gemini: { state: 'error', detail: 'RATE_LIMIT: paused' },
  telegram: { state: 'ok', detail: '3 message(s) sent today' }, news: { state: 'idle', detail: 'no symbol' },
});

function makeService(over = {}) {
  const svc = new EventEmitter();
  svc.calls = [];
  const state = { aiState: 'RUNNING', profile: 'BALANCED', symbols: ['NVDA', 'AMD', 'AAPL'], aiMode: 'AUTO', monitoring: 'ACTIVE', news: NEWS.slice() };
  svc.state = state;
  const fills = [];
  for (let i = 1; i <= 12; i++) fills.push(fill(`FB${i}`, 'BUY', i % 2 ? 'NVDA' : 'AMD', i === 2 ? { aiProvider: 'gemini', aiModel: 'gemini-x' } : {}));
  fills.push(fill('FS1', 'SELL', 'NVDA'));
  fills.push(fill('FS2', 'SELL', 'AMD', { realizedPnl: -12.4, returnPct: -1.2, kind: 'TAKE_PROFIT', exitTrigger: 'TAKE_PROFIT' }));
  const operating = () => ({
    monitoring: { state: state.monitoring, reason: state.monitoring === 'PAUSED' ? 'paused by user' : null },
    aiTrading: { state: 'RISK_BLOCKED', reason: 'DAILY LOSS LIMIT: -3.1% today' },
  });
  const orders = [
    { id: 'O1', symbol: 'NVDA', side: 'BUY', type: 'LIMIT', qty: 5, limitPrice: 120, status: 'PENDING', filledQty: 0, avgFillPrice: null, notional: null, createdAt: T0 - 60000, updatedAt: T0 - 60000, source: 'AI', reason: 'pullback entry', rejectReason: null, decisionId: 'D9' },
    { id: 'O2', symbol: 'AMD', side: 'SELL', type: 'MARKET', qty: 10, limitPrice: null, status: 'FILLED', filledQty: 10, avgFillPrice: 150, notional: 1500, createdAt: T0 - 120000, updatedAt: T0 - 110000, source: 'STOP', reason: 'stop', rejectReason: null, decisionId: null },
    { id: 'O3', symbol: 'AAPL', side: 'BUY', type: 'MARKET', qty: 3, limitPrice: null, status: 'REJECTED', filledQty: 0, avgFillPrice: null, notional: null, createdAt: T0 - 180000, updatedAt: T0 - 180000, source: 'AI', reason: 'momentum', rejectReason: 'daily loss limit', decisionId: 'D8' },
  ];
  const statsObj = (period) => ({
    period, from: T0 - 86400000, to: T0,
    portfolio: { startEquity: 10000, endEquity: 10650, netPnl: 650, netReturnPct: 6.5, realizedPnl: 400, unrealizedPnl: 250, cash: 5000, invested: 5650, initialCapital: 10000 },
    trading: { roundTrips: 4, wins: 3, losses: 1, winRatePct: 75, avgWin: 150, avgLoss: -50, largestWin: 300, largestLoss: -50, profitFactor: 9, avgHoldingMinutes: 95, avgTradeReturnPct: 2.1, fees: 12.4, buyCount: 12, sellCount: 2, volume: 20000 },
    risk: { maxDrawdownPct: 3.2, currentDrawdownPct: 1.1, maxPositionExposurePct: 25, currentExposurePct: 53, profile: 'BALANCED', dailyLossLimitPct: 3, remainingDailyLossPct: 2.5, maxConsecutiveWins: 3, maxConsecutiveLosses: 1, currentStreak: { type: 'WIN', count: 2 } },
    ai: {
      decisions: 40, proposals: 6, accepted: 4, rejected: 2, executedTrades: 4, waits: 30, holds: 4, requests: 44, status: 'RUNNING',
      deepseekRequests: 30, geminiRequests: 14, deepseekCostUsd: 0.3, geminiCostUsd: 0.12, costUsd: 0.42,
    },
    bySymbol: [{ symbol: 'NVDA', realizedPnl: 300, trades: 3 }, { symbol: 'AMD', realizedPnl: -12.4, trades: 1 }],
    insufficient: { winRatePct: true, profitFactor: true },
  });
  const base = {
    portfolio: () => ({
      initialCapital: 10000, equity: 10650, cash: 5000, positionValue: 5650, costBasis: 5000, realizedPnl: 400, unrealizedPnl: 250, totalPnl: 650,
      totalReturnPct: 6.5, feesPaid: 12.4, exposurePct: 53.05, positionsCount: 2, watchlistCount: 3, riskProfile: state.profile, aiState: state.aiState, hasSession: true,
      reservedCash: 600, monitoringState: state.monitoring, aiTradingState: 'RISK_BLOCKED',
      valuation: { stale: true, staleSymbols: ['NVDA'], asOf: T0 },
      positions: [{ symbol: 'NVDA', qty: 20, avgPrice: 120, mark: 130, markTs: T0, markKind: 'DELAYED', markStale: true, marketValue: 2600, unrealizedPnl: 200, unrealizedPct: 8.33, stop: 110, takeProfit: 150 }],
    }),
    todayPerformance: () => statsObj('today').portfolio,
    orders: (q) => {
      let it = orders.slice();
      if (q.side) it = it.filter((o) => o.side === q.side);
      if (q.status === 'OPEN') it = it.filter((o) => o.status === 'PENDING' || o.status === 'PARTIALLY_FILLED');
      else if (q.status) it = it.filter((o) => o.status === q.status);
      return { total: it.length, items: it.slice(q.offset || 0, (q.offset || 0) + (q.limit || 10)) };
    },
    fills: (q) => {
      let it = fills.slice();
      if (q.side) it = it.filter((f) => f.side === q.side);
      if (q.symbol) it = it.filter((f) => f.symbol === q.symbol);
      it.sort((a, b) => (a.side === b.side ? 0 : (a.side === 'SELL' ? -1 : 1)));
      return { total: it.length, items: it.slice(q.offset || 0, (q.offset || 0) + (q.limit || 5)) };
    },
    fill: (id) => {
      const f = fills.find((x) => x.id === id);
      if (!f) return null;
      return { ...f, decision: f.side === 'SELL' ? null : { id: f.decisionId, action: 'BUY', rationale: 'Recorded: breakout above resistance on volume', evidence: ['volume 2x average'] } };
    },
    stats: ({ period }) => statsObj(period),
    report: (kind) => ({ kind, from: T0 - 86400000, to: T0, stats: statsObj('today'), topContributor: { symbol: 'NVDA', pnl: 300 }, worstContributor: { symbol: 'AMD', pnl: -12.4 }, aiHighlights: [], riskEvents: [], newsEvents: [] }),
    stock: (s) => (s === 'NVDA' ? {
      symbol: 'NVDA', name: 'NVIDIA Corp', monitored: true, status: 'ACTIVE', price: 130.25, priceTs: T0, priceKind: 'TRADE', provider: 'Alpaca', fresh: true, changePct: 1.25,
      trend: 'UP', aiAction: 'HOLD', aiAt: T0 - 600000, aiRationale: 'Recorded rationale for NVDA', aiConfidence: 62, support: 120, resistance: 135, rsi: 58.3,
      position: { qty: 20, avgPrice: 120, unrealizedPnl: 200, unrealizedPct: 8.33 },
    } : null),
    stockNews: () => [{ ts: T0, source: 'Reuters', title: 'NVDA news <b>', url: 'https://example.com/a', impact: 'HIGH', aiNote: null }],
    watchlist: () => state.symbols.map((s) => ({ symbol: s, status: 'ACTIVE', price: 100, changePct: 1, trend: 'UP', aiAction: 'WAIT', positionQty: 0, unrealizedPnl: 0, dataTs: T0, priceKind: 'TRADE', provider: 'Alpaca', fresh: true })),
    ai: () => ({
      state: state.aiState, mode: 'BALANCED', provider: 'Auto', model: 'deepseek-chat / gemini-x', symbolsMonitored: 3, requestsToday: 44, requestsMonth: 900, inputTokensToday: 120000, outputTokensToday: 9000,
      costTodayUsd: 0.42, costMonthUsd: 8.1, dailyBudgetUsd: 2, remainingBudgetUsd: 1.58, avoidedToday: 12, lastAnalysisAt: T0,
      lastDecision: { symbol: 'AMD', action: 'WAIT', ts: T0, provider: 'gemini', model: 'gemini-x' }, apiStatus: 'OK', lastError: null,
      aiMode: state.aiMode, aiModes: ['DEEPSEEK', 'GEMINI', 'AUTO', 'DUAL'], fallback: true, dualScope: 'IMPORTANT', operating: operating(), providers: PROVIDERS(),
    }),
    decisions: (q) => {
      const items = q.symbol === 'AMD' || !q.symbol ? [{
        id: 'D1', symbol: 'AMD', ts: T0 - 60000, previousAction: 'WAIT', action: 'BUY', rationale: 'Recorded AMD rationale: higher lows', evidence: ['RSI 55'], snapshotId: 'S1', proposedTrade: true, status: 'PROPOSED', executed: false, rejected: false, rejectReasons: [],
        provider: 'gemini', model: 'gemini-x', changeReason: 'higher lows confirmed', dual: { policy: 'DISAGREE_WAIT', uncertainty: 'HIGH', deepseek: 'BUY', gemini: 'WAIT' }, news: [{ id: 'N1', note: 'earnings beat' }],
      }] : [];
      return { total: items.length, items };
    },
    news: (q) => state.news.slice(0, (q && q.limit) || 10),
    risk: () => ({ profile: state.profile, limits: { maxRiskPerTradePct: 1, maxDailyLossPct: 3, maxDrawdownPct: 10, maxPositionPct: 25, minRewardRisk: 1.5, maxOpenPositions: 5 }, dayPnlPct: 0.5, remainingDailyLossPct: 2.5, drawdownPct: 1.1, exposurePct: 53, tradingAllowed: true, blocks: [] }),
    previewRiskProfile: (profile) => ({ profile, limits: { maxRiskPerTradePct: 0.5, maxDailyLossPct: 2, maxDrawdownPct: 6, maxPositionPct: 15, minRewardRisk: 2, maxOpenPositions: 3 }, findings: [{ code: 'POS_OVER', ok: false, text: 'مركز NVDA يتجاوز الحد الجديد للمركز' }], reduceSuggestions: [{ symbol: 'NVDA', qty: 5 }] }),
    status: () => ({
      aiState: state.aiState, market: { session: 'REGULAR', label: 'الجلسة الرسمية' }, symbols: state.symbols.map((s) => ({ symbol: s, dataLabel: 'LIVE', fresh: true })), positionsCount: 1, equity: 10650, hasSession: true,
      operating: operating(), aiMode: state.aiMode, server: { state: 'DEGRADED', reasons: ['market data'] }, components: COMPONENTS(),
    }),
    setAiMode: (mode) => { state.aiMode = mode; return { ok: true, message: 'تم تغيير وضع الذكاء الاصطناعي. حدود المخاطرة لم تتغير.', state: null }; },
    pauseMonitoring: () => { state.monitoring = 'PAUSED'; return { ok: true, message: 'تم إيقاف مراقبة السوق مؤقتًا.', state: null }; },
    resumeMonitoring: () => { state.monitoring = 'ACTIVE'; return { ok: true, message: 'تم استئناف مراقبة السوق.', state: null }; },
    pauseAi: () => { state.aiState = 'PAUSED'; return { ok: true, message: 'تم إيقاف الذكاء الاصطناعي مؤقتًا', state: 'PAUSED' }; },
    resumeAi: () => { state.aiState = 'RUNNING'; return { ok: true, message: 'تم الاستئناف', state: 'RUNNING' }; },
    stopAi: () => { state.aiState = 'STOPPED'; return { ok: true, message: 'تم الإيقاف', state: 'STOPPED' }; },
    setRiskProfile: (p) => { state.profile = p; return { ok: true, message: 'تم تغيير مستوى المخاطرة', state: p }; },
    addSymbol: (s) => { state.symbols.push(s); return { ok: true, message: `تمت إضافة ${s}`, state: null }; },
    removeSymbol: (s) => ({ ok: false, message: `لا يمكن إزالة ${s} لوجود مركز مفتوح`, state: null }),
    pauseSymbol: () => ({ ok: true, message: 'ok', state: null }),
    resumeSymbol: () => ({ ok: true, message: 'ok', state: null }),
    // must never be called by the bot (would trigger AI)
    analyze: () => { throw new Error('AI must not be triggered from Telegram'); },
    runAnalysis: () => { throw new Error('AI must not be triggered from Telegram'); },
  };
  for (const [name, fn] of Object.entries({ ...base, ...over })) {
    svc[name] = async (...args) => { svc.calls.push([name, ...args]); return fn(...args); };
  }
  svc.called = (name) => svc.calls.filter((c) => c[0] === name);
  return svc;
}

function setup({ config = makeConfig(), service = makeService(), handler, token = TOKEN, store, relay = false } = {}) {
  const clock = { t: T0 };
  const logs = [];
  const timers = [];
  const fetchImpl = makeFetch(handler);
  const db = store || tempStore();
  const tg = createTelegram({
    store: db, service, getConfig: () => config, getToken: () => token,
    log: (level, message) => logs.push(`${level} ${message}`),
    fetchImpl, now: () => clock.t, setTimeoutImpl: (fn, ms) => { timers.push({ fn, ms }); return { unref() {} }; }, relay,
  });
  return { tg, clock, logs, timers, fetchImpl, service, config, db };
}

let updateId = 1;
const msg = (chat, from, text) => ({ update_id: updateId++, message: { message_id: updateId, chat, from, date: 0, text } });
const SCREEN_MARKUP = { inline_keyboard: [[{ text: '🏠 القائمة الرئيسية', callback_data: 'm' }]] };
const cb = (chat, from, data, messageId = 77, replyMarkup = SCREEN_MARKUP) => ({ update_id: updateId++, callback_query: { id: `cq${updateId}`, from, data, message: { message_id: messageId, chat, reply_markup: replyMarkup } } });
const lastOut = (f) => { const c = f.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText'); return c[c.length - 1]; };
const buttons = (call) => (call && call.params.reply_markup ? call.params.reply_markup.inline_keyboard : []);
const flatButtons = (call) => buttons(call).flat();
const findButton = (call, text) => flatButtons(call).find((b) => b.text.includes(text));

// ------------------------------------------------------------------ authorization
test('unauthorized user is rejected once (rate-limited), audited, and gets no data', async () => {
  const { tg, fetchImpl, service, db } = setup();
  await tg.handleUpdate(msg(STRANGER_CHAT, STRANGER, '/portfolio'));
  await tg.handleUpdate(msg(STRANGER_CHAT, STRANGER, '/start'));
  const sends = fetchImpl.of('sendMessage');
  assert.equal(sends.length, 1, 'reply is rate-limited');
  assert.equal(sends[0].params.text, '⛔ غير مصرح لك باستخدام هذا البوت.');
  assert.equal(service.calls.length, 0, 'no service access');
  const audit = db.db.prepare("SELECT * FROM tg_audit WHERE action = 'UNAUTHORIZED'").all();
  assert.equal(audit.length, 2);
  assert.equal(audit[0].chat_id, '999');
  assert.equal(audit[0].result, 'DENIED');
  // unauthorized button press
  await tg.handleUpdate(cb(STRANGER_CHAT, STRANGER, 'pf'));
  const ans = fetchImpl.of('answerCallbackQuery');
  assert.equal(ans.length, 1);
  assert.equal(ans[0].params.text, '⛔ غير مصرح لك باستخدام هذا البوت.');
  assert.equal(service.calls.length, 0);
});

test('authorized user id can read in a private chat even if that chat id is not listed', async () => {
  const config = makeConfig({ authorizedChatIds: ['-100500'], authorizedUserIds: ['111'] });
  const { tg, fetchImpl } = setup({ config });
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/start'));
  assert.ok(lastOut(fetchImpl).params.text.includes('فرصة'));
});

test('group chat cannot run /pauseai without an authorized user id (chat id alone never authorizes control)', async () => {
  const { tg, fetchImpl, service, db } = setup();
  await tg.handleUpdate(msg(GROUP, MEMBER, '/portfolio'));
  assert.equal(service.called('portfolio').length, 1, 'reading is allowed in the authorized group');
  await tg.handleUpdate(msg(GROUP, MEMBER, '/pauseai'));
  const out = lastOut(fetchImpl);
  assert.ok(out.params.text.includes('يتطلب مستخدمًا مصرحًا له بالتحكم'));
  assert.ok(!flatButtons(out).some((b) => b.callback_data.startsWith('y:')), 'no confirm button');
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM tg_nonces').get().n, 0);
  assert.equal(service.called('pauseAi').length, 0);
  assert.ok(db.db.prepare("SELECT * FROM tg_audit WHERE action = 'PAUSE_AI' AND result = 'DENIED_NO_CONTROL_PERMISSION'").get());
  // even with an empty authorizedUserIds list, a group chat id never authorizes control
  const cfg2 = makeConfig({ authorizedUserIds: [] });
  const s2 = setup({ config: cfg2 });
  await s2.tg.handleUpdate(msg(GROUP, MEMBER, '/pauseai'));
  assert.equal(s2.db.db.prepare('SELECT COUNT(*) AS n FROM tg_nonces').get().n, 0);
  // ...while a listed PRIVATE chat (chat.id === from.id) does
  await s2.tg.handleUpdate(msg(PRIVATE, OWNER, '/pauseai'));
  assert.equal(s2.db.db.prepare('SELECT COUNT(*) AS n FROM tg_nonces').get().n, 1);
  // and an authorized user id inside the group may control
  await tg.handleUpdate(msg(GROUP, OWNER, '/pauseai'));
  assert.ok(findButton(lastOut(fetchImpl), 'تأكيد'));
});

// ------------------------------------------------------------------ screens
test('/start shows the Arabic welcome, the paper-trading note and the 11-button main keyboard in the required order', async () => {
  const { tg, fetchImpl } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/start'));
  const out = lastOut(fetchImpl);
  assert.equal(out.method, 'sendMessage');
  assert.equal(out.params.parse_mode, 'HTML');
  const text = out.params.text;
  assert.ok(text.includes('📊 <b>فرصة | المضاربة الذكية</b>'));
  assert.ok(text.includes('مرحبًا بك في لوحة التحكم بالمحفظة الافتراضية.'));
  assert.ok(text.includes('يمكنك متابعة أداء المحفظة والصفقات وقرارات الذكاء الاصطناعي مباشرة من تيليجرام.'));
  assert.ok(text.includes('تداول ورقي فقط'));
  const rows = buttons(out);
  assert.deepEqual(rows.map((r) => r.map((b) => b.text)), [
    ['💼 المحفظة', '📈 الأسهم المراقبة'],
    ['🟢 أوامر الشراء', '🔴 أوامر البيع'],
    ['📋 سجل الصفقات', '📊 الإحصائيات'],
    ['🤖 الذكاء الاصطناعي', '⚠️ إدارة المخاطر'],
    ['📰 الأخبار', '🔔 الإشعارات'],
    ['⚙️ الإعدادات'],
  ]);
  for (const b of rows.flat()) assert.ok(parseCallbackData(b.callback_data), b.callback_data);
  assert.equal(rows.flat().find((b) => b.text === '📰 الأخبار').callback_data, 'nw');
  assert.equal(rows.flat().find((b) => b.text === '🤖 الذكاء الاصطناعي').callback_data, 'ai');
});

test('📰 news screen: /news and the menu button list the latest 10 items from service.news() (no AI)', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/news'));
  assert.deepEqual(service.called('news')[0][1], { limit: 10 });
  const out = lastOut(fetchImpl);
  const t = out.params.text;
  assert.ok(t.includes('آخر الأخبار'));
  assert.ok(t.includes('<b>NVDA</b>'), 'symbol');
  assert.ok(t.includes('<a href="https://example.com/n1">NVDA beats &lt;estimates&gt;</a>'), 'linked, escaped title');
  assert.ok(t.includes('المصدر: Reuters'), 'source');
  assert.ok(t.includes('التأثير: مرتفع') && t.includes('التأثير: متوسط'), 'impact in Arabic');
  assert.ok(t.includes('earnings beat'), 'recorded AI note');
  assert.ok(t.includes('رسمي'), 'official source flagged');
  assert.ok(/نوفمبر 2026/.test(t), 'time');
  assert.ok(findButton(out, 'تحديث') && findButton(out, 'تحديث').callback_data === 'nw');
  assert.ok(findButton(out, 'NVDA').callback_data === 'sk:NVDA:n');
  // menu button route
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'nw'));
  assert.equal(service.called('news').length, 2);
  // empty
  service.state.news = [];
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/news'));
  assert.ok(lastOut(fetchImpl).params.text.includes('لا توجد أخبار مسجلة بعد'));
  // /help lists the command
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/help'));
  assert.ok(lastOut(fetchImpl).params.text.includes('/news'));
  assert.ok(!service.calls.some((c) => c[0] === 'analyze' || c[0] === 'runAnalysis'));
});

test('/portfolio renders the service numbers, the stale-valuation warning and its buttons', async () => {
  const { tg, fetchImpl } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/portfolio'));
  const out = lastOut(fetchImpl);
  const t = out.params.text;
  for (const s of ['رأس المال الابتدائي: $10,000.00', 'القيمة الحالية: <b>$10,650.00</b>', 'السيولة المتاحة: $5,000.00', 'القيمة المستثمرة: $5,650.00',
    'الربح المحقق: +$400.00', 'الربح غير المحقق: +$250.00', 'إجمالي الأرباح: <b>+$650.00</b>', 'العائد الإجمالي: +6.50%', 'الرسوم: $12.40',
    'الأسهم المملوكة: 2', 'الأسهم المراقبة: 3', 'مستوى المخاطرة: متوسطة', 'حالة الذكاء الاصطناعي: يعمل', '⚠️ التقييم يعتمد على أسعار غير حديثة لـ: NVDA',
    'النقد المحجوز: $600.00', 'حالة مراقبة السوق: 🟢 نشطة', 'حالة التداول الآلي: ⛔ محظور بحدود المخاطر']) {
    assert.ok(t.includes(s), `missing: ${s}`);
  }
  const labels = flatButtons(out).map((b) => b.text);
  for (const l of ['تفاصيل المراكز', 'أداء اليوم', 'الإحصائيات', 'تحديث', 'القائمة الرئيسية']) assert.ok(labels.some((x) => x.includes(l)), l);
  // refresh via button edits the existing message and answers the callback
  fetchImpl.reset();
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'pf:pos'));
  assert.equal(fetchImpl.of('editMessageText').length, 1);
  assert.equal(fetchImpl.of('answerCallbackQuery').length, 1);
  assert.ok(lastOut(fetchImpl).params.text.includes('سعر متأخر'));
  // a button on a notification (no home button) opens a new message instead of overwriting the notification
  fetchImpl.reset();
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'td:FB1', 78, { inline_keyboard: [[{ text: 'x', callback_data: 'td:FB1' }]] }));
  assert.equal(fetchImpl.of('editMessageText').length, 0);
  assert.equal(fetchImpl.of('sendMessage').length, 1);
});

test('/buys pages 5 per page and passes the right filter args', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/buys'));
  assert.deepEqual(service.called('fills')[0][1], { side: 'BUY', symbol: null, period: 'all', limit: 5, offset: 0 });
  let out = lastOut(fetchImpl);
  assert.ok(out.params.text.includes('<b>1)</b>'));
  assert.ok(out.params.text.includes('رقم التنفيذ: <code>FB1</code>'));
  assert.ok(/نوفمبر 2026/.test(out.params.text), 'Arabic month name');
  assert.ok(/\d{1,2}:\d{2} [صم]/.test(out.params.text), '12h time with ص/م');
  assert.ok(out.params.text.includes('مزود التحليل: DeepSeek'), 'AI provider per buy');
  assert.ok(out.params.text.includes('مزود التحليل: Gemini'), 'per-fill provider, not a global one');
  assert.ok(out.params.text.includes('التكلفة الإجمالية: <b>$1,256.00</b>'), 'total cost = notional + fees');
  const next = findButton(out, 'التالي');
  assert.equal(next.callback_data, 'b:a:1');
  for (const l of ['اليوم', 'آخر 7 أيام', 'آخر 30 يومًا', 'جميع الأوامر', 'حسب السهم', 'الأوامر المعلقة']) assert.ok(findButton(out, l), l);
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'b:7:1'));
  assert.deepEqual(service.called('fills')[1][1], { side: 'BUY', symbol: null, period: '7d', limit: 5, offset: 5 });
  out = lastOut(fetchImpl);
  assert.equal(out.method, 'editMessageText');
  assert.ok(out.params.text.includes('<b>6)</b>'), 'numbering continues across pages');
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'b:t:0:NVDA'));
  assert.deepEqual(service.called('fills')[2][1], { side: 'BUY', symbol: 'NVDA', period: 'today', limit: 5, offset: 0 });
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'b:30:0'));
  assert.equal(service.called('fills')[3][1].period, '30d');
  // "by symbol" asks for a ticker and then uses it
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'b:sym'));
  assert.ok(lastOut(fetchImpl).params.text.includes('أرسل رمز السهم'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'amd'));
  const last = service.called('fills').pop()[1];
  assert.equal(last.symbol, 'AMD');
  assert.equal(last.side, 'BUY');
});

test('/sells shows cost basis, realized P&L, return and the trigger', async () => {
  const { tg, fetchImpl } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/sells'));
  const t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('عمليات البيع المنفذة'));
  assert.ok(t.includes('متوسط سعر الشراء: $120.00'));
  assert.ok(t.includes('الربح/الخسارة المحققة: +$55.00 (+4.58%)'));
  assert.ok(t.includes('الربح/الخسارة المحققة: -$12.40 (-1.20%)'));
  assert.ok(t.includes('محفز الخروج: <b>🛑 وقف خسارة</b>'));
  assert.ok(t.includes('محفز الخروج: <b>🎯 جني أرباح</b>'));
});

test('exit trigger labels: STOP_LOSS / TAKE_PROFIT / TRAILING_STOP / MANUAL / AI (derived from kind for older rows)', () => {
  const cases = [['STOP_LOSS', 'وقف خسارة'], ['TAKE_PROFIT', 'جني أرباح'], ['TRAILING_STOP', 'وقف متحرك'], ['MANUAL', 'إغلاق يدوي'], ['AI', 'قرار الذكاء الاصطناعي']];
  for (const [t, ar] of cases) assert.ok(F.exitTriggerText(F.exitTriggerOf({ side: 'SELL', exitTrigger: t })).includes(ar), t);
  assert.equal(F.exitTriggerOf({ side: 'SELL', kind: 'TRAILING_STOP' }), 'TRAILING_STOP');
  assert.equal(F.exitTriggerOf({ side: 'SELL', kind: 'USER' }), 'MANUAL');
  assert.equal(F.exitTriggerOf({ side: 'BUY', kind: 'STOP' }), null);
  for (const [p, ar] of [['deepseek', 'DeepSeek'], ['gemini', 'Gemini'], ['dual', 'تحليل مزدوج'], ['rules', 'قواعد ثابتة'], [null, '—']]) assert.equal(F.providerLabel(p), ar);
});

test('/orders groups by status and states that an order is not an execution', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/orders'));
  const t = lastOut(fetchImpl).params.text;
  const iPending = t.indexOf('أوامر معلقة');
  const iFilled = t.indexOf('أوامر منفذة');
  const iRejected = t.indexOf('أوامر مرفوضة');
  assert.ok(iPending >= 0 && iFilled > iPending && iRejected > iFilled, 'separate status sections');
  assert.ok(t.indexOf('<code>O1</code>') > iPending && t.indexOf('<code>O1</code>') < iFilled, 'pending order under pending section');
  assert.ok(t.indexOf('<code>O3</code>') > iRejected);
  assert.ok(t.includes('سبب الرفض: daily loss limit'));
  assert.ok(t.includes('لا يعني التنفيذ'));
  for (const l of ['الشراء', 'البيع', 'المعلقة', 'المنفذة', 'الملغاة', 'المرفوضة']) assert.ok(findButton(lastOut(fetchImpl), l), l);
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'o:open:0'));
  assert.equal(service.called('orders')[1][1].status, 'OPEN');
  const t2 = lastOut(fetchImpl).params.text;
  assert.ok(t2.includes('<code>O1</code>') && !t2.includes('<code>O2</code>'));
});

test('/stats renders sections and "بيانات غير كافية" for insufficient metrics', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/stats'));
  const t = lastOut(fetchImpl).params.text;
  for (const s of ['أداء المحفظة', 'أداء التداول', 'إحصائيات المخاطر', 'أداء الذكاء الاصطناعي']) assert.ok(t.includes(s), s);
  assert.ok(t.includes('نسبة الصفقات الرابحة: بيانات غير كافية'));
  assert.ok(t.includes('معامل الربح: بيانات غير كافية'));
  assert.ok(!t.includes('75.00%'), 'insufficient metric value is not shown');
  assert.ok(t.includes('صافي الربح/الخسارة: <b>+$650.00</b>'));
  assert.ok(t.includes('ليست احتمالًا معايرًا'));
  assert.ok(t.includes('ليست مقياسًا لدقة تنبؤات الذكاء الاصطناعي'));
  assert.ok(t.includes('طلبات DeepSeek: 30 ($0.30)'));
  assert.ok(t.includes('طلبات Gemini: 14 ($0.12)'));
  assert.ok(t.includes('التكلفة التقديرية للذكاء الاصطناعي: $0.42'));
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'st:m'));
  assert.deepEqual(service.called('stats')[1][1], { period: 'month' });
});

test('/stock shows provider + freshness from recorded data and never triggers AI', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/stock nvda'));
  const out = lastOut(fetchImpl);
  assert.ok(out.params.text.includes('NVIDIA Corp'));
  assert.ok(out.params.text.includes('Alpaca — ✅ بيانات حديثة'));
  assert.ok(out.params.text.includes('$130.25'));
  for (const l of ['التحليل الكامل', 'آخر القرارات', 'صفقات السهم', 'الأخبار', 'تحديث']) assert.ok(findButton(out, l), l);
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'sk:NVDA:f'));
  assert.ok(lastOut(fetchImpl).params.text.includes('Recorded rationale for NVDA'));
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'sk:NVDA:n'));
  assert.ok(lastOut(fetchImpl).params.text.includes('NVDA news &lt;b&gt;'), 'news titles are HTML-escaped');
  const names = new Set(service.calls.map((c) => c[0]));
  assert.ok(!names.has('analyze') && !names.has('runAnalysis'));
  for (const n of names) assert.ok(['stock', 'decisions', 'stockNews'].includes(n), `unexpected service call ${n}`);
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/stock ZZZZ'));
  assert.ok(lastOut(fetchImpl).params.text.includes('لا تتوفر بيانات'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/stock bad$$'));
  assert.ok(lastOut(fetchImpl).params.text.includes('غير صالح'));
});

test('every button produced by the screens passes the callback whitelist', async () => {
  const { tg, logs } = setup();
  for (const c of ['/start', '/help', '/portfolio', '/buys', '/sells', '/orders', '/trades', '/stats', '/daily', '/weekly', '/monthly', '/stock NVDA', '/watchlist', '/news', '/ai', '/decisions', '/risk', '/status', '/notifications', '/settings']) {
    await tg.handleUpdate(msg(PRIVATE, OWNER, c));
  }
  for (const d of ['pf:pos', 'pf:td', 'tr:a:s:0', 'td:FB1', 'td:FS1', 'ai:u', 'ai:ds', 'ai:gm', 'nw', 'aim:DUAL', 'mon:pause', 'rk:d', 'sk:NVDA:d', 'sk:NVDA:t', 'w:rm', 'w:det', 'b:pend', 'd:b:0']) {
    await tg.handleUpdate(cb(PRIVATE, OWNER, d));
  }
  assert.deepEqual(logs.filter((l) => l.includes('dropped')), []);
});

// ------------------------------------------------------------------ confirmation flow
test('confirmation: /pauseai does nothing until confirmed, runs once, second press is refused, expired nonce refused', async () => {
  const { tg, fetchImpl, service, clock, db } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/pauseai'));
  assert.equal(service.called('pauseAi').length, 0, 'nothing happens before confirmation');
  const out = lastOut(fetchImpl);
  assert.ok(out.params.text.includes('إيقاف الذكاء الاصطناعي مؤقتًا'));
  assert.ok(out.params.text.includes('وقف الخسارة وجني الأرباح'), 'explains protective orders stay active');
  const yes = findButton(out, 'تأكيد');
  const no = findButton(out, 'إلغاء');
  assert.match(yes.callback_data, /^y:[A-Za-z0-9_-]{16}$/);
  assert.match(no.callback_data, /^x:[A-Za-z0-9_-]{16}$/);
  // someone else in the same (group) context cannot use it: different chat -> invalid
  await tg.handleUpdate(cb(GROUP, OWNER, yes.callback_data));
  assert.equal(service.called('pauseAi').length, 0);
  // confirm
  await tg.handleUpdate(cb(PRIVATE, OWNER, yes.callback_data));
  assert.equal(service.called('pauseAi').length, 1);
  assert.ok(service.called('status').length >= 1, 'status() is used to verify');
  const done = lastOut(fetchImpl).params.text;
  assert.ok(done.includes('تمت العملية'));
  assert.ok(done.includes('تم التحقق') && done.includes('متوقف مؤقتًا'));
  // second press of the same button
  await tg.handleUpdate(cb(PRIVATE, OWNER, yes.callback_data));
  assert.equal(service.called('pauseAi').length, 1, 'not called again');
  const ans = fetchImpl.of('answerCallbackQuery');
  assert.ok(ans[ans.length - 1].params.text.includes('مسبقًا'));
  // expired nonce
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/resumeai'));
  const yes2 = findButton(lastOut(fetchImpl), 'تأكيد');
  clock.t += 2 * 60 * 1000 + 1;
  await tg.handleUpdate(cb(PRIVATE, OWNER, yes2.callback_data));
  assert.equal(service.called('resumeAi').length, 0);
  const ans2 = fetchImpl.of('answerCallbackQuery');
  assert.ok(ans2[ans2.length - 1].params.text.includes('انتهت صلاحية'));
  // cancel
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/stopai'));
  const no3 = findButton(lastOut(fetchImpl), 'إلغاء');
  await tg.handleUpdate(cb(PRIVATE, OWNER, no3.callback_data));
  assert.equal(service.called('stopAi').length, 0);
  assert.ok(lastOut(fetchImpl).params.text.includes('تم إلغاء العملية'));
  const results = db.db.prepare("SELECT action, result FROM tg_audit WHERE action IN ('PAUSE_AI','RESUME_AI','STOP_AI') ORDER BY id").all().map((r) => `${r.action}:${r.result}`);
  assert.deepEqual(results, ['PAUSE_AI:CONFIRM_REQUESTED', 'PAUSE_AI:OK', 'PAUSE_AI:ALREADY_HANDLED', 'RESUME_AI:CONFIRM_REQUESTED', 'RESUME_AI:EXPIRED', 'STOP_AI:CONFIRM_REQUESTED', 'STOP_AI:CANCELLED']);
});

test('confirmation: a different user cannot confirm, and service refusals are reported', async () => {
  const config = makeConfig({ authorizedUserIds: ['111', '333'] });
  const { tg, fetchImpl, service } = setup({ config });
  await tg.handleUpdate(msg(GROUP, OWNER, '/removestock NVDA'));
  const yes = findButton(lastOut(fetchImpl), 'تأكيد');
  await tg.handleUpdate(cb(GROUP, { id: 333, is_bot: false }, yes.callback_data));
  assert.equal(service.called('removeSymbol').length, 0);
  await tg.handleUpdate(cb(GROUP, MEMBER, yes.callback_data)); // read-only member
  assert.equal(service.called('removeSymbol').length, 0);
  await tg.handleUpdate(cb(GROUP, OWNER, yes.callback_data));
  assert.equal(service.called('removeSymbol').length, 1);
  const t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('تعذر تنفيذ العملية'));
  assert.ok(t.includes('لا يمكن إزالة NVDA لوجود مركز مفتوح'));
});

test('risk profile change previews the effect, never auto-closes, and requires confirmation', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/risk'));
  const out = lastOut(fetchImpl);
  for (const l of ['منخفضة', 'متوسطة', 'مرتفعة', 'مرتفعة جدًا', 'تفاصيل المخاطر']) assert.ok(findButton(out, l), l);
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'rk:p:CONSERVATIVE'));
  assert.deepEqual(service.called('previewRiskProfile')[0].slice(1), ['CONSERVATIVE']);
  assert.equal(service.called('setRiskProfile').length, 0);
  const t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('مركز NVDA يتجاوز الحد الجديد للمركز'));
  assert.ok(t.includes('لن يتم إغلاق أي مركز تلقائيًا'));
  await tg.handleUpdate(cb(PRIVATE, OWNER, findButton(lastOut(fetchImpl), 'تأكيد').callback_data));
  assert.deepEqual(service.called('setRiskProfile')[0].slice(1), ['CONSERVATIVE']);
  assert.ok(lastOut(fetchImpl).params.text.includes('مستوى المخاطرة الآن: «منخفضة»'));
});

test('/ai shows the AI mode, fallback, usage mode, one block per provider, combined budget and the last analysis', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/ai'));
  const out = lastOut(fetchImpl);
  const t = out.params.text;
  for (const s of [
    'وضع الذكاء الاصطناعي: <b>تلقائي</b>', 'التحويل إلى المزود الآخر عند الخطأ: ✅ مفعّل', 'نمط الاستخدام: متوازن',
    '🔷 <b>DeepSeek</b>', '🔶 <b>Gemini</b>', 'الحالة: ✅ متاح', 'متوقف مؤقتًا بعد أخطاء حتى 1:30 م',
    'النموذج: <code>deepseek-chat</code>', 'الطلبات اليوم / هذا الشهر: 30 / 600', 'التكلفة التقديرية اليوم / هذا الشهر: $0.30 / $6.00',
    'ميزانية المزود اليومية / المتبقي: $1.50 / $1.20', 'متوسط زمن الاستجابة: 1,800 مللي ثانية', 'آخر خطأ: <code>RATE_LIMIT</code> (تجاوز حد الطلبات) — 429 Too Many Requests',
    'التكلفة التقديرية اليوم: $0.42', 'الميزانية اليومية العامة: $2.00', 'المتبقي من الميزانية اليومية: $1.58',
    'الميزانية حد إنفاق مضبوط داخل التطبيق وليست رصيدًا مؤكدًا لدى المزود', 'آخر تحليل: <b>AMD</b> — انتظار — Gemini (gemini-x)',
  ]) assert.ok(t.includes(s), `missing: ${s}`);
  // Gemini has no per-provider budget → that line is only shown for DeepSeek
  assert.equal((t.match(/ميزانية المزود اليومية/g) || []).length, 1);
  const labels = flatButtons(out).map((b) => [b.text, b.callback_data]);
  assert.deepEqual(labels.filter(([, d]) => d.startsWith('aim:')), [['DeepSeek فقط', 'aim:DEEPSEEK'], ['Gemini فقط', 'aim:GEMINI'], ['✅ تلقائي', 'aim:AUTO'], ['تحليل مزدوج', 'aim:DUAL']]);
  assert.ok(findButton(out, 'استهلاك الذكاء الاصطناعي'));
  // usage screens
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'ai:u'));
  const u = lastOut(fetchImpl).params.text;
  assert.ok(u.includes('• DeepSeek: 30 طلب — $0.30 | 600 طلب — $6.00') && u.includes('• Gemini: 14 طلب — $0.12'));
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'ai:gm'));
  assert.ok(lastOut(fetchImpl).params.text.includes('استهلاك Gemini'));
  assert.ok(!service.calls.some((c) => c[0] === 'analyze' || c[0] === 'runAnalysis' || c[0] === 'setAiMode'), 'viewing never changes anything');
});

test('/ai mode switch: authorized + confirmed + exactly one setAiMode call; replay and unauthorized users do nothing', async () => {
  const { tg, fetchImpl, service, db } = setup();
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'aim:DUAL'));
  assert.equal(service.called('setAiMode').length, 0, 'nothing before confirmation');
  const conf = lastOut(fetchImpl);
  assert.ok(conf.params.text.includes('تأكيد العملية'));
  assert.ok(conf.params.text.includes('تغيير وضع الذكاء الاصطناعي إلى «تحليل مزدوج»'));
  assert.ok(conf.params.text.includes('لا تُنفذ أي صفقة'), 'explains the dual policy');
  const yes = findButton(conf, 'تأكيد');
  // a read-only member of the same chat cannot confirm the owner's request
  await tg.handleUpdate(cb(PRIVATE, MEMBER, yes.callback_data));
  assert.equal(service.called('setAiMode').length, 0);
  await tg.handleUpdate(cb(PRIVATE, OWNER, yes.callback_data));
  assert.deepEqual(service.called('setAiMode').map((c) => c.slice(1)), [['DUAL', 'telegram']]);
  const done = lastOut(fetchImpl).params.text;
  assert.ok(done.includes('تمت العملية'));
  assert.ok(done.includes('تم التحقق: وضع الذكاء الاصطناعي الآن: «تحليل مزدوج»'));
  // replayed confirmation
  await tg.handleUpdate(cb(PRIVATE, OWNER, yes.callback_data));
  assert.equal(service.called('setAiMode').length, 1, 'replay does not run twice');
  const ans = fetchImpl.of('answerCallbackQuery');
  assert.ok(ans[ans.length - 1].params.text.includes('مسبقًا'));
  // the screen now marks DUAL as current
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/ai'));
  assert.ok(findButton(lastOut(fetchImpl), '✅ تحليل مزدوج'));
  // a read-only group member: denied before any nonce is created
  const nonces = db.db.prepare('SELECT COUNT(*) AS n FROM tg_nonces').get().n;
  await tg.handleUpdate(cb(GROUP, MEMBER, 'aim:GEMINI'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM tg_nonces').get().n, nonces);
  const deny = fetchImpl.of('answerCallbackQuery').pop();
  assert.ok(deny.params.text.includes('يتطلب مستخدمًا مصرحًا له بالتحكم') && deny.params.show_alert);
  // a stranger is not even authorized to read
  await tg.handleUpdate(cb(STRANGER_CHAT, STRANGER, 'aim:GEMINI'));
  assert.equal(service.called('setAiMode').length, 1);
  const audit = db.db.prepare("SELECT result FROM tg_audit WHERE action = 'SET_AI_MODE' ORDER BY id").all().map((r) => r.result);
  assert.deepEqual(audit, ['CONFIRM_REQUESTED', 'DENIED_NO_CONTROL_PERMISSION', 'OK', 'ALREADY_HANDLED', 'DENIED_NO_CONTROL_PERMISSION']);
});

test('/status shows server state, operating states with reasons, AI mode and the Arabic components list', async () => {
  const { tg, fetchImpl } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/status'));
  const out = lastOut(fetchImpl);
  const t = out.params.text;
  for (const s of [
    'الخادم: 🟠 يعمل بأداء منقوص', 'الأسباب: بيانات السوق', 'مراقبة السوق: 🟢 نشطة', 'التداول الآلي: ⛔ محظور بحدود المخاطر — تم بلوغ حد الخسارة اليومية',
    'وضع الذكاء الاصطناعي: تلقائي', 'مكونات النظام', '• قاعدة البيانات: ✅ سليم', '• محرك التداول: ✅ سليم', '• Alpaca: ❌ خطأ — UNAVAILABLE',
    '• Tiingo: ⚪ غير مضبوط', '• DeepSeek: ✅ سليم', '• Gemini: ❌ خطأ', '• تيليجرام: ✅ سليم', '• الأخبار: 💤 خامل',
  ]) assert.ok(t.includes(s), `missing: ${s}`);
  assert.ok(!t.includes('PostgreSQL schema'), 'healthy component details are not dumped');
  assert.ok(t.indexOf('قاعدة البيانات') < t.indexOf('محرك التداول') && t.indexOf('تيليجرام') < t.indexOf('• الأخبار'), 'fixed order');
  assert.equal(findButton(out, 'إيقاف مراقبة السوق').callback_data, 'mon:pause');
  // server / components may be null (no HTTP layer)
  const s2 = setup({ service: makeService({ status: () => ({ aiState: 'RUNNING', market: {}, symbols: [], hasSession: false, server: null, components: null, operating: null, aiMode: 'GEMINI' }) }) });
  await s2.tg.handleUpdate(msg(PRIVATE, OWNER, '/status'));
  const t2 = lastOut(s2.fetchImpl).params.text;
  assert.ok(t2.includes('الخادم: غير متاح') && t2.includes('تفاصيل مكونات النظام غير متاحة') && t2.includes('وضع الذكاء الاصطناعي: Gemini فقط'));
});

test('/status market-monitoring button: confirmation, single pause/resume call, replay refused, read-only users denied', async () => {
  const { tg, fetchImpl, service, db } = setup();
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'mon:pause'));
  assert.equal(service.called('pauseMonitoring').length, 0);
  const conf = lastOut(fetchImpl);
  assert.ok(conf.params.text.includes('إيقاف مراقبة السوق مؤقتًا'));
  assert.ok(conf.params.text.includes('أوامر الحماية'), 'explains protective orders stay active');
  const yes = findButton(conf, 'تأكيد');
  await tg.handleUpdate(cb(PRIVATE, OWNER, yes.callback_data));
  assert.deepEqual(service.called('pauseMonitoring').map((c) => c.slice(1)), [['telegram']]);
  assert.ok(lastOut(fetchImpl).params.text.includes('تم التحقق: حالة مراقبة السوق الآن: «متوقفة»'));
  await tg.handleUpdate(cb(PRIVATE, OWNER, yes.callback_data));
  assert.equal(service.called('pauseMonitoring').length, 1, 'replay ignored');
  // the status screen now offers resume
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/status'));
  const st = lastOut(fetchImpl);
  assert.ok(st.params.text.includes('مراقبة السوق: ⏸️ متوقفة — أوقفها المستخدم'));
  assert.ok(!findButton(st, 'إيقاف مراقبة السوق'));
  const resume = findButton(st, 'استئناف مراقبة السوق');
  assert.equal(resume.callback_data, 'mon:resume');
  // read-only member cannot
  await tg.handleUpdate(cb(GROUP, MEMBER, 'mon:resume'));
  assert.equal(service.called('resumeMonitoring').length, 0);
  await tg.handleUpdate(cb(PRIVATE, OWNER, resume.callback_data));
  await tg.handleUpdate(cb(PRIVATE, OWNER, findButton(lastOut(fetchImpl), 'تأكيد').callback_data));
  assert.equal(service.called('resumeMonitoring').length, 1);
  assert.ok(lastOut(fetchImpl).params.text.includes('«نشطة»'));
  const audit = db.db.prepare("SELECT action, result FROM tg_audit WHERE action LIKE '%MONITORING' ORDER BY id").all().map((r) => `${r.action}:${r.result}`);
  assert.deepEqual(audit, ['PAUSE_MONITORING:CONFIRM_REQUESTED', 'PAUSE_MONITORING:OK', 'PAUSE_MONITORING:ALREADY_HANDLED', 'RESUME_MONITORING:DENIED_NO_CONTROL_PERMISSION', 'RESUME_MONITORING:CONFIRM_REQUESTED', 'RESUME_MONITORING:OK']);
});

test('/decisions shows provider/model, change reason and the dual-analysis summary', async () => {
  const { tg, fetchImpl } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/decisions'));
  const t = lastOut(fetchImpl).params.text;
  for (const s of ['المزود / النموذج: Gemini (gemini-x)', 'سبب التغيير: higher lows confirmed', 'التحليل المزدوج: اختلف النموذجان — لم تُنفذ أي صفقة',
    'DeepSeek: شراء | Gemini: انتظار | عدم اليقين المشترك: مرتفع', 'ملاحظات الأخبار: earnings beat']) assert.ok(t.includes(s), `missing: ${s}`);
  const agree = { id: 'D2', symbol: 'AMD', ts: T0, previousAction: 'WAIT', action: 'WAIT', rationale: 'r', evidence: [], provider: 'dual', model: null, changeReason: null, dual: { policy: 'AGREE_NO_TRADE', uncertainty: 'LOW', deepseek: 'WAIT', gemini: 'NO_TRADE' }, news: [] };
  const s2 = setup({ service: makeService({ decisions: () => ({ total: 1, items: [agree] }) }) });
  await s2.tg.handleUpdate(msg(PRIVATE, OWNER, '/decisions'));
  const t2 = lastOut(s2.fetchImpl).params.text;
  assert.ok(t2.includes('المزود / النموذج: تحليل مزدوج') && t2.includes('اتفق النموذجان') && t2.includes('Gemini: لا تداول') && t2.includes('منخفض'));
  assert.ok(!t2.includes('اختلف النموذجان'));
});

test('callback data whitelist rejects garbage without side effects', async () => {
  const { tg, fetchImpl, service } = setup();
  const bad = ['evil', 'pf:../../etc', 'y:short', 'y:' + 'a'.repeat(17), 'sk:nvda', 'sk:NVDA;DROP', 'b:9:0', 'rk:p:YOLO', 'x'.repeat(65), '', 'ctl:sell', 'td:a b', 'q:pnl:yesterday',
    'aim:GPT', 'aim:dual', 'aim:', 'mon:stop', 'mon:pause:x', 'nw:1', 'ai:xx'];
  for (const d of bad) {
    fetchImpl.reset();
    await tg.handleUpdate(cb(PRIVATE, OWNER, d));
    const ans = fetchImpl.of('answerCallbackQuery');
    assert.equal(ans.length, 1, d);
    assert.equal(ans[0].params.text, 'طلب غير صالح', d);
    assert.equal(fetchImpl.of('sendMessage').length + fetchImpl.of('editMessageText').length, 0, d);
  }
  assert.equal(service.calls.length, 0);
  for (const [, re] of CALLBACK_ROUTES) assert.ok(re.source.startsWith('^') && re.source.endsWith('$'), 'anchored');
  assert.equal(parseCallbackData('tr:30:a:999:ABCDEFGHIJ').route, 'trades');
});

// ------------------------------------------------------------------ free text
test('free-text questions are answered from the service (no AI) and clarify when needed', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم ربحي اليوم؟'));
  assert.equal(service.called('todayPerformance').length, 1);
  assert.ok(lastOut(fetchImpl).params.text.includes('+$650.00'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'ليش باع سهم NVDA؟'));
  assert.deepEqual(service.called('fills').pop()[1], { side: 'SELL', symbol: 'NVDA', period: 'all', limit: 1, offset: 0 });
  let t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('وقف الخسارة'));
  assert.ok(t.includes('لا يوجد قرار مسجل'), 'says clearly when no decision is recorded');
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'ليش باع سهم TSLA؟'));
  assert.ok(lastOut(fetchImpl).params.text.includes('لا توجد عملية بيع منفذة مسجلة'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'وش قرار الذكاء الاصطناعي على AMD؟'));
  t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('Recorded AMD rationale: higher lows') && t.includes('Gemini'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم استهلكنا من Gemini اليوم؟'));
  t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('استهلاك Gemini') && t.includes('$0.12 / $2.10') && t.includes('$0.42'), 'provider cost + combined cost');
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم صفقة خسرنا هذا الشهر؟'));
  assert.deepEqual(service.called('stats').pop()[1], { period: 'month' });
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'وش أكثر سهم ربحنا منه؟'));
  assert.ok(lastOut(fetchImpl).params.text.includes('<b>NVDA</b>'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم باقي عندي سيولة؟'));
  assert.ok(lastOut(fetchImpl).params.text.includes('<b>$5,000.00</b>'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'اعرض آخر خمس صفقات'));
  assert.equal(service.called('fills').pop()[1].limit, 5);
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'عطني كل أوامر البيع هذا الأسبوع'));
  assert.deepEqual(service.called('fills').pop()[1], { side: 'SELL', symbol: null, period: '7d', limit: 5, offset: 0 });
  // clarification with buttons
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم ربحي؟'));
  const out = lastOut(fetchImpl);
  const week = findButton(out, 'هذا الأسبوع');
  assert.equal(week.callback_data, 'q:pnl:week');
  await tg.handleUpdate(cb(PRIVATE, OWNER, week.callback_data));
  assert.deepEqual(service.called('stats').pop()[1], { period: 'week' });
  // missing ticker -> ask, then the typed ticker answers the pending question
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'ليش باع؟'));
  assert.ok(lastOut(fetchImpl).params.text.includes('أي سهم'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'NVDA'));
  assert.deepEqual(service.called('fills').pop()[1], { side: 'SELL', symbol: 'NVDA', period: 'all', limit: 1, offset: 0 });
  // unknown
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'شلونك'));
  assert.ok(lastOut(fetchImpl).params.text.includes('/help'));
  assert.ok(!service.calls.some((c) => c[0] === 'analyze' || c[0] === 'runAnalysis'));
});

test('new free-text intents are answered from service data (provider usage, best stock, last decision, weekly loss, exposure, news)', async () => {
  const { tg, fetchImpl, service } = setup();
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم استهلاك DeepSeek اليوم؟'));
  let t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('استهلاك DeepSeek') && t.includes('30 / 600') && t.includes('$0.30 / $6.00') && t.includes('$1.50 / $1.20'));
  assert.ok(t.includes('الميزانية حد إنفاق مضبوط داخل التطبيق'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم استهلاك Gemini؟'));
  t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('استهلاك Gemini') && t.includes('14 / 300') && t.includes('متوقف مؤقتًا بعد أخطاء حتى 1:30 م'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'وش أكثر سهم ربحنا منه؟'));
  assert.deepEqual(service.called('stats').pop()[1], { period: 'all' });
  t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('<b>NVDA</b> — الربح/الخسارة المحققة: +$300.00'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'وش آخر قرار على AMD؟'));
  assert.deepEqual(service.called('decisions').pop()[1], { symbol: 'AMD', kind: 'all', limit: 1, offset: 0 });
  t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('Recorded AMD rationale: higher lows') && t.includes('(Gemini)') && t.includes('اختلف النموذجان') && t.includes('لم يتم طلب تحليل جديد'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم خسرت هذا الأسبوع؟'));
  assert.deepEqual(service.called('stats').pop()[1], { period: 'week' });
  assert.ok(lastOut(fetchImpl).params.text.includes('صافي الربح/الخسارة: <b>+$650.00</b>'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'كم نسبة المحفظة المستثمرة؟'));
  t = lastOut(fetchImpl).params.text;
  assert.ok(t.includes('<b>53.05%</b>') && t.includes('$5,650.00') && t.includes('$600.00'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'وش آخر الأخبار؟'));
  assert.ok(lastOut(fetchImpl).params.text.includes('آخر الأخبار'));
  assert.equal(service.called('news').length, 1);
  // no positive symbol yet
  const s2 = setup({ service: makeService({ stats: ({ period }) => ({ period, bySymbol: [{ symbol: 'AMD', realizedPnl: -12.4, trades: 1 }], insufficient: {} }) }) });
  await s2.tg.handleUpdate(msg(PRIVATE, OWNER, 'وش أكثر سهم ربحنا منه؟'));
  assert.ok(lastOut(s2.fetchImpl).params.text.includes('لا يوجد سهم رابح بعد'));
  // unknown question keeps the menu/help fallback and never calls AI
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'وش رأيك في الطقس'));
  assert.ok(lastOut(fetchImpl).params.text.includes('/help'));
  assert.ok(!service.calls.some((c) => ['analyze', 'runAnalysis', 'setAiMode', 'pauseMonitoring'].includes(c[0])));
});

test('ticker prompts: an Arabic question is never taken as the pending ticker; typed tickers go through confirmation', async () => {
  const { tg, fetchImpl, service, db } = setup();
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'w:rm'));
  assert.ok(findButton(lastOut(fetchImpl), 'NVDA'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, 'ليش باع سهم NVDA؟'));
  assert.equal(db.db.prepare('SELECT COUNT(*) AS n FROM tg_nonces').get().n, 0, 'no removal confirmation from a question');
  assert.ok(lastOut(fetchImpl).params.text.includes('لماذا باع'));
  await tg.handleUpdate(cb(PRIVATE, OWNER, 'w:add'));
  await tg.handleUpdate(msg(PRIVATE, OWNER, '$msft'));
  assert.ok(lastOut(fetchImpl).params.text.includes('إضافة MSFT'));
  assert.equal(service.called('addSymbol').length, 0, 'still needs confirmation');
  await tg.handleUpdate(cb(PRIVATE, OWNER, findButton(lastOut(fetchImpl), 'تأكيد').callback_data));
  assert.deepEqual(service.called('addSymbol')[0].slice(1), ['MSFT']);
  assert.ok(lastOut(fetchImpl).params.text.includes('MSFT ضمن الأسهم المراقبة الآن'));
});

// ------------------------------------------------------------------ notifications
const fillEvent = (id, side = 'BUY', extra = {}) => ({
  id, type: 'FILL_EXECUTED', ts: T0, symbol: 'NVDA', priority: 'high',
  data: { fill: fill(`F-${id}`, side, 'NVDA'), partial: false, equity: 10650, cash: 5000 }, ...extra,
});

test('notifications: same event twice -> one message per chat; filters and mandatory types', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  const { tg, fetchImpl } = setup({ config });
  const id1 = tg.notify(fillEvent('e1'));
  assert.ok(Number.isInteger(id1));
  assert.equal(tg.notify(fillEvent('e1')), null, 'duplicate ignored');
  await tg._drain();
  const sends = fetchImpl.of('sendMessage');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.chat_id, '111');
  assert.equal(tg.status().sentToday, 1);
  // category off -> filtered, but FILL_EXECUTED is mandatory
  config.telegram.notifications.trades = false;
  config.telegram.notifications.news = false;
  assert.equal(tg.notify({ id: 'n1', type: 'NEWS_MATERIAL', ts: T0, symbol: 'NVDA', priority: 'normal', data: { title: 'x', source: 's', url: 'https://e.com', impact: 'HIGH' } }), null);
  assert.equal(tg.notify({ id: 'p1', type: 'PROPOSAL', ts: T0, symbol: 'NVDA', priority: 'normal', data: { action: 'BUY' } }), null);
  assert.ok(tg.notify(fillEvent('e2')));
  config.telegram.notifications.enabled = false;
  assert.equal(tg.notify(fillEvent('e3')), null, 'master switch off');
  assert.equal(tg.notify({ id: 'u1', type: 'SOMETHING_ELSE', ts: T0 }), null, 'unknown type');
});

test('notifications: per-chat spacing >= 1.1s and priority order', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  const { tg, fetchImpl, clock } = setup({ config });
  tg.notify({ id: 'low1', type: 'MARKET_SESSION', ts: T0, priority: 'low', data: { from: 'PRE', to: 'REGULAR' } });
  tg.notify({ id: 'risk1', type: 'RISK_LIMIT', ts: T0, priority: 'normal', data: { kind: 'DAILY_LOSS', message: 'حد الخسارة اليومية' } });
  await tg._drain();
  assert.equal(fetchImpl.of('sendMessage').length, 1);
  assert.ok(fetchImpl.of('sendMessage')[0].params.text.includes('تنبيه إدارة المخاطر'), 'high priority first');
  clock.t += 500;
  await tg._drain();
  assert.equal(fetchImpl.of('sendMessage').length, 1, 'spacing respected');
  clock.t += 700;
  await tg._drain();
  assert.equal(fetchImpl.of('sendMessage').length, 2);
});

test('notifications: low-priority events of the same type+symbol within 60s are grouped', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  const { tg, fetchImpl } = setup({ config });
  const a = tg.notify({ id: 'b1', type: 'BREAKOUT', ts: T0, symbol: 'AMD', priority: 'low', data: { type: 'BREAKOUT', level: 150, close: 151 } });
  const b = tg.notify({ id: 'b2', type: 'BREAKOUT', ts: T0, symbol: 'AMD', priority: 'low', data: { type: 'BREAKDOWN', level: 140, close: 139 } });
  assert.equal(a, b);
  assert.equal(tg.notify({ id: 'b2', type: 'BREAKOUT', ts: T0, symbol: 'AMD', priority: 'low', data: {} }), null);
  await tg._drain();
  const sends = fetchImpl.of('sendMessage');
  assert.equal(sends.length, 1);
  assert.ok(sends[0].params.text.includes('اختراق صاعد') && sends[0].params.text.includes('كسر هابط'));
});

test('notifications: HTTP 429 honours retry_after; 400 fails permanently; network errors back off', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  let mode = '429';
  const handler = (method) => {
    if (method !== 'sendMessage') return undefined;
    if (mode === '429') { mode = 'ok'; return { status: 429, body: { ok: false, error_code: 429, description: 'Too Many Requests: retry after 5', parameters: { retry_after: 5 } } }; }
    if (mode === '400') return { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request: chat not found' } };
    if (mode === 'net') throw new Error('socket hang up');
    return undefined;
  };
  const { tg, fetchImpl, clock, db } = setup({ config, handler });
  const id = tg.notify(fillEvent('r1'));
  await tg._drain();
  assert.equal(fetchImpl.of('sendMessage').length, 1);
  let row = db.db.prepare('SELECT * FROM tg_notifications WHERE id = ?').get(id);
  assert.equal(row.status, 'QUEUED');
  assert.equal(row.next_attempt_at, T0 + 5000);
  clock.t += 2000;
  await tg._drain();
  assert.equal(fetchImpl.of('sendMessage').length, 1, 'not retried before retry_after');
  clock.t += 3000;
  await tg._drain();
  assert.equal(fetchImpl.of('sendMessage').length, 2);
  row = db.db.prepare('SELECT * FROM tg_notifications WHERE id = ?').get(id);
  assert.equal(row.status, 'SENT');
  // 400 -> FAILED
  mode = '400';
  const id2 = tg.notify(fillEvent('r2'));
  clock.t += 2000;
  await tg._drain();
  row = db.db.prepare('SELECT * FROM tg_notifications WHERE id = ?').get(id2);
  assert.equal(row.status, 'FAILED');
  assert.ok(row.error.includes('chat not found'));
  assert.equal(tg.status().failed, 1);
  // network -> retried with exponential backoff, FAILED after 6 attempts
  mode = 'net';
  const id3 = tg.notify(fillEvent('r3'));
  for (let i = 0; i < 10; i++) { clock.t += 70 * 1000; await tg._drain(); }
  row = db.db.prepare('SELECT * FROM tg_notifications WHERE id = ?').get(id3);
  assert.equal(row.status, 'FAILED');
  assert.equal(row.attempts, 6);
});

test('notifications: queued rows survive a restart', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  const db = tempStore();
  const first = setup({ config, store: db });
  first.tg.notify(fillEvent('s1'));
  assert.equal(first.tg.status().queued, 1);
  const second = setup({ config, store: db });
  assert.equal(second.tg.status().queued, 1);
  await second.tg._drain();
  assert.equal(second.fetchImpl.of('sendMessage').length, 1);
  assert.equal(second.tg.status().queued, 0);
  assert.equal(second.tg.notify(fillEvent('s1')), null, 'still idempotent after restart');
});

test('notification templates: executed paper trade vs. unexecuted proposal / order states', () => {
  const tz = 'Asia/Riyadh';
  const buy = renderEvent(fillEvent('t1'), { tz }).text;
  assert.ok(buy.split('\n')[0].includes('تم تنفيذ صفقة شراء — صفقة افتراضية'));
  assert.ok(buy.includes('تداول ورقي'));
  assert.ok(buy.includes('$1,255.00'));
  assert.ok(buy.includes('مزود التحليل: DeepSeek') && buy.includes('التكلفة الإجمالية مع الرسوم: $1,256.00'));
  const sell = renderEvent(fillEvent('t2', 'SELL'), { tz }).text;
  assert.equal(sell.split('\n')[0], '<b>🛑 تم تنفيذ وقف الخسارة — صفقة افتراضية</b>', 'stop-loss sell says it was executed as a stop-loss');
  for (const s of ['متوسط سعر الشراء (التكلفة): $120.00', 'الربح/الخسارة المحققة: +$55.00', 'العائد على الصفقة: +4.58%', 'سبب البيع: 🛑 وقف خسارة', 'أمر حماية']) assert.ok(sell.includes(s), s);
  const sellFill = (kind, extra = {}) => ({ ...fillEvent(`k-${kind}`, 'SELL'), data: { fill: fill(`F-${kind}`, 'SELL', 'NVDA', { kind, exitTrigger: null, ...extra }), partial: false, equity: 1, cash: 1 } });
  assert.ok(renderEvent(sellFill('TRAILING_STOP'), { tz }).text.split('\n')[0].includes('📉 تم تنفيذ الوقف المتحرك — صفقة افتراضية'));
  assert.ok(renderEvent(sellFill('TAKE_PROFIT'), { tz }).text.split('\n')[0].includes('🎯 تم تنفيذ جني الأرباح — صفقة افتراضية'));
  const aiSell = renderEvent(sellFill('AI', { aiProvider: 'gemini' }), { tz }).text;
  assert.ok(aiSell.split('\n')[0].includes('🔴 <b>تم تنفيذ صفقة بيع — صفقة افتراضية</b>'));
  assert.ok(aiSell.includes('سبب البيع: 🤖 قرار الذكاء الاصطناعي') && aiSell.includes('مزود التحليل: Gemini'));
  assert.ok(!aiSell.includes('وقف الخسارة'));
  const prop = renderEvent({ id: 'p', type: 'PROPOSAL', ts: T0, symbol: 'AMD', data: { decisionId: 'D1', action: 'BUY', entry: 150, stop: 145, target: 160, confidence: 64, rationale: 'x' } }, { tz }).text;
  assert.ok(prop.includes('اقتراح من الذكاء الاصطناعي (لم يُنفذ)'));
  assert.ok(!prop.includes('تم تنفيذ'));
  for (const [type, word] of [['ORDER_PENDING', 'أمر معلق'], ['ORDER_CANCELLED', 'أمر ملغى'], ['ORDER_EXPIRED', 'أمر منتهي الصلاحية'], ['ORDER_REJECTED', 'أمر مرفوض']]) {
    const t = renderEvent({ id: type, type, ts: T0, symbol: 'AMD', data: { order: { id: 'O1', symbol: 'AMD', side: 'BUY', type: 'LIMIT', qty: 5, limitPrice: 140, status: 'PENDING', filledQty: 0, source: 'AI' } } }, { tz }).text;
    assert.ok(t.includes(word), type);
    assert.ok(t.includes('صفقة افتراضية'), `${type} carries the virtual-trade label`);
    assert.ok(!t.includes('تم تنفيذ'), `${type} must not imply execution`);
  }
  const big = renderEvent({ id: 'big', type: 'RISK_LIMIT', ts: T0, data: { message: 'x'.repeat(10000) } }, { tz }).text;
  assert.ok(big.length <= 4096);
});

test('notifications: AI_PROVIDER_DOWN / ENGINE_UNCLEAN_RESTART / ENGINE_CHECK_FAILED are mandatory; the new optional types respect their category', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  const { tg, fetchImpl, db } = setup({ config });
  const n = config.telegram.notifications;
  n.ai = false; n.data = false; n.market = false;
  const down = { id: 'aidown:gemini:1', type: 'AI_PROVIDER_DOWN', ts: T0, symbol: 'NVDA', priority: 'normal', data: { provider: 'gemini', name: 'Gemini', code: 'RATE_LIMIT', reason: '429 Too Many Requests', until: T0 + 30 * 60000 } };
  const idDown = tg.notify(down);
  assert.ok(idDown, 'sent although the ai category is off');
  assert.equal(tg.notify(down), null, 'deduplicated by event id');
  const idUnclean = tg.notify({ id: 'unclean1', type: 'ENGINE_UNCLEAN_RESTART', ts: T0, symbol: null, priority: 'low', data: { previousStartedAt: T0 - 3600000 } });
  assert.ok(idUnclean, 'sent although the data category is off');
  const idCheck = tg.notify({ id: 'chk1', type: 'ENGINE_CHECK_FAILED', ts: T0, symbol: null, priority: 'high', data: { problems: ['cash mismatch <x>', 'position mismatch'] } });
  assert.ok(idCheck);
  assert.equal(tg.notify({ id: 'rec1', type: 'AI_PROVIDER_RECOVERED', ts: T0, symbol: 'NVDA', priority: 'low', data: { provider: 'gemini', name: 'Gemini' } }), null, 'optional: ai off');
  assert.equal(tg.notify({ id: 'st1', type: 'ENGINE_STARTED', ts: T0, symbol: null, priority: 'normal', data: {} }), null, 'optional: data off');
  assert.equal(tg.notify({ id: 'mon1', type: 'MONITORING_STOPPED', ts: T0, symbol: null, priority: 'normal', data: { by: 'telegram' } }), null, 'optional: market off');
  for (const id of [idDown, idUnclean, idCheck]) assert.equal(db.db.prepare('SELECT priority FROM tg_notifications WHERE id = ?').get(id).priority, 0, 'mandatory = high priority');
  // categories on → optional types are sent; ENGINE_STARTED / AI_PROVIDER_RECOVERED are always low priority
  n.ai = true; n.data = true; n.market = true;
  const idRec = tg.notify({ id: 'rec2', type: 'AI_PROVIDER_RECOVERED', ts: T0, symbol: 'NVDA', priority: 'high', data: { provider: 'gemini', name: 'Gemini' } });
  const idStart = tg.notify({ id: 'st2', type: 'ENGINE_STARTED', ts: T0, symbol: null, priority: 'normal', data: {} });
  const idMon = tg.notify({ id: 'mon2', type: 'MONITORING_STOPPED', ts: T0, symbol: null, priority: 'normal', data: { by: 'telegram' } });
  assert.ok(idRec && idStart && idMon);
  assert.equal(db.db.prepare('SELECT priority FROM tg_notifications WHERE id = ?').get(idRec).priority, 2);
  assert.equal(db.db.prepare('SELECT priority FROM tg_notifications WHERE id = ?').get(idStart).priority, 2);
  // master switch still wins
  n.enabled = false;
  assert.equal(tg.notify({ ...down, id: 'aidown:deepseek:2' }), null);
  n.enabled = true;
  await tg._drain();
  const first = fetchImpl.of('sendMessage')[0].params.text;
  assert.ok(first.includes('Gemini') && first.includes('مؤقتًا بعد أخطاء'));
  // template content
  const tz = 'Asia/Riyadh';
  const td = renderEvent(down, { tz }).text;
  for (const s of ['تم إيقاف مزود الذكاء الاصطناعي <b>Gemini</b> مؤقتًا بعد أخطاء', 'RATE_LIMIT', 'تجاوز حد الطلبات', 'السبب: 429 Too Many Requests', 'متوقف حتى: 1:30 م',
    'سيُستخدم المزود الآخر إن كان متاحًا؛ مراقبة السوق وأوامر الحماية مستمرة']) assert.ok(td.includes(s), s);
  const tu = renderEvent({ id: 'u', type: 'ENGINE_UNCLEAN_RESTART', ts: T0, data: { previousStartedAt: T0 - 3600000 } }, { tz }).text;
  for (const s of ['أُعيد تشغيل محرك التداول بعد توقف غير متوقع', 'تمت استعادة المحفظة والمراكز المفتوحة من قاعدة البيانات', 'لم تُنفذ أي صفقة بأسعار فترة التوقف']) assert.ok(tu.includes(s), s);
  const tc = renderEvent({ id: 'c', type: 'ENGINE_CHECK_FAILED', ts: T0, data: { problems: ['cash mismatch <x>'] } }, { tz }).text;
  assert.ok(tc.includes('فشلت فحوصات بدء التشغيل') && tc.includes('لم يُستأنف التداول الآلي') && tc.includes('cash mismatch &lt;x&gt;'));
  assert.ok(renderEvent({ id: 's', type: 'ENGINE_STARTED', ts: T0, data: {} }, { tz }).text.includes('بدأ تشغيل الخادم'));
  assert.ok(renderEvent({ id: 'r', type: 'AI_PROVIDER_RECOVERED', ts: T0, data: { provider: 'deepseek', name: 'DeepSeek' } }, { tz }).text.includes('عاد مزود الذكاء الاصطناعي <b>DeepSeek</b>'));
  const ms = renderEvent({ id: 'm', type: 'MONITORING_STOPPED', ts: T0, data: { by: 'telegram' } }, { tz }).text;
  assert.ok(ms.includes('تم إيقاف مراقبة السوق مؤقتًا') && ms.includes('بواسطة: تيليجرام') && ms.includes('أوامر الحماية'));
  assert.ok(renderEvent({ id: 'm2', type: 'MONITORING_STARTED', ts: T0, data: { by: 'user' } }, { tz }).text.includes('تم استئناف مراقبة السوق'));
});

// ------------------------------------------------------------------ token safety
test('the bot token never appears in logs, errors, audit rows or status', async () => {
  const config = makeConfig();
  const handler = (method, params, url) => {
    if (method === 'answerCallbackQuery') return undefined;
    if (method === 'getUpdates' || method === 'setMyCommands' || method === 'getMe') throw new Error(`connect ECONNREFUSED ${url}`);
    if (method === 'sendMessage' && params.chat_id === '-100500') return { status: 400, body: { ok: false, error_code: 400, description: `Bad Request: bot${TOKEN} is not a member` } };
    if (method === 'sendMessage' && params.chat_id === '111' && /اتصال/.test(params.text)) throw new Error(`fetch failed for ${url}`);
    return undefined;
  };
  const { tg, logs, db, timers } = setup({ config, handler });
  const res = await tg.sendTest();
  assert.equal(res.ok, false);
  assert.equal(res.results.length, 2);
  await tg.handleUpdate(msg(STRANGER_CHAT, STRANGER, `/start ${TOKEN}`));
  await tg.handleUpdate(msg(PRIVATE, OWNER, '/pauseai'));
  tg.notify(fillEvent('tok1'));
  await tg._drain();
  const started = await tg.start();
  assert.equal(started.started, true);
  for (let i = 0; i < 5 && !tg.status().lastError; i++) await new Promise((r) => setImmediate(r));
  assert.ok(tg.status().lastError, 'poll error recorded');
  tg.stop();
  const everything = JSON.stringify({ res, logs, status: tg.status(), audit: db.db.prepare('SELECT * FROM tg_audit').all(), notif: db.db.prepare('SELECT * FROM tg_notifications').all() });
  assert.ok(!everything.includes(TOKEN), 'token leaked');
  assert.ok(!everything.includes('secretTokenValue'), 'token fragment leaked');
  assert.ok(everything.includes('<REDACTED>'), 'redaction marker present');
  assert.ok(timers.length > 0);
});

// ------------------------------------------------------------------ lifecycle
test('start() registers Arabic commands, long-polls with persisted offset, subscribes to events; stop() unsubscribes', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  let served = false;
  const handler = (method) => {
    if (method === 'getUpdates' && !served) { served = true; return { result: [{ update_id: 41, message: { message_id: 1, chat: PRIVATE, from: OWNER, text: '/status' } }] }; }
    return undefined;
  };
  const { tg, fetchImpl, service, db } = setup({ config, handler });
  assert.equal((await setup({ config: makeConfig({ enabled: false }) }).tg.start()).started, false);
  assert.equal((await setup({ config, token: null }).tg.start()).started, false);
  const r = await tg.start();
  assert.equal(r.started, true);
  for (let i = 0; i < 20 && fetchImpl.of('getUpdates').length < 1; i++) await new Promise((res) => setImmediate(res));
  for (let i = 0; i < 20 && service.called('status').length < 1; i++) await new Promise((res) => setImmediate(res));
  const smc = fetchImpl.of('setMyCommands');
  assert.equal(smc.length, 2);
  assert.equal(smc[0].params.language_code, 'ar');
  assert.equal(smc[1].params.language_code, undefined);
  assert.ok(smc[0].params.commands.some((c) => c.command === 'pauseai' && /[؀-ۿ]/.test(c.description)));
  assert.ok(smc[0].params.commands.some((c) => c.command === 'news' && /[؀-ۿ]/.test(c.description)), '/news registered');
  const gu = fetchImpl.of('getUpdates')[0].params;
  assert.equal(gu.timeout, 25);
  assert.deepEqual(gu.allowed_updates, ['message', 'callback_query']);
  assert.equal(gu.offset, 0);
  assert.equal(service.called('status').length, 1, '/status update handled');
  assert.equal(JSON.parse(db.db.prepare("SELECT value FROM tg_state WHERE key = 'poll_offset'").get().value), 42);
  assert.equal(service.listenerCount('event'), 1);
  service.emit('event', fillEvent('live1'));
  assert.equal(tg.status().queued, 1);
  assert.equal(tg.status().running, true);
  tg.stop();
  assert.equal(service.listenerCount('event'), 0);
  assert.equal(tg.status().running, false);
});

// ------------------------------------------------------------------ report scheduler
test('report scheduler queues the daily report once per local day (and survives restart)', async () => {
  const config = makeConfig({ authorizedChatIds: ['111'] });
  const db = tempStore();
  const a = setup({ config, store: db });
  a.clock.t = Date.UTC(2026, 10, 20, 16, 59); // 19:59 Riyadh
  assert.deepEqual(await a.tg._schedulerTick(), []);
  a.clock.t = Date.UTC(2026, 10, 20, 17, 5); // 20:05 Riyadh
  assert.deepEqual(await a.tg._schedulerTick(), ['report:daily:2026-11-20']);
  assert.deepEqual(await a.tg._schedulerTick(), []);
  assert.equal(a.service.called('report').length, 1);
  const rows = db.db.prepare("SELECT * FROM tg_notifications WHERE kind = 'REPORT_DAILY'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].idem_key, 'report:daily:2026-11-20:111');
  assert.ok(rows[0].text.includes('التقرير اليومي'));
  assert.ok(rows[0].text.includes('بتوقيت الرياض'));
  // restart: same store, same day -> nothing new
  const b = setup({ config, store: db });
  b.clock.t = Date.UTC(2026, 10, 20, 20, 0);
  assert.deepEqual(await b.tg._schedulerTick(), []);
  assert.equal(b.service.called('report').length, 0);
  // next local day after the configured time
  b.clock.t = Date.UTC(2026, 10, 21, 17, 1);
  assert.deepEqual(await b.tg._schedulerTick(), ['report:daily:2026-11-21']);
  // weekly on weeklyDay (5 = Friday) and monthly on the last day of the month
  config.telegram.reports = { daily: false, weekly: true, monthly: true, time: '20:00', timezone: 'Asia/Riyadh', weeklyDay: 5 };
  b.clock.t = Date.UTC(2026, 10, 27, 17, 30); // Friday 27 Nov
  assert.deepEqual(await b.tg._schedulerTick(), ['report:weekly:2026-11-27']);
  b.clock.t = Date.UTC(2026, 10, 30, 17, 30); // Monday 30 Nov = last day
  assert.deepEqual(await b.tg._schedulerTick(), ['report:monthly:2026-11-30']);
});

// ------------------------------------------------------------------ formatting
test('format helpers: money, signed money, percent, dates with timezone, HTML escaping, length cap', () => {
  assert.equal(F.money(1125), '$1,125.00');
  assert.equal(F.money(-12.4), '-$12.40');
  assert.equal(F.signedMoney(65), '+$65.00');
  assert.equal(F.signedMoney(-12.4), '-$12.40');
  assert.equal(F.pct(12.5), '+12.50%');
  assert.equal(F.money(null), 'غير متاح');
  assert.equal(F.esc('<b>&"'), '&lt;b&gt;&amp;&quot;');
  assert.equal(F.date(T0, 'Asia/Riyadh'), '20 نوفمبر 2026');
  assert.equal(F.time(T0, 'Asia/Riyadh'), '1:00 م');
  assert.equal(F.tzLabel('Asia/Riyadh'), 'بتوقيت الرياض');
  const long = Array.from({ length: 600 }, (_, i) => `<b>line ${i}</b> ${'x'.repeat(10)}`).join('\n');
  const fitted = F.fit(long);
  assert.ok(fitted.length <= 4096 && fitted.endsWith('…'));
  assert.equal((fitted.match(/<b>/g) || []).length, (fitted.match(/<\/b>/g) || []).length, 'no broken tags');
});

// ------------------------------------------------------------------ plain wording (hosted platform)
test('hosted: every command, every button and every notification uses plain wording only', async () => {
  const P = require('../server/telegram/plain');
  const S = require('../server/telegram/screens');
  const { tg, fetchImpl } = setup({ relay: true });
  const clean = (text, where) => {
    for (const line of String(text).split('\n')) {
      if (/<a href=/.test(line)) continue; // a headline
      const bare = line.replace(/<\/?(?:b|i|u)>/g, '').replace(/&\w+;/g, ' ').replace(/\/\w+/g, ' ');
      assert.ok(!P.TECH.test(bare) && !P.LATIN.test(bare) && !/الذكاء الاصطناعي|RISK_BLOCKED/.test(bare), where + ': ' + line);
    }
  };
  const seen = new Set();
  const queue = [];
  const collect = (where) => {
    for (const c of fetchImpl.calls) {
      if (c.params.text) clean(c.params.text, where);
      for (const b of ((c.params.reply_markup || {}).inline_keyboard || []).flat()) { clean(b.text, where + ' button'); if (!seen.has(b.callback_data)) { seen.add(b.callback_data); queue.push(b.callback_data); } }
    }
    fetchImpl.reset();
  };
  const commands = [...S.COMMANDS.map(([c]) => c), ...P.plainCommands(S.COMMANDS).map(([c]) => c)];
  for (const [c, d] of P.plainCommands(S.COMMANDS)) { clean(d, c); assert.ok(!/ai$|decisions|status|settings/.test(c), c); }
  for (const c of commands) { await tg.handleUpdate(msg(PRIVATE, OWNER, '/' + c + (/stock|pause$|resume$/.test(c) ? ' NVDA' : ''))); collect('/' + c); }
  for (const q of ['كم ربحي اليوم؟', 'كم استهلاك DeepSeek اليوم؟', 'وش آخر قرار على AMD؟', 'ليش بعنا NVDA؟', 'حالة النظام']) { await tg.handleUpdate(msg(PRIVATE, OWNER, q)); collect(q); }
  let n = 0;
  while (queue.length && n++ < 250) { const d = queue.shift(); await tg.handleUpdate(cb(PRIVATE, OWNER, d)); collect('button ' + d); }
  assert.ok(n > 25, 'the buttons were followed');
  const { CATEGORY } = require('../server/telegram/notifier');
  const data = { fill: fill('X', 'SELL', 'NVDA'), equity: 10650, order: { symbol: 'NVDA', side: 'BUY', reason: 'momentum', rejectReason: 'daily loss limit' }, action: 'BUY', from: 'WAIT', to: 'BUY', stop: 110, target: 150, message: 'DAILY LOSS LIMIT -3%', code: 'RATE_LIMIT', label: 'ALPACA IEX', detail: 'websocket closed', status: 'PASS', title: 'NVDA beats', url: 'https://example.com/a', type: 'BREAKOUT', level: 120, active: true, provider: 'deepseek', reason: '429', problems: ['x'] };
  let shown = 0;
  for (const type of Object.keys(CATEGORY)) { const r = P.plainEvent({ type, ts: T0, symbol: 'NVDA', data: ['AI_STATE'].includes(type) ? { to: 'PAUSED' } : type === 'MARKET_SESSION' ? { to: 'REGULAR' } : data }, { tz: 'Asia/Riyadh' }); if (r) { shown++; clean(r.text, type); assert.doesNotMatch(r.text, /undefined|null|غير متاح/, type); } }
  assert.ok(shown > 20);
  assert.equal(P.plainUpdate(msg(PRIVATE, OWNER, '/pauseauto')).message.text, '/pauseai');
});
