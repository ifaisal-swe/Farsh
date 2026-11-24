'use strict';
/**
 * The plan's arithmetic. Pure functions: percentages per asset class -> target weight per symbol -> orders.
 * A class never exceeds its own percentage; what cannot be bought safely stays in cash.
 */
const CLASSES = ['stocks', 'crypto', 'gold', 'funds'];
const SYMBOL = { stocks: /^[A-Z][A-Z0-9.]{0,9}$/, funds: /^[A-Z][A-Z0-9.]{0,9}$/, crypto: /^(?!PAXG)[A-Z0-9]{2,6}\/USD$/, gold: /^PAXG\/USD$/ };
const TILT = { SUPPORT: 1, NEUTRAL: 0.75, UNKNOWN: 0.75, AVOID: 0 };
const fail = (m) => Object.assign(new Error(m), { status: 400 });

function validate(p) {
  const x = p || {};
  const targets = {};
  for (const c of CLASSES) { const n = Number((x.targets || {})[c] || 0); if (!Number.isFinite(n) || n < 0 || n > 100) throw fail('A percentage must be between 0 and 100'); targets[c] = Math.round(n * 10) / 10; }
  const sum = CLASSES.reduce((a, c) => a + targets[c], 0);
  if (sum > 100.001) throw fail('The percentages add up to more than 100');
  if (sum < 1) throw fail('Set at least one percentage');
  const symbols = {};
  let count = 0;
  for (const c of CLASSES) {
    const list = [...new Set(((x.symbols || {})[c] || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    if (list.some((s) => !SYMBOL[c].test(s))) throw fail('Invalid symbol in the plan');
    symbols[c] = targets[c] > 0 ? list : [];
    if (targets[c] > 0 && !list.length) throw fail('Choose what to buy for every percentage');
    count += symbols[c].length;
  }
  if (new Set(CLASSES.flatMap((c) => symbols[c])).size !== count) throw fail('A symbol may appear once in the plan');
  if (count > 10) throw fail('The plan holds at most ten symbols');
  const pick = (v, allowed, d) => (allowed.includes(Number(v)) ? Number(v) : d);
  return { targets, symbols, smart: x.smart !== false, pace: pick(x.pace, [1, 3, 5, 10], 3), band: pick(x.band, [3, 5, 10], 5), guard: pick(x.guard, [10, 15, 20, 30], 20) };
}

const classOf = (plan, s) => CLASSES.find((c) => plan.symbols[c].includes(s)) || null;

/** Target weight (0..1 of the portfolio) per symbol. Calmer symbols get more; "avoid" gets nothing new in smart mode. */
function weights(plan, info) {
  const out = {};
  for (const c of CLASSES) {
    const list = plan.symbols[c];
    if (!list.length) continue;
    const base = plan.targets[c] / 100;
    const raw = list.map((s) => { const v = info[s] && info[s].vol; return 1 / Math.max(0.05, v || 0.5); });
    const tot = raw.reduce((a, b) => a + b, 0);
    let share = raw.map((r) => r / tot);
    if (list.length > 1) { // no single name may dominate its class
      const cap = Math.max(0.6, 1 / list.length);
      for (let k = 0; k < 4; k++) { const over = share.reduce((a, s) => a + Math.max(0, s - cap), 0); if (over < 1e-9) break; const room = share.reduce((a, s) => a + (s < cap ? s : 0), 0); share = share.map((s) => (s >= cap ? cap : s + (room > 0 ? (over * s) / room : 0))); }
    }
    list.forEach((s, i) => { const t = plan.smart ? (TILT[(info[s] && info[s].verdict) || 'UNKNOWN']) : 1; out[s] = { cls: c, full: base * share[i], target: base * share[i] * t, tilt: t }; });
  }
  return out;
}

/**
 * state: { equity, cash, value: {symbol: dollars}, managed: [symbols], built: {cls: true}, day, bought: {cls: dollars today} }
 * Returns orders { symbol, side, value, why } largest gap first, sells before buys.
 */
function orders(plan, info, state) {
  const w = weights(plan, info);
  const eq = state.equity;
  const min = Math.max(10, eq * 0.004);
  const val = (s) => state.value[s] || 0;
  const sells = []; const buys = [];
  // what the plan holds but no longer contains
  for (const s of state.managed) if (!w[s] && val(s) > 0) sells.push({ symbol: s, side: 'SELL', value: val(s), all: true, why: 'REMOVED' });
  for (const c of CLASSES) {
    const list = plan.symbols[c];
    if (!list.length) continue;
    const goal = (plan.targets[c] / 100) * eq; // the class ceiling; tilt lowers buying only
    const have = list.reduce((a, s) => a + val(s), 0);
    const over = have - goal;
    if (over > (plan.band / 100) * eq) {
      // back to the target, from the names furthest above their own share
      let left = over;
      for (const s of [...list].sort((a, b) => (val(b) - w[b].full * eq) - (val(a) - w[a].full * eq))) { const extra = Math.min(left, Math.max(0, val(s) - w[s].full * eq)); if (extra >= min && state.managed.includes(s)) { sells.push({ symbol: s, side: 'SELL', value: extra, why: 'OVER' }); left -= extra; } }
      continue;
    }
    const want = list.reduce((a, s) => a + w[s].target * eq, 0);
    const gap = want - have;
    const building = !(state.built || {})[c];
    if (gap < min || (!building && gap < (plan.band / 100) * eq)) continue;
    const room = Math.min(gap, goal - have, Math.max(0, goal / plan.pace - ((state.bought || {})[c] || 0)));
    // today's part is shared by need, so a symbol that cannot be bought never takes the others' turn
    const needs = list.map((s) => Math.max(0, w[s].target * eq - val(s)));
    const all = needs.reduce((a, b) => a + b, 0);
    list.forEach((s, i) => {
      const need = all > 0 ? Math.min(needs[i], (room * needs[i]) / all) : 0;
      if (need < min) return;
      buys.push({ symbol: s, side: 'BUY', value: need, most: Math.max(need, Math.min(gap, goal - have, needs[i])), why: building ? 'BUILD' : 'UNDER' });
    });
  }
  let cash = state.cash * 0.985; // fees and price movement
  const funded = [];
  for (const b of buys.sort((a, b2) => b2.value - a.value)) { const v = Math.min(b.value, cash); if (v >= min) { funded.push({ ...b, value: v, most: Math.min(b.most, cash) }); cash -= v; } }
  return [...sells, ...funded];
}

function builtClasses(plan, info, state) {
  const w = weights(plan, info);
  const out = { ...(state.built || {}) };
  for (const c of CLASSES) { const l = plan.symbols[c]; if (!l.length) { delete out[c]; continue; } const want = l.reduce((a, s) => a + w[s].target, 0) * state.equity; const have = l.reduce((a, s) => a + (state.value[s] || 0), 0); if (want > 0 && have >= want * 0.93) out[c] = true; }
  return out;
}

// ---------------------------------------------------------------- what the mix could do
const { rng, quantile } = require('../lab/quant');
/** One year of joint daily history replayed in blocks, rebalanced monthly. series: { symbol: [{time, close}] } */
function simulate(plan, info, series, { capital = 10000, days = 252, paths = 1200, seed = 5 } = {}) {
  const w = weights({ ...plan, smart: false }, info);
  const syms = Object.keys(w).filter((s) => series[s] && series[s].length > 60);
  if (!syms.length) return null;
  // crypto trades every day; only days all of them share are comparable
  const day = (t) => new Date(t * 1000).toISOString().slice(0, 10);
  const maps = syms.map((s) => new Map(series[s].map((b) => [day(b.time), b.close])));
  const dates = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort();
  if (dates.length < 60) return null;
  const R = dates.slice(1).map((d, i) => maps.map((m) => m.get(d) / m.get(dates[i]) - 1));
  // past gains are not assumed to repeat: every symbol's average is removed
  const avg = syms.map((_, k) => R.reduce((a, r) => a + r[k], 0) / R.length);
  const ws = syms.map((s) => w[s].full);
  const rand = rng(seed); const end = []; const drop = [];
  for (let p = 0; p < paths; p++) {
    let hold = ws.map((x) => x); let cash = 1 - ws.reduce((a, b) => a + b, 0); let peak = 1; let worst = 0; let i = Math.floor(rand() * R.length);
    for (let d = 0; d < days; d++) {
      i = rand() < 0.1 ? Math.floor(rand() * R.length) : (i + 1) % R.length;
      hold = hold.map((h, k) => h * (1 + R[i][k] - avg[k]));
      const v = cash + hold.reduce((a, b) => a + b, 0);
      peak = Math.max(peak, v); worst = Math.max(worst, 1 - v / peak);
      if (d % 21 === 20) { hold = ws.map((x) => x * v); cash = v * (1 - ws.reduce((a, b) => a + b, 0)); }
    }
    end.push((cash + hold.reduce((a, b) => a + b, 0)) * capital); drop.push(worst);
  }
  end.sort((a, b) => a - b); drop.sort((a, b) => a - b);
  return { days, history: dates.length, missing: Object.keys(w).filter((s) => !syms.includes(s)), end: [0.05, 0.5, 0.95].map((q) => quantile(end, q)), typicalDrop: quantile(drop, 0.5), badDrop: quantile(drop, 0.95) };
}

module.exports = { CLASSES, validate, weights, orders, builtClasses, classOf, simulate };
