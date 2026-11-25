'use strict';
/**
 * Honest testing. Rules are compared with holding and with the same trades at random times, in two periods and in a
 * locked last part that plays no role in choosing; the best result is discounted for how many rules were tried.
 * Confidence is compared with what really happened afterwards.
 */
const { RULES } = require('./rules');

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : 0; };
const ok = (x) => typeof x === 'number' && Number.isFinite(x);
const YEAR = 252;
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }


function stats(r) {
  let e = 1; let top = 1; let dd = 0; for (const x of r) { e *= 1 + x; top = Math.max(top, e); dd = Math.max(dd, 1 - e / top); }
  const s = sd(r);
  return { total: e - 1, yearly: e > 0 && r.length ? e ** (YEAR / r.length) - 1 : -1, sharpe: s > 0 ? (mean(r) / s) * Math.sqrt(YEAR) : 0, drop: dd };
}
function returns(c, p, from, to, cost) { const o = []; for (let i = from; i < to; i++) o.push(p[i] * (c[i + 1] / c[i] - 1) - Math.abs(p[i] - (i ? p[i - 1] : 0)) * cost); return o; }

function normal(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)); const d = 0.3989422804 * Math.exp((-x * x) / 2); const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429)))); return x > 0 ? 1 - p : p; }
function quantileNormal(p) { let lo = -8; let hi = 8; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (normal(m) < p) lo = m; else hi = m; } return (lo + hi) / 2; }

/** Chance that the best of the tried rules is better than luck alone would give (deflated Sharpe ratio). */
function deflated(r, sharpes) {
  const n = r.length; const tried = sharpes.length; if (n < 60 || tried < 2) return null;
  const s = sd(r); if (!(s > 0)) return null;
  const sr = mean(r) / s; const m = mean(r); const skew = mean(r.map((x) => ((x - m) / s) ** 3)); const kurt = mean(r.map((x) => ((x - m) / s) ** 4));
  const per = sharpes.map((x) => x / Math.sqrt(YEAR)); const g = 0.5772156649;
  const luck = sd(per) * ((1 - g) * quantileNormal(1 - 1 / tried) + g * quantileNormal(1 - 1 / (tried * Math.E)));
  const v = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr;
  return v > 0 ? normal(((sr - luck) * Math.sqrt(n - 1)) / Math.sqrt(v)) : null;
}

/** How often the same trades, moved to random times, did worse. About 50% means no timing skill. */
function timing(c, p, from, to, cost, { tries = 200, seed = 5 } = {}) {
  const core = p.slice(from, to); if (core.every((x) => x === core[0])) return null;
  const own = stats(returns(c, p, from, to, cost)).sharpe; const r = rng(seed); let better = 0;
  for (let t = 0; t < tries; t++) { const k = 20 + Math.floor(r() * Math.max(1, core.length - 40)); const z = [...p.slice(0, from), ...core.slice(k), ...core.slice(0, k), ...p.slice(to)]; if (own > stats(returns(c, z, from, to, cost)).sharpe) better++; }
  return better / tries;
}

/** Every rule on one stock. The last 20% is locked: shown, but never used to name the best. */
function compare(bars, { cost = 0.001, seed = 5 } = {}) {
  const c = bars.map((b) => b.close);
  const start = 252; const last = c.length - 1; if (last - start < 250) return null;
  const lock = start + Math.floor((last - start) * 0.8); const mid = start + Math.floor((lock - start) / 2); const rows = {};
  for (const [id, f] of Object.entries(RULES)) {
    const p = f(bars); const all = returns(c, p, start, lock, cost); let trades = 0; for (let i = start; i < lock; i++) if (p[i] !== p[i - 1]) trades++;
    rows[id] = { ...stats(all), first: stats(returns(c, p, start, mid, cost)).sharpe, second: stats(returns(c, p, mid, lock, cost)).sharpe, locked: stats(returns(c, p, lock, last, cost)), inMarket: mean(p.slice(start, lock)), trades, now: p[last], timing: timing(c, p, start, lock, cost, { seed }), r: all };
  }
  const list = Object.entries(rows).filter(([k]) => k !== 'hold'); const best = list.reduce((a, b) => (b[1].sharpe > a[1].sharpe ? b : a));
  // measured on the gain over holding: a rising stock must not make every rule look clever
  const over = list.map(([, x]) => x.r.map((v, i) => v - rows.hold.r[i])); const k = list.findIndex(([id]) => id === best[0]); const luck = deflated(over[k], over.map((o) => stats(o).sharpe)); const beats = best[1].sharpe > rows.hold.sharpe && best[1].locked.sharpe > rows.hold.locked.sharpe;
  for (const k of Object.keys(rows)) delete rows[k].r;
  return { days: lock - start, lockedDays: last - lock, rows, best: best[0], tried: list.length, now: best[1].now, notLuck: luck, proven: !!(beats && luck !== null && luck >= 0.95 && best[1].timing !== null && best[1].timing >= 0.95) };
}

/** How often random days did worse than a signal's days on the same stock (same number of picks, not overlapping). */
function againstRandom(rets, average, times, { ahead = 10, tries = 400, seed = 9 } = {}) {
  if (times < 5 || rets.length < times * ahead * 1.5) return null;
  const r = rng(seed); let worse = 0; let n = 0;
  for (let t = 0; t < tries; t++) { const pick = []; let guard = 0; while (pick.length < times && guard++ < times * 30) { const i = Math.floor(r() * rets.length); if (pick.every((x) => Math.abs(x - i) >= ahead)) pick.push(i); } if (pick.length < times) continue; n++; if (mean(pick.map((i) => rets[i])) < average) worse++; }
  return n >= 100 ? worse / n : null;
}

/** Said confidence against results: [{ p: 0..1, hit: bool }]. Never decreasing (pool adjacent violators), pulled to the average when few. */
function calibrate(list, { min = 20 } = {}) {
  const l = (list || []).filter((x) => ok(x.p) && typeof x.hit === 'boolean').sort((a, b) => a.p - b.p); const n = l.length;
  if (n < min) return { ready: false, n, need: min };
  const base = mean(l.map((x) => (x.hit ? 1 : 0))); const k = Math.min(5, Math.max(2, Math.floor(n / 10))); const bins = [];
  for (let i = 0; i < k; i++) { const s = l.slice(Math.floor((i * n) / k), Math.floor(((i + 1) * n) / k)); bins.push({ from: s[0].p, to: s[s.length - 1].p, n: s.length, said: mean(s.map((x) => x.p)), v: (s.filter((x) => x.hit).length + 4 * base) / (s.length + 4), w: s.length }); }
  const pool = bins.map((b) => ({ v: b.v, w: b.w, m: [b] }));
  for (let i = 0; i < pool.length - 1;) { if (pool[i].v > pool[i + 1].v + 1e-12) { const a = pool[i]; const b = pool[i + 1]; pool.splice(i, 2, { v: (a.v * a.w + b.v * b.w) / (a.w + b.w), w: a.w + b.w, m: [...a.m, ...b.m] }); i = Math.max(0, i - 1); } else i++; }
  const map = pool.flatMap((x) => x.m.map((b) => ({ from: b.from, to: b.to, n: b.n, said: b.said, real: x.v })));
  const at = (p) => { let b = map[0]; for (const x of map) if (p >= x.from) b = x; return b.real; };
  return { ready: true, n, base, bins: map, at, brier: mean(l.map((x) => (x.p - (x.hit ? 1 : 0)) ** 2)), brierBase: mean(l.map((x) => (base - (x.hit ? 1 : 0)) ** 2)) };
}

module.exports = { RULES, compare, deflated, timing, againstRandom, calibrate, stats, rng };
