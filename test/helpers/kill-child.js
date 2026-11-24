'use strict';
// usage: kill-child.js <db> <method:before|after> <BUY|SELL> — dies without any cleanup at that point
const { makeAgent, startLive, manual, buyProposal } = require('./engine');
const [, , file, point, side] = process.argv;
const [method, when] = point.split(':');
const die = () => { require('node:fs').writeSync(1, 'DYING'); process.kill(process.pid, 'SIGKILL'); for (;;) ; };
(async () => {
  const { Store } = require('../../server/db');
  const c = file.startsWith('pg:') ? makeAgent({ store: new Store(null, { postgres: { url: process.env.PG_TEST_URL, schema: file.slice(3), createSchema: true } }) }) : makeAgent({ dbFile: file });
  if (file.startsWith('pg:')) c.config.update({ risk: { ...require('../../server/trading/riskProfiles').LEGACY_DEFAULTS, profile: 'CUSTOM' } });
  await startLive(c);
  const arm = () => {
    if (method === 'commit') { const real = c.store.transaction.bind(c.store); c.store.transaction = (fn) => { real(fn); die(); }; return; }
    const real = c.store[method].bind(c.store);
    const commit = c.agent.commitTrade.bind(c.agent);
    c.agent.commitTrade = (fn) => { c.store[method] = (...x) => { if (when === 'before') die(); real(...x); die(); }; return commit(fn); };
  };
  if (side === 'SELL') { c.decider.push((s) => buyProposal(s)); await c.agent.runAnalysis(manual); arm(); c.agent.executeExit({ kind: 'USER', reason: 'x' }); }
  else { arm(); c.decider.push((s) => buyProposal(s)); await c.agent.runAnalysis(manual); }
})();
