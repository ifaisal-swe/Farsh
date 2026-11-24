'use strict';
/**
 * The helper's answers without a language model: it recognises what is asked and answers from the same facts the
 * agent's tools read. Also the growth calculator used by both.
 */
const { parse } = require('../commands/parse');

const ok = (x) => typeof x === 'number' && Number.isFinite(x);
const money = (x) => (ok(x) ? `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—');
const pct = (x, d = 1) => (ok(x) ? `${(x * 100).toFixed(d)}%` : '—');
const ACTION = { BUY: ['شراء الآن', 'buy now'], BUY_AT: ['شراء عند سعر', 'buy at a price'], WAIT: ['انتظر شرطًا', 'wait for a condition'], WATCH: ['راقب فقط', 'just watch'], AVOID: ['تجنب', 'avoid'], HOLD: ['احتفظ', 'hold'], SELL: ['بيع', 'sell'], SELL_PART: ['بيع جزء', 'sell part'], UNKNOWN: ['غير معروف', 'unknown'] };

/** What saving may become at three assumed yearly rates. Arithmetic, not a prediction. */
function growth({ start = 0, monthly = 0, years = 10 }) {
  const s = Math.min(1e9, Math.max(0, Number(start) || 0)); const m = Math.min(1e7, Math.max(0, Number(monthly) || 0)); const y = Math.min(50, Math.max(1, Math.round(Number(years) || 10)));
  const at = (rate) => { const r = (1 + rate) ** (1 / 12) - 1; let v = s; for (let i = 0; i < y * 12; i++) v = v * (1 + r) + m; return Math.round(v * 100) / 100; };
  return { start: s, monthly: m, years: y, paid: s + m * 12 * y, cases: [{ rate: -0.02, value: at(-0.02) }, { rate: 0.04, value: at(0.04) }, { rate: 0.08, value: at(0.08) }] };
}

const digits = (t) => String(t).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/(\d)[,٬](\d{3})(?!\d)/g, '$1$2').replace(/[أإآ]/g, 'ا').toLowerCase();
function growthInput(text) {
  const t = digits(text); const num = (re) => { const m = re.exec(t); return m ? Number(m[1]) : null; };
  const years = num(/(\d+(?:\.\d+)?)\s*(?:سنوات|سنة|سنين|عام|اعوام|years?|yrs?)/); const monthly = num(/(\d+(?:\.\d+)?)\s*(?:\$|دولار|ريال|usd|dollars?)?\s*(?:شهري|كل شهر|في الشهر|بالشهر|monthly|a month|per month|every month)/);
  const rest = monthly !== null ? t.replace(/(\d+(?:\.\d+)?)\s*(?:\$|دولار|ريال|usd|dollars?)?\s*(?:شهري\S*|كل شهر|في الشهر|بالشهر|monthly|a month|per month|every month)/, ' ') : t;
  const start = (/(\d+(?:\.\d+)?)\s*(?:\$|دولار|ريال|usd|dollars?)|\$\s*(\d+(?:\.\d+)?)/.exec(rest) || []).slice(1).find(Boolean);
  return { years, monthly, start: start ? Number(start) : null };
}

/** bundle: { wallet, positions, calls, record, hours, goals, live, symbols } */
function answer(text, b, lang = 'ar') {
  const ar = lang !== 'en'; const L = (a, e) => (ar ? a : e); const say = (x) => (x ? (ar ? x.ar : x.en) : ''); const t = digits(text);
  const has = (re) => re.test(t);
  const act = (a) => (ACTION[a] || ACTION.UNKNOWN)[ar ? 0 : 1];
  const links = []; const go = (label, to) => links.push({ label, to });
  const paper = L('هذه محاكاة ورقية وليست نصيحة، ولا ربح مضمون.', 'This is a paper simulation, not advice, and no profit is guaranteed.');
  const line = (c) => { const p = c.plan; return `• ${c.symbol}: ${act(c.action)}${p && ok(p.entry) ? ` ${L('عند', 'at')} ${money(p.entry)}، ${L('وقف', 'stop')} ${money(p.stop)}، ${L('هدف', 'target')} ${money(p.target)}` : ''}`; };
  const sym = (parse(text).symbol || '').toUpperCase(); const found = (b.calls || []).find((c) => c.symbol === sym || c.symbol === `${sym}/USD`);

  if (!b.session) { go(L('ابدأ محاكاة', 'Start a simulation'), '/app'); return { topic: 'start', text: L('ابدأ محاكاة أولًا، ثم أراقب لك الأسواق وأخبرك بالفرص.', 'Start a simulation first; then I can watch the markets and tell you about opportunities.'), links }; }
  if (has(/نمو|ينمو|تنمو|ادخر|ادخار|استثمر .*(شهر|سن)|كم (يصير|يصبح|سيكون)|تقاعد|grow|savings?|save .*(month|year)|compound|retire/)) {
    const g = growthInput(text); const r = growth({ start: g.start ?? (g.monthly === null ? b.wallet.equity : 0), monthly: g.monthly ?? 0, years: g.years ?? 10 });
    go(L('حدد هدفًا', 'Set a goal'), '/app/invest');
    return { topic: 'growth', growth: r, text: [L(`بداية ${money(r.start)} وإضافة ${money(r.monthly)} شهريًا لمدة ${r.years} سنة: تدفع ${money(r.paid)}.`, `Starting with ${money(r.start)} and adding ${money(r.monthly)} a month for ${r.years} years, you put in ${money(r.paid)}.`), ...r.cases.map((c) => L(`• لو كان العائد ${pct(c.rate, 0)} سنويًا: ${money(c.value)}`, `• If the yearly return were ${pct(c.rate, 0)}: ${money(c.value)}`)), L('حساب بنسب مفترضة ثابتة، والواقع يصعد وينزل.', 'Arithmetic with fixed assumed rates; real markets rise and fall.')].join('\n'), links };
  }
  if (found) {
    const c = found; const p = c.plan;
    go(L('افتح الفرص', 'Open opportunities'), '/app/opportunities');
    const out = [`${c.symbol}: ${act(c.action)}. ${say(c.why)}`];
    if (c.position) out.push(L(`تملك ${c.position.qty}، والنتيجة الآن ${money(c.position.value)} (${pct(c.position.gain)}).`, `You hold ${c.position.qty}; the result now is ${money(c.position.value)} (${pct(c.position.gain)}).`));
    if (p && ok(p.entry)) { out.push(L(`الخطة: شراء ${money(p.entry)}، وقف ${money(p.stop)}، هدف ${money(p.target)}.`, `Plan: buy ${money(p.entry)}, stop ${money(p.stop)}, target ${money(p.target)}.`)); if (p.odds) out.push(L(`من أيام سابقة: الهدف أولًا ${pct(p.odds.target, 0)}، والوقف أولًا ${pct(p.odds.stop, 0)}.`, `From past days: target first ${pct(p.odds.target, 0)}, stop first ${pct(p.odds.stop, 0)}.`)); if (p.size) out.push(L(`بحجم يناسب حدودك (${p.size.qty}): +${money(p.size.gain)} عند الهدف، و−${money(p.size.loss)} عند الوقف.`, `At a size within your limits (${p.size.qty}): +${money(p.size.gain)} at the target, −${money(p.size.loss)} at the stop.`)); }
    if ((c.reasons || []).length) out.push(`${L('لماذا', 'Why')}: ${c.reasons.map(say).join(ar ? '، ' : '; ')}`);
    if ((c.cautions || []).length) out.push(`${L('انتبه', 'Careful')}: ${c.cautions.map(say).join(ar ? '، ' : '; ')}`);
    if ((c.events || []).length) out.push(`${L('قادم', 'Coming')}: ${c.events.slice(0, 2).map((e) => `${say(e.label)} (${new Date(e.at).toISOString().slice(0, 10)})`).join(ar ? '، ' : '; ')}`);
    out.push(say(c.change), paper);
    return { topic: 'symbol', symbols: [c.symbol], text: out.filter(Boolean).join('\n'), links };
  }
  if (has(/ابيع|بيع|متى اخرج|sell|take profit|exit/)) {
    const l = (b.calls || []).filter((c) => c.position); go(L('افتح الفرص', 'Open opportunities'), '/app/opportunities');
    return { topic: 'sell', symbols: l.map((c) => c.symbol), text: l.length ? [...l.map((c) => `• ${c.symbol}: ${act(c.action)}. ${say(c.why)} (${pct(c.position.gain)})`), paper].join('\n') : L('لا تملك شيئًا لتبيعه الآن.', 'You hold nothing to sell now.'), links };
  }
  if (has(/فرص|اشتري|شراء|افضل سهم|وش تنصح|opportunit|buy|best stock|what should/)) {
    const l = (b.calls || []).filter((c) => ['BUY', 'BUY_AT', 'WAIT'].includes(c.action)).slice(0, 5); go(L('افتح الفرص', 'Open opportunities'), '/app/opportunities');
    return { topic: 'opportunities', symbols: l.map((c) => c.symbol), text: l.length ? [L('الفرص في قائمتك الآن:', 'Opportunities in your list now:'), ...l.map(line), paper].join('\n') : L('لا فرصة واضحة في قائمتك الآن. الانتظار قرار جيد أحيانًا.', 'No clear opportunity in your list now. Waiting can be a good decision.'), links };
  }
  if (has(/محفظ|رصيد|كم معي|سيوله|سيولة|ارباحي|خسارتي|wallet|balance|portfolio|cash|profit|loss/)) {
    const w = b.wallet; go(L('افتح المحفظة', 'Open the wallet'), '/app');
    return { topic: 'wallet', text: [L(`قيمة محفظتك ${money(w.equity)}، منها نقد ${money(w.cash)}.`, `Your wallet is worth ${money(w.equity)}, of which ${money(w.cash)} is cash.`), L(`ربح غير محقق ${money(w.unrealizedPnl)}، ومحقق ${money(w.realizedPnl)}.`, `Unrealized ${money(w.unrealizedPnl)}, realized ${money(w.realizedPnl)}.`), ...(b.positions || []).map((p) => `• ${p.symbol}: ${p.qty} × ${money(p.avgPrice)}`)].join('\n'), links };
  }
  if (has(/يفتح|يغلق|مفتوح|مغلق|ساعات|متى السوق|open|close|hours|market time/)) {
    const h = b.hours || {}; go(L('ساعات السوق', 'Market hours'), '/app#hours'); const when = (ms) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
    return { topic: 'hours', text: h.open ? L(`السوق الأمريكي مفتوح، ويغلق ${when(h.closesAt)} (توقيت غرينتش).`, `The US market is open and closes ${when(h.closesAt)} (GMT).`) : h.opensAt ? L(`السوق الأمريكي مغلق، ويفتح ${when(h.opensAt)} (توقيت غرينتش). العملات الرقمية مفتوحة دائمًا.`, `The US market is closed and opens ${when(h.opensAt)} (GMT). Crypto is always open.`) : L('لا أعرف مواعيد السوق الآن.', 'I do not know the market hours now.'), links };
  }
  if (has(/سجل|نتائج|صدق|دقيق|كم مره|record|track|accura|how often/)) {
    const r = b.record || {}; go(L('افتح السجل', 'Open the record'), '/app/opportunities');
    return { topic: 'record', text: r.done ? L(`من ${r.done} فرصة انتهت: ربحت ${r.won} وخسرت ${r.lost}، والمتوسط ${pct(r.average)}.`, `Of ${r.done} finished opportunities: ${r.won} gained and ${r.lost} lost, averaging ${pct(r.average)}.`) : L('لم تنتهِ أي فرصة بعد، فلا سجل حتى الآن.', 'No opportunity has finished yet, so there is no record.'), links };
  }
  if (has(/شرع|حلال|حرام|sharia|halal/)) { go(L('الفحص الشرعي', 'Sharia screen'), '/app/sharia'); return { topic: 'sharia', text: L('الفحص الشرعي معلومة تجدها في صفحته، ولا يؤثر على الآراء أو القرارات هنا.', 'The Sharia screen is information on its own page; it does not affect the views or decisions here.'), links }; }
  if (has(/هدف|اهداف|goal/)) { go(L('أهدافك', 'Your goals'), '/app/invest'); const g = b.goals || []; return { topic: 'goals', text: g.length ? g.map((x) => `• ${x.name}: ${money(x.target)}`).join('\n') : L('لا أهداف بعد. أنشئ هدفًا وسأتابعه معك.', 'No goals yet. Create one and I will follow it with you.'), links }; }
  return { topic: 'help', text: L('أستطيع أن أخبرك: ما الفرص الآن؟ متى أبيع؟ ما رأيك في NVDA؟ كم في محفظتي؟ متى يفتح السوق؟ كم يصبح 500 دولار شهريًا بعد 10 سنوات؟', 'I can tell you: what are the opportunities now? When should I sell? What about NVDA? How much is in my wallet? When does the market open? What would $500 a month become in 10 years?'), links };
}

module.exports = { answer, growth, growthInput, ACTION, money, pct };
