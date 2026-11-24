'use strict';
/**
 * The committee's rules: seven views, each -1..1 with its reasons, combined with fixed weights. It also decides what
 * the AI agents may change: they can lower the result, never raise it, and never touch the Sharia or risk limits.
 */
const clamp = (x) => Math.max(-1, Math.min(1, x));
const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
const ok = (x) => typeof x === 'number' && Number.isFinite(x);
const R = (sign, ar, en) => ({ sign, ar, en });

const VIEWS = {
  trend(q) {
    if (!q) return null;
    const { ma50, ma200, r60 } = q.trend; const out = []; let s = 0; const px = q.price;
    if (ok(ma200)) { const up = px > ma200; s += up ? 0.4 : -0.4; out.push(R(up ? 1 : -1, up ? 'السعر فوق متوسطه الطويل' : 'السعر تحت متوسطه الطويل', up ? 'Price is above its long average' : 'Price is below its long average')); }
    if (ok(ma50)) s += px > ma50 ? 0.3 : -0.3;
    if (ok(r60)) { s += clamp(r60 * 1.5) * 0.3; out.push(R(Math.sign(r60), `تغيّر ${pct(r60)} خلال ثلاثة أشهر`, `${pct(r60)} over three months`)); }
    return { score: clamp(s), reasons: out };
  },
  model(q) {
    const f = q && q.forecast;
    if (!f || !f.available) return null;
    if (!f.edge) return { score: 0, reasons: [R(0, `النماذج لم تتفوق على التخمين البسيط في ${f.tested} يومًا لم ترها، فلا وزن لها`, `The models did not beat a simple guess on ${f.tested} unseen days, so they carry no weight`)] };
    return { score: clamp((f.probUp - f.baseRate) * 5), reasons: [R(Math.sign(f.probUp - f.baseRate), `احتمال الارتفاع خلال أسبوع ${pct(f.probUp)} مقابل ${pct(f.baseRate)} معتادًا`, `${pct(f.probUp)} chance of being higher in a week, against a usual ${pct(f.baseRate)}`)] };
  },
  company(q, f) {
    const h = f && f.health;
    if (!h) return null;
    const out = []; const s = [];
    if (h.piotroski) { const v = h.piotroski.score / h.piotroski.of; s.push(v * 2 - 1); out.push(R(Math.sign(v - 0.5), `${h.piotroski.score} من ${h.piotroski.of} علامات صحة مالية`, `${h.piotroski.score} of ${h.piotroski.of} signs of financial health`)); }
    if (ok(h.revenueGrowth)) { s.push(clamp(h.revenueGrowth * 3)); out.push(R(Math.sign(h.revenueGrowth), `نمو الإيرادات ${pct(h.revenueGrowth)}`, `Revenue growth ${pct(h.revenueGrowth)}`)); }
    if (ok(h.freeCashMargin)) { s.push(clamp(h.freeCashMargin * 4)); out.push(R(Math.sign(h.freeCashMargin), `${pct(h.freeCashMargin)} من الإيرادات نقد حر`, `${pct(h.freeCashMargin)} of revenue is free cash`)); }
    if (ok(h.altman)) { s.push(h.altman > 3 ? 0.5 : h.altman < 1.8 ? -1 : -0.1); if (h.altman < 1.8) out.push(R(-1, 'مؤشر ضائقة مالية', 'A sign of financial distress')); }
    return s.length >= 2 ? { score: clamp(s.reduce((a, b) => a + b, 0) / s.length), reasons: out } : null;
  },
  price(q, f) {
    const h = f && f.health;
    if (!h || !ok(h.pricedInGrowth)) return null;
    const g = h.pricedInGrowth; const seen = ok(h.revenueGrowth) ? h.revenueGrowth : null;
    // past growth is capped: few companies keep more than 20% a year for a decade
    const s = clamp((Math.min(0.2, seen == null ? 0.08 : seen * 0.5) - g) * 6);
    return { score: s, reasons: [R(Math.sign(s), `السعر الحالي يفترض نمو النقد ${pct(g)} سنويًا لعشر سنوات`, `Today's price assumes cash grows ${pct(g)} a year for ten years`)] };
  },
  earnings(q, f) {
    if (!f) return null;
    const s = []; const out = [];
    if (f.surprises && f.surprises.count >= 3) { const v = f.surprises.beats / f.surprises.count; s.push(v * 2 - 1); out.push(R(v > 0.5 ? 1 : -1, `تجاوز التوقعات ${f.surprises.beats} من ${f.surprises.count} مرات`, `Beat expectations ${f.surprises.beats} of ${f.surprises.count} times`)); }
    const e = f.estimates; if (e && ok(e.up) && ok(e.down) && e.up + e.down >= 3) { const v = (e.up - e.down) / (e.up + e.down); s.push(v); out.push(R(Math.sign(v), `محللون رفعوا تقديراتهم: ${e.up}، وخفّضوها: ${e.down}`, `Analysts raising estimates: ${e.up}, lowering: ${e.down}`)); }
    return s.length ? { score: clamp(s.reduce((a, b) => a + b, 0) / s.length), reasons: out } : null;
  },
  people(q, f) {
    if (!f) return null;
    const s = []; const out = []; const i = f.institutions; const n = f.insiders;
    if (i && ok(i.increased) && ok(i.decreased) && i.increased + i.decreased > 0) { const v = (i.increased - i.decreased) / (i.increased + i.decreased); s.push(v); out.push(R(Math.sign(v), v > 0 ? 'الصناديق تزيد أكثر مما تخفّض' : 'الصناديق تخفّض أكثر مما تزيد', v > 0 ? 'Funds are adding more than trimming' : 'Funds are trimming more than adding')); }
    // selling by insiders is often pay-related, so only buying counts in favour and heavy one-sided selling slightly against
    if (n && ok(n.buys3m) && ok(n.sells3m) && n.buys3m + n.sells3m >= 3) { const v = n.buys3m > n.sells3m ? 0.5 : -0.2; s.push(v); out.push(R(Math.sign(v), `مطلعون خلال 3 أشهر: ${n.buys3m} شراء و${n.sells3m} بيع`, `Insiders over 3 months: ${n.buys3m} buys, ${n.sells3m} sells`)); }
    return s.length ? { score: clamp(s.reduce((a, b) => a + b, 0) / s.length), reasons: out } : null;
  },
  news(q, f) {
    const n = f && f.news;
    if (!n || n.tone == null || n.count < 4) return null;
    return { score: clamp(n.tone * 1.2), reasons: [R(Math.sign(Math.round(n.tone * 10)), `نبرة ${n.count} خبرًا: ${n.tone > 0.15 ? 'إيجابية' : n.tone < -0.15 ? 'سلبية' : 'متوازنة'}`, `Tone of ${n.count} headlines: ${n.tone > 0.15 ? 'positive' : n.tone < -0.15 ? 'negative' : 'balanced'}`)] };
  },
};
const WEIGHT = { trend: 0.22, model: 0.18, company: 0.2, price: 0.14, earnings: 0.12, people: 0.06, news: 0.08 };

/** Dangers only ever hold a decision back. */
function cautions(q) {
  const out = []; let veto = false;
  if (!q) return { list: out, veto };
  if (q.regime && q.regime.turbulentProb > 0.7) out.push(R(-1, `السوق في حالة اضطراب لهذا السهم (${pct(q.regime.turbulentProb)})`, `This stock is in a turbulent phase (${pct(q.regime.turbulentProb)})`));
  if (q.anomaly && Math.abs(q.anomaly.returnZ) > 5) out.push(R(-1, `حركة غير معتادة في آخر يوم: ${pct(q.anomaly.lastReturn)}`, `Unusual move on the last day: ${pct(q.anomaly.lastReturn)}`));
  if (q.risk.volNextYear > 0.8) { out.push(R(-1, `تقلب متوقع مرتفع جدًا: ${pct(q.risk.volNextYear)} سنويًا`, `Very high expected volatility: ${pct(q.risk.volNextYear)} a year`)); }
  if (q.risk.drawdown.current > 0.4) out.push(R(-1, `أقل من قمته بنسبة ${pct(q.risk.drawdown.current)}`, `${pct(q.risk.drawdown.current)} below its peak`));
  if (out.length >= 3) veto = true;
  return { list: out, veto };
}

function decide({ quant, facts, sharia }) {
  const q = quant && quant.available ? quant : null; const views = {}; let sum = 0; let weight = 0;
  for (const [k, fn] of Object.entries(VIEWS)) { const v = fn(q, facts); if (!v) continue; views[k] = { score: +v.score.toFixed(3), reasons: v.reasons }; sum += v.score * WEIGHT[k]; weight += WEIGHT[k]; }
  const score = weight ? sum / weight : 0; const c = cautions(q); const coverage = weight / Object.values(WEIGHT).reduce((a, b) => a + b, 0);
  let verdict = coverage < 0.3 ? 'UNKNOWN' : score >= 0.22 ? 'SUPPORT' : score <= -0.18 ? 'AVOID' : 'NEUTRAL';
  if (c.veto && verdict !== 'UNKNOWN') verdict = 'AVOID';
  else if (c.list.length && verdict === 'SUPPORT') verdict = 'NEUTRAL';
  return { verdict, score: +score.toFixed(3), coverage: +coverage.toFixed(2), views, cautions: c.list, blocked: sharia && sharia !== 'PASS' ? sharia : null };
}

const RANK = { AVOID: 0, UNKNOWN: 1, NEUTRAL: 1, SUPPORT: 2 };
/** The agents' vote can only make the result more careful. */
function merge(rules, agents) {
  if (!agents || !RANK.hasOwnProperty(agents.verdict)) return rules.verdict;
  return RANK[agents.verdict] < RANK[rules.verdict] ? agents.verdict : rules.verdict;
}

module.exports = { decide, merge, VIEWS, WEIGHT, RANK };
