'use strict';
/**
 * DeepSeek API client (OpenAI-compatible Chat Completions). Docs checked 2026-11-19
 * (https://api-docs.deepseek.com):
 *   POST {base}/chat/completions   models: deepseek-flash, deepseek-v4-pro
 *   thinking: {"type":"enabled"|"disabled"}, reasoning_effort: "low"|"high"|"max" ("none" disables)
 *   response_format: {"type":"json_object"}  (prompt must mention "json"; invalid JSON -> blank content)
 *   server-side web tools: {"type":"deepseek_web_search"}, {"type":"deepseek_read_url"} (deepseek-flash;
 *     cannot be combined with json_object or function tools)
 *   usage: prompt_cache_hit_tokens, prompt_cache_miss_tokens, completion_tokens, completion_tokens_details.reasoning_tokens
 *   errors: 400 format, 401 auth, 402 insufficient balance, 422 params, 429 rate limit, 500/503 server
 *
 * The model's hidden reasoning (reasoning_content) is never stored or displayed — only its size.
 */
const ERRORS = {
  400: ['BAD_REQUEST', 'Invalid request format', false],
  401: ['INVALID_KEY', 'Authentication failed: invalid DeepSeek API key', false],
  402: ['INSUFFICIENT_BALANCE', 'DeepSeek account has insufficient balance — top up at platform.deepseek.com', false],
  422: ['INVALID_PARAMS', 'Invalid parameters (model name or option not supported)', false],
  429: ['RATE_LIMIT', 'DeepSeek rate/concurrency limit reached', true],
  500: ['SERVER_ERROR', 'DeepSeek server error', true],
  503: ['OVERLOADED', 'DeepSeek server overloaded', true],
};

class DeepSeekError extends Error {
  constructor(message, { status = 0, code = 'UNKNOWN', retryable = false, body = null } = {}) {
    super(message);
    this.name = 'DeepSeekError';
    this.status = status; this.code = code; this.retryable = retryable; this.body = body;
  }
}

class DeepSeekClient {
  constructor({ apiKey, baseUrl = 'https://api.deepseek.com', fetchImpl, timeoutMs = 180000 }) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl || globalThis.fetch;
    this.timeoutMs = timeoutMs;
  }

  headers() { return { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' }; }

  async request(path, { method = 'GET', body, timeoutMs = 30000, stream = false } = {}) {
    if (!this.apiKey) throw new DeepSeekError('DeepSeek API key is not configured', { code: 'NO_KEY' });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}${path}`, { method, headers: this.headers(), body: body ? JSON.stringify(body) : undefined, signal: ac.signal });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === 'AbortError') throw new DeepSeekError(`DeepSeek request timed out after ${Math.round(timeoutMs / 1000)}s`, { code: 'TIMEOUT', retryable: true });
      throw new DeepSeekError(`Network error contacting DeepSeek: ${e.message}`, { code: 'NETWORK', retryable: true });
    }
    if (!res.ok) {
      clearTimeout(timer);
      let text = '';
      try { text = await res.text(); } catch { /* ignore */ }
      let detail = text;
      try { const j = JSON.parse(text); detail = (j.error && (j.error.message || j.error)) || j.message || text; } catch { /* ignore */ }
      const [code, msg, retryable] = ERRORS[res.status] || ['HTTP_' + res.status, `DeepSeek HTTP ${res.status}`, res.status >= 500];
      throw new DeepSeekError(`${msg}${detail ? `: ${String(detail).slice(0, 300)}` : ''}`, { status: res.status, code, retryable });
    }
    return { res, timer, ac };
  }

  async listModels() {
    const { res, timer } = await this.request('/models');
    try { const j = await res.json(); return (j.data || []).map((m) => ({ id: m.id, name: m.name, contextWindow: m.context_window, maxOutput: m.max_output_tokens, effort: m.effort })); } finally { clearTimeout(timer); }
  }

  async getBalance() {
    const { res, timer } = await this.request('/user/balance');
    try { return await res.json(); } finally { clearTimeout(timer); }
  }

  /**
   * Streaming chat completion. Returns { content, reasoningChars, usage, finishReason, serverToolCalls, annotations, latencyMs, model }.
   * onProgress receives { phase: 'waiting'|'thinking'|'answering'|'tool'|'done', reasoningChars, contentChars, tool }.
   */
  async chat({ model, messages, json = true, reasoningEffort = 'low', maxTokens = 8000, webTools = false, onProgress = () => {}, timeoutMs }) {
    const body = { model, messages, stream: true, stream_options: { include_usage: true }, max_tokens: maxTokens };
    if (reasoningEffort === 'none') body.thinking = { type: 'disabled' };
    else { body.thinking = { type: 'enabled' }; body.reasoning_effort = reasoningEffort; }
    if (json && !webTools) body.response_format = { type: 'json_object' };
    if (webTools) body.tools = [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }];
    if (reasoningEffort === 'none' && !webTools) body.temperature = 0.2;

    const t0 = Date.now();
    onProgress({ phase: 'waiting', reasoningChars: 0, contentChars: 0 });
    const { res, timer } = await this.request('/chat/completions', { method: 'POST', body, timeoutMs: timeoutMs || this.timeoutMs, stream: true });
    let content = '';
    let reasoningChars = 0;
    let usage = null;
    let finishReason = null;
    let respModel = model;
    const serverToolCalls = [];
    const annotations = [];
    let lastEmit = 0;
    const emit = (phase, extra = {}) => {
      const now = Date.now();
      if (phase === 'thinking' || phase === 'answering') { if (now - lastEmit < 250) return; lastEmit = now; }
      onProgress({ phase, reasoningChars, contentChars: content.length, ...extra });
    };
    try {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (!line || line.startsWith(':')) continue; // keep-alive comments
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.model) respModel = chunk.model;
          if (chunk.usage) usage = chunk.usage;
          const ch = chunk.choices && chunk.choices[0];
          if (!ch) continue;
          const d = ch.delta || {};
          if (typeof d.reasoning_content === 'string' && d.reasoning_content) { reasoningChars += d.reasoning_content.length; emit('thinking'); }
          if (typeof d.content === 'string' && d.content) { content += d.content; emit('answering'); }
          if (d.server_tool_event) { serverToolCalls.push(d.server_tool_event); emit('tool', { tool: summarizeToolEvent(d.server_tool_event) }); }
          if (Array.isArray(d.annotations)) annotations.push(...d.annotations);
          if (ch.message && Array.isArray(ch.message.annotations)) annotations.push(...ch.message.annotations);
          if (ch.message && Array.isArray(ch.message.server_tool_calls)) serverToolCalls.push(...ch.message.server_tool_calls);
          if (ch.finish_reason) finishReason = ch.finish_reason;
        }
      }
    } catch (e) {
      throw new DeepSeekError(`Stream interrupted: ${e.message}`, { code: 'STREAM', retryable: true });
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = Date.now() - t0;
    onProgress({ phase: 'done', reasoningChars, contentChars: content.length });
    return { content, reasoningChars, usage: normalizeUsage(usage), finishReason, serverToolCalls, annotations, latencyMs, model: respModel };
  }
}

function summarizeToolEvent(ev) {
  if (!ev || typeof ev !== 'object') return String(ev);
  const type = ev.type || ev.name || 'tool';
  const q = ev.query || (ev.arguments && (ev.arguments.query || ev.arguments.url)) || ev.url || '';
  return `${type}${q ? `: ${String(q).slice(0, 120)}` : ''}`;
}

function normalizeUsage(u) {
  if (!u) return { promptTokens: 0, completionTokens: 0, cacheHit: 0, cacheMiss: 0, reasoningTokens: 0, reported: false };
  const hit = u.prompt_cache_hit_tokens ?? (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ?? 0;
  const prompt = u.prompt_tokens || 0;
  return {
    promptTokens: prompt,
    completionTokens: u.completion_tokens || 0,
    cacheHit: hit,
    cacheMiss: u.prompt_cache_miss_tokens ?? Math.max(0, prompt - hit),
    reasoningTokens: (u.completion_tokens_details && u.completion_tokens_details.reasoning_tokens) || 0,
    serverToolUse: u.server_tool_use || null,
    reported: true,
  };
}

/** Extract citation URLs from web-tool annotations (shape-tolerant). */
function extractCitations(annotations) {
  const out = [];
  const seen = new Set();
  for (const a of annotations || []) {
    const c = a.url_citation || a;
    const url = c && c.url;
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, title: c.title || '', publishedAt: c.published_at || c.date || null });
  }
  return out;
}

module.exports = { DeepSeekClient, DeepSeekError, normalizeUsage, extractCitations };
