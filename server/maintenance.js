'use strict';
/**
 * Database safety: accounting reconciliation and crash detection.
 *
 * Nothing here ever invents or rewrites trading records: reconciliation only REPORTS mismatches.
 */
const { Portfolio } = require('./trading/portfolio');

/** Replay every fill of a session through a fresh portfolio and compare with the stored balances. */
function reconcileSession(store, session) {
  if (!session) return { ok: true, session: null, note: 'no active session' };
  const stored = session.portfolio;
  const initial = (stored && stored.initialCapital) || session.initialCapital;
  const fills = store.listFills(session.id);
  const replay = new Portfolio({ initialCapital: initial });
  const problems = [];
  for (const f of fills) {
    try { replay.applyFill({ symbol: f.symbol, side: f.side, qty: f.qty, price: f.price, fees: f.fees || 0, ts: f.ts }); } catch (e) { problems.push(`fill ${f.id}: ${e.message}`); }
  }
  if (!stored) return { ok: problems.length === 0, sessionId: session.id, fills: fills.length, problems, note: 'no stored portfolio yet' };
  const tol = 0.01;
  const diffCash = +(stored.cash - replay.cash).toFixed(6);
  if (Math.abs(diffCash) > tol) problems.push(`cash ${stored.cash.toFixed(2)} stored vs ${replay.cash.toFixed(2)} from ${fills.length} fill(s)`);
  const syms = new Set([...Object.keys(stored.positions || {}), ...Object.keys(replay.positions)]);
  for (const s of syms) {
    const a = (stored.positions || {})[s]; const b = replay.positions[s];
    const qa = a && a.qty > 1e-9 ? a.qty : 0; const qb = b && b.qty > 1e-9 ? b.qty : 0;
    if (Math.abs(qa - qb) > 1e-6) problems.push(`${s} position ${qa} stored vs ${qb} from fills`);
  }
  const diffPnl = +((stored.realizedPnl || 0) - replay.realizedPnl).toFixed(6);
  if (Math.abs(diffPnl) > tol) problems.push(`realized P&L ${Number(stored.realizedPnl || 0).toFixed(2)} stored vs ${replay.realizedPnl.toFixed(2)} from fills`);
  return { ok: problems.length === 0, sessionId: session.id, fills: fills.length, cash: stored.cash, replayCash: replay.cash, problems };
}

/** Crash detection: a run that did not reach a graceful stop leaves cleanShutdown=false behind. */
function markRunStart(store, now) {
  const prev = store.getSetting('runtime.run', null);
  store.setSetting('runtime.run', { startedAt: now, cleanShutdown: false, pid: process.pid });
  return prev && prev.cleanShutdown === false ? { unclean: true, previousStartedAt: prev.startedAt } : { unclean: false, previousStartedAt: prev ? prev.startedAt : null };
}
function markCleanShutdown(store, now) {
  const prev = store.getSetting('runtime.run', {}) || {};
  store.setSetting('runtime.run', { ...prev, cleanShutdown: true, stoppedAt: now });
}

module.exports = { reconcileSession, markRunStart, markCleanShutdown };
