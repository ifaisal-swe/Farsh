'use strict';
/** What the assistant may know about the companies a question is about: facts, results and dated headlines. */
const NAMES = { NVDA: 'nvidia|انفيديا|إنفيديا|نفيديا', AAPL: 'apple|ابل|آبل|أبل', TSLA: 'tesla|تسلا|تيسلا', MSFT: 'microsoft|مايكروسوفت', AMZN: 'amazon|امازون|أمازون', GOOGL: 'google|alphabet|قوقل|جوجل', META: 'meta|facebook|ميتا|فيسبوك', AMD: 'amd', NFLX: 'netflix|نتفلكس|نتفليكس', INTC: 'intel|انتل|إنتل', PLTR: 'palantir|بالانتير', AVGO: 'broadcom|برودكوم' };
const NOT = new Set(['AI', 'CEO', 'CFO', 'ETF', 'IPO', 'USA', 'US', 'USD', 'EPS', 'GDP', 'FED', 'SEC', 'OK', 'I', 'A']);
const MAX = 3;

/** Symbols a question is about; the followed ones when it names none. */
function subjects(text, followed = []) {
  const out = new Set(); const t = String(text || '').toLowerCase();
  for (const [s, re] of Object.entries(NAMES)) if (new RegExp(`(^|[^\\p{L}])(${re})($|[^\\p{L}])`, 'u').test(t)) out.add(s);
  for (const m of String(text || '').match(/\$?\b[A-Z]{1,5}\b/g) || []) { const s = m.replace('$', ''); if ((m[0] === '$' || s.length > 1) && !NOT.has(s)) out.add(s); }
  for (const s of followed) if (t.includes(String(s).toLowerCase())) out.add(s);
  return (out.size ? [...out] : followed).slice(0, MAX);
}

const ms = (x) => (typeof x === 'number' ? x : Date.parse(x));

class CompanyResearch {
  /** gather(symbol): public facts or null. feed(symbol): market-data headlines. saved(symbol): stored headlines. */
  constructor({ gather, feed, saved, isCrypto = () => false, now = Date.now, waitMs = 12000 }) { Object.assign(this, { gather, feed, saved, isCrypto, now, waitMs }); this.cache = new Map(); }

  async of(symbol) {
    const hit = this.cache.get(symbol);
    if (hit && this.now() - hit.at < 600000) return hit.value;
    const quiet = (fn) => Promise.race([Promise.resolve().then(fn).catch(() => null), new Promise((r) => { setTimeout(() => r(null), this.waitMs).unref(); })]);
    const [f, live] = await Promise.all([this.isCrypto(symbol) ? null : quiet(() => this.gather(symbol)), quiet(() => this.feed(symbol))]);
    let saved = []; try { saved = this.saved(symbol) || []; } catch { saved = []; }
    const seen = new Set(); const news = [];
    const add = (title, at, source, summary) => { const k = String(title || '').toLowerCase().replace(/\W+/g, ' ').trim().slice(0, 80); const t = ms(at); if (!k || seen.has(k) || !Number.isFinite(t) || this.now() - t > 30 * 86400000) return; seen.add(k); news.push({ date: new Date(t).toISOString().slice(0, 16).replace('T', ' '), quoted: String(title).slice(0, 220), source: source || null, summary: String(summary || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) || undefined }); };
    for (const n of live || []) add(n.headline, n.created_at, n.source, n.summary);
    for (const n of (f && f.news && f.news.items) || []) add(n.title, n.at, 'Yahoo', null);
    for (const n of saved) add(n.title, n.publishedAt || n.retrievedAt, n.source, n.summary);
    news.sort((a, b) => (a.date < b.date ? 1 : -1));
    const h = f && f.health;
    const value = { symbol, company: f ? { sector: f.sector, industry: f.industry, analystsTargetPrice: f.analystTarget, financials: h || null, nextQuarter: f.estimates, pastResults: f.surprises, insiders: f.insiders && { buysLast3Months: f.insiders.buys3m, salesLast3Months: f.insiders.sells3m }, institutions: f.institutions } : null, news: news.slice(0, 15) };
    if (value.company || news.length) this.cache.set(symbol, { at: this.now(), value });
    return value;
  }

  async about(text, followed) { const list = subjects(text, followed); return Object.fromEntries((await Promise.all(list.map((s) => this.of(s)))).map((x) => [x.symbol, x])); }
}

module.exports = { CompanyResearch, subjects };
