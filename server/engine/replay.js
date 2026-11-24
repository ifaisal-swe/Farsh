'use strict';
/**
 * Deterministic replay harness: drives the SAME TradingAgent pipeline over historical 1-minute
 * bars with a virtual clock. Future candles and news are never visible to earlier decisions
 * (ReplayProvider filters by the virtual clock; NewsCollector filters by publication time).
 */
const { Store } = require('../db');
const { ConfigManager } = require('../config');
const { SecretStore } = require('../secrets');
const { ActivityLog } = require('../activity');
const { TradingAgent } = require('./agent');
const { ReplayProvider, VirtualClock } = require('../market/replay');
const { Redactor } = require('../util/misc');
const { computeMetrics } = require('../trading/metrics');

async function runReplay({ symbol, minuteBars, dailyBars = [], news = [], decider, initialCapital = 500, analysisTimeframe = '5m', warmupBars = 120, spreadBps = 5, configOverrides = {}, onDecision, echo = false, secretsEnv = {} }) {
  if (!minuteBars || minuteBars.length <= warmupBars) throw new Error(`Need more than ${warmupBars} minute bars for a replay`);
  const store = new Store(':memory:');
  const clock = new VirtualClock((minuteBars[warmupBars - 1].time + 60) * 1000);
  const provider = new ReplayProvider({ symbol, minuteBars, dailyBars, news, spreadBps, warmupBars, clock });
  const config = new ConfigManager(store, {
    ai: { analysisTimeframe, webResearch: { enabled: false } }, market: { maxQuoteAgeMs: 90000 },
    ...configOverrides,
  });
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { TERMINAL_MASTER_KEY: '0'.repeat(64), ...secretsEnv }, redactor });
  let agent;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (agent && agent.session ? agent.session.id : null), echo });
  agent = new TradingAgent({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, autoTimers: false, deciderOverride: decider });
  agent.news.start = () => {};
  agent.scheduler.run = async () => ({ skipped: true });
  await agent.startTrading({ symbol, initialCapital, mode: 'REPLAY' });
  // Replay news: ingest only items already published at the current virtual time.
  const pendingNews = [...news].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const decisions = [];
  while (provider.hasNext()) {
    while (pendingNews.length && Date.parse(pendingNews[0].created_at) <= clock.now()) {
      const n = pendingNews.shift();
      agent.news.ingest([{ source: n.source || 'replay', sourceType: 'news_wire', title: n.headline, url: n.url, publishedAt: Date.parse(n.created_at), summary: n.summary || '', symbols: n.symbols || [symbol], verification: 'MEDIA REPORT', retrievalLevel: 'headline+summary' }], 'replay');
    }
    const bar = provider.step();
    clock.set((bar.time + 60) * 1000 + 4500);
    agent.sampleEquity(true);
    for (const ev of agent.candles.checkRollovers(clock.now())) {
      if (ev.tf !== analysisTimeframe) continue;
      const d = await agent.runAnalysis({ reasons: [{ type: 'CANDLE_CLOSE', detail: `${ev.tf} close (replay)` }] });
      if (d && !d.skipped) { decisions.push(d); if (onDecision) onDecision(d, clock.now()); }
    }
  }
  const val = agent.valuation();
  const fills = store.listFills(agent.session.id);
  const equityCurve = store.listEquity(agent.session.id);
  const metrics = computeMetrics({ valuation: val, roundTrips: agent.portfolio.roundTrips, fillCount: agent.portfolio.fillCount, equityCurve });
  const benchmark = agent.benchmark;
  const out = { symbol, fills, decisions: decisions.map((d) => ({ id: d.id, ts: d.ts, action: d.action, status: d.status })), metrics, valuation: val, benchmark, activity: activity.recent(5000), assumptions: provider.feedInfo().note };
  await agent.shutdown();
  store.close();
  return out;
}

module.exports = { runReplay };
