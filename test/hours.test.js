'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { marketHours, rule } = require('../server/market/hours');
const { MarketCalendar } = require('../server/market/session');
const isoOf = (ms) => new Date(ms).toISOString();

test('NYSE rules: holidays, observed days and early closes', () => {
  for (const [d, k] of [['2026-01-01', 'NEW_YEAR'], ['2026-01-19', 'MLK'], ['2026-02-16', 'PRESIDENTS'], ['2026-04-03', 'GOOD_FRIDAY'], ['2026-05-25', 'MEMORIAL'], ['2026-06-19', 'JUNETEENTH'], ['2026-07-03', 'INDEPENDENCE'], ['2026-09-07', 'LABOR'], ['2026-11-26', 'THANKSGIVING'], ['2026-12-25', 'CHRISTMAS'], ['2027-07-05', 'INDEPENDENCE'], ['2027-12-24', 'CHRISTMAS'], ['2027-03-26', 'GOOD_FRIDAY']]) assert.equal(rule(d).holiday, k, d);
  for (const d of ['2026-11-27', '2026-12-24', '2025-07-03']) assert.equal(rule(d).early, true, d);
  assert.equal(rule('2026-11-24').holiday, null);
  assert.equal(rule('2026-11-24').early, false);
  assert.equal(rule('2027-12-31').holiday, null); // a Saturday New Year's Day is not moved to Friday
  assert.equal(rule('2026-11-28').weekend, true);
});

test('market hours: New York times in UTC, with summer time, holidays and early closes', () => {
  const h = marketHours(null, Date.parse('2026-11-24T02:00:00Z')); // the evening of 23 November in New York
  const day = (d) => h.days.find((x) => x.date === d);
  assert.equal(h.official, false);
  assert.equal(h.days[0].date, '2026-11-23');
  assert.equal(isoOf(day('2026-11-24').open), '2026-11-24T14:30:00.000Z');
  assert.equal(isoOf(day('2026-11-24').close), '2026-11-24T21:00:00.000Z');
  assert.equal(isoOf(day('2026-11-24').pre), '2026-11-24T09:00:00.000Z');
  assert.deepEqual([day('2026-11-26').open, day('2026-11-26').holiday], [null, 'THANKSGIVING']);
  assert.equal(isoOf(day('2026-11-27').close), '2026-11-27T18:00:00.000Z');
  assert.equal(isoOf(day('2026-11-27').post), '2026-11-27T22:00:00.000Z');
  assert.equal(isoOf(marketHours(null, Date.parse('2026-07-06T12:00:00Z')).days[0].open), '2026-07-06T13:30:00.000Z');
});

test('market hours: the official calendar and clock win over the rules', async () => {
  const now = Date.parse('2026-11-24T15:00:00Z');
  const c = new MarketCalendar({
    fetchCalendar: async () => [{ date: '2026-11-24', open: '09:30', close: '13:00', session_open: '0400', session_close: '1700' }, { date: '2026-11-27', open: '09:30', close: '13:00' }],
    fetchClock: async () => ({ is_open: false, timestamp: isoOf(now), next_open: '2026-11-27T14:30:00Z', next_close: '2026-11-27T18:00:00Z' }),
  });
  await c.load(now);
  let h = marketHours(c, now);
  assert.equal(h.official, true);
  assert.equal(isoOf(h.days[0].close), '2026-11-24T18:00:00.000Z');
  assert.equal(h.days[0].early, true);
  assert.equal(h.days[1].open, null); // not in the official list
  assert.equal(h.closedUntil, null);
  await c.syncClock(now, () => now);
  h = marketHours(c, now);
  assert.equal(isoOf(h.closedUntil), '2026-11-27T14:30:00.000Z'); // an unscheduled closure
});
