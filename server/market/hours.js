'use strict';
/**
 * US stock market hours for display: the coming days with their opening and closing times.
 * The official calendar and clock are used when they are loaded (live prices). Otherwise the published
 * NYSE holiday and early-close rules apply; those cannot know an unscheduled closure.
 * Trading decisions do not use this file: they use MarketCalendar.info().
 */
const { etWallToUtcMs, etDateStr, addDays } = require('../util/time');

const wd = (d) => { const [y, m, x] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, x)).getUTCDay(); };
const iso = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10);
const nth = (y, m, day, n) => iso(y, m, 1 + ((day - wd(iso(y, m, 1)) + 7) % 7) + (n - 1) * 7);
const last = (y, m, day) => { const end = new Date(Date.UTC(y, m, 0)).getUTCDate(); return iso(y, m, end - ((wd(iso(y, m, end)) - day + 7) % 7)); };
// a holiday on Sunday moves to Monday and one on Saturday to Friday
const observed = (d) => (wd(d) === 0 ? addDays(d, 1) : wd(d) === 6 ? addDays(d, -1) : d);

function easter(y) {
  const a = y % 19; const b = Math.floor(y / 100); const c = y % 100; const e = b % 4; const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3); const h = (19 * a + b - Math.floor(b / 4) - g + 15) % 30; const k = c % 4;
  const l = (32 + 2 * e + 2 * Math.floor(c / 4) - h - k) % 7; const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const n = h + l - 7 * m + 114;
  return iso(y, Math.floor(n / 31), (n % 31) + 1);
}

function holidays(y) {
  const ny = iso(y, 1, 1);
  return new Map([
    ...(wd(ny) === 6 ? [] : [[observed(ny), 'NEW_YEAR']]), // a Saturday New Year's Day is not observed on Friday
    [nth(y, 1, 1, 3), 'MLK'], [nth(y, 2, 1, 3), 'PRESIDENTS'], [addDays(easter(y), -2), 'GOOD_FRIDAY'], [last(y, 5, 1), 'MEMORIAL'],
    [observed(iso(y, 6, 19)), 'JUNETEENTH'], [observed(iso(y, 7, 4)), 'INDEPENDENCE'], [nth(y, 9, 1, 1), 'LABOR'], [nth(y, 11, 4, 4), 'THANKSGIVING'], [observed(iso(y, 12, 25)), 'CHRISTMAS'],
  ]);
}

/** What the published rules say about a New York date. */
function rule(date) {
  const y = Number(date.slice(0, 4));
  const holiday = holidays(y).get(date) || null;
  const weekend = wd(date) === 0 || wd(date) === 6;
  const early = !holiday && !weekend && (date === addDays(nth(y, 11, 4, 4), 1) || date === iso(y, 12, 24) || date === iso(y, 7, 3));
  return { holiday, weekend, early };
}

const at = (date, s) => { const t = String(s).replace(':', ''); return etWallToUtcMs(date, Number(t.slice(0, 2)), Number(t.slice(2, 4))); };

function marketHours(calendar, nowMs = Date.now(), count = 8) {
  const official = !!(calendar && calendar.days && calendar.days.size);
  const days = [];
  for (let i = 0, date = etDateStr(nowMs); i < count; i++, date = addDays(date, 1)) {
    const r = rule(date);
    const d = official ? calendar.dayInfo(date) : r.holiday || r.weekend ? { isTradingDay: false } : { isTradingDay: true, open: '09:30', close: r.early ? '13:00' : '16:00', pre: '04:00', post: r.early ? '17:00' : '20:00' };
    const t = (k) => (d.isTradingDay ? at(date, d[k]) : null);
    days.push({ date, weekend: r.weekend, holiday: d.isTradingDay ? null : r.holiday, early: !!d.isTradingDay && String(d.close).replace(':', '') !== '1600', pre: t('pre'), open: t('open'), close: t('close'), post: t('post') });
  }
  // the official clock can report a closure that no calendar knew
  const today = days[0];
  const inSession = today.open !== null && nowMs >= today.open && nowMs < today.close;
  const closedUntil = official && inSession && calendar.clockState(nowMs) === 'CLOSED' ? calendar.clock.nextOpenMs : null;
  return { now: nowMs, official, closedUntil, days };
}

module.exports = { marketHours, rule };
