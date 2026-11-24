'use strict';
/**
 * Adaptive market monitoring. Everything is deterministic: mocked clock, mocked exchange calendar, mocked
 * market data, no network. No test depends on whether the US market is open while it runs.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { Store } = require('../server/db');
const { ConfigManager, DEFAULTS: CFG_DEFAULTS, validatePatch, deepMerge } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { Desk } = require('../server/engine/desk');
const { TerminalService } = require('../server/services/terminalService');
const { createTelegram } = require('../server/telegram');
const { renderEvent, CATEGORY } = require('../server/telegram/notifier');
const { Redactor } = require('../server/util/misc');
const { AnalysisScheduler } = require('../server/ai/scheduler');
const { FORCE_TRIGGERS } = require('../server/ai/costControl');
const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
const { MarketCalendar } = require('../server/market/session');
const { etWallToUtcMs, etDateStr } = require('../server/util/time');
const { createTerminal } = require('../server/app');
const { fetchJson } = require('../server/util/http');
const AM = require('../server/market/adaptiveMonitoring');
const { FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

const { MODE } = AM;
const et = (d, h, m = 0) => etWallToUtcMs(d, h, m);
const DAY = '2026-11-18'; // Wednesday

// ------------------------------------------------------------------ scheduler stub: records jobs, never runs them
const real = { start: AnalysisScheduler.prototype.start, pump: AnalysisScheduler.prototype.pump };
test.before(() => {
  AnalysisScheduler.prototype.start = function () { this.running = true; };
  AnalysisScheduler.prototype.pump = function () {
    if (!this.running || this.inFlight || !this.pending) return;
    (this.jobs = this.jobs || []).push(this.pending);
    this.inFlight = this.pending; this.pending = null; this.lastStartAt = this.now();
  };
});
test.after(() => { Object.assign(AnalysisScheduler.prototype, real); });

// ------------------------------------------------------------------ exchange calendar (Thanksgiving week 2026)
function calendarRows(from, to) {
  const out = [];
  for (let t = Date.parse(`${from}T12:00:00Z`); t <= Date.parse(`${to}T12:00:00Z`); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    const wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6 || d === '2026-11-26') continue;
    out.push({ date: d, open: '09:30', close: d === '2026-11-27' ? '13:00' : '16:00', session_open: '0400', session_close: d === '2026-11-27' ? '1700' : '2000' });
  }
  return out;
}
async function calendar(now, opts = {}) {
  const cal = new MarketCalendar({ fetchCalendar: async (a, b) => calendarRows(a, b), ...opts });
  await cal.load(now);
  return cal;
}
const modeAt = (cal, t, c) => AM.sessionMode(cal.info(t), t, c || AM.DEFAULTS).mode;

// ------------------------------------------------------------------ desk laboratory
const calmBar = (time, base = 100, v = 1000) => { const k = (time / 60) % 2 ? 0.01 : -0.01; return { time, open: base - k, high: base + 0.05, low: base - 0.05, close: base + k, volume: v, vw: base, trades: 20 }; };
function history(days, base = 100) {
  const out = [];
  for (const d of days) for (let t = et(d, 9, 30) / 1000; t < et(d, 16, 0) / 1000; t += 60) out.push(calmBar(t, base));
  return out;
}
function dailyBars(n = 40) {
  const out = [];
  for (let i = n; i >= 1; i--) { const t = et('2026-11-18', 0, 0) / 1000 - i * 86400; out.push({ time: t, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1e6 }); }
  return out;
}
class LabProvider extends FakeProvider {
  connect() { this.state = 'SUBSCRIBED'; this.emit('connection', { state: 'SUBSCRIBED', detail: 'test feed' }); }
  async fetchAsset(symbol) { return { symbol, name: `${symbol} Inc`, exchange: 'NASDAQ', status: 'active', tradable: true, fractionable: true }; }
  async fetchCalendar(a, b) { return calendarRows(a, b); }
  q(symbol, bid, ask) { const t = this.clock.now(); this.emit('quote', { symbol, bid, ask, bidSize: 500, askSize: 500, ts: t, receivedAt: t }); }
  t(symbol, price) { const t = this.clock.now(); this.emit('trade', { symbol, price, size: 100, ts: t, receivedAt: t }); }
}
async function lab({ at = et(DAY, 9, 30), symbols = ['TEST'], file = ':memory:', decider = new ScriptedDecider(), config: over = {}, start = true, keys = true, days = ['2026-11-16', '2026-11-17'], autoTimers = false, runtime = {} } = {}) {
  const store = new Store(file);
  const clock = { t: at, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { ...(keys ? { DEEPSEEK_API_KEY: 'sk-test-not-real-0000' } : {}), TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, deepMerge({ news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } }, runtime));
  config.update(deepMerge({ risk: { ...LEGACY_DEFAULTS, maxOpenPositions: 2, profile: 'CUSTOM', ipoMode: { enabled: 'off' } }, ai: { usageMode: 'ECONOMY' } }, over));
  let desk;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (desk && desk.book.session ? desk.book.session.id : null) });
  const provider = new LabProvider({ clock, minutes: history(days), daily: dailyBars() });
  const events = [];
  desk = new Desk({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, fetchImpl: silentFetch, autoTimers, deciderOverride: decider });
  desk.primary.news.start = () => {};
  const spawn = desk.spawn.bind(desk);
  desk.spawn = async (s, o) => { const a = await spawn(s, o); a.news.start = () => {}; a.news.stop(); return a; };
  desk.on('appEvent', (e) => events.push(e));
  const L = {
    store, clock, config, activity, provider, desk, events, mon: desk.monitor, minute: Math.floor(at / 60000) * 60, last: {},
    logs: () => store.listActivity(null, 5000).map((e) => e.message),
    settle() { for (const a of desk.all()) { a.scheduler.inFlight = null; a.scheduler.pending = null; a.scheduler.lastStartAt = 0; a.scheduler.jobs = []; } },
    idle() { for (const a of desk.all()) a.scheduler.inFlight = null; },
    jobs(sym = 'TEST') { return (desk.agent(sym).scheduler.jobs || []).flatMap((j) => j.reasons); },
    signals(sym = 'TEST') { return L.jobs(sym).filter((r) => /^SIGNAL_/.test(r.type)); },
    tick() { for (const a of desk.all()) a.tick(); },
    /** One completed minute for every symbol ({ SYM: { c, h, l, v } } overrides a calm candle). */
    step(over2 = {}) {
      const m = L.minute;
      clock.t = (m + 60) * 1000 + 4500; // the candle store closes a minute 4 s after its end
      for (const a of desk.all()) {
        const o = over2[a.symbol];
        if (o === null) continue; // no trades in this minute
        const prev = L.last[a.symbol] || 100;
        const b = o ? { time: m, open: prev, close: o.c, high: o.h != null ? o.h : Math.max(prev, o.c) + 0.02, low: o.l != null ? o.l : Math.min(prev, o.c) - 0.02, volume: o.v != null ? o.v : 1000, vw: o.c, trades: 20 } : calmBar(m, prev === 100 ? 100 : prev);
        L.last[a.symbol] = o ? b.close : prev;
        provider.emit('bar', { ...b, symbol: a.symbol });
        if (L.quotes !== false) { provider.q(a.symbol, +(b.close - 0.02).toFixed(2), +(b.close + 0.02).toFixed(2)); provider.t(a.symbol, b.close); }
      }
      L.minute += 60;
      L.tick();
      clock.t += 2000; // events of all symbols settle, then the best ones are dispatched
      L.tick();
    },
    calm(n, over3 = {}) { for (let i = 0; i < n; i++) L.step(over3); },
    status: () => desk.monitor.status(),
  };
  desk.monitor.load();
  if (start) {
    await desk.startTrading({ symbol: symbols[0], initialCapital: 10000 });
    for (const s of symbols.slice(1)) await desk.addSymbol(s);
    for (const a of desk.all()) { provider.q(a.symbol, 99.98, 100.02); provider.t(a.symbol, 100); }
    L.settle();
  }
  return L;
}
const BREAKOUT = { c: 100.6, h: 100.62, l: 99.98, v: 5000 };

// ================================================================== session modes (1–10)
test('1–6: session modes follow the exchange calendar through a whole trading day', async () => {
  const cal = await calendar(et(DAY, 8), { overnight: { enabled: true } });
  const at = (h, m) => modeAt(cal, et(DAY, h, m));
  assert.equal(at(8, 59), MODE.AFTER, 'early pre-market: extended hours');
  assert.equal(at(9, 0), MODE.PRE);
  assert.equal(at(9, 29), MODE.PRE);
  assert.equal(at(9, 30), MODE.OPENING);
  assert.equal(at(9, 59), MODE.OPENING);
  assert.equal(at(10, 0), MODE.POST_OPEN, 'after the first 30 minutes');
  assert.equal(at(10, 59), MODE.POST_OPEN);
  assert.equal(at(11, 0), MODE.NORMAL);
  assert.equal(at(13, 0), MODE.NORMAL, 'midday');
  assert.equal(at(15, 29), MODE.NORMAL);
  assert.equal(at(15, 30), MODE.CLOSING);
  assert.equal(at(15, 59), MODE.CLOSING);
  assert.equal(at(16, 0), MODE.AFTER, 'after the close');
  assert.equal(at(21, 0), MODE.AFTER, 'overnight session: reference data only');
  // durations are configurable
  const c = { ...AM.DEFAULTS, openingMin: 15, postOpenMin: 15, closingMin: 60, preMarketMin: 10 };
  assert.equal(modeAt(cal, et(DAY, 9, 46), c), MODE.POST_OPEN);
  assert.equal(modeAt(cal, et(DAY, 10, 1), c), MODE.NORMAL);
  assert.equal(modeAt(cal, et(DAY, 15, 1), c), MODE.CLOSING);
  assert.equal(modeAt(cal, et(DAY, 9, 15), c), MODE.AFTER);
});

test('7–8: weekends and market holidays are closed; the next transition skips them', async () => {
  const cal = await calendar(et('2026-11-20', 12));
  assert.equal(modeAt(cal, et('2026-11-21', 12)), MODE.CLOSED, 'Saturday');
  assert.equal(modeAt(cal, et('2026-11-22', 12)), MODE.CLOSED, 'Sunday');
  const n = AM.nextTransition(cal, et('2026-11-21', 12));
  assert.equal(n.at, et('2026-11-23', 4), 'Monday pre-market');
  const cal2 = await calendar(et('2026-11-25', 12));
  assert.equal(modeAt(cal2, et('2026-11-26', 11)), MODE.CLOSED, 'Thanksgiving');
  assert.match(cal2.info(et('2026-11-26', 11)).reason, /holiday/i);
  assert.equal(AM.nextTransition(cal2, et('2026-11-26', 11)).at, et('2026-11-27', 4));
  // Sunday evening: the overnight session is a transition, and it is reference-only
  const on = await calendar(et('2026-11-22', 12), { overnight: { enabled: true } });
  assert.deepEqual(AM.nextTransition(on, et('2026-11-22', 12)), { at: et('2026-11-22', 20), mode: MODE.AFTER });
});

test('9: early close moves the closing phase; an unscheduled early close from the official clock wins', async () => {
  const cal = await calendar(et('2026-11-27', 8));
  assert.equal(modeAt(cal, et('2026-11-27', 12, 29)), MODE.NORMAL);
  assert.equal(modeAt(cal, et('2026-11-27', 12, 30)), MODE.CLOSING);
  assert.equal(modeAt(cal, et('2026-11-27', 13, 0)), MODE.AFTER);
  assert.match(AM.closingEntryBlock(cal.info(et('2026-11-27', 12, 55)), et('2026-11-27', 12, 55), AM.DEFAULTS), /last 10 minutes/);
  const c2 = await calendar(et(DAY, 13), { fetchClock: async () => ({ is_open: true, timestamp: new Date(et(DAY, 13)).toISOString(), next_open: new Date(et('2026-11-19', 9, 30)).toISOString(), next_close: new Date(et(DAY, 14)).toISOString() }) });
  await c2.syncClock(et(DAY, 13), () => et(DAY, 13));
  assert.equal(modeAt(c2, et(DAY, 13, 35)), MODE.CLOSING, 'the official clock closes at 14:00 today');
  assert.equal(AM.nextTransition(c2, et(DAY, 13, 10)).at, et(DAY, 13, 30));
});

test('10: daylight saving time is handled by the exchange timezone; the host timezone is irrelevant', async () => {
  const cal = new MarketCalendar();
  assert.equal(modeAt(cal, Date.UTC(2026, 2, 6, 14, 30)), MODE.OPENING, 'Friday before DST: 14:30 UTC');
  assert.equal(modeAt(cal, Date.UTC(2026, 2, 9, 13, 30)), MODE.OPENING, 'Monday after DST: 13:30 UTC');
  assert.equal(modeAt(cal, Date.UTC(2026, 2, 9, 13, 29)), MODE.PRE);
  assert.equal(modeAt(cal, Date.UTC(2026, 9, 30, 13, 30)), MODE.OPENING, 'Friday before DST ends');
  assert.equal(modeAt(cal, Date.UTC(2026, 10, 2, 14, 30)), MODE.OPENING, 'Monday after DST ends');
  assert.equal(modeAt(cal, Date.UTC(2026, 10, 2, 13, 30)), MODE.AFTER, 'one hour before the open after DST ends');
  const code = "const {MarketCalendar}=require('./server/market/session');const AM=require('./server/market/adaptiveMonitoring');const c=new MarketCalendar();console.log([[2026,2,6,14,30],[2026,2,9,13,30],[2026,10,18,20,45],[2026,10,18,14,0]].map(a=>{const t=Date.UTC(...a);return AM.sessionMode(c.info(t),t).mode}).join())";
  const run = (TZ) => spawnSync(process.execPath, ['-e', code], { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ }, encoding: 'utf8' }).stdout.trim();
  const a = run('Asia/Riyadh');
  assert.equal(a, [MODE.OPENING, MODE.OPENING, MODE.CLOSING, MODE.PRE].join());
  assert.equal(run('UTC'), a);
  assert.equal(run('Australia/Sydney'), a);
});

test('session transitions happen while running, once each, without a restart', async () => {
  const L = await lab({ at: et(DAY, 9, 29) });
  L.tick();
  assert.equal(L.status().mode, MODE.PRE);
  for (const [h, m, mode] of [[9, 30, MODE.OPENING], [10, 0, MODE.POST_OPEN], [11, 0, MODE.NORMAL], [15, 30, MODE.CLOSING], [16, 0, MODE.AFTER]]) {
    L.clock.t = et(DAY, h, m) + 500; L.tick(); L.tick();
    assert.equal(L.status().mode, mode);
  }
  const changes = L.logs().filter((m) => /^Adaptive monitoring mode:/.test(m));
  assert.equal(changes.length, 5, 'each change logged once');
  assert.deepEqual(L.events.filter((e) => e.type === 'MONITORING_MODE').map((e) => e.data.to), [MODE.OPENING, MODE.NORMAL, MODE.CLOSING], 'only the optional, useful notifications');
  assert.equal(new Set(L.events.filter((e) => e.type === 'MONITORING_MODE').map((e) => e.id)).size, 3, 'stable ids');
  assert.deepEqual(L.status().next, { at: et('2026-11-19', 9, 0), mode: MODE.PRE }, 'after hours and overnight are one phase until the next preparation');
});

// ================================================================== opening range, breakouts, noise
test('opening-range breakout with volume: detected locally, confirmed, scored, and handed to the AI scheduler once', async () => {
  const L = await lab();
  L.calm(15);
  assert.equal(L.status().symbols[0].openingRange.complete, true);
  assert.equal(L.signals().length, 0, 'calm opening: no AI request');
  L.step({ TEST: BREAKOUT });
  const e = L.status().recent.find((x) => x.type === 'OPENING_RANGE_BREAKOUT');
  assert.ok(e, JSON.stringify(L.status().recent.map((x) => x.type)));
  assert.equal(e.confirmed, true);
  assert.ok(e.score >= 75, `score ${e.score}`);
  assert.deepEqual(Object.keys(e.breakdown), ['event', 'move', 'volume', 'volatility', 'trend', 'confirmation', 'exposure', 'timing']);
  assert.equal(e.status, 'DISPATCHED');
  const s = L.signals();
  assert.equal(s.length, 1, 'several events of one candle → ONE analysis');
  assert.equal(s[0].type, 'SIGNAL_CONFIRMED');
  assert.match(s[0].detail, /Opening-range breakout: close 100\.60 above the opening-range high/);
  assert.equal(L.jobs().some((r) => r.type === 'UNUSUAL_VOLUME'), false, 'the generic volume trigger does not repeat the same event');
  assert.equal(L.desk.book.aiState, 'RUNNING');
});

test('a breakout without confirmation that falls back is noise, not a signal; a failed confirmed breakout is a false breakout', async () => {
  const L = await lab();
  L.calm(15);
  L.step({ TEST: { c: 100.1, v: 900 } }); // above the range, weak volume → waits for confirmation
  L.step({ TEST: { c: 100.0, v: 900 } }); // back inside
  assert.equal(L.status().recent.some((x) => /^OPENING_RANGE/.test(x.type)), false);
  assert.ok(L.mon.sym('TEST').noise >= 1);
  L.settle();
  L.step({ TEST: BREAKOUT });
  L.idle(); L.desk.agent('TEST').scheduler.lastStartAt = 0;
  L.step({ TEST: { c: 99.97, h: 100.6, l: 99.95, v: 4000 } });
  const fb = L.status().recent.find((x) => x.type === 'FALSE_BREAKOUT' || (x.context || []).includes('FALSE_BREAKOUT'));
  assert.ok(fb, JSON.stringify(L.status().recent.map((x) => [x.type, x.context])));
});

test('slow confirmation: two closes beyond the level confirm without a volume surge', async () => {
  const L = await lab();
  L.calm(15);
  L.step({ TEST: { c: 100.12, v: 1100 } });
  assert.equal(L.status().recent.some((x) => x.type === 'OPENING_RANGE_BREAKOUT'), false, 'one close is not enough');
  L.step({ TEST: { c: 100.16, v: 1100 } });
  const all = L.status().recent.flatMap((x) => [x.type, ...(x.context || [])]);
  assert.ok(all.includes('OPENING_RANGE_BREAKOUT'), JSON.stringify(all));
});

test('gap, volume spike, reversal and acceleration are detected from completed candles only', () => {
  const T = [];
  const base = { openTr: 0.1, openVol: 1000, genTr: 0.1, genVol: 1000 };
  const t0 = et(DAY, 11) / 1000;
  const add = (c, v = 1000) => { const p = T.length ? T[T.length - 1].close : 100; T.push({ time: t0 + T.length * 60, open: p, close: c, high: Math.max(p, c) + 0.02, low: Math.min(p, c) - 0.02, volume: v }); };
  for (let i = 0; i < 25; i++) add(100 + (i % 2) * 0.01);
  const st = AM.newSymbolState();
  const detect = (gap) => { const m = AM.computeMetrics(T, base, {}); return { m, ev: AM.detectEvents(st, T, m, { levels: [], c: AM.DEFAULTS, now: (T[T.length - 1].time + 60) * 1000, mode: MODE.NORMAL, gap }) }; };
  assert.deepEqual(detect().ev, [], 'noise raises nothing');
  add(100.2, 3500);
  let r = detect();
  assert.ok(r.ev.some((e) => e.type === 'VOLUME_SPIKE') && r.m.relVol > 3);
  for (const c of [100.45, 100.75, 101.1]) add(c, 3500);
  r = detect();
  assert.ok(r.ev.some((e) => e.type === 'RAPID_MOVE' && e.dir === 1));
  assert.ok(r.m.volRatio > 2);
  add(100.7, 3000); add(100.3, 3000);
  r = detect();
  assert.ok(r.ev.some((e) => e.type === 'REVERSAL' && e.dir === -1), JSON.stringify(r.ev));
  const one = [{ time: t0, open: 101, high: 101.1, low: 100.9, close: 101, volume: 1000 }];
  const m1 = AM.computeMetrics(one, base, { inOpening: true });
  const g = AM.detectEvents(AM.newSymbolState(), one, m1, { levels: [], c: AM.DEFAULTS, now: (t0 + 60) * 1000, mode: MODE.OPENING, gap: { prevClose: 100, pct: 1, atr: 1 } });
  assert.deepEqual(g.map((e) => e.type), ['GAP_OPEN']);
});

test('metrics are volatility-aware: the open is compared with earlier opens, and nothing is invented without history', () => {
  const cal = new MarketCalendar();
  const bars = [];
  for (const d of ['2026-11-16', '2026-11-17']) for (let t = et(d, 9, 30) / 1000; t < et(d, 16) / 1000; t += 60) { const k = t * 1000 < et(d, 10) ? 0.5 : 0.1; bars.push({ time: t, open: 100, high: 100 + k / 2, low: 100 - k / 2, close: 100, volume: k === 0.5 ? 9000 : 1000 }); }
  const b = AM.buildBaseline(bars, (d) => cal.dayBounds(d), DAY, 30);
  assert.ok(Math.abs(b.openTr - 0.5) < 1e-9 && Math.abs(b.genTr - 0.1) < 1e-9);
  const T = [{ time: et(DAY, 9, 30) / 1000, open: 100, high: 100.25, low: 99.75, close: 100, volume: 9000 }];
  const open = AM.computeMetrics(T, b, { inOpening: true });
  assert.ok(open.volRatio < 1.1 && open.relVol < 1.1, 'a typical opening minute is not "high volatility"');
  assert.equal(AM.computeMetrics(T, { openTr: null, genTr: null }, {}).available, false, 'no baseline → no judgement');
});

// ================================================================== high volatility (11–13)
test('11–13: high volatility needs confirmation, has hysteresis and a cooldown, and returns to the correct session mode', async () => {
  const L = await lab({ at: et(DAY, 10, 50) });
  const wild = (up) => ({ TEST: { c: up ? 100.25 : 99.8, h: 100.3, l: 99.75, v: 3000 } });
  L.calm(6);
  assert.equal(L.status().mode, MODE.POST_OPEN);
  L.step(wild(true));
  assert.equal(L.mon.symbolMode('TEST'), MODE.POST_OPEN, 'one candle is not enough');
  L.step(wild(false)); L.step(wild(true));
  assert.equal(L.mon.symbolMode('TEST'), MODE.HIGH_VOL);
  const row = L.status().symbols[0];
  assert.equal(row.mode, MODE.HIGH_VOL);
  assert.equal(row.baseMode, MODE.POST_OPEN, 'the underlying session state is kept');
  assert.equal(L.status().baseMode, MODE.POST_OPEN);
  assert.equal(L.status().intensity, 'HIGH', 'one volatile symbol does not change the desk mode');
  // the session moves on underneath the override
  L.step(wild(false));
  L.calm(1);
  assert.equal(L.mon.symbolMode('TEST'), MODE.HIGH_VOL, 'one calm candle does not end it (hysteresis)');
  L.calm(12);
  assert.equal(L.mon.base.mode, MODE.NORMAL);
  assert.equal(L.mon.symbolMode('TEST'), MODE.NORMAL, 'returned to the CURRENT session mode, not to the old one');
  const ons = () => L.logs().filter((m) => /HIGH VOLATILITY monitoring activated/.test(m)).length;
  assert.equal(ons(), 1);
  // cooldown: the same noise right away does not re-activate it
  L.step(wild(true)); L.step(wild(false)); L.step(wild(true));
  assert.equal(L.mon.symbolMode('TEST'), MODE.NORMAL, 'cooldown');
  assert.equal(ons(), 1);
  // after the cooldown it can activate again
  L.calm(14);
  L.step(wild(true)); L.step(wild(false)); L.step(wild(true));
  assert.equal(L.mon.symbolMode('TEST'), MODE.HIGH_VOL);
  // end of the regular session clears the override
  L.clock.t = et(DAY, 16, 0) + 1000; L.tick();
  assert.equal(L.mon.symbolMode('TEST'), MODE.AFTER);
  const ids = L.events.filter((e) => e.type === 'HIGH_VOLATILITY').map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'notification ids are unique per 30-minute window');
});

test('hysteresis cannot be configured away', () => {
  const c = AM.adaptiveCfg({ adaptiveMonitoring: { volatility: { enterRatio: 2, exitRatio: 5 }, ai: { minScore: 90, highPriorityScore: 10 } } });
  assert.ok(c.volatility.exitRatio < c.volatility.enterRatio);
  assert.equal(c.ai.highPriorityScore, 90);
});

test('a market-wide move needs fresh index data, two confirmations and ends with hysteresis', async () => {
  const L = await lab({ at: et(DAY, 12, 0) });
  const feed = (pct, ageMs = 0) => { L.desk.book.broadMarket = { available: true, symbols: { SPY: { price: 600 * (1 + pct / 100), time: new Date(L.clock.t - ageMs).toISOString() }, QQQ: { price: 500 * (1 + pct / 100), time: new Date(L.clock.t - ageMs).toISOString() } } }; };
  const go = (pct, age) => { L.clock.t += 60000; feed(pct, age); L.tick(); };
  for (let i = 0; i < 9; i++) go(0);
  assert.equal(L.status().marketWide, null);
  go(0.8);
  assert.equal(L.status().marketWide, null, 'one sample is not enough');
  go(0.9);
  assert.ok(L.status().marketWide);
  assert.equal(L.status().mode, MODE.HIGH_VOL);
  assert.equal(L.status().baseMode, MODE.NORMAL);
  for (let i = 0; i < 25; i++) go(0.9);
  assert.equal(L.status().marketWide, null, 'ended once the index is calm again');
  const M = await lab({ at: et(DAY, 12, 0) });
  M.desk.book.broadMarket = { available: true, symbols: { SPY: { price: 600, time: new Date(M.clock.t - 3600000).toISOString() } } };
  M.tick();
  assert.deepEqual(M.mon.market.samples, {}, 'stale index data is ignored');
});

// ================================================================== queue, priorities, AI limits (14–17)
test('14: simultaneous events of several symbols are ranked; backpressure limits parallel analyses; the queue is bounded', async () => {
  const L = await lab({ symbols: ['TEST', 'AAA', 'BBB'], config: { adaptiveMonitoring: { ai: { maxQueued: 1 } } } });
  L.calm(15);
  L.step({ TEST: { c: 100.35, h: 100.36, l: 99.98, v: 2500 }, AAA: { c: 101.2, h: 101.22, l: 99.98, v: 9000 }, BBB: { c: 100.6, h: 100.62, l: 99.98, v: 5000 } });
  const n = (s) => L.signals(s).length;
  assert.deepEqual([n('AAA'), n('BBB'), n('TEST')], [1, 0, 0], 'the strongest event first; the rest wait');
  assert.equal(L.status().queued, 2);
  L.idle(); L.tick();
  assert.deepEqual([n('AAA'), n('BBB'), n('TEST')], [1, 1, 0]);
  L.idle(); L.tick();
  assert.deepEqual([n('AAA'), n('BBB'), n('TEST')], [1, 1, 1]);
  // flood: never more than the bound, weakest dropped first
  const st = L.mon.sym('TEST');
  const c = L.mon.cfg();
  L.desk.agent('TEST').scheduler.inFlight = { id: 'x', reasons: [] };
  for (let i = 0; i < 200; i++) L.mon.enqueue(L.desk.agent('TEST'), st, { type: 'RAPID_MOVE', dir: 1, confirmed: true, at: L.clock.t, key: `k${i}`, detail: 'x' }, { score: 60 + (i % 40), raw: 0, breakdown: {}, quality: 1 }, L.clock.t, c);
  assert.ok(L.mon.queue.length <= 40);
  assert.equal(L.mon.queue.filter((e) => e.symbol === 'TEST').length, 5, 'per-symbol bound');
  assert.ok(L.mon.queue.every((e) => e.score >= 98), 'the strongest are kept');
  assert.ok(L.mon.recent.length <= 60 && L.mon.counters.suppressed.backpressure > 0);
});

class CostlyDecider extends ScriptedDecider { constructor() { super(); this.kind = 'deepseek'; this.costly = true; this.label = 'COSTLY TEST'; } }

test('15: AI budgets are enforced before asking: daily cost, daily requests, per-symbol hourly and event caps', async () => {
  const run = async (prep, over = {}) => { const L = await lab({ decider: new CostlyDecider(), config: over }); L.calm(15); prep(L); L.step({ TEST: BREAKOUT }); return L; };
  const spend = (cost, n = 1) => (L) => { for (let i = 0; i < n; i++) L.store.insertUsage({ ts: L.clock.t, day: etDateStr(L.clock.t), model: 'deepseek-flash', purpose: 'decision', ok: true, provider: 'deepseek', costUsd: cost / n }); };
  const a = await run(spend(1.9));
  assert.equal(a.signals().length, 0, '95% of the $2 daily budget used: the reserve is kept');
  assert.equal(a.mon.queue[0].hold, 'budget');
  a.clock.t += 301000; a.tick();
  assert.equal(a.status().counters.suppressed.budget, 1);
  assert.ok(a.status().ai.preventedToday >= 1, 'shown as a prevented AI call');
  const b = await run(spend(0.001, 40));
  assert.equal(b.signals().length, 0, 'daily request cap of the ECONOMY mode');
  const c = await run((L) => { for (let i = 0; i < 2; i++) L.desk.primary.usage.noteRequestStart(L.clock.t, 'TEST'); });
  assert.equal(c.signals().length, 0, 'per-symbol hourly cap of the ECONOMY mode');
  const d = await run(() => {}, { adaptiveMonitoring: { ai: { maxPerSymbolPerDay: 0 } } });
  assert.equal(d.status().counters.suppressed.symbol_cap, 1);
  const e = await run(() => {}, { adaptiveMonitoring: { ai: { maxPerDay: 0 } } });
  assert.equal(e.status().counters.suppressed.daily_cap, 1);
  const ok = await run(() => {});
  assert.equal(ok.signals().length, 1, 'within every limit the analysis is requested');
});

test('16: deduplication and cooldown: one situation never causes repeated AI requests', async () => {
  const L = await lab({ symbols: ['TEST'] });
  L.calm(15);
  L.step({ TEST: BREAKOUT });
  assert.equal(L.signals().length, 1);
  L.idle();
  for (let i = 0; i < 4; i++) { L.step({ TEST: { c: 100.62 + i * 0.02, v: 4000 } }); L.idle(); }
  assert.equal(L.signals().length, 1, 'the same breakout is not analysed again within the cooldown');
  // an event already seen by a newer analysis is covered, not repeated
  const M = await lab({ config: { adaptiveMonitoring: { ai: { symbolCooldownSec: 30 } } } });
  M.calm(15);
  M.desk.agent('TEST').scheduler.inFlight = { id: 'other', reasons: [] };
  M.step({ TEST: BREAKOUT });
  assert.equal(M.mon.queue[0].hold, 'busy', 'no overlapping analysis of the same symbol');
  M.desk.agent('TEST').scheduler.lastStartAt = M.clock.t; M.idle(); M.tick();
  assert.equal(M.signals().length, 0);
  assert.equal(M.status().counters.suppressed.covered, 1);
  // minor fluctuation: below the threshold, no request
  const N = await lab({ at: et(DAY, 12, 0) });
  N.calm(25);
  N.step({ TEST: { c: 100.02, v: 3200 } });
  assert.equal(N.signals().length, 0);
  assert.ok(N.status().counters.suppressed.low_score >= 1 || N.status().recent.length === 0);
});

test('17: AI outage: monitoring, metrics and protective orders continue; no AI call is attempted', async () => {
  const L = await lab();
  L.desk.book.portfolio.applyFill({ symbol: 'TEST', side: 'BUY', qty: 10, price: 100, fees: 0, ts: L.clock.t });
  L.desk.book.orders.setProtection('TEST', { stopLoss: 98, takeProfit: 105, entryPrice: 100, highWater: 100 });
  L.calm(15);
  L.desk.book.aiBackoff = { fails: 3, until: L.clock.t + 3600000 };
  L.step({ TEST: BREAKOUT });
  assert.equal(L.signals().length, 0);
  assert.equal(L.mon.queue[0].hold, 'ai_unavailable');
  assert.ok(L.status().symbols[0].volRatio > 2, 'local metrics keep working');
  assert.ok(L.status().problems.some((p) => p.code === 'AI'));
  assert.equal(L.status().mode, MODE.OPENING);
  L.clock.t += 3000; L.provider.q('TEST', 97.5, 97.6); L.provider.t('TEST', 97.5);
  assert.equal(L.desk.book.portfolio.position('TEST'), null, 'the stop-loss executed without any AI provider');
});

test('AI providers failing for real: the managed plan is blocked, events wait and are counted as prevented', async () => {
  const L = await lab({ decider: null });
  L.calm(15);
  for (const id of ['deepseek', 'gemini']) L.desk.book.aiManager.health[id].openUntil = L.clock.t + 3600000;
  L.step({ TEST: BREAKOUT });
  assert.equal(L.signals().length, 0);
  assert.equal(L.mon.queue[0].hold, 'ai_unavailable');
  assert.equal(L.config.get().ai.mode, 'AUTO', 'the provider configuration is not touched');
});

// ================================================================== data quality (18), restart (19), paused (20)
test('18: stale or missing data never triggers an analysis and ends a volatility override', async () => {
  const L = await lab();
  L.calm(15);
  L.quotes = false; // candles arrive, but no current bid/ask
  L.clock.t += 30000;
  L.step({ TEST: BREAKOUT });
  assert.equal(L.signals().length, 0);
  assert.equal(L.mon.queue[0].hold, 'stale_data');
  assert.equal(L.status().symbols[0].fresh, false);
  L.clock.t += 120000; L.tick(); L.clock.t += 200000; L.tick();
  assert.equal(L.status().counters.suppressed.stale_data, 1, 'expired without an AI call');
  assert.ok(L.status().problems.some((p) => p.code === 'DATA'));
  const M = await lab();
  M.calm(3);
  M.mon.startOverride('TEST', M.mon.sym('TEST'), 'test', M.clock.t);
  assert.equal(M.mon.symbolMode('TEST'), MODE.HIGH_VOL);
  for (let i = 0; i < 25; i++) { M.clock.t += 10000; M.tick(); } // no data at all for > 3 minutes
  assert.equal(M.mon.symbolMode('TEST'), MODE.OPENING);
  assert.ok(M.logs().some((m) => /market data not reliable/.test(m)));
  // quiet minutes have no candle and raise nothing
  const N = await lab();
  N.calm(16); N.step({ TEST: null }); N.step({ TEST: null });
  assert.equal(N.signals().length, 0);
  // a candle that is not the newest minute (late backfill) is not a live event
  N.mon.onBarClose(N.desk.agent('TEST'), { tf: '1m', bar: { ...calmBar(N.minute - 1800), close: 200 } }, N.desk.agent('TEST').sessionInfo(), N.clock.t);
  assert.equal(N.signals().length, 0);
});

test('19: restart: same-day events are not repeated, counters survive, overrides are re-evaluated, timers are not duplicated', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-mon-'));
  const file = path.join(dir, 'trading.db');
  const L = await lab({ file });
  L.calm(15);
  L.step({ TEST: BREAKOUT });
  assert.equal(L.signals().length, 1);
  const before = L.status().counters.dispatched;
  L.mon.endOverride('TEST', L.mon.sym('TEST'), 'test', L.clock.t);
  await L.desk.shutdown();
  L.store.close();
  // new process on the same database, two minutes later, with the same candles available
  const t2 = L.clock.t + 120000;
  const R = await lab({ file, at: t2, start: false });
  R.provider.minutes = [...history(['2026-11-16', '2026-11-17']), ...[...L.desk.primary.candles.minutes.values()]];
  await R.desk.init();
  R.last.TEST = 100.6; R.minute = Math.floor(t2 / 60000) * 60;
  R.provider.q('TEST', 100.58, 100.62); R.provider.t('TEST', 100.6);
  assert.equal(R.status().counters.dispatched, before);
  assert.ok(R.mon.sym('TEST').override.cooldownUntil > t2, 'volatility cooldown survives');
  R.settle();
  R.step({ TEST: { c: 100.62, v: 4500 } }); R.step({ TEST: { c: 100.64, v: 4500 } });
  const types = R.status().recent.flatMap((x) => [x.type, ...(x.context || [])]);
  assert.equal(types.includes('OPENING_RANGE_BREAKOUT'), false, `the breakout from before the restart is not raised again: ${types}`);
  assert.equal(R.status().mode, MODE.OPENING, 'mode recomputed from the clock, no stored mode needed');
  await R.desk.shutdown();
  // a new day starts clean
  const D = await lab({ file: ':memory:', start: false });
  D.store.setSetting('monitor.state', { day: '2026-11-17', fired: { x: 1 }, counters: { dispatched: 9 } });
  D.mon.load();
  assert.deepEqual(D.mon.fired, {});
  assert.equal(D.mon.counters.dispatched, 0);
  // timers: the coordinator has none of its own; every symbol has its housekeeping loop exactly once
  const T = await lab({ symbols: ['TEST', 'AAA'], autoTimers: true });
  assert.equal(T.desk.agent('AAA').timers.length, 1, 'watchlist symbols run the housekeeping loop');
  T.desk.agent('AAA').startTimers();
  assert.equal(T.desk.agent('AAA').timers.length, 1, 'restarting timers never duplicates them');
  const aaa = T.desk.agent('AAA');
  await T.desk.removeSymbol('AAA');
  assert.equal(aaa.timers.length, 0, 'removed symbol: timer cleaned up');
  await T.desk.shutdown();
  assert.equal(T.desk.primary.timers.length, 0);
});

test('20: AI trading PAUSED while monitoring stays active: events are seen, nothing is asked, nothing is started', async () => {
  const L = await lab();
  L.desk.pause();
  L.calm(15);
  L.step({ TEST: BREAKOUT });
  const s = L.status();
  assert.equal(s.monitoring.state, 'ACTIVE');
  assert.equal(s.aiTrading.state, 'PAUSED');
  assert.equal(s.mode, MODE.OPENING);
  assert.ok(s.counters.events >= 1 && s.counters.suppressed.ai_not_running >= 1);
  assert.equal(L.signals().length, 0);
  assert.equal(L.desk.book.aiState, 'PAUSED', 'never resumed automatically');
  // system-wide monitoring pause: no detection at all, and still no state change
  const M = await lab();
  M.calm(15);
  M.desk.setMonitoring(false);
  M.step({ TEST: BREAKOUT });
  assert.equal(M.status().counters.events, 0);
  assert.equal(M.desk.book.aiState, 'RUNNING');
  // disabled in settings: the standard behaviour, no modes
  const N = await lab({ config: { adaptiveMonitoring: { enabled: false } } });
  N.calm(15); N.step({ TEST: BREAKOUT });
  assert.equal(N.status().mode, null);
  assert.equal(N.signals().length, 0);
  assert.equal(N.mon.entryBlock(N.desk.primary.sessionInfo(), et(DAY, 15, 55)), null);
});

// ================================================================== risk, closing, overnight, paper-only (21–23)
test('21: the risk engine is unchanged: intensity raises no limit, and proposals are still rejected by it', async () => {
  const L = await lab({ at: et(DAY, 12, 0), symbols: ['TEST', 'AAA', 'BBB'] });
  L.tick();
  const limits = JSON.stringify(L.config.get().risk);
  L.mon.startOverride('TEST', L.mon.sym('TEST'), 'test', L.clock.t);
  assert.equal(L.mon.symbolMode('TEST'), MODE.HIGH_VOL);
  assert.equal(JSON.stringify(L.config.get().risk), limits);
  assert.equal(L.store.listFills(L.desk.book.session.id).length, 0, 'higher intensity executes nothing');
  const dec = L.desk.opts.deciderOverride;
  for (const s of ['TEST', 'AAA']) { dec.push((x) => buyProposal(x)); const d = await L.desk.agent(s).runAnalysis({ reasons: [{ type: 'MANUAL' }] }); assert.equal(d.status, 'EXECUTED'); }
  dec.push((x) => buyProposal(x));
  const d3 = await L.desk.agent('BBB').runAnalysis({ reasons: [{ type: 'SIGNAL_CONFIRMED', detail: 'x' }] });
  assert.equal(d3.status, 'REJECTED_BY_RISK');
  assert.ok(d3.risk.checks.some((c) => c.name === 'max_open_positions' && !c.pass));
  // a real signal on stale data cannot trade either
  L.clock.t += 60000;
  const gate = await L.desk.agent('BBB').runAnalysis({ reasons: [{ type: 'SIGNAL_CONFIRMED', detail: 'x' }] });
  assert.equal(gate.skipped, true);
});

test('closing phase: positions are reviewed once, no new entries in the last minutes, nothing is liquidated', async () => {
  const L = await lab({ at: et(DAY, 15, 28), symbols: ['TEST', 'AAA'] });
  L.desk.book.portfolio.applyFill({ symbol: 'TEST', side: 'BUY', qty: 10, price: 100, fees: 0, ts: L.clock.t });
  L.desk.book.orders.setProtection('TEST', { stopLoss: 98, takeProfit: 105, entryPrice: 100, highWater: 100 });
  L.calm(3);
  assert.equal(L.status().mode, MODE.CLOSING);
  assert.equal(L.signals('TEST').filter((r) => /Closing review/.test(r.detail)).length, 1);
  assert.equal(L.signals('AAA').length, 0, 'only held symbols');
  assert.ok(L.logs().some((m) => /^Closing phase: 1 open position\(s\)/.test(m)));
  assert.equal(L.status().entryBlock, null, '15:31: entries are still possible');
  L.idle(); L.calm(20);
  assert.match(L.status().entryBlock, /last 10 minutes/);
  const dec = L.desk.opts.deciderOverride;
  dec.push((x) => buyProposal(x));
  const d = await L.desk.agent('AAA').runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(d.status, 'REJECTED_BY_RISK');
  assert.equal(d.risk.checks[0].name, 'closing_window');
  assert.equal(L.store.listOrders(L.desk.book.session.id)[0].status, 'REJECTED');
  const g = await L.desk.agent('AAA').runAnalysis({ reasons: [{ type: 'SIGNAL_EVENT' }] });
  assert.match(g.reason, /analysis skipped/, 'no AI request for a symbol that cannot be entered');
  // a resting limit order is not filled inside the window and is not cancelled either
  L.desk.book.orders.addPending({ symbol: 'AAA', side: 'BUY', qty: 1, limitPrice: 100.5, stopLoss: 98, takeProfit: 105, decisionId: 'd', proposal: buyProposal({ id: 's', market: { quote: { ask: 100 } } }), createdAt: L.clock.t, expiresAt: L.clock.t + 3600000 });
  L.provider.q('AAA', 99.98, 100.02); L.provider.t('AAA', 100);
  assert.equal(L.desk.book.portfolio.position('AAA'), null);
  assert.equal(L.desk.book.orders.pendingFor('AAA').length, 1);
  assert.ok(L.desk.book.portfolio.position('TEST'), 'open positions are kept');
  // protective orders always work
  L.provider.q('TEST', 97.5, 97.6); L.provider.t('TEST', 97.5);
  assert.equal(L.desk.book.portfolio.position('TEST'), null, 'stop-loss inside the closing window');
});

test('22: overnight and extended hours: reference data only — no events, no AI, no execution', async () => {
  const L = await lab({ at: et(DAY, 15, 55) });
  L.calm(2);
  L.clock.t = et(DAY, 22, 0);
  const a = L.desk.agent('TEST');
  a.calendar.overnight = { enabled: true };
  L.tick();
  assert.equal(a.sessionInfo().session, 'OVERNIGHT');
  assert.equal(L.status().mode, MODE.AFTER);
  assert.equal(L.status().intensity, 'LOW');
  a.market.onReference({ price: 140, ts: L.clock.t, kind: 'INDICATIVE', provider: 'test overnight' });
  const n = L.status().counters.events;
  L.tick(); L.clock.t += 120000; L.tick();
  assert.equal(L.status().counters.events, n, 'an indicative +40% price is not a market event');
  assert.equal(a.market.lastTrade.price < 101, true);
  const g = await a.runAnalysis({ reasons: [{ type: 'SIGNAL_CONFIRMED' }] });
  assert.equal(g.skipped, true);
  assert.equal(L.store.listFills(L.desk.book.session.id).length, 0);
  // pre-market preparation: an indicative reference is shown as indicative and creates no price level
  const P = await lab({ at: et(DAY, 9, 5) });
  P.desk.agent('TEST').market.onReference({ price: 103, ts: P.clock.t, kind: 'INDICATIVE', provider: 'test' });
  P.tick();
  const row = P.status().symbols[0];
  assert.equal(P.status().mode, MODE.PRE);
  assert.ok(Math.abs(row.gapPct - 3) < 1e-9 && row.gapIndicative === true);
  assert.deepEqual(P.status().openingWatchlist.map((x) => [x.symbol, x.indicative]), [['TEST', true]]);
  assert.equal(P.jobs().length, 0, 'preparation makes no AI call');
  assert.equal(P.mon.sym('TEST').levels.length, 0);
});

test('23: paper trading only: the monitoring module has no execution, network or brokerage path', async () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'market', 'adaptiveMonitoring.js'), 'utf8');
  for (const bad of ['executeEntry', 'executeExit', 'applyFill', 'simulateOrder', 'closePosition', 'reducePosition', 'recordOrder', 'setRiskProfile', 'setAiState', 'startTrading', 'desk.resume', '.resume(', 'config.update', 'fetch(', 'fetchJson', 'WebSocket', 'setInterval', 'setTimeout', '/v2/orders', 'clearDisable']) {
    assert.equal(src.includes(bad), false, `must not contain ${bad}`);
  }
  await assert.rejects(fetchJson('https://paper-api.alpaca.markets/v2/orders', { method: 'POST', body: {}, fetchImpl: async () => { throw new Error('must not be reached'); } }), /paper-trading only/);
  await assert.rejects(fetchJson('https://api.alpaca.markets/v2/orders', { fetchImpl: async () => { throw new Error('must not be reached'); } }), /paper-trading only/);
});

// ================================================================== cost: watchlist symbols, routine analyses
test('watchlist symbols now run their own candle/session loop without extra routine AI requests, log noise or stream probes', async () => {
  const L = await lab({ symbols: ['TEST', 'AAA'], config: { ai: { usageMode: 'BALANCED' } } });
  let verify = 0; L.provider.verifySubscription = () => { verify++; };
  L.calm(6);
  assert.ok(L.jobs('TEST').some((r) => r.type === 'CANDLE_CLOSE'), 'main symbol: unchanged');
  assert.equal(L.jobs('AAA').some((r) => r.type === 'CANDLE_CLOSE'), false, 'watchlist symbol: no analysis per candle by default');
  assert.equal(L.logs().filter((m) => /^New 1-minute candle completed/.test(m)).length, 6, 'one candle line per minute, not one per symbol');
  assert.ok(L.mon.sym('AAA').metrics.available, 'but it is monitored locally');
  assert.equal(verify, 0);
  const M = await lab({ symbols: ['TEST', 'AAA'], config: { ai: { usageMode: 'BALANCED' }, adaptiveMonitoring: { followerCandleClose: true } } });
  M.calm(6);
  assert.ok(M.jobs('AAA').some((r) => r.type === 'CANDLE_CLOSE'), 'opt-in');
});

test('intensive phases keep the last hourly requests of a symbol for events', async () => {
  const L = await lab({ config: { ai: { usageMode: 'BALANCED' } }, decider: new CostlyDecider() });
  L.tick();
  const a = L.desk.primary;
  assert.equal(L.mon.allowRoutine(a), true);
  for (let i = 0; i < 4; i++) a.usage.noteRequestStart(L.clock.t, 'TEST'); // BALANCED: 6 per hour, 2 reserved
  assert.equal(L.mon.allowRoutine(a), false);
  assert.equal(L.status().counters.routineSkipped, 1);
  L.clock.t = et(DAY, 13, 0); L.tick();
  for (let i = 0; i < 4; i++) a.usage.noteRequestStart(L.clock.t, 'TEST');
  assert.equal(L.mon.allowRoutine(a), true, 'normal session: existing behaviour');
});

test('score: explainable, confirmed high-volume breakout outranks a minor fluctuation; quality and age reduce it', () => {
  const m = { z5: 3.5, relVol: 4, volRatio: 3, efficiency: 0.8, trendDir: 1 };
  const ctx = { profile: AM.PROFILES[MODE.OPENING], ttlMs: 300000 };
  const strong = AM.scoreEvent({ type: 'OPENING_RANGE_BREAKOUT', dir: 1, confirmed: true }, m, ctx);
  const weak = AM.scoreEvent({ type: 'VOLUME_SPIKE', dir: 1, confirmed: false }, { z5: 0.3, relVol: 1.2, volRatio: 1, efficiency: 0.1, trendDir: -1 }, ctx);
  assert.ok(strong.score > weak.score + 40, `${strong.score} vs ${weak.score}`);
  assert.equal(strong.score, Math.round(strong.raw));
  assert.ok(Math.abs(Object.values(strong.breakdown).reduce((s, x) => s + x, 0) - strong.raw) <= 1 || strong.raw === 100);
  assert.ok(AM.scoreEvent({ type: 'OPENING_RANGE_BREAKOUT', dir: 1, confirmed: true }, m, { ...ctx, quality: 0.5 }).score < strong.score);
  assert.ok(AM.scoreEvent({ type: 'OPENING_RANGE_BREAKOUT', dir: 1, confirmed: true }, m, { ...ctx, ageMs: 300000 }).score < strong.score);
  assert.ok(AM.scoreEvent({ type: 'FALSE_BREAKOUT', dir: -1, confirmed: true }, m, { ...ctx, held: { qty: 1 } }).breakdown.exposure === 10);
  assert.ok(FORCE_TRIGGERS.has('SIGNAL_CONFIRMED') && !FORCE_TRIGGERS.has('SIGNAL_EVENT'), 'an unconfirmed event still goes through the analysis cache');
});

test('end to end with the real scheduler: event → one analysis → decision through the normal pipeline', async () => {
  const stub = { start: AnalysisScheduler.prototype.start, pump: AnalysisScheduler.prototype.pump };
  const dec = new ScriptedDecider();
  const L = await lab({ decider: dec });
  L.calm(15);
  AnalysisScheduler.prototype.pump = real.pump;
  try {
    const seen = dec.seen.length;
    L.step({ TEST: BREAKOUT });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(dec.seen.length, seen + 1, 'exactly one analysis');
    const d = L.store.listDecisions(L.desk.book.session.id, 1)[0];
    assert.match(d.audit.triggers[0], /^SIGNAL_CONFIRMED: Opening-range breakout/);
  } finally { Object.assign(AnalysisScheduler.prototype, stub); }
});

// ================================================================== configuration, API, Telegram, Arabic
test('settings: validated bounds, defaults for old configurations, live toggle', async () => {
  assert.deepEqual(validatePatch({ adaptiveMonitoring: { openingMin: 45, volatility: { enterRatio: 3 }, ai: { minScore: 50 } } }), []);
  assert.ok(validatePatch({ adaptiveMonitoring: { openingMin: 1 } }).length);
  assert.ok(validatePatch({ adaptiveMonitoring: { enabled: 'yes' } }).length);
  assert.ok(validatePatch({ adaptiveMonitoring: { nope: 1 } }).length);
  assert.deepEqual(AM.adaptiveCfg({}).volatility, AM.DEFAULTS.volatility, 'a stored configuration without the section works');
  const { _comment, ...shipped } = CFG_DEFAULTS.adaptiveMonitoring;
  assert.ok(_comment);
  assert.deepEqual(shipped, JSON.parse(JSON.stringify(AM.DEFAULTS)), 'config/default.json and the code defaults agree');
  const L = await lab();
  L.tick();
  L.config.update({ adaptiveMonitoring: { enabled: false } });
  L.tick();
  assert.equal(L.status().enabled, false);
  assert.equal(L.desk.book.aiState, 'RUNNING');
  L.config.update({ adaptiveMonitoring: { enabled: true } });
  L.tick();
  assert.equal(L.status().mode, MODE.OPENING);
});

test('API: /api/monitoring needs the login; the live state carries a compact summary', async () => {
  const t = createTerminal({ dbFile: ':memory:', port: 0, env: { DASHBOARD_PASSWORD: 'correct-horse-battery-staple' }, fetchImpl: silentFetch });
  const port = await t.start();
  try {
    const url = `http://localhost:${port}`;
    assert.equal((await fetch(`${url}/api/monitoring`)).status, 401);
    const login = await fetch(`${url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify({ password: 'correct-horse-battery-staple' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const r = await (await fetch(`${url}/api/monitoring`, { headers: { cookie } })).json();
    assert.equal(r.enabled, true);
    assert.match(r.scoreNote, /not a probability of profit/);
    assert.equal(r.mode, null, 'no symbol loaded yet: the mode is unknown, not "market closed"');
    const st = await (await fetch(`${url}/api/state`, { headers: { cookie } })).json();
    assert.equal(st.adaptive.enabled, true);
    assert.ok(JSON.stringify(st.adaptive).length < 1500);
  } finally { await t.stop(); }
});

test('Telegram: /monitoring answers from the engine; the optional notifications are off by default and deduplicated', async () => {
  const L = await lab({ symbols: ['TEST', 'AAA'] });
  L.calm(15); L.step({ TEST: BREAKOUT });
  const service = new TerminalService({ desk: L.desk, store: L.store, config: L.config, secrets: L.desk.opts.secrets, now: () => L.clock.now() });
  L.config.update({ telegram: { enabled: true, authorizedChatIds: ['111'], authorizedUserIds: ['111'] } });
  const sent = [];
  const fetchImpl = async (url, o) => { const method = url.split('/').pop(); sent.push({ method, body: o && o.body ? JSON.parse(o.body) : {} }); return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : { message_id: sent.length } }) }; };
  const tg = createTelegram({ store: L.store, service, getConfig: () => L.config.get(), getToken: () => '123456:TEST-TOKEN-abcdefghijklmnop', log: () => {}, fetchImpl, now: () => L.clock.now() });
  const msg = (text, from = 111) => tg.handleUpdate({ update_id: sent.length + from, message: { message_id: 1, date: Math.floor(L.clock.t / 1000), from: { id: from, is_bot: false, first_name: 'T' }, chat: { id: from, type: 'private' }, text } });
  await msg('/monitoring');
  const text = sent.filter((x) => x.method === 'sendMessage').map((x) => x.body.text).find((x) => /المراقبة التكيفية للسوق/.test(x));
  assert.ok(text, JSON.stringify(sent.map((x) => x.body.text)));
  for (const part of ['مراقبة السوق', 'التداول الآلي (حالة منفصلة)', 'مراقبة مكثفة للافتتاح', 'الأسهم المراقبة: 2', 'تحليلات بسبب أحداث السوق: 1']) assert.ok(text.includes(part), part);
  const n = sent.length;
  await msg('/monitoring', 999);
  assert.equal(sent.slice(n).some((x) => /المراقبة التكيفية للسوق/.test(x.body.text || '')), false, 'strangers get nothing');
  assert.equal(CATEGORY.HIGH_VOLATILITY, 'monitoring');
  const ev = { id: 'hv:TEST:1:1', type: 'HIGH_VOLATILITY', ts: L.clock.t, symbol: 'TEST', priority: 'low', data: { active: true, reason: 'x' } };
  assert.equal(tg.notify(ev), null, 'off by default: no extra notifications');
  L.config.update({ telegram: { notifications: { monitoring: true } } });
  assert.ok(tg.notify(ev));
  assert.equal(tg.notify(ev), null, 'same event id → sent once');
  assert.match(renderEvent({ type: 'MONITORING_MODE', ts: L.clock.t, data: { to: MODE.OPENING, intensity: 'MAXIMUM' } }).text, /المراقبة المكثفة للافتتاح/);
  assert.equal(renderEvent({ type: 'MONITORING_MODE', ts: L.clock.t, data: { to: MODE.PRE } }), null, 'no message for minor transitions');
});

test('Arabic: every monitoring message, event, mode and reason is translated', async () => {
  const L = await lab({ symbols: ['TEST', 'AAA'] });
  L.calm(15); L.step({ TEST: BREAKOUT }); L.step({ TEST: { c: 99.9, h: 100.6, l: 99.85, v: 6000 } }); L.step({ TEST: { c: 100.9, h: 101, l: 99.8, v: 8000 } });
  L.calm(20);
  L.mon.startOverride('TEST', L.mon.sym('TEST'), 'forming candle range 5.2x typical (provisional)', L.clock.t);
  L.mon.endOverride('TEST', L.mon.sym('TEST'), 'no trades for 10 minutes', L.clock.t);
  L.desk.book.portfolio.applyFill({ symbol: 'TEST', side: 'BUY', qty: 10, price: 100, fees: 0, ts: L.clock.t });
  L.clock.t = et(DAY, 15, 30) + 500; L.tick();
  L.clock.t = et(DAY, 15, 55); L.provider.q('AAA', 99.98, 100.02); L.provider.t('AAA', 100);
  L.desk.opts.deciderOverride.push((x) => buyProposal(x));
  await L.desk.agent('AAA').runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  await L.desk.agent('AAA').runAnalysis({ reasons: [{ type: 'SIGNAL_EVENT' }] });
  L.config.update({ adaptiveMonitoring: { enabled: false } }); L.tick();
  // pre-market preparation → opening watchlist, and a market-wide move
  const W = await lab({ at: et(DAY, 9, 29) });
  W.desk.agent('TEST').market.onReference({ price: 103, ts: W.clock.t, kind: 'INDICATIVE', provider: 'test' });
  W.tick(); W.clock.t = et(DAY, 9, 30) + 500; W.tick();
  assert.ok(W.logs().some((m) => /^Opening watchlist \(unusual pre-market movement\): TEST \+3\.00%$/.test(m)), W.logs().join(' | '));
  for (let i = 0; i < 12; i++) { W.clock.t += 60000; W.desk.book.broadMarket = { available: true, symbols: { SPY: { price: i < 9 ? 600 : 606, time: new Date(W.clock.t).toISOString() } } }; W.tick(); }
  assert.ok(W.status().marketWide);
  const ctx = { localStorage: { getItem: () => 'ar', setItem() {} }, document: { documentElement: {}, querySelectorAll: () => [], title: '' }, console };
  ctx.window = ctx; vm.createContext(ctx);
  for (const f of ['i18n.js', 'i18n-messages.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8'), ctx);
  const mine = [...new Set([...L.store.listActivity(null, 5000), ...W.store.listActivity(null, 5000)].filter((e) => e.source === 'adaptive monitoring' || /New positions|SIGNAL_/.test(e.message)).map((e) => e.message))];
  assert.ok(mine.length >= 10, `${mine.length} messages`);
  assert.deepEqual(mine.filter((m) => !ctx.MSG.msg(m).translated), []);
  for (const m of mine) assert.doesNotMatch(ctx.MSG.msg(m).text, /Opening-range|breakout|typical|attention/i, m);
  const { I18N } = ctx;
  for (const k of Object.values(MODE)) assert.match(I18N.en('monMode', k), /[؀-ۿ]/, k);
  for (const k of Object.keys(AM.EVENTS)) assert.match(I18N.en('monEvent', k), /[؀-ۿ]/, k);
  const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'market', 'adaptiveMonitoring.js'), 'utf8');
  const reasons = new Set([...src.matchAll(/(?:'SUPPRESSED', '|hold\('|count\('|dropAll\(')([a-z_]+)'/g)].map((x) => x[1]));
  assert.ok(reasons.size >= 12);
  for (const r of reasons) assert.match(I18N.en('monReason', r), /[؀-ۿ]/, r);
  for (const k of Object.keys(require('../server/config').flatten(CFG_DEFAULTS.adaptiveMonitoring))) if (k !== '_comment') assert.ok(I18N.field(`adaptiveMonitoring.${k}`), `label for ${k}`);
});

// ------------------------------------------------------------------ regressions found in the code review
test('review: the pre-market gap uses the last daily close before today, even without pre-market bars', async () => {
  const L = await lab();
  const now = et(DAY, 9, 5);
  const day = (d, close) => ({ time: et(d, 0, 0) / 1000, open: close, high: close + 1, low: close - 1, close, volume: 1 });
  const agent = { symbol: 'GAP', calendar: {}, market: { reference: { price: 110, ts: now } }, candles: {
    completedBars: () => [calmBar(et('2026-11-17', 15, 59) / 1000, 110)],
    getBars: () => [...Array.from({ length: 20 }, (_, i) => day('2026-11-' + String(i % 13 + 1).padStart(2, '0'), 100)).sort((a, b) => a.time - b.time), day('2026-11-16', 100), day('2026-11-17', 110)],
  } };
  L.mon.updatePrep(agent, now);
  const p = L.mon.sym('GAP').prep;
  assert.equal(p.prevClose, 110);
  assert.equal(p.gapPct, 0);
  assert.equal(p.unusual, false);
});

test('review: the market-wide mode ends when index data stops, and stale samples never count', async () => {
  const L = await lab();
  const now = L.clock.now();
  const mk = L.mon.market;
  L.mon.base.mode = AM.MODE ? AM.MODE.OPENING || AM.MODE.REGULAR : L.mon.base.mode;
  mk.active = true; mk.since = now;
  mk.samples = { SPY: [{ ts: now - 60000, price: 100 }] };
  L.desk.book.broadMarket = null;
  L.mon.marketWide(now, L.mon.cfg());
  assert.equal(mk.active, true, 'fresh enough');
  L.mon.marketWide(now + 6 * 60000, L.mon.cfg());
  assert.equal(mk.active, false);
  L.mon.marketWide(now + 30 * 60000, L.mon.cfg());
  assert.deepEqual(mk.samples, {}, 'old samples are dropped');
});

test('review: a symbol removed while it loads never starts', async () => {
  const L = await lab();
  let release;
  const real = L.provider.fetchMinuteWindow.bind(L.provider);
  L.provider.fetchMinuteWindow = async (s, x) => { if (s === 'SLOW') await new Promise((r) => { release = r; }); return real(s, x); };
  const adding = L.desk.addSymbol('SLOW');
  for (let i = 0; i < 200 && !release; i++) await new Promise((r) => setImmediate(r));
  const a = L.desk.agent('SLOW');
  assert.ok(a && release);
  await L.desk.removeSymbol('SLOW');
  release();
  await adding.catch(() => {});
  assert.equal(L.desk.agent('SLOW'), null);
  assert.equal(a.scheduler.running, false);
});

test('review: a paused symbol raises no volatility alerts, and does so again after it resumes', async () => {
  const run = async (paused) => {
    const L = await lab({ symbols: ['TEST', 'AAA'] });
    for (let i = 0; i < 40; i++) L.step();
    if (paused) L.desk.pauseSymbol('AAA');
    let p = 100;
    for (let i = 0; i < 8; i++) { p += 1.5; L.step({ AAA: { c: p, h: p + 1, l: p - 2.5, v: 20000 } }); }
    return L.events.filter((e) => e.type === 'HIGH_VOLATILITY' && e.symbol === 'AAA').length;
  };
  assert.ok(await run(false) > 0, 'the same move alerts when not paused');
  assert.equal(await run(true), 0);
});

test('review: a watchlist symbol without a position announces recovery after a halt', async () => {
  const L = await lab({ symbols: ['TEST', 'AAA'] });
  const a = L.desk.agent('AAA');
  const si = a.sessionInfo();
  let now = L.clock.now();
  a.cond.reset();
  const go = (code) => { now += 60000; L.clock.t = now; a.logDataStatus({ code, label: code, codes: [], detail: '' }, si, now); };
  go('LIVE'); go('HALTED');
  a.dataUnreliableSince = a.dataUnreliableSince || now;
  go('LIVE');
  assert.equal(L.events.filter((e) => e.type === 'DATA_RECOVERED' && e.symbol === 'AAA').length, 1);
});


test('review: waiting analyses count towards the queue limit', async () => {
  const L = await lab({ symbols: ['TEST', 'AAA'], config: { adaptiveMonitoring: { ai: { maxQueued: 1 } } } });
  for (let i = 0; i < 40; i++) L.step();
  L.settle();
  L.desk.agent('AAA').scheduler.pending = { id: 'x', reasons: [{ type: 'INTERVAL' }], priority: 1, createdAt: L.clock.now() };
  const e = { symbol: 'TEST', type: 'VOLUME_SPIKE', key: 'k', label: 'l', detail: 'd', context: [], score: 100, at: L.clock.now() - 20000, dir: 1, confirmed: true, level: null, barTime: L.minute - 60, price: 100 };
  L.mon.queue = [e];
  L.mon.dispatch(L.clock.now());
  assert.equal(L.mon.queue.length, 1, 'held back');
  assert.equal(L.mon.queue[0].hold, 'backpressure');
});

test('review: a confirmed signal merged into a waiting analysis counts towards the daily caps', async () => {
  const L = await lab();
  for (let i = 0; i < 40; i++) L.step();
  L.settle();
  const a = L.desk.agent('TEST');
  a.scheduler.trigger = () => 'merged';
  const before = L.mon.counters.dispatched;
  L.mon.queue = [{ symbol: 'TEST', type: 'VOLUME_SPIKE', key: 'k', label: 'l', detail: 'd', context: [], score: 100, at: L.clock.now() - 20000, dir: 1, confirmed: true, level: null, barTime: L.minute - 60, price: 100 }];
  L.mon.dispatch(L.clock.now());
  assert.equal(L.mon.queue.length, 0);
  assert.equal(L.mon.counters.dispatched, before + 1);
  assert.equal(L.mon.dispatched.TEST, 1);
});

test('review: the end-of-day level does not move when the program restarts during the closing phase', async () => {
  const L = await lab();
  const close = et(DAY, 16, 0);
  const si = { regularCloseMs: close, regularOpenMs: et(DAY, 9, 30) };
  const start = close - L.mon.cfg().closingMin * 60000;
  const bars = [{ time: start / 1000 - 60, high: 100, low: 99 }, { time: start / 1000 + 600, high: 101, low: 98 }];
  L.mon.base.since = start + 15 * 60000; // restarted here
  const out = L.mon.levelsFor({ lastAnalysis: null }, { prep: null }, bars, {}, { trBase: 0.01 }, start + 16 * 60000, si, AM.MODE.CLOSING);
  assert.equal(out.find((x) => x.key === 'eod_high').price, 100);
  assert.equal(out.find((x) => x.key === 'eod_low').price, 99);
});

test('review: the closing text mentions the entry limit only when there is one', async () => {
  const L = await lab();
  const text = (n) => { L.mon.closingReview(L.clock.now(), { ...L.mon.cfg(), noNewEntriesLastMin: n, closingPositionReview: false }); return L.logs().filter((m) => m.startsWith('Closing phase')).pop(); };
  assert.doesNotMatch(text(0), /no new entries/);
  assert.match(text(10), /last 10 minutes/);
});
