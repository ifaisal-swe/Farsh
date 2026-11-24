'use strict';
/** A live agent on a scripted feed and decider (same setup as agent.test.js). */
const { Store } = require('../../server/db');
const { ConfigManager } = require('../../server/config');
const { SecretStore } = require('../../server/secrets');
const { ActivityLog } = require('../../server/activity');
const { TradingAgent } = require('../../server/engine/agent');
const { Redactor } = require('../../server/util/misc');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./fixtures');
const { LEGACY_DEFAULTS } = require('../../server/trading/riskProfiles');

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

module.exports = { makeAgent, startLive, manual, buyProposal };
