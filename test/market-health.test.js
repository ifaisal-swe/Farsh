'use strict';
const { tempStore } = require('./helpers/db');
/**
 * Market-data health: sessions (regular / pre / after-hours / closed / weekend / holiday / early close),
 * IEX coverage hours, separated freshness states, once-per-change logging, disconnection and recovery,
 * missing quotes, quiet symbols on IEX, and the Alpaca connector's subscription/backoff behaviour.
 * Everything runs on a virtual clock with fake providers — no network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { Store } = require('../server/db');
const { ConfigManager, DEFAULTS } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { TradingAgent } = require('../server/engine/agent');
const { MarketCalendar } = require('../server/market/session');
const { AlpacaProvider } = require('../server/market/alpaca');
const { ConditionLog } = require('../server/util/conditions');
const { Redactor } = require('../server/util/misc');
const { etWallToUtcMs, addDays } = require('../server/util/time');
const { T0, FakeProvider, ScriptedDecider, buyProposal, makeMinuteBars, makeDailyBars, silentFetch } = require('./helpers/fixtures');

const ET = (d, h, m, s = 0) => etWallToUtcMs(d, h, m) + s * 1000;
const iso = (ms) => new Date(ms).toISOString();
const flush = () => new Promise((r) => setImmediate(r));
const IEX = DEFAULTS.market.feedCoverage.iex;

/** Alpaca trading calendar rows: weekdays, Thanksgiving closed, day after = 13:00 early close. */
function calendarRows(from = '2026-11-02', to = '2026-12-04') {
  const rows = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const [y, m, dd] = d.split('-').map(Number);
    const wd = new Date(Date.UTC(y, m - 1, dd)).getUTCDay();
    if (wd === 0 || wd === 6 || d === '2026-11-26') continue;
    rows.push({ date: d, open: '09:30', close: d === '2026-11-27' ? '13:00' : '16:00', session_open: '0400', session_close: '2000' });
  }
  return rows;
}

/** Alpaca-shaped fake: connection phases, subscription confirmation, calendar, clock, snapshots, backfill. */
class FakeAlpaca extends FakeProvider {
  constructor(o) {
    super(o);
    this.symbol = o.symbol || 'TEST';
    this.snapshot = o.snapshot || null;
    this.snapsFn = null;
    this.clockResp = o.clockResp || null;
    this.calls = { minuteWindow: [], verify: 0, forceReconnect: 0, active: [] };
  }
  feedInfo() { return { provider: 'Alpaca', feed: 'iex', realtime: true, label: 'LIVE — ALPACA IEX', note: 'IEX only', mode: 'LIVE' }; }
  connect() { this.reconnect(); }
  reconnect() {
    for (const state of ['CONNECTING', 'AUTHENTICATING', 'AUTHENTICATED']) this.emit('connection', { state, detail: state.toLowerCase() });
    this.emit('connection', { state: 'SUBSCRIBED', detail: `trades=${this.symbol}` });
    this.emit('subscribed', { trades: [this.symbol], quotes: [this.symbol], bars: [this.symbol], statuses: [this.symbol] });
  }
  drop(detail = 'socket closed (1006)') { this.emit('connection', { state: 'DISCONNECTED', detail }); }
  async fetchCalendar() { return calendarRows(); }
  async fetchClock() { if (!this.clockResp) throw new Error('clock not mocked'); return typeof this.clockResp === 'function' ? this.clockResp() : this.clockResp; }
  async fetchSnapshot() { return this.snapshot; }
  async fetchSnapshots() { return this.snapsFn ? this.snapsFn() : {}; }
  async fetchMinuteWindow(sym, startMs) {
    this.calls.minuteWindow.push(startMs);
    return this.minutes.filter((b) => b.time * 1000 >= startMs && (b.time + 60) * 1000 <= this.clock.now());
  }
  setMarketActive(a) { this.calls.active.push(a); }
  verifySubscription() { this.calls.verify++; this.emit('subscribed', { trades: [this.symbol], quotes: [this.symbol], bars: [this.symbol], verify: true }); return true; }
  forceReconnect() { this.calls.forceReconnect++; return true; }
  quote(bid, ask, size = 500) { const t = this.clock.now(); this.emit('quote', { symbol: this.symbol, bid, ask, bidSize: size, askSize: size, ts: t, receivedAt: t }); }
  trade(price, size = 100) { const t = this.clock.now(); this.emit('trade', { symbol: this.symbol, price, size, ts: t, receivedAt: t }); }
}

function harness({ startMs, symbol = 'TEST', minutes, snapshot = null, clockResp = null }) {
  const store = tempStore();
  const clock = { t: startMs, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'c'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  let agent;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (agent && agent.session ? agent.session.id : null), ring: 5000 });
  const provider = new FakeAlpaca({ clock, symbol, minutes: minutes || makeMinuteBars(), daily: makeDailyBars(300, '2026-11-17'), snapshot, clockResp });
  const decider = new ScriptedDecider();
  agent = new TradingAgent({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  agent.news.start = () => {};
  agent.scheduler.run = async () => ({ skipped: true });
  const run = async (seconds, each = null) => {
    for (let i = 0; i < seconds; i++) {
      clock.t += 1000;
      if (each) each(i);
      agent.tick();
      if (i % 5 === 0) await flush();
    }
    await flush(); await flush();
  };
  const msgs = (re) => activity.recent(5000).filter((e) => re.test(e.message));
  return { agent, provider, clock, activity, store, decider, run, msgs };
}

// ---------------------------------------------------------------- sessions

test('Sessions: regular / pre / after-hours / closed / weekend / holiday / early close, with IEX coverage hours', async () => {
  const cal = new MarketCalendar({ fetchCalendar: async () => calendarRows(), coverage: IEX });
  await cal.load(ET('2026-11-19', 12, 0));
  const at = (d, h, m) => cal.info(ET(d, h, m));
  // Thursday 2026-11-19
  assert.equal(at('2026-11-19', 3, 30).session, 'CLOSED');
  let i = at('2026-11-19', 7, 15);
  assert.equal(i.session, 'PRE'); assert.equal(i.marketStatus, 'PRE-MARKET'); assert.equal(i.feed.active, false, 'IEX has no pre-market before 08:00');
  assert.match(i.feed.reason, /IEX pre-market starts 08:00/);
  i = at('2026-11-19', 8, 30);
  assert.equal(i.session, 'PRE'); assert.equal(i.feed.active, true);
  i = at('2026-11-19', 10, 0);
  assert.equal(i.session, 'REGULAR'); assert.equal(i.marketStatus, 'OPEN'); assert.equal(i.feed.active, true);
  i = at('2026-11-19', 16, 30);
  assert.equal(i.session, 'POST'); assert.equal(i.marketStatus, 'AFTER-HOURS'); assert.equal(i.feed.active, true);
  // the reported case: 17:44 ET is after-hours for the consolidated market, but IEX closed at 17:00
  i = at('2026-11-19', 17, 44);
  assert.equal(i.session, 'POST'); assert.equal(i.feed.active, false);
  assert.match(i.feed.reason, /IEX post-market ended 17:00 ET/);
  assert.equal(i.nextFeedOpenMs, ET('2026-11-20', 8, 0));
  assert.equal(i.nextOpenMs, ET('2026-11-20', 9, 30));
  i = at('2026-11-19', 21, 0);
  assert.equal(i.session, 'CLOSED'); assert.equal(i.reason, 'After the extended-hours session');
  // weekend
  i = at('2026-11-21', 12, 0);
  assert.equal(i.session, 'CLOSED'); assert.equal(i.reason, 'Weekend'); assert.equal(i.feed.active, false);
  assert.equal(i.nextOpenMs, ET('2026-11-23', 9, 30), 'next open is Monday');
  // holiday (Thanksgiving) and early close the day after
  i = at('2026-11-26', 11, 0);
  assert.equal(i.session, 'CLOSED'); assert.match(i.reason, /holiday/i);
  i = at('2026-11-27', 13, 30);
  assert.equal(i.session, 'POST'); assert.equal(i.earlyClose, true); assert.equal(i.feed.active, true);
  assert.equal(at('2026-11-27', 14, 5).feed.active, false, 'IEX post-market assumed to end 60 min after an early close');
  // DST: same ET wall time maps to different UTC in July vs November
  const cal2 = new MarketCalendar({ coverage: IEX });
  assert.equal(cal2.info(Date.parse('2026-07-01T13:30:00Z')).session, 'REGULAR');
  assert.equal(cal2.info(Date.parse('2026-07-01T13:29:00Z')).session, 'PRE');
  assert.equal(cal2.info(Date.parse('2026-11-18T14:29:00Z')).session, 'PRE');
  assert.equal(cal2.info(Date.parse('2026-11-18T14:30:00Z')).session, 'REGULAR');
});

test('Sessions: the official Alpaca clock overrides the calendar and reveals local clock skew', async () => {
  const now = ET('2026-11-18', 11, 0);
  const cal = new MarketCalendar({
    fetchCalendar: async () => calendarRows(), coverage: IEX,
    fetchClock: async () => ({ timestamp: new Date(now - 10000).toISOString(), is_open: false, next_open: iso(ET('2026-11-19', 9, 30)), next_close: iso(ET('2026-11-19', 16, 0)) }),
  });
  await cal.load(now);
  assert.equal(cal.info(now).session, 'REGULAR');
  const c = await cal.syncClock(now, () => now);
  assert.equal(c.skewMs, 10000, 'local clock 10s ahead of Alpaca');
  const i = cal.info(now);
  assert.equal(i.session, 'CLOSED', 'unscheduled closure reported by the clock wins');
  assert.equal(i.clockOverride, 'closed');
  assert.equal(i.nextOpenMs, ET('2026-11-19', 9, 30));
});

// ---------------------------------------------------------------- the reported bug

test('After 17:00 ET (IEX closed): MARKET CLOSED with last price — no stale-quote flood, no per-minute spam, chart kept', async (t) => {
  const day = '2026-11-19';
  const h = harness({
    startMs: ET(day, 17, 44),
    symbol: 'ANT',
    minutes: makeMinuteBars({ date: day, fromH: 9, fromM: 30, endMs: ET(day, 17, 0), start: 90 }),
    snapshot: {
      latestTrade: { p: 94.88, s: 10, t: iso(ET(day, 16, 59, 44)), x: 'V' },
      latestQuote: { bp: 94.8, ap: 94.95, bs: 1, as: 1, t: iso(ET(day, 16, 18)) },
    },
  });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'ANT', initialCapital: 500, targetCapital: 1000 });
  await h.run(20 * 60); // 20 minutes of 1-second ticks
  const ds = h.agent.dataStatus();
  assert.equal(ds.code, 'CLOSED');
  assert.equal(ds.label, 'AFTER-HOURS — NO IEX DATA (LAST PRICE)');
  assert.equal(ds.tradable, false, 'still not executable — freshness checks are not disabled');
  assert.ok(ds.codes.includes('QUOTE_STALE') && ds.codes.includes('QUOTE_NOT_STREAMED') === false);
  assert.equal(h.msgs(/not reliable|Quote not updated|STALE|Still /).length, 0, 'no stale-data warnings while the feed is legitimately closed');
  assert.equal(h.msgs(/AFTER-HOURS — NO IEX DATA/).length, 1, 'closed status logged exactly once');
  assert.match(h.msgs(/AFTER-HOURS — NO IEX DATA/)[0].message, /last trade \$94\.8800 at 16:59:44 ET/);
  assert.equal(h.msgs(/No trades on this feed|closed with no trades|scheduling analysis/).length, 0, 'no per-minute spam while closed');
  assert.ok(h.activity.recent(5000).length < 80, `activity stays small (${h.activity.recent(5000).length} lines)`);
  assert.equal(h.provider.calls.active[0], false, 'provider told the market is closed (slow reconnect backoff)');
  // chart preserved: last real candle, nothing generated after it
  const bars = h.agent.chartData('1m').bars;
  assert.equal(bars[bars.length - 1].time, ET(day, 16, 59) / 1000);
  const st = h.agent.publicState();
  assert.equal(st.market.lastTrade.price, 94.88);
  assert.equal(st.market.dataStatus.code, 'CLOSED');
  assert.equal(st.session.feed.active, false);
  // risk engine refuses entries (session and data), the AI is not asked while closed
  h.decider.push((s) => buyProposal(s));
  const d = await h.agent.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(d.status, 'REJECTED_BY_RISK');
  const failed = d.risk.checks.filter((c) => !c.pass).map((c) => c.name);
  assert.ok(failed.includes('session_open') && failed.includes('data_fresh'), failed.join());
  const gate = await h.agent.runAnalysis({ reasons: [{ type: 'CANDLE_CLOSE' }] });
  assert.equal(gate.skipped, true);
  assert.match(gate.reason, /AFTER-HOURS — AI analysis deferred/);
});

// ---------------------------------------------------------------- regular hours

test('Regular hours: stale quote logged once, diagnosed once, one reminder after 5 min, recovery logged once', async (t) => {
  const h = harness({ startMs: T0 });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  h.provider.quote(99.98, 100.02);
  h.provider.trade(100);
  const quoteTs = h.clock.now();
  h.provider.snapsFn = () => ({ TEST: { latestQuote: { t: iso(quoteTs) }, latestTrade: { t: iso(quoteTs) } }, SPY: { latestQuote: { t: iso(h.clock.now() - 2000) } } });
  await h.run(2);
  assert.equal(h.agent.dataStatus().code, 'LIVE');
  assert.equal(h.agent.dataStatus().label, 'LIVE — ALPACA IEX');
  assert.equal(h.msgs(/Live data verified for TEST: first quote/).length, 1);
  await h.run(4 * 60 + 30);
  const ds = h.agent.dataStatus();
  assert.equal(ds.code, 'STALE');
  assert.equal(ds.label, 'STALE DATA — TRADING PAUSED');
  assert.equal(h.msgs(/^STALE DATA — TRADING PAUSED/).length, 1, 'logged once, not every second');
  assert.equal(h.msgs(/Feed diagnosis: the IEX feed is working \(SPY quote .* ago\), but TEST has had no IEX quote change/).length, 1);
  assert.equal(h.msgs(/^Still STALE/).length, 0);
  assert.equal(h.msgs(/No trades on this feed in minute/).length, 1, 'quiet minutes summarised, not logged each minute');
  await h.run(60);
  assert.equal(h.msgs(/^Still STALE DATA — TRADING PAUSED — unresolved for 5m/).length, 1, 'one reminder after five minutes');
  // recovery: quotes and trades flow again
  h.provider.quote(100.0, 100.04);
  h.provider.trade(100.02);
  await h.run(2);
  assert.equal(h.agent.dataStatus().code, 'LIVE');
  assert.equal(h.msgs(/^Market data recovered — LIVE — ALPACA IEX \(was STALE DATA — TRADING PAUSED for /).length, 1);
  assert.equal(h.agent.diag, null, 'diagnosis cleared once data is live');
  await h.run(70, () => { h.provider.quote(100.0, 100.04); h.provider.trade(100.02); });
  assert.equal(h.agent.dataStatus().code, 'LIVE');
  assert.equal(h.msgs(/Trades resumed after \d+ minutes without trades/).length, 1);
  assert.equal(h.msgs(/^Market data recovered/).length, 1, 'recovery logged once');
});

test('Regular hours: trades without fresh quotes update the chart but never become an execution price', async (t) => {
  const h = harness({ startMs: T0 });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  h.provider.quote(99.98, 100.02);
  await h.run(20, () => h.provider.trade(100.5));
  const ds = h.agent.dataStatus();
  assert.equal(ds.code, 'STALE');
  assert.deepEqual(ds.codes, ['QUOTE_STALE']);
  assert.equal(h.agent.market.lastTrade.price, 100.5, 'last trade tracked separately');
  assert.equal(h.agent.market.quote().ask, 100.02, 'bid/ask is not replaced by the trade price');
  const last = h.agent.chartData('1m').bars.slice(-1)[0];
  assert.equal(last.close, 100.5, 'chart forms the current candle from real trade prints');
  h.decider.push((s) => buyProposal(s));
  const d = await h.agent.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(d.status, 'REJECTED_BY_RISK');
  assert.ok(d.risk.checks.some((c) => c.name === 'data_fresh' && !c.pass && /bid\/ask is .* old by exchange timestamp/.test(c.detail)));
  assert.equal(h.agent.portfolio.fillCount, 0);
  const st = h.agent.publicState();
  assert.match(st.ai.display.label, /AI WAITING — DATA NOT RELIABLE/);
});

test('Regular hours: REST snapshot newer than the stream -> stream declared broken, forced reconnect (rate-limited)', async (t) => {
  const h = harness({ startMs: T0 });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  h.provider.quote(99.98, 100.02);
  h.provider.snapsFn = () => ({ TEST: { latestQuote: { t: iso(h.clock.now() - 1000) } }, SPY: { latestQuote: { t: iso(h.clock.now() - 1000) } } });
  await h.run(25);
  assert.equal(h.agent.diag.code, 'STREAM_MISSING_UPDATES');
  assert.equal(h.provider.calls.forceReconnect, 1);
  assert.equal(h.msgs(/Feed diagnosis: the REST snapshot has a newer TEST quote/).length, 1);
  await h.run(90);
  assert.equal(h.provider.calls.forceReconnect, 1, 'no reconnect storm');
});

// ---------------------------------------------------------------- disconnect / recovery

test('Disconnection: CONNECTION LOST — RECONNECTING, throttled logs, then resubscribe + missing candles + data verification', async (t) => {
  const h = harness({ startMs: T0 });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  h.provider.quote(99.98, 100.02);
  h.provider.trade(100);
  await h.run(2);
  const barsBefore = h.agent.chartData('1m').bars.length;
  h.provider.drop();
  h.provider.emit('reconnectScheduled', { attempt: 1, delayMs: 1000, marketActive: true });
  h.provider.emit('connection', { state: 'RECONNECTING', detail: 'attempt 1' });
  for (let a = 2; a <= 13; a++) {
    await h.run(30);
    h.provider.emit('connection', { state: 'CONNECTING', detail: 'wss' });
    h.provider.emit('error', { message: 'Stream error: getaddrinfo ENOTFOUND stream.data.alpaca.markets' });
    h.provider.drop('socket closed (1006)');
    h.provider.emit('reconnectScheduled', { attempt: a, delayMs: 30000, marketActive: true });
    h.provider.emit('connection', { state: 'RECONNECTING', detail: `attempt ${a}` });
  }
  const ds = h.agent.dataStatus();
  assert.equal(ds.code, 'RECONNECTING');
  assert.equal(ds.label, 'CONNECTION LOST — RECONNECTING');
  assert.equal(h.agent.marketForRisk().connected, false);
  assert.equal(h.msgs(/Market data connection lost/).length, 1);
  assert.equal(h.msgs(/^Reconnect attempt/).length, 4, 'attempts 1-3, then one reminder after 5 minutes');
  assert.equal(h.msgs(/getaddrinfo ENOTFOUND/).length, 2, 'identical errors: once, plus once after the 5-minute window');
  assert.equal(h.msgs(/Connecting to market data stream/).length, 1, 'per-attempt CONNECTING churn is not logged');
  // the provider's REST history now contains the minutes that traded during the outage
  const extra = makeMinuteBars({ date: '2026-11-18', fromH: 11, fromM: 0, endMs: h.clock.now(), start: 100.4, seed: 7 });
  h.provider.minutes = [...h.provider.minutes, ...extra];
  const v0 = h.agent.chartVersion;
  h.provider.reconnect();
  await h.run(1);
  assert.equal(h.msgs(/Market data stream restored after 6m .* authenticated and subscribed TEST/).length, 1);
  assert.ok(h.provider.calls.minuteWindow.slice(-1)[0] === etWallToUtcMs('2026-11-18', 11, 0), 'backfill starts after the last official minute');
  assert.ok(h.agent.chartVersion > v0, 'chart reload requested');
  assert.ok(h.agent.chartData('1m').bars.length >= barsBefore + 5, 'missing candles loaded');
  assert.equal(h.msgs(/Loaded \d+ missing 1-minute candle\(s\) since 11:00 ET/).length, 1);
  assert.equal(h.agent.dataStatus().code, 'WAITING', 'connected but no live message yet');
  assert.equal(h.agent.dataStatus().label, 'CONNECTED — WAITING FOR MARKET DATA');
  h.provider.quote(100.6, 100.64);
  await h.run(1);
  assert.equal(h.msgs(/Live data verified for TEST: first quote received .* after resubscribing/).length, 1);
  assert.equal(h.agent.dataStatus().code, 'LIVE');
});

// ---------------------------------------------------------------- pre-market wake-up / weekend

test('Pre-market: before IEX opens -> closed for the feed; at 08:00 -> wake, backfill, verify subscription, then live', async (t) => {
  const day = '2026-11-19';
  const h = harness({ startMs: ET(day, 7, 59, 30), minutes: makeMinuteBars({ date: day, fromH: 8, fromM: 0, endMs: ET(day, 8, 3), start: 101 }) });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  await h.run(10);
  assert.equal(h.agent.dataStatus().code, 'CLOSED');
  assert.equal(h.agent.dataStatus().label, 'PRE-MARKET — NO IEX DATA (LAST PRICE)');
  assert.ok(h.provider.calls.active.every((a) => a === false), 'closed for IEX before 08:00');
  await h.run(25); // crosses 08:00:00
  assert.equal(h.provider.calls.active[h.provider.calls.active.length - 1], true, 'provider told data is expected now');
  assert.equal(h.msgs(/Market session changed: PRE-MARKET → PRE-MARKET — IEX data expected/).length, 1);
  assert.equal(h.provider.calls.verify, 1, 'subscription re-verified at session start');
  assert.equal(h.msgs(/Subscription verified for TEST/).length, 1);
  assert.ok(h.provider.calls.minuteWindow.length >= 2, 'missing candles requested at session start');
  assert.equal(h.agent.dataStatus().code, 'WAITING');
  await h.run(60);
  assert.equal(h.agent.dataStatus().code, 'QUIET', 'sparse pre-market data is not a connection failure');
  assert.equal(h.agent.dataStatus().label, 'PRE-MARKET — NO RECENT IEX QUOTE');
  assert.equal(h.msgs(/STALE|Still /).length, 0);
  h.provider.quote(101.1, 101.2);
  await h.run(1);
  assert.equal(h.agent.dataStatus().label, 'LIVE — ALPACA IEX (PRE-MARKET)');
  const gate = await h.agent.runAnalysis({ reasons: [{ type: 'CANDLE_CLOSE' }] });
  assert.match(gate.reason, /PRE-MARKET — AI analysis deferred/, 'simulated trading stays in the regular session by default');
});

test('Weekend: closed with next open, no reconnect pressure, nothing logged per second or per minute', async (t) => {
  const h = harness({ startMs: ET('2026-11-21', 12, 0), snapshot: { latestTrade: { p: 101.5, s: 5, t: iso(ET('2026-11-20', 16, 58, 3)) } } });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  const n0 = h.activity.recent(5000).length;
  await h.run(30 * 60);
  const ds = h.agent.dataStatus();
  assert.equal(ds.code, 'CLOSED');
  assert.equal(ds.label, 'MARKET CLOSED — LAST PRICE');
  assert.match(h.agent.statusDetail(ds), /Weekend · last trade \$101\.5000 at 16:58:03 ET 2026-11-20 · IEX data resumes 2026-11-23 08:00 ET · regular session opens 2026-11-23 09:30 ET/);
  const extra = h.activity.recent(5000).slice(n0).map((e) => e.message);
  assert.ok(extra.length <= 3, `a quiet weekend produces (almost) no log lines; got:\n${extra.join('\n')}`);
  assert.ok(h.provider.calls.active.length >= 1 && h.provider.calls.active.every((a) => a === false), 'never told the market is active');
});

test('Identical provider errors are not repeated; ConditionLog semantics', async (t) => {
  const h = harness({ startMs: T0 });
  t.after(() => h.agent.shutdown());
  await h.agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  for (let i = 0; i < 50; i++) h.provider.emit('error', { message: 'Stream error: connect ECONNREFUSED 1.2.3.4:443' });
  assert.equal(h.msgs(/ECONNREFUSED/).length, 1);
  const c = new ConditionLog({ remindMs: 300000 });
  assert.equal(c.check('x', 'A', 0).kind, 'change');
  assert.equal(c.check('x', 'A', 1000), null);
  assert.equal(c.check('x', 'A', 299000), null);
  const r = c.check('x', 'A', 300000);
  assert.equal(r.kind, 'reminder'); assert.equal(r.suppressed, 2);
  const ch = c.check('x', 'B', 300500);
  assert.equal(ch.kind, 'change'); assert.equal(ch.prev.key, 'A');
});

// ---------------------------------------------------------------- Alpaca connector

function mockStream({ confirm = true } = {}) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const st = { connections: 0, subs: [], sockets: [] };
    wss.on('connection', (ws) => {
      st.connections++;
      st.sockets.push(ws);
      ws.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.action === 'auth') ws.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
        if (m.action === 'subscribe') {
          st.subs.push(m);
          ws.send(JSON.stringify([confirm ? { T: 'subscription', trades: m.trades, quotes: m.quotes, bars: m.bars } : { T: 'subscription', trades: [], quotes: [], bars: [] }]));
        }
      });
    });
    wss.on('listening', () => resolve({ wss, st, url: `ws://127.0.0.1:${wss.address().port}` }));
  });
}
const waitFor = async (fn, ms = 3000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('timeout'); };

test('Alpaca connector: unconfirmed subscription is never reported as SUBSCRIBED', async (t) => {
  const { wss, url } = await mockStream({ confirm: false });
  const p = new AlpacaProvider({ keyId: 'K', secretKey: 'S', feed: 'iex', cfg: { ...DEFAULTS.market, streamBaseUrl: url } });
  t.after(() => { p.disconnect(); wss.close(); });
  const states = []; const errors = [];
  p.on('connection', (c) => states.push(c.state)); p.on('error', (e) => errors.push(e));
  p.subscribe(['ANT']);
  p.connect();
  await waitFor(() => errors.length > 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(errors[0].code, 'SUBSCRIPTION_MISMATCH');
  assert.ok(!states.includes('SUBSCRIBED'));
  assert.equal(p.state, 'AUTHENTICATED');
});

test('Alpaca connector: backoff is longer while closed; market wake-up reconnects immediately; heartbeat tracked', async (t) => {
  const p0 = new AlpacaProvider({ keyId: 'K', secretKey: 'S', feed: 'iex', cfg: { ...DEFAULTS.market } });
  assert.equal(p0.reconnectDelay(1, { marketActive: true }), 1000);
  assert.equal(p0.reconnectDelay(6, { marketActive: true }), 30000, 'active market: capped at 30s');
  assert.equal(p0.reconnectDelay(9, { marketActive: false }), 256000);
  assert.equal(p0.reconnectDelay(12, { marketActive: false }), 300000, 'closed market: capped at 5 min');

  const { wss, st, url } = await mockStream();
  const p = new AlpacaProvider({ keyId: 'K', secretKey: 'S', feed: 'iex', cfg: { ...DEFAULTS.market, streamBaseUrl: url, reconnectBaseMs: 60000, pingIntervalMs: 40 } });
  t.after(() => { p.disconnect(); wss.close(); });
  const beats = []; const sched = [];
  p.on('heartbeat', (b) => beats.push(b)); p.on('reconnectScheduled', (r) => sched.push(r)); p.on('error', () => {}); p.on('info', () => {});
  p.subscribe(['ANT']);
  p.setMarketActive(false);
  p.connect();
  await waitFor(() => p.state === 'SUBSCRIBED');
  await waitFor(() => beats.length > 0);
  assert.ok(beats[0].rttMs >= 0);
  st.sockets[0].terminate();
  await waitFor(() => sched.length === 1);
  assert.ok(sched[0].delayMs >= 60000 && sched[0].marketActive === false, 'closed market: slow retry scheduled');
  p.setMarketActive(true);
  await waitFor(() => st.connections === 2 && p.state === 'SUBSCRIBED');
  assert.equal(st.subs.length, 2, 'subscription restored after reconnect');
});
