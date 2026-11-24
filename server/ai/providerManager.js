'use strict';
/**
 * AI Provider Manager — one place that decides which AI provider(s) analyse a market snapshot.
 *
 * Modes (config ai.mode):
 *   DEEPSEEK  all analysis on DeepSeek (Gemini only as fallback when ai.fallback is on)
 *   GEMINI    all analysis on Gemini   (DeepSeek only as fallback when ai.fallback is on)
 *   AUTO      per request: the usable provider with the lowest expected cost adjusted for its
 *             application-level failure rate; sticky to avoid flip-flopping; the other is the fallback
 *   DUAL      important events are analysed by BOTH providers independently and compared; routine
 *             reviews behave like AUTO (ai.dualScope = IMPORTANT | ALL)
 *
 * Safety rules:
 *   - both providers receive the same prompt and their answers pass the same strict validator;
 *   - a disagreement never produces a trade: the combined result is WAIT (flat) or HOLD (in position);
 *   - agreeing models do not make a trade safer: the deterministic risk engine still decides;
 *   - circuit breakers stop calling a failing provider; quota / balance / key errors are not retried
 *     until the cooldown ends (or the key changes);
 *   - every decision records the provider(s) and model(s) actually used.
 */
const { EventEmitter } = require('node:events');
const { extractJson, EXIT_ACTIONS } = require('./proposal');

const MODES = ['DEEPSEEK', 'GEMINI', 'AUTO', 'DUAL'];
const PROVIDERS = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', key: 'DEEPSEEK_API_KEY', model: (cfg) => cfg.ai.model, budgetKey: 'deepseekDailyBudgetUsd' },
  gemini: { id: 'gemini', name: 'Gemini', key: 'GEMINI_API_KEY', model: (cfg) => (cfg.ai.gemini || {}).model, budgetKey: 'geminiDailyBudgetUsd' },
};
const IDS = Object.keys(PROVIDERS);
/** Errors that will not fix themselves within seconds: open the circuit for the long cooldown. */
const FATAL_CODES = new Set(['INVALID_KEY', 'INSUFFICIENT_BALANCE', 'QUOTA']);
/** Triggers that count as "important market events" for DUAL mode. */
const IMPORTANT_TRIGGERS = new Set(['MANUAL', 'NEWS', 'LEVEL_BREAK', 'THESIS_INVALIDATED', 'NEAR_STOP', 'NEAR_TARGET', 'POSITION_CHANGE', 'RISK_CHANGE', 'START', 'SIGNAL_CONFIRMED']);
const TRADE_ACTIONS = new Set(['BUY', ...EXIT_ACTIONS]);

const other = (id) => (id === 'deepseek' ? 'gemini' : 'deepseek');

function classifyError(e) {
  const code = e && e.code ? String(e.code) : 'ERROR';
  if (code === 'RATE_LIMIT' && /quota|exhaust|billing|limit: 0/i.test(String(e.message || ''))) return 'QUOTA';
  return code;
}

class AiProviderManager extends EventEmitter {
  /**
   * @param {object} o
   * @param {object} o.store      Store (settings persistence + provider statistics)
   * @param {object} o.usage      UsageTracker (budgets, rate limits, cost estimates)
   * @param {Function} o.getCfg   full configuration
   * @param {Function} o.getSecret credential lookup (never returned to callers)
   * @param {object} o.deciders   { deepseek: () => decider, gemini: () => decider }
   * @param {Function} o.now
   */
  constructor({ store, usage, getCfg, getSecret, deciders, now = Date.now, redact = (s) => s }) {
    super();
    this.store = store;
    this.usage = usage;
    this.getCfg = getCfg;
    this.getSecret = getSecret;
    this.deciders = deciders;
    this.now = now;
    this.redact = redact;
    this.lastAuto = null;
    const saved = (store && store.getSetting('ai.providerHealth', null)) || {};
    this.health = {};
    for (const id of IDS) this.health[id] = { consecutive: 0, opened: 0, openUntil: 0, code: null, reason: null, at: null, ...(saved[id] || {}) };
    this.statsCache = { at: 0, data: {} };
  }

  mode() { const m = this.getCfg().ai.mode; return MODES.includes(m) ? m : 'AUTO'; }
  providerModel(id) { return PROVIDERS[id].model(this.getCfg()); }
  configured(id) { return !!this.getSecret(PROVIDERS[id].key); }
  anyConfigured() { return IDS.some((id) => this.configured(id)); }
  isOpen(id, ms = this.now()) { return this.health[id].openUntil > ms; }

  saveHealth() {
    try { this.store.setSetting('ai.providerHealth', this.health); } catch { /* best effort */ }
  }

  /** A changed credential closes that provider's circuit (the next request tests the new key). */
  credentialsChanged(name) {
    for (const id of IDS) if (PROVIDERS[id].key === name) { this.health[id] = { ...this.health[id], consecutive: 0, openUntil: 0, code: null, reason: null }; }
    this.saveHealth();
  }

  recordSuccess(id) {
    const h = this.health[id];
    const wasOpen = h.openUntil > 0 || h.consecutive > 0;
    this.health[id] = { ...h, consecutive: 0, opened: 0, openUntil: 0, code: null, reason: null, lastSuccessAt: this.now() };
    if (wasOpen) { this.saveHealth(); this.emit('recovered', { provider: id }); }
  }

  recordFailure(id, e) {
    const cb = this.getCfg().ai.circuitBreaker || { failures: 3, cooldownMin: 5, maxCooldownMin: 60 };
    const code = classifyError(e);
    const h = { ...this.health[id] };
    h.consecutive += 1; h.code = code; h.reason = String(this.redact(String((e && e.message) || code))).slice(0, 300); h.at = this.now();
    let open = 0;
    if (FATAL_CODES.has(code)) open = cb.maxCooldownMin * 60000;
    else if (code === 'RATE_LIMIT' || h.consecutive >= cb.failures) open = Math.min(cb.maxCooldownMin, cb.cooldownMin * 2 ** h.opened) * 60000;
    if (open) { h.opened += 1; h.openUntil = this.now() + open; }
    this.health[id] = h;
    this.saveHealth();
    if (open) this.emit('circuitOpen', { provider: id, code, reason: h.reason, until: h.openUntil });
    return h;
  }

  /** Application-level reliability (last 50 decision requests); cached for a minute. */
  stats(id) {
    const ms = this.now();
    if (ms - this.statsCache.at > 60000) {
      const data = {};
      for (const p of IDS) { try { data[p] = this.store.providerStats(p, 50); } catch { data[p] = { samples: 0, successRate: null }; } }
      this.statsCache = { at: ms, data };
    }
    return this.statsCache.data[id] || { samples: 0, successRate: null };
  }

  /** null when the provider may be called now, otherwise why not. */
  unusable(id, { promptChars = 6000, maxOutputTokens, symbol = null, extraUsd = 0, ms = this.now() } = {}) {
    if (!this.configured(id)) return `${PROVIDERS[id].name} API key not configured`;
    if (this.isOpen(id, ms)) return `${PROVIDERS[id].name} paused after errors until ${new Date(this.health[id].openUntil).toISOString()} (${this.health[id].code})`;
    return this.usage.check({ provider: id, model: this.providerModel(id), promptChars, maxOutputTokens: maxOutputTokens || this.getCfg().ai.maxOutputTokens, ms, symbol, extraUsd });
  }

  /**
   * Which provider(s) to call for one analysis.
   * @returns {{ mode, order: string[], dual: boolean, blocked: string|null, notes: string[] }}
   */
  plan({ promptChars, maxOutputTokens, symbol = null, triggers = [], ms = this.now() } = {}) {
    const cfg = this.getCfg();
    const mode = this.mode();
    const notes = [];
    const ctx = { promptChars, maxOutputTokens, symbol, ms };
    const why = {};
    for (const id of IDS) why[id] = this.unusable(id, ctx);
    const usable = IDS.filter((id) => !why[id]);
    const blockedMsg = () => IDS.map((id) => `${PROVIDERS[id].name}: ${why[id]}`).join(' | ');
    const important = cfg.ai.dualScope === 'ALL' || triggers.some((t) => IMPORTANT_TRIGGERS.has(String(t).split(':')[0].trim()));

    if (mode === 'DUAL' && important) {
      if (usable.length === 2) {
        // the global daily budget must cover BOTH requests
        const est = this.usage.estimate(this.providerModel('deepseek'), promptChars || 6000, maxOutputTokens || cfg.ai.maxOutputTokens, ms);
        const second = this.unusable('gemini', { ...ctx, extraUsd: est });
        if (!second) return { mode, order: ['deepseek', 'gemini'], dual: true, blocked: null, notes };
        notes.push(`dual analysis not affordable (${second}); single provider used`);
      } else if (usable.length === 1) notes.push(`dual analysis unavailable (${blockedMsg()}); ${PROVIDERS[usable[0]].name} analyses alone`);
    }
    if (!usable.length) return { mode, order: [], dual: false, blocked: `No AI provider available — ${blockedMsg()}`, notes };

    if (mode === 'DEEPSEEK' || mode === 'GEMINI') {
      const primary = mode.toLowerCase();
      const fb = other(primary);
      if (!why[primary]) return { mode, order: cfg.ai.fallback && !why[fb] ? [primary, fb] : [primary], dual: false, blocked: null, notes };
      if (cfg.ai.fallback && !why[fb]) { notes.push(`${PROVIDERS[primary].name} unavailable (${why[primary]}) — fallback to ${PROVIDERS[fb].name}`); return { mode, order: [fb], dual: false, blocked: null, notes, fallbackFrom: primary }; }
      return { mode, order: [], dual: false, blocked: `${PROVIDERS[primary].name} unavailable (${why[primary]})${cfg.ai.fallback ? '' : '; fallback is disabled'}`, notes };
    }

    // AUTO (and DUAL for routine reviews)
    const ranked = this.rank(usable, promptChars, maxOutputTokens, ms);
    return { mode, order: ranked, dual: false, blocked: null, notes, scores: this.lastScores };
  }

  /** Lowest expected cost × reliability penalty, with stickiness so the choice does not flip on noise. */
  rank(usable, promptChars = 6000, maxOutputTokens, ms = this.now()) {
    const cfg = this.getCfg();
    const scores = {};
    for (const id of usable) {
      const est = this.usage.estimate(this.providerModel(id), promptChars, maxOutputTokens || cfg.ai.maxOutputTokens, ms);
      const st = this.stats(id);
      const fail = st.successRate == null ? 0 : 1 - st.successRate;
      scores[id] = { est, failRate: fail, score: (est || 1e-6) * (1 + 3 * fail) };
    }
    this.lastScores = scores;
    const sorted = [...usable].sort((a, b) => scores[a].score - scores[b].score);
    const best = sorted[0];
    if (this.lastAuto && scores[this.lastAuto] && this.lastAuto !== best && scores[this.lastAuto].score <= scores[best].score * 1.3) {
      return [this.lastAuto, ...sorted.filter((x) => x !== this.lastAuto)];
    }
    this.lastAuto = best;
    return sorted;
  }

  /** Same prompt for every provider (they share the prompt builder). */
  promptFor(snapshot) {
    const first = IDS.find((id) => this.configured(id)) || 'deepseek';
    return this.deciders[first]().promptFor(snapshot);
  }

  /** DeepSeek server-side web research is only offered while DeepSeek itself is usable. */
  research() {
    if (this.unusable('deepseek', { promptChars: 2000, maxOutputTokens: 4000 })) return null;
    const d = this.deciders.deepseek();
    return d && d.research ? d.research.bind(d) : null;
  }

  async callOne(id, snapshot, opts, attempts) {
    const d = this.deciders[id]();
    const t0 = this.now();
    try {
      const r = await d.decide(snapshot, opts);
      this.recordSuccess(id);
      attempts.push({ provider: id, model: r.model || this.providerModel(id), ok: true, usage: r.usage, latencyMs: r.latencyMs, finishReason: r.finishReason });
      return { ...r, provider: id, model: r.model || this.providerModel(id) };
    } catch (e) {
      this.recordFailure(id, e);
      attempts.push({ provider: id, model: this.providerModel(id), ok: false, error: String(this.redact(String(e.message || ''))), code: classifyError(e), latencyMs: this.now() - t0, usage: null });
      throw e;
    }
  }

  /**
   * Run the plan. Returns the response of the provider that answered (or the combined DUAL result),
   * always with `attempts` (one entry per API call, for usage accounting). Throws when nobody answered.
   * @param {object} opts { messages, onProgress, plan, validate(content) -> { ok, proposal } , hasPosition, language, onFallback }
   */
  async decide(snapshot, opts) {
    const { plan } = opts;
    const attempts = [];
    const callOpts = { messages: opts.messages, onProgress: opts.onProgress };
    if (plan.dual) {
      const settled = await Promise.allSettled(plan.order.map((id) => this.callOne(id, snapshot, callOpts, attempts)));
      const ok = settled.map((s, i) => ({ id: plan.order[i], s })).filter((x) => x.s.status === 'fulfilled');
      if (!ok.length) throw this.aggregate(settled.map((s) => s.reason), attempts);
      const results = ok.map((x) => ({ id: x.id, r: x.s.value, v: opts.validate(x.s.value.content) }));
      const valid = results.filter((x) => x.v.ok);
      if (valid.length === 2) return this.combine(valid, attempts, opts);
      // one provider failed or produced invalid output: use the valid one, clearly marked
      const use = valid[0] || results[0];
      const missing = plan.order.filter((id) => id !== use.id);
      return { ...use.r, attempts, dual: { degraded: true, note: `Dual analysis incomplete: ${missing.map((m) => PROVIDERS[m].name).join(', ')} ${valid.length ? 'did not return a valid analysis' : 'invalid'}; using ${PROVIDERS[use.id].name} alone`, providers: Object.fromEntries(results.map((x) => [x.id, x.v.ok ? summary(x.v.proposal, x.r.model) : { error: 'invalid response' }])) } };
    }
    let lastErr = null;
    for (let i = 0; i < plan.order.length; i++) {
      const id = plan.order[i];
      if (i > 0 && opts.onFallback) opts.onFallback({ from: plan.order[i - 1], to: id, error: lastErr });
      try {
        const r = await this.callOne(id, snapshot, callOpts, attempts);
        return { ...r, attempts, fallbackFrom: i > 0 ? plan.order[0] : (plan.fallbackFrom || null) };
      } catch (e) { lastErr = e; }
    }
    throw this.aggregate([lastErr], attempts);
  }

  aggregate(errors, attempts) {
    const first = errors.find(Boolean) || new Error('AI request failed');
    const err = new Error(attempts.length > 1 ? attempts.filter((a) => !a.ok).map((a) => `${PROVIDERS[a.provider].name}: ${a.error}`).join(' | ') : first.message);
    err.code = first.code || 'ERROR';
    err.retryable = !!first.retryable;
    err.attempts = attempts;
    err.allFatal = attempts.length > 0 && attempts.every((a) => !a.ok && FATAL_CODES.has(a.code));
    return err;
  }

  /** Compare two validated analyses and produce ONE conservative raw proposal for the normal pipeline. */
  combine(valid, attempts, opts) {
    const [A, B] = valid; // A = deepseek, B = gemini (plan order)
    const pa = A.v.proposal; const pb = B.v.proposal;
    const rawA = extractJson(A.r.content); const rawB = extractJson(B.r.content);
    const fields = [['action', 'action'], ['trend', 'trend'], ['directionalBias', 'directional_bias'], ['strategy', 'strategy']];
    const agreement = []; const disagreement = [];
    for (const [f] of fields) (pa[f] === pb[f] ? agreement : disagreement).push({ field: f, [A.id]: pa[f], [B.id]: pb[f] });
    const tradeA = TRADE_ACTIONS.has(pa.action) || pa.isLimitEntry; const tradeB = TRADE_ACTIONS.has(pb.action) || pb.isLimitEntry;
    const lang = opts.language === 'en' ? 'en' : 'ar';
    let raw; let policy;
    if (pa.action === pb.action && !!pa.isLimitEntry === !!pb.isLimitEntry) {
      // agreement: keep ONE provider's internally consistent plan — the more conservative one
      let pick = A;
      if (pa.action === 'BUY' || pa.isLimitEntry) pick = (Number(rawB.position_size_pct_of_equity) || Infinity) < (Number(rawA.position_size_pct_of_equity) || Infinity) ? B : A;
      else if (pa.action === 'REDUCE_POSITION') pick = (Number(rawB.reduce_fraction) || 0) > (Number(rawA.reduce_fraction) || 0) ? B : A;
      raw = { ...(pick === A ? rawA : rawB) };
      raw.confidence = Math.min(pa.confidence, pb.confidence);
      raw.rationale = `${raw.rationale || ''} ${lang === 'ar' ? `[تحليل مزدوج: DeepSeek وGemini متفقان على ${pa.action}؛ اعتُمدت خطة ${PROVIDERS[pick.id].name} الأكثر تحفظًا]` : `[Dual analysis: DeepSeek and Gemini agree on ${pa.action}; ${PROVIDERS[pick.id].name}'s more conservative plan kept]`}`.trim();
      policy = tradeA ? 'AGREE_CONSERVATIVE' : 'AGREE_NO_TRADE';
    } else {
      // disagreement: never trade on it — wait (flat) or hold (in position) and ask for more evidence
      const base = !tradeA ? rawA : !tradeB ? rawB : rawA;
      const action = opts.hasPosition ? 'HOLD' : 'WAIT';
      raw = { ...base, action, order: { type: 'MARKET', limit_price: null } };
      for (const k of ['entry_price', 'stop_loss', 'take_profit', 'trailing_stop_pct', 'position_size_pct_of_equity', 'reduce_fraction', 'reward_to_risk']) raw[k] = null;
      raw.confidence = Math.min(pa.confidence, pb.confidence);
      raw.rationale = lang === 'ar'
        ? `تحليل مزدوج مختلف: اقترح DeepSeek «${pa.action}» واقترح Gemini «${pb.action}». الاختلاف لا يؤدي إلى أي صفقة؛ ${action === 'HOLD' ? 'يبقى المركز بأوامر الحماية الحالية' : 'ننتظر'} حتى تتضح أدلة إضافية.`
        : `Dual analysis disagrees: DeepSeek proposed "${pa.action}", Gemini proposed "${pb.action}". A disagreement never triggers a trade; ${action === 'HOLD' ? 'the position keeps its current protective orders' : 'waiting'} until more evidence is available.`;
      raw.next_action = lang === 'ar' ? 'إعادة التقييم عند حدث جديد أو مراجعة مجدولة' : 'Re-assess on the next material event or scheduled review';
      policy = 'DISAGREE_WAIT';
    }
    const confGap = Math.abs(pa.confidence - pb.confidence);
    const combinedUncertainty = policy === 'DISAGREE_WAIT' ? 'HIGH' : (disagreement.length || confGap > 20 || Math.min(pa.confidence, pb.confidence) < 60) ? 'MEDIUM' : 'LOW';
    const ev = [...new Set([...(pa.evidence || []), ...(pb.evidence || [])].map((x) => (typeof x === 'string' ? x : JSON.stringify(x))))].slice(0, 10);
    const dual = {
      providers: { [A.id]: summary(pa, A.r.model), [B.id]: summary(pb, B.r.model) },
      agreement, disagreement, evidence: ev,
      missingInformation: [pa.uncertainty, pb.uncertainty].filter(Boolean),
      combinedUncertainty, finalAction: raw.action, policy,
      note: 'Two agreeing models do not guarantee a correct forecast; every proposal still passes the deterministic risk engine.',
    };
    return {
      content: JSON.stringify(raw), provider: 'dual', model: `${A.r.model} + ${B.r.model}`,
      latencyMs: Math.max(A.r.latencyMs || 0, B.r.latencyMs || 0), finishReason: A.r.finishReason || B.r.finishReason, usage: null, attempts, dual,
    };
  }

  /** Status for the dashboard / Telegram (no secrets). */
  status(ms = this.now()) {
    const cfg = this.getCfg();
    const providers = {};
    for (const id of IDS) {
      const h = this.health[id];
      const today = this.usage.today(ms, id);
      const month = this.usage.month(ms, id);
      const budget = Number(cfg.ai[PROVIDERS[id].budgetKey]) || 0;
      const st = this.stats(id);
      providers[id] = {
        id, name: PROVIDERS[id].name, model: this.providerModel(id), configured: this.configured(id),
        state: !this.configured(id) ? 'NOT_CONFIGURED' : this.isOpen(id, ms) ? 'PAUSED_AFTER_ERRORS' : 'AVAILABLE',
        openUntil: this.isOpen(id, ms) ? h.openUntil : null, lastErrorCode: h.code, lastError: h.reason, lastErrorAt: h.at,
        requestsToday: today.requests, errorsToday: today.errors || 0, inputTokensToday: today.promptTokens, outputTokensToday: today.completionTokens,
        reasoningTokensToday: today.reasoningTokens || 0, costTodayUsd: today.costUsd, requestsMonth: month.requests, costMonthUsd: month.costUsd,
        avgLatencyMs: st.avgLatencyMs || (today.avgLatencyMs ? Math.round(today.avgLatencyMs) : null), successRate: st.successRate, lastSuccessAt: st.lastSuccessAt || h.lastSuccessAt || null,
        dailyBudgetUsd: budget || null, remainingBudgetUsd: budget ? Math.max(0, budget - today.costUsd) : null,
      };
    }
    return { mode: this.mode(), fallback: !!cfg.ai.fallback, dualScope: cfg.ai.dualScope || 'IMPORTANT', providers };
  }
}

function summary(p, model) {
  return {
    model, action: p.action, confidence: p.confidence, trend: p.trend, bias: p.directionalBias, strategy: p.strategy,
    rationale: p.rationale, evidence: (p.evidence || []).slice(0, 5), uncertainty: p.uncertainty, invalidation: p.invalidation,
    entry: p.entryPrice ?? null, stop: p.stopLoss ?? null, target: p.takeProfit ?? null, keyLevels: p.keyLevels,
  };
}

module.exports = { AiProviderManager, MODES, PROVIDERS, IMPORTANT_TRIGGERS, classifyError };
