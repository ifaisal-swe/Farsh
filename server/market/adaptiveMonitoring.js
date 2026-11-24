'use strict';
const { isCrypto } = require('./crypto');
/**
 * Adaptive market monitoring — one coordinator for the whole desk.
 *
 * Layer 1 (local, no AI): the session mode (from the exchange calendar), per-symbol volatility / volume /
 * momentum metrics, opening range, breakouts, false breakouts, reversals. It runs inside the engine's
 * existing 1-second tick and on completed 1-minute candles of the existing stream: no extra timers, sockets,
 * polling loops or processes.
 *
 * Layer 2 (AI): a meaningful event gets an explainable priority score and enters a small bounded queue. The
 * best events are handed to the EXISTING per-symbol AI scheduler, which keeps applying every existing rule
 * (usage mode, per-symbol and daily limits, budgets, cache, provider selection and fallback).
 *
 * This module never trades, never changes a risk limit, never starts or resumes AI trading and never treats
 * a reference / indicative price as a market price. Its only effect on trading is a restriction: no NEW
 * entries in the last minutes before the close (configurable). The priority score is an attention score, not
 * a probability of profit.
 */
const Ind = require('../analysis/indicators');
const { sessionLevels } = require('../analysis/structure');
const { etDateStr, etTimeStr, etWallToUtcMs, addDays, TIMEFRAMES } = require('../util/time');

const MODE = Object.freeze({
  PRE: 'PRE_MARKET_PREPARATION', OPENING: 'OPENING_INTENSIVE', POST_OPEN: 'POST_OPEN_ACTIVE', NORMAL: 'NORMAL_SESSION',
  HIGH_VOL: 'HIGH_VOLATILITY', CLOSING: 'CLOSING_INTENSIVE', AFTER: 'AFTER_HOURS', CLOSED: 'MARKET_CLOSED',
});
/** Regular-session modes: the only ones in which events, overrides and AI requests are possible. */
const REGULAR_MODES = new Set([MODE.OPENING, MODE.POST_OPEN, MODE.NORMAL, MODE.CLOSING]);

/**
 * evalSec: how often the forming candle is inspected locally. minScoreDelta / cooldownFactor tune how easily
 * an event may ask for an AI analysis. reserve: keep part of the symbol's hourly AI quota for events.
 */
const PROFILES = {
  [MODE.PRE]: { intensity: 'ELEVATED', evalSec: 30, ai: false, reserve: false, timing: 0 },
  [MODE.OPENING]: { intensity: 'MAXIMUM', evalSec: 5, ai: true, minScoreDelta: -5, cooldownFactor: 0.75, reserve: true, timing: 10 },
  [MODE.POST_OPEN]: { intensity: 'HIGH', evalSec: 10, ai: true, minScoreDelta: 0, cooldownFactor: 1, reserve: true, timing: 7 },
  [MODE.NORMAL]: { intensity: 'NORMAL', evalSec: 30, ai: true, minScoreDelta: 5, cooldownFactor: 1.5, reserve: false, timing: 3 },
  [MODE.HIGH_VOL]: { intensity: 'MAXIMUM', evalSec: 5, ai: true, minScoreDelta: -5, cooldownFactor: 0.75, reserve: true, timing: 8 },
  [MODE.CLOSING]: { intensity: 'HIGH', evalSec: 10, ai: true, minScoreDelta: 0, cooldownFactor: 1, reserve: true, timing: 10 },
  [MODE.AFTER]: { intensity: 'LOW', evalSec: 60, ai: false, reserve: false, timing: 0 },
  [MODE.CLOSED]: { intensity: 'IDLE', evalSec: 300, ai: false, reserve: false, timing: 0 },
};

const DEFAULTS = Object.freeze({
  enabled: true, preMarketMin: 30, openingMin: 30, postOpenMin: 60, closingMin: 30, noNewEntriesLastMin: 10, closingPositionReview: true,
  followerCandleClose: false,
  volatility: { enterRatio: 2.5, exitRatio: 1.4, confirmBars: 2, exitBars: 5, minActiveMin: 5, cooldownMin: 10, openingFactor: 1.5, marketMovePct: 0.5 },
  events: { confirmBars: 2, requireVolumeConfirmation: true, volumeConfirm: 1.5, volumeSpike: 3, moveZ: 3, breakoutBufferAtr: 0.1, gapAtr: 0.5, ttlSec: 300 },
  ai: { minScore: 60, highPriorityScore: 75, symbolCooldownSec: 240, maxPerSymbolPerDay: 12, maxPerDay: 60, maxQueued: 2, reserveSymbolRequests: 2, budgetReservePct: 10, enforceBudget: true },
});

/** Event types with their base attention weight (0–15) and an English label (the UI translates it). */
const EVENTS = {
  OPENING_RANGE_BREAKOUT: { base: 14, label: 'Opening-range breakout' },
  OPENING_RANGE_BREAKDOWN: { base: 14, label: 'Opening-range breakdown' },
  LEVEL_BREAKOUT: { base: 11, label: 'Resistance breakout' },
  LEVEL_BREAKDOWN: { base: 11, label: 'Support breakdown' },
  END_OF_DAY_BREAKOUT: { base: 11, label: 'Late-session breakout' },
  END_OF_DAY_BREAKDOWN: { base: 11, label: 'Late-session breakdown' },
  FALSE_BREAKOUT: { base: 13, label: 'False breakout' },
  REVERSAL: { base: 13, label: 'Rapid reversal' },
  LATE_REVERSAL: { base: 13, label: 'Late-session reversal' },
  RAPID_MOVE: { base: 9, label: 'Rapid price move' },
  MOMENTUM_ACCELERATION: { base: 7, label: 'Momentum acceleration' },
  TREND_CHANGE: { base: 8, label: 'Short-term trend change' },
  VOLUME_SPIKE: { base: 5, label: 'Volume spike' },
  GAP_OPEN: { base: 10, label: 'Opening gap' },
  CLOSING_POSITION_REVIEW: { base: 12, label: 'Closing review of an open position' },
};

const QUEUE_MAX = 40;
const QUEUE_MAX_PER_SYMBOL = 5;
const RECENT_MAX = 60;
/** Symbols close the same minute within a second of each other: wait for all of them, then rank. */
const SETTLE_MS = 1500;
const SETTINGS_KEY = 'monitor.state';
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Settings with defaults for anything missing (old stored configurations stay valid). */
function adaptiveCfg(cfg) {
  const a = (cfg && cfg.adaptiveMonitoring) || {};
  const volatility = { ...DEFAULTS.volatility, ...(a.volatility || {}) };
  const ai = { ...DEFAULTS.ai, ...(a.ai || {}) };
  volatility.exitRatio = Math.min(volatility.exitRatio, volatility.enterRatio * 0.9); // hysteresis always exists, whatever is configured
  ai.highPriorityScore = Math.max(ai.highPriorityScore, ai.minScore);
  return { ...DEFAULTS, ...a, volatility, events: { ...DEFAULTS.events, ...(a.events || {}) }, ai };
}

// ------------------------------------------------------------------ session mode
/** Regular close that applies now: the official clock wins over the calendar (unscheduled early close). */
function effectiveCloseMs(si) {
  const clk = si && si.clock;
  if (clk && clk.state === 'OPEN' && isNum(clk.nextCloseMs)) return clk.nextCloseMs;
  return si ? si.regularCloseMs : null;
}

/** Underlying session mode for a calendar `info()` object. Pure: depends only on its arguments. */
function sessionMode(si, now, c = DEFAULTS) {
  if (!si) return { mode: MODE.CLOSED, reason: 'no session information' };
  if (si.session === 'REGULAR') {
    const open = si.regularOpenMs;
    const close = effectiveCloseMs(si);
    if (!isNum(open) || !isNum(close)) return { mode: MODE.NORMAL, reason: 'continuous session' };
    const sinceOpen = (now - open) / 60000;
    const toClose = (close - now) / 60000;
    if (sinceOpen >= 0 && sinceOpen < c.openingMin) return { mode: MODE.OPENING, reason: `first ${c.openingMin} minutes after the open` };
    if (toClose > 0 && toClose <= c.closingMin) return { mode: MODE.CLOSING, reason: `last ${c.closingMin} minutes before the close` };
    if (sinceOpen >= 0 && sinceOpen < c.openingMin + c.postOpenMin) return { mode: MODE.POST_OPEN, reason: `${c.openingMin}–${c.openingMin + c.postOpenMin} minutes after the open` };
    return { mode: MODE.NORMAL, reason: 'regular session' };
  }
  if (si.session === 'PRE') {
    const toOpen = isNum(si.regularOpenMs) ? (si.regularOpenMs - now) / 60000 : Infinity;
    if (toOpen > 0 && toOpen <= c.preMarketMin) return { mode: MODE.PRE, reason: `last ${c.preMarketMin} minutes before the open` };
    return { mode: MODE.AFTER, reason: 'extended hours before the preparation window' };
  }
  if (si.session === 'POST') return { mode: MODE.AFTER, reason: 'after-hours session' };
  if (si.session === 'OVERNIGHT') return { mode: MODE.AFTER, reason: 'overnight session (reference data only)' };
  return { mode: MODE.CLOSED, reason: si.reason || 'market closed' };
}

/** Next scheduled change of the underlying mode (exchange calendar; handles weekends, holidays, early closes, DST). */
function nextTransition(calendar, now, c = DEFAULTS) {
  if (!calendar || calendar.alwaysOpen || !calendar.dayBounds) return null;
  const cur = sessionMode(calendar.info(now), now, c).mode;
  const today = etDateStr(now);
  for (let i = 0; i < 11; i++) {
    const date = addDays(today, i);
    const b = calendar.dayBounds(date);
    const times = [etWallToUtcMs(date, 20, 0)]; // the overnight session may start on any evening, e.g. Sunday
    if (b) {
      let close = b.closeMs;
      const si = i === 0 ? calendar.info(now) : null;
      if (si && si.session === 'REGULAR' && isNum(effectiveCloseMs(si))) close = effectiveCloseMs(si);
      times.push(b.preMs, b.openMs - c.preMarketMin * 60000, b.openMs, b.openMs + c.openingMin * 60000, b.openMs + (c.openingMin + c.postOpenMin) * 60000, close - c.closingMin * 60000, close, b.postMs);
    }
    for (const t of times.filter((x) => isNum(x) && x > now).sort((x, y) => x - y)) {
      const m = sessionMode(calendar.info(t), t, c).mode;
      if (m !== cur) return { at: t, mode: m };
    }
  }
  return null;
}

/**
 * Reason why a NEW entry must not be opened now (last minutes before the close), or null. A restriction on
 * top of the risk engine — it can only block, never allow.
 */
function closingEntryBlock(si, now, c) {
  if (!c.enabled || !(c.noNewEntriesLastMin > 0) || !si || si.session !== 'REGULAR') return null;
  const close = effectiveCloseMs(si);
  if (!isNum(close)) return null;
  const left = (close - now) / 60000;
  return left > 0 && left <= c.noNewEntriesLastMin ? `New positions are not opened in the last ${c.noNewEntriesLastMin} minutes before the close` : null;
}

// ------------------------------------------------------------------ local metrics (1-minute candles)
const trOf = (b, prev) => (prev ? Math.max(b.high, prev.close) - Math.min(b.low, prev.close) : b.high - b.low);

/**
 * Typical 1-minute true range and volume from EARLIER sessions, separately for the opening window and the
 * rest of the day — the open is always more volatile, so it is compared with earlier opens.
 */
function buildBaseline(bars, boundsOf, todayStr, openingMin) {
  const open = { tr: [], vol: [] };
  const gen = { tr: [], vol: [] };
  let prev = null;
  let prevDate = null;
  for (const b of bars) {
    const d = etDateStr(b.time * 1000);
    if (d >= todayStr) break;
    const bd = boundsOf(d);
    const t = b.time * 1000;
    if (!bd || t < bd.openMs || t >= bd.closeMs) { prev = null; continue; }
    const tr = trOf(b, prev && prevDate === d ? prev : null);
    const g = t - bd.openMs < openingMin * 60000 ? open : gen;
    g.tr.push(tr); g.vol.push(b.volume || 0);
    prev = b; prevDate = d;
  }
  return {
    openTr: open.tr.length >= 20 ? median(open.tr) : null, openVol: open.vol.length >= 20 ? median(open.vol) : null,
    genTr: gen.tr.length >= 40 ? median(gen.tr) : null, genVol: gen.vol.length >= 40 ? median(gen.vol) : null,
  };
}

/** 1-minute scale estimated from a higher timeframe (true range grows with the square root of time). */
function scaledBaseline(bars, tfSec, boundsOf, todayStr) {
  const tr = []; const vol = [];
  let prev = null;
  for (const b of bars || []) {
    const d = etDateStr(b.time * 1000);
    if (d >= todayStr) break;
    const bd = boundsOf(d);
    const t = b.time * 1000;
    if (!bd || t < bd.openMs || t >= bd.closeMs) { prev = null; continue; }
    tr.push(trOf(b, prev)); vol.push(b.volume || 0);
    prev = b;
  }
  if (tr.length < 12 || !(tfSec > 60)) return { tr: null, vol: null };
  return { tr: median(tr) / Math.sqrt(tfSec / 60), vol: median(vol) / (tfSec / 60) };
}

/**
 * Volatility-normalised metrics of today's completed regular-session minutes. Moves are expressed in
 * approximate standard deviations of the symbol's own typical movement, never in fixed percentages.
 */
function computeMetrics(T, base, { inOpening, openingFactor = 1.5, scaled = null } = {}) {
  const n = T.length;
  if (!n) return null;
  let trBase = null;
  let quality = null;
  let note = null;
  if (inOpening && base.openTr > 0) { trBase = base.openTr; quality = 1; note = 'earlier opening sessions'; }
  else if (base.genTr > 0) { trBase = base.genTr * (inOpening ? openingFactor : 1); quality = inOpening ? 0.9 : 1; note = 'earlier sessions'; }
  else if (scaled && scaled.tr > 0) { trBase = scaled.tr * (inOpening ? openingFactor : 1); quality = 0.85; note = 'scaled from a higher timeframe'; }
  else if (n >= 20) {
    const trs = T.slice(0, n - 5).map((b, i) => trOf(b, i ? T[i - 1] : null));
    trBase = median(trs); quality = 0.8; note = 'earlier today';
  }
  if (!(trBase > 0)) return { bars: n, available: false, note: 'not enough history for a volatility baseline', close: T[n - 1].close };
  const last = T[n - 1];
  const lastTr = T.slice(-3).map((b, i, a) => trOf(b, i ? a[i - 1] : (n > a.length ? T[n - a.length - 1] : null)));
  const z = (k, end = n - 1) => {
    if (end < 0) return null;
    const from = end - k;
    const ref = from >= 0 ? T[from].close : T[0].open;
    const len = from >= 0 ? k : end + 1;
    return (T[end].close - ref) / ((trBase * Math.sqrt(len)) / 1.6);
  };
  let volBase = null;
  if (inOpening) volBase = base.openVol || (base.genVol ? base.genVol * 2 : null);
  else if (n >= 21) volBase = mean(T.slice(-21, -1).map((b) => b.volume || 0));
  else volBase = base.genVol;
  if (!(volBase > 0) && scaled && scaled.vol > 0) volBase = scaled.vol * (inOpening ? 2 : 1);
  if (!(volBase > 0) && n >= 6) volBase = mean(T.slice(0, n - 1).map((b) => b.volume || 0));
  const w = T.slice(-21);
  let path = 0;
  for (let i = 1; i < w.length; i++) path += Math.abs(w[i].close - w[i - 1].close);
  const net = w.length > 1 ? w[w.length - 1].close - w[0].close : 0;
  const closes = T.map((b) => b.close);
  const e9 = Ind.ema(closes, 9); const e21 = Ind.ema(closes, 21);
  const cross = n >= 22 && isNum(e9[n - 2]) && isNum(e21[n - 2]) ? Math.sign(e9[n - 1] - e21[n - 1]) !== Math.sign(e9[n - 2] - e21[n - 2]) : false;
  const z3 = z(3); const z3p = n > 3 ? z(3, n - 4) : null;
  return {
    available: true, bars: n, close: last.close, trBase, quality, note,
    volRatio: mean(lastTr) / trBase, barRatio: lastTr[lastTr.length - 1] / trBase, relVol: volBase > 0 ? (last.volume || 0) / volBase : null,
    z1: z(1), z5: z(5), z10: z(10), z3, accel: isNum(z3) && isNum(z3p) ? z3 - z3p : null,
    efficiency: path > 0 ? clamp01(Math.abs(net) / path) : 0, trendDir: Math.sign(net), emaCross: cross ? Math.sign(e9[n - 1] - e21[n - 1]) : 0,
    dayHigh: Math.max(...T.map((b) => b.high)), dayLow: Math.min(...T.map((b) => b.low)),
  };
}

// ------------------------------------------------------------------ priority score
/**
 * Explainable attention score (0–100): why an event deserves an analysis now. It says nothing about the
 * direction or profitability of a trade and grants no permission of any kind.
 */
function scoreEvent(e, m, { profile, held = null, pending = false, ageMs = 0, ttlMs = 300000, quality = 1 } = {}) {
  const dir = e.dir || 0;
  const mz = Math.abs(isNum(e.moveZ) ? e.moveZ : (m && isNum(m.z5) ? m.z5 : 0));
  const aligned = m && dir && m.trendDir === dir;
  const comp = {
    event: (EVENTS[e.type] || { base: 5 }).base,
    move: 20 * clamp01(mz / 4),
    volume: m && isNum(m.relVol) ? 20 * clamp01((m.relVol - 1) / 4) : 0,
    volatility: m && isNum(m.volRatio) ? 10 * clamp01((m.volRatio - 1) / 3) : 0,
    trend: m && aligned ? 10 * m.efficiency : 0,
    confirmation: e.confirmed ? 15 : 5,
    exposure: held ? (dir < 0 ? 10 : 7) : (pending ? 4 : 0),
    timing: (profile && profile.timing) || 0,
  };
  const raw = Math.min(100, Object.values(comp).reduce((s, x) => s + x, 0));
  const freshness = 1 - 0.5 * clamp01(ageMs / Math.max(1, ttlMs));
  const q = clamp01(quality);
  const breakdown = Object.fromEntries(Object.entries(comp).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { score: Math.round(raw * freshness * q), raw: Math.round(raw), breakdown, freshness: Math.round(freshness * 100) / 100, quality: Math.round(q * 100) / 100 };
}

// ------------------------------------------------------------------ event detection (one completed minute)
/**
 * Detects events on the newest completed regular-session minute. `st` keeps unconfirmed breaks and recent
 * breakouts between calls. Only completed candles are used: nothing is predicted and nothing repaints.
 */
function detectEvents(st, T, m, { levels = [], c, now, mode, gap = null }) {
  const out = [];
  const n = T.length;
  if (!n || !m || !m.available) return out;
  const b = T[n - 1];
  const p = n > 1 ? T[n - 2] : null;
  const ev = c.events;
  const buf = ev.breakoutBufferAtr * m.trBase;
  const relVol = isNum(m.relVol) ? m.relVol : 0;
  const bucket = (min) => Math.floor(now / (min * 60000));
  const push = (e) => out.push({ at: now, barTime: b.time, price: b.close, ...e });

  // gap (once per day, on the first completed minute)
  if (n <= 2 && gap && isNum(gap.atr) && Math.abs(gap.atr) >= ev.gapAtr) {
    push({ type: 'GAP_OPEN', dir: Math.sign(gap.atr), level: gap.prevClose, confirmed: true, moveZ: gap.atr * 3, key: 'gap', detail: `${gap.pct >= 0 ? '+' : ''}${gap.pct.toFixed(2)}% vs the previous close (${Math.abs(gap.atr).toFixed(1)} daily ATR)` });
  }

  // breakouts of reference levels: cross on a closing basis, then confirmation by volume or by further closes
  for (const L of levels) {
    const up = L.dir > 0;
    const beyond = up ? b.close > L.price + buf : b.close < L.price - buf;
    const still = up ? b.close > L.price : b.close < L.price;
    const before = p ? (up ? p.close <= L.price : p.close >= L.price) : false;
    let pend = st.pending[L.key];
    if (pend && Math.abs(pend.price - L.price) > buf + 1e-9) { delete st.pending[L.key]; pend = null; }
    if (!pend && before && beyond && !(st.breaks[L.key] && st.breaks[L.key].price === L.price)) {
      pend = st.pending[L.key] = { price: L.price, closes: 0, maxRelVol: 0, firstTime: b.time };
    }
    if (!pend) continue;
    if (!still) { delete st.pending[L.key]; st.noise++; continue; } // closed back: market noise, not a signal
    if (pend.lastTime !== b.time) { pend.closes++; pend.lastTime = b.time; }
    pend.maxRelVol = Math.max(pend.maxRelVol, relVol);
    const fast = pend.maxRelVol >= ev.volumeConfirm && beyond;
    const slow = pend.closes >= ev.confirmBars && (!ev.requireVolumeConfirmation || pend.maxRelVol >= 1);
    if (!fast && !slow) continue;
    delete st.pending[L.key];
    st.breaks[L.key] = { price: L.price, dir: L.dir, at: now, label: L.label };
    push({ type: L.type, dir: L.dir, level: L.price, confirmed: true, key: `${L.key}:${L.price.toFixed(2)}`, detail: `close ${b.close.toFixed(2)} ${up ? 'above' : 'below'} ${L.label} ${L.price.toFixed(2)}, ${pend.maxRelVol > 0 ? `relative volume ${pend.maxRelVol.toFixed(1)}x` : 'no volume baseline'}` });
  }

  // false breakouts: back inside within 15 minutes of a confirmed breakout
  for (const [key, x] of Object.entries(st.breaks)) {
    if (now - x.at > 15 * 60000) { if (now - x.at > 60 * 60000) delete st.breaks[key]; continue; }
    const back = x.dir > 0 ? b.close < x.price - buf : b.close > x.price + buf;
    if (!back) continue;
    delete st.breaks[key];
    push({ type: 'FALSE_BREAKOUT', dir: -x.dir, level: x.price, confirmed: true, key: `${key}:${x.price.toFixed(2)}:${bucket(30)}`, detail: `close ${b.close.toFixed(2)} back ${x.dir > 0 ? 'below' : 'above'} ${x.label} ${x.price.toFixed(2)}` });
  }

  // rapid move / acceleration
  if (isNum(m.z5) && Math.abs(m.z5) >= ev.moveZ) {
    const dir = Math.sign(m.z5);
    push({ type: 'RAPID_MOVE', dir, confirmed: relVol >= ev.volumeConfirm || Math.abs(m.z10 || 0) >= ev.moveZ, key: `${dir}:${bucket(15)}`, detail: `${m.z5 > 0 ? '+' : '−'}${Math.abs(m.z5).toFixed(1)}σ in 5 minutes` });
  }
  if (isNum(m.accel) && Math.abs(m.accel) >= ev.moveZ && Math.sign(m.accel) === Math.sign(m.z3) && Math.abs(m.z3) >= ev.moveZ * 0.6) {
    const dir = Math.sign(m.accel);
    push({ type: 'MOMENTUM_ACCELERATION', dir, confirmed: relVol >= ev.volumeConfirm, key: `${dir}:${bucket(15)}`, detail: `3-minute momentum changed by ${Math.abs(m.accel).toFixed(1)}σ` });
  }

  // rapid reversal: a strong run within the last 10 minutes of which at least 60% was given back in ≤5 minutes
  if (n >= 8) {
    const w = T.slice(-11);
    const start = w[0].close;
    let hi = 0; let lo = 0;
    w.forEach((x, i) => { if (x.close > w[hi].close) hi = i; if (x.close < w[lo].close) lo = i; });
    const lastI = w.length - 1;
    const test = (k, dir) => {
      if (k === 0 || k === lastI || lastI - k > 5) return;
      const run = (w[k].close - start) * dir;
      const runZ = run / ((m.trBase * Math.sqrt(k)) / 1.6);
      const back = (w[k].close - b.close) * dir;
      if (runZ >= 2.5 && back >= 0.6 * run) push({ type: mode === MODE.CLOSING ? 'LATE_REVERSAL' : 'REVERSAL', dir: -dir, confirmed: relVol >= 1 || back >= run, moveZ: runZ, key: `${-dir}:${bucket(20)}`, detail: `${runZ.toFixed(1)}σ ${dir > 0 ? 'advance' : 'decline'} with ${Math.round((back / run) * 100)}% given back in ${lastI - k} min` });
    };
    test(hi, 1); test(lo, -1);
  }
  if (m.emaCross && isNum(m.z10) && Math.abs(m.z10) >= 1.5 && m.efficiency >= 0.4) {
    push({ type: 'TREND_CHANGE', dir: m.emaCross, confirmed: relVol >= 1, key: `${m.emaCross}:${bucket(30)}`, detail: 'EMA9/EMA21 crossed on 1-minute candles' });
  }
  // a spike is a NEW surge; sustained high volume is not reported again and again
  if (relVol >= ev.volumeSpike && !(p && (p.volume || 0) * 1.5 > (b.volume || 0))) push({ type: 'VOLUME_SPIKE', dir: Math.sign(m.z1 || 0), confirmed: Math.abs(m.z1 || 0) >= 1, key: `${bucket(10)}`, detail: `1-minute volume ${relVol.toFixed(1)}x the typical minute` });
  return out;
}

/** Levels that lie (almost) at the same price are one level: keep the first (most relevant) of them. */
function dedupeLevels(levels, tol) {
  const out = [];
  for (const L of levels) if (isNum(L.price) && !out.some((x) => x.dir === L.dir && Math.abs(x.price - L.price) <= tol)) out.push(L);
  return out;
}

const newSymbolState = () => ({
  baseline: null, baselineKey: null, metrics: null, pending: {}, breaks: {}, noise: 0, lastBarTime: 0, lastBarAt: 0, lastEvalAt: 0, warmed: false,
  override: { active: false, since: null, reason: null, above: 0, below: 0, cooldownUntil: 0, shock: 0 },
  lastDispatchAt: 0, lastDispatchScore: 0, lastTradableAt: 0, staleSince: null, data: null, levels: [], range: null, prep: null, lastEvent: null,
});

// ------------------------------------------------------------------ coordinator
class AdaptiveMonitor {
  /** @param {object} o { desk, store, getCfg, activity, now } */
  constructor({ desk, store, getCfg, activity, now = () => Date.now() }) {
    this.desk = desk;
    this.store = store;
    this.getCfg = getCfg;
    this.activity = activity;
    this.now = now;
    this.symbols = new Map();
    this.queue = [];
    this.recent = [];
    this.base = { mode: null, since: null, reason: null };
    this.next = null;
    this.nextAt = 0;
    this.day = null;
    this.fired = {};
    this.dispatched = {};
    this.cooldowns = {};
    this.counters = AdaptiveMonitor.emptyCounters();
    this.market = { active: false, since: null, detail: null, above: 0, below: 0, samples: {} };
    this.seq = 0;
    this.saveAt = 0;
    this.dirty = false;
    this.lastErrorAt = 0;
    this.wasEnabled = null;
  }

  static emptyCounters() { return { events: 0, highPriority: 0, dispatched: 0, merged: 0, routineSkipped: 0, suppressed: {} }; }

  cfg() { return adaptiveCfg(this.getCfg()); }
  enabled() { return !!this.cfg().enabled; }
  sym(symbol) { let s = this.symbols.get(symbol); if (!s) { s = newSymbolState(); this.symbols.set(symbol, s); } return s; }
  profile(mode) { return PROFILES[mode] || PROFILES[MODE.CLOSED]; }
  paused() { return !!this.desk.book.monitoringPaused; }

  /** Mode that applies to one symbol: the underlying session mode, unless a volatility override is active. */
  symbolMode(symbol) {
    const base = isCrypto(symbol) ? MODE.NORMAL : this.base.mode; // crypto has no opening or closing phase
    if (!REGULAR_MODES.has(base)) return base || MODE.CLOSED;
    const st = this.symbols.get(symbol);
    return (st && st.override.active) || (this.market.active && !isCrypto(symbol)) ? MODE.HIGH_VOL : base; // a stock-market move is not a crypto move
  }
  /** Desk-wide mode for display. One volatile symbol does not change the mode of the others. */
  globalMode() { return this.market.active && REGULAR_MODES.has(this.base.mode) ? MODE.HIGH_VOL : (this.base.mode || MODE.CLOSED); }

  // ---------------------------------------------------------------- persistence (one row in `settings`; no schema change)
  load() {
    let s = null;
    try { s = this.store.getSetting(SETTINGS_KEY, null); } catch { s = null; }
    const day = etDateStr(this.now());
    this.day = day;
    if (!s || s.day !== day) return;
    // same trading day: events already handled before the restart are not repeated
    this.fired = s.fired && typeof s.fired === 'object' ? s.fired : {};
    this.dispatched = s.dispatched && typeof s.dispatched === 'object' ? s.dispatched : {};
    this.cooldowns = s.cooldowns && typeof s.cooldowns === 'object' ? s.cooldowns : {};
    this.counters = { ...AdaptiveMonitor.emptyCounters(), ...(s.counters || {}) };
    for (const [symbol, until] of Object.entries(this.cooldowns)) if (until > this.now()) this.sym(symbol).override.cooldownUntil = until;
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    const now = this.now();
    if (!force && now - this.saveAt < 10000) return;
    this.saveAt = now;
    this.dirty = false;
    try { this.store.setSetting(SETTINGS_KEY, { day: this.day, fired: this.fired, dispatched: this.dispatched, cooldowns: this.cooldowns, counters: this.counters, savedAt: now }); } catch { /* monitoring never depends on it */ }
  }

  rollDay(now) {
    const day = etDateStr(now);
    if (day === this.day) return;
    this.day = day;
    this.fired = {}; this.dispatched = {}; this.cooldowns = {};
    this.counters = AdaptiveMonitor.emptyCounters();
    this.queue = [];
    for (const st of this.symbols.values()) { st.pending = {}; st.breaks = {}; st.prep = null; st.range = null; st.warmed = false; st.metrics = null; st.lastDispatchScore = 0; }
    this.dirty = true;
  }

  count(reason, n = 1) { this.counters.suppressed[reason] = (this.counters.suppressed[reason] || 0) + n; this.dirty = true; }
  prevented() {
    const s = this.counters.suppressed;
    return ['cooldown', 'budget', 'symbol_cap', 'daily_cap', 'backpressure', 'ai_unavailable', 'busy'].reduce((t, k) => t + (s[k] || 0), 0) + this.counters.routineSkipped;
  }

  /** Monitoring must never break the engine: protective orders and risk checks run regardless of it. */
  guard(fn) {
    try { return fn(); } catch (e) {
      const now = this.now();
      if (now - this.lastErrorAt > 5 * 60000) { this.lastErrorAt = now; this.activity.error(`Adaptive monitoring error: ${e.message}`, { source: 'adaptive monitoring' }); }
      return null;
    }
  }

  // ---------------------------------------------------------------- engine hooks
  /** Called from the engine's existing 1-second tick of every symbol. */
  onTick(agent, now, si, ds) {
    this.guard(() => {
      const on = this.enabled();
      if (on !== this.wasEnabled) { if (this.wasEnabled !== null || !on) this.onEnabledChange(on); this.wasEnabled = on; }
      if (!on) return;
      if (agent.primary) { const s = this.desk.stockAgent ? this.desk.stockAgent() : agent; this.globalTick(agent, now, s && s !== agent && s.market ? s.sessionInfo() : si); }
      this.symbolTick(agent, now, si, ds);
      if (agent.primary) { this.dispatch(now); this.save(); }
    });
  }

  onEnabledChange(on) {
    this.queue = [];
    this.next = null; this.nextAt = 0;
    this.base = { mode: null, since: null, reason: null };
    for (const [symbol, st] of this.symbols) if (st.override.active) this.endOverride(symbol, st, 'adaptive monitoring disabled', this.now(), false);
    this.market.active = false;
    if (!on) this.activity.info('MARKET', 'Adaptive monitoring is disabled (Settings) — the standard monitoring behaviour applies', { source: 'adaptive monitoring' });
  }

  onConfigChange() { this.nextAt = 0; for (const st of this.symbols.values()) st.baselineKey = null; }

  globalTick(agent, now, si) {
    this.rollDay(now);
    const c = this.cfg();
    const live = new Set(this.desk.all().map((a) => a.symbol));
    for (const s of [...this.symbols.keys()]) if (!live.has(s)) this.symbols.delete(s);
    const b = sessionMode(si, now, c);
    if (b.mode !== this.base.mode) this.transition(b, now, si, c);
    else this.base.reason = b.reason;
    if (now >= this.nextAt) { this.next = nextTransition(agent.calendar, now, c); this.nextAt = this.next ? Math.min(this.next.at, now + 300000) : now + 300000; }
    this.marketWide(now, c);
  }

  transition(b, now, si, c) {
    const from = this.base.mode;
    this.base = { mode: b.mode, since: now, reason: b.reason };
    this.nextAt = 0;
    const p = this.profile(b.mode);
    this.activity.info('MARKET', from ? `Adaptive monitoring mode: ${from} → ${b.mode} (${p.intensity} intensity)` : `Adaptive monitoring active: ${b.mode} (${p.intensity} intensity)`, { source: 'adaptive monitoring' });
    if (!REGULAR_MODES.has(b.mode)) {
      for (const [symbol, st] of this.symbols) if (st.override.active) this.endOverride(symbol, st, 'regular session ended', now, false);
      if (this.market.active) this.market.active = false;
      for (const e of this.queue) this.finish(e, 'SUPPRESSED', 'session_ended');
      this.queue = [];
    }
    if (!this.paused()) {
      const notify = { [MODE.OPENING]: 1, [MODE.CLOSING]: 1, [MODE.NORMAL]: 1 }[b.mode] && from !== null;
      if (notify) this.desk.emitEvent('MONITORING_MODE', null, { from, to: b.mode, intensity: p.intensity }, 'low', `monmode:${this.day}:${b.mode}`);
      if (b.mode === MODE.PRE) for (const a of this.desk.all()) this.prepare(a, now);
      if (b.mode === MODE.OPENING && from !== null) this.logWatchlist();
      if (b.mode === MODE.CLOSING) this.closingReview(now, c);
    }
    for (const a of this.desk.all()) a.markDirty();
  }

  // ---------------------------------------------------------------- pre-market preparation (no AI calls)
  prepare(agent, now) {
    const key = `${agent.symbol}|prep`;
    if (this.fired[key]) return;
    this.fired[key] = now; this.dirty = true;
    const si = agent.market ? agent.sessionInfo() : null;
    // one REST backfill per symbol and day so the preparation starts from complete minutes
    if (agent.dataMode === 'LIVE' && si && si.feed && si.feed.active && agent.market.connection.state === 'SUBSCRIBED') Promise.resolve(agent.backfillMinutes('pre-market preparation')).catch(() => {});
    this.updatePrep(agent, now);
  }

  /** Reference levels and pre-market movement from data that is actually available. Never executable prices. */
  updatePrep(agent, now) {
    const st = this.sym(agent.symbol);
    if (!agent.candles) return;
    const bars = agent.candles.completedBars('1m', now);
    const daily = agent.candles.getBars('1d');
    const bd = agent.calendar.dayBounds ? agent.calendar.dayBounds(etDateStr(now)) : null;
    const pm = bd ? bars.filter((b) => b.time * 1000 >= bd.preMs && b.time * 1000 < bd.openMs) : [];
    const ref = agent.market && agent.market.reference;
    const refFresh = ref && now - ref.ts < 20 * 60000;
    const px = pm.length ? pm[pm.length - 1].close : (refFresh ? ref.price : null);
    const source = pm.length ? 'LIVE_BARS' : (refFresh ? 'INDICATIVE_REFERENCE' : null);
    const done = daily.filter((d) => etDateStr(d.time * 1000) < etDateStr(now));
    // 'lv' takes its session from the last loaded bar, which is the PREVIOUS day until a pre-market bar exists
    const prev = done.length ? done[done.length - 1] : null;
    const prevClose = prev ? prev.close : null;
    const atrs = Ind.atr(done, 14);
    const atr = atrs.length ? atrs[atrs.length - 1] : null;
    const gap = isNum(px) && prevClose > 0 ? px - prevClose : null;
    st.prep = {
      at: now, prevClose, prevHigh: prev ? prev.high : null, prevLow: prev ? prev.low : null, price: px, source,
      pmHigh: pm.length ? Math.max(...pm.map((b) => b.high)) : null, pmLow: pm.length ? Math.min(...pm.map((b) => b.low)) : null, pmVolume: pm.reduce((s, b) => s + (b.volume || 0), 0),
      gapPct: isNum(gap) ? (gap / prevClose) * 100 : null, gapAtr: isNum(gap) && atr > 0 ? gap / atr : null, dailyAtr: atr, indicative: source === 'INDICATIVE_REFERENCE',
    };
    st.prep.unusual = isNum(st.prep.gapAtr) && Math.abs(st.prep.gapAtr) >= this.cfg().events.gapAtr;
  }

  openingWatchlist() {
    return [...this.symbols.entries()].filter(([, s]) => s.prep && s.prep.unusual)
      .sort((a, b) => Math.abs(b[1].prep.gapAtr) - Math.abs(a[1].prep.gapAtr))
      .map(([symbol, s]) => ({ symbol, gapPct: s.prep.gapPct, gapAtr: s.prep.gapAtr, indicative: s.prep.indicative }));
  }

  logWatchlist() {
    const w = this.openingWatchlist();
    const txt = w.map((x) => `${x.symbol} ${x.gapPct >= 0 ? '+' : ''}${x.gapPct.toFixed(2)}%`).join(', ');
    this.activity.info('MARKET', w.length ? `Opening watchlist (unusual pre-market movement): ${txt}` : 'Opening watchlist: no unusual pre-market movement', { source: 'adaptive monitoring' });
  }

  // ---------------------------------------------------------------- closing phase
  closingReview(now, c) {
    const book = this.desk.book;
    const v = book.portfolio ? this.desk.primary.valuation() : null;
    const held = book.portfolio ? this.desk.all().filter((a) => book.portfolio.position(a.symbol)) : [];
    this.activity.info('RISK', `Closing phase: ${held.length} open position(s), exposure ${v ? v.exposurePct.toFixed(1) : '0.0'}% of equity${c.noNewEntriesLastMin > 0 ? `; no new entries in the last ${c.noNewEntriesLastMin} minutes` : ''}`, { source: 'adaptive monitoring' });
    if (!c.closingPositionReview) return;
    for (const a of held) {
      const st = this.sym(a.symbol);
      this.admit(a, st, { type: 'CLOSING_POSITION_REVIEW', dir: 0, confirmed: true, mandatory: true, at: now, barTime: st.lastBarTime, price: a.market ? a.market.mark() : null, key: 'close-review', detail: 'open position before the close' }, now, c);
    }
  }

  // ---------------------------------------------------------------- market-wide movement (existing SPY/QQQ snapshots)
  marketWide(now, c) {
    const bm = this.desk.book.broadMarket;
    const mk = this.market;
    for (const [s, arr] of Object.entries(mk.samples)) { while (arr.length && now - arr[0].ts > 16 * 60000) arr.shift(); if (!arr.length) delete mk.samples[s]; }
    // the market-wide mode never outlives its data
    const newest = Math.max(0, ...Object.values(mk.samples).map((a) => a[a.length - 1].ts));
    if (mk.active && now - newest > 5 * 60000) {
      mk.active = false; mk.above = 0; mk.below = 0;
      this.activity.info('MARKET', 'Market-wide mode ended: index data is no longer fresh', { source: 'adaptive monitoring' });
    }
    if (!REGULAR_MODES.has(this.base.mode) || !bm || !bm.available || !bm.symbols) { if (mk.active && !REGULAR_MODES.has(this.base.mode)) mk.active = false; return; }
    let fresh = false;
    for (const [s, x] of Object.entries(bm.symbols)) {
      const ts = Date.parse(x.time);
      if (!isNum(ts) || !(x.price > 0) || now - ts > 3 * 60000) continue; // stale index data never drives a mode
      const arr = mk.samples[s] = mk.samples[s] || [];
      if (!arr.length || ts > arr[arr.length - 1].ts) { arr.push({ ts, price: x.price }); fresh = true; }
    }
    if (!fresh) return;
    const moves = Object.entries(mk.samples).filter(([, a]) => a.length > 1 && now - a[a.length - 1].ts <= 3 * 60000 && a[a.length - 1].ts - a[0].ts >= 8 * 60000).map(([s, a]) => ({ s, pct: ((a[a.length - 1].price - a[0].price) / a[0].price) * 100 }));
    if (!moves.length) return;
    const lim = c.volatility.marketMovePct;
    const same = new Set(moves.map((m) => Math.sign(m.pct))).size === 1;
    const strong = same && moves.every((m) => Math.abs(m.pct) >= lim);
    const calm = moves.every((m) => Math.abs(m.pct) < lim * 0.5);
    mk.above = strong ? mk.above + 1 : 0;
    mk.below = calm ? mk.below + 1 : 0;
    if (!mk.active && mk.above >= 2) {
      mk.active = true; mk.since = now; mk.detail = moves.map((m) => `${m.s} ${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(2)}%`).join(', ');
      this.activity.info('MARKET', `Market-wide move detected: ${mk.detail} in 15 minutes — elevated monitoring for all symbols`, { status: 'warn', source: 'adaptive monitoring' });
      if (!this.paused()) this.desk.emitEvent('HIGH_VOLATILITY', null, { active: true, scope: 'market', reason: mk.detail }, 'low', `hv:market:1:${Math.floor(now / 1800000)}`);
    } else if (mk.active && mk.below >= 5 && now - mk.since >= c.volatility.minActiveMin * 60000) {
      mk.active = false;
      this.activity.info('MARKET', 'Market-wide move ended — back to the session mode', { source: 'adaptive monitoring' });
    }
  }

  // ---------------------------------------------------------------- per symbol, between candle closes
  symbolTick(agent, now, si, ds) {
    const st = this.sym(agent.symbol);
    if (ds && ds.tradable) { st.lastTradableAt = now; st.staleSince = null; } else if (!st.staleSince) st.staleSince = now;
    const mode = this.symbolMode(agent.symbol);
    if (now - st.lastEvalAt < this.profile(mode).evalSec * 1000) return;
    st.lastEvalAt = now;
    st.data = ds ? { code: ds.code, label: ds.label, fresh: !!ds.tradable } : null;
    if (this.paused() || agent.monitoringPaused) return;
    if (mode === MODE.PRE) this.updatePrep(agent, now);
    const c = this.cfg();
    if (st.override.active) {
      // the override never outlives reliable data
      if (st.staleSince && now - st.staleSince > 3 * 60000) this.endOverride(agent.symbol, st, 'market data not reliable', now);
      else if (st.lastBarAt && now - st.lastBarAt > 10 * 60000) this.endOverride(agent.symbol, st, 'no trades for 10 minutes', now);
      return;
    }
    // forming candle: a violent move in two consecutive inspections raises local monitoring at once (no AI call)
    const m = st.metrics;
    const part = agent.candles && agent.candles.partial;
    if (!REGULAR_MODES.has(mode) || !ds || !ds.tradable || !m || !m.available || !part || now - part.time * 1000 > 90000) { st.override.shock = 0; return; }
    const tr = Math.max(part.high, m.close) - Math.min(part.low, m.close);
    st.override.shock = tr / m.trBase >= c.volatility.enterRatio * 1.8 ? st.override.shock + 1 : 0;
    if (st.override.shock >= 2 && now >= st.override.cooldownUntil) this.startOverride(agent.symbol, st, `forming candle range ${(tr / m.trBase).toFixed(1)}x typical (provisional)`, now);
  }

  // ---------------------------------------------------------------- per symbol, on a completed 1-minute candle
  onBarClose(agent, { tf, bar }, si, now) {
    if (tf !== '1m' || !bar || !this.enabled()) return;
    this.guard(() => {
      if (now - (bar.time + 60) * 1000 > 90000) return; // only candles that have just completed
      this.rollDay(now);
      const c = this.cfg();
      const st = this.sym(agent.symbol);
      st.lastBarAt = now;
      const b = sessionMode(si, now, c);
      if (!REGULAR_MODES.has(b.mode)) { if (b.mode === MODE.PRE && !this.paused()) this.updatePrep(agent, now); return; }
      if (this.paused() || agent.monitoringPaused) return; // a paused symbol raises no events or alerts
      const all = agent.candles.completedBars('1m', now);
      const T = this.todayBars(all, si, now);
      if (!T.length || T[T.length - 1].time <= st.lastBarTime) return;
      this.evaluate(agent, st, T, all, si, now, c, b.mode);
      st.lastBarTime = T[T.length - 1].time;
    });
  }

  /** Completed minutes of today's regular session (correct on early-close days). */
  todayBars(all, si, now) {
    const open = isNum(si.regularOpenMs) ? si.regularOpenMs : now - 390 * 60000;
    const close = isNum(effectiveCloseMs(si)) ? effectiveCloseMs(si) : Infinity;
    return all.filter((x) => x.time * 1000 >= open && x.time * 1000 < close);
  }

  baselineFor(agent, st, all, now, c) {
    const today = etDateStr(now);
    const key = `${today}|${agent.chartVersion}|${c.openingMin}|${this.getCfg().ai.analysisTimeframe}`;
    if (st.baselineKey === key && st.baseline) return st.baseline;
    const cache = new Map();
    const boundsOf = (d) => { if (!cache.has(d)) cache.set(d, agent.calendar.dayBounds ? agent.calendar.dayBounds(d) : null); return cache.get(d); };
    const tf = this.getCfg().ai.analysisTimeframe;
    st.baseline = { ...buildBaseline(all, boundsOf, today, c.openingMin), scaled: scaledBaseline((agent.candles.history || {})[tf], (TIMEFRAMES[tf] || { sec: 0 }).sec, boundsOf, today) };
    st.baselineKey = key;
    return st.baseline;
  }

  levelsFor(agent, st, T, lv, m, now, si, mode) {
    const out = [];
    const add = (key, price, dir, type, label) => { if (isNum(price)) out.push({ key, price, dir, type, label }); };
    if (lv.openingRangeComplete) {
      add('or_high', lv.openingRangeHigh, 1, 'OPENING_RANGE_BREAKOUT', 'the opening-range high');
      add('or_low', lv.openingRangeLow, -1, 'OPENING_RANGE_BREAKDOWN', 'the opening-range low');
    }
    if (mode === MODE.CLOSING) {
      const closeMs = effectiveCloseMs(si);
      const start = isNum(closeMs) ? closeMs - this.cfg().closingMin * 60000 : (this.base.since || now);
      const before = T.filter((b) => b.time * 1000 < start);
      if (before.length) {
        add('eod_high', Math.max(...before.map((b) => b.high)), 1, 'END_OF_DAY_BREAKOUT', 'the day high');
        add('eod_low', Math.min(...before.map((b) => b.low)), -1, 'END_OF_DAY_BREAKDOWN', 'the day low');
      }
    }
    add('prev_high', lv.prevSessionHigh, 1, 'LEVEL_BREAKOUT', 'the previous-session high');
    add('prev_low', lv.prevSessionLow, -1, 'LEVEL_BREAKDOWN', 'the previous-session low');
    if (st.prep && !st.prep.indicative) {
      add('pm_high', st.prep.pmHigh, 1, 'LEVEL_BREAKOUT', 'the pre-market high');
      add('pm_low', st.prep.pmLow, -1, 'LEVEL_BREAKDOWN', 'the pre-market low');
    }
    const L = agent.lastAnalysis && agent.lastAnalysis.levels;
    if (L && L.breakout) add('ana_up', L.breakout.price, 1, 'LEVEL_BREAKOUT', 'resistance');
    if (L && L.breakdown) add('ana_dn', L.breakdown.price, -1, 'LEVEL_BREAKDOWN', 'support');
    return dedupeLevels(out, 0.25 * m.trBase);
  }

  evaluate(agent, st, T, all, si, now, c, mode) {
    const base = this.baselineFor(agent, st, all, now, c);
    const opts = (bars) => ({ inOpening: isNum(si.regularOpenMs) && bars[bars.length - 1].time * 1000 - si.regularOpenMs < c.openingMin * 60000, openingFactor: c.volatility.openingFactor, scaled: base.scaled });
    const lv = sessionLevels(all.slice(-900), agent.candles.getBars('1d'), now);
    st.range = { high: lv.openingRangeHigh, low: lv.openingRangeLow, complete: !!lv.openingRangeComplete, minutes: lv.openingRangeMinutes };
    // after a restart: rebuild unconfirmed breaks / recent breakouts from the last candles without raising events
    if (!st.warmed) {
      st.warmed = true;
      for (let k = Math.max(1, T.length - 20); k < T.length; k++) {
        const part = T.slice(0, k);
        const pm = computeMetrics(part, base, opts(part));
        if (!pm || !pm.available) continue;
        const t = (part[k - 1].time + 60) * 1000;
        const lvP = sessionLevels(all.filter((x) => x.time <= part[k - 1].time).slice(-900), agent.candles.getBars('1d'), t);
        detectEvents(st, part, pm, { levels: this.levelsFor(agent, st, part, lvP, pm, t, si, mode), c, now: t, mode });
      }
      st.noise = 0;
    }
    const m = st.metrics = computeMetrics(T, base, opts(T));
    if (!m || !m.available) return;
    st.levels = this.levelsFor(agent, st, T, lv, m, now, si, mode);
    const gap = (() => {
      const d = agent.candles.getBars('1d').filter((x) => etDateStr(x.time * 1000) < etDateStr(now));
      const a = Ind.atr(d, 14);
      const atr = a.length ? a[a.length - 1] : null;
      return lv.prevClose > 0 && atr > 0 ? { prevClose: lv.prevClose, pct: ((T[0].open - lv.prevClose) / lv.prevClose) * 100, atr: (T[0].open - lv.prevClose) / atr } : null;
    })();
    const events = detectEvents(st, T, m, { levels: st.levels, c, now, mode, gap });
    this.updateOverride(agent.symbol, st, m, events, now, c);
    this.process(agent, st, events, now, c);
    agent.markDirty();
  }

  // ---------------------------------------------------------------- high-volatility override (hysteresis + cooldown)
  updateOverride(symbol, st, m, events, now, c) {
    const o = st.override;
    const v = c.volatility;
    const relOk = m.relVol == null || m.relVol >= 1.2;
    const brk = events.some((e) => /BREAK/.test(e.type) && e.confirmed) && m.relVol >= 2 && m.volRatio >= v.exitRatio;
    const strong = (m.volRatio >= v.enterRatio && relOk) || (Math.abs(m.z5 || 0) >= c.events.moveZ * 1.3 && relOk) || brk;
    const shock = m.volRatio >= v.enterRatio * 1.8 && relOk;
    if (!o.active) {
      o.above = strong ? o.above + 1 : 0;
      const need = shock ? 1 : v.confirmBars;
      if (o.above >= need && now >= o.cooldownUntil) this.startOverride(symbol, st, `range ${m.volRatio.toFixed(1)}x typical${isNum(m.relVol) ? `, volume ${m.relVol.toFixed(1)}x` : ''}`, now);
      return;
    }
    const calm = m.volRatio <= v.exitRatio && Math.abs(m.z5 || 0) < 1.5;
    o.below = calm ? o.below + 1 : 0;
    if (o.below >= v.exitBars && now - o.since >= v.minActiveMin * 60000) this.endOverride(symbol, st, 'volatility normalised', now);
  }

  startOverride(symbol, st, reason, now) {
    Object.assign(st.override, { active: true, since: now, reason, above: 0, below: 0, shock: 0 });
    this.activity.info('MARKET', `HIGH VOLATILITY monitoring activated for ${symbol}: ${reason}`, { status: 'warn', source: 'adaptive monitoring' });
    // at most one notification per symbol and 30 minutes (stable id: repeats are dropped downstream)
    this.desk.emitEvent('HIGH_VOLATILITY', symbol, { active: true, scope: 'symbol', reason }, 'low', `hv:${symbol}:1:${Math.floor(now / 1800000)}`);
  }

  endOverride(symbol, st, reason, now, notify = true) {
    Object.assign(st.override, { active: false, since: null, reason: null, above: 0, below: 0, shock: 0, cooldownUntil: now + this.cfg().volatility.cooldownMin * 60000 });
    this.cooldowns[symbol] = st.override.cooldownUntil;
    this.dirty = true;
    this.activity.info('MARKET', `HIGH VOLATILITY monitoring ended for ${symbol}: ${reason} — back to ${this.base.mode || MODE.CLOSED}`, { source: 'adaptive monitoring' });
    if (notify) this.desk.emitEvent('HIGH_VOLATILITY', symbol, { active: false, scope: 'symbol', reason }, 'low', `hv:${symbol}:0:${Math.floor(now / 1800000)}`);
  }

  // ---------------------------------------------------------------- events → queue
  process(agent, st, events, now, c) {
    if (!events.length) return;
    // equivalent events of one candle (same direction) become ONE candidate: the strongest; the others explain it
    const groups = new Map();
    for (const e of events) {
      const k = `${this.day}|${agent.symbol}|${e.type}|${e.key}`;
      if (this.fired[k]) { this.count('duplicate'); continue; }
      this.fired[k] = now; this.dirty = true;
      const g = groups.get(e.dir || 0) || [];
      g.push(e); groups.set(e.dir || 0, g);
    }
    this.trimFired();
    for (const g of groups.values()) {
      const scored = g.map((e) => ({ e, s: this.score(agent, st, e, now, c) })).sort((a, b) => b.s.score - a.s.score);
      const top = { ...scored[0].e, context: scored.slice(1).map((x) => x.e.type) };
      for (let i = 1; i < scored.length; i++) this.count('merged_same_candle');
      this.enqueue(agent, st, top, scored[0].s, now, c);
    }
  }

  trimFired() {
    const ks = Object.keys(this.fired);
    if (ks.length > 1500) for (const k of ks.sort((a, b) => this.fired[a] - this.fired[b]).slice(0, ks.length - 1200)) delete this.fired[k];
  }

  admit(agent, st, e, now, c) {
    const k = `${this.day}|${agent.symbol}|${e.type}|${e.key}`;
    if (this.fired[k]) { this.count('duplicate'); return; }
    this.fired[k] = now; this.dirty = true;
    this.enqueue(agent, st, e, this.score(agent, st, e, now, c), now, c);
  }

  score(agent, st, e, now, c) {
    const book = this.desk.book;
    const m = st.metrics && st.metrics.available ? st.metrics : null;
    let q = m ? m.quality : 0.8;
    const bar = agent.candles && agent.candles.minutes.get(st.metrics ? e.barTime : 0);
    if (bar && bar.provisional) q *= 0.95;
    return scoreEvent(e, m, {
      profile: this.profile(this.symbolMode(agent.symbol)), held: book.portfolio ? book.portfolio.position(agent.symbol) : null, pending: book.orders.pendingFor(agent.symbol).length > 0,
      ageMs: Math.max(0, now - e.at), ttlMs: c.events.ttlSec * 1000, quality: q,
    });
  }

  minScore(symbol, c) { return c.ai.minScore + (this.profile(this.symbolMode(symbol)).minScoreDelta || 0); }

  enqueue(agent, st, e, s, now, c) {
    const rec = {
      id: ++this.seq, symbol: agent.symbol, type: e.type, label: (EVENTS[e.type] || {}).label || e.type, dir: e.dir || 0, at: e.at, barTime: e.barTime || null, price: isNum(e.price) ? e.price : null,
      level: isNum(e.level) ? e.level : null, confirmed: !!e.confirmed, mandatory: !!e.mandatory, detail: e.detail || '', context: e.context || [], key: e.key,
      score: s.score, raw: s.raw, breakdown: s.breakdown, quality: s.quality, mode: this.symbolMode(agent.symbol), status: 'QUEUED', reason: null,
    };
    this.counters.events++;
    if (rec.score >= c.ai.highPriorityScore) this.counters.highPriority++;
    this.dirty = true;
    st.lastEvent = { at: rec.at, type: rec.type, score: rec.score };
    this.recent.push(rec);
    if (this.recent.length > RECENT_MAX) this.recent.shift();
    if (!rec.mandatory && rec.score < this.minScore(agent.symbol, c)) return this.finish(rec, 'SUPPRESSED', 'low_score');
    if (rec.score >= c.ai.highPriorityScore || rec.mandatory) this.activity.info('ANALYSIS', `Market event ${rec.symbol}: ${rec.label} — priority ${rec.score}/100 (${rec.detail})`, { status: 'warn', source: 'adaptive monitoring' });
    // bounded queue: under load the weakest event is dropped (backpressure)
    const mine = this.queue.filter((x) => x.symbol === rec.symbol);
    if (mine.length >= QUEUE_MAX_PER_SYMBOL || this.queue.length >= QUEUE_MAX) {
      const pool = mine.length >= QUEUE_MAX_PER_SYMBOL ? mine : this.queue;
      const weakest = pool.reduce((a, b) => (b.score < a.score ? b : a));
      if (weakest.score >= rec.score) return this.finish(rec, 'SUPPRESSED', 'backpressure');
      this.queue.splice(this.queue.indexOf(weakest), 1);
      this.finish(weakest, 'SUPPRESSED', 'backpressure');
    }
    this.queue.push(rec);
    return rec;
  }

  finish(rec, status, reason = null) {
    rec.status = status; rec.reason = reason; rec.doneAt = this.now();
    if (status === 'SUPPRESSED') this.count(reason || 'other');
    return rec;
  }

  // ---------------------------------------------------------------- queue → existing AI scheduler
  /** Why the AI must not be asked now for this symbol (budgets / limits), or null. Existing hard limits apply anyway. */
  budgetBlock(agent, c, now) {
    if (!c.ai.enforceBudget) return null;
    const d = agent.decider();
    if (!d || !d.costly) return null;
    const ac = agent.aiCfg();
    const t = agent.usage.today(now);
    if (ac.dailyBudgetUsd > 0 && t.costUsd >= ac.dailyBudgetUsd * (1 - c.ai.budgetReservePct / 100)) return { reason: 'budget' };
    if (ac.maxRequestsPerDay > 0 && t.requests >= ac.maxRequestsPerDay * (1 - c.ai.budgetReservePct / 100)) return { reason: 'budget' };
    if (ac.maxPerSymbolPerHour > 0 && agent.usage.symbolRequestsLastHour(agent.symbol, now) >= ac.maxPerSymbolPerHour) return { reason: 'budget' };
    if (d.managed) {
      const plan = this.desk.book.aiManager.plan({ promptChars: 8000, maxOutputTokens: ac.maxOutputTokens, symbol: agent.symbol, triggers: ['SIGNAL_EVENT'], ms: now });
      if (plan.blocked) return { reason: /budget|cap|limit/i.test(plan.blocked) ? 'budget' : 'ai_unavailable' };
    }
    return null;
  }

  /** Hand over the best events that may be analysed now. Everything else waits (until it expires) or is dropped. */
  dispatch(now) {
    if (!this.queue.length) return;
    const book = this.desk.book;
    const c = this.cfg();
    if (book.shuttingDown) return;
    const dropAll = (reason) => { for (const e of this.queue) this.finish(e, 'SUPPRESSED', reason); this.queue = []; };
    if (this.paused()) return dropAll('monitoring_paused');
    if (book.aiState !== 'RUNNING') return dropAll('ai_not_running'); // monitoring stays active; AI trading is never started from here
    const ttl = c.events.ttlSec * 1000;
    const rank = (e) => e.score * (1 - 0.5 * clamp01((now - e.at) / ttl)) + (e.mandatory ? 10 : 0);
    this.queue.sort((a, b) => rank(b) - rank(a));
    const keep = [];
    let busy = this.desk.all().filter((a) => a.scheduler.inFlight || a.scheduler.pending).length;
    for (const e of this.queue) {
      const agent = this.desk.agent(e.symbol);
      if (!agent || agent.monitoringPaused) { this.finish(e, 'SUPPRESSED', 'symbol_paused'); continue; }
      const hold = (reason) => { e.hold = reason; keep.push(e); };
      if (now - e.at > ttl) { this.finish(e, 'SUPPRESSED', e.hold || 'expired'); continue; }
      if (!this.profile(this.symbolMode(e.symbol)).ai) { this.finish(e, 'SUPPRESSED', 'session_ended'); continue; }
      const st = this.sym(e.symbol);
      // the situation must still exist: a breakout that already failed is not worth an analysis
      const lt = agent.market && agent.market.lastTrade;
      const last = lt && lt.ts >= ((e.barTime || 0) + 60) * 1000 ? lt.price : null; // only a trade AFTER the candle can contradict its close
      if (e.confirmed && e.level != null && /BREAKOUT$|BREAKDOWN$/.test(e.type) && e.type !== 'FALSE_BREAKOUT' && isNum(last) && (e.dir > 0 ? last < e.level : last > e.level)) { this.finish(e, 'SUPPRESSED', 'invalidated'); continue; }
      if (now - e.at < SETTLE_MS) { keep.push(e); continue; }
      const minNow = this.minScore(e.symbol, c);
      if (!e.mandatory && e.score * (1 - 0.5 * clamp01((now - e.at) / ttl)) < minNow) { this.finish(e, 'SUPPRESSED', e.hold || 'expired'); continue; } // too old to matter
      const ds = agent.market ? agent.dataStatus(now) : null;
      if (!ds || !ds.tradable) { hold('stale_data'); continue; }
      if (agent.scheduler.inFlight) { hold('busy'); continue; }
      // an analysis that started after the event already saw it (a gated / cached job does not count as started)
      if ((agent.scheduler.lastStartAt || 0) >= e.at) { this.finish(e, 'SUPPRESSED', 'covered'); continue; }
      const cd = c.ai.symbolCooldownSec * 1000 * (this.profile(this.symbolMode(e.symbol)).cooldownFactor || 1);
      const lastAi = Math.max(agent.scheduler.lastStartAt || 0, st.lastDispatchAt);
      if (now - lastAi < cd && !(e.score >= st.lastDispatchScore + 15 && now - lastAi >= 60000)) { hold('cooldown'); continue; }
      if ((this.dispatched[e.symbol] || 0) >= c.ai.maxPerSymbolPerDay) { this.finish(e, 'SUPPRESSED', 'symbol_cap'); continue; }
      if (this.counters.dispatched >= c.ai.maxPerDay) { this.finish(e, 'SUPPRESSED', 'daily_cap'); continue; }
      const type = e.confirmed && e.score >= c.ai.highPriorityScore ? 'SIGNAL_CONFIRMED' : 'SIGNAL_EVENT';
      const gate = agent.analysisGate({ reasons: [{ type }] });
      if (gate) {
        if (/^Entries blocked|^New positions/.test(gate)) { this.finish(e, 'SUPPRESSED', 'risk_block'); continue; }
        hold(/recovering from errors/.test(gate) ? 'ai_unavailable' : 'gate'); continue;
      }
      // the existing level-break trigger already asked about this level: do not ask twice
      const dupKey = e.level != null ? `LEVEL_BREAK:${e.dir > 0 ? 'up' : 'dn'}${e.level.toFixed(2)}` : null;
      if (dupKey && (agent.scheduler.cooldowns.get(dupKey) || 0) > now) { this.finish(e, 'SUPPRESSED', 'duplicate'); continue; }
      if (busy >= c.ai.maxQueued) { hold('backpressure'); continue; }
      const bb = this.budgetBlock(agent, c, now);
      if (bb) { hold(bb.reason); continue; }
      const r = agent.scheduler.trigger({ type, key: `${e.type}:${e.key}`, detail: `${e.label}: ${e.detail}; attention ${e.score}/100${e.context.length ? `; also ${e.context.join(', ')}` : ''}` });
      if (r === 'queued' || r === 'merged') {
        this.finish(e, 'DISPATCHED', r);
        st.lastDispatchAt = now; st.lastDispatchScore = e.score;
        if (r === 'merged') this.counters.merged++; else busy++;
        // a merged SIGNAL_CONFIRMED can force a paid request, so it counts towards the caps too
        if (r === 'queued' || type === 'SIGNAL_CONFIRMED') { this.counters.dispatched++; this.dispatched[e.symbol] = (this.dispatched[e.symbol] || 0) + 1; }
        this.dirty = true;
      } else this.finish(e, 'SUPPRESSED', r === 'cooldown' ? 'cooldown' : 'ai_not_running');
    }
    this.queue = keep;
  }

  /** A queued event of this candle already asks for the analysis: the generic volume trigger would repeat it. */
  coversBar(symbol, barTime) {
    return this.enabled() && this.queue.some((e) => e.symbol === symbol && e.barTime === barTime);
  }

  /**
   * May a ROUTINE analysis (plain candle close) use the symbol's AI quota now? During intensive phases the last
   * requests of the hour are kept for real events.
   */
  allowRoutine(agent) {
    if (!this.enabled() || !this.profile(this.symbolMode(agent.symbol)).reserve) return true;
    const c = this.cfg();
    const cap = agent.aiCfg().maxPerSymbolPerHour;
    if (!(cap > 0) || !(c.ai.reserveSymbolRequests > 0)) return true;
    const keep = Math.min(c.ai.reserveSymbolRequests, Math.floor(cap / 2));
    if (agent.usage.symbolRequestsLastHour(agent.symbol, this.now()) < cap - keep) return true;
    this.counters.routineSkipped++; this.dirty = true;
    return false;
  }

  entryBlock(si, now) { return closingEntryBlock(si, now, this.cfg()); }

  // ---------------------------------------------------------------- views
  symbolRow(agent, now) {
    const st = this.sym(agent.symbol);
    const m = st.metrics;
    const mode = this.enabled() ? this.symbolMode(agent.symbol) : null;
    const ds = agent.market ? agent.dataStatus(now) : null;
    const ages = agent.market ? agent.market.ages(now) : {};
    return {
      symbol: agent.symbol, mode, baseMode: this.base.mode, override: st.override.active ? { since: st.override.since, reason: st.override.reason } : null, intensity: mode ? this.profile(mode).intensity : null,
      paused: !!agent.monitoringPaused, dataLabel: ds ? ds.label : null, dataCode: ds ? ds.code : null, fresh: ds ? !!ds.tradable : false, quoteAgeMs: ages && isNum(ages.quoteAgeMs) ? ages.quoteAgeMs : null,
      volRatio: m && m.available ? m.volRatio : null, relVol: m && m.available ? m.relVol : null, moveZ: m && m.available ? m.z5 : null, baseline: m ? m.note : null,
      openingRange: st.range, gapPct: st.prep ? st.prep.gapPct : null, gapIndicative: !!(st.prep && st.prep.indicative), lastEvent: st.lastEvent, aiToday: this.dispatched[agent.symbol] || 0,
    };
  }

  problems(now) {
    const out = [];
    const regular = REGULAR_MODES.has(this.base.mode);
    for (const a of this.desk.all()) {
      const st = this.sym(a.symbol);
      if (regular && a.market && st.staleSince && now - st.staleSince > 60000) { const ds = a.dataStatus(now); if (!ds.tradable) out.push({ symbol: a.symbol, code: 'DATA', detail: ds.label }); }
      if (regular && st.metrics && !st.metrics.available) out.push({ symbol: a.symbol, code: 'BASELINE', detail: st.metrics.note });
    }
    const bo = this.desk.book.aiBackoff;
    if (bo && now < bo.until) out.push({ symbol: null, code: 'AI', detail: `AI provider recovering until ${etTimeStr(bo.until, false)} ET` });
    return out.slice(0, 12);
  }

  /** Full status for the dashboard tab, the API and Telegram. */
  status() {
    const now = this.now();
    const c = this.cfg();
    const on = !!c.enabled;
    const pr = this.desk.primary;
    const si = pr.market ? pr.sessionInfo() : null;
    const mode = on && this.base.mode ? this.globalMode() : null; // unknown until a symbol (and its calendar) is loaded
    const usage = (() => { try { return this.desk.book.usage.today(now); } catch { return { requests: 0 }; } })();
    const ops = this.desk.operatingStates();
    return {
      at: now, enabled: on, monitoring: ops.monitoring, aiTrading: ops.aiTrading,
      session: si ? { code: si.session, label: si.marketStatus, reason: si.reason || null, earlyClose: !!si.earlyClose, estimated: !!si.estimated } : null,
      mode, baseMode: on ? this.base.mode : null, reason: on ? this.base.reason : null, since: this.base.since, intensity: mode ? this.profile(mode).intensity : null,
      next: on ? this.next : null, marketWide: this.market.active ? { since: this.market.since, detail: this.market.detail } : null,
      highVolatility: on ? [...this.symbols.entries()].filter(([, s]) => s.override.active).map(([symbol, s]) => ({ symbol, since: s.override.since, reason: s.override.reason })) : [],
      entryBlock: on && si ? this.entryBlock(si, now) : null, trackedSymbols: this.desk.all().length, openingWatchlist: this.openingWatchlist(),
      ai: { requestsToday: usage.requests || 0, eventAnalysesToday: this.counters.dispatched, mergedToday: this.counters.merged, preventedToday: this.prevented(), maxPerSymbolPerDay: c.ai.maxPerSymbolPerDay, maxPerDay: c.ai.maxPerDay },
      counters: { ...this.counters, suppressed: { ...this.counters.suppressed } }, queued: this.queue.length, symbols: this.desk.all().map((a) => this.symbolRow(a, now)),
      recent: this.recent.slice(-25).reverse().map((e) => ({ ...e })), problems: on ? this.problems(now) : [],
      scoreNote: 'Attention score for scheduling analyses only — not a probability of profit and no permission to trade.',
    };
  }

  /** Small summary for the live state message. */
  summary() {
    const on = this.enabled();
    const mode = on && this.base.mode ? this.globalMode() : null;
    return {
      enabled: on, mode, baseMode: on ? this.base.mode : null, intensity: mode ? this.profile(mode).intensity : null, next: on ? this.next : null,
      highVolatility: on ? [...this.symbols.entries()].filter(([, s]) => s.override.active).map(([symbol]) => symbol) : [],
      eventAnalysesToday: this.counters.dispatched, highPriorityToday: this.counters.highPriority, preventedToday: this.prevented(),
    };
  }
}

module.exports = {
  AdaptiveMonitor, MODE, REGULAR_MODES, PROFILES, EVENTS, DEFAULTS, adaptiveCfg, sessionMode, nextTransition, closingEntryBlock, effectiveCloseMs,
  buildBaseline, scaledBaseline, computeMetrics, scoreEvent, detectEvents, dedupeLevels, newSymbolState,
};
