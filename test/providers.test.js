'use strict';
/** AI Provider Manager: DeepSeek-only, Gemini-only, AUTO, DUAL, failover, circuit breakers, budgets, usage per provider. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/db');
const { DEFAULTS, deepMerge } = require('../server/config');
const { UsageTracker } = require('../server/ai/usage');
const { effectiveAiCfg } = require('../server/ai/costControl');
const { AiProviderManager } = require('../server/ai/providerManager');
const { validateProposal } = require('../server/ai/proposal');
const { etDateStr } = require('../server/util/time');

const T = Date.UTC(2026, 10, 23, 15, 0, 0); // Monday 10:00 ET
const SNAP = { id: 'snap_1', market: { quote: { bid: 99.98, ask: 100.02 }, lastPrice: 100 } };
const USAGE = { promptTokens: 1000, completionTokens: 200, cacheHit: 0, cacheMiss: 1000, reasoningTokens: 0 };
const buy = (over = {}) => ({ snapshot_id: SNAP.id, action: 'BUY', strategy: 'BREAKOUT', directional_bias: 'BULLISH', trend: 'UPTREND', sentiment: 'BULLISH', confidence: 70, order: { type: 'MARKET', limit_price: null }, entry_price: 100.02, stop_loss: 99, take_profit: 103, position_size_pct_of_equity: 20, evidence: ['breakout'], rationale: 'buy it', invalidation: 'below 99', ...over });
const wait = (over = {}) => ({ snapshot_id: SNAP.id, action: 'WAIT', strategy: 'BREAKOUT', directional_bias: 'NEUTRAL', trend: 'UNCLEAR', sentiment: 'NEUTRAL', confidence: 55, order: { type: 'MARKET', limit_price: null }, evidence: ['no setup'], rationale: 'wait', invalidation: '', ...over });

function fakeDecider(model, script) {
  const d = {
    calls: 0, model,
    promptFor: () => [{ role: 'system', content: 'x'.repeat(3000) }],
    async decide() {
      d.calls++;
      const out = script(d.calls);
      if (out instanceof Error) throw out;
      return { content: JSON.stringify(out), usage: USAGE, latencyMs: 5, model, finishReason: 'stop' };
    },
  };
  return d;
}
const err = (code, msg = code) => Object.assign(new Error(msg), { code });

function setup({ ai = {}, keys = { DEEPSEEK_API_KEY: 'k1', GEMINI_API_KEY: 'k2' }, ds = () => buy(), gm = () => buy(), equalPrices = false } = {}) {
  const store = new Store(':memory:');
  const clock = { t: T };
  const cfg = deepMerge(DEFAULTS, { ai: { mode: 'AUTO', fallback: true, ...ai } });
  const pricing = equalPrices ? deepMerge(DEFAULTS.pricing, { models: { 'gemini-3.5-flash-lite': DEFAULTS.pricing.models['deepseek-flash'] } }) : DEFAULTS.pricing;
  const aiCfg = () => ({ ...effectiveAiCfg(cfg.ai), mode: cfg.ai.mode });
  const usage = new UsageTracker({ store, pricing, getAiCfg: aiCfg });
  const D = fakeDecider('deepseek-flash', ds);
  const G = fakeDecider('gemini-3.5-flash-lite', gm);
  const mgr = new AiProviderManager({ store, usage, now: () => clock.t, getSecret: (n) => keys[n], getCfg: () => ({ ...cfg, ai: aiCfg() }), deciders: { deepseek: () => D, gemini: () => G } });
  const validate = (c) => validateProposal(c, { snapshotId: SNAP.id, symbol: 'TEST', price: 100, hasPosition: false });
  const run = async (triggers = ['MANUAL'], extra = {}) => {
    const plan = mgr.plan({ promptChars: 3000, triggers, ms: clock.t });
    if (plan.blocked) return { plan };
    const resp = await mgr.decide(SNAP, { plan, validate, hasPosition: false, language: 'en', ...extra });
    for (const a of resp.attempts) usage.record({ provider: a.provider, model: a.model, purpose: 'decision', ok: a.ok, usage: a.usage, latencyMs: a.latencyMs, error: a.error, ms: clock.t });
    return { plan, resp };
  };
  return { store, clock, cfg, usage, mgr, D, G, run, keys };
}

test('DeepSeek-only and Gemini-only modes call only their provider', async () => {
  const a = setup({ ai: { mode: 'DEEPSEEK' } });
  const r1 = await a.run();
  assert.equal(r1.resp.provider, 'deepseek');
  assert.equal(a.D.calls, 1); assert.equal(a.G.calls, 0);
  const b = setup({ ai: { mode: 'GEMINI' } });
  const r2 = await b.run();
  assert.equal(r2.resp.provider, 'gemini');
  assert.equal(b.G.calls, 1); assert.equal(b.D.calls, 0);
  // usage is recorded per provider, and combined
  const day = etDateStr(T);
  assert.equal(b.store.usageForDay(day, 'gemini').requests, 1);
  assert.equal(b.store.usageForDay(day, 'deepseek').requests, 0);
  assert.equal(b.store.usageForDay(day).requests, 1);
});

test('failover: a DeepSeek error falls back to Gemini once; disabled fallback blocks instead', async () => {
  const a = setup({ ai: { mode: 'DEEPSEEK' }, ds: () => err('SERVER', 'HTTP 503') });
  const fall = [];
  const r = await a.run(['MANUAL'], { onFallback: (x) => fall.push(x) });
  assert.equal(r.resp.provider, 'gemini');
  assert.equal(r.resp.fallbackFrom, 'deepseek');
  assert.equal(r.resp.attempts.length, 2);
  assert.equal(r.resp.attempts[0].ok, false);
  assert.equal(fall.length, 1);
  assert.equal(a.store.usageForDay(etDateStr(T), 'deepseek').errors, 1, 'the failed DeepSeek call is recorded as an error');
  const b = setup({ ai: { mode: 'GEMINI', fallback: false }, keys: { DEEPSEEK_API_KEY: 'k1' } });
  const rb = await b.run();
  assert.match(rb.plan.blocked, /Gemini unavailable/);
  assert.equal(b.D.calls, 0, 'no silent provider switch when fallback is disabled');
  const c = setup({ ai: { mode: 'DEEPSEEK' }, ds: () => err('SERVER'), gm: () => err('SERVER') });
  await assert.rejects(() => c.run(), (e) => e.attempts.length === 2 && e.attempts.every((x) => !x.ok));
});

test('circuit breaker: repeated failures pause a provider; fatal errors pause it long; a new key resets it', async () => {
  const a = setup({ ai: { mode: 'DEEPSEEK', fallback: false }, ds: () => err('SERVER') });
  for (let i = 0; i < 3; i++) await assert.rejects(() => a.run());
  assert.ok(a.mgr.isOpen('deepseek'), 'opened after 3 consecutive failures');
  const p = a.mgr.plan({ promptChars: 3000, triggers: ['MANUAL'] });
  assert.match(p.blocked, /paused after errors/);
  assert.equal(a.D.calls, 3, 'no 4th call while the circuit is open');
  a.clock.t += 6 * 60000;
  assert.equal(a.mgr.isOpen('deepseek'), false, 'cooldown elapsed');
  const b = setup({ ai: { mode: 'AUTO' }, gm: () => err('INVALID_KEY', 'API key not valid') });
  b.mgr.recordFailure('gemini', err('INVALID_KEY'));
  assert.ok(b.mgr.health.gemini.openUntil - T >= 59 * 60000, 'invalid key: long cooldown');
  b.mgr.recordFailure('deepseek', err('RATE_LIMIT', 'Quota exceeded for metric: generate_content_free_tier_requests, limit: 0'));
  assert.equal(b.mgr.health.deepseek.code, 'QUOTA', 'exhausted quota is recognised and not retried quickly');
  b.mgr.credentialsChanged('GEMINI_API_KEY');
  assert.equal(b.mgr.isOpen('gemini'), false, 'a new key closes the circuit');
  // health survives a restart (persisted)
  const again = new AiProviderManager({ store: b.store, usage: b.usage, now: () => b.clock.t, getSecret: (n) => b.keys[n], getCfg: () => b.cfg, deciders: {} });
  assert.ok(again.isOpen('deepseek'));
});

test('AUTO picks the cheaper reliable provider, is sticky, and avoids a failing one', async () => {
  const a = setup({ ai: { mode: 'AUTO' } });
  const r = await a.run(['REGULAR']);
  const s = a.mgr.lastScores;
  const cheaper = s.deepseek.score <= s.gemini.score ? 'deepseek' : 'gemini';
  assert.equal(r.resp.provider, cheaper);
  // equal prices: reliability decides
  const b = setup({ ai: { mode: 'AUTO' }, equalPrices: true });
  for (let i = 0; i < 10; i++) b.store.insertUsage({ ts: T - i, day: etDateStr(T), model: 'deepseek-flash', purpose: 'decision', ok: false, provider: 'deepseek', error: 'HTTP 500' });
  b.mgr.statsCache.at = 0;
  const rb = await b.run(['REGULAR']);
  assert.equal(rb.resp.provider, 'gemini', 'a provider failing 100% of recent requests is ranked last');
  assert.deepEqual(rb.plan.order, ['gemini', 'deepseek'], 'the other provider stays available as fallback');
});

test('budgets: per-provider and global daily limits stop requests (not monitoring)', async () => {
  const a = setup({ ai: { mode: 'DEEPSEEK', fallback: true, deepseekDailyBudgetUsd: 0.001 } });
  a.store.insertUsage({ ts: T, day: etDateStr(T), model: 'deepseek-flash', purpose: 'decision', ok: true, provider: 'deepseek', costUsd: 0.001 });
  const r = await a.run();
  assert.equal(r.resp.provider, 'gemini', 'DeepSeek budget reached → fallback provider');
  assert.match(a.mgr.unusable('deepseek', { promptChars: 3000 }), /DeepSeek daily budget/);
  const b = setup({ ai: { mode: 'AUTO', dailyBudgetUsd: 0 } });
  const rb = await b.run();
  assert.match(rb.plan.blocked, /No AI provider available/);
  assert.equal(b.D.calls + b.G.calls, 0);
});

test('DUAL: important events go to both; agreement keeps the conservative plan; disagreement never trades', async () => {
  const agree = setup({ ai: { mode: 'DUAL' }, ds: () => buy({ position_size_pct_of_equity: 30, confidence: 80 }), gm: () => buy({ position_size_pct_of_equity: 10, confidence: 60, stop_loss: 99.5 }) });
  const r1 = await agree.run(['NEWS']);
  assert.equal(r1.plan.dual, true);
  assert.equal(agree.D.calls, 1); assert.equal(agree.G.calls, 1);
  const raw = JSON.parse(r1.resp.content);
  assert.equal(raw.action, 'BUY');
  assert.equal(raw.position_size_pct_of_equity, 10, 'smaller size kept');
  assert.equal(raw.stop_loss, 99.5, "one provider's plan is kept whole (no mixed fields)");
  assert.equal(raw.confidence, 60, 'lower confidence');
  assert.equal(r1.resp.dual.policy, 'AGREE_CONSERVATIVE');
  assert.equal(r1.resp.provider, 'dual');
  assert.equal(r1.resp.attempts.length, 2, 'both calls are accounted');

  const dis = setup({ ai: { mode: 'DUAL' }, ds: () => buy(), gm: () => wait() });
  const r2 = await dis.run(['LEVEL_BREAK']);
  const raw2 = JSON.parse(r2.resp.content);
  assert.equal(raw2.action, 'WAIT', 'disagreement → no trade');
  assert.equal(raw2.entry_price, null);
  assert.equal(r2.resp.dual.policy, 'DISAGREE_WAIT');
  assert.equal(r2.resp.dual.combinedUncertainty, 'HIGH');
  assert.ok(r2.resp.dual.disagreement.some((x) => x.field === 'action'));
  assert.equal(validateProposal(r2.resp.content, { snapshotId: SNAP.id, symbol: 'TEST', price: 100, hasPosition: false }).ok, true, 'combined result passes the same validator');

  const held = setup({ ai: { mode: 'DUAL' }, ds: () => ({ ...wait(), action: 'EXIT_POSITION' }), gm: () => ({ ...wait(), action: 'HOLD' }) });
  const plan = held.mgr.plan({ promptChars: 3000, triggers: ['NEWS'] });
  const r3 = await held.mgr.decide(SNAP, { plan, hasPosition: true, language: 'ar', validate: (c) => validateProposal(c, { snapshotId: SNAP.id, symbol: 'TEST', price: 100, hasPosition: true }) });
  assert.equal(JSON.parse(r3.content).action, 'HOLD', 'in a position, disagreement holds (protective orders stay)');

  const routine = setup({ ai: { mode: 'DUAL' } });
  const r4 = await routine.run(['REGULAR']);
  assert.equal(r4.plan.dual, false, 'routine reviews use one provider');
  assert.equal(routine.D.calls + routine.G.calls, 1);

  const half = setup({ ai: { mode: 'DUAL' }, gm: () => err('SERVER') });
  const r5 = await half.run(['NEWS']);
  assert.equal(r5.resp.provider, 'deepseek');
  assert.equal(r5.resp.dual.degraded, true, 'one provider failing → single analysis, clearly marked');
});

test('provider status reports usage per provider without secrets', async () => {
  const a = setup({ ai: { mode: 'AUTO' } });
  await a.run();
  const st = a.mgr.status();
  assert.equal(st.mode, 'AUTO');
  assert.equal(st.providers.deepseek.configured, true);
  assert.equal(st.providers.deepseek.requestsToday + st.providers.gemini.requestsToday, 1);
  assert.equal(JSON.stringify(st).includes('k1'), false, 'no key values');
});

// ---------------------------------------------------------------- through the real engine
test('engine: DUAL disagreement on a news event records both providers, no order; usage is split per provider', async () => {
  const { ConfigManager } = require('../server/config');
  const { SecretStore } = require('../server/secrets');
  const { ActivityLog } = require('../server/activity');
  const { Desk } = require('../server/engine/desk');
  const { Redactor } = require('../server/util/misc');
  const { AnalysisScheduler } = require('../server/ai/scheduler');
  const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
  const { T0, FakeProvider, buyProposal, silentFetch } = require('./helpers/fixtures');
  const orig = AnalysisScheduler.prototype.start;
  AnalysisScheduler.prototype.start = function () { this.running = false; };
  try {
    class P extends FakeProvider { connect() { this.state = 'SUBSCRIBED'; this.emit('connection', { state: 'SUBSCRIBED', detail: 't' }); } }
    const store = new Store(':memory:');
    const clock = { t: T0, now() { return this.t; } };
    const redactor = new Redactor();
    const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-ds-0000', GEMINI_API_KEY: 'gm-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
    const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
    config.update({ risk: { ...LEGACY_DEFAULTS, profile: 'CUSTOM' }, ai: { mode: 'DUAL', dailyBudgetUsd: 5 } });
    let desk;
    const activity = new ActivityLog({ store, redactor, getSessionId: () => (desk && desk.book.session ? desk.book.session.id : null) });
    const provider = new P({ clock });
    desk = new Desk({ store, config, secrets, activity, now: () => clock.t, providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false });
    desk.primary.news.start = () => {};
    let snapRef = null;
    const mk = (model, fn) => ({ promptFor: () => [{ role: 'user', content: 'x'.repeat(2000) }], async decide(s) { snapRef = s; return { content: JSON.stringify(fn(s)), usage: USAGE, latencyMs: 3, model, finishReason: 'stop' }; } });
    desk.book.aiManager.deciders = {
      deepseek: () => mk('deepseek-flash', (s) => buyProposal(s)),
      gemini: () => mk('gemini-3.5-flash-lite', (s) => ({ snapshot_id: s.id, action: 'WAIT', strategy: 'BREAKOUT', directional_bias: 'NEUTRAL', trend: 'UNCLEAR', sentiment: 'NEUTRAL', confidence: 50, order: { type: 'MARKET', limit_price: null }, evidence: ['no confirmation'], rationale: 'wait for confirmation' })),
    };
    await desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
    provider.quote(99.98, 100.02); provider.trade(100);
    const d = await desk.primary.runAnalysis({ reasons: [{ type: 'NEWS', detail: 'material news' }] });
    assert.ok(snapRef);
    assert.equal(d.action, 'WAIT', 'disagreement → WAIT');
    assert.equal(d.provider, 'dual');
    assert.equal(d.proposal.dual.policy, 'DISAGREE_WAIT');
    assert.equal(store.listOrders(desk.book.session.id).length, 0, 'no order');
    const day = etDateStr(clock.t);
    assert.equal(store.usageForDay(day, 'deepseek').requests, 1);
    assert.equal(store.usageForDay(day, 'gemini').requests, 1);
    assert.equal(store.getDecision(d.id).provider, 'dual');
    // AI mode switch through the shared service → single provider again
    const { TerminalService } = require('../server/services/terminalService');
    const svc = new TerminalService({ desk, store, config, secrets, now: () => clock.t });
    await svc.setAiMode('GEMINI', 'test');
    assert.equal(config.get().ai.mode, 'GEMINI');
    assert.equal(svc.ai().aiMode, 'GEMINI');
    assert.equal(svc.stats({ period: 'all' }).ai.geminiRequests, 1);
    await desk.shutdown();
  } finally { AnalysisScheduler.prototype.start = orig; }
});
