'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/db');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { Desk } = require('../server/engine/desk');
const { Redactor } = require('../server/util/misc');
const { AnalysisScheduler } = require('../server/ai/scheduler');
const A = require('../server/plan/allocator');
const { PlanService } = require('../server/plan/service');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

const origStart = AnalysisScheduler.prototype.start;
test.before(() => { AnalysisScheduler.prototype.start = function () { this.running = false; }; });
test.after(() => { AnalysisScheduler.prototype.start = origStart; });

const mix = (o = {}) => A.validate({ targets: { stocks: 30, crypto: 50, gold: 20 }, symbols: { stocks: ['NVDA', 'AAPL'], crypto: ['BTC/USD'], gold: ['PAXG/USD'] }, smart: false, pace: 1, ...o });
const st = (o = {}) => ({ equity: 10000, cash: 10000, value: {}, managed: [], built: {}, bought: {}, ...o });

test('plan: validation', () => {
  assert.throws(() => mix({ targets: { stocks: 60, crypto: 50 } }), /more than 100/);
  assert.throws(() => mix({ targets: { stocks: -1, crypto: 50 } }), /between/);
  assert.throws(() => mix({ targets: { stocks: NaN } }), /at least one/);
  assert.throws(() => mix({ symbols: { stocks: ['NVDA'], crypto: ['NVDA'], gold: ['PAXG/USD'] } }), /Invalid symbol/);
  assert.throws(() => mix({ symbols: { stocks: ['NVDA'], crypto: ['PAXG/USD'], gold: ['PAXG/USD'] } }), /Invalid symbol/);
  assert.throws(() => mix({ symbols: { stocks: ['NVDA'], gold: ['PAXG/USD'] } }), /Choose/);
});

test('plan: first purchases follow the percentages and never exceed cash', () => {
  const o = A.orders(mix(), {}, st());
  const by = (f) => o.filter((x) => f.includes(x.symbol)).reduce((a, x) => a + x.value, 0);
  assert.ok(Math.abs(by(['BTC/USD']) - 5000) < 1 && Math.abs(by(['PAXG/USD']) - 2000) < 160 && Math.abs(by(['NVDA', 'AAPL']) - 3000) < 160, JSON.stringify(o));
  assert.ok(o.reduce((a, x) => a + x.value, 0) <= 9850 + 1e-6);
  assert.ok(A.orders(mix({ pace: 5 }), {}, st()).every((x) => x.symbol !== 'BTC/USD' || Math.abs(x.value - 1000) < 1));
  assert.deepEqual(A.orders(mix({ pace: 5 }), {}, st({ bought: { stocks: 600, crypto: 1000, gold: 400 } })), [], 'today\'s part is used');
  const poor = A.orders(mix(), {}, st({ cash: 100 }));
  assert.ok(poor.reduce((a, x) => a + x.value, 0) <= 98.5);
});

test('plan: rebalances outside the band only, and sells nothing it did not buy', () => {
  const built = { stocks: true, crypto: true, gold: true };
  const near = st({ cash: 0, value: { NVDA: 1500, AAPL: 1600, 'BTC/USD': 5200, 'PAXG/USD': 1700 }, built, managed: ['NVDA', 'AAPL', 'BTC/USD', 'PAXG/USD'] });
  assert.deepEqual(A.orders(mix(), {}, near), []);
  const far = { ...near, value: { NVDA: 1200, AAPL: 1200, 'BTC/USD': 6000, 'PAXG/USD': 1600 } };
  const o = A.orders(mix(), {}, far);
  assert.equal(o.length, 1); assert.equal(o[0].side, 'SELL'); assert.equal(o[0].symbol, 'BTC/USD'); assert.ok(Math.abs(o[0].value - 1000) < 1);
  assert.deepEqual(A.orders(mix(), {}, { ...far, managed: [] }), []);
  const gone = A.orders(mix(), {}, st({ value: { OLD: 900 }, managed: ['OLD'], cash: 0 }));
  assert.equal(gone[0].all, true);
});

test('plan: analysis changes how much is bought', () => {
  const p = mix({ smart: true });
  const w = A.weights(p, { NVDA: { verdict: 'AVOID' }, AAPL: { verdict: 'SUPPORT' }, 'BTC/USD': { verdict: 'UNKNOWN' } });
  assert.equal(w.NVDA.target, 0); assert.equal(w.AAPL.target, w.AAPL.full); assert.ok(Math.abs(w['BTC/USD'].target - 0.375) < 1e-9);
  assert.ok(!A.orders(p, { NVDA: { verdict: 'AVOID' } }, st()).some((x) => x.symbol === 'NVDA'));
});

class MultiFake extends FakeProvider {
  connect() { this.state = 'SUBSCRIBED'; this.emit('connection', { state: 'SUBSCRIBED', detail: 'test feed' }); }
  async fetchAsset(symbol) { return { symbol, name: `${symbol} Inc`, exchange: 'NASDAQ', status: 'active', tradable: true, fractionable: true }; }
  px(symbol, p) { const t = this.clock.now(); this.emit('quote', { symbol, bid: p - 0.02, ask: p + 0.02, bidSize: 5000, askSize: 5000, ts: t, receivedAt: t }); this.emit('trade', { symbol, price: p, size: 100, ts: t, receivedAt: t }); }
}
async function make() {
  const store = new Store(':memory:');
  const clock = { t: T0, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  let desk;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (desk && desk.book.session ? desk.book.session.id : null) });
  const provider = new MultiFake({ clock });
  const decider = new ScriptedDecider();
  desk = new Desk({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  const sharia = { status: {}, gate(s) { return { pass: this.status[s] !== 'NO', detail: '' }; }, effective() { return { status: 'PASS' }; } };
  desk.book.sharia = sharia;
  desk.primary.news.start = () => {};
  const spawn = desk.spawn.bind(desk);
  desk.spawn = async (s, o) => { const a = await spawn(s, o); a.news.start = () => {}; a.news.stop(); return a; };
  const plan = new PlanService({ store, desk, lab: null, activity, getConfig: () => config.get(), now: () => clock.now() });
  await desk.startTrading({ symbol: 'TEST', initialCapital: 10000 });
  config.update({ ai: { autonomy: 'FULL' } });
  const price = (o) => { for (const [s, p] of Object.entries(o)) provider.px(s, p); };
  const pass = async (ms, o) => { clock.t += ms; price(o); await plan.tick(); };
  return { store, clock, config, desk, provider, plan, sharia, price, pass, decider };
}
const two = { targets: { stocks: 40, funds: 30 }, symbols: { stocks: ['TEST'], funds: ['FUND'] }, smart: false, pace: 1, band: 5, guard: 10 };

test('plan: builds by itself, keeps out refused symbols, records real orders, blocks the other decision-maker', async () => {
  const c = await make();
  await c.plan.set(two);
  c.sharia.status.FUND = 'NO';
  await c.pass(1000, { TEST: 100, FUND: 50 });
  assert.equal(c.desk.book.portfolio.position('TEST'), null, 'saved but not started');
  c.plan.toggle(true);
  await c.pass(1000, { TEST: 100, FUND: 50 });
  assert.equal(c.desk.book.portfolio.position('TEST').qty, 39);
  assert.equal(c.desk.book.portfolio.position('FUND'), null);
  assert.equal(c.plan.status().rows.find((r) => r.symbol === 'FUND').wait, 'SHARIA');
  const orders = c.store.listOrders(c.desk.book.session.id);
  assert.equal(orders.filter((o) => o.side === 'BUY' && o.source === 'PLAN' && o.status === 'FILLED').length, 1);
  assert.equal(c.store.listFills(c.desk.book.session.id)[0].kind, 'PLAN');
  await c.pass(1000, { TEST: 100, FUND: 50 });
  assert.equal(c.desk.book.portfolio.position('TEST').qty, 39, 'no repeat');
  c.decider.push((s) => buyProposal(s));
  const d = await c.desk.agent('TEST').runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(d && d.status, 'NO_ACTION', JSON.stringify(c.store.listActivity(c.desk.book.session.id, 5)));
  c.sharia.status.FUND = 'YES';
  await c.pass(60000, { TEST: 100, FUND: 50 });
  assert.equal(c.desk.book.portfolio.position('FUND').qty, 59);
  // a new service over the same storage remembers everything
  const again = new PlanService({ store: c.store, desk: c.desk, lab: null, getConfig: () => c.config.get(), now: () => c.clock.now() });
  assert.deepEqual(again.state.managed.sort(), ['FUND', 'TEST']);
  assert.equal(again.manages('TEST'), true);
});

test('plan: a hand-closed position is left alone for a day; old prices never trade', async () => {
  const c = await make();
  await c.plan.set(two); c.plan.toggle(true);
  await c.pass(1000, { TEST: 100, FUND: 50 });
  await c.desk.agent('TEST').closePosition();
  await c.pass(700000, { TEST: 100, FUND: 50 });
  assert.equal(c.desk.book.portfolio.position('TEST'), null);
  assert.equal(c.plan.waiting.TEST, 'HELD');
  const d = await make();
  await d.plan.set(two); d.plan.toggle(true);
  d.price({ TEST: 100, FUND: 50 }); d.clock.t += 600000;
  await d.plan.tick();
  assert.equal(d.desk.book.portfolio.openPositionCount(), 0);
});

test('plan: the loss guard sells what the plan bought and turns it off', async () => {
  const c = await make();
  await c.plan.set(two); c.plan.toggle(true);
  await c.pass(1000, { TEST: 100, FUND: 50 });
  await c.pass(700000, { TEST: 70, FUND: 45 });
  assert.equal(c.desk.book.portfolio.openPositionCount(), 0, JSON.stringify(c.plan.waiting));
  assert.equal(c.plan.state.on, false); assert.equal(c.plan.state.stopped, 'GUARD');
  await c.pass(700000, { TEST: 70, FUND: 45 });
  assert.equal(c.desk.book.portfolio.openPositionCount(), 0);
});

test('plan: approval mode asks, suggestion mode never trades', async () => {
  const c = await make();
  c.config.update({ ai: { autonomy: 'SEMI' } });
  await c.plan.set(two); c.plan.toggle(true);
  await c.pass(1000, { TEST: 100, FUND: 50 });
  assert.equal(c.desk.book.portfolio.openPositionCount(), 0);
  assert.equal(c.plan.asks.length, 2);
  const [x, y] = c.plan.asks;
  assert.equal(c.plan.answer(x.id, true).ok, true);
  c.plan.answer(y.id, false);
  await c.pass(700000, { TEST: 100, FUND: 50 });
  assert.equal(c.desk.book.portfolio.openPositionCount(), 1);
  assert.throws(() => c.plan.answer(y.id, true), /expired/);
  // a drop outside the automatic mode stops the plan but sells nothing
  await c.pass(700000, { TEST: 70, FUND: 45 });
  assert.equal(c.desk.book.portfolio.openPositionCount(), 1);
  assert.equal(c.plan.state.on, false);
  const d = await make();
  d.config.update({ ai: { autonomy: 'ADVISORY' } });
  await d.plan.set(two); d.plan.toggle(true);
  await d.pass(1000, { TEST: 100, FUND: 50 });
  assert.equal(d.desk.book.portfolio.openPositionCount(), 0);
});

test('plan: the yearly picture does not assume past gains repeat', () => {
  const series = {};
  for (const [s, g] of [['NVDA', 1.003], ['AAPL', 1.001], ['BTC/USD', 1.004], ['PAXG/USD', 1.0005]]) { let p = 100; series[s] = Array.from({ length: 200 }, (_, i) => ({ time: 1700000000 + i * 86400, close: (p *= g * (1 + (i % 2 ? 0.01 : -0.01))) })); }
  const r = A.simulate(mix(), {}, series, { capital: 10000, paths: 200 });
  assert.ok(r.end[1] > 8500 && r.end[1] < 11500, JSON.stringify(r.end));
  assert.ok(r.end[0] <= r.end[1] && r.end[1] <= r.end[2]);
  assert.equal(A.simulate(mix(), {}, {}), null);
});
