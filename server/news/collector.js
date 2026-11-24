'use strict';
const { isCrypto } = require('../market/crypto');
/**
 * News collection: polling, relevance, de-duplication, impact estimation, persistence and
 * breaking-news detection (which may trigger — rate-limited — an extra AI evaluation).
 */
const { EventEmitter } = require('node:events');
const { sha1 } = require('../util/misc');
const src = require('./sources');

const HIGH_IMPACT = /(halt|earnings|guidance|acqui|merger|takeover|offering|\bipo\b|lock-?up|fda|lawsuit|investigation|subpoena|bankrupt|downgrade|upgrade|recall|resign|delist|stock split|dividend|buyback|repurchase|layoff|outage|breach|short seller|8-K|S-1|424B)/i;
const MED_IMPACT = /(analyst|price target|rating|partnership|contract|launch|revenue|sales|customer|deal|funding|valuation|forecast|outlook)/i;

function companyCore(name) {
  if (!name) return null;
  const first = String(name).replace(/[,.]/g, ' ').split(/\s+/).filter(Boolean)[0];
  return first && first.length >= 4 ? first : null;
}

function tokens(t) { return new Set(String(t).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2)); }
function jaccard(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function scoreRelevance(item, symbol, companyName) {
  if (item.macro) return { relevance: 0.5, reason: 'macro / monetary policy (affects all US equities)' };
  if (item.alwaysRelevant) return { relevance: 0.9, reason: 'company investor-relations feed' };
  if (item.sourceType === 'regulatory_filing' || item.sourceType === 'exchange_notice') return { relevance: 1, reason: 'official record for this symbol' };
  const txt = `${item.title} ${item.summary || ''}`;
  if ((item.symbols || []).map((s) => s.toUpperCase()).includes(symbol.toUpperCase())) {
    const core = companyCore(companyName);
    const direct = new RegExp(`\\b${symbol}\\b`).test(txt) || (core && txt.toLowerCase().includes(core.toLowerCase()));
    return { relevance: direct ? 0.95 : 0.7, reason: direct ? 'tagged with the symbol and mentions the company' : 'tagged with the symbol by the provider' };
  }
  const core = companyCore(companyName);
  if (core && txt.toLowerCase().includes(core.toLowerCase())) return { relevance: 0.75, reason: `mentions "${core}"` };
  if (new RegExp(`\\b${symbol}\\b`).test(txt)) return { relevance: 0.6, reason: `mentions ticker ${symbol}` };
  return { relevance: 0.1, reason: 'no direct mention of the company' };
}

function estimateImpact(item) {
  if (item.forceImpact) return item.forceImpact;
  const t = `${item.title} ${item.summary || ''}`;
  if (HIGH_IMPACT.test(t)) return 'HIGH';
  if (MED_IMPACT.test(t)) return 'MEDIUM';
  return 'LOW';
}

class NewsCollector extends EventEmitter {
  constructor({ store, activity, getProvider, getSecrets, getCfg, now = () => Date.now(), fetchImpl }) {
    super();
    this.store = store;
    this.activity = activity;
    this.getProvider = getProvider;
    this.getSecrets = getSecrets;
    this.getCfg = getCfg;
    this.now = now;
    this.fetchImpl = fetchImpl;
    this.symbol = null;
    this.companyName = null;
    this.timers = [];
    this.items = [];
    this.status = {};
    this.lastBreakingAt = 0;
  }

  setSymbol(symbol, companyName) {
    this.symbol = symbol;
    this.companyName = companyName || null;
    this.items = [];
    try { this.items = this.store.listNews(symbol, 80); } catch { /* ignore */ }
  }

  sourceDefs() {
    const cfg = this.getCfg().news;
    const provider = this.getProvider();
    const isLive = provider && provider.mode === 'LIVE';
    const ua = this.getSecrets().get('SEC_USER_AGENT');
    return [
      { name: 'Alpaca News (Benzinga)', key: 'alpaca', everySec: cfg.pollSec.alpaca, enabled: isLive, note: isLive ? '' : 'Requires a live Alpaca connection', run: () => src.alpacaNews(provider, this.symbol) },
      { name: 'SEC EDGAR', key: 'sec', everySec: cfg.pollSec.sec, enabled: !!ua && provider && provider.mode !== 'DEMO', note: ua ? '' : 'Set SEC_USER_AGENT ("Name email") in Settings — required by SEC fair-access policy', run: async () => {
        if (isCrypto(this.symbol)) return []; // no issuer, no filings
        const overrides = (this.getCfg().news.cikOverrides) || {};
        const r = await src.secFilings(this.symbol, ua, { cikOverride: overrides[this.symbol], fetchImpl: this.fetchImpl });
        if (r.note) this.status.sec = { ...(this.status.sec || {}), note: r.note };
        return r.items;
      } },
      { name: 'Federal Reserve press releases', key: 'fed', everySec: cfg.pollSec.fed, enabled: provider && provider.mode !== 'DEMO', run: () => src.fedReleases({ fetchImpl: this.fetchImpl }) },
      { name: 'Nasdaq trade halts', key: 'halts', everySec: cfg.pollSec.halts, enabled: provider && provider.mode === 'LIVE' && !isCrypto(this.symbol), run: () => src.nasdaqHalts(this.symbol, { fetchImpl: this.fetchImpl }) },
      ...(cfg.customFeeds || []).map((f, i) => ({ name: f.name || f.url, key: `rss${i}`, everySec: cfg.pollSec.rss, enabled: provider && provider.mode !== 'DEMO', run: () => src.customRss(f, { fetchImpl: this.fetchImpl }) })),
      { name: 'Reuters / AP', key: 'wires', enabled: false, note: 'Not connected: no public licensed API. Add a licensed RSS/API feed under Custom feeds if you have one.' },
    ];
  }

  start() {
    this.stop();
    for (const s of this.sourceDefs()) {
      this.status[s.key] = { name: s.name, state: s.enabled ? 'idle' : 'disabled', note: s.note || '', lastPoll: null, lastError: null, count: 0 };
      if (!s.enabled || !s.run) continue;
      const tick = () => this.poll(s);
      setTimeout(tick, 500 + this.timers.length * 700);
      const t = setInterval(tick, s.everySec * 1000);
      if (t.unref) t.unref();
      this.timers.push(t);
    }
  }

  stop() { for (const t of this.timers) clearInterval(t); this.timers = []; }

  async poll(s) {
    if (!this.symbol) return;
    const st = this.status[s.key];
    try {
      st.state = 'polling';
      const raw = await s.run();
      const added = this.ingest(raw, s.name);
      st.state = 'ok'; st.lastPoll = this.now(); st.lastError = null; st.count += added.length;
      if (added.length) this.activity.info('NEWS', `${s.name}: ${added.length} new relevant item(s) retrieved`, { source: s.name, details: { titles: added.slice(0, 5).map((a) => a.title) } });
    } catch (e) {
      st.state = 'error'; st.lastError = e.message; st.lastPoll = this.now();
      this.activity.warn(`News source ${s.name} failed: ${e.message}`, { source: s.name });
    }
  }

  ingest(rawItems, sourceName) {
    const added = [];
    const now = this.now();
    for (const r of rawItems || []) {
      if (!r.title) continue;
      if (r.publishedAt && r.publishedAt > now + 5 * 60000) continue; // never accept "future" items (replay safety)
      const id = sha1(r.url ? `${r.url}|${r.title}` : `${r.source}|${r.title}`).slice(0, 20);
      const sym = r.macro ? '*MACRO*' : this.symbol;
      const rel = scoreRelevance(r, this.symbol, this.companyName);
      if (rel.relevance < 0.3) continue;
      if (r.halt) this.emit('halt', r.halt, r);
      if (this.items.some((x) => x.id === id) || (this.store.hasNews && this.store.hasNews(id))) continue;
      const dup = this.items.find((x) => x.symbol === sym && Math.abs((x.publishedAt || 0) - (r.publishedAt || 0)) < 48 * 3600e3 && jaccard(x.title, r.title) >= 0.8);
      const item = {
        id, symbol: sym, source: r.source, sourceType: r.sourceType, title: r.title.slice(0, 300), url: r.url || null, publishedAt: r.publishedAt || null,
        retrievedAt: now, summary: (r.summary || '').slice(0, 500), officialConfirmed: !!r.officialConfirmed, verification: r.verification || 'UNVERIFIED',
        retrievalLevel: r.retrievalLevel || 'headline', relevance: rel.relevance, relevanceReason: rel.reason, marketImpact: estimateImpact(r),
        sentiment: 'UNASSESSED', duplicateOf: dup ? dup.id : null, extra: r.extra || null, via: sourceName,
      };
      try { this.store.upsertNews(item); } catch (e) { this.activity.error(`Database error storing news: ${e.message}`); }
      this.items.unshift(item);
      added.push(item);
      const fresh = item.publishedAt && now - item.publishedAt < 60 * 60000;
      if (!item.duplicateOf && fresh && item.marketImpact === 'HIGH' && item.relevance >= 0.5) {
        const cd = this.getCfg().news.breakingCooldownSec * 1000;
        if (now - this.lastBreakingAt >= cd) { this.lastBreakingAt = now; this.emit('breaking', item); }
      }
    }
    if (added.length) {
      this.items.sort((a, b) => (b.publishedAt || b.retrievedAt) - (a.publishedAt || a.retrievedAt));
      this.items = this.items.slice(0, this.getCfg().news.maxItems);
      this.emit('news', added);
    }
    return added;
  }

  /** News visible as of a point in time (no future leakage in replay). */
  list(limit = 30, asOf = this.now()) {
    return this.items.filter((i) => !i.publishedAt || i.publishedAt <= asOf).slice(0, limit);
  }

  setSentiments(assessments) {
    for (const a of assessments || []) {
      const it = this.items.find((x) => x.id === a.newsId);
      if (it) { it.sentiment = a.impact; it.aiNote = a.note; try { this.store.upsertNews(it); } catch { /* ignore */ } }
    }
  }

  sourcesStatus() { return Object.values(this.status); }
}

module.exports = { NewsCollector, scoreRelevance, estimateImpact, jaccard, companyCore };
