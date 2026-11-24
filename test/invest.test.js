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
const { OrderManager } = require('../server/trading/orders');
const { PlanService } = require('../server/plan/service');
const { InvestService } = require('../server/invest/service');
const V = require('../server/invest/levels');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

const origStart = AnalysisScheduler.prototype.start;
test.before(() => { AnalysisScheduler.prototype.start = function () { this.running = false; }; });
test.after(() => { AnalysisScheduler.prototype.start = origStart; });

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
async function setup() { const c = await make(); c.inv = new InvestService({ store: c.store, desk: c.desk, lab: null, now: () => c.clock.now() }); c.at = (p, ms = 6000) => { c.clock.t += ms; c.price({ TEST: p }); c.inv.tick(); }; c.held = () => c.desk.book.portfolio.position('TEST'); c.first = () => c.inv.status().items[0]; return c; }
const base = { symbol: 'TEST', amount: 2000, days: 30, entry: 72, stop: 70, target: 72.99 + 2, near: 0.05 };

test('invest: 72.98 sells a 72.99 target, and a stop at 72.99 sells at 72.98', () => {
  const o = new OrderManager();
  const p = o.setProtection('X', { stopLoss: 60, takeProfit: 72.99, entryPrice: 70 });
  p.nearPct = 0.05;
  assert.equal(o.evaluate('X', { bid: 72.98, last: 72.98 }, 1).kind, 'TAKE_PROFIT');
  assert.equal(o.evaluate('X', { bid: 72.9, last: 72.9 }, 1), null);
  p.nearPct = 0;
  assert.equal(o.evaluate('X', { bid: 72.98, last: 72.98, nearPct: 0.5 }, 1), null, 'exact when asked');
  const q = o.setProtection('Y', { stopLoss: 72.99, takeProfit: 90, entryPrice: 75 });
  assert.equal(o.evaluate('Y', { bid: 72.98, last: 72.98 }, 1).kind, 'STOP');
  assert.equal(o.evaluate('Y', { bid: 60, last: 60 }, 1).kind, 'STOP', 'a jump past the price also sells');
  assert.ok(q);
  // never counts as a gain when the closeness would be below what was paid
  o.setProtection('Z', { stopLoss: 90, takeProfit: 100.1, entryPrice: 100 }).nearPct = 0.5;
  assert.equal(o.evaluate('Z', { bid: 99.9, last: 99.9 }, 1), null);
});

test('invest: waits for the start, buys, sells near the target, and records the result', async () => {
  const c = await setup();
  c.at(74);
  c.inv.create(base);
  assert.equal(c.held(), null); assert.equal(c.first().wait, 'START');
  c.at(71.9);
  assert.equal(c.held().qty, 27); assert.equal(c.first().status, 'OPEN');
  assert.equal(c.desk.book.orders.getProtection('TEST').takeProfit, 74.99);
  c.at(74.5); assert.ok(c.held());
  c.at(75); // bid 74.98
  assert.equal(c.held(), null);
  const x = c.first();
  assert.equal(x.status, 'CLOSED'); assert.equal(x.end, 'TAKE_PROFIT'); assert.ok(x.result > 70, String(x.result));
  c.at(71.9, 700000); assert.equal(c.held(), null, 'done once');
});

test('invest: the stop works with automation paused; buying does not', async () => {
  const c = await setup();
  c.at(74); c.inv.create(base);
  c.desk.pause(); c.at(71.9);
  assert.equal(c.held(), null); assert.equal(c.first().wait, 'AUTOMATION');
  c.desk.resume(); c.at(71.9); assert.ok(c.held());
  c.desk.pause(); c.at(69.5); assert.equal(c.held(), null);
  assert.equal(c.first().end, 'STOP'); assert.ok(c.first().result < 0);
});

test('invest: Sharia refusal waits, a price through the stop cancels, dates end it, hand sale and changes work', async () => {
  const c = await setup();
  c.at(71); c.sharia.status.TEST = 'NO'; c.inv.create(base); c.at(71);
  assert.equal(c.held(), null); assert.equal(c.first().wait, 'SHARIA');
  c.sharia.status.TEST = 'YES'; c.at(69); assert.equal(c.first().end, 'PASSED');
  c.inv.create({ ...base, entry: 60, stop: 55 }); c.at(69, 11 * 86400000); assert.equal(c.first().status, 'EXPIRED');
  const d = await setup();
  d.at(71); d.inv.create(base); assert.ok(d.held());
  d.inv.update(d.first().id, { stop: 70.5, target: 80 }); assert.equal(d.desk.book.orders.getProtection('TEST').stopLoss, 70.5);
  assert.throws(() => d.inv.update(d.first().id, { stop: 71.5 }), /stop must be below/);
  d.clock.t += 1000; d.price({ TEST: 71 }); d.inv.cancel(d.first().id);
  assert.equal(d.held(), null); assert.equal(d.first().end, 'USER');
});

test('invest: one decision-maker per symbol, cash is reserved, bad input is refused, state survives', async () => {
  const c = await setup();
  c.at(74);
  for (const x of [{ stop: 73 }, { target: 71 }, { amount: 5 }, { days: 0 }, { near: 3 }, { entry: 'x' }, { amount: 1e6 }]) assert.throws(() => c.inv.create({ ...base, ...x }));
  c.inv.create(base);
  assert.throws(() => c.inv.create(base), /already have an investment/);
  assert.equal(c.inv.status().free, 8000);
  await assert.rejects(c.plan.set({ targets: { stocks: 40 }, symbols: { stocks: ['TEST'] } }), /already have an investment/);
  c.decider.push((s) => buyProposal(s));
  const d = await c.desk.agent('TEST').runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  assert.equal(d.status, 'NO_ACTION'); assert.equal(c.held(), null);
  const again = new InvestService({ store: c.store, desk: c.desk, now: () => c.clock.now() });
  assert.equal(again.manages('TEST'), true);
});

const bars = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { time: 1700000000 + i * 86400, open: c, high: c * 1.01, low: c * 0.99, close: c }; });
test('invest: suggested prices are ordered, careful, and the analysts cannot leave the safe range', () => {
  const b = bars(120, (i) => 100 + Math.sin(i / 3) * 2);
  for (const verdict of ['SUPPORT', 'AVOID', 'UNKNOWN']) for (const goalPct of [null, 10]) { const s = V.suggest(b, 100, { days: 20, verdict, goalPct }); assert.ok(s.stop < s.entry && s.entry < s.target, JSON.stringify(s)); if (verdict === 'AVOID') assert.ok(s.entry <= 100.3); }
  assert.ok(V.suggest(b, 112, { days: 20 }).entry < 112, 'a price that ran up is not chased');
  const s = V.suggest(b, 100, { days: 20 });
  const w = V.adopt(s, [{ entry: 500, stop: 1, target: 9000 }, { entry: 500, stop: 1, target: 9000 }]);
  assert.ok(w.entry <= 100.4 && w.stop >= w.entry - 4.1 * s.atr && w.target <= w.entry + 4.1 * (w.entry - w.stop), JSON.stringify(w));
  const no = V.suggest(b, 102, { days: 20, verdict: 'AVOID' });
  assert.ok(V.adopt(no, [{ entry: 102, stop: 97, target: 112 }]).entry <= no.entry, 'the analysts cannot undo the caution');
  assert.equal(V.adopt(s, [{ entry: 1, stop: 2, target: 3 }]), s);
  assert.equal(V.suggest(b.slice(0, 10), 100), null);
  const o = V.odds(bars(300, (i) => 100 * 1.002 ** i * (1 + (i % 2) * 0.02)), { entry: 100, stop: 95, target: 110, days: 20 });
  assert.ok(Math.abs(o.target + o.stop + o.neither - 1) < 1e-9 && o.average < 0.02, JSON.stringify(o));
});

test('goals: needed growth is stated plainly', async () => {
  const c = await setup(); c.at(74);
  const by = new Date(c.clock.t + 365 * 86400000).toISOString().slice(0, 10);
  const g = c.inv.addGoal({ name: 'A', amount: 11000, by }).goals[0];
  assert.ok(Math.abs(g.perYear - 0.1) < 0.005); assert.equal(g.level, 'HARD');
  assert.equal(c.inv.addGoal({ name: 'B', amount: 50000, by }).goals[1].level, 'UNLIKELY');
  assert.throws(() => c.inv.addGoal({ name: 'C', amount: 1, by: '2001-01-01' }), /later date/);
  assert.equal(c.inv.removeGoal(g.id).goals.length, 1);
});
