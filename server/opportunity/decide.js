'use strict';
/**
 * One symbol, one clear call: buy now, buy at a price, wait, avoid, hold, sell part or sell, with its prices, its
 * reasons, what comes next and what would change the call. Pure function of the evidence.
 *
 * What it never does: promise a result, hide the losing side, or let one strong reading stand
 * alone. Chances come from replayed past days with their average removed, so on their own they favour nobody.
 */
const { VIEWS } = require('../lab/committee');
const { inflowShare } = require('../analysis/chartbook');
const { suggest, odds, tidy } = require('../invest/levels');

const ok = (x) => typeof x === 'number' && Number.isFinite(x);
const T = (ar, en) => ({ ar, en });
const clamp = (x, a = -1, b = 1) => Math.min(b, Math.max(a, x));
const DAY = 86400000;
const WEIGHT = { chart: 0.3, strength: 0.2, company: 0.18, news: 0.14, earnings: 0.1, signals: 0.06, flow: 0.04, people: 0.04 };
const NAME = { chart: T('الرسم والاتجاه', 'Chart and trend'), strength: T('القوة مقارنة بغيره', 'Strength against other stocks'), company: T('الشركة', 'The company'), news: T('الأخبار', 'News'), earnings: T('الأرباح والتوقعات', 'Earnings and estimates'), signals: T('إشارات نجحت هنا من قبل', 'Signals that worked here before'), flow: T('السيولة', 'Money flow'), people: T('الصناديق والمطلعون', 'Funds and insiders') };
const COMPANY = new Set(['graham', 'buffett', 'lynch', 'greenblatt', 'piotroski', 'oneil']);

function evidence({ tech, lens, facts, bars, strength }) {
  const out = [];
  const add = (kind, score, text) => { if (ok(score)) out.push({ kind, name: NAME[kind], score: Math.round(clamp(score) * 100) / 100, text }); };
  const d = tech.horizons.days;
  add('chart', tech.score, tech.score > 0.45 ? T('صاعد بوضوح', 'Clearly rising') : tech.score > 0.15 ? T('يميل إلى الصعود', 'Leans up') : tech.score < -0.45 ? T('هابط بوضوح', 'Clearly falling') : tech.score < -0.15 ? T('يميل إلى الهبوط', 'Leans down') : T('بلا اتجاه واضح', 'No clear direction'));
  if (strength && ok(strength.place)) { const n = Math.round(strength.place * 100); add('strength', (strength.place - 0.5) * 2 * (strength.above200 === false ? 0.6 : 1), T(`أقوى من ${n}% من ${strength.among} سهمًا وصندوقًا${strength.above200 === false ? '، لكنه تحت متوسطه الطويل' : ''}`, `Stronger than ${n}% of ${strength.among} stocks and funds${strength.above200 === false ? ', but under its long average' : ''}`)); }
  const now = tech.record.filter((r) => r.now && r.useful);
  if (now.length) add('signals', Math.min(1, 0.5 + now.length * 0.2), T(`ظهرت: ${now.map((r) => r.name.ar).join('، ')}`, `Appeared: ${now.map((r) => r.name.en).join(', ')}`));
  const share = inflowShare(bars);
  if (ok(share) && bars.slice(-20).some((b) => b.volume > 0)) add('flow', (share - 0.5) * 3, T(`السيولة الداخلة ${Math.round(share * 100)}% تقديرًا`, `About ${Math.round(share * 100)}% of money coming in (estimate)`));
  if (lens && !/financ/i.test((facts && facts.sector) || '')) {
    const m = lens.methods.filter((x) => COMPANY.has(x.id) && x.result !== 'UNKNOWN');
    if (m.length >= 3) { const v = m.reduce((a, x) => a + (x.result === 'FITS' ? 1 : x.result === 'PARTLY' ? 0 : -1), 0) / m.length; const fits = m.filter((x) => x.result === 'FITS').length; add('company', v, T(`توافق ${fits} من ${m.length} طرق لكبار المستثمرين`, `Fits ${fits} of ${m.length} great investors' methods`)); }
  }
  for (const k of ['earnings', 'people', 'news']) { const v = facts && VIEWS[k](null, facts); if (v) add(k, v.score, v.reasons.length ? T(v.reasons.map((r) => r.ar).join('، '), v.reasons.map((r) => r.en).join(', ')) : null); }
  return { list: out.sort((a, b) => WEIGHT[b.kind] - WEIGHT[a.kind]), atr: d.atr };
}

/** Candidate ways in: now, at a lower price, or above resistance. */
function entries({ tech, bars, price }) {
  const atr = tech.horizons.days.atr; // a price far away, or a target already passed, is not an opportunity now
  const near = (e) => e.target > price && (!(atr > 0) || Math.abs(e.entry - price) <= 3 * atr);
  const out = tech.setups.filter((s) => s.side === 'BUY').map((s) => ({ way: s.id, type: s.type, entry: s.price, stop: s.stop, target: s.target, odds: s.odds, why: s.why }));
  const s = suggest(bars, price, { days: 20 });
  if (s && s.why.entry === 'NOW') out.push({ way: 'NOW', type: 'MARKET', entry: tidy(price), stop: s.stop, target: s.target, odds: odds(bars, { entry: price, stop: s.stop, target: s.target, days: 20 }, { paths: 1500 }), why: T('السعر قريب من متوسطه ولم يبتعد', 'The price is near its average, not stretched') });
  return out.map((e) => ({ ...e, ratio: Math.round(((e.target - e.entry) / (e.entry - e.stop)) * 10) / 10 })).filter((e) => e.stop > 0 && e.stop < e.entry && e.entry < e.target && e.ratio >= 1.4 && e.odds && e.odds.target >= 0.15 && near(e));
}

function size(e, account, crypto, factor = 1) {
  if (!account || !(account.equity > 0)) return null;
  const risk = ((account.equity * (account.riskPct || 0.5)) / 100) * factor; const cap = (account.equity * (account.maxPositionPct || 20)) / 100;
  const raw = Math.min(risk / (e.entry - e.stop), cap / e.entry, Math.max(0, account.cash || 0) / e.entry);
  const qty = crypto ? Math.floor(raw * 1e6) / 1e6 : Math.floor(raw);
  return qty > 0 ? { qty, cost: Math.round(qty * e.entry * 100) / 100, gain: Math.round(qty * (e.target - e.entry) * 100) / 100, loss: Math.round(qty * (e.entry - e.stop) * 100) / 100 } : null;
}

/**
 * input: { symbol, price, bars, tech, lens, facts, lab, position, account, events, live, fresh, crypto, now }
 * lab: verdict of a fresh analysis, or null.
 */
function decide(i) {
  if (!i.tech || !(i.price > 0)) return { symbol: i.symbol, action: 'UNKNOWN', price: i.price || null, reasons: [], evidence: [], events: [], cautions: [T('لا توجد أسعار سابقة كافية', 'Too little price history')] };
  const { tech, price, position: pos } = i; const ev = evidence(i);
  let sum = 0; let weight = 0;
  for (const e of ev.list) { sum += e.score * WEIGHT[e.kind]; weight += WEIGHT[e.kind]; }
  const score = weight ? sum / weight : 0; const coverage = weight / Object.values(WEIGHT).reduce((a, b) => a + b, 0);
  const atr = ev.atr; const cautions = [];
  const soon = (i.events || []).filter((e) => e.at >= i.now - DAY / 2 && e.at - i.now < 14 * DAY).sort((a, b) => a.at - b.at);
  const risky = soon.find((e) => e.own && e.at - i.now < 2 * DAY);
  if (!tech.agree) cautions.push(T('الساعات والأيام والأسابيع غير متفقة', 'Hours, days and weeks disagree'));
  if (coverage < 0.5) cautions.push(T('الحكم من السعر أساسًا، فالمعلومات عن الشركة ناقصة', 'Mostly judged from price; company information is missing'));
  if (i.lab === 'AVOID') cautions.push(T('التحليل الأخير يميل ضد الشراء', 'The latest analysis leans against buying'));
  if (risky) cautions.push(T(`حدث قريب قد يحرّك السعر بقوة: ${risky.label.ar}`, `An event close by may move the price sharply: ${risky.label.en}`));
  // smaller when the market, or the stock itself, is under its long average; never larger
  const weak = !!(i.strength && i.strength.above200 === false); const factor = i.crypto ? 1 : ((i.market && i.market.factor) || 1) * (weak ? 0.5 : 1);
  if (!i.crypto && i.market && i.market.above === false) cautions.push(T('السوق تحت متوسطه الطويل، فنقلّل الحجم', 'The market is under its long average, so the size is smaller'));
  if (weak) cautions.push(T('السهم تحت متوسطه الطويل، فنقلّل الحجم', 'The stock is under its long average, so the size is smaller'));
  if (i.crowd && i.crowd.pass === false) cautions.push(T('تملك ما يشبهه كثيرًا، فالشراء يزيد الرهان نفسه', 'You already hold much that behaves like it; buying adds to the same bet'));
  const lead = ev.list.find((e) => e.kind === 'news'); if (lead && lead.score < -0.4) cautions.push(T('نبرة الأخبار سلبية', 'The tone of the news is negative'));
  const base = { symbol: i.symbol, price, score: Math.round(score * 100) / 100, coverage: Math.round(coverage * 100) / 100, evidence: ev.list, events: soon, cautions, live: !!i.live, atr: tidy(atr), strength: i.strength || null };
  const confidence = Math.abs(score) >= 0.4 && coverage >= 0.5 && tech.agree && !cautions.length ? 'HIGH' : Math.abs(score) >= 0.25 && cautions.length <= 1 ? 'MEDIUM' : 'LOW';
  const top = (sign) => ev.list.filter((e) => Math.sign(e.score) === sign && Math.abs(e.score) >= 0.15 && e.text).slice(0, 3).map((e) => e.text);

  // ---------------------------------------------------------------- something already held
  if (pos && pos.qty > 0) {
    const gain = price / pos.avgPrice - 1; const s50 = tech.horizons.days.s50;
    const result = { qty: pos.qty, gain: Math.round(gain * 10000) / 10000, value: Math.round(pos.qty * (price - pos.avgPrice) * 100) / 100 };
    const protect = tech.setups.find((s) => s.id === 'PROTECT');
    const guard = Math.max(pos.stop || 0, protect ? protect.price : 0) || null;
    let action = 'HOLD'; let why = T('لا سبب للبيع الآن. احمِ ما تملكه بوقف.', 'No reason to sell now. Protect it with a stop.');
    if (pos.stop && price <= pos.stop) { action = 'SELL'; why = T('بلغ السعر وقف الخسارة', 'The price reached the stop'); }
    else if (score <= -0.3 && (!ok(s50) || price < s50)) { action = 'SELL'; why = T('انقلبت الأدلة ضده، والسعر تحت متوسط 50 يومًا', 'The evidence turned against it and the price is under its 50-day average'); }
    else if (pos.takeProfit && price >= pos.takeProfit) { action = 'SELL_PART'; why = T('بلغ السعر الهدف. بِع جزءًا وارفع وقف الباقي.', 'The price reached the target. Sell part and raise the stop on the rest.'); }
    else if (gain > 0 && score < 0 && i.lab === 'AVOID') { action = 'SELL_PART'; why = T('أنت رابح والأدلة تضعف. احفظ جزءًا من الربح.', 'You are in profit and the evidence is weakening. Keep part of the gain.'); }
    const res = tech.horizons.days.resistance.find((x) => x.price > price);
    return { ...base, action, confidence, why, reasons: action === 'HOLD' ? top(1) : top(-1), position: result, plan: { stop: guard, target: pos.takeProfit || (res ? res.price : null) }, change: action === 'HOLD' ? T(guard ? `يتغير الرأي إذا نزل السعر تحت ${guard}` : 'يتغير الرأي إذا انقلب الاتجاه', guard ? `This changes if the price falls under ${guard}` : 'This changes if the trend turns') : T('يتغير الرأي إذا عاد السعر فوق متوسط 50 يومًا بكمية جيدة', 'This changes if the price returns above its 50-day average on good volume') };
  }

  // ---------------------------------------------------------------- not held
  const ways = entries(i); let pick = null; let action = 'WATCH'; let why = T('لا فرصة واضحة الآن. الانتظار قرار.', 'No clear opportunity now. Waiting is a decision.');
  const of = (id) => ways.find((w) => w.way === id);
  if (score <= -0.2) { action = 'AVOID'; why = T('الأدلة ضده الآن', 'The evidence is against it now'); }
  else if (score >= 0.3 && i.lab !== 'AVOID') {
    pick = (score >= 0.4 && of('NOW')) || of('DIP') || of('NOW') || of('BREAK') || null;
    if (pick) { action = pick.way === 'NOW' ? 'BUY' : 'BUY_AT'; why = pick.why; }
  } else if (score >= 0.12) { pick = of('BREAK') || of('DIP') || null; if (pick) { action = 'WAIT'; why = T('الميل إيجابي لكنه غير كافٍ. اشترِ فقط إذا تحقق السعر المطلوب.', 'It leans positive but not enough. Buy only if the price condition is met.'); } }
  if (action === 'BUY' && (risky || (i.live && i.fresh === false))) { action = 'WAIT'; why = risky ? T('انتظر حتى يمر الحدث القريب', 'Wait until the nearby event passes') : T('السعر غير حديث الآن', 'The price is not current now'); }
  if (action === 'BUY_AT' && risky) action = 'WAIT';
  const plan = pick ? { way: pick.way, type: pick.type, entry: tidy(pick.entry), stop: tidy(pick.stop), target: tidy(pick.target), ratio: pick.ratio, odds: pick.odds, days: 20, size: size(pick, i.account, i.crypto, factor), gainPct: pick.target / pick.entry - 1, lossPct: pick.entry / pick.entry - pick.stop / pick.entry, until: i.now + 7 * DAY } : null;
  return { ...base, action, confidence, why, reasons: action === 'AVOID' ? top(-1) : top(1), against: action === 'AVOID' ? top(1) : top(-1), plan, change: plan && plan.type === 'STOP' ? T(`لا تشترِ قبل أن يتجاوز ${plan.entry}. وبعدها تبطل الفكرة إذا نزل تحت ${plan.stop}`, `Do not buy before it passes ${plan.entry}. After that, the idea is wrong if it falls under ${plan.stop}`) : plan ? T(`تبطل الفكرة إذا نزل السعر تحت ${plan.stop}`, `The idea is wrong if the price falls under ${plan.stop}`) : action === 'AVOID' ? T('يتغير الرأي إذا عاد السعر فوق متوسط 50 يومًا', 'This changes if the price returns above its 50-day average') : T('يتغير الرأي إذا ظهر اتجاه واضح', 'This changes if a clear direction appears') };
}

/** The agents' review can only make a call more careful. */
function temper(call, review) {
  if (!review || !['REJECT', 'CAREFUL'].includes(review.stance)) return call;
  const note = review.stance === 'REJECT' ? T('فريق المحللين اعترض', 'The team of analysts objected') : T('فريق المحللين طلب الحذر', 'The team of analysts asked for care');
  if (!['BUY', 'BUY_AT', 'WAIT'].includes(call.action)) return call;
  const action = review.stance === 'REJECT' ? 'WATCH' : call.action === 'BUY' || call.action === 'BUY_AT' ? 'WAIT' : call.action;
  return { ...call, action, plan: action === 'WATCH' ? null : call.plan, cautions: [...call.cautions, note], confidence: 'LOW', tempered: review.stance };
}

module.exports = { decide, temper, evidence, entries, size, WEIGHT };
