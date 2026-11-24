'use strict';
/**
 * Google Gemini client (Generative Language API, REST). Docs read 2026-11-20 (aistudio.google.com/docs):
 *   POST {base}/v1beta/models/{model}:generateContent   header x-goog-api-key
 *   body: systemInstruction, contents, generationConfig { maxOutputTokens, responseMimeType:'application/json', thinkingConfig }
 *   GET  {base}/v1beta/models  (pageSize, pageToken)
 * generateContent is documented as "legacy but still supported" (the Interactions API is the new default).
 * Thinking: Gemini 3+ models take thinkingLevel (MINIMAL|LOW|MEDIUM|HIGH); 2.5 models take thinkingBudget.
 * Thought parts are never returned or stored — only their token count is recorded.
 * Errors (documented): 400 API_KEY_INVALID, 402 prepay credits depleted, 403 permission denied,
 * 429 RESOURCE_EXHAUSTED (rate / spend limits), 5xx — 429/5xx are retryable, 400/402/403 are not.
 */
const API_KEY_RE = /\bAIza[0-9A-Za-z_-]{20,}\b/g;

class GeminiError extends Error {
  constructor(message, { code, status, retryable = false } = {}) {
    super(message.replace(API_KEY_RE, '[redacted]'));
    this.code = code; this.status = status; this.retryable = retryable;
  }
}

const isGemini3Plus = (model) => /^gemini-(3|4|[5-9])/.test(model);
const LEVEL = { none: 'MINIMAL', low: 'LOW', high: 'HIGH', max: 'HIGH' };
const BUDGET = { none: 0, low: 1024, high: 8192, max: 24576 };

class GeminiClient {
  constructor({ apiKey, baseUrl = 'https://generativelanguage.googleapis.com', fetchImpl, timeoutMs = 180000 }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, timeoutMs } = {}) {
    if (!this.apiKey) throw new GeminiError('Gemini API key is not configured', { code: 'NO_KEY' });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs || this.timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, {
        method, headers: { 'x-goog-api-key': this.apiKey, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: ctrl.signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw new GeminiError(`Gemini request timed out after ${Math.round((timeoutMs || this.timeoutMs) / 1000)}s`, { code: 'TIMEOUT', retryable: true });
      throw new GeminiError(`Network error contacting Gemini: ${e.message}`, { code: 'NETWORK', retryable: true });
    } finally { clearTimeout(t); }
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = (data && data.error) || {};
      const reason = (err.details || []).map((d) => d.reason).filter(Boolean)[0];
      const msg = err.message || `HTTP ${res.status}`;
      if (res.status === 400 && (reason === 'API_KEY_INVALID' || /API key not valid/i.test(msg))) throw new GeminiError(`Gemini rejected the API key: ${msg}`, { code: 'INVALID_KEY', status: 400 });
      if (res.status === 402) throw new GeminiError(`Gemini prepay credits depleted: ${msg}`, { code: 'INSUFFICIENT_BALANCE', status: 402 });
      if (res.status === 403) throw new GeminiError(`Gemini permission denied (key blocked, leaked or project restricted): ${msg}`, { code: 'INVALID_KEY', status: 403 });
      if (res.status === 429) throw new GeminiError(`Gemini rate or spend limit reached (RESOURCE_EXHAUSTED): ${msg}`, { code: 'RATE_LIMIT', status: 429, retryable: true });
      if (res.status >= 500 || res.status === 408) throw new GeminiError(`Gemini server error ${res.status}: ${msg}`, { code: 'SERVER', status: res.status, retryable: true });
      throw new GeminiError(`Gemini error ${res.status} (${err.status || 'error'}): ${msg}`, { code: 'BAD_REQUEST', status: res.status });
    }
    return data;
  }

  async listModels() {
    const out = [];
    let token = null;
    for (let i = 0; i < 5; i++) {
      const d = await this.request(`/v1beta/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`, { timeoutMs: 20000 });
      for (const m of (d && d.models) || []) {
        if ((m.supportedGenerationMethods || []).includes('generateContent')) out.push({ id: String(m.name || '').replace(/^models\//, ''), displayName: m.displayName, outputTokenLimit: m.outputTokenLimit });
      }
      token = d && d.nextPageToken;
      if (!token) break;
    }
    return out;
  }

  /**
   * messages: [{role:'system'|'user'|'assistant', content}] (same shape as the DeepSeek client).
   * Returns { content, usage, latencyMs, model, finishReason, reasoningChars:0 }.
   */
  async chat({ model, messages, json = true, maxTokens = 8000, reasoningEffort = 'low', onProgress, timeoutMs }) {
    const t0 = Date.now();
    if (onProgress) onProgress({ phase: 'waiting', startedAt: t0 });
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const contents = messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const generationConfig = { maxOutputTokens: maxTokens };
    if (json) generationConfig.responseMimeType = 'application/json';
    generationConfig.thinkingConfig = isGemini3Plus(model) ? { thinkingLevel: LEVEL[reasoningEffort] || 'LOW' } : { thinkingBudget: BUDGET[reasoningEffort] ?? 1024 };
    const body = { contents, generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const d = await this.request(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', body, timeoutMs });
    const cand = (d && d.candidates && d.candidates[0]) || {};
    const parts = (cand.content && cand.content.parts) || [];
    const content = parts.filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
    const um = (d && d.usageMetadata) || {};
    const prompt = um.promptTokenCount || 0;
    const cached = um.cachedContentTokenCount || 0;
    const thoughts = um.thoughtsTokenCount || 0;
    const usage = { promptTokens: prompt, completionTokens: (um.candidatesTokenCount || 0) + thoughts, cacheHit: cached, cacheMiss: Math.max(0, prompt - cached), reasoningTokens: thoughts };
    const finish = String(cand.finishReason || '').toUpperCase();
    if (onProgress) onProgress({ phase: 'done' });
    if (!content && finish === 'MAX_TOKENS') throw new GeminiError('Gemini stopped at the output token limit before producing an answer (raise "Max output tokens" or lower reasoning effort)', { code: 'LENGTH' });
    if (!content && d && d.promptFeedback && d.promptFeedback.blockReason) throw new GeminiError(`Gemini blocked the request: ${d.promptFeedback.blockReason}`, { code: 'BLOCKED' });
    return { content, usage, latencyMs: Date.now() - t0, model: d.modelVersion || model, finishReason: finish === 'MAX_TOKENS' ? 'length' : (finish || 'stop').toLowerCase(), reasoningChars: 0 };
  }
}

module.exports = { GeminiClient, GeminiError };
