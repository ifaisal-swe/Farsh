'use strict';
/**
 * Desk — multi-symbol orchestration. Every monitored symbol runs its own TradingAgent (market data,
 * candles, indicators, technicals, AI analysis, decisions, protective orders), and all of them share ONE
 * book: one session, one portfolio with shared cash, one risk engine, one AI state and one AI budget.
 * One market-data WebSocket per data mode is shared by all symbols. Analyses of all symbols run one at a
 * time (book lock), so two decisions can never spend the same cash.
 *
 * Removing a symbol never touches its trades, decisions or positions; a symbol with an open position or
 * a pending order cannot be removed (pause its monitoring instead — protective orders stay active).
 */
const { EventEmitter } = require('node:events');
const { TradingAgent, SYMBOL_RE } = require('./agent');
const { isCrypto } = require('../market/crypto');
const { ReferencePriceService } = require('../market/reference');
const { AdaptiveMonitor } = require('../market/adaptiveMonitoring');
const { aggregate } = require('../market/candles');
const { etDateStr, addDays, etWallToUtcMs } = require('../util/time');

const INTRADAY = new Set(['1m', '3m', '5m', '15m', '30m', '1h']);

class Desk extends EventEmitter {
  constructor(opts) {
    super();
    this.opts = opts;
    this.store = opts.store;
    this.config = opts.config;
    this.activity = opts.activity;
    this.now = opts.now || (() => Date.now());
    this.primary = new TradingAgent(opts);
    this.book = this.primary.book;
    this.book.events = this;
    // system-wide monitoring switch survives restarts (pausing never touches positions or protective orders)
    try { this.book.monitoringPaused = !!this.store.getSetting('ops.monitoringPaused', false); } catch { this.book.monitoringPaused = false; }
    this.followers = [];
    // adaptive market monitoring: one coordinator driven by the engine's own tick (no timers of its own)
    this.monitor = new AdaptiveMonitor({ desk: this, store: this.store, getCfg: () => this.config.get(), activity: this.activity, now: this.now });
    this.book.monitor = this.monitor;
    this.wire(this.primary);
    // extended-hours / overnight reference prices (never used for execution)
    this.reference = new ReferencePriceService({
      getCfg: () => this.config.get(), getSecret: (n) => opts.secrets.get(n), fetchImpl: opts.fetchImpl, now: this.now,
      getSession: () => { const a = this.stockAgent(); return a && a.market && this.dataMode === 'LIVE' ? a.sessionInfo() : null; },
    });
    this.reference.on('reference', (r) => {
      const a = this.agent(r.symbol);
      if (a && a.market) { a.market.onReference(r); a.markDirty(); }
    });
    this.reference.on('providerError', (e) => {
      if (this.primary.cond.shouldLog(`ref-error:${e.provider}`, String(e.status || e.message).slice(0, 60), this.now())) {
        this.activity.warn(`Reference price source ${e.provider} unavailable: ${e.message}`, { source: 'reference prices' });
      }
    });
  }

  // ------------------------------------------------------------------ registry
  wire(a) {
    a.on('fill', (f) => this.emit('fill', f));
    a.on('decision', (d) => this.emit('decision', d));
    a.on('aiProgress', (p) => this.emit('aiProgress', { ...p, symbol: a.symbol }));
    a.on('equity', (p) => this.emit('equity', p));
    a.on('appEvent', (e) => this.emit('appEvent', e));
  }

  /** A symbol that follows the stock-market calendar (the main symbol when it is a stock), or null. */
  stockAgent() { return this.all().find((a) => !isCrypto(a.symbol)) || null; }

  all() { return [this.primary, ...this.followers].filter((a) => a.symbol); }

  /** book.agents (symbol -> agent) drives the shared portfolio valuation. */
  reindex() {
    this.book.agents.clear();
    for (const a of this.all()) this.book.agents.set(a.symbol, a);
    this.reference.setSymbols(this.all().map((a) => a.symbol).filter((s) => !isCrypto(s)));
  }

  agent(symbol) {
    const s = String(symbol || '').toUpperCase();
    return this.all().find((a) => a.symbol === s) || null;
  }

  get dataMode() { return this.primary.dataMode || 'LIVE'; }
  maxSymbols() { return Math.max(1, Number(this.config.get().market.maxSymbols) || 10); }

  syncPrimary() {
    // a follower that became the main symbol (or a duplicate) is retired
    this.followers = this.followers.filter((f) => {
      if (f.symbol === this.primary.symbol || f.dataMode !== this.primary.dataMode) { this.retire(f); return false; }
      return true;
    });
    if (this.primary.symbol) {
      try { this.store.upsertWatch(this.primary.symbol, this.dataMode, this.primary.monitoringPaused ? 'PAUSED' : 'ACTIVE', this.now()); } catch { /* ignore */ }
    }
    this.reindex();
  }

  retire(a) {
    a.scheduler.stop();
    a.news.stop();
    a.stopTimers();
    a.releaseProvider();
    this.config.off('change', a.onCfg);
    a.removeAllListeners();
  }

  // ------------------------------------------------------------------ lifecycle
  async init() {
    try {
      const n = this.store.migrateFillsToOrders();
      if (n) this.activity.info('SYSTEM', `Database migration: ${n} earlier fill(s) linked to order records`, { source: 'SQLite' });
    } catch (e) { this.activity.error(`Database migration failed: ${e.message}`, { source: 'SQLite' }); }
    this.monitor.load();
    await this.primary.init();
    this.syncPrimary();
    const mode = this.dataMode;
    let rows = [];
    try { rows = this.store.listWatchlist(mode); } catch { rows = []; }
    const mine = rows.find((r) => r.symbol === this.primary.symbol);
    if (mine && mine.status === 'PAUSED') this.primary.monitoringPaused = true;
    for (const r of rows) {
      if (r.symbol === this.primary.symbol || !this.primary.symbol) continue;
      try { await this.spawn(r.symbol, { paused: r.status === 'PAUSED', restore: true }); } catch (e) { this.activity.error(`Could not resume monitoring ${r.symbol}: ${e.message}`, { source: 'watchlist' }); }
    }
    if (this.opts.autoTimers !== false) this.reference.start();
  }

  /**
   * Chart bars for a symbol. On intraday timeframes, actual BOATS overnight candles (Alpaca, delayed on the
   * free plan) are merged for the latest overnight session(s) when available; they are flagged
   * session:'OVERNIGHT' / delayed and never overlap the execution feed's hours.
   */
  async bars(symbol, tf) {
    const a = this.agent(symbol) || this.primary;
    await a.ensureTf(tf);
    const out = a.chartData(tf);
    out.symbol = a.symbol;
    const ov = this.config.get().market.overnight || {};
    if (!ov.enabled || isCrypto(a.symbol) || a.dataMode !== 'LIVE' || !INTRADAY.has(tf) || !out.bars.length) return out;
    try {
      const last = out.bars[out.bars.length - 1];
      const tradeDate = etDateStr(last.time * 1000);
      const windows = [];
      const cal = a.calendar;
      const cur = cal.overnightAt ? cal.overnightAt(this.now()) : null;
      if (cur) windows.push(cur);
      if (cal.dayInfo(tradeDate).isTradingDay) windows.push({ startMs: etWallToUtcMs(addDays(tradeDate, -1), 20, 0), endMs: etWallToUtcMs(tradeDate, 4, 0) });
      const seen = new Set(out.bars.map((b) => b.time));
      let extra = [];
      for (const w of windows) {
        const mins = await this.reference.overnightBars(a.symbol, w);
        if (!mins.length) continue;
        const agg = tf === '1m' ? mins : aggregate(mins, tf).map((b) => ({ ...b, session: 'OVERNIGHT', source: 'BOATS', delayed: mins[0].delayed }));
        extra = extra.concat(agg.filter((b) => !seen.has(b.time)));
      }
      if (extra.length) {
        out.bars = [...out.bars, ...extra].sort((x, y) => x.time - y.time);
        out.overnight = { bars: extra.length, source: 'Alpaca BOATS (Blue Ocean ATS)', delayed: !!extra[0].delayed };
      }
    } catch { /* overnight candles are optional */ }
    return out;
  }

  async spawn(symbol, { paused = false } = {}) {
    const a = new TradingAgent({ ...this.opts, book: this.book });
    a.monitoringPaused = paused;
    this.followers.push(a);
    this.wire(a);
    await a.loadMarket(symbol, this.dataMode);
    // removed (or shut down) while history was loading: never start timers or analyses on a retired agent
    if (!this.followers.includes(a) || this.book.shuttingDown) return a;
    if (this.book.session) a.restoreLastDecision();
    this.reindex();
    if (a.autoTimers) a.startTimers(); // candle closes, session changes and monitoring run for EVERY symbol
    if (this.book.aiState === 'RUNNING' && !paused) { a.scheduler.start(); a.scheduler.trigger({ type: 'START', detail: 'symbol monitoring started' }); }
    return a;
  }

  async shutdown() {
    this.reference.stop();
    this.monitor.save(true);
    for (const f of this.followers) this.retire(f);
    this.followers = [];
    await this.primary.shutdown();
  }

  // ------------------------------------------------------------------ watchlist
  async addSymbol(symbolIn) {
    const symbol = String(symbolIn || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol) && !isCrypto(symbol)) throw new Error(`Invalid ticker format "${symbolIn}"`);
    if (this.agent(symbol)) throw new Error(`${symbol} is already in the watchlist`);
    if (!this.primary.symbol) {
      // first symbol: it becomes the main symbol
      const v = await this.primary.verifySymbol(symbol, { demo: this.dataMode === 'DEMO' });
      if (!v.ok) throw new Error(v.error);
      await this.primary.loadMarket(symbol, this.dataMode);
      this.syncPrimary();
    } else {
      if (this.all().length >= this.maxSymbols()) throw new Error(`Watchlist limit reached (${this.maxSymbols()} symbols; change market.maxSymbols in Settings)`);
      const v = await this.primary.verifySymbol(symbol, { demo: this.dataMode === 'DEMO' });
      if (!v.ok) throw new Error(v.error);
      try { this.store.upsertWatch(symbol, this.dataMode, 'ACTIVE', this.now()); } catch { /* ignore */ }
      await this.spawn(symbol);
    }
    this.activity.ok('SYSTEM', `Symbol added to watchlist: ${symbol} (${this.all().length} monitored)`, { source: 'watchlist' });
    this.emitEvent('SYMBOL_ADDED', symbol);
    return this.watchlist();
  }

  async removeSymbol(symbolIn) {
    const a = this.agent(symbolIn);
    if (!a) throw new Error(`${String(symbolIn).toUpperCase()} is not in the watchlist`);
    if (a === this.primary) throw new Error(`${a.symbol} is the main symbol of this session and cannot be removed; pause its monitoring instead`);
    if (this.book.portfolio && this.book.portfolio.position(a.symbol)) throw new Error(`${a.symbol} has an open paper position — close it first (removing a symbol never closes a position)`);
    if (this.book.orders.pendingFor(a.symbol).length) throw new Error(`${a.symbol} has a pending order — it must fill, expire or be cancelled first`);
    this.retire(a);
    this.followers = this.followers.filter((f) => f !== a);
    try { this.store.removeWatch(a.symbol, this.dataMode, this.now()); } catch { /* ignore */ }
    this.reindex();
    this.activity.info('SYSTEM', `Symbol removed from watchlist: ${a.symbol} (its trade history is kept)`, { source: 'watchlist' });
    this.emitEvent('SYMBOL_REMOVED', a.symbol);
    return this.watchlist();
  }

  pauseSymbol(symbolIn) {
    const a = this.agent(symbolIn);
    if (!a) throw new Error(`${String(symbolIn).toUpperCase()} is not in the watchlist`);
    a.monitoringPaused = true;
    a.scheduler.stop();
    try { this.store.upsertWatch(a.symbol, this.dataMode, 'PAUSED', this.now()); } catch { /* ignore */ }
    this.activity.info('SYSTEM', `AI monitoring paused for ${a.symbol}: no new AI analysis or entries for this symbol; market data and protective orders stay active`, { status: 'warn', source: 'watchlist' });
    this.emitEvent('MONITORING_PAUSED', a.symbol);
    return this.watchlist();
  }

  resumeSymbol(symbolIn) {
    const a = this.agent(symbolIn);
    if (!a) throw new Error(`${String(symbolIn).toUpperCase()} is not in the watchlist`);
    a.monitoringPaused = false;
    try { this.store.upsertWatch(a.symbol, this.dataMode, 'ACTIVE', this.now()); } catch { /* ignore */ }
    if (this.book.aiState === 'RUNNING') { a.scheduler.start(); a.scheduler.trigger({ type: 'START', detail: 'monitoring resumed' }); }
    this.activity.ok('SYSTEM', `AI monitoring resumed for ${a.symbol}`, { source: 'watchlist' });
    this.emitEvent('MONITORING_RESUMED', a.symbol);
    return this.watchlist();
  }

  emitEvent(type, symbol, data = {}, priority = 'low', id = null) {
    const { newId } = require('../util/misc');
    this.emit('appEvent', { id: id || newId('evt'), type, ts: this.now(), symbol, priority, data });
  }

  // ------------------------------------------------------------------ session controls (shared AI state)
  async startTrading(body) {
    const st = await this.primary.startTrading(body);
    this.syncPrimary();
    for (const f of this.followers) if (!f.monitoringPaused) { f.restoreLastDecision(); f.scheduler.start(); f.scheduler.trigger({ type: 'START', detail: 'user pressed START AI TRADING' }); }
    this.emitEvent('AI_STATE', this.primary.symbol, { from: 'STOPPED', to: 'RUNNING', by: 'user' }, 'normal');
    return st;
  }

  pause(by = 'user') {
    this.primary.pause();
    for (const f of this.followers) f.scheduler.stop();
    this.emitEvent('AI_STATE', null, { from: 'RUNNING', to: 'PAUSED', by }, 'normal');
  }

  resume(by = 'user') {
    const from = this.book.aiState;
    this.primary.resume();
    for (const f of this.followers) if (!f.monitoringPaused) { f.scheduler.start(); f.scheduler.trigger({ type: 'START', detail: 'resumed' }); }
    this.emitEvent('AI_STATE', null, { from, to: 'RUNNING', by }, 'normal');
  }

  stop(by = 'user') {
    const from = this.book.aiState;
    this.primary.stop();
    for (const f of this.followers) {
      f.scheduler.stop();
      for (const o of f.cancelPendingOrders('AI stopped')) this.activity.info('EXECUTION', `Pending order ${o.id} cancelled (AI stopped)`, { source: 'paper engine' });
    }
    this.primary.persist();
    this.emitEvent('AI_STATE', null, { from, to: 'STOPPED', by }, 'normal');
  }

  async reset() {
    for (const f of this.followers) f.scheduler.stop();
    await this.primary.reset();
  }

  async changeSymbol(symbol, opts) {
    const others = this.followers.filter((f) => this.book.portfolio && this.book.portfolio.position(f.symbol));
    if (others.length) throw new Error(`Close the open paper positions in ${others.map((f) => f.symbol).join(', ')} before changing the main symbol`);
    const sym = String(symbol || '').trim().toUpperCase();
    const existing = this.followers.find((f) => f.symbol === sym);
    if (existing) { this.retire(existing); this.followers = this.followers.filter((f) => f !== existing); }
    const st = await this.primary.changeSymbol(symbol, opts);
    this.syncPrimary();
    return st;
  }

  approve(decisionId, ok) {
    const a = this.all().find((x) => x.approvals.has(decisionId));
    if (!a) throw new Error('No pending approval with that id (it may have expired)');
    return a.approve(decisionId, ok);
  }

  // ------------------------------------------------------------------ views
  watchlist() {
    const now = this.now();
    return this.all().map((a) => {
      const md = a.market;
      const si = md ? a.sessionInfo() : null;
      const ds = md ? md.dataStatus(now, si, a.statusOpts()) : null;
      const pos = this.book.portfolio ? this.book.portfolio.position(a.symbol) : null;
      const mark = md ? md.mark() : null;
      const ref = md && md.reference && md.reference.price ? md.reference : null;
      const lt = md && md.lastTrade;
      const pd = a.lastDecision && a.lastDecision.proposal;
      const d1 = a.candles ? a.candles.getBars('1d') : [];
      const prevClose = (() => {
        const today = Math.floor(now / 86400000);
        const prev = d1.filter((b) => Math.floor(b.time / 86400) < today);
        return prev.length ? prev[prev.length - 1].close : null;
      })();
      const price = mark || (ref && ref.price) || null;
      return {
        symbol: a.symbol, primary: a === this.primary, status: a.monitoringPaused ? 'PAUSED' : 'ACTIVE', name: a.asset ? a.asset.name : null,
        price, priceTs: lt ? lt.ts : (ref ? ref.ts : null), priceKind: lt ? 'TRADE' : (ref ? ref.kind : null),
        changePct: price && prevClose ? ((price - prevClose) / prevClose) * 100 : null,
        trend: a.lastAnalysis ? a.lastAnalysis.trend : (pd ? pd.trend : null),
        aiAction: pd ? pd.action : null, aiAt: a.lastDecision ? a.lastDecision.ts : null, aiStatus: a.lastDecision ? a.lastDecision.status : null,
        positionQty: pos ? pos.qty : 0, avgPrice: pos ? pos.avgPrice : null, unrealizedPnl: pos && mark ? pos.qty * (mark - pos.avgPrice) - (pos.buyFees || 0) : null,
        dataCode: ds ? ds.code : null, dataLabel: ds ? ds.label : null, tone: ds ? ds.tone : null, fresh: ds ? !!ds.tradable : false,
        provider: md ? (md.feed.name || md.feed.label) : null, analyzing: !!a.aiProgress, monitorMode: this.monitor.enabled() ? this.monitor.symbolMode(a.symbol) : null,
      };
    });
  }

  publicState(symbol) {
    const a = this.agent(symbol) || this.primary;
    const st = a.publicState();
    st.selectedSymbol = a.symbol;
    st.primarySymbol = this.primary.symbol;
    st.watchlist = this.watchlist();
    st.maxSymbols = this.maxSymbols();
    st.positions = this.positions();
    st.operating = this.operatingStates();
    st.adaptive = this.monitor.summary();
    return st;
  }

  // ------------------------------------------------------------------ operating states (independent of any browser)
  /** Pause / resume market monitoring for ALL symbols: no AI analysis, no market alerts. Market data keeps
   *  flowing for open positions so stop-loss / take-profit protection continues. */
  setMonitoring(active, by = 'user') {
    const paused = !active;
    if (this.book.monitoringPaused === paused) return this.operatingStates();
    this.book.monitoringPaused = paused;
    try { this.store.setSetting('ops.monitoringPaused', paused); } catch { /* ignore */ }
    if (paused) for (const a of this.all()) a.scheduler.stop();
    else if (this.book.aiState === 'RUNNING') for (const a of this.all()) if (!a.monitoringPaused) { a.scheduler.start(); a.scheduler.trigger({ type: 'START', detail: 'monitoring resumed' }); }
    this.activity[paused ? 'warn' : 'ok'](paused
      ? `Market monitoring PAUSED by ${by}: no AI analysis or market alerts; market data and protective orders stay active`
      : `Market monitoring RESUMED by ${by}`, { source: by });
    this.emitEvent(paused ? 'MONITORING_STOPPED' : 'MONITORING_STARTED', null, { by }, 'normal');
    for (const a of this.all()) a.markDirty();
    return this.operatingStates();
  }

  /**
   * Three independent states (persisted inputs, computed outputs):
   *   monitoring: ACTIVE | PAUSED | ERROR
   *   aiTrading:  ACTIVE | PAUSED | RISK_BLOCKED | ERROR
   * The server state (ONLINE | DEGRADED) is added by the HTTP layer, which also knows Telegram / DB health.
   */
  operatingStates() {
    const pr = this.primary;
    const now = this.now();
    let monitoring;
    const pausedByUser = !!this.book.monitoringPaused;
    if (pausedByUser) monitoring = { state: 'PAUSED', reason: 'paused by user', pausedByUser };
    else if (!this.all().length) monitoring = { state: 'PAUSED', reason: 'no monitored symbols', pausedByUser };
    else if (pr.market && pr.market.connection.state === 'UNAVAILABLE') monitoring = { state: 'ERROR', reason: pr.market.unavailableReason || 'market data unavailable', pausedByUser };
    else monitoring = { state: 'ACTIVE', reason: null, pausedByUser };
    let aiTrading;
    const ai = this.book.aiState;
    if (ai !== 'RUNNING') aiTrading = { state: 'PAUSED', reason: ai === 'STOPPED' ? 'stopped' : ai === 'PAUSED' ? 'paused' : 'not started' };
    else {
      const v = this.book.portfolio ? pr.valuation() : null;
      const rs = v && this.book.risk ? this.book.risk.status(v.equity, now) : null;
      const plan = this.book.aiManager.anyConfigured() ? this.book.aiManager.plan({ promptChars: 6000, ms: now }) : { blocked: pr.deciderOverride || this.book.publicData || this.dataMode !== 'LIVE' ? null : 'no AI provider key configured' };
      if (rs && !rs.tradingAllowed) aiTrading = { state: 'RISK_BLOCKED', reason: (rs.blocks || []).join('; ') || 'risk limit reached' };
      else if (plan.blocked) aiTrading = { state: 'ERROR', reason: plan.blocked };
      else if (this.book.monitoringPaused) aiTrading = { state: 'PAUSED', reason: 'market monitoring paused' };
      else aiTrading = { state: 'ACTIVE', reason: null };
    }
    return { monitoring, aiTrading, aiState: ai, at: now };
  }

  positions() {
    const p = this.book.portfolio;
    if (!p) return [];
    return Object.keys(p.positions).filter((s) => p.position(s)).map((s) => {
      const pos = p.position(s);
      const a = this.agent(s);
      const mark = a && a.market ? a.market.mark() : null;
      return { symbol: s, qty: pos.qty, avgPrice: pos.avgPrice, mark, markStale: !mark || !(a.market && !a.market.freshness(this.now()).stale), stop: this.book.orders.effectiveStop(s), takeProfit: (this.book.orders.getProtection(s) || {}).takeProfit || null, unrealizedPnl: mark ? pos.qty * (mark - pos.avgPrice) - (pos.buyFees || 0) : null };
    });
  }
}

module.exports = { Desk };
