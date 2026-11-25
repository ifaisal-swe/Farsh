'use strict';
/**
 * The families of price rules found in a survey of public trading repositories, written from their general definitions
 * (no code was copied). Each takes daily bars and returns, for every day, the share of the money in the stock (0 to 1)
 * decided on that close and held until the next. honest.js tests them; a rule that proves nothing influences nothing.
 *
 * Left out on purpose: grid, martingale and averaging down (they hide large losses), short selling, options, pairs,
 * order-book and minute-by-minute methods, and trained traders that cannot be checked honestly on one stock.
 */
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sma = (c, n) => { let s = 0; return c.map((x, i) => { s += x; if (i >= n) s -= c[i - n]; return i >= n - 1 ? s / n : null; }); };
const ema = (c, n) => { const k = 2 / (n + 1); let e = null; return c.map((x, i) => { e = e === null ? x : e + k * (x - e); return i >= n - 1 ? e : null; }); };
const deviation = (c, n) => c.map((_, i) => { if (i < n - 1) return null; const w = c.slice(i - n + 1, i + 1); const m = mean(w); return Math.sqrt(mean(w.map((x) => (x - m) ** 2))); });
const rsi = (c, n) => { let u = 0; let d = 0; return c.map((x, i) => { if (!i) return null; const g = x - c[i - 1]; u = (u * (n - 1) + Math.max(0, g)) / n; d = (d * (n - 1) + Math.max(0, -g)) / n; return i > n * 3 ? 100 - 100 / (1 + u / (d || 1e-9)) : null; }); };
const ranges = (b) => b.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - b[i - 1].close), Math.abs(x.low - b[i - 1].close)) : x.high - x.low));
const atr = (b, n = 14) => { let a = null; return ranges(b).map((t, i) => { a = a === null ? t : a + (t - a) / n; return i >= n ? a : null; }); };
/** Highest or lowest of the n days before day i (without it) or, with `own`, up to it. */
const top = (b, n, own = 0) => b.map((_, i) => (i >= n ? Math.max(...b.slice(i - n + own, i + own).map((x) => x.high)) : null));
const bottom = (b, n, own = 0) => b.map((_, i) => (i >= n ? Math.min(...b.slice(i - n + own, i + own).map((x) => x.low)) : null));
const hold = (n, enter, exit) => { const p = []; let on = 0; for (let i = 0; i < n; i++) { if (!on && enter(i)) on = 1; else if (on && exit(i)) on = 0; p.push(on); } return p; };
const when = (n, f) => Array.from({ length: n }, (_, i) => (f(i) ? 1 : 0));
const C = (b) => b.map((x) => x.close);

function macd(c) { const a = ema(c, 12); const e = ema(c, 26); const m = c.map((_, i) => (e[i] === null ? 0 : a[i] - e[i])); return { m, g: ema(m, 9) }; }
function stoch(b, n = 14) { const h = top(b, n, 1); const l = bottom(b, n, 1); return b.map((x, i) => (h[i] === null ? null : ((x.close - l[i]) / (h[i] - l[i] || 1e-9)) * 100)); }
function adx(b, n = 14) {
  let tr = 0; let up = 0; let dn = 0; let a = null; const t = ranges(b);
  return b.map((x, i) => { if (!i) return null; const u = x.high - b[i - 1].high; const d = b[i - 1].low - x.low; tr += (t[i] - tr) / n; up += ((u > d && u > 0 ? u : 0) - up) / n; dn += ((d > u && d > 0 ? d : 0) - dn) / n; const pu = up / (tr || 1e-9); const pd = dn / (tr || 1e-9); const dx = (Math.abs(pu - pd) / (pu + pd || 1e-9)) * 100; a = a === null ? dx : a + (dx - a) / n; return i > n * 2 ? { a, up: pu > pd } : null; });
}
function kalman(c, q = 1e-5, r = 1e-3) { let x = Math.log(c[0]); let v = 0; let P = [1, 0, 0, 1]; return c.map((y) => { x += v; P = [P[0] + P[1] + P[2] + P[3] + q, P[1] + P[3], P[2] + P[3], P[3] + q / 10]; const s = P[0] + r; const k = [P[0] / s, P[2] / s]; const e = Math.log(y) - x; x += k[0] * e; v += k[1] * e; P = [(1 - k[0]) * P[0], (1 - k[0]) * P[1], P[2] - k[1] * P[0], P[3] - k[1] * P[1]]; return v; }); }
function heikin(b) { let o = null; let pc = null; return b.map((x) => { const c = (x.open + x.high + x.low + x.close) / 4; o = o === null ? (x.open + x.close) / 2 : (o + pc) / 2; pc = c; return c > o; }); }
function supertrend(b, n, k) { const a = atr(b, n); let up = null; let dn = null; let on = 0; return b.map((x, i) => { if (a[i] === null) return 0; const m = (x.high + x.low) / 2; const u = m + k * a[i]; const l = m - k * a[i]; const p = b[i - 1].close; up = up === null || u < up || p > up ? u : up; dn = dn === null || l > dn || p < dn ? l : dn; if (x.close > up) on = 1; else if (x.close < dn) on = 0; return on; }); }
function moneyFlow(b, n = 14) { const t = b.map((x) => (x.high + x.low + x.close) / 3); return b.map((_, i) => { if (i < n + 1) return null; let u = 0; let d = 0; for (let k = i - n + 1; k <= i; k++) { const f = t[k] * (b[k].volume || 0); if (t[k] > t[k - 1]) u += f; else if (t[k] < t[k - 1]) d += f; } return u + d > 0 ? (100 * u) / (u + d) : null; }); }

const RULES = {
  hold: (b) => b.map(() => 1),
  // trend
  long200: (b) => { const c = C(b); const m = sma(c, 200); return when(c.length, (i) => m[i] && c[i] > m[i]); },
  half200: (b) => { const c = C(b); const m = sma(c, 200); return c.map((x, i) => (m[i] && x > m[i] ? 1 : 0.5)); },
  cross: (b) => { const c = C(b); const f = sma(c, 20); const s = sma(c, 100); return when(c.length, (i) => s[i] && f[i] > s[i]); },
  stack: (b) => { const c = C(b); const x = ema(c, 10); const y = ema(c, 20); const z = sma(c, 50); return when(c.length, (i) => z[i] && x[i] > y[i] && y[i] > z[i]); },
  macd: (b) => { const c = C(b); const { m, g } = macd(c); const l = ema(c, 200); return hold(c.length, (i) => i && l[i] && c[i] > l[i] && m[i] > g[i] && m[i - 1] <= g[i - 1], (i) => m[i] < g[i]); },
  supertrend: (b) => supertrend(b, 10, 3),
  donchian: (b) => { const h = top(b, 55); const l = bottom(b, 20); return hold(b.length, (i) => h[i] && b[i].close > h[i], (i) => l[i] && b[i].close < l[i]); },
  adx: (b) => { const d = adx(b); return when(b.length, (i) => d[i] && d[i].a > 25 && d[i].up); },
  ichimoku: (b) => { const mid = (n) => { const h = top(b, n, 1); const l = bottom(b, n, 1); return h.map((x, i) => (x === null ? null : (x + l[i]) / 2)); }; const t = mid(9); const k = mid(26); const s = mid(52); return when(b.length, (i) => { const j = i - 26; return j >= 52 && k[i] && t[i] > k[i] && b[i].close > Math.max((t[j] + k[j]) / 2, s[j]); }); },
  heikin: (b) => { const h = heikin(b); return when(b.length, (i) => i > 1 && h[i] && h[i - 1]); },
  kalman: (b) => { const v = kalman(C(b)); return when(b.length, (i) => i > 60 && v[i] > 0); },
  keltner: (b) => { const c = C(b); const e = ema(c, 20); const a = atr(b, 10); return hold(c.length, (i) => e[i] && a[i] && c[i] > e[i] + 2 * a[i], (i) => e[i] && c[i] < e[i]); },
  trailing: (b) => { const c = C(b); const m = sma(c, 50); const a = atr(b, 22); let hi = 0; let on = 0; return c.map((x, i) => { if (!m[i] || !a[i]) return 0; if (!on) { if (x > m[i] && c[i - 1] <= m[i - 1]) { on = 1; hi = b[i].high; } } else { hi = Math.max(hi, b[i].high); if (x < hi - 3 * a[i]) on = 0; } return on; }); },
  // strength and breakouts
  momentum: (b) => { const c = C(b); return when(c.length, (i) => i >= 252 && c[i - 21] > c[i - 252]); },
  rsiBlend: (b) => { const c = C(b); const l = [22, 44, 66].map((n) => rsi(c, n)); return when(c.length, (i) => l[2][i] !== null && mean(l.map((x) => x[i])) > 52); },
  squeeze: (b) => { const c = C(b); const m = sma(c, 20); const s = deviation(c, 20); const h = top(b, 20); const w = s.map((x, i) => (x === null ? null : x / m[i])); return hold(c.length, (i) => i > 140 && h[i] && c[i] > h[i] && Math.min(...w.slice(i - 10, i)) <= [...w.slice(i - 120, i)].sort((x, y) => x - y)[24], (i) => c[i] < m[i]); },
  retest: (b) => { const c = C(b); const h = top(b, 20); const m = sma(c, 50); let lvl = null; let at = 0; return hold(c.length, (i) => { if (h[i] && c[i] > h[i]) { lvl = h[i]; at = i; return false; } return lvl !== null && i - at <= 10 && b[i].low <= lvl * 1.005 && c[i] > lvl; }, (i) => m[i] && c[i] < m[i]); },
  structure: (b) => { const h = top(b, 10); const l = bottom(b, 10); return hold(b.length, (i) => h[i] && b[i].close > h[i] && i > 20 && l[i] > l[i - 10], (i) => l[i] && b[i].close < l[i]); },
  gapZone: (b) => { let zone = null; let at = 0; const m = sma(C(b), 50); return hold(b.length, (i) => { if (i > 2 && b[i].low > b[i - 2].high && b[i - 1].close > b[i - 1].open) { zone = [b[i - 2].high, b[i].low]; at = i; return false; } return zone && i > at && i - at <= 20 && b[i].low <= zone[1] && b[i].close >= zone[0] && m[i] && b[i].close > m[i]; }, (i) => (m[i] && b[i].close < m[i]) || i - at > 40); },
  // volume
  volumeTrend: (b) => { let v = 0; const o = b.map((x, i) => { if (i) v += (Math.sign(x.close - b[i - 1].close) || 0) * (x.volume || 0); return v; }); const m = sma(o, 50); const c = C(b); const s = sma(c, 50); return when(c.length, (i) => m[i] !== null && o[i] > m[i] && c[i] > s[i]); },
  moneyFlow: (b) => { const f = moneyFlow(b); const c = C(b); const m = sma(c, 200); return hold(c.length, (i) => m[i] && c[i] > m[i] && f[i] !== null && f[i] < 25, (i) => f[i] > 70); },
  // buying weakness
  pullback: (b) => { const c = C(b); const m = sma(c, 200); const r = rsi(c, 2); const f = sma(c, 5); return hold(c.length, (i) => m[i] && c[i] > m[i] && r[i] !== null && r[i] < 10, (i) => f[i] && c[i] > f[i]); },
  rsi: (b) => { const r = rsi(C(b), 14); return hold(b.length, (i) => r[i] !== null && r[i] < 30, (i) => r[i] > 70); },
  bollinger: (b) => { const c = C(b); const m = sma(c, 20); const s = deviation(c, 20); return hold(c.length, (i) => m[i] && c[i] < m[i] - 2 * s[i], (i) => c[i] > m[i]); },
  stochastic: (b) => { const k = stoch(b); return hold(b.length, (i) => k[i] !== null && k[i] < 30, (i) => k[i] > 80); },
  counter: (b) => { const c = C(b); const r = rsi(c, 14); const e = ema(c, 60); return hold(c.length, (i) => e[i] && r[i] !== null && r[i] < 35 && c[i] < e[i], (i) => r[i] > 55); },
  divergence: (b) => { const c = C(b); const { m } = macd(c); return hold(c.length, (i) => { if (i < 70) return false; const w = c.slice(i - 30, i - 5); const j = i - 30 + w.indexOf(Math.min(...w)); return c[i] < c[j] && m[i] > m[j] && m[i] < 0 && c[i] > c[i - 1]; }, (i) => i > 0 && m[i] > 0 && m[i] < m[i - 1]); },
  countdown: (b) => { const c = C(b); let n = 0; const s = c.map((x, i) => { n = i >= 4 && x < c[i - 4] ? n + 1 : 0; return n; }); let u = 0; const t = c.map((x, i) => { u = i >= 4 && x > c[i - 4] ? u + 1 : 0; return u; }); return hold(c.length, (i) => s[i] === 9, (i) => t[i] === 9); },
  engulfing: (b) => { const c = C(b); const m = sma(c, 200); let at = 0; return hold(c.length, (i) => { const x = b[i]; const y = b[i - 1]; const e = y && m[i] && c[i] > m[i] && y.close < y.open && x.close > y.open && x.open <= y.close; if (e) at = i; return e; }, (i) => i - at >= 10); },
  // choosing by market state, and size by movement
  router: (b) => { const t = RULES.long200(b); const p = RULES.pullback(b); const d = RULES.donchian(b); return t.map((x, i) => (x && (p[i] || d[i]) ? 1 : 0)); },
  steady: (b) => { const c = C(b); const m = sma(c, 200); const s = deviation(c.map((x, i) => (i ? x / c[i - 1] - 1 : 0)), 20); return c.map((x, i) => (m[i] && x > m[i] && s[i] ? Math.min(1, 0.15 / (s[i] * Math.sqrt(252))) : 0)); },
};

module.exports = { RULES };
