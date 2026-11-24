'use strict';
/**
 * End-to-end engine tests with a fake (scripted) market feed and a scripted decider:
 * snapshot -> proposal -> validation -> risk -> simulated fill -> portfolio -> persistence.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../server/db');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { TradingAgent } = require('../server/engine/agent');
const { Redactor } = require('../server/util/misc');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');
const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');

function makeAgent({ dbFile = ':memory:', store: existing } = {}) {
  const store = existing || new Store(dbFile);
  const clock = { t: T0, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  // engine-mechanics tests use the pre-profile limits (1% risk, 25% allocation, R:R 1.5)
  if (!existing) config.update({ risk: { ...LEGACY_DEFAULTS, profile: 'CUSTOM' } });
  let agent;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (agent && agent.session ? agent.session.id : null) });
  const provider = new FakeProvider({ clock });
  const decider = new ScriptedDecider();
  agent = new TradingAgent({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  agent.news.start = () => {};
  agent.scheduler.run = async () => ({ skipped: true }); // tests drive analysis explicitly
  return { agent, store, clock, provider, decider, activity, config };
}

const manual = { reasons: [{ type: 'MANUAL', detail: 'test' }] };

async function startLive(ctx, capital = 10000) {
  await ctx.agent.startTrading({ symbol: 'TEST', initialCapital: capital, targetCapital: capital * 2 });
  ctx.provider.quote(99.98, 100.02);
  ctx.provider.trade(100);
}

test('autonomous BUY: proposal -> risk approval -> simulated fill -> portfolio & protective orders', async () => {
  const ctx = await (async () => { const c = makeAgent(); await startLive(c); return c; })();
  const { agent, decider } = ctx;
  decider.push((s) => buyProposal(s));
  const d = await agent.runAnalysis(manual);
  assert.equal(d.status, 'EXECUTED', JSON.stringify(d.risk && d.risk.checks.filter((c) => !c.pass)));
  const pos = agent.portfolio.position('TEST');
  assert.equal(pos.qty, 24);
  assert.ok(pos.avgPrice > 100.02, 'filled at the ask plus slippage');
  const v = agent.valuation();
  assert.ok(Math.abs(v.equity - v.initialCapital - (v.realizedPnl + v.unrealizedPnl)) < 1e-6);
  const prot = agent.orders.getProtection('TEST');
  assert.equal(prot.stopLoss, 99.02); assert.equal(prot.takeProfit, 103.02);
  const fills = ctx.store.listFills(agent.session.id);
  assert.equal(fills.length, 1); assert.equal(fills[0].side, 'BUY'); assert.equal(fills[0].decisionId, d.id);
  // the snapshot the AI saw had only completed bars and real quote data
  const snap = decider.seen[0];
  assert.equal(snap.market.quote.ask, 100.02);
  const atf = snap.timeframes[snap.analysisTimeframe];
  assert.ok(atf.recentBars.every((b) => Date.parse(b.t) < T0));
  assert.equal(snap.timeframes['1d'].indicators.sma200.available, true);
  const msgs = ctx.activity.recent(200).map((e) => e.message).join('\n');
  for (const needle of ['Sending market snapshot', 'AI proposes BUY', 'Trade accepted by risk engine', 'PAPER BUY executed', 'Portfolio updated']) assert.ok(msgs.includes(needle), needle);
});

test('duplicate proposal is rejected; stop-loss closes the position with a realized loss', async () => {
  const c = makeAgent();
  await startLive(c);
  c.decider.push((s) => buyProposal(s));
  await c.agent.runAnalysis(manual);
  const qty = c.agent.portfolio.position('TEST').qty;
  c.clock.t += 30000;
  c.provider.quote(99.98, 100.02);
  c.decider.push((s) => buyProposal(s));
  const dup = await c.agent.runAnalysis(manual);
  assert.equal(dup.status, 'DUPLICATE');
  assert.equal(c.agent.portfolio.position('TEST').qty, qty);
  // price falls through the stop: deterministic exit, independent of the AI
  c.clock.t += 5000;
  c.provider.quote(98.9, 98.92);
  assert.equal(c.agent.portfolio.position('TEST'), null);
  const fills = c.store.listFills(c.agent.session.id);
  const sell = fills.find((f) => f.side === 'SELL');
  assert.equal(sell.kind, 'STOP');
  assert.ok(sell.realizedPnl < 0);
  assert.ok(sell.price < 98.9, 'stop fills at the bid minus slippage (gap risk)');
  assert.equal(c.agent.risk.state.consecutiveLosses, 1);
  assert.equal(c.agent.orders.getProtection('TEST'), null);
});

test('no trades on stale data or after a disconnect; exits wait for reliable data', async () => {
  const c = makeAgent();
  await startLive(c);
  c.clock.t += 60000; // quote now 60s old
  c.decider.push((s) => buyProposal(s));
  const skipped = await c.agent.runAnalysis({ reasons: [{ type: 'CANDLE_CLOSE' }] });
  assert.equal(skipped.skipped, true);
  assert.match(skipped.reason, /reliable market data/);
  const d = await c.agent.runAnalysis(manual); // manual analysis still runs, but the risk engine blocks the trade
  assert.equal(d.status, 'REJECTED_BY_RISK');
  assert.ok(d.risk.checks.some((x) => x.name === 'data_fresh' && !x.pass));
  c.provider.quote(99.98, 100.02);
  c.provider.emit('connection', { state: 'DISCONNECTED', detail: 'network' });
  c.decider.push((s) => buyProposal(s));
  const d2 = await c.agent.runAnalysis(manual);
  assert.equal(d2.status, 'REJECTED_BY_RISK');
  assert.ok(d2.risk.checks.some((x) => x.name === 'feed_connected' && !x.pass));
  assert.equal(c.agent.portfolio.fillCount, 0);
});

test('invalid AI output never reaches the risk engine', async () => {
  const c = makeAgent();
  await startLive(c);
  c.decider.push(() => 'I think you should buy lots!');
  assert.equal(await c.agent.runAnalysis(manual), null);
  c.decider.push((s) => ({ ...buyProposal(s), snapshot_id: 'snap_forged' }));
  assert.equal(await c.agent.runAnalysis(manual), null);
  const ds = c.store.listDecisions(c.agent.session.id);
  assert.ok(ds.every((d) => d.status === 'INVALID'));
  assert.equal(c.agent.portfolio.fillCount, 0);
});

test('pause keeps protective orders active; stop keeps the open position', async () => {
  const c = makeAgent();
  await startLive(c);
  c.decider.push((s) => buyProposal(s, { tpOff: 2 }));
  await c.agent.runAnalysis(manual);
  c.agent.pause();
  assert.equal(c.agent.aiState, 'PAUSED');
  c.clock.t += 2000;
  c.provider.quote(102.1, 102.12); // through the 102.02 target while paused
  assert.equal(c.agent.portfolio.position('TEST'), null, 'take-profit executed while AI paused');
  const tp = c.store.listFills(c.agent.session.id).find((f) => f.kind === 'TAKE_PROFIT');
  assert.ok(tp && tp.realizedPnl > 0);
  c.agent.resume();
  c.provider.quote(99.98, 100.02);
  c.decider.push((s) => buyProposal(s, { stopOff: 1.2 }));
  await c.agent.runAnalysis(manual);
  assert.ok(c.agent.portfolio.position('TEST'));
  c.agent.stop();
  assert.equal(c.agent.aiState, 'STOPPED');
  assert.ok(c.agent.portfolio.position('TEST'), 'STOP never silently discards an open position');
  await c.agent.closePosition();
  assert.equal(c.agent.portfolio.position('TEST'), null);
});

test('session persistence: restarting restores portfolio, orders, risk state', async () => {
  const dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'att-')), 'db.sqlite');
  const a = makeAgent({ dbFile });
  await startLive(a);
  a.decider.push((s) => buyProposal(s));
  await a.agent.runAnalysis(manual);
  const before = { cash: a.agent.portfolio.cash, pos: { ...a.agent.portfolio.position('TEST') }, stop: a.agent.orders.effectiveStop('TEST'), sid: a.agent.session.id };
  a.agent.persist();
  a.store.close();
  // "restart"
  const b = makeAgent({ dbFile });
  const s = b.store.getActiveSession();
  assert.equal(s.id, before.sid);
  b.agent.restoreSession(s);
  assert.equal(b.agent.portfolio.cash, before.cash);
  assert.deepEqual(b.agent.portfolio.position('TEST'), before.pos);
  assert.equal(b.agent.orders.effectiveStop('TEST'), before.stop);
  assert.equal(b.store.listFills(s.id).length, 1);
  assert.ok(b.store.listDecisions(s.id).length >= 1);
  assert.ok(b.store.listActivity(s.id, 1000).some((e) => /PAPER BUY executed/.test(e.message)));
  b.store.close();
});

test('daily loss limit blocks new entries but not exits', async () => {
  const c = makeAgent();
  await startLive(c);
  c.agent.risk.onEquity(10000, c.clock.now());
  c.agent.risk.onEquity(9600, c.clock.now());
  c.decider.push((s) => buyProposal(s));
  const d = await c.agent.runAnalysis(manual);
  assert.equal(d.status, 'REJECTED_BY_RISK');
  assert.ok(d.risk.checks.some((x) => x.name === 'account_limits' && !x.pass));
  assert.equal(c.agent.displayStatus().code, 'RISK_PAUSE');
});

test('semi-autonomous mode waits for user approval', async () => {
  const c = makeAgent();
  c.config.update({ ai: { autonomy: 'SEMI' } });
  await startLive(c);
  c.decider.push((s) => buyProposal(s));
  const d = await c.agent.runAnalysis(manual);
  assert.equal(d.status, 'AWAITING_APPROVAL');
  assert.equal(c.agent.portfolio.fillCount, 0);
  c.agent.approve(d.id, true);
  assert.equal(c.agent.portfolio.position('TEST').qty, 24);
});
