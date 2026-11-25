'use strict';
/**
 * Configuration: config/default.json + validated user overrides persisted in PostgreSQL.
 * Every user-editable value is type-checked and bounded ("allowed simulation settings").
 */
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { TF_KEYS } = require('./util/time');
const { ALL_PROFILE_IDS, PROFILE_KEYS, LEGACY_DEFAULTS, detectProfile } = require('./trading/riskProfiles');
const { MODE_IDS } = require('./ai/costControl');

const DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'default.json'), 'utf8'));

const BOUNDS = {
  'risk.maxRiskPerTradePct': [0.05, 5], 'risk.maxDailyLossPct': [0.5, 20], 'risk.maxDrawdownPct': [1, 50],
  'risk.maxPositionPct': [1, 100], 'risk.maxSectorPct': [10, 100], 'risk.maxAlikePct': [10, 100], 'risk.maxConsecutiveLosses': [1, 20], 'risk.lossCooldownMin': [0, 1440],
  'risk.maxOpenPositions': [1, 4], 'risk.maxSpreadPct': [0.01, 5], 'risk.maxSlippagePct': [0.01, 5],
  'risk.minRewardRisk': [0.5, 10], 'risk.maxTradesPerDay': [1, 200], 'risk.minStopDistancePct': [0, 10],
  'risk.maxStopDistancePct': [0.5, 50],
  'risk.minStopDistanceSpreads': [0, 20], 'risk.ipoMode.newListingSessions': [1, 60],
  'risk.ipoMode.minMinutesAfterFirstTrade': [0, 390], 'risk.ipoMode.maxSpreadPct': [0.01, 5],
  'risk.ipoMode.allocationFactor': [0.05, 1], 'risk.ipoMode.maxAtrPct': [0.1, 50],
  'ai.regularIntervalSec': [30, 7200], 'ai.minIntervalSec': [5, 3600], 'ai.maxRequestsPerMinute': [1, 60],
  'ai.dailyBudgetUsd': [0, 500], 'ai.maxOutputTokens': [500, 128000], 'ai.requestTimeoutSec': [10, 900],
  'ai.proposalMaxAgeSec': [5, 900], 'ai.maxPriceDriftPct': [0.01, 10], 'ai.nearLevelPct': [1, 90],
  'ai.webResearch.intervalMin': [5, 1440], 'ai.webResearch.maxOutputTokens': [500, 32000],
  'execution.slippageBps': [0, 200], 'execution.impactPerTierBps': [0, 200], 'execution.defaultTierSize': [1, 100000],
  'execution.commissionPerShare': [0, 1], 'execution.commissionPerOrder': [0, 50], 'execution.secFeeRate': [0, 0.001],
  'execution.finraTafPerShare': [0, 0.01], 'execution.finraTafMax': [0, 100], 'execution.pendingLimitExpiryMin': [1, 390],
  'market.maxQuoteAgeMs': [1000, 600000], 'market.maxExchangeLagMs': [1000, 3600000], 'market.historyBars': [100, 10000],
  'news.breakingCooldownSec': [30, 86400], 'session.equitySampleSec': [5, 3600],
  'ai.maxRequestsPerDay': [0, 5000], 'ai.maxRequestsPerSymbolPerHour': [0, 120], 'ai.monthlyBudgetUsd': [0, 10000],
  'market.maxSymbols': [1, 30], 'market.overnight.pollSec': [15, 3600], 'tiingo.pollSec': [30, 3600], 'telegram.reports.weeklyDay': [0, 6],
  'ai.deepseekDailyBudgetUsd': [0, 500], 'ai.geminiDailyBudgetUsd': [0, 500], 'ai.circuitBreaker.failures': [1, 20], 'ai.circuitBreaker.cooldownMin': [1, 120],
  'ai.circuitBreaker.maxCooldownMin': [5, 1440],
  'adaptiveMonitoring.preMarketMin': [0, 120], 'adaptiveMonitoring.openingMin': [5, 120], 'adaptiveMonitoring.postOpenMin': [0, 180], 'adaptiveMonitoring.closingMin': [5, 120],
  'adaptiveMonitoring.noNewEntriesLastMin': [0, 60], 'adaptiveMonitoring.volatility.enterRatio': [1.2, 10], 'adaptiveMonitoring.volatility.exitRatio': [1, 9],
  'adaptiveMonitoring.volatility.confirmBars': [1, 10], 'adaptiveMonitoring.volatility.exitBars': [1, 30], 'adaptiveMonitoring.volatility.minActiveMin': [1, 60],
  'adaptiveMonitoring.volatility.cooldownMin': [0, 120], 'adaptiveMonitoring.volatility.openingFactor': [1, 5], 'adaptiveMonitoring.volatility.marketMovePct': [0.1, 5],
  'adaptiveMonitoring.events.confirmBars': [1, 10], 'adaptiveMonitoring.events.volumeConfirm': [1, 10], 'adaptiveMonitoring.events.volumeSpike': [1.5, 20],
  'adaptiveMonitoring.events.moveZ': [1.5, 10], 'adaptiveMonitoring.events.breakoutBufferAtr': [0, 2], 'adaptiveMonitoring.events.gapAtr': [0.1, 5], 'adaptiveMonitoring.events.ttlSec': [60, 1800],
  'adaptiveMonitoring.ai.minScore': [0, 100], 'adaptiveMonitoring.ai.highPriorityScore': [0, 100], 'adaptiveMonitoring.ai.symbolCooldownSec': [30, 3600],
  'adaptiveMonitoring.ai.maxPerSymbolPerDay': [0, 200], 'adaptiveMonitoring.ai.maxPerDay': [0, 1000], 'adaptiveMonitoring.ai.maxQueued': [1, 10],
  'adaptiveMonitoring.ai.reserveSymbolRequests': [0, 10], 'adaptiveMonitoring.ai.budgetReservePct': [0, 90],
  'execution.nearTargetPct': [0, 0.5], 'sharia.maxDebtPct': [1, 33.34], 'sharia.maxDepositsPct': [1, 33.34], 'sharia.maxIncomePct': [0.1, 5], 'sharia.resultValidDays': [1, 30],
  'sharia.rulingValidDays': [1, 400], 'sharia.maxBalanceAgeDays': [90, 400], 'sharia.maxIncomeAgeDays': [365, 800],
  'retention.activityDays': [7, 3650], 'retention.eventsDays': [1, 3650], 'retention.snapshotsDays': [1, 3650],
};
const ENUMS = {
  'ai.reasoningEffort': ['none', 'low', 'high', 'max'],
  'ai.autonomy': ['FULL', 'SEMI', 'ADVISORY'],
  'ai.analysisTimeframe': TF_KEYS.filter((t) => t !== '1d'),
  'market.feed': ['iex', 'sip', 'delayed_sip'],
  'sharia.mode': ['FULL', 'BUSINESS'],
  'market.adjustment': ['raw', 'split', 'all'],
  'market.quoteSizeUnit': ['shares', 'round_lots'],
  'risk.ipoMode.enabled': ['auto', 'on', 'off'],
  'risk.profile': ALL_PROFILE_IDS,
  'ui.language': ['ar', 'en'],
  'ai.usageMode': MODE_IDS,
  'ai.provider': ['deepseek', 'gemini'],
  'ai.mode': ['DEEPSEEK', 'GEMINI', 'AUTO', 'DUAL'],
  'ai.dualScope': ['IMPORTANT', 'ALL'],
  'market.overnight.provider': ['auto', 'alpaca', 'tiingo', 'none'],
  'market.overnight.alpacaFeed': ['overnight', 'boats'],
};
const STRINGS = {
  'ai.model': /^[a-z0-9][a-z0-9.\-_]{1,63}$/i, 'ai.webResearch.model': /^[a-z0-9][a-z0-9.\-_]{1,63}$/i, 'ai.gemini.model': /^[a-z0-9][a-z0-9.\-_]{1,63}$/i,
  // credentials may only ever be sent to the official hosts
  'ai.gemini.baseUrl': /^https:\/\/generativelanguage\.googleapis\.com$/, 'tiingo.baseUrl': /^https:\/\/api\.tiingo\.com$/,
  'telegram.reports.time': /^([01]\d|2[0-3]):[0-5]\d$/,
};
const ID_LISTS = ['telegram.authorizedChatIds', 'telegram.authorizedUserIds'];
const EDITABLE_PREFIXES = ['risk.', 'ai.', 'execution.', 'market.feed', 'market.adjustment', 'market.maxQuoteAgeMs', 'market.maxExchangeLagMs',
  'market.quoteSizeUnit', 'market.historyBars', 'market.maxSymbols', 'market.overnight.', 'news.', 'session.', 'ui.', 'tiingo.', 'telegram.', 'retention.', 'adaptiveMonitoring.', 'sharia.'];
const validTimezone = (tz) => { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } };

function deepMerge(a, b) {
  if (Array.isArray(b) || typeof b !== 'object' || b === null) return b;
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b)) out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(out[k], v) : v;
  return out;
}

function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj || {})) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, p, out); else out[p] = v;
  }
  return out;
}

function getPath(obj, p) { return p.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj); }

function validatePatch(patch) {
  const flat = flatten(patch);
  const errors = [];
  const defaultsFlat = flatten(DEFAULTS);
  for (const [p, v] of Object.entries(flat)) {
    if (p.includes('_comment')) continue;
    if (p.startsWith('news.cikOverrides.')) {
      if (!/^news\.cikOverrides\.[A-Z.]{1,10}$/.test(p) || !(v === null || /^\d{1,10}$/.test(String(v)))) errors.push(`${p} must be a ticker mapped to a numeric CIK`);
      continue;
    }
    if (!EDITABLE_PREFIXES.some((e) => p.startsWith(e))) { errors.push(`${p} is not editable`); continue; }
    if (!(p in defaultsFlat) && p !== 'news.customFeeds') { errors.push(`${p} is not a known setting`); continue; }
    const def = defaultsFlat[p];
    if (ID_LISTS.includes(p)) {
      if (!Array.isArray(v) || v.length > 20 || !v.every((x) => /^-?\d{1,20}$/.test(String(x)))) errors.push(`${p} must be a list of numeric Telegram ids`);
      continue;
    }
    if (p === 'telegram.reports.timezone') {
      if (typeof v !== 'string' || !validTimezone(v)) errors.push(`${p} must be an IANA timezone such as Asia/Riyadh`);
      continue;
    }
    if (BOUNDS[p]) {
      if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${p} must be a number`); continue; }
      const [lo, hi] = BOUNDS[p];
      if (v < lo || v > hi) errors.push(`${p} must be between ${lo} and ${hi}`);
    } else if (ENUMS[p]) {
      if (!ENUMS[p].includes(v)) errors.push(`${p} must be one of ${ENUMS[p].join(', ')}`);
    } else if (STRINGS[p]) {
      if (typeof v !== 'string' || !STRINGS[p].test(v)) errors.push(`${p} has an invalid format`);
    } else if (typeof def === 'boolean') {
      if (typeof v !== 'boolean') errors.push(`${p} must be true/false`);
    } else if (p === 'news.customFeeds') {
      if (!Array.isArray(v) || v.length > 20) errors.push('news.customFeeds must be a list of up to 20 feeds');
      else for (const f of v) {
        try { const u = new URL(f.url); if (!/^https?:$/.test(u.protocol)) throw new Error(); } catch { errors.push(`Invalid feed URL ${f && f.url}`); }
      }
    } else if (typeof def === 'number') {
      if (typeof v !== 'number' || !Number.isFinite(v)) errors.push(`${p} must be a number`);
    } else if (typeof def !== typeof v) {
      errors.push(`${p} has the wrong type`);
    }
  }
  // cross-field sanity
  const merged = deepMerge(DEFAULTS, patch);
  if (getPath(merged, 'ai.minIntervalSec') > getPath(merged, 'ai.regularIntervalSec')) errors.push('ai.minIntervalSec cannot exceed ai.regularIntervalSec');
  return errors;
}

/**
 * A stored configuration from before risk profiles existed keeps its EFFECTIVE limits: the old defaults
 * are pinned for every profile-controlled limit it did not override, and the profile becomes CUSTOM
 * unless the result happens to equal a preset. A configuration without risk overrides uses the
 * default profile from config/default.json.
 */
function migrateUserConfig(userIn) {
  let user = userIn;
  let aiMigrated = false;
  // an explicit provider chosen before AI modes existed is kept as the matching single-provider mode
  if (user && user.ai && user.ai.provider && !user.ai.mode) { user = { ...user, ai: { ...user.ai, mode: user.ai.provider === 'gemini' ? 'GEMINI' : 'DEEPSEEK' } }; aiMigrated = true; }
  const res = migrateRisk(user);
  return { user: res.user, migrated: res.migrated || aiMigrated };
}

function migrateRisk(user) {
  const r = user && user.risk;
  if (!r || r.profile) return { user, migrated: false };
  if (!PROFILE_KEYS.some((k) => k in r)) return { user, migrated: false };
  const risk = { ...r };
  for (const k of PROFILE_KEYS) if (!(k in risk)) risk[k] = LEGACY_DEFAULTS[k];
  risk.profile = detectProfile(risk);
  return { user: { ...user, risk }, migrated: true };
}

class ConfigManager extends EventEmitter {
  constructor(store, overrides = {}) {
    super();
    this.store = store;
    const stored = (store && store.getSetting('config', {})) || {};
    const { user, migrated } = migrateUserConfig(stored);
    this.user = user;
    if (migrated && this.store) this.store.setSetting('config', this.user);
    this.runtime = overrides;
    this.current = deepMerge(deepMerge(DEFAULTS, this.user), overrides);
  }
  get() { return this.current; }
  update(patchIn) {
    const errors = validatePatch(patchIn);
    if (errors.length) { const e = new Error(errors.join('; ')); e.validation = errors; throw e; }
    let patch = patchIn;
    // Editing an individual profile-controlled limit (without choosing a profile) re-derives the profile:
    // it becomes CUSTOM unless the edited values happen to equal a preset exactly.
    if (patch.risk && !('profile' in patch.risk) && PROFILE_KEYS.some((k) => k in patch.risk)) {
      const mergedRisk = deepMerge(this.current.risk, patch.risk);
      patch = { ...patch, risk: { ...patch.risk, profile: detectProfile(mergedRisk) } };
    }
    this.user = deepMerge(this.user, patch);
    if (this.store) this.store.setSetting('config', this.user);
    this.current = deepMerge(deepMerge(DEFAULTS, this.user), this.runtime);
    this.emit('change', this.current, patch);
    return this.current;
  }
  editableSchema() { return { bounds: BOUNDS, enums: ENUMS }; }
}

module.exports = { ConfigManager, DEFAULTS, deepMerge, validatePatch, flatten, migrateUserConfig };
