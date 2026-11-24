'use strict';
const { temp } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { CryptoProvider, isCrypto, CRYPTO_EXECUTION } = require('../server/market/crypto');
const { MarketCalendar } = require('../server/market/session');
const { computeFees } = require('../server/trading/execution');
const { RiskManager } = require('../server/trading/risk');
const { DEFAULTS } = require('../server/config');
const { createTerminal } = require('../server/app');
const { DemoProvider } = require('../server/market/demo');

const bar = { t: '2026-11-23T15:00:00Z', o: 1, h: 2, l: 1, c: 2, v: 0.5, vw: 1.5, n: 3 };
function provider(urls = []) {
  return new CryptoProvider({ keyId: 'k', secretKey: 's', cfg: DEFAULTS.market, fetchImpl: async (u, o) => {
    urls.push([o.method, u]);
    const snap = u.includes('BTC') ? { 'BTC/USD': { latestTrade: { p: 90000, t: bar.t }, latestQuote: { bp: 89990, ap: 90010, t: bar.t } } } : {};
    return new Response(JSON.stringify(u.includes('/snapshots') ? { snapshots: snap } : { bars: { 'BTC/USD': [bar] }, next_page_token: null }), { status: 200 });
  } });
}

test('crypto: only spot USD pairs are accepted', () => {
  for (const s of ['BTC/USD', 'ETH/USD']) assert.ok(isCrypto(s));
  for (const s of ['BTC', 'ETH/BTC', 'BTCUSD', 'BTC/USDT', '../USD', 'btc/usd', '', null]) assert.ok(!isCrypto(s), String(s));
});

test('crypto: read-only endpoints, stream address and unknown pairs', async () => {
  const urls = [];
  const p = provider(urls);
  assert.equal(p.streamUrl, 'wss://stream.data.alpaca.markets/v1beta3/crypto/us');
  assert.equal(p.channels.statuses, false);
  assert.equal((await p.fetchBars('BTC/USD', '5m'))[0].close, 2);
  assert.equal((await p.fetchMinuteWindow('BTC/USD', 0)).length, 1);
  assert.equal((await p.fetchAsset('BTC/USD')).fractionable, true);
  await assert.rejects(p.fetchAsset('NOPE/USD'), (e) => e.status === 404);
  assert.deepEqual(await p.fetchSnapshots(['SPY']), {});
  for (const [m, u] of urls) { assert.equal(m, 'GET'); assert.match(u, /^https:\/\/data\.alpaca\.markets\/v1beta3\/crypto\/us\//); }
});

test('crypto: open at the weekend, while the stock calendar is closed', () => {
  const sunday = Date.parse('2026-11-22T15:00:00Z');
  assert.equal(new MarketCalendar({ alwaysOpen: 'CRYPTO' }).info(sunday).session, 'REGULAR');
  assert.equal(new MarketCalendar().info(sunday).session, 'CLOSED');
});

test('crypto: the percentage fee is charged and counted in the risk of a trade', () => {
  assert.equal(computeFees('BUY', 0.1, 90000, CRYPTO_EXECUTION).total, 22.5);
  assert.equal(computeFees('SELL', 0.1, 90000, CRYPTO_EXECUTION).total, 22.5);
  assert.equal(computeFees('BUY', 10, 100, DEFAULTS.execution).total, 0, 'stocks unchanged');
  const c = RiskManager.costModel(CRYPTO_EXECUTION, 88000, 96000, 90000);
  assert.equal(c.entryPerShare, 225);
  assert.equal(c.exitAtStopPerShare, 220);
  const r = new RiskManager(DEFAULTS.risk);
  const now = Date.now();
  const res = r.evaluateEntry({ proposal: { stopLoss: 88000, takeProfit: 99000, orderType: 'MARKET', snapshotPrice: 90000, createdAt: now }, quote: { bid: 89990, ask: 90010, askSize: 1 }, market: { realtime: true, connected: true, session: 'REGULAR', quoteAgeMs: 1 }, account: { equity: 10000, cash: 10000, positionQty: 0, positionMark: 0, openPositions: 0 }, exec: { ...DEFAULTS.execution, ...CRYPTO_EXECUTION }, ai: DEFAULTS.ai, nowMs: now });
  assert.equal(res.approved, true, res.failed.join());
  assert.ok(res.qty > 0 && res.qty < 1);
  assert.ok(res.sizing.riskAtStop <= 50 + 1e-6, 'fees stay inside the risk budget');
});

test('crypto: joins a live watchlist on its own stream, with crypto costs and a closed Sharia gate', async () => {
  const made = [];
  class Stock extends DemoProvider { constructor() { super(); this.mode = 'LIVE'; } connect() {} subscribe(s) { for (const x of s) this.symbols.add(x); } async fetchCalendar() { return []; } }
  class Coin extends EventEmitter {
    constructor() { super(); Object.assign(this, provider()); this.mode = 'LIVE'; this.symbols = new Set(); }
    connect() {} disconnect() {} subscribe(s) { for (const x of s) this.symbols.add(x); } unsubscribe() {}
    async fetchCalendar() { return []; } async fetchNews() { return []; }
  }
  for (const k of ['feedInfo', 'fetchBars', 'fetchMinuteWindow', 'fetchSnapshot', 'fetchSnapshots', 'fetchAsset', 'bars', 'get', 'headers']) Coin.prototype[k] = CryptoProvider.prototype[k];
  const t = createTerminal({ postgres: temp(), port: 0, env: {}, fetchImpl: async () => new Response('{}', { status: 404 }), providerFactory: (mode) => { const p = mode === 'CRYPTO' ? new Coin() : new Stock(); made.push([mode, p]); return p; } });
  // the fake coin provider answers from fixed data, not from the network
  Coin.prototype.get = provider().get;
  await t.start();
  try {
    await t.desk.addSymbol('NVDA');
    await t.desk.addSymbol('BTC/USD');
    const a = t.desk.agent('BTC/USD');
    assert.ok(a, 'in the watchlist');
    const coins = made.filter(([m, p]) => m === 'CRYPTO' && p.symbols.has('BTC/USD'));
    assert.equal(coins.length, 1);
    assert.ok(!made.some(([m, p]) => m !== 'CRYPTO' && p.symbols.has('BTC/USD')), 'never subscribed on the stock stream');
    assert.equal(a.sessionInfo().marketStatus, 'OPEN 24/7');
    assert.equal(a.cfg().execution.commissionPct, 0.25);
    assert.equal(t.desk.agent('NVDA').cfg().execution.commissionPct, undefined);
    assert.equal(t.desk.book.sharia.gate('BTC/USD').pass, false);
    assert.equal((await t.desk.book.sharia.screen('BTC/USD')).status, 'UNKNOWN');
  } finally { await t.stop(); }
});

test('crypto: can be the main symbol, also together with a stock that keeps its own stream and hours', async () => {
  const made = [];
  class Stock extends DemoProvider { constructor() { super(); this.mode = 'LIVE'; } connect() {} subscribe(s) { for (const x of s) this.symbols.add(x); } async fetchCalendar() { return []; } async fetchSnapshots() { return { SPY: { latestTrade: { p: 600, t: new Date().toISOString() } } }; } }
  class Coin extends EventEmitter {
    constructor() { super(); Object.assign(this, provider()); this.mode = 'LIVE'; this.symbols = new Set(); }
    connect() {} disconnect() {} subscribe(s) { for (const x of s) this.symbols.add(x); } unsubscribe() {}
    async fetchCalendar() { return []; } async fetchNews() { return []; }
  }
  for (const k of ['feedInfo', 'fetchBars', 'fetchMinuteWindow', 'fetchSnapshot', 'fetchSnapshots', 'fetchAsset', 'bars', 'get', 'headers']) Coin.prototype[k] = CryptoProvider.prototype[k];
  const t = createTerminal({ postgres: temp(), port: 0, env: {}, fetchImpl: async () => new Response('{}', { status: 404 }), providerFactory: (mode) => { const p = mode === 'CRYPTO' ? new Coin() : new Stock(); made.push([mode, p]); return p; } });
  await t.start();
  try {
    await t.desk.addSymbol('BTC/USD');
    const btc = t.desk.primary;
    assert.equal(btc.symbol, 'BTC/USD');
    assert.equal(t.desk.stockAgent(), null);
    await btc.pollBroadMarket();
    assert.equal(t.desk.book.broadMarket, null);
    assert.equal(t.desk.monitor.symbolMode('BTC/USD'), 'NORMAL_SESSION');
    btc.tick();
    await t.desk.addSymbol('NVDA');
    const nv = t.desk.agent('NVDA');
    assert.equal(t.desk.stockAgent(), nv);
    assert.notEqual(nv.provider, btc.provider);
    assert.notEqual(nv.sessionInfo().marketStatus, 'OPEN 24/7');
    assert.equal(nv.streamLead, true, 'reports its own stream');
    await btc.pollBroadMarket();
    assert.equal(t.desk.book.broadMarket.symbols.SPY.price, 600);
    btc.tick();
    const want = require('../server/market/adaptiveMonitoring').sessionMode(nv.sessionInfo(), Date.now(), t.desk.monitor.cfg()).mode;
    assert.equal(t.desk.monitor.base.mode, want, 'stock phases follow the stock calendar');
    assert.equal(t.desk.monitor.symbolMode('BTC/USD'), 'NORMAL_SESSION');
    assert.equal((await t.desk.bars('BTC/USD', '5m')).symbol, 'BTC/USD');
    assert.equal(t.desk.publicState('BTC/USD').session.marketStatus, 'OPEN 24/7');
  } finally { await t.stop(); }
});
