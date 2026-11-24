'use strict';
/** One analysis in its own process: heavy work and the agent framework never share memory with trading. */
const { analyze } = require('./quant');
const { decide, merge } = require('./committee');

process.on('message', async (m) => {
  const send = (x) => new Promise((r) => { if (!process.connected) { r(); return; } process.send(x, () => r()); });
  if (m.task === 'levels') {
    try { const { proposeLevels } = require('./agents'); await send({ type: 'result', report: await proposeLevels(m.evidence, m.model, { lang: m.lang }) }); } catch (e) { await send({ type: 'error', message: 'levels' }); }
    process.exit(0);
  }
  if (m.task === 'opportunity' || m.task === 'chat') {
    try {
      const report = m.task === 'chat' ? await require('../helper/agent').chat(m.ask, m.model, { lang: m.lang }) : await require('../opportunity/agents').reviewOpportunity(m.evidence, m.model, { lang: m.lang, onProgress: (step, state) => send({ type: 'progress', step, state }) });
      await send({ type: 'result', report });
    } catch (e) { if (process.env.LAB_DEBUG) console.error(e); await send({ type: 'error', message: m.task }); }
    process.exit(0);
  }
  try {
    send({ type: 'progress', step: 'numbers', state: 'start' });
    const quant = analyze(m.bars, m.bench, m.options);
    send({ type: 'progress', step: 'numbers', state: 'done' });
    const rules = decide({ quant, facts: m.facts, sharia: m.sharia });
    let agents = null; let agentError = null;
    if (m.model && quant.available) {
      try {
        const { runAgents } = require('./agents');
        agents = await runAgents({ symbol: m.symbol, quant, facts: m.facts, rules, memory: m.memory, closes: m.bars.map((b) => b.close) }, m.model, { lang: m.lang, onProgress: (step, state, verdict) => send({ type: 'progress', step, state, verdict }) });
      } catch (e) { agentError = String(e.message || e).slice(0, 160); }
    }
    await send({ type: 'result', report: { symbol: m.symbol, at: m.at, quant, facts: m.facts, rules, agents, agentError, verdict: merge(rules, agents) } });
  } catch (e) { await send({ type: 'error', message: String(e.message || e).slice(0, 200) }); }
  process.exit(0);
});
process.on('disconnect', () => process.exit(1));
