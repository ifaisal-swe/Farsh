'use strict';
const { tempStore } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../server/db');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { Desk } = require('../server/engine/desk');
const { Redactor } = require('../server/util/misc');
const { AnalysisScheduler } = require('../server/ai/scheduler');
const { PlanService } = require('../server/plan/service');
const { InvestService } = require('../server/invest/service');
const { CommandService } = require('../server/commands/service');
const { parse } = require('../server/commands/parse');
const tech = require('../server/lab/technical');
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
  const store = tempStore();
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
async function setup() { const c = await make(); c.cmd = new CommandService({ store: c.store, desk: c.desk, now: () => c.clock.now() }); c.at = (p, ms = 6000) => { c.clock.t += ms; c.price({ TEST: p }); c.cmd.tick(); }; c.held = () => c.desk.book.portfolio.position('TEST'); c.one = (i = 0) => c.cmd.status().orders[i]; c.open = () => c.cmd.status().orders.filter((x) => ['WAITING', 'PART'].includes(x.status)); return c; }
const buy = (o = {}) => ({ side: 'BUY', symbol: 'TEST', type: 'LIMIT', price: 95, qty: 10, ...o });
const sell = (o = {}) => ({ side: 'SELL', symbol: 'TEST', type: 'LIMIT', price: 110, qty: 10, ...o });

test('commands: a limit purchase waits, then runs at its price or better, once', async () => {
  const c = await setup(); c.at(100);
  await c.cmd.add(buy());
  assert.equal(c.held(), null); assert.equal(c.one().wait, 'REACH'); assert.equal(c.cmd.status().free, 9050);
  c.at(95.5); assert.equal(c.held(), null);
  c.at(94); assert.equal(c.held().qty, 10); assert.ok(c.held().avgPrice <= 95);
  assert.equal(c.one().status, 'DONE'); assert.equal(c.store.listFills(c.desk.book.session.id)[0].kind, 'COMMAND');
  c.at(90); assert.equal(c.held().qty, 10);
});

test('commands: stop purchase, then its stop and target share the same shares', async () => {
  const c = await setup(); c.at(100);
  await c.cmd.add(buy({ type: 'STOP', price: 105, stop: 101, target: 112 }));
  c.at(104); assert.equal(c.held(), null);
  c.at(105.2); assert.equal(c.held().qty, 10); assert.equal(c.open().length, 2);
  c.at(112.5); assert.equal(c.held(), null);
  assert.equal(c.open().length, 0); assert.ok(c.cmd.status().orders.some((x) => x.end === 'OTHER')); assert.ok(c.cmd.status().orders.some((x) => x.result > 0));
  c.at(90); assert.equal(c.held(), null);
  const d = await setup(); d.at(100); await d.cmd.add(buy({ type: 'MARKET', stop: 97, target: 110 })); assert.ok(d.held());
  d.desk.pause(); d.at(96.5); assert.equal(d.held(), null, 'works while automation is paused');
});

test('commands: selling: limit, stop, trailing, parts, and never more than is held', async () => {
  const c = await setup(); c.at(100); await c.cmd.add(buy({ type: 'MARKET' }));
  await assert.rejects(c.cmd.add(sell({ qty: 11 })), /do not hold this quantity/);
  await assert.rejects(c.cmd.add(sell({ symbol: 'ABC' })), /do not hold this symbol/);
  await c.cmd.add(sell({ qty: 4 })); c.at(109.9 - 0.2); assert.equal(c.held().qty, 10); c.at(110.1); assert.equal(c.held().qty, 6);
  await c.cmd.add(sell({ type: 'TRAIL', trail: 5, price: null, qty: 2 }));
  c.at(120); c.at(115); assert.equal(c.held().qty, 6); c.at(113.9); assert.equal(c.held().qty, 4);
  await c.cmd.add(sell({ type: 'STOP', price: 100, all: true, qty: null })); c.at(98); assert.equal(c.held(), null);
});

test('commands: real conditions: shown size fills in parts, a closed market and old prices wait, day orders end', async () => {
  const c = await setup(); c.at(100);
  const quote = (bid, ask, size) => { c.clock.t += 6000; c.provider.emit('quote', { symbol: 'TEST', bid, ask, bidSize: size, askSize: size, ts: c.clock.t, receivedAt: c.clock.t }); c.provider.emit('trade', { symbol: 'TEST', price: bid, size: 1, ts: c.clock.t, receivedAt: c.clock.t }); };
  await c.cmd.add(buy());
  quote(94.97, 95, 4); assert.equal(c.held().qty, 4); assert.equal(c.one().status, 'PART');
  quote(94.97, 95, 400); assert.equal(c.held().qty, 10); assert.equal(c.one().average, 95);
  const d = await setup(); d.at(100); await d.cmd.add(buy({ price: 99, day: true }));
  d.clock.t += 600000; d.cmd.tick(); assert.equal(d.held(), null); assert.equal(d.one().wait, 'PRICE');
  d.clock.t += 8 * 3600000; d.price({ TEST: 98 }); d.cmd.tick(); assert.equal(d.held(), null); assert.equal(d.one().end, 'TIME');
  const e = await setup(); e.at(100); await e.cmd.add(buy()); e.clock.t += 8 * 3600000; e.price({ TEST: 94 }); e.cmd.tick(); assert.equal(e.held(), null); assert.equal(e.one().wait, 'CLOSED');
});

test('commands: cash is respected, the Sharia screen is not a condition, automation stays away, changes, cancels, and storage', async () => {
  const s = await setup(); s.at(100); s.sharia.status.TEST = 'NO'; await s.cmd.add(buy()); s.at(94); assert.ok(s.held(), 'the screen does not block');
  const c = await setup(); c.at(100);
  await c.cmd.add(buy()); assert.equal(c.held(), null);
  assert.equal(c.desk.agent('TEST').planned(), true);
  c.decider.push((s) => buyProposal(s)); assert.equal((await c.desk.agent('TEST').runAnalysis({ reasons: [{ type: 'MANUAL' }] })).status, 'NO_ACTION');
  await assert.rejects(c.cmd.add(buy({ qty: 200 })), /Not enough cash/); await assert.rejects(c.cmd.add(buy({ qty: 0 })), /quantity/); await assert.rejects(c.cmd.add(buy({ price: null })), /price/); await assert.rejects(c.cmd.add(buy({ stop: 99 })), /stop must be below/); await assert.rejects(c.cmd.add(buy({ type: 'TRAIL' })), /Choose/); await assert.rejects(c.cmd.add(buy({ qty: null, dollars: 20 })), /less than one share/);
  c.cmd.change(c.one().id, { price: 90 }); assert.equal(c.one().price, 90);
  const again = new CommandService({ store: c.store, desk: c.desk, now: () => c.clock.now() }); assert.equal(again.status().orders[0].price, 90);
  again.cancel(again.status().orders[0].id); assert.equal(again.manages('TEST'), false); assert.equal(again.status().free, 10000);
  assert.throws(() => again.cancel(again.status().orders[0].id), /ended/);
  await assert.rejects(c.plan.set({ targets: { stocks: 101 }, symbols: { stocks: ['TEST'] } }));
});

test('commands: typed orders in both languages', () => {
  const p = (t) => { const r = parse(t); return [r.side, r.symbol, r.type, r.price, r.qty, r.dollars, r.stop, r.target].join('|'); };
  assert.equal(p('buy 5 NVDA at 160 stop 150 target 180'), 'BUY|NVDA|LIMIT|160|5||150|180');
  assert.equal(p('اشتري ٥ نفيديا عند ١٦٠ وقف ١٥٠ هدف ١٨٠'), 'BUY|NVDA|LIMIT|160|5||150|180');
  assert.equal(p('buy on price 72.98 stock TSLA 4 shares'), 'BUY|TSLA|LIMIT|72.98|4|||');
  assert.equal(p('buy $1,000 of gold'), 'BUY|PAXG/USD|MARKET|||1000||');
  assert.equal(p('اشتر 2 تسلا إذا تجاوز 300'), 'BUY|TSLA|STOP|300|2|||');
  assert.equal(p('sell 3 NVDA if it falls below 150'), 'SELL|NVDA|STOP|150|3|||');
  assert.equal(parse('بع كل NVDA عند 180').all, true); assert.equal(parse('sell 3 NVDA trailing 5%').trail, 5);
  assert.deepEqual(parse('').missing, ['side', 'symbol', 'amount']);
});

const series = (n, f) => Array.from({ length: n }, (_, i) => { const c = f(i); return { time: 1600000000 + i * 86400, open: f(i - 0.5), high: c * 1.012, low: c * 0.988, close: c, volume: 1000 + (i % 7) * 100 }; });
test('technical: direction, levels, ready orders and honest records', () => {
  const up = tech.analyze({ daily: series(600, (i) => 50 * 1.002 ** i * (1 + 0.03 * Math.sin(i / 6))) });
  const down = tech.analyze({ daily: series(600, (i) => 500 * 0.997 ** i * (1 + 0.03 * Math.sin(i / 6))) });
  assert.ok(up.score > 0.1 && down.score < -0.1, up.score + ' ' + down.score);
  for (const r of [up, down]) { assert.ok(r.steps.length >= 2); for (const x of r.setups) if (x.side === 'BUY') assert.ok(x.stop < x.price && x.price < x.target, JSON.stringify(x)); for (const x of r.horizons.days.readings) assert.ok(x.name.ar && x.what.en && x.todo.ar && Math.abs(x.score) <= 1); }
  assert.ok(down.setups.filter((x) => x.side === 'BUY').every((x) => x.against));
  assert.equal(tech.analyze({ daily: series(30, () => 10) }), null);
  assert.ok(tech.analyze({ daily: series(600, (i) => 100 + 5 * Math.sin(i / 5)), held: 3 }).setups.some((x) => x.id === 'PROTECT'));
  // look-ahead: changing the future does not change what the record counted before
  const b = series(700, (i) => 100 + 10 * Math.sin(i / 9) + i / 50); const a1 = tech.read(b.slice(0, 400), { ar: '', en: '' }); const b2 = b.map((x, i) => (i < 400 ? x : { ...x, close: 1 })); assert.deepEqual(tech.read(b2.slice(0, 400), { ar: '', en: '' }), a1);
  for (const x of tech.record(b)) assert.ok(!x.useful || x.times >= 12);
  const pr = tech.practice(b, 5); assert.equal(pr.next.length, 15); assert.equal(pr.bars.length, 70); assert.deepEqual(tech.practice(b, 5), pr);
  const t = tech.adx(series(200, (i) => 10 * 1.01 ** i)); assert.ok(t.adx > 25 && t.plus > t.minus);
});
