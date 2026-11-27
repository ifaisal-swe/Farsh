'use strict';
/**
 * The AI picks markets: when the person turns it on, strong stocks from the comparison group join the watchlist by
 * themselves and weak ones it added leave again. It only ever removes what it added itself, never a symbol the person
 * added, one that is held, or one the plan, an investment goal or the person's own order manages.
 * Strength comes from server/analysis/strength.js (RSI blend and 63-day return against SPY, above the 200-day line).
 */
const DAY = 86400000;
const ADD_AT = 0.8; // place among the group (0 weakest, 1 strongest) needed to join
const DROP_AT = 0.5; // below this it leaves; the gap keeps a stock from coming and going every check
const REST = 3 * DAY; // a stock it removed is not picked again for three days

class MarketPicker {
  constructor({ desk, strength, sharia, store, getConfig, activity, isCrypto, now = Date.now }) {
    Object.assign(this, { desk, strength, sharia, store, getConfig, activity, isCrypto, now });
    this.busy = false;
    this.state = this.load();
  }

  load() {
    let s = null;
    try { s = this.store.getSetting('picker.state', null); } catch { s = null; }
    return s && Array.isArray(s.symbols) ? s : { session: null, symbols: [], dropped: {} };
  }

  save() { try { this.store.setSetting('picker.state', this.state); } catch (e) { this.activity.warn(`Market picks could not be saved: ${e.message}`, { source: 'picker' }); } }

  sid() { return this.desk.book.session ? this.desk.book.session.id : null; }

  /** Whether the AI added this symbol (and it is still followed). */
  has(symbol) { return this.state.session === this.sid() && this.state.symbols.includes(symbol); }

  shariaFail(symbol) { try { return this.sharia.effective(symbol).status === 'FAIL'; } catch { return false; } }

  /** Nothing else depends on this symbol, so it can leave the watchlist. */
  free(symbol) {
    const b = this.desk.book;
    if (b.portfolio && b.portfolio.position(symbol)) return false;
    if (b.orders.pendingFor(symbol).length) return false;
    return ![b.plan, b.invest, b.commands].some((x) => x && x.manages(symbol));
  }

  async tick() {
    if (this.busy) return;
    const cfg = this.getConfig().ai || {};
    if (!cfg.pickMarkets || this.desk.dataMode !== 'LIVE' || !this.sid()) return;
    const list = this.strength.list();
    if (list.length < 15) return; // the group is still loading
    this.busy = true;
    try {
      if (this.state.session !== this.sid()) this.state = { session: this.sid(), symbols: [], dropped: {} };
      const now = this.now();
      for (const [s, at] of Object.entries(this.state.dropped)) if (now - at > REST) delete this.state.dropped[s];
      // removed by the person: no longer its pick
      this.state.symbols = this.state.symbols.filter((s) => this.desk.agent(s));
      const rank = new Map(list.map((x) => [x.symbol, x]));
      for (const s of this.state.symbols.slice()) {
        const r = rank.get(s);
        const weak = !r || r.place < DROP_AT || r.above200 === false || this.shariaFail(s);
        if (!weak || !this.free(s)) continue;
        try {
          await this.desk.removeSymbol(s);
          this.state.symbols = this.state.symbols.filter((x) => x !== s);
          this.state.dropped[s] = now;
          this.activity.info('AI', `AI market pick removed: ${s} is no longer strong against the market${r ? ` (place ${(r.place * 100).toFixed(0)}%)` : ''}`, { source: 'picker' });
        } catch { /* tried again next check */ }
      }
      const room = Math.max(0, (Number(cfg.pickMarketsCount) || 5) - this.state.symbols.length);
      const picks = list.filter((x) => x.place >= ADD_AT && x.above200 === true && !/^XL/.test(x.symbol) && !this.isCrypto(x.symbol)
        && !this.desk.agent(x.symbol) && !this.state.dropped[x.symbol] && !this.shariaFail(x.symbol)).slice(0, room);
      for (const x of picks) {
        try {
          await this.desk.addSymbol(x.symbol);
          this.state.symbols.push(x.symbol);
          this.activity.ok('AI', `AI market pick added: ${x.symbol} is among the strongest stocks (place ${(x.place * 100).toFixed(0)}%, above its 200-day average)`, { source: 'picker' });
        } catch (e) { this.state.dropped[x.symbol] = now; this.activity.warn(`AI market pick ${x.symbol} could not be added: ${e.message}`, { source: 'picker' }); }
      }
      this.save();
    } finally { this.busy = false; }
  }
}

module.exports = { MarketPicker, ADD_AT, DROP_AT };
