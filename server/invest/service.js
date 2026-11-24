'use strict';
/**
 * Investments and goals of one account. An investment has an amount, a start price, a stop, a target and an end date.
 * Prices are checked on every quote: reaching the start buys, reaching (or passing) the stop or the target sells.
 * Starting one is the person's own approval; the analysis gate, loss limits and price checks still apply.
 */
const { newId } = require('../util/misc');
const { isCrypto } = require('../market/crypto');
const V = require('./levels');

const DAY = 86400000;
const NEAR = [0, 0.05, 0.1, 0.25, 0.5];
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const num = (x) => (x === '' || x == null ? NaN : Number(x));

class InvestService {
  constructor({ store, desk, lab, activity, now = Date.now }) {
    Object.assign(this, { store, desk, lab, activity, now });
    let s = null;
    try { s = store.getSetting('invest.state', null); } catch { s = null; }
    this.state = s || { session: null, items: [], goals: [] };
    this.job = null; this.tries = new Map(); this.aiCalls = [];
    desk.book.invest = this;
  }

  save() { try { this.store.setSetting('invest.state', this.state); } catch (e) { if (this.activity) this.activity.warn(`Investments could not be saved: ${e.message}`); } }
  sid() { return this.desk.book.session ? this.desk.book.session.id : null; }
  fresh() {
    const id = this.sid();
    if (!id || this.state.session === id) return;
    for (const x of this.state.items) if (this.active(x)) { x.status = 'CANCELLED'; x.end = 'RESET'; x.closedAt = this.now(); }
    this.state.session = id;
    this.save();
  }
  active(x) { return x.status === 'WAITING' || x.status === 'OPEN'; }
  manages(symbol) { return this.state.session === this.sid() && this.state.items.some((x) => x.symbol === symbol && this.active(x)); }
  reserved() { return this.state.session === this.sid() ? this.state.items.filter((x) => x.status === 'WAITING').reduce((a, x) => a + x.amount, 0) : 0; }
  find(id) { const x = this.state.items.find((q) => q.id === id); if (!x) throw bad('That investment was not found', 404); return x; }

  // ------------------------------------------------------------------ the suggestion
  suggest(input) {
    const b = input || {};
    const symbol = String(b.symbol || '').trim().toUpperCase();
    const days = Math.round(num(b.days)); const amount = num(b.amount); const goalPct = num(b.goalPct) > 0 ? num(b.goalPct) : null;
    if (!this.sid()) throw bad('Start a session first');
    if (!symbol) throw bad('Invalid symbol');
    if (!(days >= 1 && days <= 730)) throw bad('Choose how long');
    if (!(amount >= 10)) throw bad('Amount must be at least 10');
    if (goalPct != null && goalPct > 300) throw bad('That gain is too high');
    if (this.job && this.job.state === 'RUNNING') throw bad('An analysis is already running', 409);
    this.job = { state: 'RUNNING', symbol, startedAt: this.now(), step: 'data', input: { symbol, days, amount, goalPct, ai: b.ai !== false } };
    this.work(this.job, b.lang === 'en' ? 'en' : 'ar').catch((e) => { this.job.state = 'FAILED'; this.job.error = e.status ? e.message : 'The analysis could not be completed'; });
    return { ok: true };
  }

  async work(job, lang) {
    const { symbol, days, amount, goalPct, ai } = job.input;
    if (!this.desk.agent(symbol)) { try { await this.desk.addSymbol(symbol); } catch (e) { throw bad(/limit reached/i.test(e.message) ? 'Too many symbols are followed' : `Symbol ${symbol} not found`); } }
    const a = this.desk.agent(symbol);
    for (let i = 0; i < 40 && !(a.market && a.market.mark()); i++) await new Promise((r) => { setTimeout(r, 250).unref(); });
    const bars = await a.provider.fetchBars(symbol, '1d', { limit: 600 });
    const price = (a.market && a.market.mark()) || (bars.length ? bars[bars.length - 1].close : null);
    const model = ai && this.lab && a.dataMode === 'LIVE' ? this.lab.getModel() : null;
    if (this.lab && a.dataMode === 'LIVE') {
      const r = this.lab.reports[symbol];
      if (!r || this.now() - r.at > DAY / 2 || (model && !r.agents)) { job.step = 'team'; try { await this.lab.run(symbol, { lang, agents: ai }); } catch { /* the prices below do not depend on it */ } }
    }
    const rep = this.lab && this.lab.reports[symbol];
    const fresh = rep && this.now() - rep.at < DAY * 1.5 ? rep : null;
    // one calendar month is about 21 trading days for a share
    const sessions = Math.max(1, Math.round(isCrypto(symbol) ? days : (days * 5) / 7));
    let s = V.suggest(bars, price, { days: sessions, goalPct, verdict: fresh ? fresh.verdict : 'UNKNOWN' });
    if (!s) throw bad('Not enough price history');
    let note = '';
    this.aiCalls = this.aiCalls.filter((t) => this.now() - t < DAY);
    if (model && this.aiCalls.length < 20 && !this.lab.running) {
      job.step = 'prices';
      this.aiCalls.push(this.now());
      const j = { symbol, startedAt: this.now(), steps: {}, state: 'RUNNING' };
      this.lab.running = j;
      try {
        const r = await this.lab.work({ task: 'levels', model, lang, evidence: { symbol, priceNow: price, usualDailyMove: s.atr, rules: { start: s.entry, stop: s.stop, target: s.target }, allowed: { start: s.bounds.entry, stopBelowStartInUsualDailyMoves: s.bounds.stopAtr, targetAsMultipleOfRisk: s.bounds.rr }, goalGainPercent: goalPct, tradingDays: sessions, committee: fresh ? { verdict: fresh.verdict, summary: fresh.agents && fresh.agents.summary } : null, recentDays: bars.slice(-30).map((b) => [b.high, b.low, b.close].map(V.tidy)) } }, j);
        s = V.adopt(s, r.answers); note = r.why || '';
      } catch { /* the rules' prices stand */ } finally { if (this.lab.running === j) this.lab.running = null; }
    }
    job.step = 'chances';
    job.result = { symbol, amount, days, price, entry: s.entry, stop: s.stop, target: s.target, goalPct, why: s.why, byAI: !!s.byAI, note, verdict: fresh ? fresh.verdict : null, odds: V.odds(bars, { entry: s.entry, stop: s.stop, target: s.target, days: sessions }), history: bars.slice(-90).map((b) => b.close), at: this.now() };
    job.state = 'DONE';
  }

  // ------------------------------------------------------------------ investments
  check({ entry, stop, target, amount, days, near }) {
    if (![entry, stop, target].every((n) => Number.isFinite(n) && n > 0) || !(stop < entry && entry < target)) throw bad('The stop must be below the start and the target above it');
    if (!(amount >= 10)) throw bad('Amount must be at least 10');
    if (!(days >= 1 && days <= 730)) throw bad('Choose how long');
    if (!NEAR.includes(near)) throw bad('Invalid closeness');
    if (target * (1 - near / 100) <= entry * (1 + near / 100)) throw bad('The stop must be below the start and the target above it');
  }

  create(input) {
    const b = input || {};
    this.fresh();
    if (!this.sid()) throw bad('Start a session first');
    const symbol = String(b.symbol || '').trim().toUpperCase();
    const a = this.desk.agent(symbol);
    if (!a) throw bad('Add the symbol to your list first');
    const v = { entry: num(b.entry), stop: num(b.stop), target: num(b.target), amount: num(b.amount), days: Math.round(num(b.days)), near: b.near == null ? 0.05 : num(b.near) };
    this.check(v);
    if (this.manages(symbol)) throw bad('You already have an investment in this symbol');
    if (this.desk.book.commands && this.desk.book.commands.manages(symbol)) throw bad('You have your own order in this symbol');
    if (this.desk.book.plan && this.desk.book.plan.manages(symbol)) throw bad('This symbol is in your running plan');
    if (this.desk.book.portfolio.position(symbol)) throw bad('You already hold this symbol');
    if (v.amount > this.desk.book.portfolio.cash - this.reserved() - (this.desk.book.commands ? this.desk.book.commands.reserved() : 0)) throw bad('Not enough cash for this amount');
    const now = this.now();
    const r = b.reason === 'AI' ? 'AI' : b.reason === 'RULES' ? 'RULES' : 'OWN';
    const x = { id: newId('inv'), symbol, ...v, follow: !!b.follow, reason: r, status: 'WAITING', createdAt: now, until: now + v.days * DAY, startBy: now + Math.max(1, Math.round(v.days * 0.3)) * DAY, wait: null };
    this.state.items.unshift(x);
    this.state.items = [...this.state.items.filter((q) => this.active(q)), ...this.state.items.filter((q) => !this.active(q)).slice(0, 60)];
    this.save();
    this.onPrice(a);
    return this.status();
  }

  update(id, input) {
    const x = this.find(id);
    if (!this.active(x)) throw bad('That investment has ended');
    const b = input || {};
    const v = { entry: x.status === 'WAITING' && b.entry != null ? num(b.entry) : x.entry, stop: b.stop != null ? num(b.stop) : x.stop, target: b.target != null ? num(b.target) : x.target, amount: x.amount, days: x.days, near: b.near != null ? num(b.near) : x.near };
    if (x.status === 'OPEN') {
      // an open one is judged against the price now, not the price paid, so a gain can be protected
      const px = this.desk.agent(x.symbol) && this.desk.agent(x.symbol).market.mark();
      if (!(v.stop > 0 && v.target > v.stop && NEAR.includes(v.near)) || (px && !(v.stop < px && v.target > px))) throw bad('The stop must be below the price and the target above it');
      const p = this.desk.book.orders.getProtection(x.symbol);
      if (!p) throw bad('That investment has ended');
      p.stopLoss = v.stop; p.takeProfit = v.target; p.nearPct = v.near;
      this.desk.primary.persist();
    } else this.check(v);
    Object.assign(x, { entry: v.entry, stop: v.stop, target: v.target, near: v.near });
    this.save();
    return this.status();
  }

  cancel(id) {
    const x = this.find(id);
    if (x.status === 'WAITING') this.finish(x, 'CANCELLED', 'USER');
    else if (x.status === 'OPEN') { const a = this.desk.agent(x.symbol); const r = a ? a.planSell(null, 'USER', 'USER') : { ok: false }; if (!r.ok) throw bad('market is closed or prices are stale'); this.settle(x); }
    return this.status();
  }

  finish(x, status, end) { x.status = status; x.end = end; x.closedAt = this.now(); x.wait = null; this.save(); }

  settle(x) {
    if (x.status !== 'OPEN' || this.desk.book.portfolio.position(x.symbol)) return;
    let sells = [];
    try { sells = this.store.listFills(this.sid()).filter((f) => f.symbol === x.symbol && f.side === 'SELL' && f.ts >= x.boughtAt).sort((p, q) => p.ts - q.ts); } catch { return; }
    if (!sells.length) return;
    const q = sells.reduce((a, f) => a + f.qty, 0);
    x.soldAt = sells.reduce((a, f) => a + f.qty * f.price, 0) / q;
    x.result = sells.reduce((a, f) => a + (f.realizedPnl || 0), 0);
    this.finish(x, 'CLOSED', sells[sells.length - 1].kind);
  }

  /** Called by the engine on every price of a symbol. */
  onPrice(a) {
    if (!this.state.items.length || this.state.session !== this.sid()) return;
    for (const x of this.state.items) {
      if (x.symbol !== a.symbol) continue;
      if (x.status === 'OPEN') { this.settle(x); continue; }
      if (x.status !== 'WAITING') continue;
      const q = a.market && a.market.quote();
      if (!q || !(q.ask > 0) || !(q.bid > 0)) continue;
      const f = a.market.freshness(this.now());
      if (f.stale) { x.wait = a.planCheck().code || 'PRICE'; continue; }
      if (q.ask > x.entry * (1 + x.near / 100)) { x.wait = 'START'; continue; }
      if (this.desk.book.aiState !== 'RUNNING') { x.wait = 'AUTOMATION'; continue; }
      if (this.now() - (this.tries.get(x.id) || 0) < 5000) continue;
      this.tries.set(x.id, this.now());
      // the price already passed the stop: the reason for buying is gone (a closed market only means waiting)
      const c = a.planCheck();
      if (!c.ok) { x.wait = c.code; continue; }
      if (q.bid <= x.stop) { this.finish(x, 'CANCELLED', 'PASSED'); continue; }
      const prot = { stopLoss: x.stop, takeProfit: x.target, trailingStopPct: x.follow ? Math.round(((x.entry - x.stop) / x.entry) * 10000) / 100 : null, nearPct: x.near };
      const r = a.planBuy(x.amount, 'INVEST', x.amount, { kind: 'GOAL', protect: prot });
      if (!r.ok) { x.wait = r.code; continue; }
      const pos = this.desk.book.portfolio.position(x.symbol);
      Object.assign(x, { status: 'OPEN', wait: null, boughtAt: this.now(), qty: pos ? pos.qty : null, paid: pos ? pos.avgPrice : null });
      this.save();
    }
  }

  tick() {
    if (!this.sid()) return;
    this.fresh();
    for (const x of this.state.items) {
      if (!this.active(x)) continue;
      const a = this.desk.agent(x.symbol);
      if (x.status === 'OPEN') {
        this.settle(x);
        if (x.status === 'OPEN' && this.now() >= x.until && a && this.desk.book.aiState === 'RUNNING' && this.now() - (this.tries.get(x.id) || 0) > 30000) { this.tries.set(x.id, this.now()); a.planSell(null, 'DEADLINE', 'GOAL'); this.settle(x); }
      } else if (this.now() >= Math.min(x.startBy, x.until)) this.finish(x, 'EXPIRED', 'TIME');
      else if (a) this.onPrice(a);
    }
  }

  // ------------------------------------------------------------------ goals
  equity() { const p = this.desk.primary; return p && p.portfolio && this.sid() ? p.valuation().equity : null; }
  addGoal(input) {
    const b = input || {};
    this.fresh();
    const name = String(b.name || '').trim().slice(0, 40); const amount = num(b.amount); const by = Date.parse(`${b.by}T00:00:00Z`);
    const eq = this.equity();
    if (eq == null) throw bad('Start a session first');
    if (!name) throw bad('Name the goal');
    if (!(amount > 0 && amount < 1e9)) throw bad('Amount must be at least 10');
    if (!(by > this.now() + DAY && by < this.now() + 50 * 365 * DAY)) throw bad('Choose a later date');
    if (this.state.goals.length >= 8) throw bad('At most eight goals');
    this.state.goals.push({ id: newId('goal'), name, amount, by, createdAt: this.now(), from: eq });
    this.save();
    return this.status();
  }
  removeGoal(id) { this.state.goals = this.state.goals.filter((g) => g.id !== id); this.save(); return this.status(); }

  status() {
    this.fresh();
    const eq = this.equity();
    const items = this.state.items.slice(0, 40).map((x) => {
      const a = this.desk.agent(x.symbol);
      const price = a && a.market ? a.market.mark() : null;
      const stop = x.status === 'OPEN' ? this.desk.book.orders.effectiveStop(x.symbol) || x.stop : x.stop;
      return { ...x, stop, price, gain: x.status === 'OPEN' && price && x.paid ? price / x.paid - 1 : null, sharia: a && a.dataMode === 'LIVE' && this.desk.book.sharia ? this.desk.book.sharia.effective(x.symbol).status : null };
    });
    const goals = this.state.goals.map((g) => {
      const years = Math.max(1 / 365, (g.by - this.now()) / (365 * DAY));
      const perYear = eq > 0 ? (g.amount / eq) ** (1 / years) - 1 : null;
      return { ...g, done: eq != null && eq >= g.amount, progress: eq == null ? 0 : Math.min(1, eq / g.amount), perYear, daysLeft: Math.max(0, Math.ceil((g.by - this.now()) / DAY)), level: perYear == null ? null : perYear <= 0 ? 'DONE' : perYear <= 0.07 ? 'CALM' : perYear <= 0.15 ? 'HARD' : perYear <= 0.3 ? 'VERY' : 'UNLIKELY' };
    });
    return { session: !!this.sid(), running: this.desk.book.aiState === 'RUNNING', live: this.desk.dataMode === 'LIVE', agentsReady: !!(this.lab && this.lab.getModel()), equity: eq, free: eq == null ? null : Math.max(0, this.desk.book.portfolio.cash - this.reserved() - (this.desk.book.commands ? this.desk.book.commands.reserved() : 0)), items, goals, job: this.job };
  }
}

module.exports = { InvestService, NEAR };
