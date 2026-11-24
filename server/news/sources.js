'use strict';
/**
 * News sources. Each returns normalized raw items:
 *   { source, sourceType, title, url, publishedAt(ms), summary, symbols?, officialConfirmed, verification, retrievalLevel, extra }
 * All fetched text is UNTRUSTED external content.
 *
 * Implemented (legally & technically accessible without scraping):
 *   - Alpaca News API (Benzinga newswire) — needs Alpaca keys
 *   - SEC EDGAR submissions JSON — needs a descriptive User-Agent (SEC fair-access policy)
 *   - Federal Reserve press releases RSS (official)
 *   - Nasdaq Trader trade-halt RSS (official exchange notices)
 *   - User-configured RSS feeds (e.g. a company's investor-relations feed)
 * Not implemented: Reuters / AP — no public, licensed feed is available without a commercial agreement.
 */
const { XMLParser } = require('fast-xml-parser');
const { fetchJson, fetchText } = require('../util/http');
const { etWallToUtcMs } = require('../util/time');

const UA = 'ai-trading-terminal/1.0 (local paper-trading research tool)';
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, trimValues: true, parseTagValue: false });
const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const text = (x) => (x == null ? '' : typeof x === 'object' ? (x['#text'] || '') : String(x));
const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function parseFeed(xml) {
  const doc = parser.parse(xml);
  if (doc.rss && doc.rss.channel) {
    return asArray(doc.rss.channel.item).map((it) => ({
      title: stripHtml(text(it.title)), link: text(it.link), description: stripHtml(text(it.description)), pubDate: text(it.pubDate),
      category: text(it.category), guid: text(it.guid), raw: it,
    }));
  }
  if (doc.feed) {
    return asArray(doc.feed.entry).map((e) => ({
      title: stripHtml(text(e.title)), link: (asArray(e.link).find((l) => l['@_href']) || {})['@_href'] || '',
      description: stripHtml(text(e.summary || e.content)), pubDate: text(e.updated || e.published), raw: e,
    }));
  }
  return [];
}

async function alpacaNews(provider, symbol, { limit = 20 } = {}) {
  const rows = await provider.fetchNews(symbol, { limit });
  return rows.map((n) => ({
    source: n.source ? `${n.source} (via Alpaca)` : 'Alpaca News', sourceType: 'news_wire', title: stripHtml(n.headline), url: n.url || null,
    publishedAt: Date.parse(n.created_at), updatedAt: Date.parse(n.updated_at), summary: stripHtml(n.summary).slice(0, 500), symbols: n.symbols || [],
    officialConfirmed: false, verification: 'MEDIA REPORT', retrievalLevel: n.summary ? 'headline+summary' : 'headline', extra: { author: n.author, alpacaId: n.id },
  }));
}

let tickerMap = null;
let tickerMapAt = 0;
async function secCik(symbol, ua, fetchImpl) {
  if (!tickerMap || Date.now() - tickerMapAt > 12 * 3600e3) {
    const { data } = await fetchJson('https://www.sec.gov/files/company_tickers.json', { headers: { 'User-Agent': ua }, timeoutMs: 20000, fetchImpl });
    tickerMap = new Map(Object.values(data || {}).map((r) => [String(r.ticker).toUpperCase(), { cik: r.cik_str, title: r.title }]));
    tickerMapAt = Date.now();
  }
  return tickerMap.get(symbol.toUpperCase()) || null;
}

const SEC_HIGH = /^(8-K|S-1|S-1\/A|424B\d|10-Q|10-K|6-K|20-F|SC 13D|SC 13G|DEF 14A|S-3|F-1)/i;
async function secFilings(symbol, ua, { cikOverride, fetchImpl } = {}) {
  let cik = cikOverride;
  let company = null;
  if (!cik) {
    const hit = await secCik(symbol, ua, fetchImpl);
    if (!hit) return { items: [], note: `${symbol} not yet in SEC company_tickers.json (newly listed companies can take days to appear). Set a CIK override in Settings.` };
    cik = hit.cik; company = hit.title;
  }
  const padded = String(cik).padStart(10, '0');
  const { data } = await fetchJson(`https://data.sec.gov/submissions/CIK${padded}.json`, { headers: { 'User-Agent': ua }, timeoutMs: 20000, fetchImpl });
  const r = data && data.filings && data.filings.recent;
  if (!r) return { items: [], note: 'No recent filings' };
  const items = [];
  for (let i = 0; i < Math.min(20, r.form.length); i++) {
    const acc = String(r.accessionNumber[i]);
    const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${r.primaryDocument[i]}`;
    const form = r.form[i];
    items.push({
      source: 'SEC EDGAR', sourceType: 'regulatory_filing', title: `${data.name || company || symbol}: Form ${form} filed ${r.filingDate[i]}${r.primaryDocDescription && r.primaryDocDescription[i] ? ` — ${r.primaryDocDescription[i]}` : ''}`,
      url, publishedAt: Date.parse(r.acceptanceDateTime[i]) || Date.parse(r.filingDate[i]), summary: `Official SEC filing (form ${form}). Only filing metadata was retrieved, not the document text.`,
      symbols: [symbol], officialConfirmed: true, verification: 'OFFICIAL FILING', retrievalLevel: 'filing metadata', forceImpact: SEC_HIGH.test(form) ? 'HIGH' : (form === '4' ? 'MEDIUM' : 'LOW'),
      extra: { form, cik: Number(cik) },
    });
  }
  return { items, company: data.name || company };
}

const FED_POLICY = /(FOMC|monetary policy|federal funds|interest rate|discount rate|minutes of the federal open market|policy statement|balance sheet)/i;
async function fedReleases({ fetchImpl } = {}) {
  const xml = await fetchText('https://www.federalreserve.gov/feeds/press_all.xml', { headers: { 'User-Agent': UA }, fetchImpl });
  return parseFeed(xml)
    .filter((it) => FED_POLICY.test(`${it.title} ${it.category}`))
    .slice(0, 10)
    .map((it) => ({
      source: 'Federal Reserve Board', sourceType: 'central_bank', title: it.title, url: it.link, publishedAt: Date.parse(it.pubDate),
      summary: it.description.slice(0, 300), symbols: ['*MACRO*'], officialConfirmed: true, verification: 'OFFICIAL RELEASE', retrievalLevel: 'headline',
      forceImpact: /FOMC statement|federal funds|policy statement/i.test(it.title) ? 'HIGH' : 'MEDIUM', macro: true,
    }));
}

function parseEtDateTime(dateStr, timeStr) {
  // Nasdaq: "11/19/2026", "15:00:40.413" (Eastern Time)
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(dateStr || '').trim());
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(timeStr || '').trim());
  if (!m || !t) return null;
  return etWallToUtcMs(`${m[3]}-${m[1]}-${m[2]}`, Number(t[1]), Number(t[2])) + Number(t[3] || 0) * 1000;
}

async function nasdaqHalts(symbol, { fetchImpl } = {}) {
  const xml = await fetchText('https://www.nasdaqtrader.com/rss.aspx?feed=tradehalts', { headers: { 'User-Agent': UA }, fetchImpl });
  const items = parseFeed(xml).filter((it) => String(text(it.raw.IssueSymbol) || it.title).toUpperCase() === symbol.toUpperCase());
  const now = Date.now();
  return items.map((it) => {
    const r = it.raw;
    const haltAt = parseEtDateTime(text(r.HaltDate), text(r.HaltTime));
    const resumeTrade = parseEtDateTime(text(r.ResumptionDate), text(r.ResumptionTradeTime));
    const active = !resumeTrade || resumeTrade > now;
    const reason = text(r.ReasonCode);
    return {
      source: 'Nasdaq Trader (trade halts)', sourceType: 'exchange_notice',
      title: `Trading halt ${symbol} (${reason || 'reason n/a'}) at ${text(r.HaltTime)} ET${resumeTrade ? `; trading resumes ${text(r.ResumptionTradeTime)} ET` : '; no resumption time yet'}`,
      url: 'https://www.nasdaqtrader.com/trader.aspx?id=TradeHalts', publishedAt: haltAt, summary: `${text(r.IssueName)} — market ${text(r.Market)}, reason code ${reason}`,
      symbols: [symbol], officialConfirmed: true, verification: 'OFFICIAL EXCHANGE NOTICE', retrievalLevel: 'full notice', forceImpact: 'HIGH',
      halt: { active, haltAt, resumeTrade, reasonCode: reason },
    };
  });
}

async function customRss(feed, { fetchImpl } = {}) {
  const xml = await fetchText(feed.url, { headers: { 'User-Agent': UA }, fetchImpl });
  return parseFeed(xml).slice(0, 25).map((it) => ({
    source: feed.name || new URL(feed.url).hostname, sourceType: feed.official ? 'company_ir' : 'custom_rss', title: it.title, url: it.link,
    publishedAt: Date.parse(it.pubDate) || null, summary: it.description.slice(0, 400), officialConfirmed: !!feed.official,
    verification: feed.official ? 'OFFICIAL (user-designated IR feed)' : 'UNVERIFIED SOURCE', retrievalLevel: it.description ? 'headline+summary' : 'headline',
    alwaysRelevant: !!feed.official,
  }));
}

module.exports = { alpacaNews, secFilings, fedReleases, nasdaqHalts, customRss, parseFeed, parseEtDateTime, stripHtml };
