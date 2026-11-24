'use strict';
const { temp } = require('./helpers/db');
const test = require('node:test');
const assert = require('node:assert/strict');
const { ShariaService, evaluate } = require('../server/sharia/screener');
const { RiskManager } = require('../server/trading/risk');
const { DEFAULTS } = require('../server/config');
const { renderEvent } = require('../server/telegram/notifier');
const { createTerminal } = require('../server/app');

const NOW = Date.parse('2026-11-23T15:00:00Z');
const cfg = DEFAULTS.sharia;
const point = (val, end = '2026-09-30') => ({ units: { USD: [{ val, end, filed: '2026-11-01', form: '10-Q' }] } });
const year = (val) => ({ units: { USD: [{ val, start: '2025-01-01', end: '2025-12-31', filed: '2026-02-01', form: '10-K' }] } });
const facts = (o = {}) => ({ 'us-gaap': { Assets: point(1000), LongTermDebt: point(100), CashAndCashEquivalentsAtCarryingValue: point(200), Revenues: year(1000), InvestmentIncomeInterest: year(10), ...o } });
const input = (o = {}) => ({ symbol: 'ABC', name: 'ABC Corp', sic: '3674', facts: facts(), marketCap: 1000, now: NOW, ...o });
const check = (r, id) => r.checks.find((c) => c.id === id).status;

test('sharia: complete, recent, low-ratio data passes', () => assert.equal(evaluate(input(), cfg).status, 'PASS'));

test('sharia: each limit fails on its own, and the limit itself is not a pass', () => {
  assert.equal(check(evaluate(input({ facts: facts({ LongTermDebt: point(300) }) }), cfg), 'debt'), 'FAIL');
  assert.equal(check(evaluate(input({ facts: facts({ CashAndCashEquivalentsAtCarryingValue: point(301) }) }), cfg), 'deposits'), 'FAIL');
  assert.equal(check(evaluate(input({ facts: facts({ InvestmentIncomeInterest: year(50) }) }), cfg), 'income'), 'FAIL');
  for (const sic of ['6021', '2082', '2111', '6311', '7990']) assert.equal(evaluate(input({ sic }), cfg).status, 'FAIL', sic);
});

test('sharia: missing, stale or ambiguous data is UNKNOWN, never a pass', () => {
  const unknown = (o) => assert.equal(evaluate(input(o), cfg).status, 'UNKNOWN', JSON.stringify(o));
  unknown({ facts: null });
  unknown({ marketCap: null });
  unknown({ sic: null });
  unknown({ sic: '5812' });
  unknown({ isFund: true });
  unknown({ name: 'First Bank Holdings' });
  unknown({ facts: facts({ LongTermDebt: undefined }) });
  unknown({ facts: facts({ InvestmentIncomeInterest: undefined }) });
  unknown({ facts: facts({ Assets: point(1000, '2025-12-31') }) });
  unknown({ facts: facts({ LongTermDebt: point(100, '2025-06-30') }) });
});

function service(o = {}) {
  const events = [];
  let t = NOW;
  const s = new ShariaService({ store: null, getConfig: () => ({ sharia: cfg, news: {} }), getSecret: () => 'ua', priceOf: () => 10, now: () => t, onChange: (e, prev) => events.push([e.symbol, prev, e.status]), ...o });
  return { s, events, advance: (d) => { t += d * 86400000; } };
}

test('sharia: gate is closed before screening, opens on a sourced ruling and closes again when it expires', () => {
  const { s, events, advance } = service();
  assert.equal(s.gate('ABC').pass, false);
  assert.throws(() => s.setRuling('ABC', { status: 'PASS', source: '' }), /source/);
  s.setRuling('ABC', { status: 'PASS', source: 'Sharia board' });
  assert.equal(s.gate('ABC').pass, true);
  assert.deepEqual(events, [['ABC', 'UNKNOWN', 'PASS']]);
  advance(cfg.rulingValidDays + 1);
  assert.equal(s.gate('ABC').pass, false);
});

test('sharia: live screening from SEC responses; a failed fetch keeps the dated result', async () => {
  let fail = false;
  const body = (url) => (url.includes('company_tickers') ? { 0: { ticker: 'ABC', cik_str: 1 } }
    : url.includes('submissions') ? { name: 'ABC Corp', sic: '3674' }
      : { facts: { ...facts(), dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ val: 100, end: '2026-10-30' }] } } } } });
  const fetchImpl = async (url) => { if (fail) throw new Error('down'); return new Response(JSON.stringify(body(url)), { status: 200 }); };
  const { s, advance } = service({ fetchImpl });
  assert.equal((await s.screen('ABC')).status, 'PASS');
  fail = true;
  await assert.rejects(s.screen('ABC'));
  assert.equal(s.gate('ABC').pass, true);
  assert.ok(Math.abs(s.purification('ABC', 200).amount - 2) < 1e-9);
  advance(cfg.resultValidDays + 1);
  assert.match(s.gate('ABC').detail, /expired/);
});

test('sharia: the risk engine rejects the entry; exits have no Sharia check', () => {
  const r = new RiskManager(DEFAULTS.risk);
  const quote = { bid: 99.99, ask: 100.01, askSize: 100 };
  const market = { realtime: true, connected: true, stale: false, halted: false, session: 'REGULAR', quoteAgeMs: 1, feedLabel: 'x' };
  const ctx = { proposal: { stopLoss: 98, takeProfit: 106, orderType: 'MARKET', snapshotPrice: 100, createdAt: NOW }, quote, market, account: { equity: 100000, cash: 100000, positionQty: 0, positionMark: 0, openPositions: 0 }, exec: DEFAULTS.execution, ai: DEFAULTS.ai, nowMs: NOW };
  assert.equal(r.evaluateEntry({ ...ctx, sharia: { pass: true, detail: 'ok' } }).approved, true);
  const no = r.evaluateEntry({ ...ctx, sharia: { pass: false, detail: 'blocked' } });
  assert.equal(no.approved, false);
  assert.deepEqual(no.failed, ['sharia: blocked']);
  assert.equal(r.evaluateExit({ quote, market, positionQty: 5, exec: DEFAULTS.execution }).approved, true);
});

test('sharia: Telegram alert says a held position was not sold', () => {
  const { text } = renderEvent({ type: 'SHARIA_STATUS', symbol: 'ABC', ts: NOW, data: { status: 'FAIL', prev: 'PASS', held: true } });
  assert.match(text, /ABC/);
  assert.match(text, /لم يُبَع شيء تلقائيًا/);
});

test('sharia: service is attached to the book and its API needs the client header', async () => {
  const t = createTerminal({ postgres: temp(), port: 0, env: {} });
  const port = await t.start();
  try {
    const base = `http://127.0.0.1:${port}/api/sharia`;
    const r = await (await fetch(base)).json();
    assert.equal(r.enabled, true);
    assert.equal((await fetch(`${base}/ruling`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
    const ok = await fetch(`${base}/ruling`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify({ symbol: 'abc', status: 'FAIL', source: 'test board' }) });
    assert.equal((await ok.json()).status, 'FAIL');
  } finally { await t.stop(); }
});

test('sharia: the activity check passes only clear industries, fails prohibited ones, and leaves doubt open', () => {
  const { business } = require('../server/sharia/screener');
  const s = (industry, o = {}) => business({ industry, name: 'Acme Corp', sector: 'Technology', ...o }).status;
  for (const x of ['Semiconductors', 'Computer Manufacturing', 'Computer Software: Prepackaged Software', 'Auto Manufacturing', 'Integrated oil Companies', 'Biotechnology: Pharmaceutical Preparations']) assert.equal(s(x), 'PASS', x);
  for (const x of ['Major Banks', 'Life Insurance', 'Property-Casualty Insurers', 'Savings Institutions', 'Finance: Consumer Services', 'Ordnance And Accessories']) assert.equal(s(x, { sector: 'Finance' }), 'FAIL', x);
  for (const x of ['Beverages (Production/Distribution)', 'Medicinal Chemicals and Botanical Products', 'Hotels/Resorts', 'Military/Government/Technical', 'Department/Specialty Retail Stores', 'Services-Misc. Amusement & Recreation', 'Business Services', 'Broadcasting', 'N/A', '']) assert.equal(s(x), 'UNKNOWN', x);
  assert.equal(s('Computer Software: Prepackaged Software', { name: 'Royal Casino Gaming Inc' }), 'UNKNOWN', 'the name can raise a doubt');
  assert.equal(s('Semiconductors', { isFund: true }), 'UNKNOWN');
  assert.equal(business({}).status, 'UNKNOWN');
});

test('sharia: activity-only mode decides on the activity; the full mode still needs everything', async () => {
  const { ShariaService } = require('../server/sharia/screener');
  let mode = 'BUSINESS';
  const profiles = { NVDA: { name: 'NVIDIA', sector: 'Technology', industry: 'Semiconductors' }, JPM: { name: 'JP Morgan', sector: 'Finance', industry: 'Major Banks' }, KO: { name: 'Coca-Cola', sector: 'Consumer Staples', industry: 'Beverages (Production/Distribution)' } };
  const svc = new ShariaService({ store: null, getConfig: () => ({ sharia: { ...cfg, enabled: true, resultValidDays: 7, rulingValidDays: 120, mode } }), getSecret: () => null, priceOf: () => 100, publicProfile: async (x) => profiles[x] || null });
  for (const x of ['NVDA', 'JPM', 'KO', 'ZZZZ']) await svc.screen(x);
  assert.deepEqual(['NVDA', 'JPM', 'KO', 'ZZZZ'].map((x) => svc.effective(x).status), ['PASS', 'FAIL', 'UNKNOWN', 'UNKNOWN']);
  assert.equal(svc.gate('NVDA').pass, true);
  mode = 'FULL';
  assert.deepEqual(['NVDA', 'JPM'].map((x) => svc.effective(x).status), ['UNKNOWN', 'FAIL'], 'ratios are unknown, so the full check does not pass');
  mode = 'BUSINESS';
  svc.setRuling('NVDA', { status: 'FAIL', source: 'a board' });
  assert.equal(svc.gate('NVDA').pass, false, 'a recorded ruling always wins');
  await svc.screen('BTC/USD');
  assert.equal(svc.effective('BTC/USD').status, 'UNKNOWN', 'crypto still needs a ruling');
});
