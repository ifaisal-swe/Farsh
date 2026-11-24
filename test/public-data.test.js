'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PublicStockProvider, PublicCryptoProvider, calendarRows, holidays, nasdaqTime, yahooBars } = require('../server/market/public');

const ok = (data, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(data) });
const T = Date.UTC(2026, 10, 23, 15, 0, 30);
const chart = (o = {}) => ({ chart: { result: [{ meta: { dataGranularity: '1m', instrumentType: 'EQUITY', currency: 'USD', longName: 'NVIDIA', ...o.meta }, timestamp: o.ts || [T / 1000 - 150, T / 1000 - 90, T / 1000 - 30, T / 1000], indicators: { quote: [{ open: [1, 2, null, 3], high: [2, 3, null, 4], low: [1, 1, null, 3], close: [2, 2.5, null, 3.5], volume: [10, 20, null, 5] }] } }] } });
const info = (o = {}) => ({ data: { primaryData: { lastSalePrice: '$1,165.05', bidPrice: '$1,165.00', askPrice: '$1,165.10', bidSize: '3', askSize: '4', isRealTime: true, lastTradeTimestamp: 'Nov 23, 2026 10:00 AM ET', ...o } } });

test('public data: the exchange calendar knows holidays and early closes', () => {
  assert.deepEqual([...holidays(2026)].sort(), ['2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25']);
  assert.ok(!holidays(2022).has('2021-12-31'), 'a Saturday New Year is not moved');
  const rows = calendarRows('2026-11-23', '2026-11-30');
  assert.deepEqual(rows.map((r) => r.date), ['2026-11-23', '2026-11-24', '2026-11-25', '2026-11-27', '2026-11-30']);
  assert.equal(rows[3].close, '13:00');
});

test('public data: times and candles are read exactly; empty minutes stay empty', () => {
  assert.equal(nasdaqTime('Nov 23, 2026 4:49 PM ET'), Date.UTC(2026, 10, 23, 21, 49));
  assert.equal(nasdaqTime('Nov 23, 2026 12:05 AM ET'), Date.UTC(2026, 10, 23, 5, 5));
  assert.equal(nasdaqTime('soon'), null);
  const b = yahooBars(chart().chart.result[0]);
  assert.equal(b.length, 3);
  assert.ok(b.every((x) => x.time % 60 === 0 && x.close > 0));
});

test('public data: one reading gives a quote, a trade and no invented values', async () => {
  let reply = info();
  const p = new PublicStockProvider({ now: () => T, fetchImpl: async (u) => ok(/nasdaq/.test(u) ? reply : chart()) });
  const got = [];
  for (const k of ['quote', 'trade', 'bar']) p.on(k, (x) => got.push([k, x]));
  await p.poll('NVDA');
  assert.deepEqual(got.filter(([k]) => k === 'quote').map(([, x]) => [x.bid, x.ask]), [[1165, 1165.1]]);
  assert.equal(got.find(([k]) => k === 'trade')[1].price, 1165.05);
  got.length = 0;
  await p.poll('NVDA');
  assert.equal(got.filter(([k]) => k === 'trade').length, 0, 'the same print is not repeated');
  reply = info({ isRealTime: false, bidPrice: '', askPrice: '' });
  got.length = 0;
  await p.poll('NVDA');
  assert.equal(got.filter(([k]) => k === 'quote').length, 0, 'no quote when the source has none');
});

test('public data: a refusal stops the readings and is never worked around', async () => {
  let n = 0;
  const p = new PublicStockProvider({ pollMs: 1, fetchImpl: async () => { n++; return ok({ message: 'slow down' }, 429); } });
  const states = [];
  p.on('connection', (c) => states.push(c.state));
  p.on('error', () => {});
  p.subscribe(['NVDA']);
  p.connect();
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(n, 1);
  assert.equal(p.state, 'RECONNECTING');
  assert.ok(!states.includes('SUBSCRIBED'));
  p.disconnect();
});

test('public data: unknown symbols and funds', async () => {
  const p = new PublicStockProvider({ fetchImpl: async (u) => ok(/nasdaq/.test(u) ? (/assetclass=etf/.test(u) ? info() : { data: null }) : { chart: { result: null } }) });
  await assert.rejects(p.fetchAsset('ZZZZ'), (e) => e.status === 404);
  assert.equal((await p.quote('SPY')).price, 1165.05);
});

test('public data: crypto ticker gives quotes, trades and minute bars for its own symbols only', () => {
  const p = new PublicCryptoProvider({});
  p.symbols.add('BTC/USD');
  const got = [];
  for (const k of ['quote', 'trade', 'bar']) p.on(k, (x) => got.push([k, x]));
  const tick = (id, price, sec) => p.onMessage({ type: 'ticker', product_id: id, price: String(price), best_bid: String(price - 1), best_ask: String(price + 1), last_size: '0.5', time: new Date(T + sec * 1000).toISOString() }, T);
  tick('BTC-USD', 61000, 0); tick('BTC-USD', 61010, 5); tick('ETH-USD', 3000, 6); tick('BTC-USD', 61005, 40);
  const bars = got.filter(([k]) => k === 'bar').map(([, b]) => b);
  assert.equal(bars.length, 1);
  assert.deepEqual([bars[0].open, bars[0].high, bars[0].close, bars[0].volume], [61000, 61010, 61010, 1]);
  assert.ok(got.every(([, x]) => x.symbol === 'BTC/USD'));
});
