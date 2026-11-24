'use strict';
const { tempStore } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { validateProposal, extractJson, proposalKey } = require('../server/ai/proposal');
const { DeepSeekClient } = require('../server/ai/deepseek');
const { AnalysisScheduler } = require('../server/ai/scheduler');
const { UsageTracker } = require('../server/ai/usage');
const { Store } = require('../server/db');
const { DEFAULTS } = require('../server/config');

const CTX = { snapshotId: 'snap_1', symbol: 'ANT', price: 100, hasPosition: false };
const base = { snapshot_id: 'snap_1', action: 'BUY', confidence: 60, entry_price: 100.02, stop_loss: 99, take_profit: 103, order: { type: 'MARKET' }, evidence: ['x'] };

test('AI JSON validation: valid BUY passes and is normalized', () => {
  const r = validateProposal(JSON.stringify({ ...base, strategy: 'breakout', directional_bias: 'bullish', action: 'buy' }), CTX);
  assert.equal(r.ok, true, r.errors.join());
  assert.equal(r.proposal.action, 'BUY');
  assert.equal(r.proposal.strategy, 'BREAKOUT');
  assert.equal(r.proposal.stopLoss, 99);
});

test('AI JSON validation: rejects malformed / inconsistent / mismatched output', () => {
  assert.equal(validateProposal('not json at all', CTX).ok, false);
  assert.match(validateProposal('   ', CTX).errors[0], /Empty AI response/);
  assert.equal(validateProposal(JSON.stringify({ ...base, snapshot_id: 'snap_OTHER' }), CTX).ok, false);
  assert.equal(validateProposal(JSON.stringify({ ...base, stop_loss: 101 }), CTX).ok, false);
  assert.equal(validateProposal(JSON.stringify({ ...base, take_profit: 99.5 }), CTX).ok, false);
  assert.equal(validateProposal(JSON.stringify({ ...base, entry_price: 150 }), CTX).ok, false, 'implausible price');
  assert.equal(validateProposal(JSON.stringify({ ...base, action: 'SHORT' }), CTX).ok, false);
  assert.equal(validateProposal(JSON.stringify({ ...base, confidence: 'high' }), CTX).ok, false);
  assert.equal(validateProposal(JSON.stringify({ ...base, stop_loss: null }), CTX).ok, false);
  assert.equal(validateProposal(JSON.stringify({ ...base, action: 'REDUCE_POSITION', reduce_fraction: 2 }), CTX).ok, false);
  assert.equal(validateProposal('[1,2,3]', CTX).ok, false);
});

test('AI JSON validation: tolerant of fences, fractions; truncates long text', () => {
  const r = validateProposal('```json\n' + JSON.stringify({ ...base, confidence: 0.7, rationale: 'x'.repeat(5000) }) + '\n```', CTX);
  assert.equal(r.ok, true);
  assert.equal(r.proposal.confidence, 70);
  assert.ok(r.proposal.rationale.length <= 800);
  const wait = validateProposal(JSON.stringify({ snapshot_id: 'snap_1', action: 'WAIT', confidence: 30 }), CTX);
  assert.equal(wait.ok, true);
  assert.deepEqual(extractJson('noise {"a":1} trailing'), { a: 1 });
});

test('Duplicate proposals produce the same key', () => {
  const a = validateProposal(JSON.stringify(base), CTX).proposal;
  const b = validateProposal(JSON.stringify({ ...base, rationale: 'different words' }), CTX).proposal;
  assert.equal(proposalKey(a), proposalKey(b));
  const c = validateProposal(JSON.stringify({ ...base, stop_loss: 98.5 }), CTX).proposal;
  assert.notEqual(proposalKey(a), proposalKey(c));
});

function mockDeepSeek(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
  });
}

test('DeepSeek client: streams SSE, hides reasoning, returns usage', async () => {
  let body;
  const { srv, url } = await mockDeepSeek((req, res) => {
    let b = '';
    req.on('data', (c) => { b += c; });
    req.on('end', () => {
      body = JSON.parse(b);
      assert.equal(req.headers.authorization, 'Bearer sk-test-123456');
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      res.write(': keep-alive\n\n');
      send({ model: 'deepseek-flash', choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'secret thoughts ' } }] });
      send({ choices: [{ index: 0, delta: { content: '{"snapshot_id":"snap_1",' } }] });
      send({ choices: [{ index: 0, delta: { content: '"action":"WAIT","confidence":40}' } }] });
      send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 600, prompt_cache_miss_tokens: 400, completion_tokens_details: { reasoning_tokens: 20 } } });
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  const c = new DeepSeekClient({ apiKey: 'sk-test-123456', baseUrl: url });
  const phases = [];
  const r = await c.chat({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'json' }], reasoningEffort: 'low', onProgress: (p) => phases.push(p.phase) });
  srv.close();
  assert.equal(body.thinking.type, 'enabled');
  assert.equal(body.reasoning_effort, 'low');
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.stream, true);
  assert.equal(r.content, '{"snapshot_id":"snap_1","action":"WAIT","confidence":40}');
  assert.equal(JSON.stringify(r).includes('secret thoughts'), false, 'reasoning text is never returned');
  assert.equal(r.reasoningChars, 'secret thoughts '.length);
  assert.equal(r.usage.cacheHit, 600); assert.equal(r.usage.cacheMiss, 400); assert.equal(r.usage.reasoningTokens, 20);
  assert.ok(phases.includes('done'));
});

test('DeepSeek client: maps 401 / 402 / 429 errors', async () => {
  for (const [status, code] of [[401, 'INVALID_KEY'], [402, 'INSUFFICIENT_BALANCE'], [429, 'RATE_LIMIT']]) {
    const { srv, url } = await mockDeepSeek((req, res) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'nope' } })); });
    const c = new DeepSeekClient({ apiKey: 'sk-test-xyz', baseUrl: url });
    await assert.rejects(c.chat({ model: 'deepseek-flash', messages: [] }), (e) => e.code === code);
    srv.close();
  }
  await assert.rejects(new DeepSeekClient({ apiKey: '' }).listModels(), (e) => e.code === 'NO_KEY');
});

test('Scheduler: one analysis at a time, coalesces triggers, honours cooldowns', async () => {
  let running = 0; let maxRunning = 0; const jobs = [];
  let release;
  const s = new AnalysisScheduler({
    getCfg: () => ({ minIntervalSec: 0, regularIntervalSec: 3600 }),
    run: async (job) => { running++; maxRunning = Math.max(maxRunning, running); jobs.push(job); await new Promise((r) => { release = r; }); running--; },
  });
  s.start();
  assert.equal(s.trigger({ type: 'START' }), 'queued');
  await new Promise((r) => setImmediate(r));
  assert.equal(s.trigger({ type: 'CANDLE_CLOSE', key: '1' }), 'queued');
  assert.equal(s.trigger({ type: 'NEWS', key: 'n1', detail: 'x' }), 'merged');
  assert.equal(s.trigger({ type: 'NEWS', key: 'n1', detail: 'x' }), 'cooldown');
  release();
  await new Promise((r) => setTimeout(r, 3100));
  release();
  await new Promise((r) => setTimeout(r, 20));
  s.stop();
  assert.equal(maxRunning, 1, 'never overlapping');
  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[1].reasons.map((x) => x.type), ['CANDLE_CLOSE', 'NEWS']);
  assert.equal(s.trigger({ type: 'START' }), 'ignored', 'stopped scheduler ignores triggers');
});

test('Usage tracker: peak/off-peak cost, daily budget and RPM limits', () => {
  const store = tempStore();
  let cfg = { maxRequestsPerMinute: 2, dailyBudgetUsd: 0.01 };
  const u = new UsageTracker({ store, pricing: DEFAULTS.pricing, getAiCfg: () => cfg });
  const peak = Date.UTC(2026, 10, 18, 2, 0); // Wed 02:00 UTC
  const off = Date.UTC(2026, 10, 18, 12, 0);
  assert.equal(u.isPeak(peak), true); assert.equal(u.isPeak(off), false);
  const usage = { cacheHit: 1e6, cacheMiss: 1e6, completionTokens: 1e6, promptTokens: 2e6, reasoningTokens: 0 };
  assert.ok(Math.abs(u.cost('deepseek-flash', usage, peak) - (0.006 + 0.3 + 1.2)) < 1e-9);
  assert.ok(Math.abs(u.cost('deepseek-flash', usage, off) - (0.003 + 0.15 + 0.6)) < 1e-9);
  u.noteRequestStart(off); u.noteRequestStart(off);
  assert.match(u.check({ model: 'deepseek-flash', promptChars: 100, maxOutputTokens: 10, ms: off }), /Rate limit/);
  cfg = { maxRequestsPerMinute: 10, dailyBudgetUsd: 0.01 };
  u.record({ model: 'deepseek-flash', ok: true, usage: { cacheHit: 0, cacheMiss: 10000, completionTokens: 10000, promptTokens: 10000, reasoningTokens: 0 }, latencyMs: 5, ms: off });
  assert.match(u.check({ model: 'deepseek-flash', promptChars: 30000, maxOutputTokens: 8000, ms: off + 120000 }), /Daily AI budget/);
  store.close();
});
