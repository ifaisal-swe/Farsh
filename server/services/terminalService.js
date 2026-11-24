'use strict';
/**
 * TerminalService — the single read/controls facade used by BOTH the web dashboard and the Telegram bot.
 * All numbers come from the shared book (portfolio accounting, recorded fills/orders/decisions, equity
 * snapshots, AI usage rows). Nothing here calls the AI or invents values: anything unknown is null and
 * statistics that need more history are flagged in `insufficient`.
 */
const { EventEmitter } = require('node:events');
const Ind = require('../analysis/indicators');
const Tech = require('../analysis/technicals');
const { sessionOfFactory } = require('../analysis/snapshot');
const { RiskManager } = require('../trading/risk');
const { PROFILES } = require('../trading/riskProfiles');
const { MODES } = require('../ai/costControl');
const { MODES: AI_MODES } = require('../ai/providerManager');
const { etDateStr, TIMEFRAMES } = require('../util/time');

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const ENTRY_ACTIONS = ['BUY', 'WAITING_FOR_PULLBACK'];
const EXIT_ACTIONS = ['SELL', 'EXIT_POSITION', 'REDUCE_POSITION'];
const WAIT_ACTIONS = ['WAIT', 'NO_TRADE', 'WAITING_FOR_BREAKOUT', 'WAITING_FOR_PULLBACK'];
const ACCEPTED = ['EXECUTED', 'PARTIALLY_EXECUTED', 'ORDER_PENDING'];
const REJECTED = ['REJECTED_BY_RISK', 'USER_REJECTED', 'DUPLICATE', 'EXECUTION_FAILED', 'EXIT_BLOCKED', 'APPROVAL_EXPIRED'];

// ---------------------------------------------------------------- timezone helpers (reporting periods)
function zParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, wd: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) };
}
function wallToUtc(y, m, d, h, mi, tz) {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const off = (ms) => { const p = zParts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000; };
  let t = guess - off(guess);
  const o2 = off(t);
  if (guess - o2 !== t) t = guess - o2;
  return t;
}
/** [from, to] of a reporting period in the given timezone. week = Monday 00:00. */
function periodRange(period, nowMs, tz, sessionStart = 0) {
  const p = zParts(nowMs, tz);
  if (period === 'today') return [wallToUtc(p.y, p.m, p.d, 0, 0, tz), nowMs];
  if (period === 'week') {
    const back = (p.wd + 6) % 7; // days since Monday
    const ref = new Date(Date.UTC(p.y, p.m - 1, p.d - back));
    return [wallToUtc(ref.getUTCFullYear(), ref.getUTCMonth() + 1, ref.getUTCDate(), 0, 0, tz), nowMs];
  }
  if (period === 'month') return [wallToUtc(p.y, p.m, 1, 0, 0, tz), nowMs];
  if (period === '7d') return [nowMs - 7 * 86400000, nowMs];
  if (period === '30d') return [nowMs - 30 * 86400000, nowMs];
  void sessionStart;
  return [0, Number.MAX_SAFE_INTEGER]; // since the start of the session's records
}

class TerminalService extends EventEmitter {
  constructor({ desk, store, config, secrets, now }) {
    super();
    this.desk = desk;
    this.store = store;
    this.config = config;
    this.secrets = secrets;
    this.now = now || (() => Date.now());
    this.healthProvider = null; // set by the HTTP layer: () => { server, components }
    desk.on('appEvent', (e) => this.emit('event', e));
    desk.on('fill', (f) => this.emit('event', { id: `fill:${f.id}`, type: 'FILL_EXECUTED', ts: f.ts, symbol: f.symbol, priority: 'high', data: { fill: this.fillItem(f), partial: f.status === 'PARTIAL', ...this.cashEquity() } }));
  }

  get book() { return this.desk.book; }
  get session() { return this.book.session; }
  tz() { const t = this.config.get().telegram; return (t && t.reports && t.reports.timezone) || 'America/New_York'; }
  cashEquity() { const v = this.desk.primary.valuation(); return v ? { equity: v.equity, cash: v.cash } : { equity: null, cash: null }; }
  range(period) { return periodRange(period || 'all', this.now(), this.tz(), this.session ? this.session.startedAt : 0); }

  // ------------------------------------------------------------------ portfolio
  portfolio() {
    const p = this.book.portfolio;
    const ai = this.book.aiState;
    const ops = this.desk.operatingStates();
    const base = { hasSession: !!this.session, watchlistCount: this.desk.all().length, riskProfile: this.config.get().risk.profile || 'CUSTOM', aiState: ai, monitoringState: ops.monitoring.state, aiTradingState: ops.aiTrading.state, reservedCash: this.reservedCash() };
    if (!p) return { ...base, initialCapital: null, equity: null, cash: null, positionValue: null, costBasis: null, realizedPnl: null, unrealizedPnl: null, totalPnl: null, totalReturnPct: null, feesPaid: null, exposurePct: null, positionsCount: 0, valuation: { stale: false, staleSymbols: [], asOf: this.now() }, positions: [] };
    const v = this.desk.primary.valuation();
    const positions = this.positionsDetailed();
    const staleSymbols = positions.filter((x) => x.markStale).map((x) => x.symbol);
    return {
      ...base, initialCapital: p.initialCapital, equity: v.equity, cash: v.cash, positionValue: v.positionValue, costBasis: v.investedCapital,
      realizedPnl: v.realizedPnl, unrealizedPnl: v.unrealizedPnl, totalPnl: v.totalPnl, totalReturnPct: v.totalReturnPct, feesPaid: v.feesPaid, exposurePct: v.exposurePct,
      positionsCount: positions.length, valuation: { stale: staleSymbols.length > 0, staleSymbols, asOf: this.now() }, positions,
    };
  }

  /** Cash committed to resting paper limit BUY orders (shown separately; checked again by the risk engine at fill time). */
  reservedCash() {
    const exec = this.config.get().execution;
    return (this.book.orders.pending || []).filter((o) => o.status === 'PENDING' && (o.side || 'BUY') === 'BUY')
      .reduce((t, o) => t + o.qty * o.limitPrice + (exec.commissionPerOrder || 0) + (exec.commissionPerShare || 0) * o.qty, 0);
  }

  positionsDetailed() {
    const p = this.book.portfolio;
    if (!p) return [];
    const now = this.now();
    return Object.keys(p.positions).filter((s) => p.position(s)).map((s) => {
      const pos = p.position(s);
      const a = this.desk.agent(s);
      const md = a && a.market;
      const lt = md && md.lastTrade;
      const mark = md ? md.mark() : null;
      const fresh = md ? !md.freshness(now).stale : false;
      const prot = this.book.orders.getProtection(s);
      const mv = mark ? pos.qty * mark : null;
      const unreal = mark ? pos.qty * (mark - pos.avgPrice) - (pos.buyFees || 0) : null;
      return {
        symbol: s, qty: pos.qty, avgPrice: pos.avgPrice, mark, markTs: lt ? lt.ts : null, markKind: lt ? 'TRADE' : (mark ? 'QUOTE' : null), markStale: !mark || !fresh,
        marketValue: mv, unrealizedPnl: unreal, unrealizedPct: unreal != null && pos.avgPrice > 0 ? (unreal / (pos.qty * pos.avgPrice)) * 100 : null,
        stop: this.book.orders.effectiveStop(s), takeProfit: prot ? prot.takeProfit : null,
      };
    });
  }

  todayPerformance() { return this.stats({ period: 'today' }).portfolio; }

  // ------------------------------------------------------------------ orders & executions
  fillItem(f) {
    return {
      id: f.id, orderId: f.orderId || null, symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fees: f.fees, notional: f.qty * f.price, ts: f.ts,
      realizedPnl: f.side === 'SELL' ? f.realizedPnl : null, costBasisPrice: f.side === 'SELL' ? (f.costBasisPrice ?? null) : null,
      returnPct: f.side === 'SELL' ? (f.returnPct ?? (f.costBasisPrice > 0 ? (f.realizedPnl / (f.qty * f.costBasisPrice)) * 100 : null)) : null,
      kind: f.kind || 'AI', strategy: f.strategy || null, decisionId: f.decisionId || null, reason: f.reason || '', riskProfile: f.riskProfile || null, status: f.status || 'FILLED',
      aiProvider: f.aiProvider || null, aiModel: f.aiModel || null,
      exitTrigger: f.side === 'SELL' ? ({ STOP: 'STOP_LOSS', TRAILING_STOP: 'TRAILING_STOP', TAKE_PROFIT: 'TAKE_PROFIT', USER: 'MANUAL', AI: 'AI' }[f.kind] || f.kind || null) : null,
    };
  }

  allFills() {
    if (!this.session) return [];
    try { return this.store.listFills(this.session.id); } catch { return []; }
  }

  fills({ side = null, symbol = null, period = 'all', limit = 20, offset = 0 } = {}) {
    const [from, to] = this.range(period);
    const sym = symbol ? String(symbol).toUpperCase() : null;
    const items = this.allFills().filter((f) => f.ts >= from && f.ts <= to && (!side || f.side === side) && (!sym || f.symbol === sym))
      .sort((a, b) => b.ts - a.ts).map((f) => this.fillItem(f));
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  fill(id) {
    const f = this.allFills().find((x) => x.id === id);
    if (!f) return null;
    const d = f.decisionId ? this.store.getDecision(f.decisionId) : null;
    return { ...this.fillItem(f), decision: d && d.proposal ? { id: d.id, action: d.action, rationale: d.proposal.rationale, evidence: d.proposal.evidence || [] } : null };
  }

  orders({ side = null, status = null, period = 'all', symbol = null, limit = 20, offset = 0 } = {}) {
    if (!this.session) return { total: 0, items: [] };
    const [from, to] = this.range(period);
    const sym = symbol ? String(symbol).toUpperCase() : null;
    let rows = [];
    try { rows = this.store.listOrders(this.session.id); } catch { rows = []; }
    const match = (o) => (!status || (status === 'OPEN' ? ['PENDING', 'PARTIALLY_FILLED'].includes(o.status) && !this.isTerminalPartial(o) : o.status === status));
    const items = rows.filter((o) => o.createdAt >= from && o.createdAt <= to && (!side || o.side === side) && (!sym || o.symbol === sym) && match(o))
      .map((o) => ({ ...o, notional: o.avgFillPrice && o.filledQty ? o.avgFillPrice * o.filledQty : (o.limitPrice && o.qty ? o.limitPrice * o.qty : null) }));
    return { total: items.length, items: items.slice(offset, offset + limit) };
  }

  isTerminalPartial(o) { return o.status === 'PARTIALLY_FILLED' && !this.book.orders.pending.some((p) => p.id === o.id); }

  // ------------------------------------------------------------------ statistics
  stats({ period = 'all' } = {}) {
    const [from, to] = this.range(period);
    const p = this.book.portfolio;
    const v = p ? this.desk.primary.valuation() : null;
    const insufficient = {};
    const fills = this.allFills().filter((f) => f.ts >= from && f.ts <= to);
    const sells = fills.filter((f) => f.side === 'SELL');
    const rts = p ? p.roundTrips.filter((r) => r.closedAt >= from && r.closedAt <= to).sort((a, b) => a.closedAt - b.closedAt) : [];
    // equity at the period start: the last snapshot before it (or the first after, or the initial capital)
    let startEquity = p ? p.initialCapital : null;
    if (this.session && period !== 'all') {
      try {
        const before = this.store.equityAtOrBefore(this.session.id, from);
        const after = before ? null : this.store.equityFirstAfter(this.session.id, from);
        if (before) startEquity = before.equity; else if (after) startEquity = after.equity;
      } catch { /* keep initial capital */ }
    }
    const endEquity = v ? v.equity : null;
    const realizedInPeriod = sells.reduce((s, f) => s + (f.realizedPnl || 0), 0);
    const wins = rts.filter((r) => r.pnl > 0);
    const losses = rts.filter((r) => r.pnl < 0);
    const grossWin = wins.reduce((s, r) => s + r.pnl, 0);
    const grossLoss = -losses.reduce((s, r) => s + r.pnl, 0);
    const trading = {
      roundTrips: rts.length, wins: wins.length, losses: losses.length,
      winRatePct: rts.length ? (wins.length / rts.length) * 100 : null,
      avgWin: wins.length ? grossWin / wins.length : null, avgLoss: losses.length ? -grossLoss / losses.length : null,
      largestWin: wins.length ? Math.max(...wins.map((r) => r.pnl)) : null, largestLoss: losses.length ? Math.min(...losses.map((r) => r.pnl)) : null,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : null,
      avgHoldingMinutes: rts.length ? rts.reduce((s, r) => s + (r.closedAt - r.openedAt), 0) / rts.length / 60000 : null,
      avgTradeReturnPct: rts.length ? rts.reduce((s, r) => s + (r.returnPct || 0), 0) / rts.length : null,
      fees: fills.reduce((s, f) => s + (f.fees || 0), 0), buyCount: fills.filter((f) => f.side === 'BUY').length, sellCount: sells.length,
      volume: fills.reduce((s, f) => s + f.qty * f.price, 0),
    };
    if (!rts.length) for (const k of ['winRatePct', 'avgWin', 'avgLoss', 'largestWin', 'largestLoss', 'profitFactor', 'avgHoldingMinutes', 'avgTradeReturnPct']) insufficient[k] = true;
    if (rts.length && !losses.length) insufficient.profitFactor = true;
    if (rts.length && !wins.length) { insufficient.avgWin = true; insufficient.largestWin = true; }
    if (rts.length && !losses.length) { insufficient.avgLoss = true; insufficient.largestLoss = true; }
    // equity path for drawdown / exposure
    let curve = [];
    if (this.session) {
      try { curve = this.store.db.prepare('SELECT ts, equity, position_value AS pv FROM equity_curve WHERE session_id = ? AND ts >= ? AND ts <= ? ORDER BY ts').all(this.session.id, from, to).map((r) => ({ ...r })); } catch { curve = []; }
    }
    if (v) curve.push({ ts: this.now(), equity: v.equity, pv: v.positionValue });
    let peak = -Infinity; let maxDd = 0; let maxExpo = 0;
    for (const c of curve) {
      peak = Math.max(peak, c.equity);
      if (peak > 0) maxDd = Math.max(maxDd, ((peak - c.equity) / peak) * 100);
      if (c.equity > 0 && isNum(c.pv)) maxExpo = Math.max(maxExpo, (c.pv / c.equity) * 100);
    }
    if (curve.length < 2) { insufficient.maxDrawdownPct = true; insufficient.maxPositionExposurePct = true; }
    let maxW = 0; let maxL = 0; let cw = 0; let cl = 0;
    for (const r of rts) { if (r.pnl > 0) { cw++; cl = 0; } else if (r.pnl < 0) { cl++; cw = 0; } maxW = Math.max(maxW, cw); maxL = Math.max(maxL, cl); }
    const last = rts[rts.length - 1];
    const rs = this.book.risk && v ? this.book.risk.status(v.equity, this.now()) : null;
    const L = this.config.get().risk;
    const risk = {
      maxDrawdownPct: curve.length >= 2 ? maxDd : null, currentDrawdownPct: rs ? rs.drawdownPct : null,
      maxPositionExposurePct: curve.length >= 2 ? maxExpo : null, currentExposurePct: v ? v.exposurePct : null, profile: L.profile || 'CUSTOM',
      dailyLossLimitPct: L.maxDailyLossPct, remainingDailyLossPct: rs ? Math.max(0, L.maxDailyLossPct + Math.min(0, rs.dayPnlPct)) : null,
      maxConsecutiveWins: maxW, maxConsecutiveLosses: maxL, currentStreak: last ? { type: last.pnl > 0 ? 'WIN' : 'LOSS', count: last.pnl > 0 ? cw : cl } : null,
    };
    if (!rts.length) insufficient.currentStreak = true;
    // AI activity in the period (recorded decisions; confidence is not a calibrated probability)
    let decs = [];
    if (this.session) { try { decs = this.store.decisionsBetween(this.session.id, from, to); } catch { decs = []; } }
    const proposals = decs.filter((d) => ENTRY_ACTIONS.includes(d.action) || EXIT_ACTIONS.includes(d.action));
    // 'all' ends at MAX_SAFE_INTEGER, which is not a valid date: clamp the day range to [epoch, now]
    const dayFrom = etDateStr(Math.max(0, from));
    const dayTo = etDateStr(Math.min(to, this.now()));
    const usage = (() => { try { return this.store.usageBetween(dayFrom, dayTo); } catch { return { requests: 0 }; } })();
    const byProv = (id) => { try { return this.store.usageBetween(dayFrom, dayTo, id); } catch { return { requests: 0, costUsd: 0 }; } };
    const ds = byProv('deepseek'); const gm = byProv('gemini');
    const ai = {
      decisions: decs.length, proposals: proposals.length, accepted: proposals.filter((d) => ACCEPTED.includes(d.status)).length,
      rejected: proposals.filter((d) => REJECTED.includes(d.status)).length, executedTrades: fills.filter((f) => f.decisionId && f.kind === 'AI').length,
      waits: decs.filter((d) => WAIT_ACTIONS.includes(d.action)).length, holds: decs.filter((d) => d.action === 'HOLD').length,
      requests: usage.requests || 0, status: this.book.aiState,
      deepseekRequests: ds.requests || 0, geminiRequests: gm.requests || 0, deepseekCostUsd: ds.costUsd || 0, geminiCostUsd: gm.costUsd || 0, costUsd: usage.costUsd || 0,
    };
    const bySymbolMap = new Map();
    for (const f of sells) { const e = bySymbolMap.get(f.symbol) || { symbol: f.symbol, realizedPnl: 0, trades: 0 }; e.realizedPnl += f.realizedPnl || 0; e.trades++; bySymbolMap.set(f.symbol, e); }
    for (const f of fills.filter((x) => x.side === 'BUY')) if (!bySymbolMap.has(f.symbol)) bySymbolMap.set(f.symbol, { symbol: f.symbol, realizedPnl: 0, trades: 0 });
    return {
      period, from, to, timezone: this.tz(),
      portfolio: {
        startEquity, endEquity, netPnl: isNum(startEquity) && isNum(endEquity) ? endEquity - startEquity : null,
        netReturnPct: startEquity > 0 && isNum(endEquity) ? ((endEquity - startEquity) / startEquity) * 100 : null,
        realizedPnl: realizedInPeriod, unrealizedPnl: v ? v.unrealizedPnl : null, cash: v ? v.cash : null, invested: v ? v.positionValue : null, initialCapital: p ? p.initialCapital : null,
      },
      trading, risk, ai, bySymbol: [...bySymbolMap.values()].sort((a, b) => b.realizedPnl - a.realizedPnl), insufficient,
    };
  }

  report(kind) {
    const period = { daily: 'today', weekly: 'week', monthly: 'month' }[kind] || 'today';
    const stats = this.stats({ period });
    const contrib = new Map();
    for (const b of stats.bySymbol) contrib.set(b.symbol, b.realizedPnl);
    for (const pos of this.positionsDetailed()) if (isNum(pos.unrealizedPnl)) contrib.set(pos.symbol, (contrib.get(pos.symbol) || 0) + pos.unrealizedPnl);
    const arr = [...contrib.entries()].map(([symbol, pnl]) => ({ symbol, pnl })).sort((a, b) => b.pnl - a.pnl);
    const top = arr.length && arr[0].pnl > 0 ? arr[0] : null;
    const worst = arr.length && arr[arr.length - 1].pnl < 0 ? arr[arr.length - 1] : null;
    let aiHighlights = [];
    let riskEvents = [];
    let newsEvents = [];
    if (this.session) {
      try {
        aiHighlights = this.store.decisionsBetween(this.session.id, stats.from, stats.to)
          .filter((d) => d.proposal && d.proposal.chart && d.proposal.chart.change && d.proposal.chart.change.changed)
          .slice(0, 8).map((d) => ({ symbol: d.symbol, ts: d.ts, from: d.proposal.chart.change.from, to: d.action, reason: d.proposal.chart.change.reason || null }));
      } catch { aiHighlights = []; }
      try { riskEvents = this.store.activityBetween(this.session.id, stats.from, stats.to, ['WARNING', 'RISK']).filter((e) => /^RISK LIMIT|Trade REJECTED|Exposure review/.test(e.message)).slice(0, 10).map((e) => ({ ts: e.ts, message: e.message })); } catch { riskEvents = []; }
    }
    try {
      for (const a of this.desk.all()) {
        for (const n of this.store.listNews(a.symbol, 30)) {
          const ts = n.publishedAt || n.retrievedAt;
          if (ts >= stats.from && ts <= stats.to && n.marketImpact === 'HIGH') newsEvents.push({ ts, symbol: a.symbol, title: n.title });
        }
      }
      newsEvents = newsEvents.sort((x, y) => y.ts - x.ts).slice(0, 8);
    } catch { newsEvents = []; }
    return { kind, from: stats.from, to: stats.to, stats, topContributor: top, worstContributor: worst, aiHighlights, riskEvents, newsEvents };
  }

  // ------------------------------------------------------------------ symbols
  watchlist() {
    return this.desk.watchlist().map((w) => ({
      symbol: w.symbol, status: w.status, price: w.price, changePct: w.changePct, trend: trendCode(w.trend), aiAction: w.aiAction, positionQty: w.positionQty,
      unrealizedPnl: w.unrealizedPnl, dataTs: w.priceTs, priceKind: w.priceKind, provider: w.provider, fresh: w.fresh, dataLabel: w.dataLabel, primary: w.primary, name: w.name,
    }));
  }

  stock(symbolIn) {
    const sym = String(symbolIn || '').toUpperCase();
    const a = this.desk.agent(sym);
    if (!a) return null;
    const w = this.desk.watchlist().find((x) => x.symbol === sym) || {};
    const ld = a.lastDecision;
    const pd = ld && ld.proposal;
    let support = null; let resistance = null; let rsi = null;
    try {
      const atf = this.config.get().ai.analysisTimeframe;
      const bars = a.candles.completedBars(atf, this.now());
      const lv = Ind.latestValues(bars, sessionOfFactory(atf));
      rsi = lv.rsi14 && lv.rsi14.available ? lv.rsi14.value : null;
      const t = Tech.analyze(bars.slice(-300), { tfSec: TIMEFRAMES[atf].sec, price: w.price });
      if (t.available) { support = t.levels.supports[0] ? t.levels.supports[0].price : null; resistance = t.levels.resistances[0] ? t.levels.resistances[0].price : null; }
    } catch { /* technicals unavailable */ }
    const pos = this.positionsDetailed().find((x) => x.symbol === sym);
    return {
      symbol: sym, name: a.asset ? a.asset.name : null, monitored: true, status: w.status, price: w.price, priceTs: w.priceTs, priceKind: w.priceKind, provider: w.provider,
      fresh: w.fresh, dataLabel: w.dataLabel, changePct: w.changePct, trend: trendCode(w.trend || (pd && pd.trend)), aiAction: pd ? pd.action : null, aiAt: ld ? ld.ts : null,
      aiRationale: pd ? pd.rationale : null, aiConfidence: pd ? pd.confidence : null, support, resistance, rsi,
      position: pos ? { qty: pos.qty, avgPrice: pos.avgPrice, unrealizedPnl: pos.unrealizedPnl, unrealizedPct: pos.unrealizedPct } : null,
    };
  }

  stockNews(symbolIn) {
    const sym = String(symbolIn || '').toUpperCase();
    const a = this.desk.agent(sym);
    const notes = new Map(((a && a.lastDecision && a.lastDecision.proposal && a.lastDecision.proposal.newsAssessment) || []).map((n) => [n.newsId, n.note]));
    let items = [];
    try { items = this.store.listNews(sym, 10); } catch { items = []; }
    return items.map((n) => ({ ts: n.publishedAt || n.retrievedAt, source: n.source, title: n.title, url: n.url, impact: n.marketImpact, aiNote: notes.get(n.id) || null }));
  }

  // ------------------------------------------------------------------ AI
  ai() {
    const c = this.config.get().ai;
    const ac = this.desk.primary.aiCfg();
    const u = this.book.usage;
    const today = u.today(this.now());
    const month = u.month(this.now());
    const day = etDateStr(this.now());
    let avoided = 0;
    try { avoided = this.store.avoidedBetween(day, day); } catch { avoided = 0; }
    const mgr = this.book.aiManager.status(this.now());
    const aiMode = mgr.mode;
    const provider = aiMode === 'GEMINI' ? 'Gemini' : aiMode === 'DEEPSEEK' ? 'DeepSeek' : aiMode === 'DUAL' ? 'DeepSeek + Gemini' : 'Auto';
    const last = this.desk.all().map((a) => a.lastDecision).filter(Boolean).sort((x, y) => y.ts - x.ts)[0] || null;
    const err = this.book.aiError;
    const anyKey = Object.values(mgr.providers).some((x) => x.configured);
    return {
      state: this.book.aiState, mode: ac.usageMode, aiMode, aiModes: AI_MODES, fallback: mgr.fallback, dualScope: mgr.dualScope, providers: mgr.providers,
      operating: this.desk.operatingStates(), provider, model: aiMode === 'GEMINI' ? (c.gemini && c.gemini.model) : aiMode === 'DEEPSEEK' ? c.model : `${c.model} / ${c.gemini && c.gemini.model}`, symbolsMonitored: this.desk.all().length,
      requestsToday: today.requests, requestsMonth: month.requests, inputTokensToday: today.promptTokens, outputTokensToday: today.completionTokens,
      inputTokensMonth: month.promptTokens, outputTokensMonth: month.completionTokens, costTodayUsd: today.costUsd, costMonthUsd: month.costUsd, errorsMonth: month.errors,
      dailyBudgetUsd: c.dailyBudgetUsd, remainingBudgetUsd: Math.max(0, c.dailyBudgetUsd - today.costUsd), monthlyBudgetUsd: c.monthlyBudgetUsd || 0,
      maxRequestsPerDay: ac.maxRequestsPerDay, avoidedToday: avoided, lastAnalysisAt: last ? last.ts : null,
      lastDecision: last ? { symbol: last.symbol, action: last.action, ts: last.ts, provider: last.provider || (last.proposal && last.proposal.aiProvider) || null, model: last.model || null } : null,
      apiStatus: !anyKey ? 'NO_KEY' : (err ? 'ERROR' : 'OK'), lastError: err ? err.message : null,
      recentErrors: (() => { try { return this.store.recentUsageErrors(5); } catch { return []; } })(), modes: Object.keys(MODES),
      budgetNote: 'Configured budgets are spending caps set in this app — not proof of remaining free provider quota.',
    };
  }

  decisions({ symbol = null, kind = 'all', limit = 10, offset = 0 } = {}) {
    if (!this.session) return { total: 0, items: [] };
    let rows = [];
    try { rows = symbol ? this.store.listDecisionsBySymbol(this.session.id, String(symbol).toUpperCase(), 300) : this.store.listDecisions(this.session.id, 300); } catch { rows = []; }
    rows = rows.filter((d) => kind === 'all' || (kind === 'buy' ? ENTRY_ACTIONS.includes(d.action) : EXIT_ACTIONS.includes(d.action)));
    const items = rows.slice(offset, offset + limit).map((d) => {
      const p = d.proposal;
      const ch = p && p.chart && p.chart.change;
      return {
        id: d.id, symbol: d.symbol, ts: d.ts, previousAction: ch ? ch.from : null, action: d.action, rationale: p ? p.rationale : null, evidence: p ? p.evidence || [] : [],
        provider: d.provider || (p && p.aiProvider) || null, model: d.model || null, changeReason: ch ? ch.reason || null : null,
        dual: p && p.dual && p.dual.policy ? { policy: p.dual.policy, uncertainty: p.dual.combinedUncertainty, deepseek: p.dual.providers.deepseek && p.dual.providers.deepseek.action, gemini: p.dual.providers.gemini && p.dual.providers.gemini.action } : null,
        news: p && p.newsAssessment ? p.newsAssessment.slice(0, 3).map((n) => ({ id: n.newsId, note: n.note || null })) : [],
        snapshotId: d.snapshotId, proposedTrade: !!(d.action && (ENTRY_ACTIONS.includes(d.action) || EXIT_ACTIONS.includes(d.action))), status: d.status,
        executed: ['EXECUTED', 'PARTIALLY_EXECUTED'].includes(d.status), rejected: REJECTED.includes(d.status),
        rejectReasons: d.risk && d.risk.checks ? d.risk.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.detail}`) : [],
      };
    });
    return { total: rows.length, items };
  }

  // ------------------------------------------------------------------ risk
  risk() {
    const L = this.config.get().risk;
    const v = this.book.portfolio ? this.desk.primary.valuation() : null;
    const rs = this.book.risk && v ? this.book.risk.status(v.equity, this.now()) : null;
    return {
      profile: L.profile || 'CUSTOM', limits: { maxRiskPerTradePct: L.maxRiskPerTradePct, maxDailyLossPct: L.maxDailyLossPct, maxDrawdownPct: L.maxDrawdownPct, maxPositionPct: L.maxPositionPct, minRewardRisk: L.minRewardRisk, maxOpenPositions: L.maxOpenPositions },
      dayPnlPct: rs ? rs.dayPnlPct : null, remainingDailyLossPct: rs ? Math.max(0, L.maxDailyLossPct + Math.min(0, rs.dayPnlPct)) : null,
      drawdownPct: rs ? rs.drawdownPct : null, exposurePct: v ? v.exposurePct : null, tradingAllowed: rs ? rs.tradingAllowed : null, blocks: rs ? rs.blocks : [],
    };
  }

  /** Effect of a risk level on the existing positions WITHOUT applying it (Telegram confirmation screen). */
  previewRiskProfile(profile) {
    if (!PROFILES[profile]) throw new Error('مستوى مخاطرة غير معروف');
    const limits = { ...this.config.get().risk, ...PROFILES[profile], profile };
    const findings = [];
    const reduceSuggestions = [];
    const p = this.book.portfolio;
    if (p && this.book.risk) {
      const rm = new RiskManager(limits, JSON.parse(JSON.stringify(this.book.risk.state)));
      const v = this.desk.primary.valuation();
      const pos = this.positionsDetailed();
      for (const x of pos.length ? pos : [null]) {
        const r = rm.reviewExposure({ equity: v.equity, pos: x ? p.position(x.symbol) : null, mark: x ? (x.mark || x.avgPrice) : null, stop: x ? x.stop : null, exec: this.config.get().execution, nowMs: this.now(), fractional: !!this.config.get().execution.fractionalShares });
        for (const f of r.findings) {
          if (!x && !['daily_loss', 'drawdown'].includes(f.code)) continue;
          if (['daily_loss', 'drawdown', 'open_positions'].includes(f.code) && findings.some((y) => y.code === f.code)) continue;
          findings.push({ code: f.code, ok: f.ok, symbol: x ? x.symbol : null, text: findingText(f, x ? x.symbol : null) });
        }
        if (x && r.reduceQty > 0) reduceSuggestions.push({ symbol: x.symbol, qty: r.reduceQty });
      }
    }
    return { profile, limits: PROFILES[profile], findings, reduceSuggestions };
  }

  status() {
    const pr = this.desk.primary;
    const si = pr.market ? pr.sessionInfo() : null;
    const v = this.book.portfolio ? pr.valuation() : null;
    const health = this.healthProvider ? this.healthProvider() : null;
    return {
      aiState: this.book.aiState, hasSession: !!this.session, operating: this.desk.operatingStates(), server: health ? health.server : null, components: health ? health.components : null,
      aiMode: this.book.aiManager.mode(),
      market: si ? { session: si.session, label: si.marketStatus } : { session: null, label: null },
      symbols: this.desk.watchlist().map((w) => ({ symbol: w.symbol, dataLabel: w.dataLabel, fresh: w.fresh, status: w.status })),
      positionsCount: this.positionsDetailed().length, equity: v ? v.equity : null,
    };
  }

  // ------------------------------------------------------------------ controls (same engine, same rules as the web UI)
  async control(fn, okMsg) {
    try { await fn(); } catch (e) { const err = new Error(arabicError(e.message)); err.original = e.message; throw err; }
    return { ok: true, message: okMsg, state: this.status() };
  }
  pauseAi() { return this.control(() => this.desk.pause('telegram'), 'تم إيقاف الذكاء الاصطناعي مؤقتًا. أوامر وقف الخسارة وجني الأرباح تبقى فعّالة.'); }
  resumeAi() { return this.control(() => this.desk.resume('telegram'), 'تم استئناف الذكاء الاصطناعي ضمن حدود المخاطرة الحالية.'); }
  stopAi() { return this.control(() => this.desk.stop('telegram'), 'تم إيقاف التداول الآلي. المراكز المفتوحة محفوظة ومحمية بأوامر الحماية.'); }
  setRiskProfile(profile) { return this.control(() => this.desk.primary.setRiskProfile(profile), `تم تطبيق مستوى المخاطرة الجديد. لم يُغلق أي مركز تلقائيًا.`); }
  addSymbol(s) { return this.control(() => this.desk.addSymbol(s), `تمت إضافة ${String(s).toUpperCase()} إلى الأسهم المراقبة.`); }
  removeSymbol(s) { return this.control(() => this.desk.removeSymbol(s), `تمت إزالة ${String(s).toUpperCase()} من المراقبة (سجله محفوظ).`); }
  pauseSymbol(s) { return this.control(() => this.desk.pauseSymbol(s), `تم إيقاف مراقبة الذكاء الاصطناعي لـ ${String(s).toUpperCase()}؛ البيانات وأوامر الحماية مستمرة.`); }
  resumeSymbol(s) { return this.control(() => this.desk.resumeSymbol(s), `تم استئناف مراقبة ${String(s).toUpperCase()}.`); }
  /** AI operating mode — the same setting the web dashboard changes (one AI Provider Manager). */
  setAiMode(mode, by = 'telegram') {
    const m = String(mode || '').toUpperCase();
    const ar = { DEEPSEEK: 'DeepSeek فقط', GEMINI: 'Gemini فقط', AUTO: 'تلقائي', DUAL: 'تحليل مزدوج' };
    return this.control(() => {
      if (!AI_MODES.includes(m)) throw new Error('Unknown AI mode');
      this.config.update({ ai: { mode: m } });
      this.desk.activity.info('AI', `AI mode set to ${m} by ${by}`, { source: by });
    }, `تم تغيير وضع الذكاء الاصطناعي إلى: ${ar[m] || m}. حدود المخاطرة لم تتغير.`);
  }
  pauseMonitoring(by = 'telegram') { return this.control(() => this.desk.setMonitoring(false, by), 'تم إيقاف مراقبة السوق مؤقتًا. أوامر الحماية للمراكز المفتوحة تبقى فعّالة.'); }
  resumeMonitoring(by = 'telegram') { return this.control(() => this.desk.setMonitoring(true, by), 'تم استئناف مراقبة السوق.'); }

  /** Adaptive monitoring status (session mode, per-symbol state, event counters) — read only, no AI call. */
  monitoring() { return this.desk.monitor.status(); }

  /** Recent news across all monitored symbols (from the database; no AI call). */
  news({ limit = 10, symbol = null } = {}) {
    const syms = symbol ? [String(symbol).toUpperCase()] : this.desk.all().map((a) => a.symbol);
    const seen = new Set();
    const out = [];
    for (const s of syms) {
      let items = [];
      try { items = this.store.listNews(s, 15); } catch { items = []; }
      const a = this.desk.agent(s);
      const notes = new Map(((a && a.lastDecision && a.lastDecision.proposal && a.lastDecision.proposal.newsAssessment) || []).map((n) => [n.newsId, n.note]));
      for (const n of items) {
        const key = n.duplicateOf || n.id || `${n.source}|${n.title}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ id: n.id, symbol: n.symbol === '*MACRO*' ? null : s, ts: n.publishedAt || n.retrievedAt, source: n.source, title: n.title, url: n.url || null, impact: n.marketImpact || null, official: !!n.officialConfirmed, aiNote: notes.get(n.id) || null });
      }
    }
    return out.sort((x, y) => (y.ts || 0) - (x.ts || 0)).slice(0, limit);
  }
}

function trendCode(t) {
  if (!t) return null;
  const s = String(t).toUpperCase();
  if (/UP/.test(s) || s === 'BULLISH') return 'UP';
  if (/DOWN/.test(s) || s === 'BEARISH') return 'DOWN';
  if (/RANGE|SIDEWAYS|TRANSITION|MIXED|CONTRACT|EXPAND/.test(s)) return 'SIDEWAYS';
  return null;
}

function findingText(f, symbol) {
  const P = f.params || {};
  const n = (x, d = 2) => (isNum(x) ? x.toFixed(d) : '—');
  const s = symbol ? `${symbol}: ` : '';
  switch (f.code) {
    case 'allocation': return f.ok ? `${s}التخصيص ${n(P.valuePct)}% ضمن الحد ${P.limit}%` : `${s}قيمة المركز ${n(P.valuePct)}% من رأس المال تتجاوز الحد الجديد ${P.limit}% — يلزم بيع ${P.reduceQty} سهم للامتثال (لن يُباع شيء تلقائيًا)`;
    case 'risk_to_stop': return P.noStop ? `${s}لا يوجد وقف خسارة فعّال` : (f.ok ? `${s}المخاطرة حتى الوقف ${n(P.riskPct)}% ضمن الحد ${P.limit}%` : `${s}المخاطرة حتى الوقف ${n(P.riskPct)}% تتجاوز الحد الجديد ${P.limit}%`);
    case 'stop_distance': return f.ok ? `${s}مسافة الوقف ${n(P.distPct)}% ضمن الحد ${P.limit}%` : `${s}مسافة الوقف ${n(P.distPct)}% أكبر من الحد الجديد ${P.limit}%`;
    case 'daily_loss': return f.ok ? `خسارة اليوم ضمن الحد ${P.limit}%` : `خسارة اليوم ${n(Math.abs(P.dayPnlPct))}% تتجاوز الحد اليومي الجديد ${P.limit}% — سيتوقف الدخول حتى اليوم التالي`;
    case 'drawdown': return f.ok ? `التراجع ضمن الحد ${P.limit}%` : `التراجع ${n(P.drawdownPct)}% يتجاوز الحد الجديد ${P.limit}% — سيتعطل التداول`;
    case 'open_positions': return f.ok ? `عدد المراكز المفتوحة ${P.open} ضمن الحد ${P.limit}` : `عدد المراكز المفتوحة ${P.open} يتجاوز الحد الجديد ${P.limit}`;
    default: return f.code;
  }
}

function arabicError(m) {
  const rules = [
    [/is already in the watchlist/, 'السهم موجود مسبقًا في قائمة المراقبة'], [/is not in the watchlist/, 'السهم غير موجود في قائمة المراقبة'],
    [/main symbol of this session/, 'هذا هو السهم الرئيسي للجلسة ولا يمكن إزالته؛ يمكنك إيقاف مراقبته بدلًا من ذلك'],
    [/has an open paper position/, 'لا يمكن الإزالة: يوجد مركز ورقي مفتوح لهذا السهم (الإزالة لا تغلق المراكز)'], [/has a pending order/, 'لا يمكن الإزالة: يوجد أمر معلق لهذا السهم'],
    [/Watchlist limit reached/, 'تم بلوغ الحد الأقصى لعدد الأسهم المراقبة'], [/Invalid ticker/, 'رمز سهم غير صالح'], [/not found/i, 'الرمز غير موجود لدى مزود البيانات'],
    [/AI is not running/, 'الذكاء الاصطناعي لا يعمل حاليًا'], [/AI is not paused/, 'الذكاء الاصطناعي ليس متوقفًا'], [/No session/, 'لا توجد جلسة تداول نشطة'],
    [/Unknown risk profile/, 'مستوى مخاطرة غير معروف'], [/Unknown AI mode/, 'وضع ذكاء اصطناعي غير معروف'], [/credentials are not configured|UNAVAILABLE/, 'بيانات السوق غير متاحة (مفاتيح Alpaca غير مضبوطة)'],
  ];
  for (const [re, ar] of rules) if (re.test(m)) return ar;
  return m;
}

module.exports = { TerminalService, periodRange, zParts, wallToUtc, trendCode };
