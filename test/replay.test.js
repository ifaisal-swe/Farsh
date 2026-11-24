'use strict';
const { URL } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { runReplay } = require('../server/engine/replay');
const { ReplayProvider, VirtualClock } = require('../server/market/replay');
const { RulesDecider } = require('../server/ai/decider');
const { makeMinuteBars, makeDailyBars } = require('./helpers/fixtures');
const { etWallToUtcMs, TIMEFRAMES } = require('../server/util/time');
const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');

const DAY = '2026-11-18';
const bars = makeMinuteBars({ date: DAY, fromH: 9, fromM: 30, endMs: etWallToUtcMs(DAY, 15, 0), drift: 0.004, seed: 11 });
const daily = makeDailyBars(260, '2026-11-17');
const news = [
  { created_at: new Date(etWallToUtcMs(DAY, 11, 0)).toISOString(), headline: 'Testco wins large contract', summary: 'early news', source: 'replay', url: 'https://example.com/a', symbols: ['TEST'] },
  { created_at: new Date(etWallToUtcMs(DAY, 14, 0)).toISOString(), headline: 'Testco announces acquisition', summary: 'late news', source: 'replay', url: 'https://example.com/b', symbols: ['TEST'] },
];

/** Rules baseline that also audits every snapshot it receives for look-ahead. */
class AuditingDecider extends RulesDecider {
  constructor() { super(); this.calls = 0; this.violations = []; this.seen = []; }
  async decide(s) {
    this.calls++;
    const now = Date.parse(s.createdAt);
    if (!(now >= bars[0].time * 1000 && now <= etWallToUtcMs(DAY, 15, 1))) this.violations.push(`snapshot time ${s.createdAt} is not replay time`);
    for (const [tf, v] of Object.entries(s.timeframes)) {
      for (const b of v.recentBars) if (Date.parse(b.t) + TIMEFRAMES[tf].sec * 1000 > now) this.violations.push(`${tf} bar ${b.t} not complete at ${s.createdAt}`);
      if (v.formingBar && Date.parse(v.formingBar.t) > now) this.violations.push(`${tf} forming bar from the future`);
    }
    for (const n of s.untrusted_external_content.news) if (Date.parse(n.publishedAt) > now) this.violations.push(`news "${n.title}" published after ${s.createdAt}`);
    this.seen.push({ at: now, titles: s.untrusted_external_content.news.map((n) => n.title) });
    return super.decide(s);
  }
}

test('replay provider never reveals bars that have not closed yet', async () => {
  const p = new ReplayProvider({ symbol: 'TEST', minuteBars: bars, warmupBars: 60 });
  const clock = p.clock;
  assert.ok(clock instanceof VirtualClock);
  const visible = await p.fetchBars('TEST', '1m');
  assert.equal(visible.length, 60);
  assert.ok(visible.every((b) => (b.time + 60) * 1000 <= clock.now()));
  p.step();
  assert.equal((await p.fetchBars('TEST', '1m')).length, 61);
  const five = await p.fetchBars('TEST', '5m');
  assert.ok(five.every((b) => b.time * 1000 <= clock.now()));
});

test('replay: no future candles or news leak into any decision', async () => {
  const spy = new AuditingDecider();
  const r = await runReplay({ databaseUrl: URL, symbol: 'TEST', minuteBars: bars, dailyBars: daily, news, decider: spy, initialCapital: 10000, analysisTimeframe: '5m', warmupBars: 60 });
  assert.ok(spy.calls > 30, `expected many decisions, got ${spy.calls}`);
  assert.deepEqual(spy.violations, []);
  for (const x of spy.seen) {
    if (x.at < etWallToUtcMs(DAY, 14, 0)) assert.ok(!x.titles.includes('Testco announces acquisition'), 'late news leaked');
    if (x.at < etWallToUtcMs(DAY, 11, 0)) assert.equal(x.titles.length, 0);
  }
  assert.ok(spy.seen.some((x) => x.titles.includes('Testco wins large contract')));
  assert.ok(r.decisions.length === spy.calls);
});

test('replay is deterministic: identical inputs give identical fills and equity', async () => {
  const legacy = { risk: { ...LEGACY_DEFAULTS, profile: 'CUSTOM' } };
  const a = await runReplay({ databaseUrl: URL, symbol: 'TEST', minuteBars: bars, dailyBars: daily, decider: new RulesDecider(), initialCapital: 10000, warmupBars: 60, configOverrides: legacy });
  const b = await runReplay({ databaseUrl: URL, symbol: 'TEST', minuteBars: bars, dailyBars: daily, decider: new RulesDecider(), initialCapital: 10000, warmupBars: 60, configOverrides: legacy });
  const strip = (fs) => fs.map((f) => [f.side, f.qty, f.price.toFixed(6), f.ts, f.kind]);
  assert.ok(a.fills.length >= 1, 'rules baseline traded at least once on the trending sample');
  assert.deepEqual(strip(a.fills), strip(b.fills));
  assert.equal(a.valuation.equity.toFixed(6), b.valuation.equity.toFixed(6));
  assert.match(a.metrics.sampleWarning, /too few/, 'never claims profitability from a handful of trades');
});
