'use strict';
/**
 * The order desk: the person's own orders, kept until the price comes, like at a broker.
 *   BUY  LIMIT  at this price or cheaper      BUY  STOP  when it rises to this price
 *   SELL LIMIT  at this price or better       SELL STOP  when it falls to this price      SELL TRAIL  follows a rise
 *   MARKET      at the next real price (waits for the market to open)
 * Fills use real bid/ask and displayed size, so an order can fill in parts, and cost fees. Cash and shares are held
 * back. Orders work while automation is paused. Every purchase passes the account's loss limits.
 */
const { newId } = require('../util/misc');
const { isCrypto } = require('../market/crypto');
const { parse } = require('./parse');

const DAY = 86400000;
const LIVE = ['WAITING', 'PART'];
const bad = (m, status = 400) => Object.assign(new Error(m), { status });
const num = (x) => (x === '' || x == null ? null : Number(x));

class CommandService {
  constructor({ store, desk, activity, now = Date.now }) {
    Object.assign(this, { store, desk, activity, now });
    let s = null;
    try { s = store.getSetting('commands.state', null); } catch { s = null; }
    this.state = s || { session: null, orders: [], owned: [] };
    this.tries = new Map(); this.working = false;
    desk.book.commands = this;
  }

  save() { try { this.store.setSetting('commands.state', this.state); } catch (e) { if (this.activity) this.activity.warn(`Orders could not be saved: ${e.message}`); } }
  sid() { return this.desk.book.session ? this.desk.book.session.id : null; }
  mine() { return this.state.session === this.sid(); }
  live(x) { return LIVE.includes(x.status); }
  fresh() {
    const id = this.sid();
    if (!id || this.state.session === id) return;
    for (const x of this.state.orders) if (this.live(x)) this.close(x, 'CANCELLED', 'RESET');
    this.state.session = id; this.state.owned = [];
    this.save();
  }
  position(symbol) { return this.desk.book.portfolio ? this.desk.book.portfolio.position(symbol) : null; }
  /** Automation leaves a symbol alone while a purchase waits for it or the person's purchase is held. */
  manages(symbol) { return this.mine() && (this.state.owned.includes(symbol) || this.state.orders.some((x) => x.symbol === symbol && x.side === 'BUY' && this.live(x))); }
  reserved(except = null) { return this.mine() ? this.state.orders.filter((x) => x.side === 'BUY' && this.live(x) && x !== except).reduce((a, x) => a + (x.hold || 0), 0) : 0; }
  close(x, status, end) { x.status = status; x.end = end; x.closedAt = this.now(); x.wait = null; x.hold = 0; }
  find(id) { this.fresh(); const x = this.state.orders.find((q) => q.id === id); if (!x) throw bad('That order was not found', 404); return x; }

  preview(text) { return parse(text); }

  async add(input) {
    const b = input || {};
    this.fresh();
    if (!this.sid()) throw bad('Start a session first');
    const symbol = String(b.symbol || '').trim().toUpperCase();
    if (!symbol) throw bad('Invalid symbol');
    const side = b.side === 'SELL' ? 'SELL' : b.side === 'BUY' ? 'BUY' : null;
    const type = ['MARKET', 'LIMIT', 'STOP', ...(side === 'SELL' ? ['TRAIL'] : [])].includes(b.type) ? b.type : null;
    if (!side || !type) throw bad('Choose buy or sell');
    const price = type === 'LIMIT' || type === 'STOP' ? num(b.price) : null;
    const trail = type === 'TRAIL' ? num(b.trail) : null;
    const stop = side === 'BUY' ? num(b.stop) : null; const target = side === 'BUY' ? num(b.target) : null;
    if (price != null ? !(price > 0 && price < 1e7) : type === 'LIMIT' || type === 'STOP') throw bad('Write the price');
    if (type === 'TRAIL' && !(trail >= 0.5 && trail <= 50)) throw bad('The distance must be between 0.5 and 50');
    for (const v of [stop, target]) if (v != null && !(v > 0 && v < 1e7)) throw bad('Write the price');
    if (side === 'SELL' && !this.position(symbol)) throw bad('You do not hold this symbol');
    if (!this.desk.agent(symbol)) { try { await this.desk.addSymbol(symbol); } catch (e) { throw bad(/limit reached/i.test(e.message) ? 'Too many symbols are followed' : `Symbol ${symbol} not found`); } }
    const a = this.desk.agent(symbol);
    for (let i = 0; i < 40 && !(a.market && a.market.mark()); i++) await new Promise((r) => { setTimeout(r, 200).unref(); });
    this.fresh();
    const mark = a.market && a.market.mark(); const ref = price || mark;
    if (!ref) throw bad('There is no price yet');
    if (stop != null && stop >= ref) throw bad('The stop must be below the start and the target above it');
    if (target != null && target <= ref) throw bad('The stop must be below the start and the target above it');
    const fr = !!a.cfg().execution.fractionalShares; const floor = (x) => (fr ? Math.floor(x * 10000 + 1e-9) / 10000 : Math.floor(x + 1e-9));
    const pos = this.position(symbol);
    let qty = side === 'SELL' && b.all ? pos.qty : num(b.qty) > 0 ? floor(num(b.qty)) : num(b.dollars) > 0 ? floor(num(b.dollars) / (ref * (1 + (a.cfg().execution.commissionPct || 0) / 100))) : 0;
    if (!(qty > 0)) throw bad(num(b.dollars) > 0 && !fr ? 'The amount is less than one share' : 'Write the quantity');
    if (side === 'BUY') {
      if (this.desk.book.plan && this.desk.book.plan.manages(symbol)) throw bad('This symbol is in your running plan');
      if (this.desk.book.invest && this.desk.book.invest.manages(symbol)) throw bad('You already have an investment in this symbol');
    } else if (qty > pos.qty + 1e-9) throw bad('You do not hold this quantity');
    const hold = side === 'BUY' ? qty * ref * (1 + (a.cfg().execution.commissionPct || 0) / 100) * (type === 'LIMIT' ? 1 : 1.01) : 0;
    if (side === 'BUY') { const inv = this.desk.book.invest; if (hold > this.desk.book.portfolio.cash - this.reserved() - (inv ? inv.reserved() : 0)) throw bad('Not enough cash for this amount'); }
    if (this.state.orders.filter((x) => this.live(x)).length >= 40) throw bad('Too many orders');
    const x = { id: newId('cmd'), symbol, side, type, price, trail, top: type === 'TRAIL' ? mark : null, qty, done: 0, spent: 0, stop, target, hold, day: !!b.day, status: 'WAITING', wait: null, createdAt: this.now(), until: this.now() + (b.day && isCrypto(symbol) ? DAY : 90 * DAY), sawOpen: false, group: null };
    this.state.orders.unshift(x);
    const ended = this.state.orders.filter((q) => !this.live(q)).slice(0, 100);
    this.state.orders = [...this.state.orders.filter((q) => this.live(q)), ...ended];
    this.save();
    this.onPrice(a);
    return this.status();
  }

  change(id, input) {
    const x = this.find(id); const b = input || {};
    if (!this.live(x)) throw bad('That order has ended');
    if (x.done > 0 && x.side === 'BUY') throw bad('A part is already done. Cancel the rest instead');
    if (x.type === 'TRAIL') { const t = num(b.trail); if (!(t >= 0.5 && t <= 50)) throw bad('The distance must be between 0.5 and 50'); x.trail = t; } else if (x.type !== 'MARKET') {
      const p = num(b.price);
      if (!(p > 0 && p < 1e7)) throw bad('Write the price');
      if ((x.stop != null && x.stop >= p) || (x.target != null && x.target <= p)) throw bad('The stop must be below the start and the target above it');
      if (x.side === 'BUY') { const hold = (x.hold / x.price) * p; const inv = this.desk.book.invest; if (hold > this.desk.book.portfolio.cash - this.reserved(x) - (inv ? inv.reserved() : 0)) throw bad('Not enough cash for this amount'); x.hold = hold; }
      x.price = p;
    }
    this.save();
    const a = this.desk.agent(x.symbol); if (a) this.onPrice(a);
    return this.status();
  }

  cancel(id) { const x = this.find(id); if (!this.live(x)) throw bad('That order has ended'); this.close(x, x.done > 0 ? 'DONE' : 'CANCELLED', 'USER'); if (x.side === 'BUY' && x.done > 0) this.children(x); this.save(); return this.status(); }

  /** Is the price there? Returns the limit to respect, or null for "at market", or false for "not yet". */
  reached(x, q, last, near) {
    if (x.type === 'MARKET') return null;
    if (x.side === 'BUY') { if (x.type === 'LIMIT') return q.ask <= x.price ? x.price : false; return q.ask >= x.price || last >= x.price ? null : false; }
    if (x.type === 'LIMIT') { const p = x.price * (1 - near / 100); return q.bid >= p ? p : false; }
    if (x.type === 'STOP') return q.bid <= x.price || (last > 0 && last <= x.price) ? null : false;
    const top = Math.max(x.top || 0, last || 0, q.bid);
    if (top > (x.top || 0)) { x.top = top; this.dirty = true; }
    return q.bid <= x.top * (1 - x.trail / 100) ? null : false;
  }

  children(x) {
    if (!(x.done > 0) || (x.stop == null && x.target == null)) return;
    const group = newId('grp');
    for (const [type, price] of [['STOP', x.stop], ['LIMIT', x.target]]) if (price != null) this.state.orders.unshift({ id: newId('cmd'), symbol: x.symbol, side: 'SELL', type, price, trail: null, qty: x.done, done: 0, spent: 0, stop: null, target: null, hold: 0, day: false, status: 'WAITING', wait: null, createdAt: this.now(), until: this.now() + 365 * DAY, group, parent: x.id });
    x.stop = null; x.target = null;
  }

  /** Called by the engine on every price of a symbol, and on a timer. */
  onPrice(a) {
    if (this.working || !this.mine() || !a.market || !this.desk.book.portfolio) return;
    const own = this.state.owned.includes(a.symbol);
    if (own && !this.position(a.symbol)) { this.state.owned = this.state.owned.filter((s) => s !== a.symbol); this.save(); }
    if (!this.state.orders.some((x) => x.symbol === a.symbol && this.live(x))) return;
    this.working = true;
    try {
      const q = a.market.quote(); const last = a.market.lastTrade ? a.market.lastTrade.price : null; const open = a.sessionInfo().session === 'REGULAR';
      // stops first: protection is never behind a purchase
      const rank = (x) => (x.side === 'SELL' ? (x.type === 'LIMIT' ? 1 : 0) : 2);
      for (const x of this.state.orders.filter((y) => y.symbol === a.symbol && this.live(y)).sort((m, n) => rank(m) - rank(n) || m.createdAt - n.createdAt)) {
        if (!this.live(x)) continue;
        if (x.side === 'SELL') { const p = this.position(x.symbol); if (!p) { this.close(x, x.done > 0 ? 'DONE' : 'CANCELLED', x.done > 0 ? null : 'SOLD'); this.save(); continue; } if (x.qty - x.done > p.qty + 1e-9) x.qty = x.done + p.qty; }
        if (open) x.sawOpen = true;
        if (this.now() >= x.until || (x.day && x.sawOpen && !open)) { this.close(x, x.done > 0 ? 'DONE' : 'EXPIRED', 'TIME'); if (x.side === 'BUY') this.children(x); this.save(); continue; }
        if (!open) { x.wait = 'CLOSED'; continue; }
        if (!q || !(q.bid > 0 && q.ask >= q.bid) || a.market.freshness(this.now()).stale) { x.wait = 'PRICE'; continue; }
        const limit = this.reached(x, q, last, a.cfg().execution.nearTargetPct || 0);
        if (limit === false && !x.triggered) { x.wait = 'REACH'; continue; }
        // a selling stop that was touched stays triggered, as at a broker; everything else must still be at its price
        if (x.side === 'SELL' && (x.type === 'STOP' || x.type === 'TRAIL')) x.triggered = x.triggered || this.now();
        if (this.now() - (this.tries.get(x.id) || 0) < 1500) continue;
        this.tries.set(x.id, this.now());
        this.run(a, x, limit === false ? null : limit);
      }
      if (this.dirty) { this.dirty = false; if (this.now() - (this.savedTop || 0) > 15000) { this.savedTop = this.now(); this.save(); } }
    } finally { this.working = false; }
  }

  run(a, x, limit) {
    const left = Math.round((x.qty - x.done) * 1e8) / 1e8;
    const r = x.side === 'BUY' ? a.ownBuy(left, limit, x.id) : a.ownSell(left, limit, x.id);
    if (!r.ok) { const was = x.wait; x.wait = r.code; if (was !== x.wait) this.save(); return; }
    x.done = Math.round((x.done + r.qty) * 1e8) / 1e8; x.spent += r.qty * r.price; x.average = x.spent / x.done; x.at = this.now(); x.wait = null;
    if (x.side === 'BUY') { x.hold = Math.max(0, x.hold * (1 - r.qty / left)); if (!this.state.owned.includes(x.symbol)) this.state.owned.push(x.symbol); } else x.result = (x.result || 0) + (r.realized || 0);
    if (x.done >= x.qty - 1e-9) { this.close(x, 'DONE', null); if (x.side === 'BUY') this.children(x); } else { x.status = 'PART'; x.wait = 'MORE'; }
    // the stop and the target of one purchase share the same shares
    if (x.group) for (const y of this.state.orders) if (y !== x && y.group === x.group && this.live(y)) { y.qty = Math.round((y.qty - r.qty) * 1e8) / 1e8; if (y.qty - y.done <= 1e-9) this.close(y, 'CANCELLED', 'OTHER'); }
    this.save();
  }

  tick() { if (!this.sid()) return; this.fresh(); for (const s of new Set(this.state.orders.filter((x) => this.live(x)).map((x) => x.symbol))) { const a = this.desk.agent(s); if (a) this.onPrice(a); } }

  status() {
    this.fresh();
    const pf = this.desk.book.portfolio; const inv = this.desk.book.invest;
    const orders = this.mine() ? this.state.orders.slice(0, 80).map((x) => { const a = this.desk.agent(x.symbol); const px = a && a.market ? a.market.mark() : null; const level = x.type === 'TRAIL' ? (x.top ? x.top * (1 - x.trail / 100) : null) : x.price; return { ...x, now: px, level, away: this.live(x) && px && level ? level / px - 1 : null, sharia: a && a.dataMode === 'LIVE' && this.desk.book.sharia ? this.desk.book.sharia.effective(x.symbol).status : null }; }) : [];
    const held = pf ? this.desk.all().map((a) => { const p = pf.position(a.symbol); return p ? { symbol: a.symbol, qty: p.qty, paid: p.avgPrice, now: a.market ? a.market.mark() : null } : null; }).filter(Boolean) : [];
    return { session: !!this.sid(), live: this.desk.dataMode === 'LIVE', free: pf ? Math.max(0, pf.cash - this.reserved() - (inv ? inv.reserved() : 0)) : null, orders, held };
  }
}

module.exports = { CommandService };
