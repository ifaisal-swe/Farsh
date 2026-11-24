'use strict';
/**
 * Keeps one account's portfolio on its plan: adds the symbols, reads the state every few seconds, and buys or sells
 * towards the targets. Every buy passes the same market-data, Sharia, analysis and account-limit checks as any other.
 * In approval mode it asks first; in suggestion mode it only shows.
 */
const A = require('./allocator');
const { sd, logReturns } = require('../lab/quant');

const HOUR = 3600000;
const EVERY = 10 * 60000; // at most one order per symbol in ten minutes
const day = (t) => new Date(t).toISOString().slice(0, 10);

class PlanService {
  constructor({ store, desk, lab, activity, getConfig, now = Date.now }) {
    Object.assign(this, { store, desk, lab, activity, getConfig, now });
    this.state = this.load();
    this.vol = new Map(); this.series = new Map(); this.last = new Map(); this.tried = new Map(); this.waiting = {}; this.asks = []; this.declined = new Map(); this.busy = false; this.adding = new Map(); this.guardTry = new Map();
    desk.book.plan = this;
  }

  load() { try { return this.store.getSetting('plan.state', null) || { on: false, plan: null, managed: [], built: {}, bought: {}, day: null, peak: 0, log: [], session: null }; } catch { return { on: false, plan: null, managed: [], built: {}, bought: {}, day: null, peak: 0, log: [], session: null }; } }
  save() { try { this.store.setSetting('plan.state', this.state); } catch (e) { if (this.activity) this.activity.warn(`The plan could not be saved: ${e.message}`); } }
  sid() { return this.desk.book.session ? this.desk.book.session.id : null; }
  /** A new simulation starts with an empty portfolio, so nothing from an older one is remembered. */
  fresh() { const id = this.sid(); if (id && this.state.session !== id) Object.assign(this.state, { session: id, managed: [], built: {}, bought: {}, day: null, peak: 0, on: false, stopped: null, hold: {} }); }
  manages(symbol) { return !!(this.state.on && this.state.session === this.sid() && this.state.plan && (A.classOf(this.state.plan, symbol) || this.state.managed.includes(symbol))); }
  note(x) { this.state.log = [...this.state.log, { at: this.now(), ...x }].slice(-60); }

  async set(input) {
    const plan = A.validate(input);
    if (!this.sid()) throw Object.assign(new Error('Start a session first'), { status: 400 });
    this.fresh();
    const inv = this.desk.book.invest;
    const cmd = this.desk.book.commands;
    if (cmd && A.CLASSES.some((c) => plan.symbols[c].some((s) => cmd.manages(s)))) throw Object.assign(new Error('You have your own order in this symbol'), { status: 400 });
    if (inv && A.CLASSES.some((c) => plan.symbols[c].some((s) => inv.manages(s)))) throw Object.assign(new Error('You already have an investment in this symbol'), { status: 400 });
    const bad = [];
    for (const s of A.CLASSES.flatMap((c) => plan.symbols[c])) if (!this.desk.agent(s)) { try { await this.desk.addSymbol(s); } catch (e) { if (/limit reached/i.test(e.message)) throw Object.assign(new Error('Too many symbols are followed'), { status: 400 }); bad.push(s); } }
    if (bad.length) throw Object.assign(new Error(`Symbol ${bad[0]} not found`), { status: 400 });
    const list = (p) => (p ? JSON.stringify([p.targets, p.symbols]) : '');
    if (list(plan) !== list(this.state.plan)) this.state.built = {};
    this.state.plan = plan;
    this.asks = [];
    this.save();
    return this.status();
  }

  toggle(on) {
    this.fresh();
    if (on && !this.state.plan) throw Object.assign(new Error('Save a plan first'), { status: 400 });
    const inv = this.desk.book.invest;
    const cmd = this.desk.book.commands;
    if (on && cmd && A.CLASSES.some((c) => this.state.plan.symbols[c].some((s) => cmd.manages(s)))) throw Object.assign(new Error('You have your own order in this symbol'), { status: 400 });
    if (on && inv && A.CLASSES.some((c) => this.state.plan.symbols[c].some((s) => inv.manages(s)))) throw Object.assign(new Error('You already have an investment in this symbol'), { status: 400 });
    this.state.on = !!on; this.state.stopped = null; this.state.hold = {};
    if (on) { const v = this.valuation(); this.state.peak = v ? v.equity : 0; } else this.asks = [];
    this.note({ what: on ? 'ON' : 'OFF' });
    this.save();
    return this.status();
  }

  valuation() { const p = this.desk.primary; return p && p.portfolio ? p.valuation() : null; }
  info(plan) {
    const out = {};
    for (const s of A.CLASSES.flatMap((c) => plan.symbols[c])) { const r = this.lab && this.lab.reports[s]; const fresh = r && this.now() - r.at < 36 * HOUR; out[s] = { vol: this.vol.has(s) ? this.vol.get(s).v : null, verdict: fresh ? r.verdict : 'UNKNOWN' }; }
    return out;
  }

  async measure(symbol) {
    const c = this.vol.get(symbol);
    if (c && this.now() - c.at < 6 * HOUR) return;
    const a = this.desk.agent(symbol);
    if (!a || !a.provider) return;
    this.vol.set(symbol, { at: this.now() - 5.8 * HOUR, v: c ? c.v : null }); // a failure is retried later, not at every tick
    const bars = await a.provider.fetchBars(symbol, '1d', { limit: 400 });
    if (bars.length < 30) return;
    this.series.set(symbol, bars.map((b) => ({ time: b.time, close: b.close })));
    const perYear = /\//.test(symbol) ? 365 : 252;
    this.vol.set(symbol, { at: this.now(), v: sd(logReturns(bars.slice(-91).map((b) => b.close))) * Math.sqrt(perYear) });
  }

  snapshot() {
    const v = this.valuation();
    if (!v) return null;
    const value = {};
    for (const a of this.desk.all()) { const pos = this.desk.book.portfolio.position(a.symbol); const px = a.market && a.market.mark(); if (pos && px) value[a.symbol] = pos.qty * px; else if (pos) return { unknown: a.symbol }; }
    const inv = this.desk.book.invest;
    return { equity: v.equity, cash: Math.max(0, v.cash - (inv ? inv.reserved() : 0) - (this.desk.book.commands ? this.desk.book.commands.reserved() : 0)), total: v.cash, value }; // waiting investments keep their cash
  }

  async tick() {
    if (this.busy || !this.sid()) return;
    this.fresh();
    if (!this.state.on || !this.state.plan || this.desk.book.aiState !== 'RUNNING' || this.desk.book.shuttingDown) return;
    this.busy = true;
    try {
      const { plan } = this.state;
      for (const s of A.CLASSES.flatMap((c) => plan.symbols[c])) {
        if (!this.desk.agent(s) && this.now() - (this.adding.get(s) || 0) > 60000) { this.adding.set(s, this.now()); try { await this.desk.addSymbol(s); } catch { /* shown as waiting */ } }
        try { await this.measure(s); } catch { /* measured later */ }
      }
      this.step();
    } finally { this.busy = false; }
  }

  step() {
    const { plan } = this.state;
    const snap = this.snapshot();
    if (!snap || snap.unknown) { if (snap) this.waiting = { [snap.unknown]: 'PRICE' }; return; }
    if (this.state.day !== day(this.now())) { this.state.day = day(this.now()); this.state.bought = {}; }
    if (this.state.stopped === 'GUARD') return this.guard(snap);
    // sold by a stop or by hand: the plan does not buy it straight back
    for (const s of this.state.managed.slice()) if (!this.desk.book.portfolio.position(s)) { this.state.managed = this.state.managed.filter((x) => x !== s); (this.state.hold = this.state.hold || {})[s] = this.now(); this.save(); }
    this.state.peak = Math.max(this.state.peak || 0, snap.equity);
    if (this.state.peak > 0 && 1 - snap.equity / this.state.peak >= plan.guard / 100) return this.guard(snap);
    const info = this.info(plan);
    const st = { ...snap, managed: this.state.managed, built: this.state.built, bought: this.state.bought };
    const built = A.builtClasses(plan, info, st);
    if (JSON.stringify(built) !== JSON.stringify(this.state.built)) { this.state.built = built; this.save(); }
    this.waiting = {};
    for (const s of A.CLASSES.flatMap((c) => plan.symbols[c])) if (plan.smart && info[s].verdict === 'AVOID') this.waiting[s] = 'ANALYSIS';
    const mode = this.getConfig().ai.autonomy;
    const todo = A.orders(plan, info, { ...st, built });
    this.todo = todo;
    this.asks = this.asks.filter((x) => this.now() < x.expiresAt && todo.some((o) => o.symbol === x.symbol && o.side === x.side));
    for (const o of todo) {
      if (o.side === 'BUY' && this.held(o.symbol)) { this.waiting[o.symbol] = 'HELD'; continue; }
      if (this.now() - (this.last.get(o.symbol) || 0) < EVERY) { if (this.tried.has(o.symbol)) this.waiting[o.symbol] = this.tried.get(o.symbol); continue; }
      if (mode === 'ADVISORY') { this.waiting[o.symbol] = 'SUGGESTION'; continue; }
      if (mode === 'SEMI') {
        if (this.now() - (this.declined.get(`${o.symbol}${o.side}`) || 0) < 12 * HOUR) { this.waiting[o.symbol] = 'DECLINED'; continue; }
        const block = o.side === 'BUY' ? this.blocked(o.symbol) : null;
        if (block) { this.waiting[o.symbol] = block; continue; }
        if (!this.asks.some((x) => x.symbol === o.symbol && x.side === o.side)) this.asks.push({ id: `plan_${o.symbol.replace('/', '-')}_${o.side}`, ...o, at: this.now(), expiresAt: this.now() + HOUR });
        continue;
      }
      this.place(o);
    }
  }

  held(symbol) { return this.now() - ((this.state.hold || {})[symbol] || 0) < 24 * HOUR; }

  blocked(symbol) { const a = this.desk.agent(symbol); if (!a) return 'PRICE'; const c = a.planCheck(); return c.ok ? null : c.code; }

  place(o) {
    const a = this.desk.agent(o.symbol);
    if (!a) { this.waiting[o.symbol] = 'PRICE'; return false; }
    const r = o.side === 'BUY' ? a.planBuy(o.value, o.why, o.most) : a.planSell(o.all ? null : o.value, o.why);
    if (!r.ok) { this.waiting[o.symbol] = r.code || 'MARKET'; this.last.set(o.symbol, this.now() - EVERY + 30000); this.tried.set(o.symbol, this.waiting[o.symbol]); return false; }
    this.tried.delete(o.symbol);
    this.last.set(o.symbol, this.now());
    if (o.side === 'BUY') { const c = A.classOf(this.state.plan, o.symbol); this.state.bought[c] = (this.state.bought[c] || 0) + r.value; if (!this.state.managed.includes(o.symbol)) this.state.managed.push(o.symbol); } else if (!this.desk.book.portfolio.position(o.symbol)) this.state.managed = this.state.managed.filter((s) => s !== o.symbol);
    this.note({ what: o.side, symbol: o.symbol, value: r.value, why: o.why });
    this.save();
    return true;
  }

  answer(id, yes) {
    const x = this.asks.find((q) => q.id === id);
    if (!x) throw Object.assign(new Error('No pending approval with that id (it may have expired)'), { status: 400 });
    this.asks = this.asks.filter((q) => q !== x);
    if (!yes) { this.declined.set(`${x.symbol}${x.side}`, this.now()); return { ok: true }; }
    // sized again from this moment, so an old figure can never be used
    const snap = this.snapshot();
    const now = snap && !snap.unknown ? A.orders(this.state.plan, this.info(this.state.plan), { ...snap, managed: this.state.managed, built: this.state.built, bought: this.state.bought }).find((o) => o.symbol === x.symbol && o.side === x.side) : null;
    if (!now) return { ok: false, code: 'CHANGED' };
    return { ok: this.place(now), code: this.waiting[x.symbol] || null };
  }

  /** The portfolio fell too far from its peak: sell what the plan bought and stop. */
  guard(snap) {
    let left = false;
    const mode = this.getConfig().ai.autonomy;
    this.waiting = {};
    // outside the automatic mode nothing is sold without the person: the plan only stops
    if (mode === 'FULL') {
      for (const s of this.state.managed.slice()) {
        if (!this.desk.book.portfolio.position(s)) continue;
        if (this.now() - (this.guardTry.get(s) || 0) < 30000) { left = true; continue; }
        this.guardTry.set(s, this.now());
        this.place({ symbol: s, side: 'SELL', all: true, why: 'GUARD' });
        if (this.desk.book.portfolio.position(s)) left = true;
      }
    }
    if (!this.state.stopped) { this.state.stopped = 'GUARD'; this.note({ what: 'GUARD' }); const p = this.desk.primary; if (p.emitEvent) p.emitEvent('RISK_LIMIT', { kind: 'PLAN_GUARD', message: 'plan loss guard' }, 'high'); }
    if (!left) { this.state.on = false; this.state.built = {}; this.asks = []; if (mode === 'FULL') this.state.managed = []; }
    this.save();
    return snap;
  }

  async simulate() {
    const { plan } = this.state;
    if (!plan) throw Object.assign(new Error('Save a plan first'), { status: 400 });
    const out = {};
    for (const s of A.CLASSES.flatMap((c) => plan.symbols[c])) { if (!this.desk.agent(s)) continue; try { await this.measure(s); } catch { /* left out */ } if (this.series.has(s)) out[s] = this.series.get(s); }
    const v = this.valuation();
    return A.simulate(plan, this.info(plan), out, { capital: v ? v.equity : 10000 });
  }

  status() {
    this.fresh();
    const { plan } = this.state;
    const snap = this.snapshot();
    const ok = snap && !snap.unknown;
    const w = plan ? A.weights(plan, this.info(plan)) : {};
    const row = (s) => ({ symbol: s, cls: w[s].cls, target: w[s].target, full: w[s].full, now: ok && snap.equity > 0 ? (snap.value[s] || 0) / snap.equity : 0, verdict: (this.lab && this.lab.reports[s] && this.lab.reports[s].verdict) || null, wait: this.state.on ? this.waiting[s] || null : null, sharia: this.desk.book.sharia ? this.desk.book.sharia.effective(s).status : null });
    const rows = Object.keys(w).map(row);
    const others = ok ? Object.keys(snap.value).filter((s) => !w[s]).reduce((a, s) => a + snap.value[s], 0) / (snap.equity || 1) : 0;
    return { on: this.state.on, stopped: this.state.stopped || null, plan, live: this.desk.dataMode === 'LIVE', session: !!this.sid(), running: this.desk.book.aiState === 'RUNNING', mode: this.getConfig().ai.autonomy, equity: ok ? snap.equity : null, cash: ok && snap.equity ? snap.total / snap.equity : null, others, rows, asks: this.asks, log: this.state.log.slice(-20), drop: ok && this.state.on && this.state.peak ? Math.max(0, 1 - snap.equity / this.state.peak) : 0 };
  }
}

module.exports = { PlanService };
