'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocketServer } = require('ws');
const { AlpacaProvider } = require('../server/market/alpaca');
const { MarketState } = require('../server/market/marketState');
const { CandleStore } = require('../server/market/candles');
const { MarketCalendar } = require('../server/market/session');
const { assertReadOnlyBrokerRequest } = require('../server/util/http');
const { DEFAULTS } = require('../server/config');
const { etWallToUtcMs } = require('../server/util/time');

const waitFor = async (fn, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 15)); }
  throw new Error('timeout waiting for condition');
};

/** Minimal Alpaca-protocol mock stream. */
function mockAlpaca({ failAuth = false } = {}) {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const st = { connections: 0, subs: [], sockets: [] };
    wss.on('connection', (ws) => {
      st.connections++;
      st.sockets.push(ws);
      ws.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
      ws.on('message', (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.action === 'auth') {
          if (failAuth || m.key !== 'KEY') ws.send(JSON.stringify([{ T: 'error', code: 402, msg: 'auth failed' }]));
          else ws.send(JSON.stringify([{ T: 'success', msg: 'authenticated' }]));
        } else if (m.action === 'subscribe') {
          st.subs.push(m);
          ws.send(JSON.stringify([{ T: 'subscription', trades: m.trades, quotes: m.quotes, bars: m.bars, statuses: m.statuses || [] }]));
          ws.send(JSON.stringify([
            { T: 't', S: 'ANT', i: 1, x: 'V', p: 101.25, s: 100, c: ['@'], t: '2026-11-19T15:00:01.123456789Z', z: 'C' },
            { T: 'q', S: 'ANT', bx: 'V', bp: 101.2, bs: 300, ax: 'V', ap: 101.3, as: 200, c: ['R'], t: '2026-11-19T15:00:01.2Z', z: 'C' },
            { T: 'b', S: 'ANT', o: 101, h: 101.5, l: 100.9, c: 101.25, v: 5000, vw: 101.2, n: 40, t: '2026-11-19T15:00:00Z' },
            { T: 's', S: 'ANT', sc: 'H', sm: 'Trading Halt', rc: 'T12', rm: 'Halted', t: '2026-11-19T15:00:02Z', z: 'C' },
          ]));
        }
      });
    });
    wss.on('listening', () => resolve({ wss, st, url: `ws://127.0.0.1:${wss.address().port}` }));
  });
}

test('Alpaca stream: auth, subscribe, message parsing, halt status', async (t) => {
  const { wss, st, url } = await mockAlpaca();
  const p = new AlpacaProvider({ keyId: 'KEY', secretKey: 'SECRET', feed: 'iex', cfg: { ...DEFAULTS.market, streamBaseUrl: url, reconnectBaseMs: 30 } });
  t.after(() => { p.disconnect(); wss.close(); });
  const got = { trades: [], quotes: [], bars: [], statuses: [], states: [] };
  p.on('trade', (t) => got.trades.push(t)); p.on('quote', (q) => got.quotes.push(q)); p.on('bar', (b) => got.bars.push(b));
  p.on('status', (s) => got.statuses.push(s)); p.on('connection', (c) => got.states.push(c.state)); p.on('error', () => {});
  p.subscribe(['ANT']);
  p.connect();
  await waitFor(() => got.statuses.length === 1);
  assert.deepEqual(st.subs[0].trades, ['ANT']);
  assert.ok(st.subs[0].updatedBars && st.subs[0].dailyBars && st.subs[0].statuses);
  assert.equal(got.trades[0].price, 101.25);
  assert.equal(got.trades[0].ts, Date.parse('2026-11-19T15:00:01.123Z'));
  assert.equal(got.quotes[0].bid, 101.2); assert.equal(got.quotes[0].askSize, 200);
  assert.equal(got.bars[0].time, Date.parse('2026-11-19T15:00:00Z') / 1000);
  assert.equal(got.statuses[0].code, 'H');
  // connection phases are reported separately, in order; SUBSCRIBED only after the server confirmed ANT
  const order = ['CONNECTING', 'AUTHENTICATING', 'AUTHENTICATED', 'SUBSCRIBED'].map((x) => got.states.indexOf(x));
  assert.ok(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1])), got.states.join(' > '));
  assert.equal(p.feedInfo().label, 'LIVE — ALPACA IEX');
});

test('Alpaca stream: automatic reconnection and re-subscription after disconnect', async (t) => {
  const { wss, st, url } = await mockAlpaca();
  const p = new AlpacaProvider({ keyId: 'KEY', secretKey: 'SECRET', feed: 'iex', cfg: { ...DEFAULTS.market, streamBaseUrl: url, reconnectBaseMs: 30 } });
  t.after(() => { p.disconnect(); wss.close(); });
  const states = [];
  p.on('connection', (c) => states.push(c.state)); p.on('error', () => {}); p.on('info', () => {});
  p.subscribe(['ANT']);
  p.connect();
  await waitFor(() => st.subs.length === 1);
  st.sockets[0].terminate(); // simulate network drop
  await waitFor(() => st.subs.length === 2);
  assert.equal(st.connections, 2);
  assert.ok(states.includes('DISCONNECTED') || states.includes('RECONNECTING'));
  assert.equal(states[states.length - 1], 'SUBSCRIBED');
});

test('Alpaca stream: auth failure is fatal (no reconnect storm)', async (t) => {
  const { wss, st, url } = await mockAlpaca({ failAuth: true });
  const p = new AlpacaProvider({ keyId: 'BAD', secretKey: 'X', feed: 'iex', cfg: { ...DEFAULTS.market, streamBaseUrl: url, reconnectBaseMs: 20 } });
  t.after(() => { p.disconnect(); wss.close(); });
  const errors = [];
  const states = [];
  p.on('error', (e) => errors.push(e)); p.on('connection', (c) => states.push(c));
  p.connect();
  await waitFor(() => states.some((s) => s.state === 'ERROR'));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(st.connections, 1);
  assert.match(errors[0].message, /402/);
  p.disconnect();
  wss.close();
});

test('Paper-only guard: no non-GET or order endpoints to any Alpaca host', () => {
  assert.throws(() => assertReadOnlyBrokerRequest('https://paper-api.alpaca.markets/v2/orders', 'POST'), /paper-trading only/);
  assert.throws(() => assertReadOnlyBrokerRequest('https://api.alpaca.markets/v2/orders', 'GET'), /paper-trading only/);
  assert.throws(() => assertReadOnlyBrokerRequest('https://api.alpaca.markets/v2/positions/ANT', 'DELETE'));
  assert.doesNotThrow(() => assertReadOnlyBrokerRequest('https://data.alpaca.markets/v2/stocks/ANT/bars', 'GET'));
  assert.doesNotThrow(() => assertReadOnlyBrokerRequest('https://api.deepseek.com/chat/completions', 'POST'));
});

test('Data freshness: disconnected, missing, stale, snapshot-only, invalid, delayed and lagging data are flagged', () => {
  const now = 1_800_000_000_000;
  const ms = new MarketState({ symbol: 'ANT', cfg: { maxQuoteAgeMs: 15000, maxExchangeLagMs: 60000 } });
  ms.setFeed({ realtime: true, label: 'LIVE — ALPACA IEX', feed: 'iex' });
  assert.ok(ms.freshness(now).codes.includes('STREAM_NOT_READY'));
  ms.setConnection('SUBSCRIBED', 'ok', now);
  assert.ok(ms.freshness(now).codes.includes('NO_QUOTE'));
  // a quote from the REST snapshot is displayed but never executable
  ms.onQuote({ bid: 10, ask: 10.02, ts: now - 100, receivedAt: now, source: 'snapshot' });
  assert.deepEqual(ms.freshness(now).codes, ['QUOTE_NOT_STREAMED']);
  ms.onQuote({ bid: 10, ask: 10.02, ts: now - 100, receivedAt: now });
  assert.equal(ms.freshness(now + 1000).stale, false);
  // age is measured from the EXCHANGE timestamp, not from receipt; an open socket does not refresh it
  const f = ms.freshness(now + 20000);
  assert.deepEqual(f.codes, ['QUOTE_STALE']);
  assert.match(f.reasons[0], /by exchange timestamp/);
  assert.equal(f.quoteAgeMs, 20100);
  ms.onQuote({ bid: 10, ask: 10.02, ts: now - 120000, receivedAt: now });
  assert.ok(ms.freshness(now).codes.includes('DATA_LAGGING'));
  assert.ok(ms.freshness(now).codes.includes('QUOTE_STALE'), 'a 2-minute-old quote is stale even if just received');
  ms.onQuote({ bid: 10.05, ask: 10.01, ts: now, receivedAt: now });
  ms.lastExchangeLagMs = 0;
  assert.deepEqual(ms.freshness(now).codes, ['INVALID_QUOTE']);
  ms.setFeed({ realtime: false, label: 'DELAYED — 15 MINUTES (ALPACA SIP)' });
  assert.ok(ms.freshness(now).codes.includes('FEED_DELAYED'));
  ms.setConnection('RECONNECTING', 'retry', now);
  assert.equal(ms.feedStatus(now), 'RECONNECTING');
});

test('Halt / resume status handling', () => {
  const ms = new MarketState({ symbol: 'ANT', cfg: { maxQuoteAgeMs: 15000, maxExchangeLagMs: 60000 } });
  ms.onStatus({ code: 'H', message: 'Trading Halt', reasonMessage: 'News pending' });
  assert.equal(ms.halted, true);
  ms.onStatus({ code: 'T', message: 'Resume' });
  assert.equal(ms.halted, false);
  ms.onStatus({ code: '2' });
  assert.equal(ms.halted, true);
});

test('Candles: forming minute from real prints, replaced by official bar, no invented bars', () => {
  const cs = new CandleStore({ symbol: 'ANT' });
  const m0 = etWallToUtcMs('2026-11-18', 10, 0) / 1000;
  cs.setMinutes([{ time: m0 - 60, open: 10, high: 10.2, low: 9.9, close: 10.1, volume: 100 }], m0 - 3600, m0 * 1000);
  cs.onTrade({ price: 10.3, size: 5, ts: m0 * 1000 + 1000 });
  cs.onTrade({ price: 10.5, size: 5, ts: m0 * 1000 + 2000 });
  cs.onTrade({ price: 10.2, size: 5, ts: m0 * 1000 + 3000 });
  let bars = cs.getBars('1m');
  assert.deepEqual(bars.map((b) => b.time), [m0 - 60, m0]);
  const f = bars[1];
  assert.equal(f.open, 10.3); assert.equal(f.high, 10.5); assert.equal(f.low, 10.2); assert.equal(f.close, 10.2); assert.equal(f.volume, 15);
  cs.onMinuteBar({ time: m0, open: 10.3, high: 10.6, low: 10.2, close: 10.25, volume: 40 });
  bars = cs.getBars('1m');
  assert.equal(bars[1].high, 10.6, 'official bar replaces provisional');
  assert.equal(bars[1].volume, 40);
  cs.onTrade({ price: 11, size: 1, ts: m0 * 1000 + 5000 }); // late print for a finalized minute is ignored
  assert.equal(cs.getBars('1m')[1].high, 10.6);
  // gap minute with no trades -> no bar is created
  cs.onTrade({ price: 10.4, size: 1, ts: (m0 + 180) * 1000 });
  assert.deepEqual(cs.getBars('1m').map((b) => b.time), [m0 - 60, m0, m0 + 180]);
  // 5m aggregation from minutes
  const five = cs.getBars('5m');
  const b5 = five.find((b) => b.time === m0);
  assert.equal(b5.open, 10.3); assert.equal(b5.high, 10.6); assert.equal(b5.close, 10.4); assert.equal(b5.volume, 41);
});

test('Candles: bucket rollovers emit one close per bucket', () => {
  const cs = new CandleStore({ symbol: 'ANT', graceMs: 0 });
  cs.track('5m');
  const m0 = etWallToUtcMs('2026-11-18', 10, 0) / 1000;
  cs.setMinutes([], m0 - 3600, m0 * 1000 + 1000);
  cs.onMinuteBar({ time: m0, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  assert.deepEqual(cs.checkRollovers((m0 + 30) * 1000), []);
  const closed = cs.checkRollovers((m0 + 61) * 1000);
  assert.deepEqual(closed.map((c) => c.tf), ['1m']);
  assert.equal(closed[0].bar.time, m0);
  assert.equal(cs.checkRollovers((m0 + 62) * 1000).length, 0, 'not emitted twice');
  const c5 = cs.checkRollovers((m0 + 301) * 1000);
  assert.ok(c5.some((c) => c.tf === '5m' && c.bucket === m0));
});

test('Session identification: pre / regular / post / closed / weekend / early close', async () => {
  const cal = new MarketCalendar();
  assert.equal(cal.info(etWallToUtcMs('2026-11-18', 8, 0)).session, 'PRE');
  assert.equal(cal.info(etWallToUtcMs('2026-11-18', 9, 30)).session, 'REGULAR');
  assert.equal(cal.info(etWallToUtcMs('2026-11-18', 16, 0)).session, 'POST');
  assert.equal(cal.info(etWallToUtcMs('2026-11-18', 21, 0)).session, 'CLOSED');
  assert.equal(cal.info(etWallToUtcMs('2026-11-21', 12, 0)).session, 'CLOSED'); // Saturday
  assert.equal(cal.info(etWallToUtcMs('2026-11-18', 12, 0)).estimated, true);
  const cal2 = new MarketCalendar({ fetchCalendar: async () => [{ date: '2026-11-27', open: '09:30', close: '13:00', session_open: '0400', session_close: '1700' }] });
  await cal2.load(etWallToUtcMs('2026-11-27', 10, 0));
  assert.equal(cal2.info(etWallToUtcMs('2026-11-27', 13, 30)).session, 'POST', 'early close respected');
  assert.equal(cal2.info(etWallToUtcMs('2026-11-26', 12, 0)).session, 'CLOSED', 'holiday (not in calendar)');
  // DST edge: 9:30 ET in summer is 13:30 UTC
  assert.equal(new Date(etWallToUtcMs('2026-07-01', 9, 30)).toISOString(), '2026-07-01T13:30:00.000Z');
  assert.equal(new Date(etWallToUtcMs('2026-11-18', 9, 30)).toISOString(), '2026-11-18T14:30:00.000Z');
});
