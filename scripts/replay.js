'use strict';
/**
 * Deterministic historical replay (paper simulation) using REAL Alpaca historical bars and news.
 *
 *   npm run replay -- --symbol NVDA --date 2026-11-18 [--decider rules|deepseek] [--capital 500] [--tf 5m] [--warmup 60]
 *
 * Future candles/news are never visible to earlier decisions. Note: an LLM may carry general world
 * knowledge about past dates from its training — the app prevents data look-ahead, not model memory.
 * A handful of replayed trades says nothing reliable about strategy profitability.
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { Store } = require('../server/db');
const { SecretStore } = require('../server/secrets');
const { ConfigManager } = require('../server/config');
const { AlpacaProvider } = require('../server/market/alpaca');
const { DeepSeekClient } = require('../server/ai/deepseek');
const { DeepSeekDecider, RulesDecider } = require('../server/ai/decider');
const { runReplay } = require('../server/engine/replay');
const { Redactor } = require('../server/util/misc');
const { etWallToUtcMs, addDays } = require('../server/util/time');

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const symbol = String(arg('symbol', 'NVDA')).toUpperCase();
  const date = arg('date');
  const deciderKind = arg('decider', 'rules');
  const capital = Number(arg('capital', 500));
  const tf = arg('tf', '5m');
  const warmup = Number(arg('warmup', 60));
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new Error('Pass --date YYYY-MM-DD (a past trading day)');

  const dataDir = path.join(ROOT, 'data');
  const store = new Store(path.join(dataDir, 'terminal.db'));
  const secrets = new SecretStore({ store, dataDir, env: process.env, redactor: new Redactor() });
  const config = new ConfigManager(store);
  const keyId = secrets.get('ALPACA_KEY_ID');
  const secretKey = secrets.get('ALPACA_SECRET_KEY');
  if (!keyId || !secretKey) throw new Error('Alpaca credentials are required to download historical data (Settings or .env)');
  const m = config.get().market;
  const alp = new AlpacaProvider({ keyId, secretKey, feed: m.feed === 'delayed_sip' ? 'sip' : m.feed, cfg: m, adjustment: m.adjustment });

  const start = etWallToUtcMs(date, 4, 0);
  const end = etWallToUtcMs(date, 20, 0);
  console.log(`Downloading ${symbol} 1-minute bars for ${date} (${alp.feedInfo().label}, ${m.adjustment}-adjusted)…`);
  const minutes = (await alp.fetchMinuteWindow(symbol, start)).filter((b) => b.time * 1000 < end);
  const daily = (await alp.fetchBars(symbol, '1d', { limit: 300, start: addDays(date, -450), end: start })).filter((b) => b.time * 1000 < start);
  let news = [];
  try { news = await alp.fetchNews(symbol, { limit: 50, start: new Date(start - 86400e3).toISOString(), end: new Date(end).toISOString() }); } catch (e) { console.warn(`News unavailable: ${e.message}`); }
  console.log(`Bars: ${minutes.length} minute, ${daily.length} daily; news items: ${news.length}`);

  let decider;
  if (deciderKind === 'deepseek') {
    const key = secrets.get('DEEPSEEK_API_KEY');
    if (!key) throw new Error('DeepSeek key required for --decider deepseek');
    decider = new DeepSeekDecider({ getClient: () => new DeepSeekClient({ apiKey: key, baseUrl: config.get().ai.baseUrl }), getCfg: () => config.get() });
    console.log(`Decision engine: ${decider.label} (daily budget $${config.get().ai.dailyBudgetUsd}; each analysis is a paid API call)`);
  } else {
    decider = new RulesDecider();
    console.log('Decision engine: RULES BASELINE (not AI)');
  }

  const r = await runReplay({ symbol, minuteBars: minutes, dailyBars: daily, news, decider, initialCapital: capital, analysisTimeframe: tf, warmupBars: warmup, secretsEnv: deciderKind === 'deepseek' ? { DEEPSEEK_API_KEY: secrets.get('DEEPSEEK_API_KEY') } : {} });
  const mt = r.metrics;
  const bh = r.benchmark && minutes.length ? r.benchmark.cashLeft + r.benchmark.shares * minutes[minutes.length - 1].close : null;
  console.log('\n=== REPLAY RESULT (paper simulation) ===');
  console.log(`Decisions: ${r.decisions.length}  Executions: ${mt.executions}  Closed trades: ${mt.closedTrades}  Win rate: ${mt.winRatePct == null ? 'n/a' : mt.winRatePct.toFixed(1) + '%'}`);
  console.log(`Equity: $${mt.currentEquity.toFixed(2)} (${mt.totalReturnPct >= 0 ? '+' : ''}${mt.totalReturnPct.toFixed(2)}%)  Fees: $${mt.tradingFees.toFixed(2)}  Max DD: ${mt.maxDrawdownPct.toFixed(2)}%`);
  if (bh != null) console.log(`Buy & hold (same capital): $${bh.toFixed(2)}`);
  console.log(`Assumptions: ${r.assumptions}`);
  if (mt.sampleWarning) console.log(`WARNING: ${mt.sampleWarning}`);
  const outDir = path.join(dataDir, 'replays');
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${symbol}-${date}-${deciderKind}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(r, null, 2));
  console.log(`Report: ${file}`);
  store.close();
}

main().catch((e) => { console.error(`Replay failed: ${e.message}`); process.exit(1); });
