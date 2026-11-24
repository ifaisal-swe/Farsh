'use strict';
/**
 * Watches every symbol of one account, keeps the current call for each, tells the person when an opportunity or a
 * reason to sell appears, and grades its own calls by what the price did afterwards. It never places an order.
 */
const { decide, temper } = require('./decide');
const { newId } = require('../util/misc');

const DAY = 86400000;
const KEEP = 200;
const REVIEWS_PER_DAY = 10;
const BUYS = new Set(['BUY', 'BUY_AT']);
const SELLS = new Set(['SELL', 'SELL_PART']);
const bad = (m, status = 400) => Object.assign(new Error(m), { status });

class OpportunityService {
  constructor({ store, desk, lab, investors, sharia, getBars, technical, catalysts = [], earningsDate = null, isCrypto, activity, now = Date.now }) {
    Object.assign(this, { store, desk, lab, investors, sharia, getBars, technical, catalysts, earningsDate, isCrypto, activity, now });
    this.calls = new Map(); this.scannedAt = null; this.busy = false; this.reviewing = null; this.dates = new Map();
    this.tracked = this.get('opportunity.tracked', []);
    this.reviews = this.get('opportunity.reviews', {});
    this.told = this.get('opportunity.told', {});
    this.used = this.get('opportunity.used', []);
  }

  get(k, d) { try { return this.store.getSetting(k, d) || d; } catch { return d; } }
  put(k, v) { try { this.store.setSetting(k, v); } catch (e) { if (this.activity) this.activity.warn(`Opportunities could not be saved: ${e.message}`); } }
  mode() { return this.desk.dataMode; }
  sid() { return this.desk.book.session ? this.desk.book.session.id : null; }

  /** Dated things ahead: the company's own results, and market-wide events from the dated research file. */
  async ahead(symbol) {
    const out = [];
    for (const c of this.catalysts) { const at = Date.parse(`${c.date}T14:00:00Z`); const text = `${c.label.en} ${c.label.ar}`; if (Number.isFinite(at)) out.push({ at, label: c.label, own: new RegExp(`\\b${symbol.replace(/[^A-Z]/g, '')}\\b`).test(text) }); }
    const own = this.mode() === 'LIVE' && this.earningsDate && !this.isCrypto(symbol);
    if (own) {
      const c = this.dates.get(symbol);
      if (!c || this.now() - c.at > DAY / 2) { let v = null; try { v = await this.earningsDate(symbol); } catch { v = null; } this.dates.set(symbol, { at: this.now(), v }); }
      const v = this.dates.get(symbol).v;
      if (v) out.push({ at: v, label: { ar: `إعلان أرباح ${symbol}`, en: `${symbol} earnings report` }, own: true });
    }
    return out;
  }

  account() {
    const p = this.desk.primary.publicState().portfolio; const r = this.desk.primary.cfg().risk || {};
    return p ? { equity: p.equity, cash: p.cash, riskPct: r.maxRiskPerTradePct, maxPositionPct: r.maxPositionPct } : null;
  }

  async evaluate(a, account) {
    const { daily, hourly } = await this.getBars(a.symbol);
    const price = (a.market && a.market.mark()) || (daily.length ? daily[daily.length - 1].close : null);
    const live = a.dataMode === 'LIVE'; const held = this.desk.positions().find((p) => p.symbol === a.symbol) || null;
    const tech = this.technical.analyze({ daily, hourly, price, held: held ? held.qty : 0 });
    const facts = live && this.investors ? (this.investors.facts.get(a.symbol) || {}).facts || null : null;
    const rep = this.lab && this.lab.reports[a.symbol]; const fresh = rep && this.now() - rep.at < DAY * 1.5 ? rep.verdict : null;
    let status = null;
    if (live) { try { status = this.sharia.effective(a.symbol).status; } catch { status = 'UNKNOWN'; } }
    const lens = facts && this.investors.lensOf ? this.investors.lensOf(facts, daily) : null;
    const now = this.now();
    const call = decide({ symbol: a.symbol, price, bars: daily, tech, lens, facts, lab: live ? fresh : null, sharia: status, position: held, account, events: await this.ahead(a.symbol), live, fresh: a.market && a.market.freshness ? !a.market.freshness(now).stale : true, crypto: this.isCrypto(a.symbol), now });
    const news = facts && facts.news ? facts.news.items.slice(0, 4).map((n) => ({ title: n.title, url: n.url, at: n.at, tone: n.tone })) : [];
    const rv = this.reviews[a.symbol];
    const review = rv && rv.mode === this.mode() && now - rv.at < DAY && rv.action === call.action ? rv : null;
    return { ...temper(call, review), raw: call.action, sharia: status, name: live && a.asset ? a.asset.name : null, news, review: review ? { stance: review.stance, why: review.why, risks: review.risks, scenarios: review.scenarios, at: review.at } : null, at: now };
  }

  async scan() {
    if (this.busy || !this.sid()) return;
    this.busy = true;
    try {
      const account = this.account(); const seen = new Set();
      for (const a of this.desk.all()) {
        if (!a.symbol || !a.provider) continue;
        seen.add(a.symbol);
        try { const c = await this.evaluate(a, account); this.calls.set(a.symbol, c); this.notify(c); } catch (e) { if (this.activity) this.activity.warn(`Opportunity check of ${a.symbol} failed: ${e.message}`, { source: 'opportunity' }); }
        await new Promise((r) => { setImmediate(r); });
      }
      for (const s of [...this.calls.keys()]) if (!seen.has(s)) this.calls.delete(s);
      this.follow();
      this.scannedAt = this.now();
    } finally { this.busy = false; }
  }

  notify(c) {
    const key = `${this.mode()}|${this.sid()}|${c.symbol}`; const was = this.told[key];
    const kind = BUYS.has(c.action) && !c.blocked ? 'BUY' : SELLS.has(c.action) ? c.action : null;
    if (kind === (was && was.kind) || (!kind && !was)) return;
    // an old opportunity is announced again only after a quiet day, so a call that flickers does not flood anyone
    if (kind && was && was.lastKind === kind && this.now() - was.at < DAY) { this.told[key] = { ...was, kind }; this.put('opportunity.told', this.told); return; }
    this.told[key] = { kind, lastKind: kind || (was && was.lastKind), at: kind ? this.now() : was ? was.at : 0 };
    const keys = Object.keys(this.told); for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete this.told[k];
    this.put('opportunity.told', this.told);
    if (kind) this.desk.emitEvent('OPPORTUNITY', c.symbol, { action: c.action, price: c.price, entry: c.plan && c.plan.entry, stop: c.plan && c.plan.stop, target: c.plan && c.plan.target, why: c.why, confidence: c.confidence }, kind === 'BUY' ? 'normal' : 'high');
    if (kind === 'BUY') this.track(c);
  }

  // ------------------------------------------------------------------ its own record
  track(c) {
    if (this.tracked.some((t) => t.symbol === c.symbol && t.session === this.sid() && ['WAITING', 'ACTIVE'].includes(t.status))) return;
    this.tracked.push({ id: newId('opp'), symbol: c.symbol, mode: this.mode(), session: this.sid(), at: this.now(), type: c.plan.type, entry: c.plan.entry, stop: c.plan.stop, target: c.plan.target, confidence: c.confidence, status: c.plan.type === 'MARKET' ? 'ACTIVE' : 'WAITING', startedAt: c.plan.type === 'MARKET' ? this.now() : null });
    this.tracked = this.tracked.slice(-KEEP);
    this.put('opportunity.tracked', this.tracked);
  }

  follow() {
    let changed = false; const now = this.now();
    const end = (t, status, price) => { t.status = status; t.endedAt = now; if (price) t.result = Math.round((price / t.entry - 1) * 10000) / 10000; changed = true; };
    for (const t of this.tracked) {
      if (!['WAITING', 'ACTIVE'].includes(t.status)) continue;
      if (t.session !== this.sid()) { end(t, 'DROPPED'); continue; }
      const c = this.calls.get(t.symbol); if (!c || !(c.price > 0)) continue;
      const p = c.price;
      if (t.status === 'WAITING') {
        if (t.type === 'LIMIT' ? p <= t.entry : p >= t.entry) { t.status = 'ACTIVE'; t.startedAt = now; changed = true; } else if (now - t.at > 7 * DAY) { end(t, 'EXPIRED'); continue; } else continue;
      }
      // a gap through the stop is graded at the worse price that was really there
      if (p <= t.stop) end(t, 'STOPPED', Math.min(p, t.stop)); else if (p >= t.target) end(t, 'REACHED', t.target); else if (now - t.startedAt > 28 * DAY) end(t, 'ENDED', p);
    }
    if (changed) this.put('opportunity.tracked', this.tracked);
  }

  record() {
    const mine = this.tracked.filter((t) => t.mode === this.mode()); const done = mine.filter((t) => typeof t.result === 'number');
    const won = done.filter((t) => t.result > 0).length;
    return { open: mine.filter((t) => ['WAITING', 'ACTIVE'].includes(t.status)).length, done: done.length, won, lost: done.length - won, average: done.length ? done.reduce((a, t) => a + t.result, 0) / done.length : null, reached: mine.filter((t) => t.status === 'REACHED').length, stopped: mine.filter((t) => t.status === 'STOPPED').length, expired: mine.filter((t) => t.status === 'EXPIRED').length, list: mine.slice(-30).reverse() };
  }

  // ------------------------------------------------------------------ the agents' review
  left() { this.used = this.used.filter((t) => this.now() - t < DAY); return Math.max(0, REVIEWS_PER_DAY - this.used.length); }
  async review(symbolIn, lang = 'ar') {
    const symbol = String(symbolIn || '').trim().toUpperCase(); const a = this.desk.agent(symbol);
    if (!a) throw bad('Add the symbol to your list first');
    const model = this.lab && this.lab.getModel();
    if (!model) throw bad('The team of analysts is not connected');
    if (this.reviewing) throw bad('An analysis is already running', 409);
    if (this.left() < 1) throw bad('Today\'s reviews are used up', 429);
    const job = { symbol, steps: {}, at: this.now() }; this.reviewing = job;
    this.used.push(this.now()); this.put('opportunity.used', this.used); // a failed review still used the model
    try {
      const call = await this.evaluate(a, this.account());
      const { review: _, ...facts } = call;
      const r = await this.lab.work({ task: 'opportunity', evidence: facts, model, lang: lang === 'en' ? 'en' : 'ar' }, job);
      this.reviews[symbol] = { ...r, at: this.now(), mode: this.mode(), action: call.raw };
      const keys = Object.keys(this.reviews).sort((x, y) => this.reviews[y].at - this.reviews[x].at); for (const k of keys.slice(20)) delete this.reviews[k];
      this.put('opportunity.reviews', this.reviews);
      const c = await this.evaluate(a, this.account()); this.calls.set(symbol, c);
      return c;
    } finally { this.reviewing = null; }
  }

  status() {
    const order = { SELL: 0, SELL_PART: 1, BUY: 2, BUY_AT: 3, WAIT: 4, HOLD: 5, WATCH: 6, AVOID: 7, UNKNOWN: 8 };
    const items = [...this.calls.values()].sort((a, b) => (order[a.action] - order[b.action]) || b.score - a.score);
    return { session: !!this.sid(), live: this.mode() === 'LIVE', scannedAt: this.scannedAt, items, record: this.record(), agentsReady: !!(this.lab && this.lab.getModel()), reviewsLeft: this.left(), reviewing: this.reviewing ? { symbol: this.reviewing.symbol, steps: this.reviewing.steps } : null };
  }
}

/** "Earnings announcement* for AAPL: Jan 28, 2027" -> milliseconds, or null. */
function parseEarningsDate(text) { const m = /:\s*([A-Z][a-z]{2})[a-z]*\.?\s+(\d{1,2}),\s*(\d{4})/.exec(String(text || '')); const t = m ? Date.parse(`${m[1]} ${m[2]}, ${m[3]} 21:00 UTC`) : NaN; return Number.isFinite(t) ? t : null; }

module.exports = { OpportunityService, parseEarningsDate };
