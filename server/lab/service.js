'use strict';
/**
 * Analysis service of one account: collects the evidence, runs the worker, keeps the reports, grades its own past
 * results and gives the trading engine one answer: whether a fresh report speaks against buying.
 */
const { fork } = require('node:child_process');
const path = require('node:path');
const { gather } = require('./facts');
const { isCrypto } = require('../market/crypto');

const DAY = 86400000;
const KEEP = 150;
const HORIZON = 5; // trading days after which a result is graded
const AGENT_RUNS_PER_DAY = 12;

class LabService {
  constructor({ store, desk, sharia, publicData = false, getModel = () => null, fetchImpl, activity, now = Date.now, workerFile = path.join(__dirname, 'worker.js'), timeoutMs = 600000, gatherImpl = gather }) {
    Object.assign(this, { store, desk, sharia, publicData, getModel, fetchImpl, activity, now, workerFile, timeoutMs, gatherImpl });
    this.running = null; // one at a time per account
    this.reports = this.get('lab.reports', {});
    this.history = this.get('lab.history', []);
    this.tried = new Map();
  }

  get(k, d) { try { return this.store.getSetting(k, d) || d; } catch { return d; } }
  put(k, v) { try { this.store.setSetting(k, v); } catch (e) { if (this.activity) this.activity.warn(`Analysis could not be saved: ${e.message}`); } }
  gateOn() { return this.get('lab.gate', { on: true }).on !== false; }
  setGate(on) { this.put('lab.gate', { on: !!on }); return this.gateOn(); }
  agent(symbol) { return this.desk.agent(String(symbol || '').toUpperCase()); }
  live(a) { return !!(a && a.dataMode === 'LIVE' && a.provider); }
  shariaOf(symbol) { try { return this.sharia.effective(symbol).status; } catch { return 'UNKNOWN'; } }

  /** Used by the engine before every new buy. A missing or old report never blocks; a fresh "avoid" does. */
  gate(symbol) {
    if (!this.gateOn()) return null;
    const r = this.reports[symbol];
    if (!r || this.now() - r.at > DAY) return null;
    return { pass: r.verdict !== 'AVOID', detail: r.verdict === 'AVOID' ? 'The analysis committee advises against buying' : 'The analysis committee does not object' };
  }

  agentRunsToday() { const t = this.now(); return this.history.filter((h) => h.agents && t - h.at < DAY).length; }

  async run(symbolIn, { lang = 'ar', agents = true } = {}) {
    const symbol = String(symbolIn || '').trim().toUpperCase();
    const a = this.agent(symbol);
    if (!a) throw Object.assign(new Error('Add the symbol to your list first'), { status: 400 });
    if (!this.live(a)) throw Object.assign(new Error('Analysis needs real prices'), { status: 400 });
    if (this.running) throw Object.assign(new Error('An analysis is already running'), { status: 409 });
    const job = { symbol, startedAt: this.now(), steps: {}, state: 'RUNNING' };
    this.running = job;
    this.last = job;
    try {
      job.steps.data = { state: 'start' };
      const crypto = isCrypto(symbol);
      const [bars, bench, facts] = await Promise.all([
        a.provider.fetchBars(symbol, '1d', { limit: 1250 }),
        this.benchmark(crypto),
        crypto || !this.publicData ? null : this.gatherImpl(symbol, { fetchImpl: this.fetchImpl, now: this.now }),
      ]);
      job.steps.data = { state: 'done' };
      const model = agents && this.agentRunsToday() < AGENT_RUNS_PER_DAY ? this.getModel() : null;
      const prot = a.book.orders && a.book.orders.getProtection ? a.book.orders.getProtection(symbol) : null;
      const limits = (a.cfg().risk) || {};
      const report = await this.work({ symbol, at: this.now(), bars, bench, facts, sharia: this.shariaOf(symbol), model, lang, memory: this.memory(symbol), options: { price: a.market && a.market.mark(), stop: prot && prot.stop, target: prot && prot.takeProfit, riskCapPct: limits.maxPositionPct || 20 } }, job);
      this.grade(symbol, bars);
      if (report.facts && report.facts.news) report.facts.news.items = report.facts.news.items.slice(0, 8);
      this.reports[symbol] = report;
      const keys = Object.keys(this.reports).sort((x, y) => this.reports[y].at - this.reports[x].at);
      for (const k of keys.slice(12)) delete this.reports[k];
      this.history.push({ symbol, at: report.at, price: report.quant.available ? report.quant.price : null, verdict: report.verdict, score: report.rules.score, agents: !!report.agents });
      this.history = this.history.slice(-KEEP);
      this.put('lab.reports', this.reports);
      this.put('lab.history', this.history);
      job.state = 'DONE';
      return report;
    } catch (e) { job.state = 'FAILED'; throw e; } finally { this.running = null; }
  }

  async benchmark(crypto) {
    try { const s = crypto ? 'BTC/USD' : 'SPY'; const a = this.desk.all().find((x) => this.live(x) && isCrypto(x.symbol) === crypto); return a ? await a.provider.fetchBars(s, '1d', { limit: 1250 }) : []; } catch { return []; }
  }

  work(msg, job) {
    return new Promise((resolve, reject) => {
      const env = {}; for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'NODE_ENV']) if (process.env[k]) env[k] = process.env[k];
      const c = fork(this.workerFile, [], { env: { ...env, MASTRA_TELEMETRY_DISABLED: '1' }, execArgv: ['--max-old-space-size=384'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      this.child = c;
      let settled = false;
      const end = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); this.child = null; try { c.kill('SIGKILL'); } catch { /* gone */ } fn(v); };
      const timer = setTimeout(() => end(reject, new Error('The analysis took too long')), this.timeoutMs);
      c.on('message', (m) => { if (m.type === 'progress') job.steps[m.step] = { state: m.state, verdict: m.verdict || null }; else if (m.type === 'result') end(resolve, m.report); else if (m.type === 'error') end(reject, new Error('The analysis could not be completed')); });
      c.on('error', () => end(reject, new Error('The analysis could not be started')));
      c.on('exit', () => end(reject, new Error('The analysis stopped unexpectedly')));
      c.send(msg, (e) => { if (e) end(reject, new Error('The analysis could not be started')); });
    });
  }

  /** Grades past results with what the price did afterwards. */
  grade(symbol, bars) {
    for (const h of this.history) {
      if (h.symbol !== symbol || h.after != null || !h.price) continue;
      const i = bars.findIndex((b) => b.time * 1000 > h.at);
      if (i >= 0 && bars[i + HORIZON - 1]) h.after = bars[i + HORIZON - 1].close / h.price - 1;
    }
  }

  memory(symbol) {
    const done = this.history.filter((h) => h.symbol === symbol && h.after != null).slice(-8).map((h) => ({ date: new Date(h.at).toISOString().slice(0, 10), verdict: h.verdict, priceThen: h.price, changeAfter5Days: h.after }));
    return { earlier: done, record: this.record() };
  }

  record() {
    const g = this.history.filter((h) => h.after != null && ['SUPPORT', 'AVOID'].includes(h.verdict));
    return { graded: g.length, right: g.filter((h) => (h.verdict === 'SUPPORT' ? h.after > 0 : h.after <= 0)).length, waiting: this.history.filter((h) => h.after == null && h.price).length };
  }

  /** Once a day per live symbol the fixed rules run by themselves; agents run only when asked. */
  async sweep() {
    if (this.running || !this.publicData || this.desk.book.aiState !== 'RUNNING') return;
    const a = this.desk.all().find((x) => this.live(x) && this.now() - (this.reports[x.symbol] ? this.reports[x.symbol].at : 0) > DAY / 2 && this.now() - (this.tried.get(x.symbol) || 0) > 3600000);
    if (!a) return;
    this.tried.set(a.symbol, this.now());
    try { await this.run(a.symbol, { agents: false }); } catch { /* shown on the page when asked for */ }
  }

  status(symbol) {
    const s = String(symbol || '').toUpperCase();
    const j = this.running || (this.last && this.last.symbol === s ? this.last : null);
    return { symbol: s, live: this.live(this.agent(s)), report: this.reports[s] || null, job: j ? { symbol: j.symbol, state: j.state, steps: j.steps, startedAt: j.startedAt } : null, gate: this.gateOn(), agentsReady: !!this.getModel() && !(this.modelProbe && this.modelProbe.ok === false), agentRunsLeft: Math.max(0, AGENT_RUNS_PER_DAY - this.agentRunsToday()), sharia: this.shariaOf(s), record: this.record(), history: this.history.filter((h) => h.symbol === s).slice(-12) };
  }

  stop() { if (this.child) { try { this.child.kill('SIGKILL'); } catch { /* gone */ } } }
}

module.exports = { LabService, HORIZON };
