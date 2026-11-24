'use strict';
/**
 * Telegram companion bot for the PAPER-trading terminal.
 *
 * createTelegram({ store, service, getConfig, getToken, log, fetchImpl, now, setTimeoutImpl }) ->
 *   { start, stop, handleUpdate, notify, sendTest, status }
 *
 * - Read-only views of the service + confirmed controls (AI pause/resume/stop, AI provider mode, market monitoring,
 *   risk profile, watchlist).
 * - Never places, modifies or cancels orders: no such service method is ever called from here.
 * - The bot token only appears in request URLs; logs, errors, audit rows and return values are redacted.
 */
const crypto = require('node:crypto');
const F = require('./format');
const { createTgStore, PRIORITY } = require('./store');
const { createApi, makeRedactor } = require('./api');
const { renderEvent, createWorker, CATEGORY, MANDATORY, DEFAULT_PRIORITY, FIXED_PRIORITY } = require('./notifier');
const { createBot, toInlineKeyboard } = require('./bot');
const { createReportScheduler } = require('./scheduler');
const S = require('./screens');
const plain = require('./plain');

const TEST_TEXT = '✅ تم الاتصال بنجاح بين منصة فرصة وتيليجرام.\nستصلك هنا الإشعارات والتقارير حسب إعداداتك.\n🧪 تداول ورقي فقط — لا توجد أموال أو أوامر حقيقية.';
const POLL_TIMEOUT_S = 25;
const GROUP_WINDOW_MS = 60 * 1000;

function createTelegram({ store, service, getConfig, getToken, log, fetchImpl, now, setTimeoutImpl, relay = false } = {}) {
  const clock = typeof now === 'function' ? now : Date.now;
  const setT = typeof setTimeoutImpl === 'function' ? setTimeoutImpl : setTimeout;
  const rawLog = typeof log === 'function' ? log : () => {};
  const tokenFn = typeof getToken === 'function' ? getToken : () => null;

  let api = null;
  const knownToken = () => {
    try {
      const t = tokenFn();
      if (typeof t === 'string' && t) return t;
      if (t && typeof t.then === 'function') t.then(() => {}, () => {}); // async getToken: never leave a dangling rejection
    } catch { /* ignore */ }
    return api ? api.getLastToken() : null;
  };
  const redact = makeRedactor(knownToken);
  const safeLog = (level, message) => { try { rawLog(level, redact(String(message))); } catch { /* logger must never break us */ } };

  api = createApi({
    getToken: async () => { try { return await tokenFn(); } catch { return null; } },
    fetchImpl: fetchImpl || ((...a) => globalThis.fetch(...a)),
    redact,
  });
  if (relay) api = plain.plainApi(api); // hosted customers get plain wording only
  const tgStore = createTgStore(store, { redact });
  const tgCfg = () => { try { return ((getConfig && getConfig()) || {}).telegram || {}; } catch { return {}; } };
  const tzOf = (c) => F.safeTz((c.reports && c.reports.timezone) || F.DEFAULT_TZ);
  const chatsOf = (c) => [...new Set((c.authorizedChatIds || []).map((x) => String(x).trim()).filter(Boolean))];

  let running = false;
  let lastPollAt = null;
  let lastError = null;
  let pollAbort = null;
  let subscribed = false;
  const sleepers = new Set();

  const worker = createWorker({ tgStore, api, now: clock, setTimeoutImpl: setT, log: safeLog, isEnabled: () => !!tgCfg().enabled, redact });

  function status() {
    const c = tgCfg();
    const counts = (() => { try { return tgStore.counts(); } catch { return { queued: 0, failed: 0 }; } })();
    let sentToday = 0;
    try { sentToday = tgStore.sentSince(F.startOfLocalDay(clock(), tzOf(c))); } catch { sentToday = 0; }
    return { running, lastPollAt, lastError, queued: counts.queued, failed: counts.failed, sentToday };
  }

  const bot = createBot({ tgStore, api, service, getConfig, now: clock, log: safeLog, redact, getQueueStatus: status });

  // ---------------------------------------------------------------- notifications
  function eventId(ev) {
    if (ev.id != null && String(ev.id).length) return String(ev.id).slice(0, 200);
    return 'h' + crypto.createHash('sha256').update(JSON.stringify([ev.type, ev.symbol, ev.ts, ev.data])).digest('hex').slice(0, 24);
  }

  function notify(event) {
    try {
      if (!event || typeof event !== 'object' || typeof event.type !== 'string') return null;
      const c = tgCfg();
      if (!c.enabled) return null;
      const n = c.notifications || {};
      if (!n.enabled) return null;
      const cat = CATEGORY[event.type];
      if (!cat) return null;
      if (!MANDATORY.has(event.type) && n[cat] === false) return null;
      const chats = chatsOf(c);
      if (!chats.length) return null;
      const rendered = relay ? plain.plainEvent(event, { tz: tzOf(c), demo: !!(service && service.session && service.session.dataMode !== 'LIVE') }) : renderEvent(event, { tz: tzOf(c), redact });
      if (!rendered) return null;
      const prioName = MANDATORY.has(event.type) ? 'high'
        : (FIXED_PRIORITY[event.type] || (Object.prototype.hasOwnProperty.call(PRIORITY, event.priority) ? event.priority : (DEFAULT_PRIORITY[event.type] || 'normal')));
      const prio = PRIORITY[prioName];
      const evId = eventId(event);
      const sym = event.symbol ? String(event.symbol) : null;
      let firstId = null;
      for (const chatId of chats) {
        const idemKey = `${evId}:${chatId}`;
        if (tgStore.hasIdem(idemKey)) continue;
        let id = null;
        if (prioName === 'low') {
          const g = tgStore.findGroupable({ chatId, kind: event.type, symbol: sym || '', since: clock() - GROUP_WINDOW_MS, priority: prio });
          if (g && g.text.length + rendered.text.length + 2 <= 3800) {
            tgStore.updateText(g.id, `${g.text}\n\n${rendered.text}`);
            tgStore.enqueue({ idemKey, priority: prio, kind: event.type, chatId, text: rendered.text, replyMarkup: null, now: clock(), symbol: sym, status: 'SKIPPED', error: `GROUPED_INTO:${g.id}` });
            id = g.id;
          }
        }
        if (id == null) id = tgStore.enqueue({ idemKey, priority: prio, kind: event.type, chatId, text: rendered.text, replyMarkup: rendered.replyMarkup, now: clock(), symbol: sym });
        if (id != null && firstId == null) firstId = id;
      }
      if (firstId != null) worker.kick();
      return firstId;
    } catch (e) {
      safeLog('warn', `telegram: notify failed: ${e && e.message}`);
      return null;
    }
  }

  function enqueueReport({ key, kind, report, chats, tz }) {
    const scr = S.renderReport({ kind, ...report }, tz, { forNotification: true });
    const markup = toInlineKeyboard(scr.keyboard);
    for (const chatId of chats) {
      tgStore.enqueue({ idemKey: `${key}:${chatId}`, priority: PRIORITY.normal, kind: `REPORT_${String(kind).toUpperCase()}`, chatId, text: scr.text, replyMarkup: markup, now: clock(), symbol: null });
    }
    worker.kick();
  }

  const scheduler = createReportScheduler({ tgStore, service, getTgConfig: tgCfg, now: clock, setTimeoutImpl: setT, log: safeLog, redact, enqueueReport });

  // ---------------------------------------------------------------- polling
  function sleep(ms) {
    return new Promise((resolve) => {
      const done = () => { sleepers.delete(done); resolve(); };
      sleepers.add(done);
      const h = setT(done, ms);
      if (h && typeof h.unref === 'function') h.unref();
    });
  }

  async function registerCommands() {
    const commands = S.COMMANDS.map(([command, description]) => ({ command, description: description.slice(0, 256) }));
    for (const extra of [{ language_code: 'ar' }, {}]) {
      try { await api.call('setMyCommands', { commands, ...extra }); } catch (e) { safeLog('warn', `telegram: setMyCommands failed: ${e.message}`); }
    }
    try {
      const me = await api.call('getMe', {});
      if (me && me.username) bot.setBotUsername(me.username);
    } catch (e) { safeLog('warn', `telegram: getMe failed: ${e.message}`); }
  }

  async function pollOnce() {
    const offset = Number(tgStore.getState('poll_offset', 0)) || 0;
    pollAbort = new AbortController();
    const started = clock();
    let updates;
    try {
      updates = await api.call('getUpdates', { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
        { timeoutMs: (POLL_TIMEOUT_S + 15) * 1000, signal: pollAbort.signal });
    } finally {
      pollAbort = null;
    }
    lastPollAt = clock();
    lastError = null;
    const list = Array.isArray(updates) ? updates : [];
    for (const u of list) {
      if (!running) break;
      // at-most-once: advance the persisted offset before handling so a poison update can never loop
      if (u && Number.isInteger(u.update_id)) tgStore.setState('poll_offset', u.update_id + 1);
      await bot.handleUpdate(u);
    }
    return { count: list.length, elapsed: clock() - started };
  }

  let loopGen = 0;
  async function pollLoop() {
    const myGen = ++loopGen;
    let backoff = 0;
    while (running && myGen === loopGen) {
      try {
        if (!tgCfg().enabled) { await sleep(5000); continue; }
        const r = await pollOnce();
        backoff = 0;
        if (running && myGen === loopGen) await sleep(r.count === 0 && r.elapsed < 1000 ? 1000 : 0);
      } catch (e) {
        if (!running) break;
        lastError = redact(e && e.message ? e.message : String(e));
        safeLog('warn', `telegram: polling error: ${lastError}`);
        if (e && e.status === 409) backoff = 30000;
        else if (e && (e.status === 401 || e.status === 404 || e.kind === 'NO_TOKEN')) backoff = 5 * 60 * 1000;
        else if (e && e.status === 429) backoff = Math.max(1000, (Number(e.retryAfter) || 5) * 1000);
        else backoff = Math.min(backoff ? backoff * 2 : 1000, 60000);
        await sleep(backoff);
      }
    }
  }

  function onServiceEvent(ev) { notify(ev); }

  async function start() {
    try {
      if (running) return { started: true, already: true };
      const c = tgCfg();
      if (!c.enabled) return { started: false, reason: 'disabled' };
      let token = null;
      try { token = await tokenFn(); } catch { token = null; }
      if (!token) return { started: false, reason: 'no_token' };
      running = true;
      lastError = null;
      if (service && typeof service.on === 'function' && !subscribed) { service.on('event', onServiceEvent); subscribed = true; }
      worker.start();
      scheduler.start();
      if (relay) { lastPollAt = clock(); return { started: true }; } // the platform receives the messages and hands them over
      registerCommands().catch((e) => safeLog('warn', `telegram: command registration failed: ${e && e.message}`));
      pollLoop().catch((e) => { lastError = redact(e && e.message); safeLog('error', `telegram: polling loop crashed: ${lastError}`); });
      safeLog('info', 'telegram: bot started (paper trading companion)');
      return { started: true };
    } catch (e) {
      lastError = redact(e && e.message);
      safeLog('error', `telegram: start failed: ${lastError}`);
      return { started: false, reason: 'error' };
    }
  }

  function stop() {
    try {
      running = false;
      if (pollAbort) { try { pollAbort.abort(); } catch { /* ignore */ } }
      for (const wake of [...sleepers]) wake();
      worker.stop();
      scheduler.stop();
      if (subscribed && service) {
        if (typeof service.off === 'function') service.off('event', onServiceEvent);
        else if (typeof service.removeListener === 'function') service.removeListener('event', onServiceEvent);
        subscribed = false;
      }
    } catch (e) {
      safeLog('warn', `telegram: stop error: ${e && e.message}`);
    }
  }

  async function sendTest() {
    const c = tgCfg();
    const chats = chatsOf(c);
    const results = [];
    for (const chatId of chats) {
      try {
        await api.call('sendMessage', { chat_id: chatId, text: TEST_TEXT, disable_web_page_preview: true });
        results.push({ chatId, ok: true, error: null });
      } catch (e) {
        results.push({ chatId, ok: false, error: redact(e && e.message ? e.message : String(e)) });
      }
    }
    const out = { ok: results.length > 0 && results.every((r) => r.ok), results };
    if (!chats.length) out.error = 'لا توجد محادثات مصرح لها في الإعدادات.';
    return out;
  }

  return {
    start,
    stop,
    handleUpdate: (u) => bot.handleUpdate(relay ? plain.plainUpdate(u) : u),
    notify,
    sendTest,
    status,
    // test / maintenance hooks (not part of the public contract)
    _drain: () => worker.drainOnce(),
    _schedulerTick: () => scheduler.tick(),
    _store: tgStore,
  };
}

module.exports = { createTelegram };
