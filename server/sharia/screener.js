'use strict';
/**
 * Sharia screening (AAOIFI-style thresholds). Deterministic, and it FAILS CLOSED: a symbol is buyable only
 * when every test passes on recent, complete data, or when the user recorded a dated result with its source.
 *
 *   1. business activity  SEC SIC code + company name against excluded activities
 *   2. debt               interest-bearing debt / market cap            < maxDebtPct
 *   3. deposits           cash + short/long-term securities / market cap < maxDepositsPct (upper bound: XBRL
 *                         does not say which balances earn interest, so ALL of them are counted)
 *   4. income             interest / investment income / revenue         < maxIncomePct (a filing that does
 *                         not report it separately is UNKNOWN, never zero)
 *
 * mode FULL applies all four. mode BUSINESS applies only the company's activity (the account owner's choice): the
 * ratios are still shown when known but do not decide. Doubtful activities stay UNKNOWN in both modes.
 *
 * This is an automated pre-screen: XBRL cannot show every impermissible revenue line. It only
 * decides whether NEW entries are allowed. It never sells anything and never blocks an exit.
 */
const { fetchJson } = require('../util/http');

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', UNKNOWN: 'UNKNOWN' };
const DAY = 86400000;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** SIC ranges whose core business is excluded. */
const SIC_EXCLUDED = [
  [2082, 2085, 'alcohol'], [2100, 2199, 'tobacco'], [5180, 5182, 'alcohol wholesale'], [5813, 5813, 'bars'], [5921, 5921, 'liquor stores'],
  [5194, 5194, 'tobacco wholesale'], [6000, 6199, 'conventional banking / lending'], [6200, 6299, 'conventional brokerage / finance'],
  [6300, 6411, 'conventional insurance'], [7990, 7990, 'gambling / amusement'], [7993, 7993, 'gambling'],
  [2011, 2013, 'meat processing (pork exposure unverified)'], [3480, 3489, 'weapons'],
];
/** Activities that need a human decision: the code alone cannot decide. */
const SIC_REVIEW = [[6700, 6799, 'holding / investment vehicle'], [7011, 7011, 'hotels (alcohol, gambling)'], [7810, 7841, 'film / entertainment'], [4830, 4841, 'broadcasting'], [5800, 5812, 'restaurants'], [5411, 5411, 'grocery (alcohol, pork)']];
const NAME_EXCLUDED = /\b(casino|brewing|brewery|distill\w*|winery|tobacco|cannabis|gaming & leisure|bancorp|bank|insurance)\b/i;

/** Industry labels are coarse (one label covers soft drinks and beer), so only clearly permissible ones pass. */
const INDUSTRY_OK = /^(semiconductors|computer manufacturing|computer software|computer communications equipment|computer peripheral|electronic components|electrical products|electronics distribution|edp services|radio and television broadcasting and communications equipment|telecommunications equipment|auto manufacturing|auto parts|automotive aftermarket|industrial machinery|industrial specialties|fluid controls|construction\/ag equipment|metal fabrications|steel\/iron ore|aluminum|precious metals|other metals and minerals|mining & quarrying|integrated oil companies|oil & gas production|oil\/gas transmission|oilfield services|natural gas distribution|electric utilities|power generation|water supply|major chemicals|specialty chemicals|agricultural chemicals|building materials|building products|homebuilding|engineering & construction|railroads|trucking freight|air freight|marine transportation|medical\/dental instruments|medical specialities|medical electronics|biotechnology: (pharmaceutical preparations|biological products|electromedical|laboratory|in vitro|commercial physical)|ophthalmic goods|apparel|shoe manufacturing|textiles|home furnishings|paints\/coatings|paper|containers\/packaging|environmental services|pollution control|professional services)/i;
const INDUSTRY_BAD = /\b(bank|banks|savings institutions|finance companies|finance: consumer|investment bankers|insurance|insurers|investment managers|tobacco|ordnance|casino|gambling|brew|distill|wine)/i;
const NAME_REVIEW = /\b(casino|casinos|gaming|betting|lottery|sportsbook|brewing|brewery|beer|wine|winery|spirits|distill\w*|tobacco|cannabis|pork|bancorp|bank|insurance|defen[cs]e|weapons|adult|bitcoin|crypto)\b/i;
/** Decides from a public industry label. Anything not clearly one or the other is UNKNOWN. */
function business({ name = '', sector = '', industry = '', isFund = false }) {
  const label = String(industry || '').trim();
  if (isFund) return { status: STATUS.UNKNOWN, detail: 'Fund or ETF: holdings must be screened separately' };
  if (!label || label === 'N/A') return { status: STATUS.UNKNOWN, detail: 'Activity not published' };
  if (INDUSTRY_BAD.test(label)) return { status: STATUS.FAIL, detail: label };
  if (NAME_REVIEW.test(name)) return { status: STATUS.UNKNOWN, detail: `Company name needs review: ${name}` };
  if (/^finance$/i.test(String(sector).trim())) return { status: STATUS.UNKNOWN, detail: `${label} needs review` };
  return INDUSTRY_OK.test(label) ? { status: STATUS.PASS, detail: label } : { status: STATUS.UNKNOWN, detail: `${label} needs review` };
}

const inRange = (list, sic) => list.find(([a, b]) => sic >= a && sic <= b);

/** Latest value of a concept: the newest period end, then the newest filing. flow: annual (10-K) values only. */
function latest(facts, names, { flow = false } = {}) {
  let best = null;
  for (const ns of ['us-gaap', 'ifrs-full']) {
    for (const name of names) {
      const usd = facts && facts[ns] && facts[ns][name] && facts[ns][name].units && facts[ns][name].units.USD;
      for (const v of usd || []) {
        if (!isNum(v.val) || !v.end) continue;
        if (flow) {
          const days = v.start ? (Date.parse(v.end) - Date.parse(v.start)) / DAY : 0;
          if (days < 350 || days > 380) continue;
        } else if (v.start) continue;
        if (!best || v.end > best.end || (v.end === best.end && String(v.filed) > String(best.filed))) best = { val: v.val, end: v.end, filed: v.filed, form: v.form, concept: name };
      }
    }
  }
  return best;
}

/** Interest-bearing debt at one balance-sheet date. Null when the filing does not report debt at all. */
function debtAt(facts, end) {
  const at = (names) => { const x = latest(facts, names); return x && x.end === end ? x.val : null; };
  const longTotal = at(['LongTermDebt', 'DebtLongtermAndShorttermCombinedAmount', 'LongTermDebtAndCapitalLeaseObligationsIncludingCurrentMaturities']);
  const nc = at(['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations']);
  const cur = at(['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent', 'DebtCurrent']);
  const st = at(['ShortTermBorrowings', 'CommercialPaper']);
  if (longTotal == null && nc == null && cur == null && st == null) return null;
  const parts = (nc || 0) + (cur || 0);
  return Math.max(longTotal || 0, parts) + (st || 0);
}

/**
 * Pure evaluation. input: { symbol, name, sic, isFund, facts, marketCap, now }
 * Returns { status, checks: [{ id, status, value, limit, detail, asOf }], asOf }
 */
function evaluate(input, cfg) {
  const { name = '', sic, isFund, facts, marketCap, now } = input;
  const checks = [];
  const add = (id, status, o = {}) => checks.push({ id, status, value: null, limit: null, asOf: null, detail: '', ...o });

  const code = Number(sic);
  if (isFund) add('business', STATUS.UNKNOWN, { detail: 'Fund or ETF: holdings must be screened separately' });
  else if (!code) add('business', STATUS.UNKNOWN, { detail: 'No SIC code available' });
  else {
    const bad = inRange(SIC_EXCLUDED, code);
    const rev = inRange(SIC_REVIEW, code);
    if (bad) add('business', STATUS.FAIL, { detail: `SIC ${code}: ${bad[2]}` });
    else if (NAME_EXCLUDED.test(name)) add('business', STATUS.UNKNOWN, { detail: `Company name needs review: ${name}` });
    else if (rev) add('business', STATUS.UNKNOWN, { detail: `SIC ${code}: ${rev[2]} needs review` });
    else add('business', STATUS.PASS, { detail: `SIC ${code}` });
  }

  const assets = latest(facts, ['Assets']);
  const balanceFresh = assets && now - Date.parse(assets.end) <= cfg.maxBalanceAgeDays * DAY;
  const capOk = isNum(marketCap) && marketCap > 0;
  const why = !assets ? 'No balance sheet in SEC data' : !balanceFresh ? `Balance sheet of ${assets.end} is too old` : !capOk ? 'Market capitalization unavailable' : null;

  const ratio = (id, amount, limit, missing) => {
    if (why) return add(id, STATUS.UNKNOWN, { limit, detail: why });
    if (amount == null) return add(id, STATUS.UNKNOWN, { limit, detail: missing });
    const value = (amount / marketCap) * 100;
    return add(id, value < limit ? STATUS.PASS : STATUS.FAIL, { value, limit, asOf: assets.end, detail: `${Math.round(amount / 1e6)}M / ${Math.round(marketCap / 1e6)}M` });
  };
  ratio('debt', why ? null : debtAt(facts, assets.end), cfg.maxDebtPct, 'Debt not reported at the balance-sheet date');

  let deposits = null;
  if (!why) {
    const at = (names) => { const x = latest(facts, names); return x && x.end === assets.end ? x.val : null; };
    const combined = at(['CashCashEquivalentsAndShortTermInvestments']);
    const cash = at(['CashAndCashEquivalentsAtCarryingValue', 'CashAndCashEquivalents']);
    const sti = at(['ShortTermInvestments', 'MarketableSecuritiesCurrent', 'AvailableForSaleSecuritiesDebtSecuritiesCurrent']);
    const lti = at(['MarketableSecuritiesNoncurrent', 'LongTermInvestments', 'AvailableForSaleSecuritiesDebtSecuritiesNoncurrent']);
    if (combined != null || cash != null) deposits = Math.max(combined || 0, (cash || 0) + (sti || 0)) + (lti || 0);
  }
  ratio('deposits', deposits, cfg.maxDepositsPct, 'Cash not reported at the balance-sheet date');

  const rev = latest(facts, ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'Revenue'], { flow: true });
  const inc = latest(facts, ['InvestmentIncomeInterest', 'InvestmentIncomeInterestAndDividend', 'InterestIncomeOther', 'InterestAndOtherIncome', 'InterestIncomeNonOperating'], { flow: true });
  if (!rev || !(rev.val > 0)) add('income', STATUS.UNKNOWN, { limit: cfg.maxIncomePct, detail: 'Annual revenue not available' });
  else if (now - Date.parse(rev.end) > cfg.maxIncomeAgeDays * DAY) add('income', STATUS.UNKNOWN, { limit: cfg.maxIncomePct, detail: `Annual figures of ${rev.end} are too old` });
  else if (!inc || inc.end !== rev.end) add('income', STATUS.UNKNOWN, { limit: cfg.maxIncomePct, detail: 'Interest income not reported separately for the same year' });
  else {
    const value = (Math.abs(inc.val) / rev.val) * 100;
    add('income', value < cfg.maxIncomePct ? STATUS.PASS : STATUS.FAIL, { value, limit: cfg.maxIncomePct, asOf: rev.end, detail: 'interest income / revenue' });
  }
  const status = checks.some((c) => c.status === STATUS.FAIL) ? STATUS.FAIL : checks.some((c) => c.status === STATUS.UNKNOWN) ? STATUS.UNKNOWN : STATUS.PASS;
  return { status, checks, asOf: assets ? assets.end : null };
}

const { isCrypto } = require('../market/crypto');
const SYMBOL = { test: (s) => /^[A-Z][A-Z0-9.]{0,9}$/.test(s) || isCrypto(s) };
const KEY = 'sharia.state';

class ShariaService {
  /** priceOf(symbol) -> last price or null. onChange(result, previousStatus) is called when a status changes. */
  constructor({ store, getConfig, getSecret, priceOf, fetchImpl, now = Date.now, onChange = () => {}, publicProfile = null }) {
    Object.assign(this, { store, getConfig, getSecret, priceOf, fetchImpl, now, onChange, publicProfile });
    const s = (store && store.getSetting(KEY, null)) || {};
    this.results = s.results || {};
    this.rulings = s.rulings || {};
    this.inFlight = new Map();
    this.tickers = null;
    this.tickersAt = 0;
  }

  cfg() { return this.getConfig().sharia; }
  save() { if (this.store) this.store.setSetting(KEY, { results: this.results, rulings: this.rulings }); }

  /** What the chosen mode says about an automatic result. */
  verdictOf(auto) {
    if (this.cfg().mode !== 'BUSINESS') return auto.status;
    const b = (auto.checks || []).find((c) => c.id === 'business');
    return b ? b.status : STATUS.UNKNOWN;
  }

  canScreen() { return !!this.getSecret('SEC_USER_AGENT') || !!this.publicProfile; }

  /** Effective status: an unexpired user result wins, then a fresh automatic result, else UNKNOWN. */
  effective(symbol) {
    const c = this.cfg();
    const auto = this.results[symbol] || null;
    const r = this.rulings[symbol];
    if (r && this.now() - r.at <= c.rulingValidDays * DAY) return { symbol, status: r.status, basis: 'RULING', ruling: r, auto, checks: auto ? auto.checks : [] };
    const fresh = auto && this.now() - auto.at <= c.resultValidDays * DAY;
    if (fresh) return { symbol, status: this.verdictOf(auto), basis: 'AUTO', auto, checks: auto.checks, name: auto.name };
    return { symbol, status: STATUS.UNKNOWN, basis: auto ? 'EXPIRED' : 'NONE', auto, checks: auto ? auto.checks : [] };
  }

  /** Risk-engine gate for NEW entries. */
  gate(symbol) {
    const c = this.cfg();
    if (!c.enabled) return null;
    const e = this.effective(symbol);
    const bad = e.checks.find((x) => x.status !== STATUS.PASS);
    const detail = e.status === STATUS.PASS ? `Sharia screen passed (${e.basis})` : e.basis === 'NONE' ? 'Sharia screen has not been run' : e.basis === 'EXPIRED' ? 'Sharia screen has expired' : `Sharia screen: ${e.status}${bad && e.basis === 'AUTO' ? ` (${bad.id}: ${bad.detail})` : ''}`;
    return { pass: e.status === STATUS.PASS, status: e.status, detail };
  }

  setRuling(symbol, { status, source, note = '' }) {
    if (!SYMBOL.test(symbol)) throw new Error('Invalid symbol');
    if (![STATUS.PASS, STATUS.FAIL].includes(status)) throw new Error('Ruling must be PASS or FAIL');
    const src = String(source || '').trim();
    if (src.length < 3) throw new Error('A result needs its source (board or screening service)');
    const prev = this.effective(symbol).status;
    this.rulings[symbol] = { status, source: src.slice(0, 200), note: String(note).slice(0, 500), at: this.now() };
    this.save();
    return this.changed(symbol, prev);
  }

  clearRuling(symbol) {
    const prev = this.effective(symbol).status;
    delete this.rulings[symbol];
    this.save();
    return this.changed(symbol, prev);
  }

  changed(symbol, prev) {
    const e = this.effective(symbol);
    if (e.status !== prev) this.onChange(e, prev);
    return e;
  }

  /** Screens one symbol; concurrent calls share a request. A failed fetch keeps the previous dated result. */
  screen(symbol) {
    if (!SYMBOL.test(symbol)) return Promise.reject(new Error('Invalid symbol'));
    if (this.inFlight.has(symbol)) return this.inFlight.get(symbol);
    const p = this._screen(symbol).finally(() => this.inFlight.delete(symbol));
    this.inFlight.set(symbol, p);
    return p;
  }

  async _screen(symbol) {
    if (isCrypto(symbol)) {
      // no financial statements exist: only a sourced result can open the gate
      const before = this.effective(symbol).status;
      this.results[symbol] = { symbol, name: symbol, status: STATUS.UNKNOWN, checks: [{ id: 'business', status: STATUS.UNKNOWN, value: null, limit: null, asOf: null, detail: 'Crypto asset: needs a recorded result' }], asOf: null, at: this.now() };
      this.save();
      return this.changed(symbol, before);
    }
    const ua = this.getSecret('SEC_USER_AGENT');
    if (!ua && !this.publicProfile) throw new Error('SEC_USER_AGENT is not configured: Sharia screening needs SEC data');
    if (!ua) {
      // without filings only the activity can be judged; the ratios stay unknown, so FULL mode never passes here
      const before = this.effective(symbol).status;
      const p = await this.publicProfile(symbol);
      const b = business(p || {});
      const c = this.cfg();
      const none = (id, limit) => ({ id, status: STATUS.UNKNOWN, value: null, limit, asOf: null, detail: 'Company filings are not connected' });
      const checks = [{ id: 'business', status: b.status, value: null, limit: null, asOf: null, detail: b.detail }, none('debt', c.maxDebtPct), none('deposits', c.maxDepositsPct), none('income', c.maxIncomePct)];
      this.results[symbol] = { symbol, name: (p && p.name) || null, status: b.status === STATUS.FAIL ? STATUS.FAIL : STATUS.UNKNOWN, checks, asOf: null, marketCap: null, at: this.now() };
      this.save();
      return this.changed(symbol, before);
    }
    const get = async (url) => (await fetchJson(url, { headers: { 'User-Agent': ua }, timeoutMs: 30000, fetchImpl: this.fetchImpl })).data;
    if (!this.tickers || this.now() - this.tickersAt > DAY / 2) {
      this.tickers = new Map(Object.values(await get('https://www.sec.gov/files/company_tickers.json') || {}).map((r) => [String(r.ticker).toUpperCase(), r.cik_str]));
      this.tickersAt = this.now();
    }
    const prev = this.effective(symbol).status;
    const cik = this.tickers.get(symbol.replace('.', '-')) || (this.getConfig().news.cikOverrides || {})[symbol];
    let input = { symbol, now: this.now() };
    if (cik) {
      const id = String(cik).padStart(10, '0');
      const sub = await get(`https://data.sec.gov/submissions/CIK${id}.json`);
      let cf = null;
      try { cf = await get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${id}.json`); } catch (e) { if (e.status !== 404) throw e; }
      const facts = cf && cf.facts;
      const sh = facts && facts.dei && facts.dei.EntityCommonStockSharesOutstanding;
      const rows = (sh && sh.units && sh.units.shares) || [];
      const end = rows.reduce((m, r) => (r.end > m ? r.end : m), '');
      // dual-class companies report one row per class without a usable total here: ambiguous means unknown
      const vals = [...new Set(rows.filter((r) => r.end === end).map((r) => r.val))];
      const shares = vals.length === 1 && this.now() - Date.parse(end) <= 200 * DAY ? vals[0] : null;
      const price = this.priceOf(symbol);
      input = { ...input, name: sub.name, sic: sub.sic, isFund: /^(6221|6726)$/.test(String(sub.sic)), facts, marketCap: isNum(shares) && isNum(price) ? shares * price : null };
    }
    const res = evaluate(input, this.cfg());
    this.results[symbol] = { ...res, symbol, name: input.name || null, marketCap: input.marketCap || null, at: this.now() };
    this.save();
    return this.changed(symbol, prev);
  }

  /** Amount of a dividend to give away, from the measured impermissible-income share (estimate). */
  purification(symbol, dividends) {
    const c = this.effective(symbol).checks.find((x) => x.id === 'income');
    return c && isNum(c.value) && isNum(dividends) ? { pct: c.value, amount: (dividends * c.value) / 100, asOf: c.asOf } : null;
  }
}

module.exports = { ShariaService, evaluate, business, latest, debtAt, STATUS };
