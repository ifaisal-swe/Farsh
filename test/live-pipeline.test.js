'use strict';
/**
 * End-to-end LIVE code path against local mock Alpaca REST + WebSocket servers:
 * real AlpacaProvider -> candles/market state -> snapshot -> (scripted) AI -> risk -> paper fill.
 * Also covers a newly listed stock (IPO) with almost no history.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { WebSocketServer } = require('ws');
const { Store } = require('../server/db');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { TradingAgent } = require('../server/engine/agent');
const { Redactor } = require('../server/util/misc');
const { etDateStr } = require('../server/util/time');
const { ScriptedDecider, buyProposal } = require('./helpers/fixtures');

const iso = (ms) => new Date(ms).toISOString();

function startMocks({ dailyCount }) {
  const now = Date.now();
  const curMin = Math.floor(now / 60000) * 60000;
  const minutes = [];
  let px = 90;
  for (let t = curMin - 150 * 60000; t < curMin; t += 60000) {
    const o = px; const c = px + 0.01;
    minutes.push({ t: iso(t), o, h: c + 0.03, l: o - 0.03, c, v: 1500, n: 30, vw: (o + c) / 2 });
    px = c;
  }
  const daily = [];
  for (let i = dailyCount; i >= 1; i--) daily.push({ t: iso(curMin - i * 86400e3), o: 85, h: 92, l: 83, c: 88, v: 2e6, n: 1e4, vw: 88 });
  const seen = { headers: [], paths: [] };
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.paths.push(u.pathname + '?' + u.searchParams.toString());
    seen.headers.push(req.headers['apca-api-key-id']);
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method !== 'GET') return json(405, { message: 'mock only allows GET' });
    if (u.pathname === '/v2/assets/ANT') return json(200, { symbol: 'ANT', name: 'Anthropic PBC Class A Common Stock', exchange: 'NASDAQ', status: 'active', tradable: true, fractionable: true });
    if (u.pathname === '/v2/assets/NOPE') return json(404, { message: 'asset not found' });
    if (u.pathname === '/v2/calendar') return json(200, [{ date: etDateStr(now), open: '00:00', close: '23:59', session_open: '0000', session_close: '2359' }]);
    if (u.pathname === '/v2/stocks/ANT/snapshot') return json(200, { symbol: 'ANT', latestTrade: { p: px, s: 10, t: iso(now - 1000), x: 'V' }, latestQuote: { bp: px - 0.01, ap: px + 0.01, bs: 300, as: 300, t: iso(now - 1000) } });
    if (u.pathname === '/v2/stocks/snapshots') return json(200, {});
    if (u.pathname === '/v2/stocks/ANT/bars') {
      const tf = u.searchParams.get('timeframe');
      assert.equal(u.searchParams.get('feed'), 'iex');
      assert.equal(u.searchParams.get('adjustment'), 'split');
      if (tf === '1Day') return json(200, { bars: u.searchParams.get('sort') === 'desc' ? [...daily].reverse() : daily, symbol: 'ANT', next_page_token: null });
      const list = u.searchParams.get('sort') === 'desc' ? [...minutes].reverse() : minutes;
      if (tf === '1Min') return json(200, { bars: list, symbol: 'ANT', next_page_token: null });
      return json(200, { bars: [], symbol: 'ANT', next_page_token: null }); // higher TFs aggregated from minutes in the live window
    }
    if (u.pathname === '/v1beta1/news') return json(200, { news: [{ id: 1, headline: 'Anthropic shares debut on Nasdaq', summary: 'IPO priced at $83', author: 'x', created_at: iso(now - 600000), updated_at: iso(now - 600000), url: 'https://example.com/ant-ipo', symbols: ['ANT'], source: 'benzinga' }] });
    return json(404, { message: 'not found' });
  });
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const sockets = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.send(JSON.stringify([{ T: 'success', msg: 'connected' }]));
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      if (m.action === 'auth') ws.send(JSON.stringify([{ T: 'success', msg: m.key === 'PKTEST' && m.secret === 'SECRETTEST' ? 'authenticated' : 'x' }]));
      if (m.action === 'subscribe') ws.send(JSON.stringify([{ T: 'subscription', trades: m.trades, quotes: m.quotes, bars: m.bars }]));
    });
  });
  const push = (msgs) => sockets.forEach((s) => s.send(JSON.stringify(msgs)));
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, wss, push, seen, px: () => px, http: `http://127.0.0.1:${srv.address().port}`, ws: `ws://127.0.0.1:${wss.address().port}` })));
}

const waitFor = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error('timeout'); };

async function makeLiveAgent(mocks, overrides = {}) {
  const store = new Store(':memory:');
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { ALPACA_KEY_ID: 'PKTEST', ALPACA_SECRET_KEY: 'SECRETTEST', DEEPSEEK_API_KEY: 'sk-test-0000000000', TERMINAL_MASTER_KEY: 'b'.repeat(64) }, redactor });
  // Keep the mock network endpoints when individual tests override market settings.
  // A top-level spread of overrides.market would silently replace these endpoints.
  const { market: marketOverrides = {}, ...otherOverrides } = overrides;
  const config = new ConfigManager(store, {
    market: { dataBaseUrl: mocks.http, tradingInfoBaseUrl: mocks.http, streamBaseUrl: mocks.ws, ...marketOverrides },
    ...otherOverrides,
  });
  let agent;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (agent && agent.session ? agent.session.id : null) });
  const decider = new ScriptedDecider();
  agent = new TradingAgent({ store, config, secrets, activity, autoTimers: false, deciderOverride: decider });
  agent.news.start = () => {};
  agent.scheduler.run = async () => ({ skipped: true });
  return { agent, decider, activity, store };
}

test('LIVE pipeline over the real Alpaca connector (mocked network): data -> AI -> risk -> paper fill', async (t) => {
  const mocks = await startMocks({ dailyCount: 260 });
  // The mock calendar declares 00:00–23:59 as one artificial REGULAR trading session.
  // Disable the *real* overnight window for this test so it stays deterministic
  // when run at night (20:00–04:00 ET), without relaxing production risk checks.
  const { agent, decider, activity, store } = await makeLiveAgent(mocks, {
    risk: { ipoMode: { enabled: 'off' } },
    market: { overnight: { enabled: false } },
  });
  t.after(async () => { await agent.shutdown(); mocks.srv.close(); mocks.wss.close(); });
  const v = await agent.verifySymbol('ANT');
  assert.equal(v.ok, true, v.error); assert.equal(v.name, 'Anthropic PBC Class A Common Stock'); assert.equal(v.feed.label, 'LIVE — ALPACA IEX');
  const bad = await agent.verifySymbol('NOPE');
  assert.equal(bad.ok, false); assert.match(bad.error, /not found/);
  await agent.startTrading({ symbol: 'ANT', initialCapital: 500, targetCapital: 1000 });
  await waitFor(() => agent.market.connection.state === 'SUBSCRIBED');
  assert.ok(mocks.seen.headers.every((h) => h === 'PKTEST'), 'read-only REST calls carry the key header');
  const now = Date.now();
  const px = mocks.px();
  mocks.push([{ T: 'q', S: 'ANT', bp: px - 0.01, ap: px + 0.01, bs: 400, as: 400, t: iso(now) }, { T: 't', S: 'ANT', p: px, s: 50, t: iso(now), x: 'V', c: ['@'] }]);
  await waitFor(() => agent.market.lastQuote && agent.market.lastQuote.receivedAt >= now);
  assert.equal(agent.market.freshness(Date.now()).stale, false, agent.market.freshness(Date.now()).reasons.join());
  assert.equal(agent.market.feedStatus(), 'LIVE');
  decider.push((s) => buyProposal(s, { stopOff: 0.6, tpOff: 1.8 }));
  const d = await agent.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(d.status, 'EXECUTED', JSON.stringify(d.risk && d.risk.checks.filter((c) => !c.pass)));
  const pos = agent.portfolio.position('ANT');
  assert.equal(pos.qty, 1, '$500 * 25% allocation affords one ~$91 share');
  const fill = store.listFills(agent.session.id)[0];
  assert.equal(fill.dataSource, 'LIVE — ALPACA IEX');
  const snap = decider.seen[0];
  assert.equal(snap.dataSource.label, 'LIVE — ALPACA IEX');
  assert.equal(snap.dataSource.adjustment, 'split');
  // chart data endpoint uses the same candles
  const chart = agent.chartData('1m');
  assert.ok(chart.bars.length >= 150);
  assert.equal(chart.markers.length, 1);
  const msgs = activity.recent(300).map((e) => e.message);
  assert.ok(msgs.some((m) => /Subscribed to ANT: trades✓ quotes✓ bars✓/.test(m)), 'subscription confirmed per channel');
  assert.ok(msgs.some((m) => /Live data verified for ANT: first (quote|trade)/.test(m)), 'first live message verified');
  // stream drop -> trading blocked
  mocks.wss.clients.forEach((c) => c.terminate());
  await waitFor(() => agent.market.connection.state !== 'SUBSCRIBED');
  decider.push((s) => buyProposal(s));
  const blocked = await agent.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.ok(blocked === null || blocked.status === 'REJECTED_BY_RISK' || blocked.status === 'DUPLICATE');
});

test('Newly listed stock (IPO): no fabricated long-term indicators; IPO mode activates', async (t) => {
  const mocks = await startMocks({ dailyCount: 0 });
  const { agent, decider } = await makeLiveAgent(mocks);
  t.after(async () => { await agent.shutdown(); mocks.srv.close(); mocks.wss.close(); });
  await agent.startTrading({ symbol: 'ANT', initialCapital: 500, targetCapital: 1000 });
  await waitFor(() => agent.market.connection.state === 'SUBSCRIBED');
  assert.equal(agent.ipo.isNewlyListed, true);
  assert.equal(agent.ipo.active, true);
  assert.equal(agent.ipo.reference.offerPrice, 83, 'IPO offer price is kept as a labelled reference');
  const now = Date.now();
  const px = mocks.px();
  mocks.push([{ T: 'q', S: 'ANT', bp: px - 0.01, ap: px + 0.01, bs: 400, as: 400, t: iso(now) }]);
  await waitFor(() => agent.market.lastQuote && agent.market.lastQuote.receivedAt >= now);
  decider.push((s) => ({ snapshot_id: s.id, action: 'WAIT', confidence: 30, rationale: 'IPO volatility' }));
  await agent.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  const snap = decider.seen[0];
  assert.equal(snap.timeframes['1d'].completedBars, 0);
  assert.equal(snap.timeframes['1d'].indicators.sma200.available, false);
  assert.equal(snap.timeframes['1d'].indicators.sma200.value, null);
  assert.equal(snap.listing.isNewlyListed, true);
  assert.notEqual(snap.market.lastPrice, 83, 'live price comes from the feed, not the IPO price');
  assert.match(snap.listing.reference.note, /NOT the market price/);
});
