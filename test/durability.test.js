'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Store } = require('../server/db');
const { Portfolio } = require('../server/trading/portfolio');
const { makeAgent, startLive, manual, buyProposal } = require('./helpers/engine');

const snap = (a) => JSON.stringify([a.portfolio.toJSON(), a.orders.toJSON(), a.risk.state, a.benchmark]);
const breakOn = (store, name) => { const real = store[name]; store[name] = () => { throw new Error('disk full'); }; return () => { store[name] = real; }; };
/** Replaying the stored fills must give the stored portfolio. */
function reconcile(store, id) {
  const s = store.getSession(id);
  const p = new Portfolio({ initialCapital: s.initialCapital });
  for (const f of store.listFills(id)) p.applyFill({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fees: f.fees, ts: f.ts });
  assert.ok(Math.abs(p.cash - s.portfolio.cash) < 1e-6, 'cash');
  assert.equal((p.position('TEST') || { qty: 0 }).qty, ((s.portfolio.positions || {}).TEST || { qty: 0 }).qty, 'position');
}

for (const step of ['insertOrder', 'insertFill', 'saveSessionState']) {
  test('durability: a BUY that fails in ' + step + ' leaves no trace, is not announced and stops entries', async () => {
    const c = makeAgent();
    await startLive(c);
    const { agent, store, decider } = c;
    const fills = []; const events = [];
    agent.on('fill', (f) => fills.push(f));
    agent.on('appEvent', (e) => events.push(e));
    const before = snap(agent);
    const fix = breakOn(store, step);
    decider.push((s) => buyProposal(s));
    assert.equal((await agent.runAnalysis(manual)).status, 'EXECUTION_FAILED');
    assert.equal(snap(agent), before);
    assert.equal(fills.length, 0);
    assert.equal(store.listFills(agent.session.id).length, 0);
    assert.ok(!store.listOrders(agent.session.id).some((o) => o.status === 'FILLED'));
    assert.equal(events.filter((e) => e.type === 'RISK_LIMIT' && e.priority === 'high').length, 1);
    assert.ok(agent.book.storageFault);
    fix();
    decider.push((s) => buyProposal(s));
    assert.equal((await agent.runAnalysis(manual)).status, 'EXECUTED', 'works again after storage recovers');
    assert.equal(agent.book.storageFault, null);
    assert.equal(fills.length, 1);
    reconcile(store, agent.session.id);
  });

  test('durability: a SELL that fails in ' + step + ' keeps the position and its stop, then succeeds', async () => {
    const c = makeAgent();
    await startLive(c);
    const { agent, store, decider } = c;
    decider.push((s) => buyProposal(s));
    await agent.runAnalysis(manual);
    const before = snap(agent);
    const fix = breakOn(store, step);
    assert.equal(agent.executeExit({ kind: 'USER', reason: 'test' }).ok, false);
    assert.equal(snap(agent), before);
    fix();
    assert.equal(agent.executeExit({ kind: 'USER', reason: 'test' }).ok, true);
    assert.equal(agent.portfolio.position('TEST'), null);
    assert.equal(agent.orders.getProtection('TEST'), null);
    reconcile(store, agent.session.id);
  });
}

test('durability: the stored state of a closed position has no stop left', async () => {
  const c = makeAgent();
  await startLive(c);
  c.decider.push((s) => buyProposal(s));
  await c.agent.runAnalysis(manual);
  c.agent.afterFill = () => {}; // crash right after the commit
  c.agent.executeExit({ kind: 'USER', reason: 'test' });
  const s = c.store.getSession(c.agent.session.id);
  assert.deepEqual(s.orders.protective, {});
  reconcile(c.store, c.agent.session.id);
});

test('durability: a failed duplicate check blocks the entry, and the database allows one live entry per decision', async () => {
  const c = makeAgent();
  await startLive(c);
  const fix = breakOn(c.store, 'hasLiveOrderForDecision');
  c.decider.push((s) => buyProposal(s));
  assert.equal((await c.agent.runAnalysis(manual)).status, 'DUPLICATE');
  fix();
  const o = (id) => c.store.insertOrder({ id, sessionId: c.agent.session.id, symbol: 'TEST', side: 'BUY', type: 'MARKET', qty: 1, status: 'FILLED', filledQty: 1, decisionId: 'dec_x', createdAt: 1 });
  o('ord_1');
  assert.throws(() => o('ord_2'), /UNIQUE/);
});

test('durability: killing the process at every write leaves a consistent account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dt-kill-'));
  try {
    for (const at of ['insertOrder:before', 'insertOrder:after', 'insertFill:before', 'insertFill:after', 'saveSessionState:after', 'commit:after']) {
      for (const side of ['BUY', 'SELL']) {
        const file = path.join(dir, at.replace(':', '-') + side + '.db');
        const r = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, 'helpers', 'kill-child.js'), file, at, side], { encoding: 'utf8' });
        assert.notEqual(r.status, 0, at + ' ' + side + ' must die: ' + r.stdout + r.stderr);
        assert.match(r.stdout, /DYING/, r.stderr);
        const store = new Store(file);
        const id = store.getActiveSession().id;
        reconcile(store, id);
        const filled = store.listOrders(id).filter((o) => o.status === 'FILLED').length;
        assert.equal(filled, store.listFills(id).length, at + ' ' + side);
        const s = store.getSession(id);
        assert.equal(Object.keys(s.orders.protective).length, s.portfolio.positions.TEST && s.portfolio.positions.TEST.qty > 0 ? 1 : 0, 'protection matches the position');
        store.close ? store.close() : store.db.close();
      }
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
