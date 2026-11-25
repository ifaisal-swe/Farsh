'use strict';
/**
 * Strength against other stocks, the state of the market, and how alike holdings are. Pure functions of daily closes.
 *
 * Chosen by a test of 20 published rules on 15 years of daily prices (next-day execution, 0.1% costs): ranking by an RSI
 * blend and by 63-day return against SPY picked better than random choices; halving risk under the 200-day average cut
 * the worst drop. Breadth did no better than the 200-day line, so it is information only. None of it predicts a profit.
 */
const ok = (x) => typeof x === 'number' && Number.isFinite(x);
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/** A fixed, varied group to compare with, so a place means something even when only one stock is followed. */
const UNIVERSE = 'AAPL MSFT NVDA AMZN GOOGL META TSLA JPM XOM JNJ PG KO WMT HD CVX PFE MRK INTC CSCO IBM GE BA CAT DIS NKE T VZ BAC GM ORCL AMD QCOM TXN MCD UPS MMM XLK XLF XLE XLV XLU XLP XLI'.split(' ');
const SECTOR = Object.fromEntries(Object.entries({
  Technology: 'AAPL MSFT NVDA INTC CSCO IBM ORCL AMD QCOM TXN AVGO CRM ADBE MU AMAT PLTR SMCI ARM TSM ASML XLK SMH', Communication: 'GOOGL GOOG META DIS T VZ NFLX TMUS CMCSA XLC', Consumer: 'AMZN TSLA HD NKE MCD GM F SBUX LOW BKNG XLY', Staples: 'PG KO WMT PEP COST XLP', Financials: 'JPM BAC C WFC GS MS V MA BRK.B XLF', Energy: 'XOM CVX COP SLB XLE', Health: 'JNJ PFE MRK LLY UNH ABBV XLV', Industrials: 'GE BA CAT UPS MMM HON XLI', Utilities: 'NEE DUK SO XLU',
}).flatMap(([s, l]) => l.split(' ').map((x) => [x, s])));

function rsi(c, n) {
  if (c.length <= n * 3) return null;
  let u = 0; let d = 0;
  for (let i = 1; i < c.length; i++) { const x = c[i] - c[i - 1]; u = (u * (n - 1) + Math.max(0, x)) / n; d = (d * (n - 1) + Math.max(0, -x)) / n; }
  return 100 - 100 / (1 + u / (d || 1e-9));
}
const average = (c, n) => (c.length >= n ? mean(c.slice(-n)) : null);
const change = (c, n) => (c.length > n && c[c.length - 1 - n] > 0 ? c[c.length - 1] / c[c.length - 1 - n] - 1 : null);

function reading(c, spy) {
  const r = [22, 44, 66].map((n) => rsi(c, n)); const a = change(c, 63); const b = change(spy, 63); const m = average(c, 200); const px = c[c.length - 1];
  return { blend: r.every(ok) ? mean(r) : null, relative: ok(a) && ok(b) ? a - b : null, above200: ok(m) ? px > m : null, distance200: ok(m) ? px / m - 1 : null };
}

/** Place of one value among others: 0 (weakest) to 1 (strongest). */
function place(v, all) { const l = all.filter(ok); if (!ok(v) || l.length < 15) return null; return (l.filter((x) => x < v).length + 0.5 * l.filter((x) => x === v).length) / l.length; }

/** closes: { symbol: [daily closes, oldest first] }. Places every symbol among the comparison group. */
function rank(closes, spy, group = UNIVERSE) {
  const read = {}; for (const [s, c] of Object.entries(closes)) if (c && c.length > 200) read[s] = reading(c, spy);
  const peers = group.filter((s) => read[s]); const out = {};
  for (const [s, r] of Object.entries(read)) {
    const p = [place(r.blend, peers.map((x) => read[x].blend)), place(r.relative, peers.map((x) => read[x].relative))].filter(ok);
    out[s] = { ...r, place: p.length ? mean(p) : null, among: peers.length };
  }
  return out;
}

/** The market now. Risk is halved, never raised, when the broad market is under its long average. */
function marketState(closes, spy, group = UNIVERSE) {
  const m = average(spy, 200);
  if (!ok(m)) return { known: false, factor: 1, above: null, breadth: null };
  const above = spy[spy.length - 1] > m; const v = group.filter((s) => !s.startsWith('XL')).map((s) => { const c = closes[s]; const a = c && average(c, 200); return ok(a) ? (c[c.length - 1] > a ? 1 : 0) : null; }).filter((x) => x !== null);
  return { known: true, above, factor: above ? 1 : 0.5, distance: spy[spy.length - 1] / m - 1, breadth: v.length >= 15 ? mean(v) : null };
}

/** How alike two price series moved in the last `n` days (daily changes, -1 to 1). */
function correlation(a, b, n = 60) {
  const k = Math.min(a.length, b.length, n + 1); if (k < 40) return null;
  const x = []; const y = []; const A = a.slice(-k); const B = b.slice(-k);
  for (let i = 1; i < k; i++) { x.push(A[i] / A[i - 1] - 1); y.push(B[i] / B[i - 1] - 1); }
  const mx = mean(x); const my = mean(y); let xy = 0; let xx = 0; let yy = 0;
  for (let i = 0; i < x.length; i++) { xy += (x[i] - mx) * (y[i] - my); xx += (x[i] - mx) ** 2; yy += (y[i] - my) ** 2; }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null;
}

/**
 * Would one more purchase make the portfolio one single bet? held: [{ symbol, value }]. Unknown data never blocks.
 * Limits are percentages of the account already held in the same sector, or in stocks that move together.
 */
function concentration({ symbol, held, equity, closes, sectorOf = (s) => SECTOR[s] || null, maxSectorPct = 50, maxAlikePct = 40, alike = 0.75 }) {
  const others = (held || []).filter((h) => h.symbol !== symbol && h.value > 0);
  if (!others.length || !(equity > 0)) return { pass: true, detail: 'No other holding to compare', sectorPct: 0, alikePct: 0 };
  const s = sectorOf(symbol); const sum = (l) => (l.reduce((a, h) => a + h.value, 0) / equity) * 100;
  const sectorPct = s ? sum(others.filter((h) => sectorOf(h.symbol) === s)) : 0;
  const close = others.map((h) => ({ ...h, r: closes[symbol] && closes[h.symbol] ? correlation(closes[symbol], closes[h.symbol]) : null })).filter((h) => ok(h.r) && h.r >= alike); const alikePct = sum(close);
  const full = [sectorPct >= maxSectorPct ? `${sectorPct.toFixed(0)}% of the account is already in ${s} (limit ${maxSectorPct}%)` : null, alikePct >= maxAlikePct ? `${alikePct.toFixed(0)}% is already in ${close.map((h) => h.symbol).join(', ')}, which move with it (limit ${maxAlikePct}%)` : null].filter(Boolean);
  return { pass: !full.length, detail: full.join('; ') || 'Not the same bet as the other holdings', sectorPct, alikePct, sector: s, alike: close.map((h) => h.symbol) };
}

/** Keeps a day of closes for the comparison group, one request at a time. fetchBars(symbol) -> daily bars. */
class StrengthService {
  constructor({ fetchBars, followed = () => [], group = UNIVERSE, now = Date.now, gapMs = 250 }) { Object.assign(this, { fetchBars, followed, group, now, gapMs }); this.data = new Map(); this.busy = false; this.table = {}; this.market = { known: false, factor: 1, above: null, breadth: null }; }
  stale(s) { const d = this.data.get(s); return !d || this.now() - d.at > (d.c ? 6 * 3600000 : 1800000); }

  async refresh() {
    if (this.busy) return; this.busy = true;
    try {
      for (const s of new Set(['SPY', ...this.followed(), ...this.group])) {
        if (!this.stale(s)) continue;
        let c = null; try { c = (await this.fetchBars(s)).map((b) => b.close).filter((x) => x > 0); } catch { c = null; }
        const old = this.data.get(s);
        this.data.set(s, { at: this.now(), c: c && c.length ? c : (old && old.c) || null });
        if (this.gapMs) await new Promise((r) => { setTimeout(r, this.gapMs); });
      }
      const closes = this.closes(); const spy = closes.SPY || [];
      if (spy.length > 200) { this.table = rank(closes, spy, this.group); this.market = marketState(closes, spy, this.group); }
    } finally { this.busy = false; }
  }
  closes() { return Object.fromEntries([...this.data].filter(([, d]) => d.c).map(([s, d]) => [s, d.c])); }
  of(s) { return this.table[s] || null; }
  list() { return Object.entries(this.table).filter(([s, r]) => ok(r.place) && s !== 'SPY').map(([symbol, r]) => ({ symbol, place: r.place, relative: r.relative, above200: r.above200 })).sort((a, b) => b.place - a.place); }
  check(symbol, held, equity, limits = {}) { return concentration({ symbol, held, equity, closes: this.closes(), ...limits }); }
}

module.exports = { UNIVERSE, SECTOR, rsi, reading, rank, marketState, correlation, concentration, StrengthService };
