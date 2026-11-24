'use strict';
const { tempStore } = require('./helpers/db');
/** Multi-symbol desk, shared portfolio, orders ledger, AI cost control, Gemini client, overnight reference data, service stats. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/db');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { Desk } = require('../server/engine/desk');
const { TerminalService, periodRange } = require('../server/services/terminalService');
const { Redactor } = require('../server/util/misc');
const { AnalysisScheduler } = require('../server/ai/scheduler');
const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
const { effectiveAiCfg, materialStateHash } = require('../server/ai/costControl');
const { GeminiClient } = require('../server/ai/gemini');
const { ReferencePriceService } = require('../server/market/reference');
const { MarketCalendar } = require('../server/market/session');
const { etWallToUtcMs } = require('../server/util/time');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

// Analyses are driven explicitly in these tests (no background scheduling).
const origStart = AnalysisScheduler.prototype.start;
test.before(() => { AnalysisScheduler.prototype.start = function () { this.running = false; }; });
test.after(() => { AnalysisScheduler.prototype.start = origStart; });

class MultiFake extends FakeProvider {
  connect() { this.state = 'SUBSCRIBED'; this.emit('connection', { state: 'SUBSCRIBED', detail: 'test feed' }); }
  async fetchAsset(symbol) { return { symbol, name: `${symbol} Inc`, exchange: 'NASDAQ', status: 'active', tradable: true, fractionable: true }; }
  q(symbol, bid, ask) { const t = this.clock.now(); this.emit('quote', { symbol, bid, ask, bidSize: 500, askSize: 500, ts: t, receivedAt: t }); }
  t(symbol, price) { const t = this.clock.now(); this.emit('trade', { symbol, price, size: 100, ts: t, receivedAt: t }); }
}

function makeDesk({ legacy = true, decider = new ScriptedDecider() } = {}) {
  const store = tempStore();
  const clock = { t: T0, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  if (legacy) config.update({ risk: { ...LEGACY_DEFAULTS, maxOpenPositions: 2, profile: 'CUSTOM' } });
  let desk;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (desk && desk.book.session ? desk.book.session.id : null) });
  const provider = new MultiFake({ clock });
  let created = 0;
  desk = new Desk({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => { created++; return provider; }, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  for (const a of [desk.primary]) a.news.start = () => {};
  const origSpawn = desk.spawn.bind(desk);
  desk.spawn = async (s, o) => { const a = await origSpawn(s, o); a.news.start = () => {}; a.news.stop(); return a; };
  const service = new TerminalService({ desk, store, config, secrets, now: () => clock.now() });
  return { desk, store, clock, provider, decider, activity, config, service, created: () => created };
}
const manual = { reasons: [{ type: 'MANUAL', detail: 'test' }] };

test('two symbols share ONE stream, ONE cash balance and the global position limit', async () => {
  const ctx = makeDesk();
  const { desk, provider, decider, store } = ctx;
  await desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  await desk.addSymbol('ABC');
  assert.equal(ctx.created(), 1, 'one provider (one WebSocket) for both symbols');
  assert.deepEqual([...new Set(provider.subscribed)].sort(), ['ABC', 'TEST']);
  provider.q('TEST', 99.98, 100.02); provider.t('TEST', 100);
  provider.q('ABC', 99.98, 100.02); provider.t('ABC', 100);
  decider.push((s) => buyProposal(s));
  const d1 = await desk.agent('TEST').runAnalysis(manual);
  assert.equal(d1.status, 'EXECUTED', JSON.stringify(d1.risk && d1.risk.checks.filter((c) => !c.pass)));
  const cashAfter1 = desk.book.portfolio.cash;
  decider.push((s) => buyProposal(s));
  const d2 = await desk.agent('ABC').runAnalysis(manual);
  assert.equal(d2.status, 'EXECUTED', JSON.stringify(d2.risk && d2.risk.checks.filter((c) => !c.pass)));
  assert.ok(desk.book.portfolio.cash < cashAfter1, 'second buy spent the SAME cash');
  assert.equal(desk.book.portfolio.openPositionCount(), 2);
  const v = desk.primary.valuation();
  assert.ok(Math.abs(v.equity - v.cash - v.positionValue) < 1e-6);
  assert.ok(Math.abs(v.equity - v.initialCapital - (v.realizedPnl + v.unrealizedPnl)) < 1e-6);
  // third symbol: max 2 simultaneous positions → rejected by the risk engine, recorded as a REJECTED order
  await desk.addSymbol('XYZ');
  provider.q('XYZ', 99.98, 100.02); provider.t('XYZ', 100);
  decider.push((s) => buyProposal(s));
  const d3 = await desk.agent('XYZ').runAnalysis(manual);
  assert.equal(d3.status, 'REJECTED_BY_RISK');
  assert.ok(d3.risk.checks.some((c) => c.name === 'max_open_positions' && !c.pass));
  const orders = store.listOrders(desk.book.session.id);
  assert.equal(orders.filter((o) => o.status === 'FILLED' && o.side === 'BUY').length, 2);
  assert.equal(orders.filter((o) => o.status === 'REJECTED' && o.symbol === 'XYZ').length, 1);
  const fills = store.listFills(desk.book.session.id);
  for (const f of fills) assert.ok(orders.some((o) => o.id === f.orderId), 'every execution belongs to an order');
  // the service (web + Telegram) sees the same book
  const pf = ctx.service.portfolio();
  assert.equal(pf.positionsCount, 2);
  assert.equal(pf.cash, desk.book.portfolio.cash);
  assert.equal(ctx.service.fills({ side: 'BUY' }).total, 2);
  assert.equal(ctx.service.orders({ status: 'REJECTED' }).total, 1);
  const st = ctx.service.stats({ period: 'all' });
  assert.equal(st.trading.buyCount, 2);
  assert.equal(st.trading.roundTrips, 0);
  assert.ok(st.insufficient.winRatePct, 'win rate needs closed trades');
  assert.equal(desk.watchlist().length, 3);
  assert.equal(store.listWatchlist('LIVE').length, 3);
});

test('watchlist safeguards: no removal with a position, pause keeps protection, removal keeps history', async () => {
  const ctx = makeDesk();
  const { desk, provider, decider, store } = ctx;
  await desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  await desk.addSymbol('ABC');
  provider.q('ABC', 99.98, 100.02); provider.t('ABC', 100);
  decider.push((s) => buyProposal(s));
  await desk.agent('ABC').runAnalysis(manual);
  await assert.rejects(desk.removeSymbol('ABC'), /open paper position/);
  await assert.rejects(desk.removeSymbol('TEST'), /main symbol/);
  desk.pauseSymbol('ABC');
  assert.equal(desk.agent('ABC').monitoringPaused, true);
  const gate = await desk.agent('ABC').runAnalysis({ reasons: [{ type: 'INTERVAL' }] });
  assert.equal(gate.skipped, true);
  assert.ok(desk.book.orders.getProtection('ABC'), 'protective stop still armed while paused');
  // stop-loss still fires while monitoring is paused
  ctx.clock.t += 5000; provider.q('ABC', 98.5, 98.6); provider.t('ABC', 98.55);
  assert.equal(desk.book.portfolio.position('ABC'), null, 'stop executed');
  await desk.removeSymbol('ABC');
  assert.equal(desk.agent('ABC'), null);
  assert.equal(store.listFills(desk.book.session.id).filter((f) => f.symbol === 'ABC').length, 2, 'history kept');
  const sells = ctx.service.fills({ side: 'SELL' }).items;
  assert.equal(sells[0].kind, 'STOP');
  assert.ok(sells[0].costBasisPrice > 0 && Number.isFinite(sells[0].returnPct));
});

class CostlyDecider extends ScriptedDecider { constructor() { super(); this.kind = 'deepseek'; this.costly = true; this.label = 'COSTLY TEST'; this.calls = 0; } async decide(s) { this.calls++; const r = await super.decide(s); return { ...r, usage: { promptTokens: 100, completionTokens: 10, cacheHit: 0, cacheMiss: 100, reasoningTokens: 0 } }; } }

test('AI cache: unchanged market state reuses the last analysis; forced triggers still analyse', async () => {
  const decider = new CostlyDecider();
  const ctx = makeDesk({ decider });
  const { desk, provider, store } = ctx;
  await desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  provider.q('TEST', 99.98, 100.02); provider.t('TEST', 100);
  const a = desk.agent('TEST');
  await a.runAnalysis(manual);
  assert.equal(decider.calls, 1);
  assert.ok(store.getAiCache('TEST', 'LIVE').stateHash);
  ctx.clock.t += 120000; provider.q('TEST', 99.98, 100.02); provider.t('TEST', 100);
  const r = await a.runAnalysis({ reasons: [{ type: 'INTERVAL', detail: 'regular' }] });
  assert.deepEqual(r, { skipped: true, reason: 'cached' });
  assert.equal(decider.calls, 1, 'no API request for an unchanged state');
  assert.equal(store.avoidedBetween('2000-01-01', '2100-01-01'), 1);
  await a.runAnalysis(manual);
  assert.equal(decider.calls, 2, 'manual request bypasses the cache');
  assert.ok(ctx.activity.recent(100).some((e) => /AI request avoided for TEST/.test(e.message)));
});

test('usage modes and per-symbol / daily limits', () => {
  const eco = effectiveAiCfg({ usageMode: 'ECONOMY', minIntervalSec: 45, regularIntervalSec: 300, maxOutputTokens: 12000, reasoningEffort: 'high', webResearch: { enabled: true, intervalMin: 30 } });
  assert.equal(eco.candleCloseTrigger, false);
  assert.equal(eco.reasoningEffort, 'none');
  assert.equal(eco.webResearch.enabled, false);
  assert.ok(eco.minIntervalSec >= 300 && eco.maxOutputTokens <= 6000);
  const det = effectiveAiCfg({ usageMode: 'DETAILED', minIntervalSec: 45, regularIntervalSec: 300, maxOutputTokens: 12000, reasoningEffort: 'high', webResearch: { enabled: true, intervalMin: 30 } });
  assert.equal(det.maxOutputTokens, 12000);
  assert.equal(det.reasoningEffort, 'high');
  const { UsageTracker } = require('../server/ai/usage');
  const store = tempStore();
  const u = new UsageTracker({ store, pricing: require('../server/config').DEFAULTS.pricing, getAiCfg: () => ({ ...effectiveAiCfg({ usageMode: 'ECONOMY', maxRequestsPerMinute: 60, dailyBudgetUsd: 100, webResearch: {} }) }) });
  const ms = Date.UTC(2026, 10, 20, 15);
  assert.equal(u.check({ model: 'deepseek-flash', promptChars: 100, maxOutputTokens: 10, ms, symbol: 'AAA' }), null);
  u.noteRequestStart(ms, 'AAA'); u.noteRequestStart(ms + 1, 'AAA');
  assert.match(u.check({ model: 'deepseek-flash', promptChars: 100, maxOutputTokens: 10, ms: ms + 2, symbol: 'AAA' }), /Per-symbol limit: AAA 2\/2/);
  assert.equal(u.check({ model: 'deepseek-flash', promptChars: 100, maxOutputTokens: 10, ms: ms + 2, symbol: 'BBB' }), null);
  store.close();
});

test('material state hash ignores price noise inside one ATR step but sees structure and news', () => {
  const snap = (price, news = [], structure = 'UPTREND') => ({ market: { lastPrice: price, session: 'REGULAR' }, timeframes: { '5m': { indicators: { atr14: { available: true, value: 1 } }, structure: { trend: 'UP', emaStack: 'BULLISH' }, signals: [], technicals: { atr14: 1, marketStructure: structure, supports: [], resistances: [] } } }, risk: { tradingAllowed: true, blocks: [], profile: 'BALANCED' }, pendingOrders: [], untrusted_external_content: { news } });
  const h = (s) => materialStateHash(s, '5m', 0.5);
  assert.equal(h(snap(100.1)), h(snap(100.3)));
  assert.notEqual(h(snap(100.1)), h(snap(101.2)));
  assert.notEqual(h(snap(100.1)), h(snap(100.1, [{ news_id: 'n1' }])));
  assert.notEqual(h(snap(100.1)), h(snap(100.1, [], 'DOWNTREND')));
});

test('Gemini client: JSON request shape, usage mapping, documented error codes', async () => {
  const calls = [];
  const ok = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 200, text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: 'secret', thought: true }, { text: '{"action":"WAIT"}' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1000, cachedContentTokenCount: 200, candidatesTokenCount: 50, thoughtsTokenCount: 30 }, modelVersion: 'gemini-3.5-flash-lite' }) }; };
  const c = new GeminiClient({ apiKey: 'AIzaTESTKEY000000000000000000', fetchImpl: ok });
  const r = await c.chat({ model: 'gemini-3.5-flash-lite', messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'u' }], maxTokens: 500, reasoningEffort: 'low' });
  assert.equal(r.content, '{"action":"WAIT"}', 'thought parts are never returned');
  assert.deepEqual(r.usage, { promptTokens: 1000, completionTokens: 80, cacheHit: 200, cacheMiss: 800, reasoningTokens: 30 });
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(calls[0].opts.headers['x-goog-api-key'], 'AIzaTESTKEY000000000000000000');
  assert.match(calls[0].url, /\/v1beta\/models\/gemini-3\.5-flash-lite:generateContent$/);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'LOW');
  assert.equal(body.systemInstruction.parts[0].text, 'sys');
  const fail = (status, err) => async () => ({ ok: false, status, text: async () => JSON.stringify({ error: err }) });
  await assert.rejects(new GeminiClient({ apiKey: 'k', fetchImpl: fail(400, { message: 'API key not valid. Please pass a valid API key.', details: [{ reason: 'API_KEY_INVALID' }] }) }).chat({ model: 'm', messages: [] }), (e) => e.code === 'INVALID_KEY');
  await assert.rejects(new GeminiClient({ apiKey: 'k', fetchImpl: fail(429, { message: 'quota', status: 'RESOURCE_EXHAUSTED' }) }).chat({ model: 'm', messages: [] }), (e) => e.code === 'RATE_LIMIT' && e.retryable);
  await assert.rejects(new GeminiClient({ apiKey: 'k', fetchImpl: fail(402, { message: 'credits' }) }).chat({ model: 'm', messages: [] }), (e) => e.code === 'INSUFFICIENT_BALANCE' && !e.retryable);
});

test('overnight session and reference prices are labelled, never execution data', async () => {
  const cal = new MarketCalendar({ overnight: { enabled: true } });
  const sunNight = etWallToUtcMs('2026-11-22', 21, 0);
  assert.equal(cal.info(sunNight).session, 'OVERNIGHT');
  assert.equal(cal.info(etWallToUtcMs('2026-11-20', 21, 0)).session, 'CLOSED', 'no overnight session on Friday night');
  const responses = {
    'data.alpaca.markets': { AAA: { latestQuote: { bp: 10, ap: 10.2, t: new Date(sunNight).toISOString() }, latestTrade: { p: 10.1, t: new Date(sunNight - 900000).toISOString() } } },
    'api.tiingo.com': [{ ticker: 'aaa', timestamp: new Date(sunNight).toISOString(), tngoLast: 10.05, lqBidPrice: 10, lqAskPrice: 10.1 }],
  };
  const seen = [];
  const fetchImpl = async (url, opts) => { seen.push({ url, opts }); const host = new URL(url).hostname; return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify(responses[host]) }; };
  const cfg = require('../server/config').DEFAULTS;
  const secrets = { ALPACA_KEY_ID: 'k', ALPACA_SECRET_KEY: 's', TIINGO_API_KEY: 't' };
  const svc = new ReferencePriceService({ getCfg: () => cfg, getSecret: (n) => secrets[n], getSession: () => cal.info(sunNight), fetchImpl, now: () => sunNight });
  svc.setSymbols(['AAA']);
  assert.equal(svc.wanted(), true);
  const out = [];
  svc.on('reference', (r) => out.push(r));
  await svc.tick();
  assert.equal(out[0].kind, 'INDICATIVE', 'free Alpaca overnight quotes are indicative');
  assert.match(seen[0].url, /feed=overnight/);
  const t = await svc.pollTiingo();
  assert.equal(t[0].kind, 'INDICATIVE');
  assert.equal(t[0].provider, 'Tiingo 24x5 (derived reference price)');
  assert.equal(seen[1].opts.headers.Authorization, 'Token t');
  const regular = new ReferencePriceService({ getCfg: () => cfg, getSecret: (n) => secrets[n], getSession: () => cal.info(etWallToUtcMs('2026-11-23', 11, 0)), fetchImpl, now: () => sunNight });
  regular.setSymbols(['AAA']);
  assert.equal(regular.wanted(), false, 'regular session uses the execution feed only');
});

test('reporting periods follow the configured timezone', () => {
  const now = Date.UTC(2026, 10, 20, 12, 0); // Friday 2026-11-20 12:00 UTC
  const [fromNy] = periodRange('today', now, 'America/New_York');
  assert.equal(new Date(fromNy).toISOString(), '2026-11-20T05:00:00.000Z');
  const [fromRiyadh] = periodRange('today', now, 'Asia/Riyadh');
  assert.equal(new Date(fromRiyadh).toISOString(), '2026-11-19T21:00:00.000Z');
  const [weekFrom] = periodRange('week', now, 'America/New_York');
  assert.equal(new Date(weekFrom).toISOString(), '2026-11-16T05:00:00.000Z', 'week starts Monday 00:00');
  const [monthFrom] = periodRange('month', now, 'America/New_York');
  assert.equal(new Date(monthFrom).toISOString(), '2026-11-01T04:00:00.000Z', 'DST-correct month start');
});

test('data-kind labels: synthetic data and reference prices are never shown as live trades', () => {
  const { MarketState } = require('../server/market/marketState');
  const now = etWallToUtcMs('2026-11-23', 1, 0); // Monday 01:00 ET — overnight
  const ms = new MarketState({ symbol: 'AAA', cfg: { maxQuoteAgeMs: 15000, maxExchangeLagMs: 60000 } });
  assert.equal(ms.dataKind({ code: 'DEMO' }, now), 'SYNTHETIC');
  assert.equal(ms.dataKind({ code: 'REPLAY' }, now), 'REPLAY');
  assert.equal(ms.dataKind({ code: 'CLOSED' }, now), 'MARKET_CLOSED', 'no reference → market closed, not a price');
  ms.onReference({ price: 10.05, ts: now - 60000, kind: 'INDICATIVE', provider: 'Alpaca overnight' });
  assert.equal(ms.dataKind({ code: 'CLOSED' }, now), 'INDICATIVE');
  assert.equal(ms.lastTrade, null, 'a reference price never becomes a trade print');
  ms.onReference({ price: 10.1, ts: now - 30000, kind: 'DELAYED', provider: 'Alpaca BOATS' });
  assert.equal(ms.dataKind({ code: 'CLOSED' }, now), 'DELAYED');
  assert.equal(ms.dataKind({ code: 'CLOSED' }, now + 3600000), 'MARKET_CLOSED', 'an old reference price is not presented as current');
  assert.equal(ms.dataKind({ code: 'NO_DATA' }, now), 'DATA_UNAVAILABLE');
});

test('news, data-reliability and breakout events reach the notification channel once', async () => {
  const ctx = makeDesk();
  const { desk, service } = ctx;
  await desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  await desk.addSymbol('ABC');
  const evts = [];
  service.on('event', (e) => evts.push(e));
  const abc = desk.agent('ABC');
  abc.news.emit('breaking', { id: 'n1', title: 'ABC wins a large contract', source: 'Business Wire', url: 'https://example.com/n1' });
  abc.news.emit('breaking', { id: 'n1', title: 'ABC wins a large contract', source: 'Business Wire', url: 'https://example.com/n1' });
  const news = evts.filter((e) => e.type === 'NEWS_MATERIAL');
  assert.equal(news.length, 2, 'the engine reports what it saw');
  assert.equal(news[0].id, news[1].id, 'same stable id, so the notifier sends it once');
  assert.equal(news[0].symbol, 'ABC');
  const ds = { code: 'STALE', label: 'STALE DATA — TRADING PAUSED', codes: [], detail: 'no quote' };
  abc.noteDataUnreliable(ds, 'no quote', ctx.clock.now());
  abc.noteDataUnreliable(ds, 'no quote', ctx.clock.now() + 1000);
  assert.equal(evts.filter((e) => e.type === 'DATA_UNRELIABLE').length, 1, 'one alert per episode');
  abc.lastAnalysis = { price: 99, levels: { breakout: { price: 100, label: 'R1' } } };
  abc.breakNotified = null;
  // the level-break check runs on price updates; call the guarded helper path twice through two ticks
  ctx.provider.q('ABC', 100.48, 100.52); ctx.provider.t('ABC', 100.5);
  ctx.provider.t('ABC', 100.6);
  const brk = evts.filter((e) => e.type === 'BREAKOUT');
  assert.equal(brk.length, 1, 'one breakout alert per level per day');
  assert.equal(brk[0].data.type, 'BREAKOUT');
  assert.equal(brk[0].data.level, 100);
});

test('overnight AUTO provider falls back to Tiingo if Alpaca returns no stock quotes', async () => {
  const { DEFAULTS } = require('../server/config');
  const t = etWallToUtcMs('2026-11-22', 21, 0);
  const cfg = structuredClone(DEFAULTS);
  cfg.market.overnight.provider = 'auto';
  let alpacaCalls = 0;
  let tiingoCalls = 0;
  const fetchImpl = async (url) => {
    const host = new URL(url).hostname;
    if (host === 'data.alpaca.markets') { alpacaCalls++; return { ok: true, status: 200, headers: new Map(), text: async () => '{}' }; }
    tiingoCalls++;
    return { ok: true, status: 200, headers: new Map(), text: async () => JSON.stringify([{ ticker: 'AAA', timestamp: new Date(t).toISOString(), tngoLast: 20.5 }]) };
  };
  const secrets = { ALPACA_KEY_ID: 'test-key', ALPACA_SECRET_KEY: 'test-secret', TIINGO_API_KEY: 'test-token' };
  const service = new ReferencePriceService({ getCfg: () => cfg, getSecret: (name) => secrets[name], getSession: () => ({ session: 'OVERNIGHT' }), fetchImpl, now: () => t });
  service.setSymbols(['AAA']);
  const updates = [];
  service.on('reference', (r) => updates.push(r));
  await service.tick();
  assert.equal(alpacaCalls, 1);
  assert.equal(tiingoCalls, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].provider, 'Tiingo 24x5 (derived reference price)');
  assert.equal(updates[0].kind, 'INDICATIVE');
  // No extra upstream traffic before the provider polling interval expires.
  await service.tick();
  assert.equal(alpacaCalls, 1);
  assert.equal(tiingoCalls, 1);
});
