'use strict';
/**
 * Company facts from public pages (read-only, no keys, personal use): statements, estimates, earnings surprises,
 * insider and institutional activity, headlines. Parsers return null for anything missing; nothing is estimated.
 * All fetched text is untrusted data.
 */
const { fetchJson, fetchText } = require('../util/http');
const { parseFeed } = require('../news/sources');

const API = 'https://api.nasdaq.com/api/';
const HEADERS = { 'User-Agent': 'market-data-client/1.0' };
const num = (x) => { const s = String(x == null ? '' : x).trim(); if (!s || /^(--|N\/A)$/i.test(s)) return null; const neg = /^\(.*\)$|^-/.test(s); const n = Number(s.replace(/[$,%()\-\s]/g, '')); return s.replace(/[^0-9]/g, '') && Number.isFinite(n) ? (neg ? -n : n) : null; };
const div = (a, b) => (a != null && b != null && b !== 0 ? a / b : null);
const growth = (a, b) => (a != null && b != null && b > 0 ? a / b - 1 : null);

/** rows of one statement table -> name -> [latest, previous, ...] in dollars (the page reports thousands) */
function table(t) {
  const out = new Map();
  for (const r of (t && t.rows) || []) out.set(String(r.value1 || '').trim().toLowerCase(), ['value2', 'value3', 'value4', 'value5'].map((k) => { const n = num(r[k]); return n == null ? null : n * 1000; }));
  return out;
}

function statements(d) {
  if (!d || !d.incomeStatementTable) return null;
  const I = table(d.incomeStatementTable); const B = table(d.balanceSheetTable); const C = table(d.cashFlowTable);
  const pick = (m, ...names) => { for (const n of names) { if (m.has(n)) return m.get(n); } return [null, null, null, null]; };
  const revenue = pick(I, 'total revenue'); const gross = pick(I, 'gross profit'); const op = pick(I, 'operating income'); const net = pick(I, 'net income', 'net income-cont. operations'); const ebit = pick(I, 'earnings before interest and tax'); const interest = pick(I, 'interest expense');
  const ca = pick(B, 'total current assets'); const ta = pick(B, 'total assets'); const cl = pick(B, 'total current liabilities'); const tl = pick(B, 'total liabilities'); const ltd = pick(B, 'long-term debt'); const std = pick(B, 'short-term debt / current portion of long-term debt'); const eq = pick(B, 'total equity'); const re = pick(B, 'retained earnings'); const cash = pick(B, 'cash and cash equivalents'); const sti = pick(B, 'short-term investments');
  const cfo = pick(C, 'net cash flow-operating'); const capex = pick(C, 'capital expenditures');
  const fcf = cfo.map((x, i) => (x != null && capex[i] != null ? x - Math.abs(capex[i]) : null));
  const debt = ltd.map((x, i) => (x == null && std[i] == null ? null : (x || 0) + (std[i] || 0)));
  if (revenue[0] == null) return null;
  return { period: d.incomeStatementTable.headers && d.incomeStatementTable.headers.value2, revenue, gross, op, net, ebit, interest, ca, ta, cl, tl, ltd, eq, re, cash, sti, cfo, fcf, debt };
}

/** Piotroski: how many of the testable signs of improving health are present. */
function piotroski(s) {
  const t = [];
  const add = (v) => { if (v != null) t.push(v ? 1 : 0); };
  const roa = [0, 1].map((i) => div(s.net[i], s.ta[i]));
  add(roa[0] == null ? null : roa[0] > 0); add(s.cfo[0] == null ? null : s.cfo[0] > 0); add(roa[0] == null || roa[1] == null ? null : roa[0] > roa[1]); add(s.cfo[0] == null || s.net[0] == null ? null : s.cfo[0] > s.net[0]);
  const lev = [0, 1].map((i) => div(s.ltd[i], s.ta[i])); add(lev[0] == null || lev[1] == null ? null : lev[0] <= lev[1]);
  const cr = [0, 1].map((i) => div(s.ca[i], s.cl[i])); add(cr[0] == null || cr[1] == null ? null : cr[0] > cr[1]);
  const gm = [0, 1].map((i) => div(s.gross[i], s.revenue[i])); add(gm[0] == null || gm[1] == null ? null : gm[0] > gm[1]);
  const at = [0, 1].map((i) => div(s.revenue[i], s.ta[i])); add(at[0] == null || at[1] == null ? null : at[0] > at[1]);
  return t.length >= 5 ? { score: t.reduce((a, b) => a + b, 0), of: t.length } : null;
}

function altman(s, cap) {
  const x = [div(s.ca[0] != null && s.cl[0] != null ? s.ca[0] - s.cl[0] : null, s.ta[0]), div(s.re[0], s.ta[0]), div(s.ebit[0] != null ? s.ebit[0] : s.op[0], s.ta[0]), div(cap, s.tl[0]), div(s.revenue[0], s.ta[0])];
  return x.every((v) => v != null) ? 1.2 * x[0] + 1.4 * x[1] + 3.3 * x[2] + 0.6 * x[3] + x[4] : null;
}

/** Yearly cash-flow growth for ten years that today's value already assumes (10% return, 3% afterwards). */
function pricedInGrowth(cap, fcf, { rate = 0.1, end = 0.03, years = 10 } = {}) {
  if (!(cap > 0) || !(fcf > 0)) return null;
  const value = (g) => { let v = 0; let f = fcf; for (let y = 1; y <= years; y++) { f *= 1 + g; v += f / (1 + rate) ** y; } return v + (f * (1 + end)) / (rate - end) / (1 + rate) ** years; };
  let lo = -0.5; let hi = 1.5; if (value(hi) < cap) return null;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (value(m) < cap) lo = m; else hi = m; }
  return (lo + hi) / 2;
}

function health(s, cap) {
  if (!s) return null;
  const d = (a, b, i = 0) => div(a[i], b[i]);
  return { period: s.period, revenue: s.revenue[0], revenueGrowth: growth(s.revenue[0], s.revenue[1]), profitGrowth: growth(s.net[0], s.net[1]), grossMargin: d(s.gross, s.revenue), operatingMargin: d(s.op, s.revenue), netMargin: d(s.net, s.revenue), returnOnEquity: d(s.net, s.eq), freeCash: s.fcf[0], freeCashMargin: d(s.fcf, s.revenue), currentRatio: d(s.ca, s.cl), debtToEquity: d(s.debt, s.eq), interestCover: s.ebit[0] != null && s.interest[0] ? s.ebit[0] / Math.abs(s.interest[0]) : null, pe: s.net[0] > 0 ? div(cap, s.net[0]) : null, cashYield: div(s.fcf[0], cap), piotroski: piotroski(s), altman: altman(s, cap), pricedInGrowth: pricedInGrowth(cap, s.fcf[0]), marketCap: cap || null };
}

const POS = new Set('beat beats beating raise raises raised record surge surges surged soar soars soared jump jumps rally rallies gain gains upgrade upgraded upgrades outperform strong stronger growth profit profits win wins approval approved expand expands partnership buyback dividend rebound rebounds optimistic bullish tops topped exceeds accelerates breakthrough'.split(' '));
const NEG = new Set('miss misses missed cut cuts lower lowers lowered plunge plunges plunged drop drops dropped fall falls fell slump slumps sink sinks tumble tumbles downgrade downgraded downgrades underperform weak weaker loss losses lawsuit sues sued probe investigation fraud recall recalls warning warns layoffs decline declines bearish delay delays delayed ban banned fine fined halt halted bankruptcy resigns selloff fears antitrust subpoena shortage'.split(' '));
/** Word-list sentiment: crude, transparent, and used only with small weight. */
function tone(text) { const w = String(text).toLowerCase().match(/[a-z]+/g) || []; let s = 0; let n = 0; w.forEach((x, i) => { const v = POS.has(x) ? 1 : NEG.has(x) ? -1 : 0; if (!v) return; const not = /^(not|no|never|without)$/.test(w[i - 1] || ''); s += not ? -v : v; n++; }); return n ? s / n : 0; }
function headlines(items, now, names) {
  const seen = []; const out = [];
  for (const it of items) {
    const at = Date.parse(it.pubDate); if (!Number.isFinite(at) || now - at > 10 * 86400000 || at > now + 3600000) continue;
    const words = new Set((it.title.toLowerCase().match(/[a-z0-9]{3,}/g) || [])); if (!words.size || seen.some((s) => { const c = [...words].filter((x) => s.has(x)).length; return c / Math.min(s.size, words.size) > 0.7; })) continue;
    seen.push(words); const about = names.some((n) => n && it.title.toLowerCase().includes(n));
    out.push({ title: it.title.slice(0, 220), url: /^https:\/\//.test(it.link) ? it.link : null, at, about, tone: tone(`${it.title} ${about ? it.description : ''}`) });
  }
  out.sort((a, b) => b.at - a.at);
  const w = out.map((h) => Math.exp(-(now - h.at) / (3 * 86400000)) * (h.about ? 1 : 0.35)); const tot = w.reduce((a, b) => a + b, 0);
  return { items: out.slice(0, 14), count: out.length, tone: tot ? out.reduce((a, h, i) => a + h.tone * w[i], 0) / tot : null };
}

/** Name, sector and industry of one company (or fund), for the activity check. */
async function profile(symbol, { fetchImpl } = {}) {
  const id = encodeURIComponent(symbol);
  const get = async (k, kind) => { const { data } = await fetchJson(`${API}quote/${id}/${k}?assetclass=${kind}`, { headers: HEADERS, timeoutMs: 15000, fetchImpl }); return data && data.data; };
  const info = await get('info', 'stocks');
  if (!info) { const etf = await get('info', 'etf'); return etf ? { name: etf.companyName || symbol, isFund: true } : null; }
  const s = await get('summary', 'stocks');
  const v = (k) => (s && s.summaryData && s.summaryData[k] ? String(s.summaryData[k].value || '').trim() : '');
  return { name: info.companyName || symbol, sector: v('Sector'), industry: v('Industry'), isFund: false };
}

async function gather(symbol, { fetchImpl, now = Date.now } = {}) {
  const gap = () => new Promise((r) => setTimeout(r, 300)); const missing = [];
  const get = async (key, path) => { try { const { data } = await fetchJson(API + path, { headers: HEADERS, timeoutMs: 15000, fetchImpl }); await gap(); return (data && data.data) || null; } catch { missing.push(key); await gap(); return null; } };
  const id = encodeURIComponent(symbol);
  const sum = await get('summary', `quote/${id}/summary?assetclass=stocks`); const fin = await get('statements', `company/${id}/financials?frequency=1`); const est = await get('estimates', `analyst/${id}/earnings-forecast`); const sur = await get('surprises', `company/${id}/earnings-surprise`); const ins = await get('insiders', `company/${id}/insider-trades?limit=5&type=ALL`); const inst = await get('institutions', `company/${id}/institutional-holdings?limit=5`);
  let feed = [];
  try { feed = parseFeed(await fetchText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${id}&region=US&lang=en-US`, { headers: HEADERS, timeoutMs: 15000, fetchImpl })); } catch { missing.push('news'); }
  const S = (sum && sum.summaryData) || {}; const val = (k) => (S[k] ? S[k].value : null); const cap = num(val('MarketCap')); const st = statements(fin);
  const eRow = est && est.quarterlyForecast && est.quarterlyForecast.rows && est.quarterlyForecast.rows[0]; const sRows = (sur && sur.earningsSurpriseTable && sur.earningsSurpriseTable.rows) || [];
  const rowOf = (t, re, key, field) => { const r = ((t && t.rows) || []).find((x) => re.test(String(x[key] || ''))); return r ? num(r[field]) : null; };
  return {
    sector: val('Sector'), industry: val('Industry'), analystTarget: num(val('OneYrTarget')), health: health(st, cap),
    estimates: eRow ? { quarter: eRow.fiscalEnd, eps: num(eRow.consensusEPSForecast), up: num(eRow.up), down: num(eRow.down), analysts: num(eRow.noOfEstimates) } : null,
    surprises: sRows.length ? { count: sRows.length, beats: sRows.filter((r) => num(r.percentageSurprise) > 0).length, average: sRows.reduce((a, r) => a + (num(r.percentageSurprise) || 0), 0) / sRows.length, last: sRows[0].dateReported } : null,
    insiders: ins ? { buys3m: rowOf(ins.numberOfTrades, /buys/i, 'insiderTrade', 'months3'), sells3m: rowOf(ins.numberOfTrades, /sells/i, 'insiderTrade', 'months3'), net3m: rowOf(ins.numberOfSharesTraded, /net/i, 'insiderTrade', 'months3') } : null,
    institutions: inst ? { share: num(inst.ownershipSummary && inst.ownershipSummary.SharesOutstandingPCT && inst.ownershipSummary.SharesOutstandingPCT.value), increased: rowOf(inst.activePositions, /increased/i, 'positions', 'shares'), decreased: rowOf(inst.activePositions, /decreased/i, 'positions', 'shares') } : null,
    news: headlines(feed, now(), [symbol.toLowerCase(), String((sum && sum.companyName) || '').toLowerCase().split(' ')[0]].filter((x) => x && x.length > 1)), missing,
  };
}

module.exports = { gather, profile, statements, health, piotroski, altman, pricedInGrowth, tone, headlines, num };
