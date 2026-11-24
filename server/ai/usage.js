'use strict';
/** AI usage (DeepSeek and Gemini, tracked separately and combined), cost estimation, budgets and rate limiting. */
const { etDateStr } = require('../util/time');

class UsageTracker {
  constructor({ store, pricing, getAiCfg }) {
    this.store = store;
    this.pricing = pricing;
    this.getAiCfg = getAiCfg;
    this.window = []; // request start timestamps (rate limit)
    this.symWindow = new Map(); // symbol -> request start timestamps (per-symbol hourly limit)
    this.last = null;
    this.session = { requests: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 };
  }

  isPeak(ms) {
    const d = new Date(ms);
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) return false;
    const h = d.getUTCHours() + d.getUTCMinutes() / 60;
    return (this.pricing.peakWindowsUtc || []).some(([a, b]) => h >= a && h < b);
  }

  prices(model, ms) {
    const m = (this.pricing.models && this.pricing.models[model]) || this.pricing.fallback;
    return this.isPeak(ms) ? m.peak : m.offPeak;
  }

  cost(model, usage, ms = Date.now()) {
    const p = this.prices(model, ms);
    return (usage.cacheHit * p.cacheHit + usage.cacheMiss * p.cacheMiss + usage.completionTokens * p.output) / 1e6;
  }

  /** Conservative pre-request estimate (assumes no cache hits and the full output budget). */
  estimate(model, promptChars, maxOutputTokens, ms = Date.now()) {
    const p = this.prices(model, ms);
    const promptTokens = Math.ceil(promptChars / 3);
    return (promptTokens * p.cacheMiss + maxOutputTokens * p.output) / 1e6;
  }

  /** Today's totals (ET day); `provider` narrows to one AI provider. */
  today(ms = Date.now(), provider = null) {
    const day = etDateStr(ms);
    try { return { day, ...this.store.usageForDay(day, provider) }; } catch { return { day, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, cacheHit: 0, cacheMiss: 0, reasoningTokens: 0, costUsd: 0 }; }
  }

  requestsLastMinute(ms = Date.now()) {
    this.window = this.window.filter((t) => ms - t < 60000);
    return this.window.length;
  }

  symbolRequestsLastHour(symbol, ms = Date.now()) {
    const w = (this.symWindow.get(symbol) || []).filter((t) => ms - t < 3600000);
    this.symWindow.set(symbol, w);
    return w.length;
  }

  month(ms = Date.now(), provider = null) {
    const day = etDateStr(ms);
    const from = `${day.slice(0, 7)}-01`;
    try { return { from, to: day, ...this.store.usageBetween(from, day, provider) }; } catch { return { from, to: day, requests: 0, errors: 0, promptTokens: 0, completionTokens: 0, costUsd: 0 }; }
  }

  /** Returns null if allowed, or a human-readable reason why a request must not be sent. */
  check({ model, promptChars, maxOutputTokens, ms = Date.now(), symbol = null, provider = null, extraUsd = 0 }) {
    const cfg = this.getAiCfg();
    const rpm = this.requestsLastMinute(ms);
    if (rpm >= cfg.maxRequestsPerMinute) return `Rate limit: ${rpm}/${cfg.maxRequestsPerMinute} requests in the last minute`;
    if (symbol && cfg.maxPerSymbolPerHour > 0) {
      const n = this.symbolRequestsLastHour(symbol, ms);
      if (n >= cfg.maxPerSymbolPerHour) return `Per-symbol limit: ${symbol} ${n}/${cfg.maxPerSymbolPerHour} requests in the last hour (${cfg.usageMode} mode)`;
    }
    const t = this.today(ms);
    if (cfg.maxRequestsPerDay > 0 && t.requests >= cfg.maxRequestsPerDay) return `Daily AI request cap: ${t.requests}/${cfg.maxRequestsPerDay} requests today (${cfg.usageMode} mode)`;
    if (cfg.monthlyBudgetUsd > 0) {
      const mo = this.month(ms);
      if (mo.costUsd >= cfg.monthlyBudgetUsd) return `Monthly AI budget: spent $${mo.costUsd.toFixed(4)} of $${cfg.monthlyBudgetUsd.toFixed(2)}`;
    }
    const est = this.estimate(model, promptChars, maxOutputTokens, ms);
    if (t.costUsd + extraUsd + est > cfg.dailyBudgetUsd) return `Daily AI budget: spent $${t.costUsd.toFixed(4)} of $${cfg.dailyBudgetUsd.toFixed(2)}; next request may cost up to $${(est + extraUsd).toFixed(4)}`;
    // optional per-provider daily budget (application setting, not a provider quota)
    const pb = provider ? Number(cfg[`${provider}DailyBudgetUsd`]) || 0 : 0;
    if (pb > 0) {
      const pt = this.today(ms, provider);
      if (pt.costUsd + est > pb) return `${provider === 'gemini' ? 'Gemini' : 'DeepSeek'} daily budget: spent $${pt.costUsd.toFixed(4)} of $${pb.toFixed(2)}; next request may cost up to $${est.toFixed(4)}`;
    }
    return null;
  }

  noteRequestStart(ms = Date.now(), symbol = null) {
    this.window.push(ms);
    if (symbol) { const w = this.symWindow.get(symbol) || []; w.push(ms); this.symWindow.set(symbol, w); }
  }

  record({ model, purpose, ok, usage, latencyMs, error, ms = Date.now(), provider = null }) {
    const u = usage || { promptTokens: 0, completionTokens: 0, cacheHit: 0, cacheMiss: 0, reasoningTokens: 0 };
    const costUsd = this.cost(model, u, ms);
    const prov = provider || (/^gemini/i.test(String(model)) ? 'gemini' : /^deepseek/i.test(String(model)) ? 'deepseek' : null);
    const row = { ts: ms, day: etDateStr(ms), model, purpose, ok, ...u, costUsd, latencyMs, error: error || null, provider: prov };
    try { this.store.insertUsage(row); } catch { /* reported by caller */ }
    this.last = row;
    this.session.requests++; this.session.promptTokens += u.promptTokens; this.session.completionTokens += u.completionTokens; this.session.costUsd += costUsd;
    return row;
  }

  summary(ms = Date.now()) {
    const cfg = this.getAiCfg();
    const t = this.today(ms);
    return {
      day: t.day, requests: t.requests, inputTokens: t.promptTokens, outputTokens: t.completionTokens, cacheHitTokens: t.cacheHit,
      reasoningTokens: t.reasoningTokens, estimatedCostUsd: t.costUsd, dailyBudgetUsd: cfg.dailyBudgetUsd,
      budgetRemainingUsd: Math.max(0, cfg.dailyBudgetUsd - t.costUsd), requestsLastMinute: this.requestsLastMinute(ms),
      maxRequestsPerMinute: cfg.maxRequestsPerMinute, lastLatencyMs: this.last ? this.last.latencyMs : null,
      pricingPeriod: this.isPeak(ms) ? 'peak' : 'off-peak', lastModel: this.last ? this.last.model : null,
      usageMode: cfg.usageMode || null, maxRequestsPerDay: cfg.maxRequestsPerDay || null, monthlyBudgetUsd: cfg.monthlyBudgetUsd || 0,
    };
  }
}

module.exports = { UsageTracker };
