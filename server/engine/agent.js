'use strict';
/**
 * TradingAgent — orchestrates the autonomous PAPER-trading loop:
 *   real market data -> candles/indicators -> scheduled snapshot -> AI proposal -> strict validation
 *   -> deterministic risk engine -> simulated execution -> portfolio accounting -> persistence/UI.
 * The AI proposes; the risk engine disposes. Protective orders run independently of the AI.
 */
const { EventEmitter } = require('node:events');
const { MarketState, REASON_TEXT, fmtAge } = require('../market/marketState');
const { ConditionLog, fmtDuration } = require('../util/conditions');
const { CandleStore } = require('../market/candles');
const { MarketCalendar } = require('../market/session');
const { AlpacaProvider } = require('../market/alpaca');
const { DemoProvider } = require('../market/demo');
const { Portfolio, PortfolioError } = require('../trading/portfolio');
const { RiskManager } = require('../trading/risk');
const { OrderManager } = require('../trading/orders');
const { simulateOrder, computeFees } = require('../trading/execution');
const { computeMetrics, benchmarkEquity } = require('../trading/metrics');
const { buildSnapshot, sessionOfFactory } = require('../analysis/snapshot');
const { AiProviderManager, PROVIDERS: AI_PROVIDERS } = require('../ai/providerManager');
const { buildChartAnalysis } = require('../analysis/chartAnalysis');
const { PROFILES, PROFILE_KEYS, profilePatch, SYMBOLS_TRADED_AT_ONCE } = require('../trading/riskProfiles');
const Ind = require('../analysis/indicators');
const { DeepSeekClient } = require('../ai/deepseek');
const { GeminiClient } = require('../ai/gemini');
const { DeepSeekDecider, GeminiDecider, RulesDecider } = require('../ai/decider');
const { validateProposal, proposalKey, EXIT_ACTIONS } = require('../ai/proposal');
const { AnalysisScheduler } = require('../ai/scheduler');
const { UsageTracker } = require('../ai/usage');
const { NewsCollector } = require('../news/collector');
const { newId } = require('../util/misc');
const { effectiveAiCfg, materialStateHash, FORCE_TRIGGERS } = require('../ai/costControl');
const { TIMEFRAMES, isValidTf, etWallToUtcMs, etTimeStr, etDateStr, bucketStart } = require('../util/time');

const { PublicStockProvider, PublicCryptoProvider } = require('../market/public');
const { CryptoProvider, isCrypto, CRYPTO_EXECUTION } = require('../market/crypto');
const SYMBOL_RE = /^[A-Z][A-Z0-9.]{0,9}$/;
const fmt = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(d) : 'n/a');

class TradingAgent extends EventEmitter {
  constructor({ store, config, secrets, activity, now, providerFactory, fetchImpl, autoTimers = true, deciderOverride = null, book = null, publicData = false }) {
    super();
    // The BOOK is the account shared by every monitored symbol: one session, one portfolio (shared cash),
    // one risk engine, one set of protective orders, one AI state and one AI usage budget. The agent that
    // creates the book is the PRIMARY; agents for further watchlist symbols are FOLLOWERS sharing it.
    this.primary = !book;
    this.book = book || {
      session: null, portfolio: null, risk: null, orders: new OrderManager(), benchmark: null, aiState: 'IDLE', aiError: null,
      agents: new Map(), providers: new Map(), calendars: new Map(), usage: null, lock: new SerialLock(), broadMarket: null, events: null,
      aiManager: null, publicData: !!publicData, shuttingDown: false, monitoringPaused: false, startup: { dbOk: true, accountingOk: true, problems: [] },
    };
    this.monitoringPaused = false;
    this.store = store;
    this.config = config;
    this.secrets = secrets;
    this.activity = activity;
    this.now = now || (() => Date.now());
    this.providerFactory = providerFactory || ((mode) => this.defaultProvider(mode));
    this.fetchImpl = fetchImpl;
    this.autoTimers = autoTimers;
    this.deciderOverride = deciderOverride;

    this.symbol = null;
    this.dataMode = 'LIVE';
    this.provider = null;
    this.providerHandlers = [];
    this.market = null;
    this.candles = null;
    this.calendar = new MarketCalendar();
    this.aiProgress = null;
    this.lastDecision = null;
    this.lastAnalysis = null;
    this.asset = null;
    this.ipo = { isNewlyListed: false, active: false };
    this.broadMarket = null;
    this.webResearch = null;
    this.lastResearchAt = 0;
    this.lastExecuted = null;
    this.approvals = new Map();
    this.loadedTfs = new Set();
    this.timers = [];
    this.dirty = { candles: true, state: true };
    this.lastSkipReason = null;
    this.exitAttemptAt = 0;
    this.msgStats = { trades: 0, quotes: 0, bars: 0, since: this.now() };
    this.msgRate = null;
    this.lastRateLogAt = 0;
    this.chartVersion = 0;
    // market-data health bookkeeping (see tick())
    this.cond = new ConditionLog({ remindMs: (config.get().market.statusReminderMin || 5) * 60000 });
    this.lastSessionKey = null;
    this.lastSessionInfo = null;
    this.liveWindowDate = null;
    this.diag = null;
    this.lastDiagAt = 0;
    this.diagInFlight = false;
    this.lastForcedReconnectAt = 0;
    this.lastClockSyncAt = 0;
    this.clockSyncInFlight = false;
    this.quiet = null;
    this.outage = null;
    this.verifyPending = null;
    this.wakeInFlight = false;
    this.riskReview = null;
    this.applyingProfile = false;

    if (!this.book.usage) this.book.usage = new UsageTracker({ store, pricing: config.get().pricing, getAiCfg: () => this.aiCfg() });
    if (!this.book.aiManager) {
      // one AI Provider Manager for the whole book: same modes, budgets and circuit breakers for every symbol
      const deciderCfg = () => ({ ...this.cfg(), ai: this.aiCfg() });
      this.book.aiManager = new AiProviderManager({
        store, usage: this.book.usage, now: this.now, getSecret: (n) => this.secrets.get(n),
        redact: (s) => (this.activity && this.activity.redactor ? this.activity.redactor.redactString(s) : s),
        getCfg: () => ({ ...this.cfg(), ai: { ...this.aiCfg(), mode: this.cfg().ai.mode } }),
        deciders: {
          deepseek: () => new DeepSeekDecider({ getClient: () => this.deepseekClient(), getCfg: deciderCfg }),
          gemini: () => new GeminiDecider({ getClient: () => this.geminiClient(), getCfg: deciderCfg }),
        },
      });
      this.book.aiManager.on('circuitOpen', (x) => {
        const name = AI_PROVIDERS[x.provider].name;
        this.activity.error(`${name} paused after errors (${x.code}) until ${etTimeStr(x.until, false)} ET: ${x.reason}`, { source: 'AI provider manager' });
        this.emitEvent('AI_PROVIDER_DOWN', { provider: x.provider, name, code: x.code, reason: x.reason, until: x.until }, 'high', `aidown:${x.provider}:${x.until}`);
      });
      this.book.aiManager.on('recovered', (x) => {
        const name = AI_PROVIDERS[x.provider].name;
        this.activity.ok('AI', `${name} is answering again`, { source: 'AI provider manager' });
        this.emitEvent('AI_PROVIDER_RECOVERED', { provider: x.provider, name }, 'low');
      });
    }
    this.usage = this.book.usage;
    // analyses of all symbols are serialised through the book lock: one AI request at a time, and no two
    // decisions can ever spend the same cash
    this.scheduler = new AnalysisScheduler({ run: (job) => this.book.lock.run(() => this.runAnalysis(job)), getCfg: () => this.aiCfg(), now: this.now });
    this.scheduler.on('jobError', (job, e) => this.activity.error(`AI analysis job failed: ${e.message}`, { source: 'scheduler', details: { stack: String(e.stack || '').split('\n').slice(0, 4) } }));
    this.scheduler.on('waiting', (job, wait) => this.activity.info('AI', `Analysis queued (${job.reasons.map((r) => r.type).join(', ')}); next slot in ${(wait / 1000).toFixed(0)}s (min interval)`, { status: 'pending', source: 'scheduler' }));
    this.news = new NewsCollector({
      store, activity, getProvider: () => this.provider, getSecrets: () => this.secrets, getCfg: () => this.cfg(), now: this.now, fetchImpl,
    });
    this.news.on('breaking', (item) => {
      this.activity.info('NEWS', `Significant news detected: "${item.title}" (${item.source}) — requesting AI re-evaluation`, { status: 'warn', source: item.source, details: { url: item.url } });
      this.scheduler.trigger({ type: 'NEWS', key: item.id, detail: item.title.slice(0, 120) });
      this.emitEvent('NEWS_MATERIAL', { title: item.title, url: item.url || null, source: item.source || null, impact: item.impact || item.aiImpact || null }, 'normal', `news:${this.symbol}:${item.id}`);
    });
    this.news.on('news', () => this.markDirty());
    this.news.on('halt', (h) => {
      if (!this.market) return;
      const before = this.market.halted;
      this.market.setExternalHalt(h.active, { reason: h.reasonCode, ts: h.haltAt, source: 'Nasdaq Trader trade halts feed' });
      if (this.market.halted !== before) this.onHaltChange();
    });
    this.onCfg = (cfg, patch) => this.onConfigChange(cfg, patch);
    config.on('change', this.onCfg);
  }

  cfg() {
    const c = this.config.get();
    if (!isCrypto(this.symbol)) return c;
    if (this.cryptoCfgFor !== c) { this.cryptoCfgFor = c; this.cryptoCfg = { ...c, execution: { ...c.execution, ...CRYPTO_EXECUTION } }; }
    return this.cryptoCfg;
  }
  /** Reports for a shared stream come once: from the main symbol, or from the first symbol on a stream the main symbol does not use. */
  get streamLead() {
    if (this.primary) return true;
    const mine = this.slot(this.dataMode);
    for (const a of this.book.agents.values()) if (a.slot(a.dataMode) === mine) return a === this;
    return false;
  }
  /** Shared provider / calendar slot of a symbol: crypto has its own stream and is open 24/7. */
  slot(mode, symbol = this.symbol) { return mode === 'LIVE' && isCrypto(symbol) ? 'CRYPTO' : mode; }
  /** AI settings with the usage-mode preset applied (economy / balanced / detailed). */
  aiCfg() { return effectiveAiCfg(this.cfg().ai); }
  markDirty() { this.dirty.state = true; }

  // ------------------------------------------------------------------ providers / clients
  defaultProvider(mode) {
    if (mode === 'DEMO') return new DemoProvider();
    const keyId = this.secrets.get('ALPACA_KEY_ID');
    const secretKey = this.secrets.get('ALPACA_SECRET_KEY');
    const m = this.cfg().market;
    if ((!keyId || !secretKey) && this.book.publicData) return mode === 'CRYPTO' ? new PublicCryptoProvider({ fetchImpl: this.fetchImpl }) : new PublicStockProvider({ fetchImpl: this.fetchImpl });
    if (!keyId || !secretKey) return null;
    if (mode === 'CRYPTO') return new CryptoProvider({ keyId, secretKey, cfg: m, fetchImpl: this.fetchImpl });
    return new AlpacaProvider({ keyId, secretKey, feed: m.feed, cfg: m, adjustment: m.adjustment, fetchImpl: this.fetchImpl });
  }

  deepseekClient() {
    const key = this.secrets.get('DEEPSEEK_API_KEY');
    return new DeepSeekClient({ apiKey: key, baseUrl: this.cfg().ai.baseUrl, fetchImpl: this.fetchImpl, timeoutMs: this.cfg().ai.requestTimeoutSec * 1000 });
  }

  geminiClient() {
    const g = this.cfg().ai.gemini || {};
    return new GeminiClient({ apiKey: this.secrets.get('GEMINI_API_KEY'), baseUrl: g.baseUrl, fetchImpl: this.fetchImpl, timeoutMs: this.cfg().ai.requestTimeoutSec * 1000 });
  }

  /** The primary provider of the current AI mode (AUTO / DUAL report DeepSeek first). */
  aiProvider() {
    const m = this.book.aiManager.mode();
    return m === 'GEMINI' ? { id: 'gemini', name: 'Gemini', key: 'GEMINI_API_KEY' } : { id: 'deepseek', name: 'DeepSeek', key: 'DEEPSEEK_API_KEY' };
  }

  /** Decider facade over the AI Provider Manager (DeepSeek, Gemini, AUTO or DUAL). */
  managedDecider() {
    const mgr = this.book.aiManager;
    const agent = this;
    return {
      kind: 'managed', costly: true, managed: true,
      get label() {
        const m = mgr.mode();
        if (m === 'DEEPSEEK') return `DeepSeek ${mgr.providerModel('deepseek')}`;
        if (m === 'GEMINI') return `Gemini ${mgr.providerModel('gemini')}`;
        return m === 'DUAL' ? 'AI dual (DeepSeek + Gemini)' : 'AI auto (DeepSeek / Gemini)';
      },
      promptFor: (snapshot) => mgr.promptFor(snapshot),
      get research() { return agent.cfg().ai.webResearch && agent.cfg().ai.webResearch.enabled ? mgr.research() : null; },
      decide: (snapshot, opts) => mgr.decide(snapshot, opts),
    };
  }

  decider() {
    if (this.deciderOverride) return this.deciderOverride;
    if (this.book.aiManager.anyConfigured()) return this.managedDecider();
    // real prices without keys: the fixed rules suggest (still paper only, still behind the risk checks)
    if (this.dataMode !== 'LIVE' || this.book.publicData) return new RulesDecider();
    return null;
  }

  // ------------------------------------------------------------------ lifecycle
  async init() {
    let s = null;
    try { s = this.store.getActiveSession(); } catch (e) { this.activity.error(`Database error reading sessions: ${e.message}`); }
    if (this.autoTimers) this.startTimers();
    if (!s) { this.activity.info('SYSTEM', 'Terminal ready. No active paper-trading session.'); return; }
    this.restoreSession(s);
    this.activity.ok('SYSTEM', `Restored paper session #${s.id} (${s.symbol}, ${s.dataMode}) from database: cash $${fmt(this.portfolio.cash)}, ${this.portfolio.position(s.symbol) ? `${this.portfolio.position(s.symbol).qty} sh open` : 'flat'}`, { source: 'database' });
    this.expireOfflineOrders();
    await this.loadMarket(s.symbol, s.dataMode);
    const prev = s.aiState;
    const st = this.book.startup || { dbOk: true, accountingOk: true, problems: [] };
    if (prev === 'RUNNING' && this.cfg().session.autoResumeAi && (!st.dbOk || !st.accountingOk)) {
      this.setAiState('PAUSED');
      this.activity.error(`AI was running before the restart but was NOT resumed: startup checks failed (${st.problems.join('; ')}). Market data and protective orders stay active; resume manually after checking.`, { source: 'session restore' });
      this.emitEvent('ENGINE_CHECK_FAILED', { problems: st.problems }, 'high', `startcheck:${s.id}:${this.now()}`);
    } else if (prev === 'RUNNING' && this.cfg().session.autoResumeAi) {
      this.setAiState('RUNNING');
      this.activity.info('AI', 'AI was running before restart — resuming. Analyses and new entries wait for fresh, verified market data; decisions made before the restart are never executed.', { source: 'session restore' });
      this.scheduler.start();
      this.scheduler.trigger({ type: 'START', detail: 'session restored' });
    } else {
      this.setAiState(prev === 'RUNNING' ? 'PAUSED' : (prev === 'ENDED' ? 'STOPPED' : prev || 'STOPPED'));
    }
  }

  /** Pending limit orders whose expiry passed while the application was not running: expired, never filled. */
  expireOfflineOrders() {
    const now = this.now();
    for (const o of [...(this.orders.pending || [])]) {
      if (o.status !== 'PENDING' || !(o.expiresAt < now)) continue;
      this.orders.cancelPending(o.id, 'expired');
      try { this.store.updateOrder(o.id, { status: 'EXPIRED', rejectReason: 'expired while the application was offline — not filled', updatedAt: now }); } catch { /* ignore */ }
      this.activity.info('EXECUTION', `Pending LIMIT ${o.side || 'BUY'} ${o.qty} ${o.symbol} @ ${fmt(o.limitPrice, 4)} expired while the application was offline — not filled (no fills are reconstructed for offline periods)`, { source: 'session restore' });
    }
    this.persist();
  }

  restoreSession(s) {
    this.session = s;
    this.symbol = s.symbol;
    this.dataMode = s.dataMode;
    this.portfolio = s.portfolio ? Portfolio.fromJSON(s.portfolio) : new Portfolio({ initialCapital: s.initialCapital });
    this.risk = new RiskManager(this.cfg().risk, s.risk || {});
    this.orders = new OrderManager(s.orders || {});
    this.benchmark = s.benchmark || null;
    this.aiState = s.aiState === 'ENDED' ? 'STOPPED' : s.aiState;
    this.restoreLastDecision();
  }

  /** Keep the latest AI assessment of THIS symbol across restarts (current analysis + chart annotations). */
  restoreLastDecision() {
    if (!this.session || !this.symbol) { this.lastDecision = null; return; }
    try {
      const decs = this.store.listDecisionsBySymbol(this.session.id, this.symbol, 10);
      this.lastDecision = decs.find((d) => d.proposal) || null;
    } catch { this.lastDecision = null; }
  }

  startTimers() {
    this.stopTimers();
    const t1 = setInterval(() => this.tick(), 1000);
    // watchlist symbols share the account: they only need the housekeeping loop (candles, sessions, monitoring)
    if (!this.primary) { if (t1.unref) t1.unref(); this.timers.push(t1); return; }
    const t2 = setInterval(() => this.sampleEquity(), this.cfg().session.equitySampleSec * 1000);
    const t3 = setInterval(() => this.pollBroadMarket(), this.cfg().market.broadMarketPollSec * 1000);
    const t4 = setInterval(() => this.reportMessageRate(), 60000);
    for (const t of [t1, t2, t3, t4]) if (t.unref) t.unref();
    this.timers.push(t1, t2, t3, t4);
  }

  stopTimers() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async shutdown() {
    this.stopTimers();
    this.scheduler.stop();
    this.news.stop();
    if (this.provider) this.provider.disconnect();
    this.persist();
  }

  setAiState(st) {
    this.aiState = st;
    if (this.session) { try { this.store.saveSessionState(this.session.id, { aiState: st }); } catch (e) { this.activity.error(`Database error: ${e.message}`); } }
    this.markDirty();
  }

  persist() {
    if (!this.session || !this.portfolio) return;
    try {
      this.store.saveSessionState(this.session.id, {
        // only the main agent owns the session's symbol (a watchlist symbol must never overwrite it)
        aiState: this.aiState, portfolio: this.portfolio.toJSON(), orders: this.orders.toJSON(), risk: this.risk.toJSON(), benchmark: this.benchmark, symbol: this.primary ? this.symbol : null,
      });
    } catch (e) {
      this.activity.error(`Database error while saving session: ${e.message}`, { source: 'database' });
    }
  }

  // ------------------------------------------------------------------ market data
  async verifySymbol(symbolIn, { demo = false } = {}) {
    const symbol = String(symbolIn || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol) && !isCrypto(symbol)) return { ok: false, error: `Invalid ticker format "${symbolIn}"` };
    const want = this.slot(demo ? 'DEMO' : 'LIVE', symbol);
    const provider = (this.provider && this.provider.mode === (demo ? 'DEMO' : 'LIVE') && this.slot(this.dataMode) === want) ? this.provider : this.providerFactory(want);
    if (!provider) return { ok: false, error: 'REAL-TIME MARKET DATA UNAVAILABLE: Alpaca API credentials are not configured (Settings → Credentials).' };
    try {
      const asset = await provider.fetchAsset(symbol);
      if (!asset) return { ok: false, error: `Symbol ${symbol} not found` };
      let snap = null;
      try { snap = await provider.fetchSnapshot(symbol); } catch (e) { snap = { error: e.message }; }
      const warnings = [];
      if (asset.status && asset.status !== 'active') warnings.push(`Asset status is ${asset.status}`);
      if (asset.tradable === false) warnings.push('Asset is marked not tradable by the provider');
      if (!snap || (!snap.latestTrade && !snap.error)) warnings.push('No trades reported yet for this symbol on the selected feed (e.g. IPO not yet open, or no IEX prints).');
      if (snap && snap.error) warnings.push(`Snapshot unavailable: ${snap.error}`);
      return {
        ok: true, symbol, name: asset.name, exchange: asset.exchange, status: asset.status, tradable: asset.tradable, fractionable: asset.fractionable,
        lastTrade: snap && snap.latestTrade ? { price: snap.latestTrade.p, time: snap.latestTrade.t } : null,
        quote: snap && snap.latestQuote ? { bid: snap.latestQuote.bp, ask: snap.latestQuote.ap, time: snap.latestQuote.t } : null,
        dailyBar: snap && snap.dailyBar ? snap.dailyBar : null, prevDailyBar: snap && snap.prevDailyBar ? snap.prevDailyBar : null,
        feed: provider.feedInfo(), warnings, demo,
      };
    } catch (e) {
      if (e.status === 404) return { ok: false, error: `Symbol ${symbol} not found by ${provider.feedInfo().provider}` };
      if (e.status === 401 || e.status === 403) return { ok: false, error: `Market data provider rejected the credentials (${e.message})` };
      return { ok: false, error: `Symbol verification failed: ${e.message}` };
    }
  }

  /** One market-data provider (one WebSocket) per data mode, shared by all symbols of the book. */
  acquireProvider(mode) {
    const ex = this.book.providers.get(mode);
    if (ex && ex.provider && !ex.stale) { ex.users.add(this); return ex.provider; }
    const provider = this.providerFactory(mode);
    if (!provider) return null;
    this.book.providers.set(mode, { provider, users: new Set([this]), connected: false });
    return provider;
  }

  releaseProvider() {
    const p = this.provider;
    if (!p) return;
    for (const [ev, fn] of this.providerHandlers) p.removeListener(ev, fn);
    this.providerHandlers = [];
    const entry = [...this.book.providers.entries()].find(([, e]) => e.provider === p);
    if (entry) {
      entry[1].users.delete(this);
      if (this.symbol && entry[1].users.size && p.unsubscribe) { try { p.unsubscribe([this.symbol]); } catch { /* ignore */ } }
      if (!entry[1].users.size) { this.book.providers.delete(entry[0]); try { p.disconnect(); } catch { /* ignore */ } }
    } else { try { p.disconnect(); } catch { /* ignore */ } }
    this.provider = null;
  }

  /** Recreate the shared provider (credentials or feed changed): every symbol reconnects. */
  invalidateProviders() { for (const e of this.book.providers.values()) e.stale = true; }

  async loadMarket(symbol, mode = 'LIVE') {
    this.releaseProvider();
    this.news.stop();
    this.symbol = symbol;
    this.dataMode = mode;
    const m = this.cfg().market;
    this.market = new MarketState({ symbol, cfg: m });
    this.candles = new CandleStore({ symbol });
    this.loadedTfs.clear();
    this.lastAnalysis = null;
    this.cond.reset();
    this.lastSessionKey = null;
    this.lastSessionInfo = null;
    this.diag = null;
    this.lastDiagAt = 0;
    this.quiet = null;
    this.outage = null;
    this.verifyPending = null;
    this.lastClockSyncAt = 0;
    this.activity.info('MARKET', `Loading ${symbol} (${mode === 'DEMO' ? 'DEMO synthetic data' : mode})…`, { source: 'system' });
    const slot = this.slot(mode);
    const provider = this.acquireProvider(slot);
    this.provider = provider;
    if (!provider) {
      this.market.setConnection('UNAVAILABLE', 'Alpaca API credentials not configured', this.now());
      this.market.unavailableReason = 'Alpaca market data credentials are not configured. Enter your Alpaca key ID and secret in Settings → Credentials (a free Alpaca paper account provides real-time IEX data).';
      this.activity.error(`REAL-TIME MARKET DATA UNAVAILABLE: ${this.market.unavailableReason}`, { source: 'market data' });
      this.markDirty();
      return false;
    }
    this.market.setFeed(provider.feedInfo());
    this.attachProvider(provider);
    const feedInfo = provider.feedInfo();
    const sharedCal = this.book.calendars.get(slot);
    if (sharedCal && sharedCal.provider === provider) {
      this.calendar = sharedCal.calendar; // same exchange calendar and clock for every symbol
    } else {
      this.calendar = new MarketCalendar({
        fetchCalendar: (a, b) => provider.fetchCalendar(a, b),
        fetchClock: slot === 'LIVE' && provider.fetchClock ? () => provider.fetchClock() : null,
        alwaysOpen: slot === 'CRYPTO' ? 'CRYPTO' : mode === 'DEMO',
        coverage: mode === 'LIVE' ? ((m.feedCoverage || {})[feedInfo.feed] || null) : null,
        overnight: mode === 'LIVE' ? (m.overnight || null) : null,
      });
      try {
        const ok = await this.calendar.load(this.now());
        if (ok && this.calendar.days.size) this.activity.ok('MARKET', `Market calendar loaded (${this.calendar.source})`, { source: 'Alpaca /v2/calendar' });
        else if (mode !== 'DEMO') { this.calendar.days.clear(); this.activity.warn('Trading calendar unavailable — using weekday estimate (holidays not detected)', { source: 'calendar' }); }
      } catch (e) {
        this.calendar.days.clear();
        this.activity.warn(`Trading calendar unavailable (${e.message}) — using weekday estimate`, { source: 'Alpaca /v2/calendar' });
      }
      this.book.calendars.set(slot, { calendar: this.calendar, provider });
      await this.syncClock(true);
      if (this.calendar.coverage) this.activity.info('MARKET', `Feed coverage: ${this.calendar.coverage.note}`, { source: feedInfo.label });
    }
    // Asset / symbol validation
    try {
      this.asset = await provider.fetchAsset(symbol);
      this.activity.ok('MARKET', `Ticker verified: ${symbol} — ${this.asset.name || 'n/a'} (${this.asset.exchange || 'n/a'}, ${this.asset.status || 'n/a'})`, { source: `${provider.feedInfo().provider} assets` });
    } catch (e) {
      this.asset = null;
      const notFound = e.status === 404;
      const msg = notFound ? `Stock symbol ${symbol} not found` : `Asset lookup failed: ${e.message}`;
      this.activity.error(msg, { source: 'assets' });
      if (notFound || e.status === 401 || e.status === 403) {
        this.market.setConnection('UNAVAILABLE', msg, this.now());
        this.market.unavailableReason = e.status === 401 || e.status === 403 ? `Alpaca rejected the credentials (${e.message}).` : msg;
        this.markDirty();
        return false;
      }
    }
    this.news.setSymbol(symbol, this.asset && this.asset.name);
    await this.loadHistory();
    await this.seedFromSnapshot();
    this.candles.track(this.cfg().ai.analysisTimeframe);
    this.candles.track('1m');
    const si = this.sessionInfo();
    if (provider.setMarketActive) provider.setMarketActive(!!(si.feed && si.feed.active));
    provider.subscribe([symbol]);
    const pe = this.book.providers.get(slot);
    if (pe && !pe.connected) { pe.connected = true; provider.connect(); }
    else if (provider.state) this.market.setConnection(provider.state, 'shared market data stream', this.now());
    this.news.start();
    if (this.primary) this.pollBroadMarket();
    if (this.secondary) this.secondary.subscribe(symbol);
    this.markDirty();
    return true;
  }

  attachProvider(p) {
    const on = (ev, fn) => { p.on(ev, fn); this.providerHandlers.push([ev, fn]); };
    on('connection', ({ state, detail }) => this.onConnectionState(state, detail));
    on('reconnectScheduled', (r) => { if (this.streamLead || !this.book.agents.size) this.onReconnectScheduled(r); else if (this.market) { this.outage = this.outage || { since: this.now(), attempts: 0, lastLogAt: this.now() }; this.outage.attempts = r.attempt; } });
    on('heartbeat', (h) => { if (this.market) this.market.onHeartbeat(h); });
    on('subscribed', (m) => this.onSubscribed(m));
    on('error', (e) => {
      // identical errors (e.g. "connect ECONNREFUSED" on every retry) are logged once per reminder window
      const now = this.now();
      if (!this.cond.shouldLog(`provider-error:${e.code || ''}:${String(e.message).slice(0, 120)}`, 'x', now)) return;
      if (!this.streamLead) return; // the shared stream's errors are logged once, by the primary symbol
      this.activity.error(e.message, { source: this.feedName(), details: e.code ? { code: e.code } : null });
    });
    on('info', (e) => { if (this.streamLead) this.activity.info('MARKET', e.message, { source: this.feedName() }); });
    on('trade', (t) => this.onTrade(t));
    on('quote', (q) => this.onQuote(q));
    on('bar', (b) => this.onMinuteBar(b, false));
    on('updatedBar', (b) => this.onMinuteBar(b, true));
    on('dailyBar', (b) => { if (b.symbol === this.symbol) { this.candles.onDailyBar(b); this.dirty.candles = true; } });
    on('status', (s) => {
      if (s.symbol !== this.symbol) return;
      const before = this.market.halted;
      this.market.onStatus({ ...s, source: 'Alpaca trading status stream' });
      this.activity.info('MARKET', `Trading status ${s.code}: ${s.message || ''}${s.reasonMessage ? ` (${s.reasonMessage})` : ''}`, { status: this.market.halted ? 'warn' : 'info', source: 'Alpaca statuses' });
      if (before !== this.market.halted) this.onHaltChange();
    });
    on('luld', (l) => { if (l.symbol === this.symbol) this.market.luld = { up: l.up, down: l.down, ts: l.ts }; });
  }

  /**
   * Stream connection phases. The first loss of a working stream is logged once; while the outage lasts,
   * the per-attempt CONNECTING/AUTHENTICATING/RECONNECTING churn is not logged (onReconnectScheduled
   * reports attempts 1–3 and then a reminder every few minutes).
   */
  onConnectionState(state, detail) {
    if (!this.market) return;
    const now = this.now();
    const prev = this.market.connection.state;
    this.market.setConnection(state, detail, now);
    this.markDirty();
    if (state === prev) return;
    const src = this.feedName();
    const down = state === 'DISCONNECTED' || state === 'RECONNECTING';
    if (!this.primary) {
      // shared stream: the primary logs connection changes once; followers only track the outage for recovery
      if (down && prev === 'SUBSCRIBED' && !this.outage) this.outage = { since: now, attempts: 0, lastLogAt: now };
      return;
    }
    if (down && prev === 'SUBSCRIBED' && !this.outage) {
      this.outage = { since: now, attempts: 0, lastLogAt: now };
      const si = this.sessionInfo();
      const closed = si.feed && !si.feed.active;
      this.activity.warn(`Market data connection lost (${detail || state.toLowerCase()}). ${closed ? 'Market is closed for this feed — reconnecting with a slow backoff.' : 'New simulated trades are blocked; reconnecting with exponential backoff.'}`, { source: src });
      return;
    }
    if (this.outage) {
      if (state === 'ERROR') this.activity.error(`Market data stream error while reconnecting: ${detail}`, { source: src });
      return; // SUBSCRIBED is handled in onSubscribed (recovery)
    }
    if (state === 'CONNECTING') this.activity.info('MARKET', `Connecting to market data stream (${detail})`, { source: src });
    else if (state === 'AUTHENTICATING') this.activity.info('MARKET', 'Market data socket open, authenticating…', { source: src });
    else if (state === 'AUTHENTICATED') this.activity.ok('MARKET', `Market data stream authenticated${detail && /not confirmed/.test(detail) ? ` — ${detail}` : ''}`, { source: src });
    else if (state === 'ERROR') this.activity.error(`Market data stream error: ${detail}`, { source: src });
    else if (down && prev !== 'DISCONNECTED' && prev !== 'RECONNECTING') this.activity.warn(`Market data ${state.toLowerCase()}: ${detail}`, { source: src });
  }

  onReconnectScheduled({ attempt, delayMs, marketActive, reason }) {
    if (!this.market) return;
    const now = this.now();
    if (!this.outage) this.outage = { since: now, attempts: 0, lastLogAt: 0 };
    this.outage.attempts = attempt;
    const remind = (this.cfg().market.statusReminderMin || 5) * 60000;
    if (attempt <= 3 || now - this.outage.lastLogAt >= remind) {
      this.outage.lastLogAt = now;
      const tail = attempt > 3 ? ` — still unresolved after ${fmtDuration(now - this.outage.since)}` : '';
      this.activity.info('MARKET', `Reconnect attempt ${attempt} in ${(delayMs / 1000).toFixed(1)}s${marketActive === false ? ' (market closed: slow retry)' : ''}${reason ? ` — ${reason}` : ''}${tail}`, { status: 'warn', source: this.feedName() });
    }
  }

  /** Provider confirmed the symbol's subscription (initial connect, reconnect, or verification). */
  onSubscribed(m) {
    if (!this.market) return;
    const now = this.now();
    const sub = this.market.onSubscription(m || {}, now);
    const src = this.feedName();
    const channels = `trades${sub.trades ? '✓' : '✗'} quotes${sub.quotes ? '✓' : '✗'} bars${sub.bars ? '✓' : '✗'}${sub.statuses ? ' status✓' : ''}`;
    if (m && m.verify) {
      this.activity.ok('MARKET', `Subscription verified for ${this.symbol} (${channels})`, { source: src });
      return;
    }
    this.verifyPending = { since: now, after: this.outage ? 'reconnect' : 'connect' };
    if (this.outage) {
      const o = this.outage;
      this.outage = null;
      this.activity.ok('MARKET', `Market data stream restored after ${fmtDuration(now - o.since)} (${o.attempts} attempt${o.attempts === 1 ? '' : 's'}): authenticated and subscribed ${this.symbol} (${channels}). Verifying incoming data and loading missed candles…`, { source: src });
      this.recoverAfterOutage(o).catch((e) => this.activity.error(`Recovery after reconnect failed: ${e.message}`, { source: src }));
    } else {
      this.activity.ok('MARKET', `Subscribed to ${this.symbol}: ${channels} — waiting for the first live message`, { source: src });
    }
    this.markDirty();
  }

  /** After a stream outage: refresh latest trade/quote for display, fetch missing minute candles. */
  async recoverAfterOutage(outage) {
    if (this.dataMode !== 'LIVE' || !this.provider) return;
    await this.backfillMinutes(`stream outage of ${fmtDuration(this.now() - outage.since)}`);
    await this.refreshLatestFromSnapshot();
  }

  /** Fetch official 1-minute bars missing since the newest one held (REST). Nothing is synthesized. */
  async backfillMinutes(why) {
    if (!this.provider || !this.candles || this.dataMode !== 'LIVE') return 0;
    const now = this.now();
    const last = this.candles.lastOfficialMinute();
    const windowStart = this.candles.minutesStart;
    const fromSec = last != null ? last + 60 : windowStart;
    if (fromSec == null || now - fromSec * 1000 < 60000) return 0;
    const src = `${this.market.feed.provider} historical bars`;
    try {
      const bars = await this.provider.fetchMinuteWindow(this.symbol, fromSec * 1000);
      const added = this.candles.mergeMinutes(bars, this.now());
      const curMin = Math.floor(this.now() / 60000) * 60;
      const lastDone = bars.filter((b) => b.time < curMin).pop();
      if (lastDone) this.market.onBar({ ...lastDone, source: 'rest', receivedAt: this.now() });
      if (added) {
        this.dirty.candles = true;
        this.chartVersion++;
        this.activity.ok('MARKET', `Loaded ${added} missing 1-minute candle(s) since ${etTimeStr(fromSec * 1000, false)} ET (${why}) — official ${this.market.feed.feed.toUpperCase()} bars`, { source: src });
      } else {
        this.activity.info('MARKET', `No missing candles since ${etTimeStr(fromSec * 1000, false)} ET (${why}): the feed reported no trades in that period`, { source: src });
      }
      return added;
    } catch (e) {
      this.activity.warn(`Could not load missing candles (${why}): ${e.message}`, { source: src });
      return 0;
    }
  }

  /** Latest trade/quote from the REST snapshot (exchange timestamps kept; never replaces newer stream data). */
  async refreshLatestFromSnapshot() {
    try {
      const s = await this.provider.fetchSnapshot(this.symbol);
      if (!s) return;
      if (s.latestTrade && s.latestTrade.p > 0) {
        const ts = Date.parse(s.latestTrade.t);
        this.market.onTrade({ price: s.latestTrade.p, size: s.latestTrade.s || 0, ts, receivedAt: this.now(), exchange: s.latestTrade.x, source: 'snapshot' });
      }
      if (s.latestQuote && s.latestQuote.ap > 0) {
        const ts = Date.parse(s.latestQuote.t);
        this.market.onQuote({ bid: s.latestQuote.bp, ask: s.latestQuote.ap, bidSize: s.latestQuote.bs, askSize: s.latestQuote.as, ts, receivedAt: this.now(), source: 'snapshot' });
      }
      this.markDirty();
    } catch (e) {
      this.activity.warn(`Snapshot refresh failed: ${e.message}`, { source: 'snapshot' });
    }
  }

  onHaltChange() {
    if (this.market.halted) {
      this.activity.warn(`MARKET HALTED: ${this.symbol} trading halted (${(this.market.haltInfo && (this.market.haltInfo.reason || this.market.haltInfo.code)) || 'reason n/a'}). No simulated fills during the halt; pending orders stay pending.`, { source: this.market.haltInfo && this.market.haltInfo.source });
    } else {
      this.activity.ok('MARKET', `${this.symbol} trading resumed`, { source: this.market.haltInfo && this.market.haltInfo.source });
    }
    this.scheduler.trigger({ type: 'RISK_CHANGE', key: 'halt', detail: this.market.halted ? 'trading halt' : 'halt lifted' });
    this.markDirty();
  }

  async loadHistory() {
    const p = this.provider;
    const now = this.now();
    const sym = this.symbol;
    const windowDate = this.calendar.liveWindowDate(now);
    this.liveWindowDate = windowDate;
    const startMs = isCrypto(this.symbol) ? now - 24 * 3600e3 : this.dataMode === 'DEMO' ? now - 6 * 3600e3 : etWallToUtcMs(windowDate, 4, 0);
    try {
      const mins = await p.fetchMinuteWindow(sym, startMs);
      this.candles.setMinutes(mins, Math.floor(startMs / 1000), now);
      this.activity.ok('MARKET', `Loaded ${mins.length} one-minute bars for the live window (from ${etTimeStr(startMs, false)} ET ${etDateStr(startMs)})`, { source: `${this.market.feed.provider} historical bars` });
      this.loadedTfs.add('1m');
    } catch (e) {
      this.activity.error(`Historical 1-minute data failed: ${e.message}`, { source: 'historical bars' });
    }
    const tfs = [...new Set([this.cfg().ai.analysisTimeframe, '1d', '1m'])];
    for (const tf of tfs) await this.loadTf(tf);
    const d = this.candles.history['1d'] || [];
    const L = this.cfg().risk.ipoMode;
    const newly = d.length < L.newListingSessions;
    this.ipo = {
      isNewlyListed: newly, dailyBarsAvailable: d.length, firstDailyBar: d.length ? etDateStr(d[0].time * 1000) : null,
      active: L.enabled === 'on' || (L.enabled === 'auto' && newly), mode: L.enabled,
      reference: (this.cfg().market.ipoReferences || {})[sym] || null,
    };
    if (!d.length) this.activity.warn(`No daily history for ${sym} on this feed — long-term indicators unavailable`, { source: 'historical bars' });
    if (d.length < 200) this.activity.info('ANALYSIS', `Daily SMA200 unavailable: only ${d.length} daily bars exist${newly ? ' (newly listed stock — long-term indicators will not be fabricated)' : ''}`, { source: 'indicator engine' });
    if (this.ipo.active) this.activity.warn(`IPO / new-listing mode ACTIVE for ${sym}: stricter spread, volatility, seasoning and allocation checks`, { source: 'risk engine' });
    if (this.ipo.reference) this.activity.info('MARKET', `IPO reference (configuration, not market data): offer price $${this.ipo.reference.offerPrice} on ${this.ipo.reference.date}. Live price always comes from the data feed.`, { source: 'config' });
    this.dirty.candles = true;
    this.chartVersion++;
  }

  async loadTf(tf) {
    if (tf === '1m' && this.candles.history['1m']) return;
    try {
      const bars = await this.provider.fetchBars(this.symbol, tf, { limit: this.cfg().market.historyBars });
      this.candles.setHistory(tf, bars, this.now());
      this.loadedTfs.add(tf);
      this.chartVersion++;
      this.activity.ok('MARKET', `Historical ${tf} data loaded: ${bars.length} bars${bars.length ? ` (${etDateStr(bars[0].time * 1000)} → ${etDateStr(bars[bars.length - 1].time * 1000)})` : ''}`, { source: `${this.market.feed.provider} historical bars (${this.cfg().market.adjustment}-adjusted)` });
    } catch (e) {
      this.activity.error(`Historical ${tf} data failed: ${e.message}`, { source: 'historical bars' });
    }
  }

  async ensureTf(tf) {
    if (!isValidTf(tf)) throw new Error('invalid timeframe');
    if (!this.candles) return;
    if (!this.loadedTfs.has(tf)) await this.loadTf(tf);
  }

  async seedFromSnapshot() {
    const lm = this.candles.lastOfficialMinute();
    if (lm != null) this.market.onBar({ ...this.candles.minutes.get(lm), receivedAt: this.now(), source: 'rest' });
    try {
      const s = await this.provider.fetchSnapshot(this.symbol);
      if (!s) { this.activity.warn(`No snapshot (last trade/quote) available yet for ${this.symbol} on this feed`, { source: 'snapshot' }); return; }
      // Seed with the provider's own exchange timestamps — never presented as fresher than they are.
      // Snapshot data is for display only: execution waits for a quote delivered by the live stream.
      const recv = this.now();
      if (s.latestTrade && s.latestTrade.p > 0) {
        const ts = Date.parse(s.latestTrade.t);
        this.market.onTrade({ price: s.latestTrade.p, size: s.latestTrade.s || 0, ts, receivedAt: recv, exchange: s.latestTrade.x, source: 'snapshot' });
      }
      if (s.latestQuote && s.latestQuote.ap > 0) {
        const ts = Date.parse(s.latestQuote.t);
        this.market.onQuote({ bid: s.latestQuote.bp, ask: s.latestQuote.ap, bidSize: s.latestQuote.bs, askSize: s.latestQuote.as, ts, receivedAt: recv, source: 'snapshot' });
      }
      const parts = [];
      if (s.latestTrade) parts.push(`last trade $${fmt(s.latestTrade.p, 4)} at ${etTimeStr(Date.parse(s.latestTrade.t))} ET ${etDateStr(Date.parse(s.latestTrade.t))}`);
      if (s.latestQuote) parts.push(`last bid/ask ${fmt(s.latestQuote.bp, 4)} / ${fmt(s.latestQuote.ap, 4)} at ${etTimeStr(Date.parse(s.latestQuote.t))} ET`);
      if (parts.length) this.activity.info('MARKET', `Snapshot: ${parts.join('; ')}`, { source: `${this.feedName()} snapshot` });
    } catch (e) {
      this.activity.warn(`Snapshot request failed: ${e.message}`, { source: 'snapshot' });
    }
  }

  onTrade(t) {
    if (!this.market || t.symbol && t.symbol !== this.symbol) return;
    if (!this.market.onTrade(t)) return;
    this.candles.onTrade(t);
    this.msgStats.trades++;
    this.dirty.candles = true;
    this.noteStreamVerified('trade', t);
    this.onPriceUpdate();
  }

  onQuote(q) {
    if (!this.market || q.symbol && q.symbol !== this.symbol) return;
    this.market.onQuote(q);
    this.msgStats.quotes++;
    this.noteStreamVerified('quote', q);
    this.onPriceUpdate();
  }

  onMinuteBar(b, updated) {
    if (!this.market || b.symbol && b.symbol !== this.symbol) return;
    this.candles.onMinuteBar(b);
    this.market.onBar(b);
    this.msgStats.bars++;
    this.dirty.candles = true;
    this.noteStreamVerified('minute bar', { ts: (b.time + 60) * 1000, receivedAt: b.receivedAt });
    if (updated) this.activity.info('MARKET', `Minute bar ${etTimeStr(b.time * 1000, false)} corrected by provider (late trades)`, { source: this.feedName() });
  }

  /** First live message after (re)subscribing proves data is actually flowing for the symbol. */
  noteStreamVerified(kind, m) {
    if (!this.verifyPending || (m && m.source && m.source !== 'stream')) return;
    const v = this.verifyPending;
    this.verifyPending = null;
    const now = this.now();
    this.activity.ok('MARKET', `Live data verified for ${this.symbol}: first ${kind} received ${fmtDuration(now - v.since)} after ${v.after === 'reconnect' ? 'resubscribing' : 'subscribing'} (exchange time ${m && Number.isFinite(m.ts) ? etTimeStr(m.ts) : 'n/a'} ET)`, { source: this.feedName() });
    this.markDirty();
  }

  /** Message-rate bookkeeping for the status panel; logged at most every market.rateReportSec. */
  reportMessageRate() {
    if (!this.market || !this.streamLead) return;
    const now = this.now();
    const { trades, quotes, bars, since } = this.msgStats;
    const mins = Math.max(1 / 60, (now - since) / 60000);
    this.msgRate = { tradesPerMin: trades / mins, quotesPerMin: quotes / mins, barsPerMin: bars / mins, at: now };
    this.msgStats = { trades: 0, quotes: 0, bars: 0, since: now };
    const acc = this.msgAcc || { trades: 0, quotes: 0, bars: 0, since };
    acc.trades += trades; acc.quotes += quotes; acc.bars += bars;
    this.msgAcc = acc;
    const every = (this.cfg().market.rateReportSec || 300) * 1000;
    if (now - this.lastRateLogAt >= every) {
      if (this.market.connection.state === 'SUBSCRIBED' && (acc.trades || acc.quotes)) {
        this.activity.info('MARKET', `Receiving market data: ${acc.trades} trades, ${acc.quotes} quotes, ${acc.bars} minute bars in the last ${fmtDuration(now - acc.since)}`, { source: this.feedName() });
      }
      this.lastRateLogAt = now;
      this.msgAcc = { trades: 0, quotes: 0, bars: 0, since: now };
    }
  }

  sessionInfo() { return this.calendar.info(this.now()); }

  /** Log source; watchlist symbols add their ticker because the message itself does not name it. */
  logSource(base = this.feedName()) { return this.primary ? base : `${base} · ${this.symbol}`; }

  /** Adaptive monitoring: reason why no NEW entry may be opened now (last minutes before the close), or null. */
  closingEntryBlock() {
    const mon = this.book.monitor;
    return mon && this.market ? mon.guard(() => mon.entryBlock(this.sessionInfo(), this.now())) : null;
  }

  /** Neutral feed name for log sources (the feed's LIVE label is only shown when data is actually live). */
  feedName() { return this.market ? (this.market.feed.name || this.market.feed.label) : 'provider'; }

  statusOpts() {
    const m = this.cfg().market;
    return { extendedHours: !!this.cfg().execution.extendedHours, waitGraceMs: (m.subscribeGraceSec || 60) * 1000 };
  }

  /** User-facing data status for the current session (see MarketState.dataStatus). */
  dataStatus(now = this.now(), si = this.sessionInfo()) {
    return this.market.dataStatus(now, si, this.statusOpts());
  }

  marketForRisk() {
    const si = this.sessionInfo();
    const f = this.market.freshness(this.now());
    return {
      realtime: this.market.feed.realtime, feedLabel: this.market.feed.label, connected: this.market.connection.state === 'SUBSCRIBED',
      stale: f.stale, staleReasons: f.reasons, quoteAgeMs: f.quoteAgeMs, halted: this.market.halted,
      haltReason: this.market.haltInfo && (this.market.haltInfo.reason || this.market.haltInfo.code), session: si.session,
    };
  }

  /** Called on every real trade/quote: protective orders, resting limits, level & proximity triggers. */
  onPriceUpdate() {
    // protective orders run for EVERY symbol of the book (shared session), not only the main one
    if (!this.portfolio || !this.session || !this.symbol || (this.book.agents.size && this.book.agents.get(this.symbol) !== this)) return;
    const q = this.market.quote();
    const last = this.market.lastTrade ? this.market.lastTrade.price : null;
    if (this.book.commands) { try { this.book.commands.onPrice(this); } catch (e) { if (this.cond.shouldLog('commands', e.message, this.now())) this.activity.error(`Order check failed: ${e.message}`); } }
    if (this.book.invest) { try { this.book.invest.onPrice(this); } catch (e) { if (this.cond.shouldLog('invest', e.message, this.now())) this.activity.error(`Investment check failed: ${e.message}`); } }
    const pos = this.portfolio.position(this.symbol);
    if (pos) {
      const trig = this.orders.evaluate(this.symbol, { bid: q && q.bid, ask: q && q.ask, last, lastTs: this.market.lastTrade && this.market.lastTrade.ts, nearPct: this.cfg().execution.nearTargetPct || 0 }, pos.qty);
      if (trig && this.now() - this.exitAttemptAt > 2000) {
        this.exitAttemptAt = this.now();
        this.executeExit({ fraction: 1, kind: trig.kind, trigger: trig, reason: `${trig.kind.replace('_', ' ')} ${fmt(trig.level, 4)} triggered by ${trig.triggeredBy} ${fmt(trig.triggerPrice, 4)}` });
      } else if (!trig) {
        const prox = this.orders.proximity(this.symbol, last || (q && (q.bid + q.ask) / 2));
        const near = this.cfg().ai.nearLevelPct;
        if (prox && prox.toStopPct != null && prox.toStopPct <= near) this.scheduler.trigger({ type: 'NEAR_STOP', detail: `price within ${prox.toStopPct.toFixed(0)}% of stop distance` });
        if (prox && prox.toTargetPct != null && prox.toTargetPct <= near) this.scheduler.trigger({ type: 'NEAR_TARGET', detail: `price within ${prox.toTargetPct.toFixed(0)}% of target distance` });
      }
    }
    if (this.orders.pendingFor(this.symbol).length) {
      for (const a of this.orders.checkPending(this.symbol, q, this.now())) {
        if (a.action === 'EXPIRE') {
          this.orders.cancelPending(a.order.id, 'expired');
          this.updateOrderStatus(a.order.id, { status: 'EXPIRED' });
          this.activity.info('EXECUTION', `Pending LIMIT BUY ${a.order.qty} @ ${fmt(a.order.limitPrice, 4)} expired unfilled`, { source: 'paper engine' });
          this.persist(); this.markDirty();
        } else if (a.action === 'FILLABLE' && !this.closingEntryBlock()) this.fillPendingLimit(a.order); // closing window: the order stays pending
      }
    }
    // Level-break trigger from the latest analysis levels
    const L = this.lastAnalysis && this.lastAnalysis.levels;
    if (L && last) {
      const brk = (type, lv) => {
        const k = `${etDateStr(this.now())}:${type}:${lv.price.toFixed(2)}`;
        this.breakNotified = this.breakNotified || new Set();
        if (this.breakNotified.has(k)) return;
        this.breakNotified.add(k);
        if (this.breakNotified.size > 200) this.breakNotified = new Set([k]);
        this.emitEvent('BREAKOUT', { type, level: lv.price, label: lv.label || null, price: last }, 'low', `brk:${this.symbol}:${k}`);
      };
      if (L.breakout && last > L.breakout.price && this.lastAnalysis.price <= L.breakout.price) brk('BREAKOUT', L.breakout);
      if (L.breakdown && last < L.breakdown.price && this.lastAnalysis.price >= L.breakdown.price) brk('BREAKDOWN', L.breakdown);
      if (L.breakout && last > L.breakout.price && this.lastAnalysis.price <= L.breakout.price) this.scheduler.trigger({ type: 'LEVEL_BREAK', key: `up${L.breakout.price.toFixed(2)}`, detail: `price ${last} broke above ${L.breakout.label} ${L.breakout.price.toFixed(2)}` });
      if (L.breakdown && last < L.breakdown.price && this.lastAnalysis.price >= L.breakdown.price) this.scheduler.trigger({ type: 'LEVEL_BREAK', key: `dn${L.breakdown.price.toFixed(2)}`, detail: `price ${last} broke below ${L.breakdown.label} ${L.breakdown.price.toFixed(2)}` });
    }
  }

  /**
   * 1-second housekeeping: session transitions, bar closes, data-status changes (logged ONCE per change,
   * with a reminder only if a problem persists), feed diagnosis, clock refresh, approval expiry.
   */
  tick() {
    if (!this.market || !this.candles) return;
    const now = this.now();
    const si = this.sessionInfo();
    this.handleSessionTransition(si, now);
    const mon = this.book.monitor;
    if (this.market.connection.state === 'SUBSCRIBED' || this.dataMode !== 'LIVE') {
      for (const ev of this.candles.checkRollovers(now)) {
        if (mon) mon.onBarClose(this, ev, si, now);
        this.onBarClose(ev, si);
      }
    }
    const ds = this.market.dataStatus(now, si, this.statusOpts());
    this.logDataStatus(ds, si, now);
    if (mon) mon.onTick(this, now, si, ds);
    if (ds.tradable && this.awaitingData && this.aiState === 'RUNNING') {
      this.awaitingData = false;
      this.scheduler.trigger({ type: 'DATA_READY', detail: 'market data became reliable' });
    }
    this.maybeDiagnose(ds, si, now);
    this.maybeSyncClock(si, now);
    for (const [id, a] of this.approvals) {
      if (now > a.expiresAt) {
        this.approvals.delete(id);
        this.finishDecision(a.decision, 'APPROVAL_EXPIRED', { note: 'Not approved within 90s' });
        this.activity.info('AI', `Proposal ${a.decision.action} expired without user approval`, { source: 'semi-autonomous mode' });
      }
    }
  }

  /** Log the data status when it CHANGES (stable code key, no ages), plus a reminder while a problem persists. */
  logDataStatus(ds, si, now) {
    const key = `${ds.code}|${ds.codes.join(',')}`;
    const r = this.cond.check('data-status', key, now, { code: ds.code, label: ds.label });
    if (!r) return;
    this.markDirty();
    const src = this.logSource();
    const holding = !!(this.portfolio && this.portfolio.position(this.symbol));
    const problem = (c) => ['STALE', 'RECONNECTING', 'UNAVAILABLE', 'HALTED', 'WAITING'].includes(c);
    if (!this.primary) {
      // quiet symbols flip between LIVE and STALE all day on a single-exchange feed: for watchlist symbols only
      // unavailability, halts and problems of an open position are reported
      if (r.kind === 'reminder' && !holding) return;
      if (['CLOSED', 'QUIET', 'WAITING'].includes(ds.code)) return;
      const announced = r.prev && r.prev.meta && ['HALTED', 'UNAVAILABLE'].includes(r.prev.meta.code);
      if (['LIVE', 'STALE'].includes(ds.code) && !holding && !(ds.code === 'LIVE' && announced)) { if (ds.code === 'LIVE') this.dataUnreliableSince = null; return; }
    }
    if (r.kind === 'reminder') {
      if (!problem(ds.code) || ds.code === 'UNAVAILABLE') return;
      if (ds.code === 'RECONNECTING') return; // onReconnectScheduled reports long outages
      this.activity.warn(`Still ${ds.label} — unresolved for ${fmtDuration(now - r.since)}: ${this.statusDetail(ds)}`, { source: src });
      return;
    }
    const prev = r.prev && r.prev.meta;
    if (ds.code === 'UNAVAILABLE' && this.market.unavailableReason) return; // already reported when loading
    if (ds.code === 'CONNECTING' || ds.code === 'RECONNECTING') return; // reported by the connection handlers
    if (ds.code === 'LIVE') {
      const wasProblem = prev && problem(prev.code) && prev.code !== 'WAITING';
      const q = this.market.quote();
      const body = `bid/ask ${q ? `${fmt(q.bid, 4)} / ${fmt(q.ask, 4)}` : 'n/a'}, quote age ${fmtAge(this.market.ages(now).quoteAgeMs)} by exchange time`;
      this.activity.ok('MARKET', wasProblem ? `Market data recovered — ${ds.label} (was ${prev.label} for ${fmtDuration(now - r.prev.since)}); ${body}` : `${ds.label}: ${body}`, { source: src });
      if (wasProblem && this.dataUnreliableSince) { this.emitEvent('DATA_RECOVERED', { label: ds.label, detail: `was ${prev.label} for ${fmtDuration(now - r.prev.since)}` }, 'normal', `data-ok:${this.symbol}:${this.dataUnreliableSince}`); this.dataUnreliableSince = null; }
      if (this.aiState === 'RUNNING' && prev && prev.code !== 'LIVE') this.scheduler.trigger({ type: 'DATA_READY', detail: 'market data became reliable' });
      return;
    }
    if (ds.code === 'CLOSED' || ds.code === 'QUIET') {
      this.activity.info('MARKET', `${ds.label}: ${this.statusDetail(ds)}`, { source: src });
      return;
    }
    if (ds.code === 'WAITING') { this.activity.info('MARKET', `${ds.label}: ${ds.detail}`, { status: 'pending', source: src }); return; }
    if (ds.code === 'DEMO' || ds.code === 'REPLAY') {
      if (ds.codes.length && prev) this.activity.warn(`${ds.label}: ${ds.detail}`, { source: src });
      return;
    }
    if (ds.code === 'UNAVAILABLE') { this.activity.error(`${ds.label}: ${ds.detail}`, { source: src }); this.noteDataUnreliable(ds, ds.detail, now); return; }
    this.activity.warn(`${ds.label}: ${this.statusDetail(ds)}`, { source: src });
    if (ds.code === 'STALE' || ds.code === 'HALTED') this.noteDataUnreliable(ds, this.statusDetail(ds), now);
  }

  /** One notification per unreliable-data episode (recovery sends DATA_RECOVERED). */
  noteDataUnreliable(ds, detail, now) {
    if (this.dataUnreliableSince) return;
    this.dataUnreliableSince = now;
    this.emitEvent('DATA_UNRELIABLE', { label: ds.label, code: ds.code, detail }, 'normal', `data-bad:${this.symbol}:${now}`);
  }

  /** Human-readable detail for a status, including last price/time and the latest diagnosis. */
  statusDetail(ds) {
    const parts = [];
    if (ds.code === 'CLOSED' || ds.code === 'QUIET') {
      const t = this.market.lastTrade;
      parts.push(ds.detail);
      if (t) parts.push(`last trade $${fmt(t.price, 4)} at ${etTimeStr(t.ts)} ET ${etDateStr(t.ts)}`);
      const si = this.sessionInfo();
      if (si.nextFeedOpenMs && ds.code === 'CLOSED' && si.feed && si.feed.name && si.feed.name !== 'feed') parts.push(`${si.feed.name} data resumes ${etDateStr(si.nextFeedOpenMs)} ${etTimeStr(si.nextFeedOpenMs, false)} ET`);
      if (si.nextOpenMs) parts.push(`regular session opens ${etDateStr(si.nextOpenMs)} ${etTimeStr(si.nextOpenMs, false)} ET`);
      parts.push('the chart keeps the last real candles; nothing is generated while closed');
      return parts.join(' · ');
    }
    parts.push(ds.codes.length ? ds.codes.map((c) => REASON_TEXT[c] || c).join('; ') : ds.detail);
    if (ds.codes.includes('QUOTE_STALE') && this.market.lastQuote) parts.push(`last bid/ask at ${etTimeStr(this.market.lastQuote.ts)} ET`);
    if (this.diag && ['STALE', 'WAITING'].includes(ds.code)) parts.push(this.diag.message);
    if (ds.code === 'STALE') parts.push('new simulated trades are paused until a current bid/ask arrives');
    return parts.join(' · ');
  }

  /** Market session / feed-coverage changes: log once, adjust reconnect policy, resume cleanly. */
  handleSessionTransition(si, now) {
    const key = `${si.dateStr}|${si.session}|${si.feed && si.feed.active ? 1 : 0}`;
    if (key === this.lastSessionKey) return;
    const prev = this.lastSessionInfo;
    this.lastSessionKey = key;
    this.lastSessionInfo = si;
    this.markDirty();
    const active = !!(si.feed && si.feed.active);
    if (this.provider && this.provider.setMarketActive) this.provider.setMarketActive(active);
    const named = si.feed && si.feed.name && si.feed.name !== 'feed' && si.feed.name !== 'DEMO';
    const feedWhy = si.feed && si.feed.reason && si.feed.reason !== si.reason ? ` (${si.feed.reason})` : '';
    const feedTxt = named ? (active ? ` — ${si.feed.name} data expected` : ` — no ${si.feed.name} data now${feedWhy}`) : '';
    const src = this.calendar.clock ? `${this.calendar.source} + Alpaca clock` : this.calendar.source;
    if (!this.primary) {
      // calendar, clock and session log are shared and handled once by the main symbol
      this.quiet = null;
      if (prev && active && !(prev.feed && prev.feed.active)) this.onMarketWake(si).catch((e) => this.activity.error(`Session start handling failed: ${e.message}`));
      if (prev && this.aiState === 'RUNNING' && this.portfolio && this.portfolio.position(this.symbol)) this.scheduler.trigger({ type: 'RISK_CHANGE', key: `session:${si.session}`, detail: `session ${si.marketStatus}` });
      return;
    }
    if (!prev) {
      this.activity.info('MARKET', `Market session: ${si.marketStatus}${si.estimated ? ' (estimated)' : ''}${si.reason && si.session === 'CLOSED' ? ` (${si.reason})` : ''}${feedTxt}`, { source: src });
      return;
    }
    this.activity.info('MARKET', `Market session changed: ${prev.marketStatus} → ${si.marketStatus}${si.reason && si.session === 'CLOSED' ? ` (${si.reason})` : ''}${feedTxt}`, { source: src });
    if (this.primary && prev.session !== si.session) this.emitEvent('MARKET_SESSION', { from: prev.session, to: si.session }, 'low', `sess:${si.dateStr}:${si.session}`);
    this.quiet = null;
    if (si.dateStr !== prev.dateStr && this.dataMode === 'LIVE') this.reloadCalendar();
    if (this.dataMode === 'LIVE') this.syncClock(false);
    if (active && !(prev.feed && prev.feed.active)) this.onMarketWake(si).catch((e) => this.activity.error(`Session start handling failed: ${e.message}`));
    if (this.aiState === 'RUNNING') this.scheduler.trigger({ type: 'RISK_CHANGE', key: `session:${si.session}`, detail: `session ${si.marketStatus}` });
  }

  /** Feed coverage started (pre-market on IEX, or the regular open): verify the stream, fill missing candles. */
  async onMarketWake(si) {
    if (this.dataMode !== 'LIVE' || !this.provider || this.wakeInFlight) return;
    this.wakeInFlight = true;
    try {
      const src = this.feedName();
      const windowDate = this.calendar.liveWindowDate(this.now());
      if (windowDate !== this.liveWindowDate) {
        this.activity.info('MARKET', `New trading day ${windowDate}: loading the new live window and recent history`, { source: src });
        await this.loadHistory();
      } else {
        await this.backfillMinutes(`${si.marketStatus.toLowerCase()} started`);
      }
      const st = this.market.connection.state;
      if (st === 'SUBSCRIBED') {
        this.verifyPending = { since: this.now(), after: 'connect' };
        if (this.streamLead && this.provider.verifySubscription) this.provider.verifySubscription(); // one shared stream
      } else {
        this.activity.info('MARKET', `Stream is ${st.toLowerCase()} at session start — reconnecting now`, { source: src });
      }
    } finally {
      this.wakeInFlight = false;
    }
  }

  async reloadCalendar() {
    try { await this.calendar.load(this.now()); } catch (e) { this.activity.warn(`Trading calendar refresh failed: ${e.message}`, { source: 'Alpaca /v2/calendar' }); }
  }

  maybeSyncClock(si, now) {
    if (!this.streamLead || this.dataMode !== 'LIVE' || !this.calendar.fetchClock) return;
    const every = (this.cfg().market.clockRefreshSec || 300) * 1000;
    if (now - this.lastClockSyncAt >= every) this.syncClock(false);
  }

  /** Official Alpaca market clock (open/closed now, next open/close, server time -> local clock skew). */
  async syncClock(initial) {
    if (!this.calendar.fetchClock || this.clockSyncInFlight) return;
    this.clockSyncInFlight = true;
    this.lastClockSyncAt = this.now();
    try {
      const c = await this.calendar.syncClock(this.now());
      if (initial && c) this.activity.ok('MARKET', `Alpaca market clock: market ${c.isOpen ? 'OPEN' : 'CLOSED'}; next ${c.isOpen ? `close ${etTimeStr(c.nextCloseMs, false)} ET` : `open ${etDateStr(c.nextOpenMs)} ${etTimeStr(c.nextOpenMs, false)} ET`}`, { source: 'Alpaca /v2/clock' });
      if (c && c.skewMs != null && Math.abs(c.skewMs) > 2000 + (c.latencyMs || 0) / 2) {
        if (this.cond.shouldLog('clock-skew', String(Math.sign(c.skewMs)), this.now())) {
          this.activity.warn(`Local clock differs from Alpaca's server clock by ${(c.skewMs / 1000).toFixed(1)}s — data ages are measured against the local clock; please sync your system time`, { source: 'Alpaca /v2/clock' });
        }
      }
      if (this.cond.get('clock-error')) { this.cond.reset('clock-error'); this.activity.ok('MARKET', 'Alpaca market clock available again', { source: 'Alpaca /v2/clock' }); }
      this.markDirty();
    } catch (e) {
      // the calendar is a working fallback: report the failure once (until the clock works again)
      const r = this.cond.check('clock-error', e.message, this.now());
      if (r && r.kind === 'change') this.activity.warn(`Alpaca market clock unavailable (${e.message}) — using the trading calendar`, { source: 'Alpaca /v2/clock' });
    } finally {
      this.clockSyncInFlight = false;
    }
  }

  /**
   * When the feed should be active but no current quote arrives: compare the stream with REST snapshots
   * of the symbol and a liquid reference symbol to tell "stream not delivering" apart from "this stock is
   * quiet on IEX" and "the whole feed is quiet". Runs at most every market.diagnoseIntervalSec.
   */
  maybeDiagnose(ds, si, now) {
    if (!this.primary || isCrypto(this.symbol) || this.dataMode !== 'LIVE' || !this.provider || !this.provider.fetchSnapshots) return; // may reconnect the SHARED stream
    if (ds.code === 'LIVE' || ds.code === 'CLOSED' || !(si.feed && si.feed.active)) {
      if (this.diag) { this.diag = null; this.cond.reset('diagnosis'); this.markDirty(); }
      return;
    }
    if (ds.code !== 'STALE' && !(ds.code === 'WAITING' && this.market.subscribedAt && now - this.market.subscribedAt > 20000)) return;
    const every = (this.cfg().market.diagnoseIntervalSec || 60) * 1000;
    if (this.diagInFlight || now - this.lastDiagAt < every) return;
    this.lastDiagAt = now;
    this.diagInFlight = true;
    this.diagnoseFeed(now).finally(() => { this.diagInFlight = false; });
  }

  async diagnoseFeed(now) {
    const sym = this.symbol;
    const ref = this.cfg().market.feedCheckSymbol || 'SPY';
    const feedName = (this.calendar.coverage && this.calendar.coverage.name) || String(this.market.feed.feed || '').toUpperCase();
    let diag;
    try {
      const snaps = await this.provider.fetchSnapshots(ref === sym ? [sym] : [sym, ref]);
      const s = (snaps && snaps[sym]) || {};
      const r = (snaps && snaps[ref]) || {};
      const ts = (x) => (x && x.t ? Date.parse(x.t) : null);
      const restQ = ts(s.latestQuote);
      const restT = ts(s.latestTrade);
      const streamQ = this.market.lastQuote && this.market.lastQuote.source === 'stream' ? this.market.lastQuote.ts : null;
      const knownQ = this.market.lastQuote ? this.market.lastQuote.ts : null;
      const refAge = ts(r.latestQuote) != null ? Math.max(0, now - ts(r.latestQuote)) : null;
      const limit = this.cfg().market.maxQuoteAgeMs;
      if (restQ != null && now - restQ <= Math.max(limit, 60000) && restQ > (streamQ || 0) + 5000) {
        diag = { code: 'STREAM_MISSING_UPDATES', message: `the REST snapshot has a newer ${sym} quote (${etTimeStr(restQ)} ET) than the stream delivered (${streamQ ? `${etTimeStr(streamQ)} ET` : 'none'}) — the stream is not delivering ${sym} updates; reconnecting` };
        if (now - this.lastForcedReconnectAt > 120000 && this.provider.forceReconnect) {
          this.lastForcedReconnectAt = now;
          this.provider.forceReconnect(`stream missing ${sym} updates that the REST snapshot has`);
        }
      } else if (refAge != null && refAge <= 60000) {
        diag = { code: 'SYMBOL_QUIET_ON_FEED', message: `the ${feedName} feed is working (${ref} quote ${fmtAge(refAge)} ago), but ${sym} has had no ${feedName} quote change since ${knownQ ? `${etTimeStr(knownQ)} ET` : 'subscribing'}${restT ? ` (last ${feedName} trade ${etTimeStr(restT)} ET)` : ''} — the stock currently has little or no activity on ${feedName}, a single venue with a small share of US volume; this is not a connection failure` };
      } else if (refAge != null) {
        diag = { code: 'FEED_QUIET', message: `no recent ${feedName} activity even for ${ref} (last quote ${fmtAge(refAge)} ago) — the ${feedName} feed or the market appears quiet` };
      } else {
        diag = { code: 'DIAG_NO_REFERENCE', message: `no REST snapshot for ${ref} to compare against` };
      }
    } catch (e) {
      diag = { code: 'DIAG_FAILED', message: `feed diagnosis via REST snapshot failed (${e.message})` };
    }
    this.diag = { ...diag, at: this.now(), refSymbol: ref };
    this.markDirty();
    // each distinct finding is logged once (reminders come from the STALE status itself)
    const r = this.cond.check('diagnosis', diag.code, this.now());
    if (r && r.kind === 'change') {
      const msg = `Feed diagnosis: ${diag.message}`;
      if (diag.code === 'STREAM_MISSING_UPDATES' || diag.code === 'DIAG_FAILED') this.activity.warn(msg, { source: `${this.feedName()} + REST snapshot` });
      else this.activity.info('MARKET', msg, { status: 'warn', source: `${this.feedName()} + REST snapshot` });
    }
  }

  onBarClose({ tf, bar }, si = this.sessionInfo()) {
    const atf = this.cfg().ai.analysisTimeframe;
    const feedActive = !si.feed || si.feed.active;
    const src = this.feedName();
    if (tf === '1m' && bar) {
      if (this.quiet) {
        const q = this.quiet;
        this.quiet = null;
        if (q.count > 1 && this.primary) this.activity.info('MARKET', `Trades resumed after ${q.count} minutes without trades on this feed (${etTimeStr(q.since * 1000, false)}–${etTimeStr(bar.time * 1000, false)} ET); no candles exist for those minutes`, { source: src });
      }
      if (this.primary) this.activity.info('MARKET', `New 1-minute candle completed ${etTimeStr(bar.time * 1000, false)} ET: O ${fmt(bar.open, 4)} H ${fmt(bar.high, 4)} L ${fmt(bar.low, 4)} C ${fmt(bar.close, 4)} V ${Math.round(bar.volume)}${bar.provisional ? ' (provisional — official bar pending)' : ''}`, { source: src });
      const mins = this.candles.completedBars('1m', this.now());
      const rv = Ind.relativeVolume(mins.map((b) => b.volume || 0), 20);
      const last = rv[rv.length - 1];
      if (last != null && last >= 3) {
        this.activity.info('ANALYSIS', `Abnormal volume: last minute ${last.toFixed(1)}x the 20-bar average`, { status: 'warn', source: this.logSource('indicator engine') });
        if (!(this.book.monitor && this.book.monitor.coversBar(this.symbol, bar.time))) this.scheduler.trigger({ type: 'UNUSUAL_VOLUME', detail: `1m relative volume ${last.toFixed(1)}x` });
      }
    } else if (tf === '1m' && !bar && feedActive) {
      const t = this.candles.lastClosed['1m'];
      if (!this.quiet) {
        this.quiet = { since: t, count: 1 };
        if (this.primary) this.activity.info('MARKET', `No trades on this feed in minute ${etTimeStr(t * 1000, false)} ET — no candle created (candles only come from real trades; further quiet minutes are summarised when trading resumes)`, { source: src });
      } else this.quiet.count++;
    }
    if (tf === atf) {
      const tradable = si.session === 'REGULAR' || (this.cfg().execution.extendedHours && (si.session === 'PRE' || si.session === 'POST'));
      const holding = this.portfolio && this.portfolio.position(this.symbol);
      if (!feedActive || (!tradable && !holding)) return; // closed: no updates expected, no analysis scheduled
      const pp = this.lastDecision && this.lastDecision.proposal;
      if (bar && pp && pp.keyLevels) {
        // the AI's own thesis broke on a closing basis: ask for a re-assessment (deterministic check)
        const sup = Math.max(...(pp.keyLevels.support || []).filter(Number.isFinite), -Infinity);
        const res = Math.min(...(pp.keyLevels.resistance || []).filter(Number.isFinite), Infinity);
        if (pp.directionalBias === 'BULLISH' && Number.isFinite(sup) && bar.close < sup) this.scheduler.trigger({ type: 'THESIS_INVALIDATED', key: `s${sup}`, detail: `close ${fmt(bar.close, 4)} below AI support ${fmt(sup, 4)}` });
        if (pp.directionalBias === 'BEARISH' && Number.isFinite(res) && bar.close > res) this.scheduler.trigger({ type: 'THESIS_INVALIDATED', key: `r${res}`, detail: `close ${fmt(bar.close, 4)} above AI resistance ${fmt(res, 4)}` });
      }
      if (!this.aiCfg().candleCloseTrigger) return; // economy mode: candle closes alone do not call the AI
      const mon = this.book.monitor;
      if (!this.primary && !(mon && mon.cfg().followerCandleClose)) return; // watchlist symbols: scheduled reviews + events (no analysis per candle)
      if (mon && !mon.allowRoutine(this)) return; // intensive phase: keep the last requests of the hour for real events
      this.activity.info('ANALYSIS', `${tf} candle closed${bar ? ` (C ${fmt(bar.close, 4)})` : ' (no trades)'} — scheduling analysis`, { source: 'candle builder' });
      this.scheduler.trigger({ type: 'CANDLE_CLOSE', key: String(this.candles.lastClosed[tf]), detail: `${tf} candle close` });
    }
  }

  async pollBroadMarket() {
    if (!this.primary) return;
    // index prices come from the stock stream, whichever symbol uses it
    const stock = [this, ...this.book.agents.values()].find((a) => a.symbol && !isCrypto(a.symbol) && a.provider);
    if (!stock || stock.provider.mode !== 'LIVE') { this.book.broadMarket = null; return; }
    const syms = this.cfg().market.broadMarketSymbols;
    try {
      const snaps = await stock.provider.fetchSnapshots(syms);
      const out = {};
      for (const s of syms) {
        const x = snaps[s];
        if (!x || !x.latestTrade) continue;
        const prev = x.prevDailyBar && x.prevDailyBar.c;
        out[s] = { price: x.latestTrade.p, time: x.latestTrade.t, changePct: prev ? ((x.latestTrade.p - prev) / prev) * 100 : null };
      }
      this.broadMarket = { available: Object.keys(out).length > 0, feed: this.feedName(), symbols: out, retrievedAt: new Date(this.now()).toISOString() };
    } catch (e) {
      this.broadMarket = { available: false, error: e.message };
    }
    this.book.broadMarket = this.broadMarket;
  }

  // ------------------------------------------------------------------ session control
  async startTrading({ symbol, initialCapital, targetCapital, demo = false, mode: modeIn = null }) {
    const sym = String(symbol || this.symbol || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(sym) && !isCrypto(sym)) throw new Error('Enter a valid ticker symbol');
    const cap = Number(initialCapital);
    if (!(cap >= 10 && cap <= 10_000_000)) throw new Error('Initial capital must be between $10 and $10,000,000');
    const tgt = targetCapital ? Number(targetCapital) : null;
    if (tgt != null && !(tgt > cap)) throw new Error('Target capital must be greater than initial capital');
    const mode = modeIn || (demo ? 'DEMO' : 'LIVE');
    if (mode === 'LIVE' && !this.deciderOverride && !this.book.publicData && !this.book.aiManager.anyConfigured()) throw new Error('No AI provider key is configured: add a DeepSeek or Gemini API key (Settings → Credentials).');
    let s = this.session;
    const hasActivity = s && this.portfolio && (this.portfolio.fillCount > 0 || this.portfolio.openPositionCount() > 0);
    if (s && (s.symbol !== sym || s.dataMode !== mode || Math.abs(s.initialCapital - cap) > 1e-9)) {
      if (hasActivity) throw new Error(`Session #${s.id} already has trades (${s.symbol}, $${s.initialCapital}). Use CHANGE STOCK (when flat) or RESET SIMULATION to start over.`);
      this.store.endSession(s.id);
      s = null;
    }
    if (!s) {
      const id = this.store.createSession({ symbol: sym, dataMode: mode, initialCapital: cap, targetCapital: tgt });
      this.session = this.store.getSession(id);
      this.portfolio = new Portfolio({ initialCapital: cap });
      this.risk = new RiskManager(this.cfg().risk);
      this.orders = new OrderManager();
      this.benchmark = null;
      this.lastDecision = null;
      this.riskReview = null;
      this.activity.ok('SYSTEM', `New PAPER session #${id}: ${sym}, initial capital $${cap.toFixed(2)}${tgt ? `, target $${tgt.toFixed(2)} (+${(((tgt - cap) / cap) * 100).toFixed(0)}%, not guaranteed)` : ''}${mode === 'DEMO' ? ' — DEMO synthetic data' : ''}`, { source: 'session' });
      this.persist();
    } else if (tgt != null && tgt !== s.targetCapital) {
      this.store.db.prepare('UPDATE sessions SET target_capital = ? WHERE id = ?').run(tgt, s.id);
      this.session.targetCapital = tgt;
    }
    if (this.symbol !== sym || !this.market || this.dataMode !== mode || this.market.connection.state === 'UNAVAILABLE') {
      const ok = await this.loadMarket(sym, mode);
      if (!ok) this.activity.warn('AI started but will wait: market data is unavailable', { source: 'session' });
    }
    this.aiError = null;
    this.setAiState('RUNNING');
    const d = this.decider();
    this.activity.ok('AI', `START AI TRADING — autonomous paper trading enabled (${d ? d.label : 'no decision engine'}, autonomy ${this.cfg().ai.autonomy})`, { source: 'user' });
    if (d && d.kind === 'rules') this.activity.warn('No AI key: this session uses the deterministic RULES BASELINE (not AI).', { source: 'decision engine' });
    this.scheduler.start();
    this.scheduler.trigger({ type: 'START', detail: 'user pressed START AI TRADING' });
    this.markDirty();
    return this.publicState();
  }

  pause() {
    if (this.aiState !== 'RUNNING') throw new Error('AI is not running');
    this.setAiState('PAUSED');
    this.scheduler.stop();
    this.activity.info('AI', 'AI PAUSED — no new AI-driven entries. Protective stop/target orders and risk controls remain active.', { status: 'warn', source: 'user' });
  }

  resume() {
    if (this.aiState !== 'PAUSED' && this.aiState !== 'STOPPED') throw new Error('AI is not paused');
    if (!this.session) throw new Error('No session');
    this.setAiState('RUNNING');
    this.aiError = null;
    this.scheduler.start();
    this.activity.ok('AI', 'AI RESUMED', { source: 'user' });
    this.scheduler.trigger({ type: 'START', detail: 'resumed' });
  }

  stop() {
    if (!this.session) throw new Error('No session');
    this.setAiState('STOPPED');
    this.scheduler.stop();
    for (const o of this.cancelPendingOrders('AI stopped')) this.activity.info('EXECUTION', `Pending order ${o.id} cancelled (AI stopped)`, { source: 'paper engine' });
    const pos = this.portfolio.position(this.symbol);
    this.activity.info('AI', `AI STOPPED.${pos ? ` Open paper position kept: ${pos.qty} sh @ ${fmt(pos.avgPrice, 4)} — still protected by stop ${fmt(this.orders.effectiveStop(this.symbol), 4)} / target ${fmt((this.orders.getProtection(this.symbol) || {}).takeProfit, 4)}. Use CLOSE PAPER POSITION to exit.` : ' No open position.'}`, { status: 'warn', source: 'user' });
    this.persist();
  }

  async closePosition() {
    if (!this.session) throw new Error('No session');
    const pos = this.portfolio.position(this.symbol);
    if (!pos) throw new Error('No open paper position');
    const r = this.executeExit({ fraction: 1, kind: 'USER', reason: 'User requested CLOSE PAPER POSITION' });
    if (!r || !r.ok) throw new Error(r && r.reason ? r.reason : 'Close failed');
    return r;
  }

  async reset() {
    if (this.session) {
      this.store.endSession(this.session.id);
      this.activity.warn(`RESET SIMULATION: session #${this.session.id} archived (history kept in the database).`, { source: 'user' });
    }
    this.scheduler.stop();
    this.approvals.clear();
    this.session = null;
    this.portfolio = null;
    this.risk = null;
    this.orders = new OrderManager();
    this.benchmark = null;
    this.lastDecision = null;
    this.riskReview = null;
    this.aiState = 'IDLE';
    this.aiError = null;
    this.markDirty();
  }

  async changeSymbol(symbolIn, { demo } = {}) {
    const sym = String(symbolIn || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(sym) && !isCrypto(sym)) throw new Error('Invalid ticker');
    const mode = demo != null ? (demo ? 'DEMO' : 'LIVE') : this.dataMode;
    if (this.session && this.portfolio) {
      if (this.portfolio.position(this.symbol)) throw new Error(`Close the open ${this.symbol} paper position before changing stock`);
      if (this.session.dataMode !== mode) throw new Error('Reset the simulation to switch between DEMO and LIVE data');
      const prevAi = this.aiState;
      const equity = this.portfolio.valuation({}).equity;
      const target = this.session.targetCapital;
      this.store.endSession(this.session.id);
      this.scheduler.stop();
      const id = this.store.createSession({ symbol: sym, dataMode: mode, initialCapital: equity, targetCapital: target && target > equity ? target : null, meta: { carriedFrom: this.session.id } });
      this.session = this.store.getSession(id);
      this.portfolio = new Portfolio({ initialCapital: equity });
      this.risk = new RiskManager(this.cfg().risk, { ...this.risk.toJSON(), dayStartEquity: this.risk.state.dayStartEquity });
      this.orders = new OrderManager();
      this.benchmark = null;
      this.lastDecision = null;
      this.riskReview = null;
      this.activity.ok('SYSTEM', `CHANGE STOCK: ${this.symbol} → ${sym}. Session #${id} continues with carried equity $${equity.toFixed(2)}.`, { source: 'user' });
      await this.loadMarket(sym, mode);
      this.persist();
      if (prevAi === 'RUNNING') { this.setAiState('RUNNING'); this.scheduler.start(); this.scheduler.trigger({ type: 'START', detail: 'stock changed' }); } else this.setAiState(prevAi === 'IDLE' ? 'STOPPED' : prevAi);
    } else {
      await this.loadMarket(sym, mode);
    }
    this.markDirty();
    return this.publicState();
  }

  changeCapital({ initialCapital, targetCapital }) {
    if (!this.session) throw new Error('Start a session first (capital is set when you press START)');
    const cap = initialCapital != null ? Number(initialCapital) : this.session.initialCapital;
    const tgt = targetCapital != null && targetCapital !== '' ? Number(targetCapital) : null;
    if (cap !== this.session.initialCapital) {
      if (this.portfolio.fillCount > 0) throw new Error('Capital cannot change after trades exist — RESET SIMULATION to start with new capital');
      if (!(cap >= 10)) throw new Error('Initial capital must be at least $10');
      this.portfolio = new Portfolio({ initialCapital: cap });
      this.risk = new RiskManager(this.cfg().risk);
      this.benchmark = null;
      this.store.db.prepare('UPDATE sessions SET initial_capital = ? WHERE id = ?').run(cap, this.session.id);
      this.session.initialCapital = cap;
    }
    if (tgt != null && !(tgt > cap)) throw new Error('Target must exceed initial capital');
    this.store.db.prepare('UPDATE sessions SET target_capital = ? WHERE id = ?').run(tgt, this.session.id);
    this.session.targetCapital = tgt;
    this.activity.info('PORTFOLIO', `Capital settings: initial $${cap.toFixed(2)}, target ${tgt ? `$${tgt.toFixed(2)}` : 'none'} (target never increases risk)`, { source: 'user' });
    this.persist();
    this.markDirty();
  }

  onConfigChange(cfg, patch) {
    if (this.risk) this.risk.setLimits(cfg.risk);
    this.usage.pricing = cfg.pricing;
    if (patch.ai && (patch.ai.regularIntervalSec != null) && this.scheduler.running) this.scheduler.resetInterval();
    if (this.primary && this.book.monitor && (patch.adaptiveMonitoring || patch.ai)) this.book.monitor.onConfigChange();
    if (patch.ai && patch.ai.analysisTimeframe && this.candles) { this.candles.track(cfg.ai.analysisTimeframe); this.ensureTf(cfg.ai.analysisTimeframe).catch(() => {}); }
    if (patch.market && patch.market.feed && this.symbol && this.dataMode === 'LIVE') {
      if (this.primary) this.activity.info('MARKET', `Feed changed to ${cfg.market.feed} — reconnecting`, { source: 'user' });
      this.loadMarket(this.symbol, this.dataMode).catch((e) => this.activity.error(e.message));
    }
    // risk state, portfolio and the settings log are shared by every symbol: handled once, by the main agent
    if (!this.primary) { this.markDirty(); return; }
    if (patch.risk && patch.risk.maxDrawdownPct && this.risk && this.risk.state.disabled) {
      this.risk.clearDisable();
      this.activity.info('RISK', 'Drawdown limit changed — trading-disabled flag cleared; it will re-trigger if the new limit is exceeded.', { source: 'user' });
    }
    if (patch.risk && patch.risk.maxDailyLossPct && this.risk && this.risk.state.dailyLocked) {
      this.risk.state.dailyLocked = null;
      this.activity.info('RISK', 'Daily loss limit changed — daily lock re-evaluated against the new limit.', { source: 'user' });
    }
    if (patch.risk && this.risk && this.portfolio) {
      // Apply changed limits immediately (daily loss / drawdown are re-checked now, not at the next sample).
      const val = this.valuation();
      for (const ev of this.risk.onEquity(val.equity, this.now())) this.activity.warn(`RISK LIMIT: ${ev.message}`, { source: 'risk engine' });
      this.riskReview = { at: this.now(), ...this.reviewRisk() };
      this.persist();
    }
    const keys = Object.keys(patch);
    if (keys.length === 1 && keys[0] === 'ui' && patch.ui.language) {
      this.activity.info('SYSTEM', `Interface language set to ${patch.ui.language === 'ar' ? 'Arabic' : 'English'}; new AI explanations will be written in ${patch.ui.language === 'ar' ? 'Arabic' : 'English'}`, { source: 'user' });
    } else if (!this.applyingProfile) {
      this.activity.info('SYSTEM', `Settings updated: ${keys.join(', ')}${patch.risk && patch.risk.profile === 'CUSTOM' ? ' (risk profile is now CUSTOM)' : ''}`, { source: 'user' });
    }
    this.markDirty();
  }

  // ------------------------------------------------------------------ risk profile
  /** Evaluate the open position / account against the CURRENT limits (nothing is sold automatically). */
  reviewRisk() {
    if (!this.risk || !this.portfolio) return null;
    const val = this.valuation();
    const exec = this.cfg().execution;
    const fractional = !!exec.fractionalShares;
    const agents = this.book.agents.size ? [...this.book.agents.values()] : [this];
    const held = agents.filter((a) => this.portfolio.position(a.symbol));
    const findings = [];
    const reduceSuggestions = [];
    let base = null;
    // account-level limits once, then each open position against the per-trade / per-symbol limits
    for (const a of held.length ? held : [this]) {
      const pos = this.portfolio.position(a.symbol);
      const mark = (a.market && a.market.mark()) || (pos && pos.avgPrice) || null;
      const r = this.risk.reviewExposure({ equity: val.equity, pos, mark, stop: pos ? this.orders.effectiveStop(a.symbol) : null, exec, nowMs: this.now(), fractional });
      if (!base) base = r;
      for (const f of r.findings) {
        if (['daily_loss', 'drawdown', 'open_positions'].includes(f.code)) { if (!findings.some((x) => x.code === f.code)) findings.push(f); continue; }
        findings.push({ ...f, params: { ...f.params, symbol: a.symbol } });
      }
      if (r.reduceQty > 0) reduceSuggestions.push({ symbol: a.symbol, qty: r.reduceQty });
    }
    const L = this.risk.limits;
    const openIdx = findings.findIndex((f) => f.code === 'open_positions');
    const openF = { code: 'open_positions', ok: held.length <= L.maxOpenPositions, params: { open: held.length, limit: L.maxOpenPositions } };
    if (openIdx >= 0) findings[openIdx] = openF; else findings.push(openF);
    const totalExposurePct = val.equity > 0 ? (val.positionValue / val.equity) * 100 : 0;
    const mine = reduceSuggestions.find((x) => x.symbol === this.symbol);
    return {
      compliant: findings.every((f) => f.ok), findings, reduceQty: mine ? mine.qty : (reduceSuggestions[0] ? reduceSuggestions[0].qty : 0),
      reduceSuggestions, entryBlocks: base ? base.entryBlocks : [], totalExposurePct, note: base ? base.note : '',
    };
  }

  /**
   * One-click risk level. Updates every profile-controlled limit in the deterministic engine at once,
   * enforces the stricter/looser rules immediately for new trades, and reviews the existing exposure.
   * It never closes or reduces a position by itself; it explains what would be required instead.
   */
  setRiskProfile(profile) {
    if (!PROFILES[profile]) throw new Error(`Unknown risk profile "${profile}"`);
    const prev = this.cfg().risk.profile || 'CUSTOM';
    this.applyingProfile = true;
    try { this.config.update(profilePatch(profile)); } finally { this.applyingProfile = false; }
    const L = this.cfg().risk;
    this.activity.ok('RISK', `Risk profile changed: ${prev} → ${profile}. Limits now: risk per trade ${L.maxRiskPerTradePct}%, daily loss ${L.maxDailyLossPct}%, max drawdown ${L.maxDrawdownPct}%, max allocation ${L.maxPositionPct}%, min R:R ${L.minRewardRisk}, max stop distance ${L.maxStopDistancePct}%, max open positions ${L.maxOpenPositions}. Applied to the risk engine immediately.`, { source: 'user' });
    const review = this.riskReview || (this.portfolio ? { at: this.now(), ...this.reviewRisk() } : null);
    if (review) {
      review.from = prev; review.to = profile;
      this.riskReview = review;
      const bad = review.findings.filter((f) => !f.ok);
      if (bad.length) {
        const parts = bad.map((f) => {
          if (f.code === 'allocation') return `${f.params.symbol ? `${f.params.symbol} ` : ''}position is ${fmt(f.params.valuePct)}% of equity (new limit ${f.params.limit}%)`;
          if (f.code === 'risk_to_stop') return f.params.noStop ? 'position has no protective stop' : `risk to stop $${fmt(f.params.risk)} = ${fmt(f.params.riskPct)}% of equity (new limit ${f.params.limit}%)`;
          if (f.code === 'open_positions') return `${f.params.open} open positions (new limit ${f.params.limit})`;
          if (f.code === 'stop_distance') return `stop is ${fmt(f.params.distPct)}% below the price (new maximum ${f.params.limit}%)`;
          if (f.code === 'daily_loss') return `day P&L ${fmt(f.params.dayPnlPct)}% is beyond the new ${f.params.limit}% daily loss limit`;
          if (f.code === 'drawdown') return `drawdown ${fmt(f.params.drawdownPct)}% is beyond the new ${f.params.limit}% limit`;
          return f.code;
        });
        this.activity.warn(`Exposure review after risk profile change: ${parts.join('; ')}. Nothing was sold automatically${review.reduceQty > 0 ? ` — selling ${review.reduceQty} sh would bring the position within the new limits` : ''}. New entries must satisfy the new limits; protective stops stay active.`, { source: 'risk engine' });
      } else if (this.portfolio.position(this.symbol)) {
        this.activity.info('RISK', 'Exposure review after risk profile change: the open position is within the new limits.', { source: 'risk engine' });
      }
    }
    if (this.orders.pendingFor(this.symbol).length) this.activity.info('RISK', 'Pending limit orders will be re-validated against the new limits before they can fill.', { source: 'risk engine' });
    if (this.aiState === 'RUNNING') this.scheduler.trigger({ type: 'RISK_CHANGE', key: `profile:${profile}`, detail: `risk profile ${profile}` });
    this.markDirty();
    return { profile, previous: prev, limits: Object.fromEntries(PROFILE_KEYS.map((k) => [k, L[k]])), review: this.riskReview };
  }

  /** User-confirmed partial sale (e.g. to comply with a stricter risk profile). */
  reducePosition(qtyIn) {
    if (!this.session) throw new Error('No session');
    const pos = this.portfolio.position(this.symbol);
    if (!pos) throw new Error('No open paper position');
    const qty = Number(qtyIn);
    if (!(qty > 0) || qty > pos.qty + 1e-9) throw new Error(`Quantity must be between 0 and ${pos.qty}`);
    const r = this.executeExit({ fraction: qty / pos.qty, kind: 'USER', reason: `User reduced the position by ${qty} sh (risk profile review)` });
    if (!r || !r.ok) throw new Error(r && r.reason ? r.reason : 'Reduce failed');
    this.riskReview = { at: this.now(), ...this.reviewRisk() };
    return r;
  }

  credentialsChanged(name) {
    if ((name === 'ALPACA_KEY_ID' || name === 'ALPACA_SECRET_KEY') && this.symbol && this.dataMode === 'LIVE') {
      this.loadMarket(this.symbol, 'LIVE').catch((e) => this.activity.error(e.message));
    }
    if (name === 'DEEPSEEK_API_KEY' || name === 'GEMINI_API_KEY') { this.aiError = null; this.book.aiManager.credentialsChanged(name); }
    this.markDirty();
  }

  // ------------------------------------------------------------------ analysis pipeline
  analysisGate(job) {
    const manual = job.reasons.some((r) => r.type === 'MANUAL');
    if (this.book.shuttingDown) return 'Server is shutting down';
    if (!this.session) return 'No active session';
    if (this.book.monitoringPaused && !manual) return 'Market monitoring is paused (system-wide)';
    if (this.planned() && !manual) return `${this.symbol} is managed by the portfolio plan`;
    if (this.monitoringPaused && !manual) return `Monitoring paused for ${this.symbol}`;
    if (!manual && this.book.aiBackoff && this.now() < this.book.aiBackoff.until) return `AI provider recovering from errors — next automatic attempt at ${etTimeStr(this.book.aiBackoff.until, false)} ET`;
    if (this.aiState !== 'RUNNING' && !manual) return `AI is ${this.aiState}`;
    if (!this.market || this.market.connection.state === 'UNAVAILABLE') return 'Market data unavailable';
    const si = this.sessionInfo();
    const ds = this.market.dataStatus(this.now(), si, this.statusOpts());
    const tradableSession = si.session === 'REGULAR' || (this.cfg().execution.extendedHours && (si.session === 'PRE' || si.session === 'POST'));
    if (!manual) {
      if (!tradableSession) return `Market ${si.marketStatus} — AI analysis deferred until the trading session (saves API budget)`;
      if (!ds.tradable) return `Waiting for reliable market data (${ds.label}: ${ds.codes.map((c) => REASON_TEXT[c] || c).join('; ') || ds.detail})`;
      if (this.market.halted && !this.portfolio.position(this.symbol)) return 'Market halted — analysis deferred';
      const blocks = this.risk.entryBlocks(this.now());
      if (blocks.length && !this.portfolio.position(this.symbol)) return `Entries blocked (${blocks[0]}) and no open position — analysis skipped`;
      const late = this.closingEntryBlock();
      if (late && !this.portfolio.position(this.symbol)) return `${late} and no open position — analysis skipped`;
    }
    return null;
  }

  async runAnalysis(job) {
    const gate = this.analysisGate(job);
    if (gate) {
      if (/^Waiting for reliable market data|^Market data unavailable/.test(gate)) this.awaitingData = true;
      if (gate !== this.lastSkipReason) this.activity.info('AI', `Analysis skipped: ${gate}`, { status: 'pending', source: 'scheduler' });
      this.lastSkipReason = gate;
      return { skipped: true, reason: gate };
    }
    this.lastSkipReason = null;
    const decider = this.decider();
    if (!decider) {
      this.aiError = { code: 'NO_KEY', message: 'No AI provider key configured (DeepSeek or Gemini)', at: this.now() };
      this.activity.error('AI ERROR: no AI provider key is configured — add a DeepSeek or Gemini key (Settings → Credentials)', { source: 'AI provider manager' });
      this.markDirty();
      return null;
    }
    const now = this.now();
    const triggers = job.reasons.map((r) => `${r.type}${r.detail ? `: ${r.detail}` : ''}`);
    const audit = { triggers, steps: [], startedAt: new Date(now).toISOString() };
    const step = (name, detail) => audit.steps.push({ at: new Date(this.now()).toISOString(), name, detail });
    this.activity.info('ANALYSIS', `Analysis started — trigger: ${triggers.join(' | ')}`, { source: 'scheduler' });

    // 1) Snapshot (deterministic indicators from real data)
    const atf = this.cfg().ai.analysisTimeframe;
    await this.ensureTf(atf);
    let built;
    try {
      built = this.buildSnapshotNow(triggers);
    } catch (e) {
      this.activity.error(`Snapshot build failed: ${e.message}`, { source: 'analysis engine' });
      return null;
    }
    const { snapshot, internals } = built;
    const v = snapshot.timeframes[atf];
    const iv = (k, d = 2) => (v.indicators[k] && v.indicators[k].available ? Number(v.indicators[k].value).toFixed(d) : 'n/a');
    this.activity.info('ANALYSIS', `Recalculated indicators on ${v.completedBars} completed ${atf} bars: RSI14 ${iv('rsi14', 1)} | MACD hist ${iv('macdHist', 3)} | ATR14 ${iv('atr14', 3)} | EMA9/21/50 ${iv('ema9')}/${iv('ema21')}/${iv('ema50')} | VWAP ${iv('vwap')} | RelVol ${iv('relVol')}`, { source: 'indicator engine' });
    const unavailable = Object.entries(v.indicators).filter(([, x]) => !x.available).map(([k]) => k);
    if (unavailable.length) this.activity.info('ANALYSIS', `Unavailable (insufficient data, not estimated): ${unavailable.join(', ')}`, { source: 'indicator engine' });
    for (const s of v.signals) this.activity.info('ANALYSIS', `Signal ${s.id.replace(/_/g, ' ')}: ${s.detail}`, { status: 'warn', source: 'pattern detector' });
    const price = snapshot.market.lastPrice;
    const atr = v.indicators.atr14 && v.indicators.atr14.value;
    if (v.structure.breakoutLevel && price && atr && v.structure.breakoutLevel.price - price < 0.5 * atr) this.activity.info('ANALYSIS', `Price ${price} approaching ${v.structure.breakoutLevel.basis} ${v.structure.breakoutLevel.price}`, { source: 'structure engine' });
    if (v.structure.breakdownLevel && price && atr && price - v.structure.breakdownLevel.price < 0.5 * atr) this.activity.info('ANALYSIS', `Price ${price} near ${v.structure.breakdownLevel.basis} ${v.structure.breakdownLevel.price}`, { source: 'structure engine' });
    this.lastAnalysis = { at: now, price, levels: internals[atf].levels, sr: internals[atf].sr, tf: atf, snapshotId: snapshot.id, trend: v.structure.trend };
    step('snapshot', { id: snapshot.id, bars: v.completedBars, signals: v.signals.map((s) => s.id) });
    try { this.store.insertSnapshot({ ...snapshot, sessionId: this.session.id, createdAt: now }); } catch (e) { this.activity.error(`Database error saving snapshot: ${e.message}`); }

    // 1b) AI cost control: when nothing material changed since the last analysis, reuse it (no request)
    const ac = this.aiCfg();
    const stateHash = materialStateHash(snapshot, atf, ac.priceStepAtr);
    const allNewsIds = snapshot.untrusted_external_content.news.map((n) => n.news_id);
    let aiCache = null;
    if (decider.costly) { try { aiCache = this.store.getAiCache(this.symbol, this.dataMode); } catch { aiCache = null; } }
    const forced = job.reasons.some((r) => FORCE_TRIGGERS.has(r.type));
    if (decider.costly && !forced && aiCache && aiCache.stateHash === stateHash && aiCache.nextReviewAt && now < aiCache.nextReviewAt) {
      try { this.store.insertAvoided({ ts: now, day: etDateStr(now), symbol: this.symbol, reason: 'cache' }); } catch { /* ignore */ }
      this.activity.info('AI', `AI request avoided for ${this.symbol}: market state unchanged since the analysis at ${etTimeStr(aiCache.updatedAt)} ET — reusing it until the next review at ${etTimeStr(aiCache.nextReviewAt, false)} ET`, { source: 'AI cost control' });
      return { skipped: true, reason: 'cached' };
    }
    // news already interpreted is not sent again (only a count); new items are sent in full
    if (decider.costly && aiCache && aiCache.processedNews && aiCache.processedNews.length) {
      const seen = new Set(aiCache.processedNews);
      const all = snapshot.untrusted_external_content.news;
      snapshot.untrusted_external_content.news = all.filter((n) => !seen.has(n.news_id));
      snapshot.untrusted_external_content.alreadyAnalysedNews = { count: all.length - snapshot.untrusted_external_content.news.length, note: 'Items interpreted in previous analyses are omitted; see previousAnalysis.' };
    }

    const newsN = snapshot.untrusted_external_content.news.length;
    const official = snapshot.untrusted_external_content.news.filter((n) => n.officialConfirmed).length;
    this.activity.info('NEWS', `Checking latest company news: ${newsN} relevant item(s) available (${official} officially confirmed)`, { source: 'news collector' });
    step('news', { items: newsN, official });

    // 2) Optional DeepSeek web research (server-side tools), rate-limited
    if (decider.costly) await this.maybeWebResearch(decider, snapshot, step);

    // 3) Budget / rate gate
    const messages = decider.promptFor ? decider.promptFor(snapshot) : null;
    const promptChars = messages ? messages.reduce((s, m) => s + m.content.length, 0) : 0;
    let plan = null;
    if (decider.costly && decider.managed) {
      plan = this.book.aiManager.plan({ promptChars, maxOutputTokens: this.aiCfg().maxOutputTokens, symbol: this.symbol, triggers: job.reasons.map((r) => r.type), ms: this.now() });
      for (const n of plan.notes) this.activity.info('AI', n, { status: 'warn', source: 'AI provider manager' });
      if (plan.blocked) {
        this.activity.warn(`AI request not sent — ${plan.blocked}`, { source: 'AI provider manager' });
        step('budget_block', plan.blocked);
        return null;
      }
      step('ai_plan', { mode: plan.mode, providers: plan.order, dual: plan.dual });
      for (let i = 0; i < (plan.dual ? 2 : 1); i++) this.usage.noteRequestStart(this.now(), this.symbol);
    } else if (decider.costly) {
      const block = this.usage.check({ model: this.aiCfg().model, promptChars, maxOutputTokens: this.aiCfg().maxOutputTokens, ms: this.now(), symbol: this.symbol });
      if (block) {
        this.activity.warn(`AI request not sent — ${block}`, { source: 'budget control' });
        step('budget_block', block);
        return null;
      }
      this.usage.noteRequestStart(this.now(), this.symbol);
    }
    const pname = (id) => `${AI_PROVIDERS[id].name} ${this.book.aiManager.providerModel(id)}`;
    const target = plan ? (plan.dual ? `${pname('deepseek')} + ${pname('gemini')} (dual analysis)` : pname(plan.order[0])) : decider.label;

    // 4) AI request
    const decisionId = newId('dec');
    this.activity.info('AI', `Sending market snapshot ${snapshot.id} to ${target} (~${Math.round(promptChars / 3)} input tokens est., reasoning ${this.aiCfg().reasoningEffort})`, { status: 'pending', source: target });
    step('ai_request', { model: target, promptChars });
    this.aiProgress = { decisionId, phase: 'waiting', startedAt: this.now(), reasoningChars: 0, contentChars: 0 };
    this.markDirty();
    let resp;
    let thinkingLogged = false;
    try {
      resp = await decider.decide(snapshot, {
        messages, plan, hasPosition: !!this.portfolio.position(this.symbol), language: (this.cfg().ui && this.cfg().ui.language) || 'ar',
        validate: (content) => validateProposal(content, { snapshotId: snapshot.id, symbol: this.symbol, price, hasPosition: !!this.portfolio.position(this.symbol) }),
        onFallback: ({ from, to, error }) => this.activity.warn(`${AI_PROVIDERS[from].name} failed (${(error && error.code) || 'error'}: ${error && error.message}) — falling back to ${AI_PROVIDERS[to].name}`, { source: 'AI provider manager' }),
        onProgress: (p) => {
          this.aiProgress = { ...this.aiProgress, ...p };
          this.emit('aiProgress', this.aiProgress);
          if (p.phase === 'thinking' && !thinkingLogged) { thinkingLogged = true; this.activity.info('AI', 'Model is reasoning (internal reasoning is not displayed or stored)…', { status: 'pending', source: decider.label }); }
          if (p.phase === 'tool') this.activity.info('AI', `DeepSeek server tool: ${p.tool}`, { source: decider.label });
        },
      });
    } catch (e) {
      this.aiProgress = null;
      if (e.attempts && e.attempts.length) {
        for (const a of e.attempts) this.usage.record({ provider: a.provider, model: a.model, purpose: 'decision', ok: a.ok, usage: a.usage, latencyMs: a.latencyMs, error: a.error, ms: this.now() });
      } else if (decider.costly) {
        this.usage.record({ model: this.aiCfg().model, purpose: 'decision', ok: false, usage: null, latencyMs: this.now() - now, error: e.message, ms: this.now() });
      }
      this.aiError = { code: e.code || 'ERROR', message: e.message, at: this.now(), retryable: !!e.retryable };
      this.activity.error(`AI request failed (${e.code || 'error'}): ${e.message}`, { source: target });
      // automatic recovery: exponential backoff for scheduled analyses (manual requests still allowed)
      const fails = ((this.book.aiBackoff && this.book.aiBackoff.fails) || 0) + 1;
      this.book.aiBackoff = { fails, until: this.now() + Math.min(30 * 60000, 60000 * 2 ** (fails - 1)) };
      // pause only when NO provider can be used any more (the other provider is still tried while it works)
      const stillUsable = decider.managed ? !this.book.aiManager.plan({ promptChars, symbol: this.symbol, ms: this.now() }).blocked : false;
      if (!stillUsable && (e.allFatal || e.code === 'INSUFFICIENT_BALANCE' || e.code === 'INVALID_KEY')) {
        this.activity.error('AI ERROR — no AI provider is usable (key, balance or quota problem). Autonomous analysis paused; market monitoring and protective orders remain active.', { source: target });
        this.emitEvent('AI_PAUSED_ERROR', { code: e.code, message: e.message }, 'high');
        this.setAiState('PAUSED');
        this.scheduler.stop();
        for (const a of this.book.agents.values()) if (a !== this) a.scheduler.stop();
      }
      this.insertDecision({ id: decisionId, snapshot, status: 'AI_ERROR', proposal: null, audit: { ...audit, error: e.message, attempts: e.attempts || null }, model: target });
      this.markDirty();
      return null;
    }
    this.aiProgress = null;
    this.aiError = null;
    let usageRow = null;
    if (decider.costly && resp.attempts) {
      const rows = resp.attempts.map((a) => ({ a, row: this.usage.record({ provider: a.provider, model: a.model, purpose: 'decision', ok: a.ok, usage: a.usage, latencyMs: a.latencyMs, error: a.error, ms: this.now() }) }));
      for (const { a, row } of rows) {
        if (!a.ok || !a.usage) continue;
        this.activity.ok('AI', `${AI_PROVIDERS[a.provider].name} response received in ${(a.latencyMs / 1000).toFixed(1)}s — ${a.usage.promptTokens} in (${a.usage.cacheHit} cached) / ${a.usage.completionTokens} out tokens (${a.usage.reasoningTokens} reasoning), est. $${row.costUsd.toFixed(5)}`, { source: a.model });
      }
      const okRows = rows.filter((x) => x.a.ok).map((x) => x.row);
      usageRow = okRows.length === 1 ? okRows[0] : { providers: okRows.map((r) => r.provider), costUsd: okRows.reduce((t, r) => t + (r.costUsd || 0), 0), promptTokens: okRows.reduce((t, r) => t + (r.promptTokens || 0), 0), completionTokens: okRows.reduce((t, r) => t + (r.completionTokens || 0), 0) };
      if (resp.fallbackFrom) this.activity.warn(`Analysis answered by ${AI_PROVIDERS[resp.provider].name} (fallback from ${AI_PROVIDERS[resp.fallbackFrom].name})`, { source: 'AI provider manager' });
    } else if (decider.costly) {
      usageRow = this.usage.record({ model: resp.model || this.cfg().ai.model, purpose: 'decision', ok: true, usage: resp.usage, latencyMs: resp.latencyMs, ms: this.now() });
      this.activity.ok('AI', `AI response received in ${(resp.latencyMs / 1000).toFixed(1)}s — ${resp.usage.promptTokens} in (${resp.usage.cacheHit} cached) / ${resp.usage.completionTokens} out tokens (${resp.usage.reasoningTokens} reasoning), est. $${usageRow.costUsd.toFixed(5)}`, { source: resp.model });
    } else {
      this.activity.ok('AI', `${decider.label} evaluated the snapshot`, { source: decider.label });
    }
    step('ai_response', { latencyMs: resp.latencyMs, finishReason: resp.finishReason, usage: resp.usage });

    // 5) Strict validation
    const pos = this.portfolio.position(this.symbol);
    const val = validateProposal(resp.content, { snapshotId: snapshot.id, symbol: this.symbol, price, hasPosition: !!pos });
    if (!val.ok) {
      const lengthHint = resp.finishReason === 'length' ? ' (response hit max_tokens — raise "Max output tokens" or lower reasoning effort)' : '';
      this.activity.error(`AI response validation failed${lengthHint}: ${val.errors.join('; ')}`, { source: 'proposal validator', details: { preview: String(resp.content || '').slice(0, 300) } });
      this.insertDecision({ id: decisionId, snapshot, status: 'INVALID', proposal: val.proposal || null, audit: { ...audit, validationErrors: val.errors, warnings: val.warnings }, model: resp.model, provider: resp.provider || null, usage: usageRow, latencyMs: resp.latencyMs });
      return null;
    }
    for (const w of val.warnings) this.activity.info('AI', `Validator note: ${w}`, { status: 'warn', source: 'proposal validator' });
    const providerLabel = resp.provider === 'dual' ? 'DeepSeek + Gemini' : resp.provider && AI_PROVIDERS[resp.provider] ? AI_PROVIDERS[resp.provider].name : null;
    const p = { ...val.proposal, id: decisionId, createdAt: now, snapshotPrice: snapshot.market.quote ? (snapshot.market.quote.bid + snapshot.market.quote.ask) / 2 : price, decider: providerLabel ? `${providerLabel} ${resp.model}` : decider.label };
    p.aiProvider = resp.provider || decider.kind; p.aiModel = resp.model || null; p.aiMode = plan ? plan.mode : null;
    if (resp.fallbackFrom) p.fallbackFrom = resp.fallbackFrom;
    if (resp.dual) {
      p.dual = resp.dual;
      if (resp.dual.policy) this.activity.info('AI', `Dual analysis: DeepSeek ${resp.dual.providers.deepseek.action} (${resp.dual.providers.deepseek.confidence}%) vs Gemini ${resp.dual.providers.gemini.action} (${resp.dual.providers.gemini.confidence}%) — ${resp.dual.policy === 'DISAGREE_WAIT' ? 'disagreement: no trade, waiting for more evidence' : 'agreement'}; combined uncertainty ${resp.dual.combinedUncertainty}`, { status: resp.dual.policy === 'DISAGREE_WAIT' ? 'warn' : 'ok', source: 'AI provider manager' });
      else if (resp.dual.note) this.activity.warn(resp.dual.note, { source: 'AI provider manager' });
    }
    p.riskProfile = this.cfg().risk.profile || 'CUSTOM';
    p.indicators = this.indicatorSummaryFrom(v);
    // Chart annotations for this assessment: AI levels cross-checked against app-computed levels.
    const previous = this.lastDecision && this.lastDecision.proposal ? this.lastDecision : null;
    try {
      p.chart = buildChartAnalysis({ proposal: p, decisionId, at: now, tf: atf, snapshot, internals: internals[atf], previous });
      if (p.chart.unverifiedLevels) this.activity.info('ANALYSIS', `${p.chart.unverifiedLevels} AI price level(s) did not match any level computed by the application — shown on the chart as unverified`, { status: 'warn', source: 'chart analysis' });
      else if (p.chart.levels.length) this.activity.info('ANALYSIS', `Chart updated: ${p.chart.levels.length} AI level(s) verified against application-computed levels`, { source: 'chart analysis' });
      if (p.chart.change && p.chart.change.changed) {
        this.activity.info('AI', `Decision changed from ${p.chart.change.from.replace(/_/g, ' ')} to ${p.action.replace(/_/g, ' ')}${p.chart.change.reason ? ` — ${p.chart.change.reason}` : ' (no reason given by the model)'}`, { status: 'warn', source: p.decider });
        this.emitEvent('DECISION_CHANGED', { decisionId, from: p.chart.change.from, to: p.action, reason: p.chart.change.reason, confidence: p.confidence }, 'normal');
      }
    } catch (e) {
      this.activity.warn(`Chart analysis could not be built: ${e.message}`, { source: 'chart analysis' });
    }
    step('validated', { action: p.action, warnings: val.warnings });
    this.news.setSentiments(p.newsAssessment);

    const cat = p.action === 'BUY' || p.isLimitEntry ? 'BUY_PROPOSAL' : EXIT_ACTIONS.includes(p.action) ? 'SELL_PROPOSAL' : 'AI';
    const lvl = p.action === 'BUY' || p.isLimitEntry ? ` entry ~${fmt(p.entryPrice, 4)}, stop ${fmt(p.stopLoss, 4)}, target ${fmt(p.takeProfit, 4)}` : '';
    this.activity.info(cat, `AI proposes ${p.action.replace(/_/g, ' ')}${lvl} — ${p.strategy.replace(/_/g, ' ')}, bias ${p.directionalBias}, confidence ${p.confidence}%`, { source: p.decider });
    if (p.rationale) this.activity.info(cat, `Reason: ${p.rationale}`, { source: p.decider });
    const decision = this.insertDecision({ id: decisionId, snapshot, status: 'PROPOSED', proposal: p, audit, model: resp.model, provider: resp.provider || decider.kind, usage: usageRow, latencyMs: resp.latencyMs });
    this.lastDecision = decision;
    this.emit('decision', decision);
    if (p.action === 'BUY' || p.isLimitEntry || EXIT_ACTIONS.includes(p.action)) this.emitEvent('PROPOSAL', { decisionId, action: p.action, entry: p.entryPrice, stop: p.stopLoss, target: p.takeProfit, confidence: p.confidence, rationale: p.rationale }, 'low');
    // remember this analysis: reused while the market state stays the same (see AI cost control)
    if (decider.costly) {
      try {
        const prev = this.store.getAiCache(this.symbol, this.dataMode);
        const seen = new Set([...((prev && prev.processedNews) || []), ...allNewsIds]);
        this.store.setAiCache({ symbol: this.symbol, dataMode: this.dataMode, updatedAt: now, decisionId, stateHash, snapshotId: snapshot.id, nextReviewAt: now + ac.reviewIntervalMin * 60000, processedNews: [...seen].slice(-300), data: { action: p.action, bias: p.directionalBias, trend: p.trend, keyLevels: p.keyLevels, invalidation: p.invalidation, bullCase: p.bullCase, bearCase: p.bearCase, plan: p.chart && p.chart.plan } });
      } catch (e) { this.activity.error(`Database error saving AI cache: ${e.message}`); }
    }
    this.book.aiBackoff = null;

    // 6) Route to risk/execution
    this.handleProposal(p, decision);
    this.markDirty();
    return decision;
  }

  buildSnapshotNow(triggers = []) {
    const now = this.now();
    const atf = this.cfg().ai.analysisTimeframe;
    const val = this.valuation();
    const pos = this.portfolio.position(this.symbol);
    const prot = this.orders.getProtection(this.symbol);
    const si = this.sessionInfo();
    const mkt = this.market.toJSON(now, si, this.statusOpts());
    const firstReg = this.candles.firstRegularMinute();
    const exec = this.cfg().execution;
    const fills = (() => { try { return this.store.listFills(this.session.id).slice(-10); } catch { return []; } })();
    const decs = (() => { try { return this.store.listDecisions(this.session.id, 5); } catch { return []; } })();
    const prev = this.lastDecision && this.lastDecision.proposal ? this.lastDecision : null;
    const pp = prev && prev.proposal;
    const previousAnalysis = pp ? {
      time: new Date(prev.ts).toISOString(), minutesAgo: Math.round((now - prev.ts) / 60000), action: pp.action, directionalBias: pp.directionalBias, trend: pp.trend,
      confidence: pp.confidence, strategy: pp.strategy, entry: pp.entryPrice, stopLoss: pp.stopLoss, takeProfit: pp.takeProfit, watchLevel: pp.watchLevel,
      keyLevels: pp.keyLevels, rationale: (pp.rationale || '').slice(0, 300), invalidation: (pp.invalidation || '').slice(0, 200), outcome: prev.status,
      riskRejection: prev.risk && prev.risk.checks ? prev.risk.checks.filter((c) => !c.pass).map((c) => c.name).slice(0, 4) : [],
      note: 'Your previous assessment. Re-evaluate it against the current data; do not anchor on it.',
    } : null;
    let capitalAtRisk = null;
    if (pos && prot) {
      const mark = this.market.mark() || pos.avgPrice;
      const stop = this.orders.effectiveStop(this.symbol);
      const amt = pos.qty * Math.max(0, mark - stop);
      capitalAtRisk = { toStopUsd: Math.round(amt * 100) / 100, pctOfEquity: val.equity > 0 ? Math.round((amt / val.equity) * 10000) / 100 : null, stop };
    }
    const ipo = {
      ...this.ipo,
      minutesSinceFirstRegularTrade: firstReg ? Math.round((now - firstReg * 1000) / 60000) : null,
      note: this.ipo.isNewlyListed ? 'Newly listed: limited history; long-term indicators unavailable; expect wide spreads, halts and high volatility.' : undefined,
      reference: this.ipo.reference ? { ...this.ipo.reference, note: 'Configuration reference only — NOT the market price.' } : null,
    };
    return buildSnapshot({
      id: newId('snap'), symbol: this.symbol, nowMs: now, candles: this.candles, market: { ...mkt, lastTrade: this.market.lastTrade, quote: this.market.quote(), freshness: mkt.freshness },
      sessionInfo: si, analysisTf: atf, portfolio: val, position: pos, protection: prot ? { stopLoss: prot.stopLoss, effectiveStop: this.orders.effectiveStop(this.symbol), takeProfit: prot.takeProfit, trailingStopPct: prot.trailingStopPct } : null,
      pendingOrders: this.orders.pendingFor(this.symbol).map((o) => ({ side: o.side, qty: o.qty, limitPrice: o.limitPrice, expiresAt: new Date(o.expiresAt).toISOString() })),
      risk: this.risk.status(val.equity, now), news: this.news.list(15, now),
      recentFills: fills.map((f) => ({ time: new Date(f.ts).toISOString(), side: f.side, qty: f.qty, price: f.price, realizedPnl: f.realizedPnl, reason: f.reason })),
      recentDecisions: decs.map((d) => ({ time: new Date(d.ts).toISOString(), action: d.action, status: d.status, confidence: d.confidence, rationale: d.proposal && d.proposal.rationale ? d.proposal.rationale.slice(0, 200) : '' })),
      triggers, ipo, broadMarket: this.broadMarket || this.book.broadMarket, webResearch: this.webResearch ? { at: this.webResearch.at, text: this.webResearch.text.slice(0, 2500), citations: this.webResearch.citations.slice(0, 10), note: 'AI web research via DeepSeek server-side tools; unverified by the application.' } : null,
      feed: this.market.feed, target: this.session.targetCapital, adjustment: this.cfg().market.adjustment,
      executionCosts: { buyAt: 'ask', sellAt: 'bid', slippageBps: exec.slippageBps, commissionPerShare: exec.commissionPerShare, secFeeRate: exec.secFeeRate, finraTafPerShare: exec.finraTafPerShare, fractionalShares: exec.fractionalShares },
      previousAnalysis, capitalAtRisk,
      symbolsMonitored: this.book.agents.size || 1,
      otherPositions: Object.keys(this.portfolio.positions).filter((x) => x !== this.symbol && this.portfolio.position(x)).map((x) => ({ symbol: x, ...this.portfolio.position(x) })),
    });
  }

  /** Compact indicator values (from a snapshot timeframe view) kept with proposals and fills. */
  indicatorSummaryFrom(v) {
    if (!v || !v.indicators) return null;
    const out = { timeframe: v.timeframe };
    for (const k of ['rsi14', 'macdHist', 'atr14', 'ema9', 'ema21', 'ema50', 'sma50', 'vwap', 'relVol', 'bbUpper', 'bbLower']) {
      const x = v.indicators[k];
      out[k] = x && x.available ? x.value : null;
    }
    out.trend = v.structure ? v.structure.trend : null;
    out.marketStructure = v.technicals && v.technicals.available !== false ? v.technicals.marketStructure : null;
    return out;
  }

  /** Indicators on the analysis timeframe right now (completed bars only) — for fills without a proposal. */
  currentIndicatorSummary() {
    try {
      const atf = this.cfg().ai.analysisTimeframe;
      const bars = this.candles.completedBars(atf, this.now());
      const lv = Ind.latestValues(bars, sessionOfFactory(atf));
      const out = { timeframe: atf };
      for (const k of ['rsi14', 'macdHist', 'atr14', 'ema9', 'ema21', 'ema50', 'sma50', 'vwap', 'relVol']) out[k] = lv[k] && lv[k].available ? Math.round(lv[k].value * 1e4) / 1e4 : null;
      return out;
    } catch { return null; }
  }

  async maybeWebResearch(decider, snapshot, step) {
    const wr = this.aiCfg().webResearch;
    if (!wr.enabled || !decider.research) return;
    const due = this.now() - this.lastResearchAt >= wr.intervalMin * 60000;
    const newsTrig = snapshot.triggers.some((t) => t.startsWith('NEWS'));
    if (!due && !newsTrig) return;
    const block = this.usage.check({ model: wr.model, promptChars: 2000, maxOutputTokens: wr.maxOutputTokens, ms: this.now() });
    if (block) { this.activity.info('AI', `Web research skipped — ${block}`, { status: 'warn', source: 'budget control' }); return; }
    this.lastResearchAt = this.now();
    this.usage.noteRequestStart(this.now());
    this.activity.info('AI', `Running DeepSeek web research (deepseek_web_search / deepseek_read_url) for ${this.symbol}…`, { status: 'pending', source: wr.model });
    try {
      const since = new Date(this.now() - 3 * 86400e3).toISOString().slice(0, 10);
      const r = await decider.research({ symbol: this.symbol, companyName: this.asset && this.asset.name, since, onProgress: (p) => { if (p.phase === 'tool') this.activity.info('AI', `Web tool: ${p.tool}`, { source: 'DeepSeek web tools' }); } });
      const u = this.usage.record({ model: r.model || wr.model, purpose: 'web_research', ok: true, usage: r.usage, latencyMs: r.latencyMs, ms: this.now() });
      this.webResearch = { at: new Date(this.now()).toISOString(), text: String(r.text || '').slice(0, 4000), citations: r.citations, toolCalls: r.toolCalls };
      this.activity.ok('AI', `Web research complete in ${(r.latencyMs / 1000).toFixed(1)}s: ${r.citations.length} cited source(s), est. $${u.costUsd.toFixed(5)}`, { source: 'DeepSeek web tools', details: { citations: r.citations.slice(0, 8) } });
      step('web_research', { citations: r.citations.length, toolCalls: r.toolCalls });
    } catch (e) {
      this.usage.record({ model: wr.model, purpose: 'web_research', ok: false, usage: null, latencyMs: 0, error: e.message, ms: this.now() });
      this.activity.warn(`DeepSeek web research unavailable: ${e.message} (continuing with independently collected news)`, { source: 'DeepSeek web tools' });
      step('web_research_failed', e.message);
    }
  }

  insertDecision({ id, snapshot, status, proposal, audit, model, usage, latencyMs, provider = null }) {
    const d = {
      id, sessionId: this.session.id, snapshotId: snapshot.id, ts: this.now(), symbol: this.symbol, action: proposal ? proposal.action : null,
      confidence: proposal ? proposal.confidence : null, strategy: proposal ? proposal.strategy : null, status, model, provider, latencyMs: latencyMs || null,
      proposal, risk: null, execution: null, audit, usage,
    };
    try { this.store.insertDecision(d); } catch (e) { this.activity.error(`Database error saving decision: ${e.message}`); }
    return d;
  }

  finishDecision(decision, status, { risk, execution, note } = {}) {
    decision.status = status;
    if (risk) decision.risk = risk;
    if (execution) decision.execution = execution;
    if (note) decision.audit = { ...(decision.audit || {}), note };
    decision.audit = { ...(decision.audit || {}), steps: [...((decision.audit && decision.audit.steps) || []), { at: new Date(this.now()).toISOString(), name: 'final', detail: status }] };
    try { this.store.updateDecision(decision.id, { status, risk: decision.risk, execution: decision.execution, audit: decision.audit }); } catch (e) { this.activity.error(`Database error updating decision: ${e.message}`); }
    if (this.lastDecision && this.lastDecision.id === decision.id) this.lastDecision = decision;
    this.emit('decision', decision);
    this.markDirty();
  }

  handleProposal(p, decision) {
    if (this.book.shuttingDown) { this.activity.warn('Proposal not executed: the server is shutting down', { source: 'risk engine' }); return this.finishDecision(decision, 'SHUTDOWN'); }
    const pos = this.portfolio.position(this.symbol);
    const autonomy = this.cfg().ai.autonomy;
    const isEntry = p.action === 'BUY' || p.isLimitEntry;
    const isExit = EXIT_ACTIONS.includes(p.action);
    if (this.planned()) return this.finishDecision(decision, 'NO_ACTION', { note: 'the plan manages this symbol' });
    if (!isEntry && !isExit) {
      if (p.action === 'HOLD' && pos && (p.stopLoss != null || p.takeProfit != null || p.trailingStopPct != null)) return this.applyAdjust(p, decision);
      this.activity.info('AI', `No trade: ${p.action.replace(/_/g, ' ')}${p.nextAction ? ` — next: ${p.nextAction}` : ''}`, { source: p.decider });
      return this.finishDecision(decision, 'NO_ACTION');
    }
    if (isExit && !pos) { this.activity.info('RISK', `${p.action} ignored: no open position`, { source: 'risk engine' }); return this.finishDecision(decision, 'NO_POSITION'); }
    // duplicate proposal protection
    const key = proposalKey(p);
    const qtyNow = pos ? pos.qty : 0;
    if (this.lastExecuted && this.lastExecuted.key === key && this.now() - this.lastExecuted.at < 10 * 60000 && this.lastExecuted.qtyAfter === qtyNow) {
      this.activity.warn(`Duplicate proposal rejected (identical ${p.action} already executed ${Math.round((this.now() - this.lastExecuted.at) / 1000)}s ago)`, { source: 'risk engine' });
      return this.finishDecision(decision, 'DUPLICATE', { note: 'identical proposal already executed' });
    }
    if (autonomy === 'ADVISORY') {
      this.activity.info('AI', 'Advisory mode: proposal recorded, not executed', { source: 'autonomy' });
      return this.finishDecision(decision, 'ADVISORY_ONLY');
    }
    if (autonomy === 'SEMI') {
      this.approvals.set(decision.id, { decision, proposal: p, expiresAt: this.now() + 90000 });
      this.activity.info(isEntry ? 'BUY_PROPOSAL' : 'SELL_PROPOSAL', `Awaiting your approval (semi-autonomous mode, 90s): ${p.action}`, { status: 'pending', source: 'autonomy' });
      return this.finishDecision(decision, 'AWAITING_APPROVAL');
    }
    return isEntry ? this.executeEntry(p, decision) : this.executeExitFromProposal(p, decision);
  }

  approve(decisionId, approve = true) {
    const a = this.approvals.get(decisionId);
    if (!a) throw new Error('No pending approval with that id (it may have expired)');
    this.approvals.delete(decisionId);
    if (!approve) { this.activity.info('AI', `User rejected proposal ${a.proposal.action}`, { source: 'user' }); return this.finishDecision(a.decision, 'USER_REJECTED'); }
    this.activity.info('AI', `User approved proposal ${a.proposal.action}`, { source: 'user' });
    const isEntry = a.proposal.action === 'BUY' || a.proposal.isLimitEntry;
    return isEntry ? this.executeEntry(a.proposal, a.decision) : this.executeExitFromProposal(a.proposal, a.decision);
  }

  riskAccount() {
    const val = this.valuation();
    const pos = this.portfolio.position(this.symbol);
    return { equity: val.equity, cash: this.portfolio.cash, positionQty: pos ? pos.qty : 0, positionMark: this.market.mark() || (pos && pos.avgPrice) || 0, openPositions: this.portfolio.openPositionCount() };
  }

  ipoContext() {
    const firstReg = this.candles.firstRegularMinute();
    const atf = this.cfg().ai.analysisTimeframe;
    const bars = this.candles.completedBars(atf, this.now());
    const a = Ind.atr(bars, 14);
    const atr = a[a.length - 1];
    const px = this.market.mark();
    return { active: this.ipo.active, minutesSinceFirstTrade: firstReg ? (this.now() - firstReg * 1000) / 60000 : null, atrPct: atr && px ? (atr / px) * 100 : null };
  }

  // ------------------------------------------------------------------ portfolio plan
  planned() { return !!((this.book.plan && this.book.plan.manages(this.symbol)) || (this.book.invest && this.book.invest.manages(this.symbol)) || (this.book.commands && this.book.commands.manages(this.symbol))); }

  /** The checks before a plan purchase. The plan's own percentages replace the per-position size and stop rules. */
  planCheck({ own = false } = {}) {
    if (this.book.shuttingDown || !this.session || !this.market || !this.storageReady()) return { ok: false, code: 'MARKET' };
    if (this.dataMode === 'LIVE') {
      const lab = this.book.lab && this.book.lab.gate(this.symbol);
      if (lab && !lab.pass && !own) return { ok: false, code: 'ANALYSIS' };
    }
    if (this.risk.entryBlocks(this.now()).length) return { ok: false, code: 'LIMITS' };
    if (!own && (this.monitoringPaused || this.book.monitoringPaused)) return { ok: false, code: 'PAUSED' };
    const q = this.market.quote();
    const m = this.marketForRisk();
    const bad = this.risk.constructor.marketChecks(m, q, false).filter((c) => !c.pass);
    if (bad.length) return { ok: false, code: bad.some((c) => c.name === 'session_open') ? 'CLOSED' : 'PRICE' };
    if (!own && this.closingEntryBlock()) return { ok: false, code: 'CLOSED' };
    if (((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100 > this.cfg().risk.maxSpreadPct || q.askSize === 0) return { ok: false, code: 'SPREAD' };
    return { ok: true };
  }

  /** The person's own order: an exact quantity, at market or not above `limit`. The person decided, so only loss limits and price quality apply. */
  ownBuy(qty, limit, ref) {
    const c = this.planCheck({ own: true });
    if (!c.ok) return c;
    const exec = this.cfg().execution;
    const fill = simulateOrder({ side: 'BUY', qty, type: limit ? 'LIMIT' : 'MARKET', limitPrice: limit || null, quote: this.market.quote(), cfg: exec, maxSlippagePct: 1, sizeUnit: this.cfg().market.quoteSizeUnit });
    if (fill.status !== 'FILLED' && fill.status !== 'PARTIAL') return { ok: false, code: 'PRICE' };
    if (fill.filledQty * fill.avgPrice + fill.fees.total > this.portfolio.cash) return { ok: false, code: 'CASH' };
    const id = newId('ord');
    try {
      this.commitTrade(() => {
        this.portfolio.applyFill({ symbol: this.symbol, side: 'BUY', qty: fill.filledQty, price: fill.avgPrice, fees: fill.fees.total, ts: this.now() });
        this.recordOrder({ id, side: 'BUY', type: limit ? 'LIMIT' : 'MARKET', qty, limitPrice: limit || null, status: fill.status === 'PARTIAL' ? 'PARTIALLY_FILLED' : 'FILLED', filledQty: fill.filledQty, avgFillPrice: fill.avgPrice, source: 'COMMAND', reason: `Your order ${ref}` });
        this.ensureBenchmark();
        this.recordFill({ side: 'BUY', fill, decision: null, proposal: null, reason: `Your order ${ref}`, realized: 0, kind: 'COMMAND', orderId: id });
      });
    } catch (e) { this.activity.error(`Order not recorded: ${e.message}`, { source: 'portfolio' }); return { ok: false, code: 'MARKET' }; }
    this.activity.ok('EXECUTION', `PAPER BUY executed (your order): ${fill.filledQty} ${this.symbol} @ ${fmt(fill.avgPrice, 4)}`, { source: 'paper engine' });
    this.afterFill();
    return { ok: true, qty: fill.filledQty, price: fill.avgPrice };
  }

  ownSell(qty, limit, ref) {
    const pos = this.portfolio && this.portfolio.position(this.symbol);
    if (!pos || !this.market || this.book.shuttingDown) return { ok: false, code: 'SMALL' };
    const bad = this.risk.constructor.marketChecks(this.marketForRisk(), this.market.quote(), false).filter((c) => !c.pass);
    if (bad.length) return { ok: false, code: bad.some((c) => c.name === 'session_open') ? 'CLOSED' : 'PRICE' };
    const r = this.executeExit({ fraction: qty >= pos.qty - 1e-9 ? 1 : qty / pos.qty + 1e-12, kind: 'COMMAND', reason: `Your order ${ref}`, limitPrice: limit || null });
    return r && r.ok ? { ok: true, qty: r.fill.filledQty, price: r.fill.avgPrice, realized: r.realized } : { ok: false, code: 'PRICE' };
  }

  /** Buy about `value` dollars; one whole share is allowed up to `most` when shares cannot be split. */
  planBuy(value, why, most = value, { kind = 'PLAN', protect = null } = {}) {
    const c = this.planCheck();
    if (!c.ok) return c;
    const exec = this.cfg().execution;
    const q = this.market.quote();
    const price = q.ask * (1 + (exec.slippageBps || 0) / 1e4) * (1 + (exec.commissionPct || 0) / 100);
    const whole = !exec.fractionalShares;
    let qty = whole ? Math.floor(value / price) : Math.floor((value / price) * 10000) / 10000;
    if (whole && qty < 1 && price <= most) qty = 1;
    if (!(qty > 0)) return { ok: false, code: 'SMALL' };
    const fill = simulateOrder({ side: 'BUY', qty, type: 'MARKET', quote: q, cfg: exec, maxSlippagePct: this.cfg().risk.maxSlippagePct, sizeUnit: this.cfg().market.quoteSizeUnit });
    if (fill.status !== 'FILLED' && fill.status !== 'PARTIAL') return { ok: false, code: 'PRICE' };
    if (fill.filledQty * fill.avgPrice + fill.fees.total > this.portfolio.cash) return { ok: false, code: 'CASH' };
    const id = newId('ord');
    try {
      this.commitTrade(() => {
        this.portfolio.applyFill({ symbol: this.symbol, side: 'BUY', qty: fill.filledQty, price: fill.avgPrice, fees: fill.fees.total, ts: this.now() });
        this.recordOrder({ id, side: 'BUY', type: 'MARKET', qty, limitPrice: null, status: fill.status === 'PARTIAL' ? 'PARTIALLY_FILLED' : 'FILLED', filledQty: fill.filledQty, avgFillPrice: fill.avgPrice, source: kind, reason: `Portfolio plan: ${why}`, extra: protect ? { stopLoss: protect.stopLoss, takeProfit: protect.takeProfit } : undefined });
        if (protect) { const p = this.orders.setProtection(this.symbol, { ...protect, highWater: fill.avgPrice, entryPrice: fill.avgPrice }); p.nearPct = protect.nearPct; }
        this.ensureBenchmark();
        this.recordFill({ side: 'BUY', fill, decision: null, proposal: null, reason: `Portfolio plan: ${why}`, realized: 0, kind, orderId: id });
      });
    } catch (e) { this.activity.error(`Plan purchase not recorded: ${e.message}`, { source: 'portfolio' }); return { ok: false, code: 'MARKET' }; }
    this.activity.ok('EXECUTION', `PAPER BUY executed (plan): ${fill.filledQty} ${this.symbol} @ ${fmt(fill.avgPrice, 4)}`, { source: 'paper engine' });
    this.afterFill();
    return { ok: true, value: fill.filledQty * fill.avgPrice };
  }

  /** Sell about `value` dollars, or everything when value is null. */
  planSell(value, why, kind = 'PLAN') {
    const pos = this.portfolio && this.portfolio.position(this.symbol);
    if (!pos || !this.market || this.book.shuttingDown) return { ok: false, code: 'SMALL' };
    const q = this.market.quote();
    const bad = this.risk.constructor.marketChecks(this.marketForRisk(), q, false).filter((c) => !c.pass);
    if (bad.length) return { ok: false, code: bad.some((c) => c.name === 'session_open') ? 'CLOSED' : 'PRICE' };
    let fraction = 1;
    if (value != null) {
      const n = value / q.bid;
      const qty = Math.min(pos.qty, this.cfg().execution.fractionalShares ? Math.floor(n * 10000) / 10000 : Math.floor(n));
      if (!(qty > 0)) return { ok: false, code: 'SMALL' };
      fraction = Math.min(1, qty / pos.qty + 1e-9);
    }
    const r = this.executeExit({ fraction, kind, reason: `Portfolio plan: ${why}` });
    return r && r.ok ? { ok: true, value: r.fill.filledQty * r.fill.avgPrice } : { ok: false, code: 'PRICE' };
  }

  executeEntry(p, decision, { skipFreshness = false, pendingOrder = null } = {}) {
    if (this.planned()) { // one decision-maker per symbol
      if (pendingOrder) { this.orders.cancelPending(pendingOrder.id, 'the plan manages this symbol'); this.updateOrderStatus(pendingOrder.id, { status: 'CANCELLED', rejectReason: 'the plan manages this symbol' }); this.persist(); return null; }
      return this.finishDecision(decision, 'NO_ACTION', { note: 'the plan manages this symbol' });
    }
    if (this.book.shuttingDown) return this.finishDecision(decision, 'SHUTDOWN');
    if (!this.storageReady()) {
      if (pendingOrder) return null; // stays resting; retried when storage works again
      return this.finishDecision(decision, 'EXECUTION_FAILED', { execution: { error: this.book.storageFault.message } });
    }
    // idempotency: one decision can create at most one live entry order
    if (!pendingOrder && decision && decision.id) {
      let dup = true; // a failed check is never read as "no duplicate"
      try { dup = this.store.hasLiveOrderForDecision(decision.id); } catch { dup = true; }
      if (dup) { this.activity.warn(`Duplicate entry blocked: decision ${decision.id} already has an order`, { source: 'risk engine' }); return this.finishDecision(decision, 'DUPLICATE', { note: 'decision already has an order' }); }
    }
    const late = this.closingEntryBlock();
    if (late && !pendingOrder) {
      this.activity.warn(`Trade REJECTED: ${late}`, { source: 'adaptive monitoring' });
      this.recordOrder({ side: 'BUY', type: p.orderType, qty: null, limitPrice: p.orderType === 'LIMIT' ? p.limitPrice : null, status: 'REJECTED', source: 'AI', reason: p.rationale || 'AI entry', rejectReason: late, decisionId: decision.id });
      return this.finishDecision(decision, 'REJECTED_BY_RISK', { risk: { approved: false, qty: 0, checks: [{ name: 'closing_window', pass: false, detail: late }] } });
    }
    const exec = this.cfg().execution;
    const L = this.cfg().risk;
    this.activity.info('RISK', 'Validating proposal against risk limits…', { status: 'pending', source: 'risk engine' });
    const res = this.risk.evaluateEntry({
      proposal: p, quote: this.market.quote(), market: this.marketForRisk(), account: this.riskAccount(), ipo: this.ipoContext(), exec, ai: this.cfg().ai, nowMs: this.now(), skipFreshness,
      // real securities only: DEMO prices are synthetic
      lab: this.book.lab && this.dataMode === 'LIVE' ? this.book.lab.gate(this.symbol) : null,
      riskFactor: this.book.riskFactor && this.dataMode === 'LIVE' ? this.book.riskFactor(this.symbol) : 1,
      crowd: this.book.crowd && this.dataMode === 'LIVE' ? this.book.crowd(this.symbol) : null,
    });
    const riskRecord = { approved: res.approved, qty: res.qty, checks: res.checks, sizing: res.sizing, rr: res.rr, fillEstimate: res.fillEstimate };
    if (!res.approved) {
      this.activity.warn(`Trade REJECTED by risk engine: ${res.failed.join(' | ')}`, { source: 'risk engine', details: { checks: res.checks } });
      if (pendingOrder) this.updateOrderStatus(pendingOrder.id, { status: 'CANCELLED', rejectReason: `risk re-check failed: ${res.failed[0]}` });
      else this.recordOrder({ side: 'BUY', type: p.orderType, qty: null, limitPrice: p.orderType === 'LIMIT' ? p.limitPrice : null, status: 'REJECTED', source: 'AI', reason: p.rationale || 'AI entry', rejectReason: `Risk engine: ${res.failed.join(' | ')}`, decisionId: decision.id });
      const drift = res.checks.find((c) => (c.name === 'price_drift' || c.name === 'proposal_fresh') && !c.pass);
      if (drift && !pendingOrder) {
        this.activity.info('AI', 'Market changed since the snapshot — stale proposal invalidated, re-assessing', { source: 'scheduler' });
        this.scheduler.trigger({ type: 'STALE_PROPOSAL', detail: drift.detail });
      }
      if (pendingOrder) { this.orders.cancelPending(pendingOrder.id, `risk re-check failed: ${res.failed[0]}`); this.persist(); }
      return this.finishDecision(decision, 'REJECTED_BY_RISK', { risk: riskRecord });
    }
    this.activity.ok('RISK', `Trade accepted by risk engine: ${res.qty} sh (limited by ${res.sizing.limitingFactor.replace('by', '').toLowerCase()}; risk at stop $${fmt(res.sizing.riskAtStop)} = ${fmt(res.sizing.riskPctOfEquity)}% of equity; R:R ${fmt(res.rr)})${res.resized ? ' — resized from AI request' : ''}`, { source: 'risk engine' });
    const q = this.market.quote();
    // Resting limit order (waiting for a better entry)
    if (p.orderType === 'LIMIT' && !pendingOrder && q.ask > p.limitPrice) {
      const o = this.orders.addPending({
        symbol: this.symbol, side: 'BUY', qty: res.qty, limitPrice: p.limitPrice, stopLoss: p.stopLoss, takeProfit: p.takeProfit, trailingStopPct: p.trailingStopPct,
        decisionId: decision.id, proposal: p, createdAt: this.now(), expiresAt: this.now() + exec.pendingLimitExpiryMin * 60000,
      });
      this.recordOrder({ id: o.id, side: 'BUY', type: 'LIMIT', qty: res.qty, limitPrice: p.limitPrice, status: 'PENDING', source: 'AI', reason: p.rationale || 'AI limit entry', decisionId: decision.id, extra: { stopLoss: p.stopLoss, takeProfit: p.takeProfit, expiresAt: o.expiresAt } });
      this.activity.ok('EXECUTION', `PAPER LIMIT BUY placed: ${res.qty} ${this.symbol} @ ${fmt(p.limitPrice, 4)} (ask ${fmt(q.ask, 4)}; expires ${etTimeStr(o.expiresAt, false)} ET)`, { source: 'paper engine' });
      this.persist();
      return this.finishDecision(decision, 'ORDER_PENDING', { risk: riskRecord, execution: { status: 'PENDING', orderId: o.id } });
    }
    const fill = simulateOrder({ side: 'BUY', qty: res.qty, type: p.orderType, limitPrice: p.orderType === 'LIMIT' ? p.limitPrice : null, quote: q, cfg: exec, maxSlippagePct: L.maxSlippagePct, sizeUnit: this.cfg().market.quoteSizeUnit });
    const entryOrderId = pendingOrder ? pendingOrder.id : newId('ord');
    if (fill.status === 'REJECTED' || fill.status === 'UNFILLED') {
      this.activity.warn(`PAPER BUY not filled: ${fill.reason}`, { source: 'execution simulator' });
      if (!pendingOrder) this.recordOrder({ id: entryOrderId, side: 'BUY', type: p.orderType, qty: res.qty, limitPrice: p.orderType === 'LIMIT' ? p.limitPrice : null, status: 'REJECTED', source: 'AI', reason: p.rationale || 'AI entry', rejectReason: `Simulator: ${fill.reason}`, decisionId: decision.id });
      return this.finishDecision(decision, 'EXECUTION_FAILED', { risk: riskRecord, execution: fill });
    }
    let applied;
    let f;
    try {
      this.commitTrade(() => {
        applied = this.portfolio.applyFill({ symbol: this.symbol, side: 'BUY', qty: fill.filledQty, price: fill.avgPrice, fees: fill.fees.total, ts: this.now() });
        const existing = this.orders.getProtection(this.symbol);
        if (existing) this.orders.adjustProtection(this.symbol, { stopLoss: Math.max(existing.stopLoss, p.stopLoss), takeProfit: p.takeProfit, trailingStopPct: p.trailingStopPct });
        else this.orders.setProtection(this.symbol, { stopLoss: p.stopLoss, takeProfit: p.takeProfit, trailingStopPct: p.trailingStopPct, highWater: fill.avgPrice, proposalId: decision.id, entryPrice: fill.avgPrice });
        this.risk.onEntryFill();
        const ordStatus = fill.status === 'PARTIAL' ? 'PARTIALLY_FILLED' : 'FILLED';
        if (pendingOrder) this.updateOrderStatus(entryOrderId, { status: ordStatus, filledQty: fill.filledQty, avgFillPrice: fill.avgPrice });
        else this.recordOrder({ id: entryOrderId, side: 'BUY', type: p.orderType, qty: res.qty, limitPrice: p.orderType === 'LIMIT' ? p.limitPrice : null, status: ordStatus, filledQty: fill.filledQty, avgFillPrice: fill.avgPrice, source: 'AI', reason: p.rationale || 'AI entry', decisionId: decision.id });
        if (pendingOrder) this.orders.cancelPending(pendingOrder.id, 'filled');
        this.ensureBenchmark();
        f = this.recordFill({ side: 'BUY', fill, decision, proposal: p, reason: p.rationale || 'AI entry', realized: 0, kind: 'AI', orderId: entryOrderId });
      });
    } catch (e) {
      this.activity.error(`Execution rejected by ${e.storage ? 'storage' : 'accounting'}: ${e.message}`, { source: 'portfolio' });
      return this.finishDecision(decision, 'EXECUTION_FAILED', { risk: riskRecord, execution: { ...fill, error: e.message } });
    }
    this.lastExecuted = { key: proposalKey(p), at: this.now(), qtyAfter: applied.position ? applied.position.qty : 0 };
    this.activity.ok('EXECUTION', `PAPER BUY executed: ${fill.filledQty} ${this.symbol} @ ${fmt(fill.avgPrice, 4)} (ask ${fmt(fill.touchPrice, 4)}, spread ${fmt(fill.spread, 4)}, slippage $${fmt(fill.slippageVsTouch, 4)}, fees $${fmt(fill.fees.total)})${fill.status === 'PARTIAL' ? ` — PARTIAL: ${fill.reason}` : ''}`, { source: 'execution simulator', details: { fillId: f.id } });
    this.activity.info('EXECUTION', `Protective orders set: stop ${fmt(this.orders.effectiveStop(this.symbol), 4)}, take-profit ${fmt(p.takeProfit, 4)}${p.trailingStopPct ? `, trailing ${p.trailingStopPct}%` : ''}`, { source: 'paper engine' });
    this.afterFill();
    this.finishDecision(decision, fill.status === 'PARTIAL' ? 'PARTIALLY_EXECUTED' : 'EXECUTED', { risk: riskRecord, execution: { ...fill, fillId: f.id } });
    this.scheduler.trigger({ type: 'POSITION_CHANGE', detail: 'entry filled', priority: 0, cooldownMs: 120000 });
    return f;
  }

  fillPendingLimit(order) {
    const decision = { id: order.decisionId, audit: { steps: [] }, action: 'BUY' };
    const p = { ...order.proposal, orderType: 'LIMIT', limitPrice: order.limitPrice };
    this.activity.info('EXECUTION', `Pending LIMIT BUY @ ${fmt(order.limitPrice, 4)} is marketable (ask ${fmt(this.market.quote().ask, 4)}) — re-validating risk`, { source: 'paper engine' });
    this.executeEntry(p, decision, { skipFreshness: true, pendingOrder: order });
  }

  executeExitFromProposal(p, decision) {
    if (this.planned()) return this.finishDecision(decision, 'NO_ACTION', { note: 'the plan manages this symbol' });
    const fraction = p.action === 'REDUCE_POSITION' ? p.reduceFraction : (p.action === 'SELL' && p.reduceFraction ? p.reduceFraction : 1);
    const r = this.executeExit({ fraction, kind: 'AI', reason: p.rationale || `AI ${p.action}`, decision, proposal: p });
    if (!r || !r.ok) return this.finishDecision(decision, r && r.deferred ? 'EXIT_BLOCKED' : 'EXECUTION_FAILED', { execution: r });
    this.lastExecuted = { key: proposalKey(p), at: this.now(), qtyAfter: (this.portfolio.position(this.symbol) || { qty: 0 }).qty };
    return this.finishDecision(decision, r.partial ? 'PARTIALLY_EXECUTED' : 'EXECUTED', { risk: r.risk, execution: r.fill });
  }

  /** Exit (AI, stop, target, trailing, user). Never blocked by loss limits; only by unreliable data / halts / session. */
  executeExit({ fraction = 1, kind, reason, trigger = null, decision = null, proposal = null, limitPrice = null }) {
    const pos = this.portfolio.position(this.symbol);
    if (!pos) return { ok: false, reason: 'No position' };
    const exec = this.cfg().execution;
    const q = this.market.quote();
    const chk = this.risk.evaluateExit({ quote: q, market: this.marketForRisk(), positionQty: pos.qty, fraction, exec });
    if (!chk.approved) {
      const msg = `${kind} exit cannot execute now: ${chk.failed.join(' | ')}${kind === 'STOP' || kind === 'TRAILING_STOP' || kind === 'TAKE_PROFIT' ? ' — order stays armed until data is reliable' : ''}`;
      const failedNames = chk.checks.filter((c) => !c.pass).map((c) => c.name).join(',');
      if (kind === 'USER' || kind === 'AI' || this.cond.shouldLog(`exit-blocked:${kind}`, failedNames, this.now())) this.activity.warn(msg, { source: 'risk engine' });
      if (kind === 'USER' || kind === 'AI') this.recordOrder({ side: 'SELL', type: 'MARKET', qty: chk.qty || null, status: 'REJECTED', source: kind, reason, rejectReason: `Exit not possible now: ${chk.failed.join(' | ')}`, decisionId: decision ? decision.id : null });
      return { ok: false, deferred: true, reason: msg, risk: chk };
    }
    let fill;
    if (kind === 'TAKE_PROFIT') {
      const tp = trigger.level;
      if (q.bid >= tp) fill = simulateOrder({ side: 'SELL', qty: chk.qty, type: 'LIMIT', limitPrice: tp, quote: q, cfg: exec, sizeUnit: this.cfg().market.quoteSizeUnit });
      else {
        // resting limit at target filled by a buyer trading through it (trade print >= target)
        const fees = computeFees('SELL', chk.qty, tp, exec);
        fill = { status: 'FILLED', side: 'SELL', type: 'LIMIT', limitPrice: tp, filledQty: chk.qty, avgPrice: tp, fees, fills: [{ qty: chk.qty, price: tp }], touchPrice: q.bid, spread: q.ask - q.bid, slippageVsTouch: 0, reason: `resting limit filled at target (trade printed ${trigger.triggerPrice})` };
      }
    } else if (limitPrice) {
      fill = simulateOrder({ side: 'SELL', qty: chk.qty, type: 'LIMIT', limitPrice, quote: q, cfg: exec, sizeUnit: this.cfg().market.quoteSizeUnit });
    } else {
      fill = simulateOrder({ side: 'SELL', qty: chk.qty, type: 'MARKET', quote: q, cfg: exec, maxSlippagePct: kind === 'STOP' || kind === 'TRAILING_STOP' || kind === 'USER' || kind === 'COMMAND' ? 5 : this.cfg().risk.maxSlippagePct, sizeUnit: this.cfg().market.quoteSizeUnit });
    }
    const exitOrderId = newId('ord');
    const exitType = fill.type || (kind === 'TAKE_PROFIT' ? 'LIMIT' : 'MARKET');
    if (fill.status === 'REJECTED' || fill.status === 'UNFILLED') {
      this.activity.warn(`PAPER SELL not filled (${kind}): ${fill.reason}`, { source: 'execution simulator' });
      this.recordOrder({ id: exitOrderId, side: 'SELL', type: exitType, qty: chk.qty, status: 'REJECTED', source: kind, reason, rejectReason: `Simulator: ${fill.reason}`, decisionId: decision ? decision.id : null });
      return { ok: false, reason: fill.reason, fill, risk: chk };
    }
    const costBasisPrice = pos.avgPrice;
    let applied;
    let f;
    let riskEvents = [];
    try {
      this.commitTrade(() => {
        applied = this.portfolio.applyFill({ symbol: this.symbol, side: 'SELL', qty: fill.filledQty, price: fill.avgPrice, fees: fill.fees.total, ts: this.now() });
        this.recordOrder({ id: exitOrderId, side: 'SELL', type: exitType, qty: chk.qty, limitPrice: exitType === 'LIMIT' ? fill.limitPrice || null : null, status: fill.status === 'PARTIAL' ? 'PARTIALLY_FILLED' : 'FILLED', filledQty: fill.filledQty, avgFillPrice: fill.avgPrice, source: kind, reason, decisionId: decision ? decision.id : null });
        if (applied.closedRoundTrip) {
          this.orders.clearProtection(this.symbol);
          this.cancelPendingOrders('position closed');
          riskEvents = this.risk.onRoundTripClosed(applied.closedRoundTrip.pnl, this.now());
        }
        f = this.recordFill({ side: 'SELL', fill, decision, proposal, reason, realized: applied.realized, kind, orderId: exitOrderId, costBasisPrice });
      });
    } catch (e) {
      if (!e.storage || this.cond.shouldLog('exit-storage', kind, this.now())) this.activity.error(`Execution rejected by ${e.storage ? 'storage' : 'accounting'}: ${e.message}`, { source: 'portfolio' });
      return { ok: false, reason: e.message };
    }
    const label = { STOP: 'STOP-LOSS', TRAILING_STOP: 'TRAILING STOP', TAKE_PROFIT: 'TAKE-PROFIT', USER: 'MANUAL CLOSE', AI: 'AI' }[kind] || kind;
    this.activity.ok('EXECUTION', `PAPER SELL executed (${label}): ${fill.filledQty} ${this.symbol} @ ${fmt(fill.avgPrice, 4)} (bid ${fmt(fill.touchPrice, 4)}, fees $${fmt(fill.fees.total)}) — realized P&L $${fmt(applied.realized)}${fill.status === 'PARTIAL' ? ` — PARTIAL: ${fill.reason}` : ''}`, { status: applied.realized >= 0 ? 'ok' : 'warn', source: 'execution simulator', details: { fillId: f.id, reason } });
    if (applied.closedRoundTrip) {
      const evs = riskEvents;
      this.activity.info('PORTFOLIO', `Round trip closed: P&L $${fmt(applied.closedRoundTrip.pnl)} (${fmt(applied.closedRoundTrip.returnPct)}%)`, { status: applied.closedRoundTrip.pnl >= 0 ? 'ok' : 'warn', source: 'portfolio' });
      for (const ev of evs) { this.activity.warn(`RISK LIMIT: ${ev.message}`, { source: 'risk engine' }); this.emitEvent('RISK_LIMIT', { kind: ev.type, message: ev.message }, 'high'); this.scheduler.trigger({ type: 'RISK_CHANGE', key: ev.type, detail: ev.type }); }
    }
    this.afterFill();
    if (kind !== 'AI') this.scheduler.trigger({ type: 'POSITION_CHANGE', detail: `${label} exit`, priority: 0 });
    return { ok: true, fill: { ...fill, fillId: f.id }, partial: fill.status === 'PARTIAL', realized: applied.realized, risk: chk };
  }

  applyAdjust(p, decision) {
    const prot = this.orders.getProtection(this.symbol);
    if (!prot) return this.finishDecision(decision, 'NO_ACTION', { note: 'no protective orders to adjust' });
    const res = this.risk.evaluateAdjust({ current: { stopLoss: this.orders.effectiveStop(this.symbol), takeProfit: prot.takeProfit }, proposed: { stopLoss: p.stopLoss, takeProfit: p.takeProfit, trailingStopPct: p.trailingStopPct }, quote: this.market.quote() });
    for (const c of res.checks) if (!c.pass) this.activity.warn(`Adjustment rejected: ${c.detail}`, { source: 'risk engine' });
    if (!res.approved) return this.finishDecision(decision, 'NO_ACTION', { risk: res });
    this.orders.adjustProtection(this.symbol, res.changes);
    this.activity.ok('EXECUTION', `Protective orders updated: ${Object.entries(res.changes).map(([k, v]) => `${k} ${v}`).join(', ')}`, { source: 'paper engine' });
    this.persist();
    return this.finishDecision(decision, 'ORDERS_ADJUSTED', { risk: res });
  }

  /** Structured application event (consumed by notifications / Telegram). */
  emitEvent(type, data = {}, priority = 'normal', id = null) {
    // market alerts are part of monitoring: none while monitoring is paused (trades, risk and errors always are)
    if (this.book.monitoringPaused && (type === 'BREAKOUT' || type === 'NEWS_MATERIAL' || type === 'MARKET_SESSION')) return null;
    // a stable id lets notification channels drop repeats of the same real-world event
    const evt = { id: id || newId('evt'), type, ts: this.now(), symbol: this.symbol, priority, data };
    this.emitAfterCommit('appEvent', evt);
    return evt;
  }

  /**
   * One trade = one transaction: order, fill, portfolio, pending orders, protection and risk state. fn may only use
   * the recording methods below. If anything fails, memory goes back to what it was, no event leaves the engine
   * and new entries stop until storage works again.
   */
  commitTrade(fn) {
    const b = this.book;
    const before = JSON.stringify({ portfolio: this.portfolio.toJSON(), orders: this.orders.toJSON(), risk: this.risk.state, benchmark: this.benchmark });
    b.trade = { events: [] };
    let accounting = null;
    try {
      this.store.transaction(() => { try { fn(); } catch (e) { if (e instanceof PortfolioError) accounting = e; throw e; } });
    } catch (e) {
      b.trade = null;
      const s = JSON.parse(before);
      Object.assign(this.portfolio, new Portfolio(s.portfolio));
      Object.assign(this.orders, s.orders);
      this.risk.state = s.risk;
      this.benchmark = s.benchmark;
      if (accounting) throw accounting;
      this.storageFailed(e);
      throw Object.assign(new Error(`trade not recorded, so it was cancelled: ${e.message}`), { storage: true });
    }
    const { events } = b.trade;
    b.trade = null;
    if (b.storageFault) this.storageRecovered();
    for (const [name, payload] of events) this.emit(name, payload);
  }

  /** Events raised inside a trade are delivered only after it has been committed. */
  emitAfterCommit(name, payload) { if (this.book.trade) this.book.trade.events.push([name, payload]); else this.emit(name, payload); }

  storageFailed(e) {
    if (this.book.storageFault) return;
    this.book.storageFault = { at: this.now(), message: `Storage failure: ${e.message}` };
    this.emitEvent('RISK_LIMIT', { kind: 'STORAGE', message: `A trade could not be saved and was cancelled. New entries are stopped until storage works again. ${e.message}` }, 'high');
  }

  storageRecovered() {
    this.book.storageFault = null;
    this.activity.ok('RISK', 'Storage works again: new entries are allowed', { source: 'database' });
  }

  /** After a storage failure every new entry first proves that the account state can be written. */
  storageReady() {
    if (!this.book.storageFault) return true;
    try { this.store.transaction(() => this.store.saveSessionState(this.session.id, this.sessionState())); } catch { return false; }
    this.storageRecovered();
    return true;
  }

  sessionState() {
    return { aiState: this.aiState, portfolio: this.portfolio.toJSON(), orders: this.orders.toJSON(), risk: this.risk.toJSON(), benchmark: this.benchmark, symbol: this.primary ? this.symbol : null };
  }

  /** Persist an order (an order is not an execution: it may be pending, rejected, cancelled, or filled by one or more fills). */
  recordOrder(o) {
    const now = this.now();
    const ord = { id: o.id || newId('ord'), sessionId: this.session ? this.session.id : null, symbol: this.symbol, createdAt: now, updatedAt: now, filledQty: 0, ...o };
    try { this.store.insertOrder(ord); } catch (e) { if (this.book.trade) throw e; this.activity.error(`Database error saving order: ${e.message}`); }
    const ev = { PENDING: 'ORDER_PENDING', REJECTED: 'ORDER_REJECTED', CANCELLED: 'ORDER_CANCELLED', EXPIRED: 'ORDER_EXPIRED' }[ord.status];
    if (ev) this.emitEvent(ev, { order: ord }, 'normal');
    return ord;
  }

  updateOrderStatus(id, changes) {
    try { this.store.updateOrder(id, { ...changes, updatedAt: this.now() }); } catch (e) { if (this.book.trade) throw e; this.activity.error(`Database error updating order: ${e.message}`); }
    const ev = { REJECTED: 'ORDER_REJECTED', CANCELLED: 'ORDER_CANCELLED', EXPIRED: 'ORDER_EXPIRED' }[changes.status];
    if (ev) { let o = null; try { o = this.store.getOrder(id); } catch { /* ignore */ } this.emitEvent(ev, { order: o || { id, symbol: this.symbol, ...changes } }, 'normal'); }
  }

  cancelPendingOrders(reason) {
    const out = this.orders.cancelAll(this.symbol, reason);
    for (const o of out) this.updateOrderStatus(o.id, { status: 'CANCELLED', rejectReason: reason });
    return out;
  }

  recordFill({ side, fill, decision, proposal, reason, realized, kind, orderId = null, costBasisPrice = null }) {
    const f = {
      id: newId('fill'), sessionId: this.session.id, symbol: this.symbol, side, qty: fill.filledQty, price: fill.avgPrice, fees: fill.fees.total, feeBreakdown: fill.fees,
      ts: this.now(), orderType: fill.type, status: fill.status, requestedQty: fill.requestedQty, reason: String(reason || '').slice(0, 500), kind,
      strategy: proposal ? proposal.strategy : null, confidence: proposal ? proposal.confidence : null, decisionId: decision ? decision.id : null,
      realizedPnl: realized, quoteAtFill: { bid: this.market.quote() && this.market.quote().bid, ask: this.market.quote() && this.market.quote().ask },
      slippage: fill.slippageVsTouch, liquidityAssumed: !!fill.liquidityAssumed, stopLoss: proposal ? proposal.stopLoss : null, takeProfit: proposal ? proposal.takeProfit : null,
      newsIds: proposal ? (proposal.newsAssessment || []).map((n) => n.newsId) : [], dataSource: this.market.feed.label,
      orderId, costBasisPrice: side === 'SELL' ? costBasisPrice : null,
      returnPct: side === 'SELL' && costBasisPrice > 0 && fill.filledQty > 0 ? (realized / (fill.filledQty * costBasisPrice)) * 100 : null,
      riskProfile: (proposal && proposal.riskProfile) || this.cfg().risk.profile || 'CUSTOM',
      indicatorsAtDecision: proposal && proposal.indicators ? proposal.indicators : null,
      indicatorsAtFill: this.currentIndicatorSummary(),
      protectiveStop: side === 'BUY' ? this.orders.effectiveStop(this.symbol) : null,
      aiProvider: proposal ? proposal.aiProvider || null : null, aiModel: proposal ? proposal.aiModel || null : null,
    };
    // always inside commitTrade(): an error here cancels the whole trade
    this.store.insertFill(f);
    this.store.saveSessionState(this.session.id, this.sessionState());
    this.emitAfterCommit('fill', f);
    return f;
  }

  afterFill() {
    const val = this.valuation();
    const pos = this.portfolio.position(this.symbol);
    this.activity.info('PORTFOLIO', `Portfolio updated: equity $${fmt(val.equity)}, cash $${fmt(val.cash)}, ${pos ? `${pos.qty} sh @ avg ${fmt(pos.avgPrice, 4)}` : 'flat'}, realized $${fmt(val.realizedPnl)}, return ${fmt(val.totalReturnPct)}%`, { source: 'portfolio' });
    for (const ev of this.risk.onEquity(val.equity, this.now())) { this.activity.warn(`RISK LIMIT: ${ev.message}`, { source: 'risk engine' }); this.emitEvent('RISK_LIMIT', { kind: ev.type, message: ev.message }, 'high'); }
    this.sampleEquity(true);
    this.persist();
    this.markDirty();
  }

  ensureBenchmark() {
    if (this.benchmark || !this.portfolio) return;
    const q = this.market.quote();
    if (!q) return;
    const exec = this.cfg().execution;
    const cap = this.portfolio.initialCapital;
    const fee = (exec.commissionPerOrder || 0);
    let shares = (cap - fee) / q.ask;
    shares = exec.fractionalShares ? Math.floor(shares * 10000) / 10000 : Math.floor(shares);
    const fees = computeFees('BUY', shares, q.ask, exec).total;
    this.benchmark = { refTs: this.now(), refPrice: q.ask, shares, cashLeft: cap - shares * q.ask - fees, note: `Buy & hold ${shares} sh at the ask when the session first traded` };
  }

  valuation() {
    if (!this.portfolio) return null;
    return this.portfolio.valuation(this.allMarks());
  }

  /** Latest marks of every symbol in the book (shared portfolio valuation). */
  allMarks() {
    const marks = {};
    for (const a of this.book.agents.size ? this.book.agents.values() : [this]) {
      const m = a.market ? a.market.mark() : null;
      if (m) marks[a.symbol] = m;
    }
    if (this.market && this.market.mark()) marks[this.symbol] = this.market.mark();
    return marks;
  }

  sampleEquity(force = false) {
    if (!this.primary || !this.session || !this.portfolio || !this.market) return;
    const now = this.now();
    if (this.aiState === 'RUNNING' && !this.benchmark && this.market.quote() && !this.market.freshness(now).stale) this.ensureBenchmark();
    const val = this.valuation();
    const evs = this.risk.onEquity(val.equity, now);
    for (const ev of evs) {
      this.activity.warn(`RISK LIMIT: ${ev.message}`, { source: 'risk engine' });
      this.emitEvent('RISK_LIMIT', { kind: ev.type, message: ev.message }, 'high');
      this.scheduler.trigger({ type: 'RISK_CHANGE', key: ev.type, detail: ev.type });
      this.markDirty();
    }
    const mark = this.market.mark();
    const bench = benchmarkEquity(this.benchmark, mark);
    if (!force && this.market.freshness(now).stale && !this.portfolio.position(this.symbol)) return;
    try { this.store.insertEquity(this.session.id, { ts: now, equity: val.equity, cash: val.cash, positionValue: val.positionValue, benchmark: bench }); } catch (e) { this.activity.error(`Database error: ${e.message}`); }
    this.emit('equity', { ts: now, equity: val.equity, benchmark: bench });
    if (!force) this.persist();
  }

  // ------------------------------------------------------------------ UI state
  displayStatus() {
    if (!this.session) return { code: 'IDLE', label: 'AI IDLE', detail: 'Configure a symbol and capital, then START AI TRADING' };
    const now = this.now();
    const val = this.valuation();
    const rs = this.risk.status(val.equity, now);
    if (rs.disabled) return { code: 'TRADING_DISABLED', label: 'TRADING DISABLED', detail: rs.disabled.reason };
    if (this.aiError && (this.aiState === 'RUNNING' || this.aiError.code === 'INSUFFICIENT_BALANCE' || this.aiError.code === 'INVALID_KEY')) return { code: 'AI_ERROR', label: 'AI ERROR', detail: this.aiError.message };
    if (this.aiState === 'PAUSED') return { code: 'PAUSED', label: 'AI PAUSED', detail: 'No new AI entries; protective orders active' };
    if (this.aiState === 'STOPPED' || this.aiState === 'IDLE') return { code: 'STOPPED', label: 'AI STOPPED', detail: this.portfolio.position(this.symbol) ? 'Open position still protected' : '' };
    if (!this.market || this.market.connection.state === 'UNAVAILABLE') return { code: 'NO_DATA', label: 'WAITING FOR MARKET DATA', detail: this.market && this.market.unavailableReason };
    if (this.market.halted) return { code: 'HALTED', label: 'MARKET HALTED', detail: this.market.haltInfo && (this.market.haltInfo.reason || this.market.haltInfo.code) };
    const si = this.sessionInfo();
    const tradable = si.session === 'REGULAR' || (this.cfg().execution.extendedHours && si.session !== 'CLOSED');
    if (!tradable) return { code: 'MARKET_CLOSED', label: 'AI WAITING — MARKET CLOSED', detail: si.nextOpenMs ? `Next regular open ${etDateStr(si.nextOpenMs)} ${etTimeStr(si.nextOpenMs, false)} ET` : '' };
    const ds = this.market.dataStatus(now, si, this.statusOpts());
    if (!ds.tradable) return { code: 'NO_DATA', label: 'AI WAITING — DATA NOT RELIABLE', detail: `${ds.label}: ${this.statusDetail(ds)}` };
    if (rs.blocks.length) return { code: 'RISK_PAUSE', label: 'ENTRIES PAUSED (RISK)', detail: rs.blocks.join('; ') };
    if (this.aiProgress) return { code: 'ANALYZING', label: 'AI ANALYZING', detail: this.aiProgress.phase };
    return { code: 'RUNNING', label: 'AI RUNNING', detail: '' };
  }

  publicState() {
    const now = this.now();
    const si = this.market ? this.sessionInfo() : null;
    const val = this.valuation();
    const pos = this.portfolio && this.portfolio.position(this.symbol);
    const prot = this.orders.getProtection(this.symbol);
    let metrics = null;
    let equityCurve = [];
    if (this.session && this.portfolio) {
      try { equityCurve = this.store.listEquity(this.session.id); } catch { equityCurve = []; }
      metrics = computeMetrics({ valuation: val, roundTrips: this.portfolio.roundTrips, fillCount: this.portfolio.fillCount, equityCurve });
    }
    const mark = this.market && this.market.mark();
    const md = this.market ? this.market.toJSON(now, si, this.statusOpts()) : null;
    if (md) {
      md.diagnosis = this.diag;
      md.msgRate = this.msgRate;
      md.outage = this.outage ? { since: this.outage.since, attempts: this.outage.attempts } : null;
      md.verifyPending = this.verifyPending;
      md.statusDetail = this.statusDetail(md.dataStatus);
      md.ages = this.market.ages(now);
    }
    const d1 = this.candles ? this.candles.getBars('1d') : [];
    const prevClose = (() => {
      if (!d1.length) return null;
      const today = bucketStart('1d', Math.floor(now / 1000));
      const prev = d1.filter((b) => b.time < today);
      return prev.length ? prev[prev.length - 1].close : null;
    })();
    return {
      serverTime: now, symbol: this.symbol, dataMode: this.dataMode, chartVersion: this.chartVersion, asset: this.asset ? { name: this.asset.name, exchange: this.asset.exchange, status: this.asset.status, fractionable: this.asset.fractionable } : null,
      market: md, session: si, prevClose, changePct: prevClose && mark ? ((mark - prevClose) / prevClose) * 100 : null,
      ipo: this.ipo, broadMarket: this.broadMarket,
      ai: {
        state: this.aiState, display: this.displayStatus(), error: this.aiError, progress: this.aiProgress, decider: this.decider() ? this.decider().label : null,
        scheduler: this.scheduler.status(), usage: this.usage.summary(now), lastDecision: this.lastDecision, analysisTimeframe: this.cfg().ai.analysisTimeframe,
        lastAnalysis: this.lastAnalysis ? { at: this.lastAnalysis.at, trend: this.lastAnalysis.trend, levels: this.lastAnalysis.levels, tf: this.lastAnalysis.tf } : null,
        chartAnalysis: this.lastDecision && this.lastDecision.proposal && this.lastDecision.proposal.chart
          ? { ...this.lastDecision.proposal.chart, status: this.lastDecision.status, decidedAt: this.lastDecision.ts } : null,
        approvals: [...this.approvals.values()].map((a) => ({ id: a.decision.id, action: a.proposal.action, expiresAt: a.expiresAt })),
        webResearch: this.webResearch, autonomy: this.cfg().ai.autonomy, model: this.cfg().ai.model,
      },
      tradingSession: this.session ? { id: this.session.id, startedAt: this.session.startedAt, initialCapital: this.session.initialCapital, targetCapital: this.session.targetCapital, dataMode: this.session.dataMode } : null,
      portfolio: val, metrics,
      position: pos ? { ...pos, mark, stop: this.orders.effectiveStop(this.symbol), takeProfit: prot && prot.takeProfit, trailingStopPct: prot && prot.trailingStopPct, initialStop: prot && prot.initialStop } : null,
      pendingOrders: this.orders.pendingFor(this.symbol),
      risk: this.risk && val ? { ...this.risk.status(val.equity, now), profile: this.cfg().risk.profile || 'CUSTOM', symbolsTradedAtOnce: Math.max(SYMBOLS_TRADED_AT_ONCE, this.book.agents.size) } : null,
      riskProfile: { profile: this.cfg().risk.profile || 'CUSTOM', limits: Object.fromEntries(PROFILE_KEYS.map((k) => [k, this.cfg().risk[k]])), presets: PROFILES, symbolsTradedAtOnce: Math.max(SYMBOLS_TRADED_AT_ONCE, this.book.agents.size) },
      riskReview: this.riskReview,
      capitalAtRisk: (() => {
        if (!pos || !val) return null;
        const stop = this.orders.effectiveStop(this.symbol);
        const m = mark || pos.avgPrice;
        if (!(stop > 0)) return { toStopUsd: null, noStop: true };
        const amt = pos.qty * Math.max(0, m - stop);
        return { toStopUsd: amt, pctOfEquity: val.equity > 0 ? (amt / val.equity) * 100 : null, stop };
      })(),
      ui: { language: (this.cfg().ui && this.cfg().ui.language) || 'ar' },
      benchmark: this.benchmark ? { ...this.benchmark, equity: benchmarkEquity(this.benchmark, mark) } : null,
      news: this.news.list(30, now), newsSources: this.news.sourcesStatus(),
    };
  }

  chartData(tf) {
    if (!this.candles) return { bars: [], overlays: {}, markers: [], lines: [] };
    const bars = this.candles.getBars(tf);
    const series = Ind.computeSeries(bars, sessionOfFactory(tf));
    const pick = (k) => bars.map((b, i) => (series[k][i] != null ? { time: b.time, value: series[k][i] } : null)).filter(Boolean);
    const overlays = {};
    for (const k of ['sma9', 'sma20', 'sma50', 'sma200', 'ema9', 'ema21', 'ema50', 'vwap', 'bbUpper', 'bbMid', 'bbLower']) overlays[k] = pick(k);
    let fills = [];
    if (this.session) { try { fills = this.store.listFills(this.session.id).filter((f) => f.symbol === this.symbol); } catch { fills = []; } }
    const markers = fills.map((f) => ({ id: f.id, time: bucketStart(tf, Math.floor(f.ts / 1000)), side: f.side, price: f.price, qty: f.qty, ts: f.ts, kind: f.kind }));
    return { tf, bars, overlays, markers, levels: this.lastAnalysis && this.lastAnalysis.tf === tf ? this.lastAnalysis.sr : (this.lastAnalysis ? this.lastAnalysis.sr : null) };
  }
}

// Shared account state lives in the book (see constructor); these accessors keep the engine code unchanged.
for (const k of ['session', 'portfolio', 'risk', 'orders', 'benchmark', 'aiState', 'aiError']) {
  Object.defineProperty(TradingAgent.prototype, k, { get() { return this.book[k]; }, set(v) { this.book[k] = v; }, configurable: true });
}

/** Runs async jobs one at a time (global AI / decision serialisation across symbols). */
class SerialLock {
  constructor() { this.tail = Promise.resolve(); this.busy = 0; }
  run(fn) {
    const p = this.tail.then(() => { this.busy++; return fn(); }).finally(() => { this.busy--; });
    this.tail = p.catch(() => {});
    return p;
  }
}

module.exports = { TradingAgent, SYMBOL_RE, TIMEFRAMES, SerialLock };
