'use strict';
/**
 * AI cost control. Market monitoring, indicators, levels, P&L and risk all run locally; the AI is only
 * asked to INTERPRET when something material changed. This module provides:
 *  - usage modes (ECONOMY / BALANCED / DETAILED) that set how often the AI may be asked,
 *  - a material-state hash of a snapshot: when it is unchanged and no forcing event happened, the
 *    previous analysis is reused instead of sending a new request,
 *  - the list of triggers that always deserve a fresh analysis.
 * Deterministic risk protections are identical in every mode.
 */
const crypto = require('node:crypto');

const MODES = {
  ECONOMY: {
    reviewIntervalMin: 60, minIntervalSec: 300, regularIntervalSec: 1800, maxPerSymbolPerHour: 2, maxRequestsPerDay: 40,
    maxOutputTokens: 6000, reasoningEffort: 'none', candleCloseTrigger: false, webResearchIntervalMin: 0, priceStepAtr: 1.0, compactSnapshot: true,
  },
  BALANCED: {
    reviewIntervalMin: 20, minIntervalSec: 120, regularIntervalSec: 900, maxPerSymbolPerHour: 6, maxRequestsPerDay: 150,
    maxOutputTokens: 9000, reasoningEffort: 'low', candleCloseTrigger: true, webResearchIntervalMin: 120, priceStepAtr: 0.5, compactSnapshot: true,
  },
  DETAILED: {
    reviewIntervalMin: 5, minIntervalSec: 45, regularIntervalSec: 300, maxPerSymbolPerHour: 20, maxRequestsPerDay: 500,
    maxOutputTokens: null, reasoningEffort: null, candleCloseTrigger: true, webResearchIntervalMin: null, priceStepAtr: 0.25, compactSnapshot: false,
  },
};
const MODE_IDS = Object.keys(MODES);
const EFFORT_ORDER = ['none', 'low', 'high', 'max'];

/** Triggers that always get a fresh analysis (subject to budgets / rate limits, never to the cache). */
const FORCE_TRIGGERS = new Set(['MANUAL', 'START', 'NEWS', 'LEVEL_BREAK', 'NEAR_STOP', 'NEAR_TARGET', 'POSITION_CHANGE', 'RISK_CHANGE', 'STALE_PROPOSAL', 'THESIS_INVALIDATED', 'SIGNAL_CONFIRMED']);

/** AI settings with the usage-mode preset applied. User limits can only make a mode stricter. */
function effectiveAiCfg(ai) {
  const mode = MODES[ai.usageMode] ? ai.usageMode : 'BALANCED';
  const m = MODES[mode];
  const out = { ...ai, usageMode: mode, mode: m };
  out.minIntervalSec = Math.max(ai.minIntervalSec || 0, m.minIntervalSec);
  out.regularIntervalSec = Math.max(ai.regularIntervalSec || 0, m.regularIntervalSec);
  if (m.maxOutputTokens) out.maxOutputTokens = Math.min(ai.maxOutputTokens || m.maxOutputTokens, m.maxOutputTokens);
  if (m.reasoningEffort) out.reasoningEffort = EFFORT_ORDER[Math.min(EFFORT_ORDER.indexOf(ai.reasoningEffort || 'low'), EFFORT_ORDER.indexOf(m.reasoningEffort))] || m.reasoningEffort;
  out.reviewIntervalMin = m.reviewIntervalMin;
  out.maxPerSymbolPerHour = ai.maxRequestsPerSymbolPerHour > 0 ? Math.min(ai.maxRequestsPerSymbolPerHour, m.maxPerSymbolPerHour) : m.maxPerSymbolPerHour;
  out.maxRequestsPerDay = ai.maxRequestsPerDay > 0 ? Math.min(ai.maxRequestsPerDay, m.maxRequestsPerDay) : m.maxRequestsPerDay;
  out.candleCloseTrigger = m.candleCloseTrigger;
  out.compactSnapshot = m.compactSnapshot;
  out.priceStepAtr = m.priceStepAtr;
  const wr = ai.webResearch || {};
  out.webResearch = { ...wr, enabled: !!wr.enabled && m.webResearchIntervalMin !== 0, intervalMin: m.webResearchIntervalMin ? Math.max(wr.intervalMin || 0, m.webResearchIntervalMin) : wr.intervalMin };
  return out;
}

/**
 * Hash of what the AI would need to re-interpret: price location in ATR steps, nearest level ranks and
 * status, structure, active signals, confirmed recent candle patterns, position / pending orders, risk
 * blocks, session and the set of news items. Small price noise inside one step does not change it.
 */
function materialStateHash(snapshot, tf, priceStepAtr = 0.5) {
  const v = snapshot.timeframes[tf] || {};
  const t = v.technicals || {};
  const px = snapshot.market.lastPrice;
  const atrInd = v.indicators && v.indicators.atr14 && v.indicators.atr14.available ? v.indicators.atr14.value : null;
  const atr = t.atr14 || atrInd || (px ? px * 0.003 : 1);
  const step = Math.max(1e-6, atr * priceStepAtr);
  const lvl = (l) => `${l.rank || l.role}:${Math.round(l.price / step)}:${l.status}`;
  const parts = {
    session: snapshot.market.session,
    halted: !!snapshot.market.halted,
    price: px ? Math.floor(px / step) : null,
    structure: [t.marketStructure, v.structure && v.structure.trend, v.structure && v.structure.emaStack],
    levels: [...(t.supports || []).slice(0, 1), ...(t.resistances || []).slice(0, 1)].map(lvl),
    broken: (t.brokenLevels || []).length,
    signals: (v.signals || []).map((x) => x.id).sort(),
    patterns: (t.recentCandlePatterns || []).filter((p) => p.confirmation === 'CONFIRMED').map((p) => `${p.pattern}@${p.time}`),
    position: snapshot.position ? `${snapshot.position.qty}` : 'flat',
    pending: (snapshot.pendingOrders || []).length,
    risk: [snapshot.risk && snapshot.risk.tradingAllowed, snapshot.risk && (snapshot.risk.blocks || []).length, snapshot.risk && snapshot.risk.profile],
    news: (snapshot.untrusted_external_content.news || []).map((n) => n.news_id).sort(),
  };
  return crypto.createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 20);
}

module.exports = { MODES, MODE_IDS, FORCE_TRIGGERS, effectiveAiCfg, materialStateHash };
