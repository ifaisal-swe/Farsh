'use strict';
const { tempStore } = require('./helpers/db');
/**
 * Arabic interface coverage: real engine scenarios produce activity-log messages (server stays in English);
 * every one of them must be translated by the browser's message catalog. Also checks dictionary parity.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { Store } = require('../server/db');
const { ConfigManager } = require('../server/config');
const { SecretStore } = require('../server/secrets');
const { ActivityLog } = require('../server/activity');
const { TradingAgent } = require('../server/engine/agent');
const { Redactor } = require('../server/util/misc');
const { LEGACY_DEFAULTS } = require('../server/trading/riskProfiles');
const { T0, FakeProvider, ScriptedDecider, buyProposal, silentFetch } = require('./helpers/fixtures');

function loadCatalog(lang = 'ar') {
  const store = new Map([['terminal.lang', lang]]);
  const ctx = {
    localStorage: { getItem: (k) => store.get(k) || null, setItem: (k, v) => store.set(k, v) },
    document: { documentElement: {}, querySelectorAll: () => [], title: '' },
    console,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const f of ['i18n.js', 'i18n-messages.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'js', f), 'utf8'), ctx);
  return ctx;
}

function makeAgent() {
  const store = tempStore();
  const clock = { t: T0, now() { return this.t; } };
  const redactor = new Redactor();
  const secrets = new SecretStore({ store, dataDir: null, env: { DEEPSEEK_API_KEY: 'sk-test-not-real-0000', TERMINAL_MASTER_KEY: 'a'.repeat(64) }, redactor });
  const config = new ConfigManager(store, { news: { pollSec: { alpaca: 9999, sec: 9999, fed: 9999, halts: 9999, rss: 9999 } } });
  config.update({ risk: { ...LEGACY_DEFAULTS, profile: 'CUSTOM' } });
  let agent;
  const activity = new ActivityLog({ store, redactor, getSessionId: () => (agent && agent.session ? agent.session.id : null) });
  const provider = new FakeProvider({ clock });
  const decider = new ScriptedDecider();
  agent = new TradingAgent({ store, config, secrets, activity, now: () => clock.now(), providerFactory: () => provider, fetchImpl: silentFetch, autoTimers: false, deciderOverride: decider });
  agent.news.start = () => {};
  agent.scheduler.run = async () => ({ skipped: true });
  return { agent, store, clock, provider, decider, activity, config };
}

test('every activity message from real engine flows is translated to Arabic', async () => {
  const ctx = makeAgent();
  const { agent, decider, provider, clock } = ctx;
  await agent.startTrading({ symbol: 'TEST', initialCapital: 10000, targetCapital: 20000 });
  provider.quote(99.98, 100.02); provider.trade(100);
  decider.push((s) => buyProposal(s));
  await agent.runAnalysis({ reasons: [{ type: 'MANUAL', detail: 'user requested analysis' }] });
  decider.push((s) => ({ snapshot_id: s.id, action: 'WAIT', confidence: 40, rationale: 'x' }));
  clock.t += 30000; provider.quote(99.98, 100.02);
  await agent.runAnalysis({ reasons: [{ type: 'MANUAL' }] });
  agent.setRiskProfile('AGGRESSIVE');
  agent.setRiskProfile('CONSERVATIVE');
  agent.reducePosition(1);
  agent.pause(); agent.resume(); agent.stop();
  clock.t += 5000; provider.quote(98.5, 98.6); provider.trade(98.55); // stop-loss
  agent.tick();
  agent.changeCapital({ initialCapital: 10000, targetCapital: 30000 });
  ctx.config.update({ ui: { language: 'en' } });
  ctx.config.update({ risk: { maxSpreadPct: 0.4 } });
  const msgs = [...new Set(ctx.store.listActivity(agent.session.id, 5000).map((e) => e.message))];
  assert.ok(msgs.length > 25, `scenario produced ${msgs.length} messages`);
  const w = loadCatalog('ar');
  const missing = msgs.filter((m) => !w.MSG.msg(m).translated);
  assert.deepEqual(missing, [], 'untranslated activity messages');
  // translated text must actually be Arabic and keep numbers/tickers
  const sample = w.MSG.msg('PAPER BUY executed: 24 TEST @ 100.0400 (ask 100.0200, spread 0.0400, slippage $0.0200, fees $0.00)').text;
  assert.match(sample, /[؀-ۿ]/);
  assert.match(sample, /100\.0400/);
  assert.match(sample, /TEST/);
});

test('dictionary: every key has Arabic and English text; English mode leaves server text unchanged', () => {
  const w = loadCatalog('en');
  assert.equal(w.MSG.msg('AI RESUMED').text, 'AI RESUMED');
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'i18n.js'), 'utf8');
  const entries = [...src.matchAll(/^\s+(\w+): \['([^']*)', '([^']*)'\]/gm)];
  assert.ok(entries.length > 300, `${entries.length} dictionary entries`);
  for (const [, k, ar, en] of entries) {
    assert.ok(ar.trim() && en.trim(), `empty translation for ${k}`);
  }
  // every data-i18n key used in the page exists
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-title|-ph|-html)?="([^"]+)"/g)].map((m) => m[1]);
  const wa = loadCatalog('ar');
  for (const k of keys) assert.notEqual(wa.I18N.T(k), k, `missing dictionary key ${k}`);
});
