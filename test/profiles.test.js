'use strict';
/** Risk profiles: presets, CUSTOM detection, migration, real engine enforcement, exposure review. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/db');
const { ConfigManager, migrateUserConfig } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { TradingAgent } = require('../server/engine/agent');
const { RiskManager } = require('../server/trading/risk');
const { Redactor } = require('../server/util/misc');
const { PROFILES, PROFILE_KEYS, detectProfile, LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

test('profile table matches the specification', () => {
  const spec = {
    CONSERVATIVE: [0.25, 1, 5, 10, 2.0, 1], BALANCED: [0.5, 2, 8, 20, 1.8, 2], AGGRESSIVE: [1, 3, 12, 30, 1.5, 3], VERY_AGGRESSIVE: [2, 5, 20, 50, 1.2, 4],
  };
  for (const [id, v] of Object.entries(spec)) {
    const p = PROFILES[id];
    assert.deepEqual([p.maxRiskPerTradePct, p.maxDailyLossPct, p.maxDrawdownPct, p.maxPositionPct, p.minRewardRisk, p.maxOpenPositions], v, id);
  }
  assert.equal(detectProfile(PROFILES.AGGRESSIVE), 'AGGRESSIVE');
  assert.equal(detectProfile({ ...PROFILES.AGGRESSIVE, maxRiskPerTradePct: 0.9 }), 'CUSTOM');
});

test('config: default is BALANCED; editing one limit marks CUSTOM; choosing a preset restores it', () => {
  const store = new Store(':memory:');
  const c = new ConfigManager(store);
  assert.equal(c.get().risk.profile, 'BALANCED');
  assert.equal(c.get().ui.language, 'ar');
  c.update({ risk: { maxPositionPct: 15 } });
  assert.equal(c.get().risk.profile, 'CUSTOM');
  c.update({ risk: { profile: 'CONSERVATIVE', ...PROFILES.CONSERVATIVE } });
  assert.equal(c.get().risk.profile, 'CONSERVATIVE');
  // editing back to exact preset values is detected as that preset
  c.update({ risk: { maxPositionPct: 20, maxRiskPerTradePct: 0.5, maxDailyLossPct: 2, maxDrawdownPct: 8, minRewardRisk: 1.8, maxOpenPositions: 2, maxStopDistancePct: 5, maxConsecutiveLosses: 3, lossCooldownMin: 30, maxTradesPerDay: 8 } });
  assert.equal(c.get().risk.profile, 'BALANCED');
  assert.throws(() => c.update({ risk: { profile: 'YOLO' } }), /must be one of/);
  assert.throws(() => c.update({ ui: { language: 'fr' } }), /must be one of/);
  store.close();
});

test('migration keeps the effective limits of a stored pre-profile configuration', () => {
  const { user, migrated } = migrateUserConfig({ risk: { maxRiskPerTradePct: 5, maxDailyLossPct: 10, minRewardRisk: 0.5 } });
  assert.equal(migrated, true);
  assert.equal(user.risk.profile, 'CUSTOM');
  assert.equal(user.risk.maxRiskPerTradePct, 5);
  assert.equal(user.risk.maxPositionPct, LEGACY_DEFAULTS.maxPositionPct, 'old default allocation pinned');
  assert.equal(user.risk.maxDrawdownPct, LEGACY_DEFAULTS.maxDrawdownPct);
  assert.equal(migrateUserConfig({ ai: { model: 'x' } }).migrated, false, 'no risk overrides → default profile');
  const store = new Store(':memory:');
  store.setSetting('config', { risk: { maxRiskPerTradePct: 5 } });
  const c = new ConfigManager(store);
  assert.equal(c.get().risk.profile, 'CUSTOM');
  assert.equal(c.get().risk.maxPositionPct, 25);
  assert.equal(store.getSetting('config').risk.profile, 'CUSTOM', 'migration persisted');
  store.close();
});

const Q = { bid: 99.98, ask: 100.02, bidSize: 500, askSize: 500 };
const MKT = { realtime: true, feedLabel: 'LIVE — TEST', connected: true, stale: false, staleReasons: [], quoteAgeMs: 200, halted: false, session: 'REGULAR' };
const { DEFAULTS } = require('../server/config');
const evalWith = (id, p = {}, acct = {}) => new RiskManager({ ...DEFAULTS.risk, ...PROFILES[id], profile: id }).evaluateEntry({
  proposal: { stopLoss: 98, takeProfit: 106, positionSizePct: null, orderType: 'MARKET', limitPrice: null, snapshotPrice: 100, createdAt: T0, ...p },
  quote: Q, market: MKT, account: { equity: 10000, cash: 10000, positionQty: 0, positionMark: 0, openPositions: 0, ...acct }, ipo: {}, exec: { ...DEFAULTS.execution }, ai: { proposalMaxAgeSec: 120, maxPriceDriftPct: 0.5 }, nowMs: T0 + 1000,
});

test('each profile really changes position sizing and the actual risk taken (incl. costs)', () => {
  const sizes = {};
  for (const id of Object.keys(PROFILES)) {
    const r = evalWith(id);
    assert.equal(r.approved, true, `${id}: ${r.failed.join('|')}`);
    const L = PROFILES[id];
    assert.ok(r.sizing.riskAtStop <= 10000 * L.maxRiskPerTradePct / 100 + 1e-6, `${id} risk within budget`);
    assert.ok(r.qty * r.fillEstimate <= 10000 * L.maxPositionPct / 100 + 1e-6, `${id} allocation within cap`);
    assert.ok(r.checks.some((c) => c.name === 'risk_per_trade' && c.pass));
    sizes[id] = r.qty;
  }
  assert.ok(sizes.CONSERVATIVE < sizes.BALANCED && sizes.BALANCED < sizes.AGGRESSIVE && sizes.AGGRESSIVE < sizes.VERY_AGGRESSIVE, JSON.stringify(sizes));
  // conservative: risk 0.25% of 10k = $25 / ≈2.06 per share → 12 sh, but the 10% allocation cap ($1,000) allows 9
  assert.equal(sizes.CONSERVATIVE, 9);
  assert.equal(evalWith('CONSERVATIVE').sizing.limitingFactor, 'byAllocation');
  // with a tighter allocation-free comparison, the risk budget binds: 2.06/share at 0.25% → 12 sh at most
  const wideStop = evalWith('CONSERVATIVE', { stopLoss: 97.5, takeProfit: 106 });
  assert.equal(wideStop.sizing.limitingFactor, 'byRisk');
  assert.ok(wideStop.sizing.riskAtStop <= 25 + 1e-6);
});

test('profile minimum reward:risk and maximum stop distance are enforced', () => {
  const tight = evalWith('CONSERVATIVE', { stopLoss: 98, takeProfit: 103.5 }); // ~1.7 R:R < 2.0
  assert.ok(tight.checks.some((c) => c.name === 'reward_to_risk' && !c.pass));
  assert.equal(evalWith('VERY_AGGRESSIVE', { stopLoss: 98, takeProfit: 103.5 }).approved, true);
  const wide = evalWith('CONSERVATIVE', { stopLoss: 95, takeProfit: 112 }); // stop ~5% away > 3%
  assert.ok(wide.checks.some((c) => c.name === 'stop_distance_max' && !c.pass));
});

function makeAgent() {
  const store = new Store(':memory:');
  const clock = { t: T0, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  let agent;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (agent && agent.session ? agent.session.id : null) });
  const provider = new FakeProvider({ clock });
  const decider = new ScriptedDecider();
  agent = new TradingAgent({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  agent.news.start = () => {};
  agent.scheduler.run = async () => ({ skipped: true });
  return { agent, store, clock, provider, decider, activity, config };
}

test('switching Aggressive → Conservative: stricter limits apply now, nothing is liquidated, reduction explained', async () => {
  const ctx = makeAgent();
  const { agent, decider, provider } = ctx;
  agent.setRiskProfile('AGGRESSIVE');
  await agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  provider.quote(99.98, 100.02); provider.trade(100);
  decider.push((s) => buyProposal(s));
  const d = await agent.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(d.status, 'EXECUTED', JSON.stringify(d.risk && d.risk.checks.filter((c) => !c.pass)));
  const qty = agent.portfolio.position('TEST').qty;
  assert.ok(qty > 10, `aggressive size ${qty}`);
  assert.equal(ctx.store.listFills(agent.session.id)[0].riskProfile, 'AGGRESSIVE');
  const capital = agent.portfolio.initialCapital;
  const r = agent.setRiskProfile('CONSERVATIVE');
  assert.equal(agent.portfolio.position('TEST').qty, qty, 'position NOT sold automatically');
  assert.equal(agent.portfolio.initialCapital, capital, 'initial capital unchanged');
  assert.equal(agent.risk.limits.maxPositionPct, 10, 'engine uses the new limits');
  assert.equal(r.review.compliant, false);
  const alloc = r.review.findings.find((f) => f.code === 'allocation');
  assert.equal(alloc.ok, false);
  assert.ok(r.review.reduceQty > 0 && r.review.reduceQty < qty);
  assert.ok(ctx.activity.recent(50).some((e) => /Nothing was sold automatically/.test(e.message)));
  assert.ok(agent.orders.getProtection('TEST'), 'protective stop still active');
  // the user confirms the suggested reduction
  agent.reducePosition(r.review.reduceQty);
  const after = agent.portfolio.position('TEST').qty;
  assert.equal(after, qty - r.review.reduceQty);
  assert.equal(agent.riskReview.findings.find((f) => f.code === 'allocation').ok, true, 'within the new allocation cap after reducing');
  // new entries are evaluated with the conservative limits
  assert.equal(agent.publicState().riskProfile.profile, 'CONSERVATIVE');
});

test('a stricter daily-loss limit is enforced immediately when the profile changes', async () => {
  const ctx = makeAgent();
  const { agent, provider } = ctx;
  agent.setRiskProfile('VERY_AGGRESSIVE');
  await agent.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  provider.quote(99.98, 100.02); provider.trade(100);
  agent.risk.onEquity(10000, ctx.clock.now());
  agent.risk.state.dayStartEquity = 10150; // day P&L ≈ -1.5%
  assert.equal(agent.risk.entryBlocks(ctx.clock.now()).length, 0, '5% limit not hit');
  agent.setRiskProfile('CONSERVATIVE');
  assert.ok(agent.risk.entryBlocks(ctx.clock.now()).some((b) => /DAILY LOSS LIMIT/.test(b)), 'conservative 1% daily limit applies at once');
});

test('profile keys are all bounded editable settings', () => {
  const store = new Store(':memory:');
  const c = new ConfigManager(store);
  for (const k of PROFILE_KEYS) assert.doesNotThrow(() => c.update({ risk: { [k]: PROFILES.AGGRESSIVE[k] } }), k);
  store.close();
});
