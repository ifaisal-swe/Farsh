'use strict';
/**
 * Risk profiles: one control ("risk level") that sets every related risk-engine limit at once.
 * These are configurable PAPER-TRADING simulation presets, not investment recommendations and
 * not "safe" settings. The deterministic risk engine enforces whichever values are active; the AI
 * cannot override them. Editing any individual limit marks the profile CUSTOM.
 */

const PROFILE_IDS = ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE', 'VERY_AGGRESSIVE'];
const ALL_PROFILE_IDS = [...PROFILE_IDS, 'CUSTOM'];

/** Limits a profile controls (all of them are also individually editable in the advanced settings). */
const PROFILE_KEYS = [
  'maxRiskPerTradePct', 'maxDailyLossPct', 'maxDrawdownPct', 'maxPositionPct', 'minRewardRisk', 'maxOpenPositions',
  'maxStopDistancePct', 'maxConsecutiveLosses', 'lossCooldownMin', 'maxTradesPerDay',
];

const PROFILES = {
  CONSERVATIVE: {
    maxRiskPerTradePct: 0.25, maxDailyLossPct: 1, maxDrawdownPct: 5, maxPositionPct: 10, minRewardRisk: 2.0, maxOpenPositions: 1,
    maxStopDistancePct: 3, maxConsecutiveLosses: 2, lossCooldownMin: 60, maxTradesPerDay: 4,
  },
  BALANCED: {
    maxRiskPerTradePct: 0.5, maxDailyLossPct: 2, maxDrawdownPct: 8, maxPositionPct: 20, minRewardRisk: 1.8, maxOpenPositions: 2,
    maxStopDistancePct: 5, maxConsecutiveLosses: 3, lossCooldownMin: 30, maxTradesPerDay: 8,
  },
  AGGRESSIVE: {
    maxRiskPerTradePct: 1, maxDailyLossPct: 3, maxDrawdownPct: 12, maxPositionPct: 30, minRewardRisk: 1.5, maxOpenPositions: 3,
    maxStopDistancePct: 8, maxConsecutiveLosses: 4, lossCooldownMin: 20, maxTradesPerDay: 12,
  },
  VERY_AGGRESSIVE: {
    maxRiskPerTradePct: 2, maxDailyLossPct: 5, maxDrawdownPct: 20, maxPositionPct: 50, minRewardRisk: 1.2, maxOpenPositions: 4,
    maxStopDistancePct: 12, maxConsecutiveLosses: 5, lossCooldownMin: 15, maxTradesPerDay: 20,
  },
};

/**
 * Effective limits of the engine before risk profiles existed. Used once, when migrating a stored
 * configuration that already had individual risk overrides, so its effective values do not change.
 */
const LEGACY_DEFAULTS = {
  maxRiskPerTradePct: 1, maxDailyLossPct: 3, maxDrawdownPct: 10, maxPositionPct: 25, minRewardRisk: 1.5, maxOpenPositions: 1,
  maxStopDistancePct: 50, maxConsecutiveLosses: 3, lossCooldownMin: 30, maxTradesPerDay: 10,
};

const same = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9;

/** Which preset matches these risk settings exactly (or CUSTOM). */
function detectProfile(risk) {
  if (!risk) return 'CUSTOM';
  for (const id of PROFILE_IDS) {
    if (PROFILE_KEYS.every((k) => same(risk[k], PROFILES[id][k]))) return id;
  }
  return 'CUSTOM';
}

/** Config patch that applies a preset (profile id + all of its limits). */
function profilePatch(id) {
  if (!PROFILES[id]) throw new Error(`Unknown risk profile ${id}`);
  return { risk: { profile: id, ...PROFILES[id] } };
}

/** Minimum number of symbols the risk display assumes; with a watchlist the open-position limit applies to the whole shared portfolio. */
const SYMBOLS_TRADED_AT_ONCE = 1;

module.exports = { PROFILE_IDS, ALL_PROFILE_IDS, PROFILE_KEYS, PROFILES, LEGACY_DEFAULTS, detectProfile, profilePatch, SYMBOLS_TRADED_AT_ONCE };
