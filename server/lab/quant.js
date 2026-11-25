'use strict';
/**
 * Quantitative techniques on daily closes. Pure functions, seeded randomness, no look-ahead: every figure about skill
 * is measured out of sample, and a model that does not beat its own naive baseline is reported as having no edge.
 */
const { compare } = require('../analysis/honest');

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1)) : 0; };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const quantile = (sorted, q) => { if (!sorted.length) return null; const i = (sorted.length - 1) * q; const lo = Math.floor(i); return sorted[lo] + (sorted[Math.min(lo + 1, sorted.length - 1)] - sorted[lo]) * (i - lo); };
const sigmoid = (x) => 1 / (1 + Math.exp(-clamp(x, -35, 35)));
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const closes = (bars) => bars.map((b) => b.close);
const logReturns = (c) => c.slice(1).map((x, i) => Math.log(x / c[i]));
const YEAR = 252;

function drawdown(c) { let peak = -Infinity; let max = 0; for (const x of c) { peak = Math.max(peak, x); max = Math.max(max, 1 - x / peak); } return { max, current: 1 - c[c.length - 1] / peak }; }

/** GARCH(1,1) by a small grid on the likelihood, with the long-run variance fixed to the sample's. */
function garch(r) {
  const m = mean(r); const raw = r.map((x) => x - m); const lim = 4 * sd(raw.map((x) => x));
  const e = raw.map((x) => Math.max(-lim, Math.min(lim, x))); const v0 = mean(e.map((x) => x * x)); // one extreme day must not decide the forecast
  let best = null;
  for (const a of [0.02, 0.05, 0.08, 0.12, 0.18]) for (const b of [0.7, 0.8, 0.86, 0.9, 0.94]) {
    if (a + b >= 0.995) continue;
    const w = v0 * (1 - a - b); let v = v0; let ll = 0;
    for (const x of e) { ll += Math.log(v) + (x * x) / v; v = w + a * x * x + b * v; }
    if (!best || ll < best.ll) best = { ll, a, b, next: v };
  }
  return { alpha: best.a, beta: best.b, nextDay: Math.sqrt(best.next), longRun: Math.sqrt(v0) };
}

/** Two-state Gaussian hidden Markov model (EM): a calm and a turbulent state. */
function regimes(r, iters = 40) {
  const n = r.length; const s = sd(r);
  if (n < 120 || !(s > 0)) return null;
  let mu = [mean(r), mean(r)]; let sg = [s * 0.6, s * 1.6]; let A = [[0.97, 0.03], [0.05, 0.95]]; let pi = [0.5, 0.5]; let g = [];
  const pdf = (x, k) => Math.max(1e-300, Math.exp(-((x - mu[k]) ** 2) / (2 * sg[k] ** 2)) / (sg[k] * Math.sqrt(2 * Math.PI)));
  for (let it = 0; it < iters; it++) {
    const al = []; const c = [];
    for (let t = 0; t < n; t++) { const row = [0, 1].map((k) => pdf(r[t], k) * (t ? al[t - 1][0] * A[0][k] + al[t - 1][1] * A[1][k] : pi[k])); const z = row[0] + row[1]; c.push(z); al.push([row[0] / z, row[1] / z]); }
    const be = new Array(n); be[n - 1] = [1, 1];
    for (let t = n - 2; t >= 0; t--) be[t] = [0, 1].map((i) => (A[i][0] * pdf(r[t + 1], 0) * be[t + 1][0] + A[i][1] * pdf(r[t + 1], 1) * be[t + 1][1]) / c[t + 1]);
    g = al.map((x, t) => { const a = x[0] * be[t][0]; const b = x[1] * be[t][1]; return [a / (a + b), b / (a + b)]; });
    const xi = [[0, 0], [0, 0]];
    for (let t = 0; t < n - 1; t++) for (const i of [0, 1]) for (const j of [0, 1]) xi[i][j] += (al[t][i] * A[i][j] * pdf(r[t + 1], j) * be[t + 1][j]) / c[t + 1];
    A = xi.map((x) => { const z = x[0] + x[1] || 1; return [x[0] / z, x[1] / z]; });
    pi = g[0].slice();
    for (const k of [0, 1]) { const w = g.reduce((a, x) => a + x[k], 0) || 1; mu[k] = g.reduce((a, x, t) => a + x[k] * r[t], 0) / w; sg[k] = Math.max(s * 0.1, Math.sqrt(g.reduce((a, x, t) => a + x[k] * (r[t] - mu[k]) ** 2, 0) / w)); }
  }
  const hot = sg[1] >= sg[0] ? 1 : 0;
  return { turbulentProb: g[n - 1][hot], calmVol: sg[1 - hot] * Math.sqrt(YEAR), turbulentVol: sg[hot] * Math.sqrt(YEAR), stay: A[hot][hot], shareTurbulent: mean(g.map((x) => x[hot])) };
}

/** Stationary block bootstrap: standardized past days replayed at today's forecast volatility, drift removed. */
function monteCarlo(r, price, { horizon = 20, paths = 3000, seed = 7, vol = null, stop = null, target = null } = {}) {
  const rand = rng(seed); const m = mean(r); const s = sd(r) || 1e-6; const z = r.map((x) => (x - m) / s); const v = vol || s;
  const byDay = Array.from({ length: horizon }, () => []); let hitStop = 0; let hitTarget = 0; let worst = [];
  for (let p = 0; p < paths; p++) {
    let x = price; let i = Math.floor(rand() * z.length); let done = null; let low = price;
    for (let d = 0; d < horizon; d++) {
      i = rand() < 0.15 ? Math.floor(rand() * z.length) : (i + 1) % z.length;
      x *= Math.exp(z[i] * v - (v * v) / 2);
      low = Math.min(low, x);
      byDay[d].push(x);
      if (!done && stop && x <= stop) done = 'stop';
      if (!done && target && x >= target) done = 'target';
    }
    if (done === 'stop') hitStop++; if (done === 'target') hitTarget++;
    worst.push(1 - low / price);
  }
  worst = worst.sort((a, b) => a - b);
  return { horizon, paths, bands: byDay.map((a) => { a.sort((x, y) => x - y); return [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => quantile(a, q)); }), hitStop: stop ? hitStop / paths : null, hitTarget: target ? hitTarget / paths : null, worstTypical: quantile(worst, 0.5), worstBad: quantile(worst, 0.95) };
}

// ---------------------------------------------------------------- learning models
function features(bars, i, bench) {
  const c = (k) => bars[i - k].close; const r = (k) => Math.log(c(0) / c(k));
  const win = (n) => bars.slice(i - n + 1, i + 1);
  const ret = (n) => { const w = win(n + 1).map((b) => b.close); return logReturns(w); };
  const v20 = sd(ret(20)); const v60 = sd(ret(60)) || 1e-6;
  const ch = ret(14); const up = mean(ch.map((x) => Math.max(0, x))); const dn = mean(ch.map((x) => Math.max(0, -x)));
  const vols = win(20).map((b) => b.volume || 0); const hi = Math.max(...win(60).map((b) => b.high)); const ma = (n) => mean(win(n).map((b) => b.close));
  const f = [r(1) / v20, r(5) / (v20 * 2.24), r(20) / (v20 * 4.47), r(60) / (v60 * 7.75), v20 / v60 - 1, up + dn > 0 ? up / (up + dn) - 0.5 : 0, c(0) / ma(50) - 1, c(0) / ma(200) - 1, c(0) / hi - 1, sd(vols) > 0 ? (vols[19] - mean(vols)) / sd(vols) : 0];
  const b = bench && bench.get(bars[i].time); const b20 = bench && bars[i - 20] && bench.get(bars[i - 20].time);
  f.push(b && b20 ? Math.log(b / b20) : 0);
  return f.map((x) => (Number.isFinite(x) ? clamp(x, -6, 6) : 0));
}
function scaler(X) { const m = X[0].map((_, j) => mean(X.map((r) => r[j]))); const s = X[0].map((_, j) => sd(X.map((r) => r[j])) || 1); return (r) => r.map((x, j) => (x - m[j]) / s[j]); }

function logistic(X, y, { steps = 220, lr = 0.25, l2 = 0.02 } = {}) {
  const k = X[0].length; const w = new Array(k).fill(0); let b = Math.log((mean(y) + 1e-6) / (1 - mean(y) + 1e-6));
  for (let s = 0; s < steps; s++) {
    const g = new Array(k).fill(0); let gb = 0;
    X.forEach((r, i) => { const e = sigmoid(b + r.reduce((a, x, j) => a + x * w[j], 0)) - y[i]; gb += e; for (let j = 0; j < k; j++) g[j] += e * r[j]; });
    b -= (lr * gb) / X.length; for (let j = 0; j < k; j++) w[j] -= lr * (g[j] / X.length + l2 * w[j]);
  }
  const f = (r) => sigmoid(b + r.reduce((a, x, j) => a + x * w[j], 0)); f.weights = w; return f;
}
/** Gradient-boosted decision stumps on the logistic loss. */
function boosted(X, y, { rounds = 40, lr = 0.08 } = {}) {
  const n = X.length; const k = X[0].length; const base = Math.log((mean(y) + 1e-6) / (1 - mean(y) + 1e-6)); const F = new Array(n).fill(base); const trees = [];
  const cuts = Array.from({ length: k }, (_, j) => { const v = X.map((r) => r[j]).sort((a, b) => a - b); return [0.1, 0.25, 0.5, 0.75, 0.9].map((q) => quantile(v, q)); });
  for (let t = 0; t < rounds; t++) {
    const g = F.map((f, i) => y[i] - sigmoid(f)); const h = F.map((f) => { const p = sigmoid(f); return p * (1 - p); });
    let best = null;
    for (let j = 0; j < k; j++) for (const c of cuts[j]) {
      let gl = 0; let hl = 0; let gr = 0; let hr = 0;
      for (let i = 0; i < n; i++) { if (X[i][j] <= c) { gl += g[i]; hl += h[i]; } else { gr += g[i]; hr += h[i]; } }
      if (hl < 2 || hr < 2) continue;
      const gain = (gl * gl) / (hl + 1) + (gr * gr) / (hr + 1);
      if (!best || gain > best.gain) best = { gain, j, c, l: gl / (hl + 1), r: gr / (hr + 1) };
    }
    if (!best) break;
    trees.push(best); for (let i = 0; i < n; i++) F[i] += lr * (X[i][best.j] <= best.c ? best.l : best.r);
  }
  return (r) => sigmoid(trees.reduce((a, t) => a + lr * (r[t.j] <= t.c ? t.l : t.r), base));
}
function nearest(X, y, { k = 40 } = {}) { const base = mean(y); return (r) => { const d = X.map((x, i) => [x.reduce((a, v, j) => a + (v - r[j]) ** 2, 0), y[i]]).sort((a, b) => a[0] - b[0]).slice(0, Math.min(k, X.length)); return (d.reduce((a, x) => a + x[1], 0) + base * 20) / (d.length + 20); }; }

/** Chance that the price is higher after `horizon` days: three models, judged only on days they never saw. */
/** 1 when the target is touched before the stop within the horizon. Both on one day counts as the stop. */
function barrier(bars, { horizon = 20, up = 2, down = 1.5 } = {}) {
  let a = null; const atr = bars.map((b, i) => { const t = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low; a = a === null ? t : a + (t - a) / 14; return a; });
  return (i) => { const e = bars[i].close; const t = e + up * atr[i]; const s = e - down * atr[i]; for (let k = i + 1; k <= i + horizon; k++) { if (bars[k].low <= s) return 0; if (bars[k].high >= t) return 1; } return 0; };
}

function forecast(bars, bench, { horizon = 5, block = 42, seed = 11, label = null } = {}) {
  const start = 200; const X = []; const y = []; const idx = [];
  for (let i = start; i + horizon < bars.length; i++) { X.push(features(bars, i, bench)); y.push(label ? label(i) : bars[i + horizon].close > bars[i].close ? 1 : 0); idx.push(i); }
  if (X.length < 180) return { available: false, reason: 'HISTORY', samples: X.length };
  const fit = (A, b) => { const s = scaler(A); const Z = A.map(s); const ms = [logistic(Z, b), boosted(Z, b), nearest(Z, b)]; return (r) => { const z = s(r); return ms.map((m) => m(z)); }; };
  const scored = [];
  for (let from = Math.max(120, Math.floor(X.length * 0.35)); from < X.length; from += block) {
    const trainEnd = from - horizon; // the last labels overlap the test days, so they are left out
    const A = X.slice(0, trainEnd); const b = y.slice(0, trainEnd); const m = fit(A, b); const base = mean(b);
    for (let i = from; i < Math.min(X.length, from + block); i++) { const p = m(X[i]); scored.push({ y: y[i], p: mean(p), parts: p, base }); }
  }
  const brier = (f) => mean(scored.map((s) => (f(s) - s.y) ** 2)); const own = brier((s) => s.p); const naive = brier((s) => s.base);
  // paired block bootstrap: how often would chance alone look this good?
  const diff = scored.map((s) => (s.base - s.y) ** 2 - (s.p - s.y) ** 2); const rand = rng(seed); let notBetter = 0; const B = 600;
  for (let b = 0; b < B; b++) { let t = 0; let n = 0; while (n < diff.length) { const a = Math.floor(rand() * diff.length); for (let k = 0; k < 10 && n < diff.length; k++, n++) t += diff[(a + k) % diff.length]; } if (t <= 0) notBetter++; }
  const skill = 1 - own / naive; const trust = 1 - notBetter / B; const edge = skill > 0.002 && trust >= 0.9;
  const now = fit(X.slice(0, X.length), y)(features(bars, bars.length - 1, bench)); const base = mean(y); const raw = mean(now);
  return { available: true, horizon, samples: X.length, tested: scored.length, accuracy: mean(scored.map((s) => ((s.p > 0.5 ? 1 : 0) === s.y ? 1 : 0))), baseRate: base, naiveAccuracy: mean(scored.map((s) => ((s.base > 0.5 ? 1 : 0) === s.y ? 1 : 0))), skill, trust, edge, models: now, probUp: edge ? raw : base, rawProbUp: raw, agreement: now.every((p) => p > 0.5) || now.every((p) => p < 0.5) };
}

/** Chance that a target of 2 usual moves comes before a stop of 1.5, the way a plan really ends. */
function targetFirst(bars, bench) {
  const o = { horizon: 20, up: 2, down: 1.5 }; if (bars.some((b) => !(b.high > 0) || !(b.low > 0))) return null;
  const f = forecast(bars, bench, { horizon: o.horizon, label: barrier(bars, o), seed: 23 });
  return f.available ? { available: true, ...o, chance: f.probUp, usual: f.baseRate, edge: f.edge, tested: f.tested, skill: f.skill } : { available: false };
}

/** Past stretches whose shape looks most like the last `len` days, and what followed. */
function analogues(c, { len = 20, ahead = 10, k = 12 } = {}) {
  const r = logReturns(c); const shape = (from) => { const w = r.slice(from, from + len); const m = mean(w); const s = sd(w) || 1e-6; return w.map((x) => (x - m) / s); };
  const n = r.length; const now = shape(n - len); const found = [];
  for (let i = 0; i + len + ahead <= n - len; i++) { const s = shape(i); found.push([s.reduce((a, x, j) => a + x * now[j], 0) / (len - 1), Math.exp(r.slice(i + len, i + len + ahead).reduce((a, x) => a + x, 0)) - 1, i]); }
  found.sort((a, b) => b[0] - a[0]);
  const pick = []; for (const f of found) { if (pick.every((p) => Math.abs(p[2] - f[2]) >= ahead)) pick.push(f); if (pick.length === k) break; }
  if (pick.length < 5) return null;
  const o = pick.map((p) => p[1]).sort((a, b) => a - b);
  return { count: pick.length, ahead, similarity: mean(pick.map((p) => p[0])), upShare: mean(o.map((x) => (x > 0 ? 1 : 0))), median: quantile(o, 0.5), low: o[0], high: o[o.length - 1] };
}

function anomaly(bars) {
  const r = logReturns(closes(bars)); const robust = (a) => { const s = [...a.slice(-250)].sort((x, y) => x - y); const med = quantile(s, 0.5); const mad = quantile(s.map((x) => Math.abs(x - med)).sort((x, y) => x - y), 0.5) || 1e-9; return (x) => (x - med) / (1.4826 * mad); };
  const v = bars.map((b) => Math.log((b.volume || 0) + 1));
  return { returnZ: robust(r.slice(0, -1))(r[r.length - 1]), volumeZ: robust(v.slice(0, -1))(v[v.length - 1]), lastReturn: Math.exp(r[r.length - 1]) - 1 };
}

/** A simple trend rule against holding, after costs, decided on the previous close. */
function backtest(c, { fast = 20, slow = 100, cost = 0.001 } = {}) {
  let pos = 0; const strat = []; const hold = []; let trades = 0;
  for (let i = slow; i < c.length; i++) { const ma = (n) => mean(c.slice(i - n, i)); const want = ma(fast) > ma(slow) ? 1 : 0; const r = c[i] / c[i - 1] - 1; const fee = want !== pos ? cost : 0; if (want !== pos) trades++; pos = want; strat.push(pos * r - fee); hold.push(r); }
  const sum = (a) => { const eq = a.reduce((e, x) => { e.push((e[e.length - 1] || 1) * (1 + x)); return e; }, []); return { total: eq[eq.length - 1] - 1, sharpe: sd(a) > 0 ? (mean(a) / sd(a)) * Math.sqrt(YEAR) : 0, maxDrawdown: drawdown(eq).max }; };
  return strat.length < 120 ? null : { days: strat.length, trades, rule: sum(strat), hold: sum(hold) };
}

function market(c, b) {
  const n = Math.min(c.length, b.length, 253); const x = logReturns(c.slice(-n)); const y = logReturns(b.slice(-n)); const mx = mean(x); const my = mean(y);
  const cov = mean(x.map((v, i) => (v - mx) * (y[i] - my))); const vy = mean(y.map((v) => (v - my) ** 2)); const vx = mean(x.map((v) => (v - mx) ** 2));
  return vy > 0 && vx > 0 ? { beta: cov / vy, correlation: cov / Math.sqrt(vx * vy), relative: Math.exp(x.slice(-63).reduce((a, v) => a + v, 0) - y.slice(-63).reduce((a, v) => a + v, 0)) - 1 } : null;
}

/** Everything above for one symbol. `price` is the live price; `stop`/`target` optional. */
function analyze(bars, benchBars, { price, stop, target, riskCapPct = 20, targetVol = 0.15 } = {}) {
  const clean = bars.filter((b) => b.close > 0);
  if (clean.length < 130) return { available: false, reason: 'HISTORY', days: clean.length };
  const c = closes(clean); const r = logReturns(c); const px = price || c[c.length - 1];
  const g = garch(r); const sorted = [...r].sort((a, b) => a - b); const var95 = quantile(sorted, 0.05); const tail = sorted.filter((x) => x <= var95);
  const bench = benchBars && benchBars.length ? new Map(benchBars.map((b) => [b.time, b.close])) : null;
  const pair = benchBars && benchBars.length ? clean.filter((b) => bench.has(b.time)) : [];
  const dailyVol = g.nextDay; const ma = (n) => (c.length >= n ? mean(c.slice(-n)) : null);
  return {
    available: true, days: clean.length, price: px,
    trend: { ma20: ma(20), ma50: ma(50), ma200: ma(200), r20: c.length > 20 ? c[c.length - 1] / c[c.length - 21] - 1 : null, r60: c.length > 60 ? c[c.length - 1] / c[c.length - 61] - 1 : null, r250: c.length > 250 ? c[c.length - 1] / c[c.length - 251] - 1 : null },
    risk: { volYear: sd(r.slice(-60)) * Math.sqrt(YEAR), volNext: dailyVol, volNextYear: dailyVol * Math.sqrt(YEAR), var95: 1 - Math.exp(var95), cvar95: 1 - Math.exp(mean(tail)), drawdown: drawdown(c) },
    regime: regimes(r.slice(-750)), market: pair.length > 130 ? market(closes(pair), pair.map((b) => bench.get(b.time))) : null,
    monteCarlo: monteCarlo(r.slice(-500), px, { vol: dailyVol, stop, target }), forecast: forecast(clean, bench), plan: targetFirst(clean, bench), analogues: analogues(c.slice(-1500)), anomaly: anomaly(clean), backtest: backtest(c), tested: clean.every((b) => b.open > 0 && b.high > 0 && b.low > 0) ? compare(clean) : null,
    sizing: { pct: Math.max(0, Math.min(riskCapPct, (targetVol / (dailyVol * Math.sqrt(YEAR))) * 100)), capPct: riskCapPct, targetVol },
  };
}

module.exports = { barrier, targetFirst, analyze, garch, regimes, monteCarlo, forecast, analogues, anomaly, backtest, market, drawdown, quantile, rng, mean, sd, logReturns };
