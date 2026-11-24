'use strict';
/**
 * US equity market sessions (America/New_York; DST handled by util/time).
 *
 * Sources, in order of authority:
 *  - Alpaca market clock  GET /v2/clock     — "is the regular market open right now", next open/close,
 *    and the server time (used to detect a wrong local clock).
 *  - Alpaca calendar      GET /v2/calendar  — trading days, holidays, early closes and the extended-hours
 *    window (session_open/session_close, normally 04:00–20:00 ET).
 *  - Fallback: a clearly flagged weekday estimate (holidays unknown).
 *
 * Feed coverage: a data feed may cover less than the full extended-hours window. The IEX exchange
 * itself trades only 08:00–09:30 (pre-market), 09:30–16:00 (regular) and 16:00–17:00 ET (post-market),
 * so the free Alpaca IEX feed has no prints or quote changes outside those hours. Silence there means
 * "closed for this feed", not a connection failure. `info().feed.active` captures this.
 */
const { etParts, etWallToUtcMs, etDateStr, etTimeStr, addDays } = require('../util/time');

const hm = (s) => {
  const t = String(s).replace(':', '');
  return { h: Number(t.slice(0, 2)), m: Number(t.slice(2, 4)) };
};
const at = (dateStr, s) => { const x = hm(s); return etWallToUtcMs(dateStr, x.h, x.m); };
const weekdayOf = (dateStr) => { const [y, m, d] = dateStr.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)).getUTCDay(); };

class MarketCalendar {
  /**
   * @param {object} o
   * @param {function} [o.fetchCalendar] (startDate, endDate) => Alpaca calendar rows
   * @param {function} [o.fetchClock]    () => Alpaca clock object
   * @param {boolean}  [o.alwaysOpen]    DEMO only
   * @param {object}   [o.coverage]      { name, preOpen:'08:00', postMinutesAfterClose:60, note } or null (= full window)
   */
  constructor({ fetchCalendar = null, fetchClock = null, alwaysOpen = false, coverage = null, overnight = null } = {}) {
    // overnight: { enabled } — the 20:00–04:00 ET overnight session (Blue Ocean ATS), Sunday–Thursday nights,
    // only before a trading day (NYSE holiday calendar; a full 8 hours even after a half-day).
    this.overnight = overnight && overnight.enabled ? overnight : null;
    this.fetchCalendar = fetchCalendar;
    this.fetchClock = fetchClock;
    this.alwaysOpen = alwaysOpen;
    this.coverage = coverage;
    this.days = new Map();
    this.source = 'estimated (weekdays, holidays unknown)';
    this.loadedAt = 0;
    this.loadedForDate = null;
    this.clock = null;
  }

  async load(nowMs = Date.now()) {
    if (!this.fetchCalendar) return false;
    const today = etDateStr(nowMs);
    const rows = await this.fetchCalendar(addDays(today, -14), addDays(today, 14));
    this.days.clear();
    for (const r of rows || []) {
      this.days.set(r.date, { open: r.open, close: r.close, pre: r.session_open || '0400', post: r.session_close || '2000' });
    }
    if (this.days.size) this.source = 'Alpaca trading calendar';
    this.loadedAt = nowMs;
    this.loadedForDate = today;
    return true;
  }

  /** Fetch the official market clock. Returns the parsed clock (also stored) or throws. */
  async syncClock(nowMs = Date.now(), wallNow = () => Date.now()) {
    if (!this.fetchClock) return null;
    const t0 = wallNow();
    const c = await this.fetchClock();
    const t1 = wallNow();
    if (!c || typeof c.is_open !== 'boolean') throw new Error('unexpected /v2/clock response');
    const serverTs = Date.parse(c.timestamp);
    const localMid = (t0 + t1) / 2;
    this.clock = {
      isOpen: c.is_open,
      nextOpenMs: Date.parse(c.next_open),
      nextCloseMs: Date.parse(c.next_close),
      serverTs: Number.isFinite(serverTs) ? serverTs : null,
      // positive = local clock ahead of Alpaca's server clock (request latency adds ±(t1-t0)/2)
      skewMs: Number.isFinite(serverTs) ? Math.round(localMid - serverTs) : null,
      latencyMs: t1 - t0,
      fetchedAt: nowMs,
      source: 'Alpaca /v2/clock',
    };
    return this.clock;
  }

  /** What the clock says *now*, while its snapshot is still valid (until its next open/close). */
  clockState(nowMs) {
    const c = this.clock;
    if (!c) return null;
    if (c.isOpen && Number.isFinite(c.nextCloseMs) && nowMs < c.nextCloseMs) return 'OPEN';
    if (!c.isOpen && Number.isFinite(c.nextOpenMs) && nowMs < c.nextOpenMs) return 'CLOSED';
    return null; // outdated: a boundary passed since the clock was fetched
  }

  dayInfo(dateStr) {
    if (this.days.size) {
      const d = this.days.get(dateStr);
      if (d) return { ...d, isTradingDay: true, estimated: false };
      const wd = weekdayOf(dateStr);
      return { isTradingDay: false, estimated: false, reason: wd === 0 || wd === 6 ? 'Weekend' : 'Market holiday (Alpaca calendar)' };
    }
    const wd = weekdayOf(dateStr);
    const trading = wd >= 1 && wd <= 5;
    return trading ? { open: '09:30', close: '16:00', pre: '0400', post: '2000', isTradingDay: true, estimated: true } : { isTradingDay: false, estimated: true, reason: 'Weekend' };
  }

  /** Session boundaries of one exchange date (DST-safe), or null when it is not a trading day. */
  dayBounds(dateStr) {
    const d = this.dayInfo(dateStr);
    if (!d.isTradingDay) return null;
    return { dateStr, openMs: at(dateStr, d.open), closeMs: at(dateStr, d.close), preMs: at(dateStr, d.pre), postMs: at(dateStr, d.post), estimated: !!d.estimated, earlyClose: d.close.replace(':', '') !== '1600' };
  }

  /** Window of a trading day in which the configured data feed is expected to carry data. */
  feedWindow(dateStr, d) {
    const openMs = at(dateStr, d.open); const closeMs = at(dateStr, d.close);
    const preMs = at(dateStr, d.pre); const postMs = at(dateStr, d.post);
    const cov = this.coverage;
    if (!cov) return { startMs: preMs, endMs: postMs };
    const covPre = cov.preOpen ? at(dateStr, cov.preOpen) : preMs;
    const startMs = Math.min(openMs, Math.max(preMs, covPre));
    const covEnd = cov.postMinutesAfterClose != null ? closeMs + cov.postMinutesAfterClose * 60000 : postMs;
    const endMs = Math.max(closeMs, Math.min(postMs, covEnd));
    return { startMs, endMs };
  }

  info(nowMs = Date.now()) {
    const feedName = this.coverage ? this.coverage.name : 'feed';
    if (this.alwaysOpen === 'CRYPTO') {
      return {
        session: 'REGULAR', marketStatus: 'OPEN 24/7', dateStr: etDateStr(nowMs), isTradingDay: true, estimated: false,
        source: 'crypto market, always open', feed: { active: true, name: 'ALPACA CRYPTO', note: 'single venue' }, clock: null,
      };
    }
    if (this.alwaysOpen) {
      return {
        session: 'REGULAR', marketStatus: 'OPEN (DEMO)', dateStr: etDateStr(nowMs), isTradingDay: true, estimated: false,
        source: 'DEMO — synthetic market, always open', feed: { active: true, name: 'DEMO', note: 'synthetic' }, clock: null,
      };
    }
    const dateStr = etDateStr(nowMs);
    const d = this.dayInfo(dateStr);
    const clockState = this.clockState(nowMs);
    const clock = this.clock ? { ...this.clock, state: clockState, outdated: clockState == null } : null;
    const base = { dateStr, isTradingDay: d.isTradingDay, estimated: d.estimated, source: this.source, clock };
    const nextOpenMs = this.nextOpen(nowMs);
    const nextFeedOpenMs = this.nextFeedOpen(nowMs);
    const feedOff = (reason) => ({ active: false, name: feedName, reason, note: this.coverage ? this.coverage.note : null, nextStartMs: nextFeedOpenMs });

    const on = this.overnightAt(nowMs, dateStr);
    if (on) {
      return { ...base, session: 'OVERNIGHT', marketStatus: 'OVERNIGHT', reason: 'Overnight session (Blue Ocean ATS, 20:00–04:00 ET)', overnight: on, nextOpenMs, nextFeedOpenMs, feed: feedOff(`no ${feedName} data in the overnight session`) };
    }
    if (!d.isTradingDay) {
      return { ...base, session: 'CLOSED', marketStatus: 'CLOSED', reason: d.reason || 'Not a trading day', nextOpenMs, nextFeedOpenMs, feed: feedOff(d.reason || 'Not a trading day') };
    }
    const openMs = at(dateStr, d.open); const closeMs = at(dateStr, d.close);
    const preMs = at(dateStr, d.pre); const postMs = at(dateStr, d.post);
    const fw = this.feedWindow(dateStr, d);
    const out = {
      ...base, regularOpenMs: openMs, regularCloseMs: closeMs, preOpenMs: preMs, postCloseMs: postMs, earlyClose: d.close.replace(':', '') !== '1600',
      feedStartMs: fw.startMs, feedEndMs: fw.endMs,
    };
    let session;
    if (nowMs >= openMs && nowMs < closeMs) session = 'REGULAR';
    else if (nowMs >= preMs && nowMs < openMs) session = 'PRE';
    else if (nowMs >= closeMs && nowMs < postMs) session = 'POST';
    else session = 'CLOSED';
    let reason = session === 'CLOSED' ? (nowMs < preMs ? 'Before pre-market' : 'After the extended-hours session') : null;

    // The official clock overrides the calendar for the regular session (e.g. an unscheduled closure).
    let clockOverride = null;
    if (clockState === 'CLOSED' && session === 'REGULAR') { session = 'CLOSED'; reason = 'Alpaca market clock reports the market closed'; clockOverride = 'closed'; }
    if (clockState === 'OPEN' && session !== 'REGULAR') { session = 'REGULAR'; reason = null; clockOverride = 'open'; }

    const marketStatus = { REGULAR: 'OPEN', PRE: 'PRE-MARKET', POST: 'AFTER-HOURS', CLOSED: 'CLOSED' }[session];
    let feed;
    if (session === 'REGULAR') feed = { active: true, name: feedName, note: this.coverage ? this.coverage.note : null };
    else if (session === 'CLOSED') feed = feedOff(reason);
    else if (nowMs >= fw.startMs && nowMs < fw.endMs) feed = { active: true, name: feedName, note: this.coverage ? this.coverage.note : null, endsMs: session === 'POST' ? fw.endMs : null };
    else {
      const why = session === 'PRE'
        ? `${feedName} pre-market starts ${etTimeStr(fw.startMs, false)} ET`
        : `${feedName} post-market ended ${etTimeStr(fw.endMs, false)} ET`;
      feed = feedOff(why);
    }
    return { ...out, session, marketStatus, reason, clockOverride, nextOpenMs: session === 'REGULAR' ? null : nextOpenMs, nextFeedOpenMs, feed };
  }

  /**
   * Overnight session covering nowMs, or null. It runs 20:00 ET on day D to 04:00 ET on D+1 and exists only
   * when D+1 is a trading day (so Sunday night yes, Friday/Saturday nights and holiday eves no).
   */
  overnightAt(nowMs, dateStr = etDateStr(nowMs)) {
    if (!this.overnight || this.alwaysOpen) return null;
    const startToday = at(dateStr, '20:00');
    const next = addDays(dateStr, 1);
    if (nowMs >= startToday && this.dayInfo(next).isTradingDay) return { startMs: startToday, endMs: at(next, '04:00'), tradeDate: next };
    const endToday = at(dateStr, '04:00');
    if (nowMs < endToday && this.dayInfo(dateStr).isTradingDay) return { startMs: at(addDays(dateStr, -1), '20:00'), endMs: endToday, tradeDate: dateStr };
    return null;
  }

  /** Next regular-session open (the clock's value when it is valid). */
  nextOpen(nowMs) {
    if (this.clock && !this.clock.isOpen && this.clockState(nowMs) === 'CLOSED') return this.clock.nextOpenMs;
    let ds = etDateStr(nowMs);
    for (let i = 0; i < 12; i++) {
      const d = this.dayInfo(ds);
      if (d.isTradingDay) {
        const t = at(ds, d.open);
        if (t > nowMs) return t;
      }
      ds = addDays(ds, 1);
    }
    return null;
  }

  /** Next time the configured feed is expected to start carrying data. */
  nextFeedOpen(nowMs) {
    let ds = etDateStr(nowMs);
    for (let i = 0; i < 12; i++) {
      const d = this.dayInfo(ds);
      if (d.isTradingDay) {
        const fw = this.feedWindow(ds, d);
        if (fw.startMs > nowMs) return fw.startMs;
      }
      ds = addDays(ds, 1);
    }
    return null;
  }

  /** Most recent trading date whose pre-market has started (used for the intraday live window). */
  liveWindowDate(nowMs) {
    let ds = etDateStr(nowMs);
    for (let i = 0; i < 10; i++) {
      const d = this.dayInfo(ds);
      if (d.isTradingDay && at(ds, d.pre || '0400') <= nowMs) return ds;
      ds = addDays(ds, -1);
    }
    return etDateStr(nowMs);
  }

  minutesSinceRegularOpen(nowMs) {
    const i = this.info(nowMs);
    if (!i.regularOpenMs) return null;
    return (nowMs - i.regularOpenMs) / 60000;
  }
}

function etHourMinute(ms) { const p = etParts(ms); return p.hour * 60 + p.minute; }

module.exports = { MarketCalendar, etHourMinute };
