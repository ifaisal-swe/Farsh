'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { lens, ranks, cagr, verdict, InvestorService } = require('../server/lab/investors');
const F = require('../server/lab/facts');
const CB = require('../server/analysis/chartbook');
const Ind = require('../server/analysis/indicators');

const day = (i, close, o = {}) => ({ time: 1700000000 + i * 86400, open: o.open ?? close, high: o.high ?? close * 1.01, low: o.low ?? close * 0.99, close, volume: o.volume ?? 1000 });
const rising = (n = 300, g = 0.002) => Array.from({ length: n }, (_, i) => day(i, 100 * (1 + g) ** i));
const falling = (n = 300) => Array.from({ length: n }, (_, i) => day(i, 300 * 0.997 ** i));
const row = (...x) => x;
const good = { period: '9/2026', revenue: row(400e6, 330e6, 270e6, 220e6), gross: row(240e6, 190e6, 150e6, 120e6), op: row(130e6, 100e6, 80e6, 60e6), net: row(100e6, 78e6, 60e6, 46e6), ebit: row(130e6, 100e6, 80e6, 60e6), interest: row(1e6, 1e6, 1e6, 1e6), ca: row(300e6, 230e6, 180e6, 150e6), ta: row(600e6, 510e6, 430e6, 370e6), cl: row(100e6, 90e6, 80e6, 75e6), tl: row(160e6, 150e6, 140e6, 135e6), ltd: row(40e6, 45e6, 50e6, 55e6), eq: row(440e6, 360e6, 290e6, 235e6), re: row(300e6, 220e6, 160e6, 110e6), cash: row(150e6, 100e6, 70e6, 60e6), sti: row(20e6, 10e6, 0, 0), cfo: row(120e6, 95e6, 75e6, 60e6), fcf: row(100e6, 78e6, 60e6, 48e6), debt: row(50e6, 55e6, 60e6, 65e6), fixed: row(100e6, 95e6, 90e6, 85e6) };
const facts = (s, cap, o = {}) => ({ statements: s, health: F.health(s, cap), sector: 'Technology', ...o });
const by = (x, id) => x.methods.find((m) => m.id === id);

test('investors: a strong, fairly priced company passes the quality, growth and health rules', () => {
  const x = lens({ bars: rising(), bench: rising(300, 0.0005), facts: facts(good, 1.2e9) });
  assert.equal(by(x, 'buffett').rules[0].state, 'PASS');
  assert.equal(by(x, 'lynch').result, 'FITS'); // 29% growth at 12 times earnings
  assert.equal(by(x, 'graham').rules[0].state, 'PASS'); // 300 / 100
  assert.equal(by(x, 'graham').rules[3].state, 'UNKNOWN'); // twenty years of dividends are not in the data
  assert.equal(by(x, 'graham').rules[2].state, 'UNKNOWN'); // four years cannot prove ten
  assert.equal(by(x, 'piotroski').passed, 8);
  assert.equal(by(x, 'piotroski').known, 8);
  assert.equal(by(x, 'minervini').result, 'FITS');
  assert.equal(by(x, 'momentum').result, 'FITS');
  assert.equal(x.distress.zone, 'SAFE');
});

test('investors: losses, debt and a falling price fail, they are not skipped', () => {
  const bad = { ...good, net: row(-20e6, 10e6, 30e6, 40e6), fcf: row(-30e6, 5e6, 10e6, 20e6), ca: row(80e6, 90e6, 95e6, 99e6), debt: row(500e6, 400e6, 300e6, 200e6), ltd: row(480e6, 380e6, 280e6, 190e6), eq: row(60e6, 90e6, 110e6, 120e6), re: row(-200e6, -150e6, 0, 0), ebit: row(-10e6, 20e6, 40e6, 50e6) };
  const x = lens({ bars: falling(), bench: rising(), facts: facts(bad, 1e8) });
  for (const id of ['graham', 'buffett', 'minervini', 'momentum']) assert.equal(by(x, id).result, 'NOT', id);
  assert.equal(by(x, 'graham').rules[2].state, 'FAIL');
  assert.equal(x.fits, 0);
  const bank = lens({ bars: [], facts: facts(good, 1e9, { sector: 'Finance' }), rank: { yield: 1, capital: 1, of: 4 } });
  assert.equal(by(bank, 'greenblatt').result, 'NOT');
  assert.equal(by(lens({ bars: [], facts: facts(good, 1e9) }), 'greenblatt').result, 'UNKNOWN'); // passing the conditions alone proves nothing
});

test('investors: without company data only the price methods answer; short history stays unknown', () => {
  const x = lens({ bars: rising(), bench: [], facts: null });
  assert.equal(by(x, 'buffett').result, 'UNKNOWN');
  assert.equal(by(x, 'minervini').rules.at(-1).state, 'UNKNOWN'); // no market to compare with
  assert.equal(by(x, 'minervini').known, 7);
  const y = lens({ bars: rising(60), facts: null });
  assert.equal(by(y, 'minervini').result, 'UNKNOWN');
  assert.equal(y.judged, 0);
  assert.equal(cagr([10, null, null, null]), null);
  assert.equal(cagr([8, 4, 2, 1]), 1);
  assert.equal(verdict([{ state: 'PASS' }, { state: 'UNKNOWN' }, { state: 'UNKNOWN' }]).result, 'UNKNOWN');
});

test('investors: missing values never become passes', () => {
  const none = Object.fromEntries(Object.keys(good).map((k) => [k, k === 'period' ? 'x' : [null, null, null, null]]));
  none.revenue = row(1, null, null, null);
  const x = lens({ bars: [], facts: facts(none, null) });
  for (const m of x.methods) for (const r of m.rules.filter((q) => !q.gate)) assert.notEqual(r.state, 'PASS', `${m.id}: ${r.text.en}`);
});

test('investors: ranking needs three companies', () => {
  const cheap = facts(good, 5e8); const dear = facts(good, 5e9); const mid = facts(good, 1.5e9);
  assert.deepEqual(ranks([{ symbol: 'A', facts: cheap }, { symbol: 'B', facts: dear }]), {});
  const r = ranks([{ symbol: 'A', facts: cheap }, { symbol: 'B', facts: dear }, { symbol: 'C', facts: mid }]);
  assert.deepEqual([r.A.yield, r.C.yield, r.B.yield], [1, 2, 3]);
});

test('investors service: company pages are read only for live stocks, one at a time, and kept', async () => {
  const asked = [];
  const agents = [{ symbol: 'AAA', dataMode: 'LIVE' }, { symbol: 'BTC/USD', dataMode: 'LIVE' }, { symbol: 'BBB', dataMode: 'LIVE' }];
  const svc = new InvestorService({ desk: { all: () => agents }, lab: { benchmark: async () => rising() }, getBars: async () => ({ daily: rising() }), publicData: true, isCrypto: (s) => s.includes('/'), gatherImpl: async (s) => { asked.push(s); return facts(good, 1e9); } });
  await svc.status();
  await new Promise((r) => setTimeout(r, 20));
  const st = await svc.status();
  assert.deepEqual(asked, ['AAA', 'BBB']);
  assert.equal(st.items[0].hasCompany, true);
  assert.equal(st.items[1].crypto, true);
  assert.equal(by(st.items[1], 'buffett').result, 'UNKNOWN');
  const demo = new InvestorService({ desk: { all: () => [{ symbol: 'AAA', dataMode: 'DEMO' }] }, lab: { benchmark: async () => [] }, getBars: async () => ({ daily: [] }), publicData: true, isCrypto: () => false, gatherImpl: async () => { throw new Error('must not be asked'); } });
  assert.equal((await demo.status()).items[0].hasCompany, false); // invented prices are never mixed with real statements
});

test('chartbook: series are aligned with the bars and use no later bar', () => {
  const bars = Array.from({ length: 260 }, (_, i) => { const c = 100 + Math.sin(i / 7) * 8 + i * 0.05; return day(i, c, { open: c - Math.cos(i / 7), high: c + 2, low: c - 2, volume: 1000 + i }); });
  const x = CB.build(bars, { tf: '1d' });
  for (const a of [...Object.values(x.averages), x.rsi, x.mfi, x.stoch.k, x.stoch.d, x.flow, x.macd.hist, x.bands.upper]) assert.equal(a.length, bars.length);
  const y = CB.build(bars.slice(0, 200), { tf: '1d' });
  for (const k of ['rsi', 'mfi', 'flow']) assert.deepEqual(x[k].slice(0, 200), y[k], k);
  assert.ok(Math.abs(x.averages.sma20.at(-1) - Ind.sma(bars.map((b) => b.close), 20).at(-1)) < 1e-3);
  assert.ok(x.mfi.filter((v) => v !== null).every((v) => v >= 0 && v <= 100));
  assert.ok(x.inflow >= 0 && x.inflow <= 1);
  assert.equal(CB.build(bars.slice(0, 10)).available, false);
  const f = CB.fibonacci(rising(120));
  assert.equal(f.up, true);
  assert.ok(Math.abs(f.levels[2].price - (f.top + f.bottom) / 2) < 1e-9);
});

test('chartbook: money flow follows where each bar closes', () => {
  const top = Array.from({ length: 30 }, (_, i) => day(i, 100, { open: 98, high: 100, low: 98 }));
  const low = Array.from({ length: 30 }, (_, i) => day(i, 98, { open: 100, high: 100, low: 98 }));
  assert.equal(CB.inflowShare(top), 1);
  assert.equal(CB.inflowShare(low), 0);
});
