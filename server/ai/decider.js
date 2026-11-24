'use strict';
/**
 * Decision makers. DeepSeekDecider is the AI used for live sessions.
 * RulesDecider is a transparent, deterministic BASELINE (not AI) available only for DEMO and
 * REPLAY so the pipeline can be tested without an API key; it is always labelled as such.
 */
const { buildMessages, researchMessages } = require('./prompt');
const { extractCitations } = require('./deepseek');

class DeepSeekDecider {
  constructor({ getClient, getCfg }) {
    this.getClient = getClient;
    this.getCfg = getCfg;
    this.kind = 'deepseek';
    this.costly = true; // paid API: subject to the AI cache and request limits
  }

  get label() { return `DeepSeek ${this.getCfg().ai.model}`; }

  promptFor(snapshot) {
    const cfg = this.getCfg();
    return buildMessages(snapshot, { autonomy: cfg.ai.autonomy, fractional: cfg.execution.fractionalShares, language: (cfg.ui && cfg.ui.language) || 'ar' });
  }

  async decide(snapshot, { onProgress, messages } = {}) {
    const cfg = this.getCfg();
    const client = this.getClient();
    const msgs = messages || this.promptFor(snapshot);
    const r = await client.chat({
      model: cfg.ai.model, messages: msgs, json: true, reasoningEffort: cfg.ai.reasoningEffort,
      maxTokens: cfg.ai.maxOutputTokens, onProgress, timeoutMs: cfg.ai.requestTimeoutSec * 1000,
    });
    return { content: r.content, usage: r.usage, latencyMs: r.latencyMs, model: r.model, finishReason: r.finishReason, reasoningChars: r.reasoningChars };
  }

  async research({ symbol, companyName, since, onProgress }) {
    const cfg = this.getCfg();
    const client = this.getClient();
    const r = await client.chat({
      model: cfg.ai.webResearch.model, messages: researchMessages({ symbol, companyName, since, language: (cfg.ui && cfg.ui.language) || 'ar' }), json: false, webTools: true,
      reasoningEffort: 'none', maxTokens: cfg.ai.webResearch.maxOutputTokens, onProgress, timeoutMs: cfg.ai.requestTimeoutSec * 1000,
    });
    return {
      text: r.content, citations: extractCitations(r.annotations), toolCalls: r.serverToolCalls.length,
      usage: r.usage, latencyMs: r.latencyMs, model: r.model, finishReason: r.finishReason,
    };
  }
}

/** Google Gemini decider — same prompt, same strict validation, same risk engine as DeepSeek. */
class GeminiDecider {
  constructor({ getClient, getCfg }) {
    this.getClient = getClient;
    this.getCfg = getCfg;
    this.kind = 'gemini';
    this.costly = true;
  }

  get label() { return `Gemini ${this.getCfg().ai.gemini.model}`; }

  promptFor(snapshot) {
    const cfg = this.getCfg();
    return buildMessages(snapshot, { autonomy: cfg.ai.autonomy, fractional: cfg.execution.fractionalShares, language: (cfg.ui && cfg.ui.language) || 'ar' });
  }

  async decide(snapshot, { onProgress, messages } = {}) {
    const cfg = this.getCfg();
    const r = await this.getClient().chat({
      model: cfg.ai.gemini.model, messages: messages || this.promptFor(snapshot), json: true, reasoningEffort: cfg.ai.reasoningEffort,
      maxTokens: cfg.ai.maxOutputTokens, onProgress, timeoutMs: cfg.ai.requestTimeoutSec * 1000,
    });
    return { content: r.content, usage: r.usage, latencyMs: r.latencyMs, model: r.model, finishReason: r.finishReason, reasoningChars: 0 };
  }
  // no `research()`: DeepSeek's server-side web tools have no verified Gemini equivalent wired here, so web research is skipped
}

/** Deterministic rules baseline — NOT AI. Used only in DEMO / REPLAY. */
class RulesDecider {
  constructor() { this.kind = 'rules'; this.label = 'RULES BASELINE (not AI)'; }

  async decide(snapshot) {
    const tfKey = snapshot.analysisTimeframe;
    const v = snapshot.timeframes[tfKey];
    const ind = (k) => (v && v.indicators[k] && v.indicators[k].available ? v.indicators[k].value : null);
    const price = snapshot.market.lastPrice;
    const ask = snapshot.market.quote ? snapshot.market.quote.ask : price;
    const atr = ind('atr14');
    const ema9 = ind('ema9'); const ema21 = ind('ema21'); const ema50 = ind('ema50'); const rsi = ind('rsi14');
    const hasPos = snapshot.position && snapshot.position.qty > 0;
    const sig = new Set((v && v.signals || []).map((s) => s.id));
    const base = {
      snapshot_id: snapshot.id, strategy: 'TREND_FOLLOWING', trend: 'UNCLEAR', directional_bias: 'NEUTRAL', sentiment: 'NEUTRAL', confidence: 50,
      market_condition: 'Rules baseline evaluation (not AI)', uncertainty: 'Mechanical rules; no discretionary judgement', order: { type: 'MARKET', limit_price: null },
      bull_case: '', bear_case: '', base_case: '', key_levels: {}, expected_range: {}, evidence: [], news_assessment: [], next_action: '', invalidation: '',
    };
    if ([price, atr, ema9, ema21, ema50, rsi].some((x) => x == null)) {
      return { content: JSON.stringify({ ...base, action: 'WAIT', rationale: 'Indicators unavailable — insufficient data', evidence: ['Required indicators unavailable'] }), usage: null, latencyMs: 0, model: this.label };
    }
    const up = ema9 > ema21 && ema21 > ema50;
    if (!hasPos) {
      if ((up && rsi > 50 && rsi < 70) || sig.has('bullish_breakout')) {
        const stop = Math.min(ask - 1.5 * atr, ema21);
        // aim far enough to clear the active profile's minimum reward:risk after spread, slippage and fees
        const minRR = snapshot.risk && snapshot.risk.limits && Number(snapshot.risk.limits.minRewardRisk);
        const target = ask + Math.max(2.2, (minRR > 0 ? minRR : 1.5) + 0.7) * (ask - stop);
        return { content: JSON.stringify({ ...base, action: 'BUY', directional_bias: 'BULLISH', trend: 'UPTREND', entry_price: ask, stop_loss: Number(stop.toFixed(4)), take_profit: Number(target.toFixed(4)), position_size_pct_of_equity: 25, evidence: [`EMA9 ${ema9.toFixed(2)} > EMA21 ${ema21.toFixed(2)} > EMA50 ${ema50.toFixed(2)}`, `RSI ${rsi.toFixed(1)}`], rationale: 'Rules baseline: EMA stack bullish with RSI 50-70', invalidation: `Close below ${stop.toFixed(2)}` }), usage: null, latencyMs: 0, model: this.label };
      }
      return { content: JSON.stringify({ ...base, action: 'WAIT', rationale: 'Rules baseline: no setup', evidence: [`EMA stack ${up ? 'bullish' : 'not bullish'}`, `RSI ${rsi.toFixed(1)}`] }), usage: null, latencyMs: 0, model: this.label };
    }
    if (price < ema21 || sig.has('bearish_breakdown')) {
      return { content: JSON.stringify({ ...base, action: 'EXIT_POSITION', directional_bias: 'BEARISH', rationale: 'Rules baseline: price below EMA21', evidence: [`Price ${price} < EMA21 ${ema21.toFixed(2)}`] }), usage: null, latencyMs: 0, model: this.label };
    }
    return { content: JSON.stringify({ ...base, action: 'HOLD', rationale: 'Rules baseline: trend intact', evidence: [`Price ${price} >= EMA21 ${ema21.toFixed(2)}`] }), usage: null, latencyMs: 0, model: this.label };
  }
}

module.exports = { DeepSeekDecider, GeminiDecider, RulesDecider };
