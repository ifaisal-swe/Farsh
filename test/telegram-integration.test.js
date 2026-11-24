'use strict';
const { tempStore } = require('./helpers/db');
/** Telegram bot wired to the REAL engine (desk + service + database); only the Telegram HTTP API is faked. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/db');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { Desk } = require('../server/engine/desk');
const { TerminalService } = require('../server/services/terminalService');
const { Redactor } = require('../server/util/misc');
const { AnalysisScheduler } = require('../server/ai/scheduler');
const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
const { createTelegram } = require('../server/telegram');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

const origStart = AnalysisScheduler.prototype.start;
test.before(() => { AnalysisScheduler.prototype.start = function () { this.running = false; }; });
test.after(() => { AnalysisScheduler.prototype.start = origStart; });

class Fake2 extends FakeProvider {
  connect() { this.state = 'SUBSCRIBED'; this.emit('connection', { state: 'SUBSCRIBED', detail: 'test' }); }
}

async function setup() {
  const store = tempStore();
  const clock = { t: T0, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  config.update({ risk: { ...LEGACY_DEFAULTS, profile: 'CUSTOM' }, telegram: { enabled: true, authorizedChatIds: ['111'], authorizedUserIds: ['111'] } });
  let desk;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (desk && desk.book.session ? desk.book.session.id : null) });
  const provider = new Fake2({ clock });
  const decider = new ScriptedDecider();
  desk = new Desk({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  desk.primary.news.start = () => {};
  const service = new TerminalService({ desk, store, config, secrets, now: () => clock.now() });
  const sent = [];
  let mid = 100;
  const fetchImpl = async (url, opts) => {
    const method = url.split('/').pop();
    const body = opts && opts.body ? JSON.parse(opts.body) : {};
    sent.push({ method, body });
    const result = method === 'getMe' ? { id: 1, username: 'testbot', is_bot: true } : method === 'getUpdates' ? [] : { message_id: ++mid };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }), text: async () => JSON.stringify({ ok: true, result }) };
  };
  const tg = createTelegram({ store, service, getConfig: () => config.get(), getToken: () => '123456:TEST-TOKEN-abcdefghijklmnop', log: () => {}, fetchImpl, now: () => clock.now() });
  await desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  provider.quote(99.98, 100.02); provider.trade(100);
  decider.push((s) => buyProposal(s));
  await desk.primary.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  let uid = 1;
  const msg = (text) => tg.handleUpdate({ update_id: uid++, message: { message_id: uid, date: Math.floor(T0 / 1000), from: { id: 111, is_bot: false, first_name: 'T' }, chat: { id: 111, type: 'private' }, text } });
  const press = (data, messageId = 101) => tg.handleUpdate({ update_id: uid++, callback_query: { id: `cb${uid}`, from: { id: 111, is_bot: false }, data, message: { message_id: messageId, chat: { id: 111, type: 'private' }, date: Math.floor(T0 / 1000), text: 'x' } } });
  const texts = () => sent.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText').map((x) => x.body.text);
  return { store, desk, service, tg, sent, msg, press, texts, clock, provider };
}

test('Telegram answers from the real portfolio, orders and statistics', async () => {
  const c = await setup();
  const v = c.desk.primary.valuation();
  await c.msg('/start');
  const menu = c.sent.find((x) => x.method === 'sendMessage' && /فرصة/.test(x.body.text));
  assert.ok(menu, 'welcome message');
  assert.ok(JSON.stringify(menu.body.reply_markup).includes('💼 المحفظة'));
  await c.msg('/portfolio');
  const pf = c.texts().find((t) => /المحفظة الافتراضية|المحفظة/.test(t) && /السيولة المتاحة/.test(t));
  assert.ok(pf, 'portfolio screen');
  const cash = v.cash.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(pf.includes(cash), `portfolio shows the real cash ${cash}`);
  await c.msg('/buys');
  const buys = c.texts().find((t) => /الشراء/.test(t) && /TEST/.test(t) && /سعر التنفيذ/.test(t));
  assert.ok(buys && /100\.04/.test(buys), 'buy list shows the real execution price');
  await c.msg('/stats');
  assert.ok(c.texts().some((t) => /بيانات غير كافية/.test(t)), 'no closed trades yet → insufficient data, not invented numbers');
  await c.msg('كم باقي عندي سيولة؟');
  assert.ok(c.texts().some((t) => t.includes(cash)), 'free-text question answered from the database');
});

test('Telegram /pauseai needs confirmation, runs once, and pauses the real engine', async () => {
  const c = await setup();
  assert.equal(c.desk.book.aiState, 'RUNNING');
  await c.msg('/pauseai');
  assert.equal(c.desk.book.aiState, 'RUNNING', 'nothing happens before confirmation');
  const conf = [...c.sent].reverse().find((x) => x.body.reply_markup && JSON.stringify(x.body.reply_markup).includes('تأكيد'));
  const btn = conf.body.reply_markup.inline_keyboard.flat().find((b) => /تأكيد/.test(b.text));
  await c.press(btn.callback_data);
  assert.equal(c.desk.book.aiState, 'PAUSED');
  c.desk.resume();
  await c.press(btn.callback_data);
  assert.equal(c.desk.book.aiState, 'RUNNING', 'a replayed confirmation is not executed again');
  assert.ok(c.store.db.prepare('SELECT COUNT(*) n FROM tg_audit').get().n >= 1, 'audited');
});

test('Telegram /ai, /status and /news render from the real service; AI mode and monitoring changes need confirmation and run once', async () => {
  const c = await setup();
  const failed = () => c.texts().filter((t) => /تعذر جلب البيانات/.test(t));
  await c.msg('/ai');
  const ai = c.texts().pop();
  assert.ok(ai.includes('وضع الذكاء الاصطناعي') && ai.includes('DeepSeek') && ai.includes('Gemini'), 'AI screen with provider blocks');
  assert.ok(ai.includes('الميزانية حد إنفاق مضبوط داخل التطبيق'));
  await c.msg('/status');
  const st = c.texts().pop();
  assert.ok(st.includes('مراقبة السوق') && st.includes('التداول الآلي'), 'operating states');
  assert.ok(st.includes('تفاصيل مكونات النظام غير متاحة'), 'no HTTP health provider in this test → handled as null');
  await c.msg('/news');
  assert.ok(c.texts().pop().includes('آخر الأخبار'));
  await c.msg('/portfolio');
  assert.ok(c.texts().pop().includes('النقد المحجوز'));
  await c.msg('/buys');
  assert.ok(c.texts().pop().includes('مزود التحليل'));
  assert.deepEqual(failed(), [], 'every screen rendered from the real service');
  // AI mode via confirmation, exactly once
  let calls = 0;
  const orig = c.service.setAiMode.bind(c.service);
  c.service.setAiMode = (...a) => { calls++; return orig(...a); };
  await c.press('aim:DUAL');
  assert.equal(calls, 0, 'nothing before confirmation');
  const conf = [...c.sent].reverse().find((x) => x.body.reply_markup && JSON.stringify(x.body.reply_markup).includes('y:'));
  const yes = conf.body.reply_markup.inline_keyboard.flat().find((b) => /تأكيد/.test(b.text));
  await c.press(yes.callback_data);
  assert.equal(calls, 1);
  assert.equal(c.service.ai().aiMode, 'DUAL');
  assert.equal(c.service.status().aiMode, 'DUAL');
  assert.ok(c.texts().pop().includes('تم التحقق'), 'verified against the real status');
  await c.press(yes.callback_data);
  assert.equal(calls, 1, 'replayed confirmation is not executed again');
  // market monitoring pause through the same confirmation flow
  await c.press('mon:pause');
  assert.equal(c.desk.book.monitoringPaused || false, false);
  const conf2 = [...c.sent].reverse().find((x) => x.body.reply_markup && JSON.stringify(x.body.reply_markup).includes('y:'));
  await c.press(conf2.body.reply_markup.inline_keyboard.flat().find((b) => /تأكيد/.test(b.text)).callback_data);
  assert.equal(c.desk.book.monitoringPaused, true);
  assert.equal(c.service.status().operating.monitoring.state, 'PAUSED');
  const audit = c.store.db.prepare("SELECT action, result FROM tg_audit WHERE action IN ('SET_AI_MODE','PAUSE_MONITORING') ORDER BY id").all().map((r) => `${r.action}:${r.result}`);
  assert.deepEqual(audit, ['SET_AI_MODE:CONFIRM_REQUESTED', 'SET_AI_MODE:OK', 'SET_AI_MODE:ALREADY_HANDLED', 'PAUSE_MONITORING:CONFIRM_REQUESTED', 'PAUSE_MONITORING:OK']);
});

test('a paper fill produces exactly one Telegram notification', async () => {
  const c = await setup();
  const evts = [];
  c.service.on('event', (e) => evts.push(e));
  c.service.emit('event', { id: 'fill:x1', type: 'FILL_EXECUTED', ts: T0, symbol: 'TEST', priority: 'high', data: { fill: c.service.fills({}).items[0], partial: false, equity: 1, cash: 1 } });
  const id1 = c.tg.notify(evts[0]);
  const id2 = c.tg.notify(evts[0]);
  assert.ok(id1);
  assert.equal(id2, null, 'duplicate event ignored');
});
