'use strict';
/**
 * A stock seen through the published rules of well-known investors. Every rule is a plain comparison that passes,
 * fails, or stays unknown when the data does not reach far enough; nothing is estimated. Rules that are a common
 * rule of thumb, not the investor's own number, are marked "approx". A study aid: it never buys and is not advice.
 *
 * Sources checked 2026-11-24: Wikipedia (Piotroski F-score, CAN SLIM, Magic formula, Altman Z-score, Momentum
 * investing), Graham's defensive rules and Minervini's trend template from several secondary descriptions that agree,
 * Lynch's PEG and growth ranges, 12-1 momentum as used in academic work.
 */
const ok = (x) => typeof x === 'number' && Number.isFinite(x);
const T = (ar, en) => ({ ar, en });
const div = (a, b) => (ok(a) && ok(b) && b !== 0 ? a / b : null);
const pct = (x, d = 0) => (ok(x) ? `${(x * 100).toFixed(d)}%` : null);
const fix = (x, d = 2) => (ok(x) ? x.toFixed(d) : null);
const mean = (a) => (a.length && a.every(ok) ? a.reduce((x, y) => x + y, 0) / a.length : null);
const at = (bars, back) => (bars && bars.length > back ? bars[bars.length - 1 - back].close : null);
const rule = (text, pass, value, approx = false) => ({ text, state: pass === null || pass === undefined ? 'UNKNOWN' : pass ? 'PASS' : 'FAIL', value: value == null ? null : String(value), ...(approx ? { approx: true } : {}) });
/** A condition to be considered at all: it can disqualify, but meeting it earns nothing. */
const gate = (...a) => ({ ...rule(...a), gate: true });
const cmp = (x, f) => (ok(x) ? f(x) : null);
const sma = (bars, n, back = 0) => { const e = bars.length - back; if (e < n) return null; let s = 0; for (let i = e - n; i < e; i++) s += bars[i].close; return s / n; };
/** Years of a statement row that are known, newest first. */
const years = (row) => (row || []).filter(ok);
/** Yearly growth between the newest and the oldest known year; both must be positive. */
function cagr(row) { const y = row || []; const last = y.findLastIndex((x) => ok(x)); return last > 0 && ok(y[0]) && y[0] > 0 && y[last] > 0 ? (y[0] / y[last]) ** (1 / last) - 1 : null; }

function numbers(s, h) {
  if (!s) return null;
  const cap = h && h.marketCap; const col = (a, b, i) => div(a[i], b[i]);
  const ebit = ok(s.ebit[0]) ? s.ebit[0] : s.op[0];
  const ev = ok(cap) ? cap + (s.debt[0] || 0) - (s.cash[0] || 0) - (s.sti[0] || 0) : null;
  const wc = ok(s.ca[0]) && ok(s.cl[0]) ? s.ca[0] - s.cl[0] : null;
  const capital = ok(wc) && s.fixed && ok(s.fixed[0]) ? Math.max(0, wc) + s.fixed[0] : null;
  return { cap, roe: [0, 1, 2, 3].map((i) => (s.eq[i] > 0 ? col(s.net, s.eq, i) : null)), ebit, earningsYield: div(ebit, ev), returnOnCapital: capital > 0 ? div(ebit, capital) : null, wc, pe3: ok(cap) && mean(s.net.slice(0, 3)) > 0 ? cap / mean(s.net.slice(0, 3)) : null, pb: ok(cap) && s.eq[0] > 0 ? cap / s.eq[0] : null, growth: cagr(s.net), salesGrowth: cagr(s.revenue) };
}

const METHODS = {
  graham: {
    name: T('بنجامين غراهام', 'Benjamin Graham'), idea: T('المستثمر المتحفظ: شركة متينة بسعر معقول', 'The defensive investor: a sound company at a fair price'), needs: 'company',
    rules: ({ s, n }) => [
      rule(T('أصول متداولة ضعف الالتزامات على الأقل', 'Current assets at least twice current liabilities'), cmp(div(s.ca[0], s.cl[0]), (x) => x >= 2), fix(div(s.ca[0], s.cl[0]))),
      rule(T('الدين الطويل لا يتجاوز رأس المال العامل', 'Long-term debt no more than working capital'), ok(s.ltd[0]) && ok(n.wc) ? s.ltd[0] <= n.wc : null, ok(s.ltd[0]) && n.wc > 0 ? `${fix(s.ltd[0] / n.wc)}×` : null),
      rule(T('لا خسارة في عشر سنوات', 'No loss in ten years'), years(s.net).some((x) => x <= 0) ? false : null, `${years(s.net).filter((x) => x > 0).length} / 10`),
      rule(T('توزيعات متصلة عشرين سنة', 'Twenty years of dividends'), null, null),
      rule(T('السعر لا يتجاوز 15 ضعف متوسط أرباح 3 سنوات', 'Price at most 15 times average 3-year earnings'), cmp(n.pe3, (x) => x <= 15), n.pe3 === null ? null : `${fix(n.pe3, 1)}×`),
      rule(T('مكرر الربح × مكرر القيمة الدفترية ≤ 22.5', 'Earnings multiple × book multiple at most 22.5'), cmp(ok(n.pe3) && ok(n.pb) ? n.pe3 * n.pb : null, (x) => x <= 22.5), ok(n.pe3) && ok(n.pb) ? fix(n.pe3 * n.pb, 1) : null),
    ],
  },
  buffett: {
    name: T('وارن بافيت', 'Warren Buffett'), idea: T('شركة رائعة تكسب كثيرًا بدين قليل ونقد حقيقي', 'A great business: high returns, little debt, real cash'), needs: 'company',
    rules: ({ s, h, n }) => [
      rule(T('عائد على حقوق الملكية 15% فأكثر كل سنة', 'Return on equity of 15% or more every year'), years(n.roe).length >= 3 ? years(n.roe).every((x) => x >= 0.15) : null, years(n.roe).length ? `${pct(Math.min(...years(n.roe)))} – ${pct(Math.max(...years(n.roe)))}` : null, true),
      rule(T('الدين أقل من نصف حقوق الملكية', 'Debt under half of equity'), cmp(h.debtToEquity, (x) => x >= 0 && x < 0.5), fix(h.debtToEquity), true),
      rule(T('نقد حر موجب كل سنة', 'Positive free cash every year'), years(s.fcf).length >= 3 ? years(s.fcf).every((x) => x > 0) : null, years(s.fcf).length ? `${years(s.fcf).filter((x) => x > 0).length} / ${years(s.fcf).length}` : null),
      rule(T('هامش الربح الإجمالي ثابت أو يتحسن', 'Gross margin steady or rising'), ok(div(s.gross[0], s.revenue[0])) && ok(div(s.gross[2], s.revenue[2])) ? s.gross[0] / s.revenue[0] >= s.gross[2] / s.revenue[2] - 0.02 : null, pct(div(s.gross[0], s.revenue[0])), true),
      rule(T('السعر لا يفترض نموًا أكبر مما تحقق', 'Price assumes no more growth than was achieved'), ok(h.pricedInGrowth) && ok(n.salesGrowth) ? h.pricedInGrowth <= Math.min(0.2, Math.max(0, n.salesGrowth)) : null, ok(h.pricedInGrowth) ? `${pct(h.pricedInGrowth)} / ${pct(n.salesGrowth) || '—'}` : null, true),
    ],
  },
  lynch: {
    name: T('بيتر لينش', 'Peter Lynch'), idea: T('نمو سريع دون أن تدفع ثمنًا مبالغًا فيه', 'Fast growth without overpaying for it'), needs: 'company',
    rules: ({ s, h, n }) => [
      rule(T('نمو الأرباح بين 20% و50% سنويًا', 'Earnings growing 20% to 50% a year'), cmp(n.growth, (x) => x >= 0.2 && x <= 0.5), pct(n.growth)),
      rule(T('مكرر الربح لا يتجاوز معدل النمو (PEG ≤ 1)', 'Earnings multiple no higher than growth (PEG ≤ 1)'), ok(h.pe) && n.growth > 0 ? h.pe / (n.growth * 100) <= 1 : ok(n.growth) && n.growth <= 0 ? false : null, ok(h.pe) && n.growth > 0 ? fix(h.pe / (n.growth * 100)) : null),
      rule(T('النقد أكبر من الدين', 'More cash than debt'), ok(s.cash[0]) && ok(s.debt[0]) ? s.cash[0] + (s.sti[0] || 0) >= s.debt[0] : null, ok(s.cash[0]) && s.debt[0] > 0 ? `${fix((s.cash[0] + (s.sti[0] || 0)) / s.debt[0])}×` : null, true),
      rule(T('نقد حر موجب', 'Positive free cash'), cmp(s.fcf[0], (x) => x > 0), pct(h.freeCashMargin)),
    ],
  },
  greenblatt: {
    name: T('جويل غرينبلات', 'Joel Greenblatt'), idea: T('شركة جيدة ورخيصة معًا، بترتيبها بين غيرها', 'Good and cheap together, ranked against others'), needs: 'company',
    rules: ({ n, sector, rank }) => [
      gate(T('ليست بنكًا أو شركة مرافق', 'Not a financial or utility company'), sector ? !/financ|utilit/i.test(sector) : null, sector),
      gate(T('القيمة السوقية فوق 50 مليون دولار', 'Market value above $50 million'), cmp(n.cap, (x) => x > 5e7), ok(n.cap) ? `$${(n.cap / 1e9).toFixed(1)}B` : null),
      rule(T('عائد الأرباح في النصف الأعلى من قائمتك', 'Earnings yield in the top half of your list'), rank && ok(n.earningsYield) ? rank.yield <= rank.of / 2 : null, ok(n.earningsYield) ? `${pct(n.earningsYield, 1)}${rank ? ` (${rank.yield}/${rank.of})` : ''}` : null, true),
      rule(T('العائد على رأس المال في النصف الأعلى من قائمتك', 'Return on capital in the top half of your list'), rank && ok(n.returnOnCapital) ? rank.capital <= rank.of / 2 : null, ok(n.returnOnCapital) ? `${pct(n.returnOnCapital)}${rank ? ` (${rank.capital}/${rank.of})` : ''}` : null, true),
    ],
  },
  piotroski: {
    name: T('جوزيف بيوتروسكي', 'Joseph Piotroski'), idea: T('تسع علامات على أن صحة الشركة المالية تتحسن', 'Nine signs that a company’s finances are improving'), needs: 'company',
    rules: ({ s }) => {
      const r = (a, b, i) => div(a[i], b[i]); const roa = [r(s.net, s.ta, 0), r(s.net, s.ta, 1)]; const cfa = r(s.cfo, s.ta, 0);
      const better = (a, b, i, down) => { const x = r(a, b, 0); const y = r(a, b, 1); return ok(x) && ok(y) ? (down ? x < y : x > y) : null; };
      const lev = better(s.ltd, s.ta, 0, true); const noDebt = s.ltd[0] === 0 && s.ltd[1] === 0;
      return [
        rule(T('ربح على الأصول موجب', 'Positive return on assets'), cmp(roa[0], (x) => x > 0), pct(roa[0], 1)),
        rule(T('نقد التشغيل موجب', 'Positive operating cash flow'), cmp(s.cfo[0], (x) => x > 0), pct(cfa, 1)),
        rule(T('الربح على الأصول أعلى من العام السابق', 'Return on assets higher than last year'), ok(roa[0]) && ok(roa[1]) ? roa[0] > roa[1] : null, ok(roa[1]) ? `${pct(roa[1], 1)} → ${pct(roa[0], 1)}` : null),
        rule(T('نقد التشغيل أكبر من الربح', 'Operating cash flow above profit'), ok(cfa) && ok(roa[0]) ? cfa > roa[0] : null, null),
        rule(T('نسبة الدين الطويل أقل', 'Lower long-term debt ratio'), noDebt ? true : lev, pct(r(s.ltd, s.ta, 0), 1)),
        rule(T('السيولة الجارية أعلى', 'Higher current ratio'), better(s.ca, s.cl, 0), fix(r(s.ca, s.cl, 0))),
        rule(T('لا أسهم جديدة', 'No new shares issued'), null, null),
        rule(T('هامش إجمالي أعلى', 'Higher gross margin'), better(s.gross, s.revenue, 0), pct(r(s.gross, s.revenue, 0), 1)),
        rule(T('دوران الأصول أعلى', 'Higher asset turnover'), better(s.revenue, s.ta, 0), fix(r(s.revenue, s.ta, 0))),
      ];
    },
  },
  oneil: {
    name: T('ويليام أونيل (CAN SLIM)', 'William O’Neil (CAN SLIM)'), idea: T('قادة السوق: أرباح متسارعة وسعر قوي في سوق صاعد', 'Market leaders: fast earnings and a strong price in a rising market'), needs: 'company',
    rules: ({ s, n, bars, bench, institutions }) => {
      const g = ok(s.net[0]) && s.net[1] > 0 ? s.net[0] / s.net[1] - 1 : null; const me = momentum(bars); const mkt = momentum(bench);
      return [
        rule(T('C: ربح الربع أعلى 25% من مثيله', 'C: quarterly earnings up 25% on a year ago'), null, null),
        rule(T('A: نمو سنوي للأرباح 25% فأكثر', 'A: yearly earnings growth of 25% or more'), ok(n.growth) ? n.growth >= 0.25 : cmp(g, (x) => x >= 0.25), pct(ok(n.growth) ? n.growth : g)),
        rule(T('A: عائد على حقوق الملكية 17% فأكثر', 'A: return on equity of 17% or more'), cmp(n.roe[0], (x) => x >= 0.17), pct(n.roe[0])),
        rule(T('N: منتج أو تغيير جديد (يحتاج قراءتك)', 'N: something new (needs your reading)'), null, null),
        rule(T('L: أقوى من السوق خلال سنة', 'L: stronger than the market over a year'), ok(me) && ok(mkt) ? me > mkt : null, ok(me) && ok(mkt) ? `${pct(me)} / ${pct(mkt)}` : pct(me), true),
        rule(T('I: المؤسسات تزيد أسهمها', 'I: institutions are adding shares'), institutions && ok(institutions.increased) && ok(institutions.decreased) ? institutions.increased > institutions.decreased : null, null, true),
        rule(T('M: السوق فوق متوسطه الطويل', 'M: the market is above its long average'), bench && bench.length >= 200 ? at(bench, 0) > sma(bench, 200) : null, null, true),
      ];
    },
  },
  minervini: {
    name: T('مارك مينرفيني', 'Mark Minervini'), idea: T('قالب الاتجاه: لا تشترِ إلا سهمًا في صعود واضح', 'The trend template: buy only a clear uptrend'), needs: 'price',
    rules: ({ bars, bench }) => {
      const px = at(bars, 0); const a50 = sma(bars, 50); const a150 = sma(bars, 150); const a200 = sma(bars, 200); const was = sma(bars, 200, 21);
      const yr = bars.length >= 250 ? bars.slice(-252) : null; const hi = yr ? Math.max(...yr.map((b) => b.high)) : null; const lo = yr ? Math.min(...yr.map((b) => b.low)) : null;
      const both = (x, y, f) => (ok(x) && ok(y) ? f(x, y) : null); const me = momentum(bars); const mkt = momentum(bench);
      return [
        rule(T('السعر فوق متوسطي 150 و200', 'Price above the 150 and 200 averages'), ok(a200) ? px > a150 && px > a200 : null, null),
        rule(T('متوسط 150 فوق متوسط 200', 'The 150 average above the 200'), both(a150, a200, (x, y) => x > y), null),
        rule(T('متوسط 200 يرتفع منذ شهر', 'The 200 average rising for a month'), both(a200, was, (x, y) => x > y), ok(a200) && ok(was) ? pct(a200 / was - 1, 1) : null),
        rule(T('متوسط 50 فوق 150 و200', 'The 50 average above the 150 and 200'), ok(a200) ? a50 > a150 && a50 > a200 : null, null),
        rule(T('السعر فوق متوسط 50', 'Price above the 50 average'), both(px, a50, (x, y) => x > y), ok(a50) ? pct(px / a50 - 1, 1) : null),
        rule(T('أعلى من أدنى سعر في سنة بـ30% على الأقل', 'At least 30% above the one-year low'), both(px, lo, (x, y) => x >= y * 1.3), ok(lo) ? pct(px / lo - 1) : null),
        rule(T('ضمن 25% من أعلى سعر في سنة', 'Within 25% of the one-year high'), both(px, hi, (x, y) => x >= y * 0.75), ok(hi) ? pct(px / hi - 1) : null),
        rule(T('أقوى من السوق', 'Stronger than the market'), both(me, mkt, (x, y) => x > y), both(me, mkt, (x, y) => `${pct(x)} / ${pct(y)}`), true),
      ];
    },
  },
  momentum: {
    name: T('الزخم الأكاديمي', 'Academic momentum'), idea: T('ما صعد خلال سنة، دون آخر شهر، يميل إلى الاستمرار', 'What rose over a year, leaving out the last month, tends to continue'), needs: 'price',
    rules: ({ bars, bench }) => { const m = skip(bars); const b = skip(bench); const six = ok(at(bars, 126)) && ok(at(bars, 21)) ? at(bars, 21) / at(bars, 126) - 1 : null; return [
      rule(T('عائد 12 شهرًا دون آخر شهر موجب', '12-month return without the last month is positive'), cmp(m, (x) => x > 0), pct(m)),
      rule(T('وأعلى من السوق في المدة نفسها', 'And above the market over the same time'), ok(m) && ok(b) ? m > b : null, pct(b)),
      rule(T('عائد 6 أشهر دون آخر شهر موجب', '6-month return without the last month is positive'), cmp(six, (x) => x > 0), pct(six)),
    ]; },
  },
};
function momentum(bars) { return bars && ok(at(bars, 252)) ? at(bars, 0) / at(bars, 252) - 1 : null; }
function skip(bars) { return bars && ok(at(bars, 252)) ? at(bars, 21) / at(bars, 252) - 1 : null; }

function verdict(all) {
  const rules = all.filter((r) => !r.gate);
  const known = rules.filter((r) => r.state !== 'UNKNOWN').length; const passed = rules.filter((r) => r.state === 'PASS').length;
  if (all.some((r) => r.gate && r.state === 'FAIL')) return { known, passed, total: rules.length, result: 'NOT' };
  if (!known || known < rules.length / 2) return { known, passed, total: rules.length, result: 'UNKNOWN' };
  const share = passed / known;
  return { known, passed, total: rules.length, result: share >= 0.75 ? 'FITS' : share >= 0.5 ? 'PARTLY' : 'NOT' };
}

/** One symbol through every method. facts may be null (demo prices, crypto, or not reached yet). */
function lens({ bars, bench = [], facts = null, rank = null }) {
  const s = facts && facts.statements; const h = facts && facts.health; const n = numbers(s, h);
  const out = [];
  for (const [id, m] of Object.entries(METHODS)) {
    if (m.needs === 'company' && !(s && h)) { out.push({ id, name: m.name, idea: m.idea, needs: m.needs, rules: [], known: 0, passed: 0, total: 0, result: 'UNKNOWN' }); continue; }
    const rules = m.rules({ s, h, n, bars: bars || [], bench, sector: facts && facts.sector, institutions: facts && facts.institutions, rank });
    out.push({ id, name: m.name, idea: m.idea, needs: m.needs, rules, ...verdict(rules) });
  }
  return { methods: out, fits: out.filter((m) => m.result === 'FITS').length, judged: out.filter((m) => m.result !== 'UNKNOWN').length, distress: h && ok(h.altman) ? { score: Math.round(h.altman * 100) / 100, zone: h.altman > 2.99 ? 'SAFE' : h.altman >= 1.81 ? 'GREY' : 'DISTRESS' } : null, period: s ? s.period : null };
}

/** Places of each symbol inside the list for the two ranked measures. */
function ranks(list) {
  const rows = list.map((x) => ({ symbol: x.symbol, n: numbers(x.facts && x.facts.statements, x.facts && x.facts.health) })).filter((x) => x.n && ok(x.n.earningsYield) && ok(x.n.returnOnCapital));
  if (rows.length < 3) return {};
  const place = (k) => new Map([...rows].sort((a, b) => b.n[k] - a.n[k]).map((x, i) => [x.symbol, i + 1]));
  const y = place('earningsYield'); const c = place('returnOnCapital');
  return Object.fromEntries(rows.map((x) => [x.symbol, { yield: y.get(x.symbol), capital: c.get(x.symbol), of: rows.length }]));
}

const DAY = 86400000;
/** Keeps company facts for half a day and fetches them one symbol at a time. */
class InvestorService {
  constructor({ desk, lab, getBars, publicData = false, gatherImpl, isCrypto, now = Date.now }) { Object.assign(this, { desk, lab, getBars, publicData, gatherImpl, isCrypto, now }); this.facts = new Map(); this.busy = null; this.bench = null; }
  lensOf(facts, bars) { return lens({ bars, bench: (this.bench && this.bench.bars) || [], facts }); }
  wants(a) { return this.publicData && a.dataMode === 'LIVE' && !this.isCrypto(a.symbol); }
  fresh(x) { return x && this.now() - x.at < (x.facts ? DAY / 2 : 900000); }
  async fill() {
    if (this.busy) return;
    const a = this.desk.all().find((x) => this.wants(x) && !this.fresh(this.facts.get(x.symbol)));
    if (!a) return;
    this.busy = a.symbol;
    let facts = null;
    try { const f = await this.gatherImpl(a.symbol); facts = f && f.statements ? f : null; } catch { /* stays unknown, tried again later */ }
    this.facts.set(a.symbol, { at: this.now(), facts });
    this.busy = null;
    this.fill();
  }
  async status() {
    this.fill();
    const agents = this.desk.all();
    if (!this.bench || this.now() - this.bench.at > 3600000) this.bench = { at: this.now(), bars: await this.lab.benchmark(false) };
    const list = agents.map((a) => ({ a, symbol: a.symbol, facts: this.wants(a) ? (this.facts.get(a.symbol) || {}).facts || null : null }));
    const places = ranks(list); const items = [];
    for (const x of list) {
      let bars = [];
      try { bars = (await this.getBars(x.symbol)).daily; } catch { /* price rules stay unknown */ }
      const crypto = this.isCrypto(x.symbol);
      items.push({ symbol: x.symbol, name: x.a.dataMode === 'LIVE' && x.a.asset ? x.a.asset.name : null, sector: x.facts ? x.facts.sector : null, crypto, live: x.a.dataMode === 'LIVE', loading: this.wants(x.a) && !this.fresh(this.facts.get(x.symbol)), hasCompany: !!x.facts, ...lens({ bars, bench: crypto ? [] : this.bench.bars, facts: x.facts, rank: places[x.symbol] || null }) });
    }
    return { items, companyData: this.publicData, loading: this.busy, at: this.now() };
  }
}

module.exports = { lens, ranks, numbers, cagr, verdict, METHODS, InvestorService };
