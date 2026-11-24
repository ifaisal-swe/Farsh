<script setup lang="ts">
import { Check, CircleAlert, Loader, Minus, TrendingDown, TrendingUp } from '@lucide/vue'
const { t, lang, num } = useLang()
const { state, symbol } = useTerminal()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const pick = ref('')
const d = ref<any>(null)
const error = ref('')
const busy = ref(false)
let timer: any
const list = computed(() => (state.value?.watchlist || []).map((w: any) => w.symbol))
const running = computed(() => d.value?.job?.state === 'RUNNING')
async function load() { if (!pick.value) return; try { d.value = await api(`lab?symbol=${encodeURIComponent(pick.value)}`) } catch (e: any) { error.value = e.message } }
async function run() {
  busy.value = true
  error.value = ''
  try { await api('lab/run', { symbol: pick.value, lang: lang.value }); await load() } catch (e: any) { error.value = e.message } finally { busy.value = false }
}
async function setGate(on: boolean) { error.value = ''; try { await api('lab/gate', { on }); await load() } catch (e: any) { error.value = e.message } }
watch(list, (x) => { if (!pick.value && x.length) pick.value = x.includes(symbol.value) ? symbol.value : x[0] }, { immediate: true })
watch(pick, () => { d.value = null; error.value = ''; load() })
watch(running, (now, before) => { if (before && !now && d.value?.job?.state === 'FAILED') error.value = L('تعذّر إكمال التحليل. حاول مرة أخرى', 'The analysis did not finish. Please try again') })
onMounted(() => { load(); timer = setInterval(() => { if (running.value || busy.value) load() }, 1500) })
onBeforeUnmount(() => clearInterval(timer))

const r = computed(() => d.value?.report || null)
const q = computed(() => (r.value?.quant?.available ? r.value.quant : null))
const h = computed(() => r.value?.facts?.health || null)
const p = (x: any, n = 0) => (typeof x === 'number' ? `${(x * 100).toFixed(n)}%` : '—')
const big = (x: any) => (typeof x !== 'number' ? '—' : Math.abs(x) >= 1e12 ? `$${(x / 1e12).toFixed(2)}T` : Math.abs(x) >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`)
const VERDICT = computed<Record<string, { t: string, s: string, c: string, i: any }>>(() => ({
  SUPPORT: { t: L('يميل إلى التأييد', 'Leans in favour'), s: L('الأدلة تميل إلى التأييد، وتبقى حدودك والفحص الشرعي قبل أي شراء.', 'The evidence leans in favour; your limits and the Sharia check still come first.'), c: 'bg-brand text-white', i: TrendingUp },
  NEUTRAL: { t: L('غير حاسم', 'Not decisive'), s: L('الأدلة متعارضة أو ضعيفة.', 'The evidence is mixed or thin.'), c: 'bg-sun text-sun-foreground', i: Minus },
  AVOID: { t: L('يميل إلى التجنب', 'Leans against'), s: L('المخاطر أو الأدلة السلبية غالبة الآن.', 'Risks or negative evidence dominate now.'), c: 'bg-[#0d0f26] text-white', i: TrendingDown },
  UNKNOWN: { t: L('معلومات غير كافية', 'Not enough information'), s: L('لا تكفي المعلومات المتاحة لرأي.', 'There is too little information for a view.'), c: 'bg-secondary text-secondary-foreground', i: CircleAlert },
}))
const SHORT = computed<Record<string, string>>(() => ({ SUPPORT: L('تأييد', 'For'), NEUTRAL: L('محايد', 'Neutral'), AVOID: L('تجنب', 'Against') }))
const VIEWS = computed(() => [['trend', L('الاتجاه', 'Trend')], ['model', L('النماذج المتعلمة', 'Learning models')], ['company', L('قوة الشركة', 'Company strength')], ['price', L('السعر مقابل القيمة', 'Price against value')], ['earnings', L('الأرباح والتقديرات', 'Earnings and estimates')], ['people', L('الصناديق والمطلعون', 'Funds and insiders')], ['news', L('الأخبار', 'News')]])
const TEAM = computed(() => [['data', L('جمع المعلومات', 'Collecting information')], ['numbers', L('الحسابات', 'Calculations')], ['technical', L('محلل السعر', 'Price analyst')], ['quant', L('محلل الإحصاء', 'Statistics analyst')], ['company', L('محلل الشركة', 'Company analyst')], ['news', L('محلل الأخبار', 'News analyst')], ['risk', L('مسؤول المخاطر', 'Risk officer')], ['supporter', L('المؤيد', 'The supporter')], ['challenger', L('المعارض', 'The challenger')], ['chair', L('رئيس اللجنة', 'The chair')]])
const steps = computed(() => TEAM.value.filter(([k]) => d.value?.agentsReady || ['data', 'numbers'].includes(k!)))
// chart of the simulated range: one hue, the middle line labelled, limits named in the table beside it
const W = 640; const H = 220
const fan = computed(() => {
  const b = q.value?.monteCarlo?.bands
  if (!b) return null
  const all = b.flat(); const lo = Math.min(...all, q.value.price); const hi = Math.max(...all, q.value.price)
  const x = (i: number) => (i / b.length) * W; const y = (v: number) => H - 8 - ((v - lo) / (hi - lo || 1)) * (H - 16)
  const start = `${x(0)},${y(q.value.price)}`
  const area = (a: number, c: number) => `M${start} ${b.map((r: number[], i: number) => `L${x(i + 1)},${y(r[c]!)}`).join(' ')} ${[...b].reverse().map((r: number[], i: number) => `L${x(b.length - i)},${y(r[a]!)}`).join(' ')} Z`
  return { wide: area(0, 4), mid: area(1, 3), line: `M${start} ${b.map((r: number[], i: number) => `L${x(i + 1)},${y(r[2]!)}`).join(' ')}`, y0: y(q.value.price), last: b[b.length - 1] }
})
const when = (x: number) => new Date(x).toLocaleString('en-GB')
</script>

<template>
  <div>
    <div class="row"><UiNativeSelect v-model="pick" :aria-label="t('symbol')"><option v-for="x in list" :key="x" :value="x">{{ x }}</option></UiNativeSelect><UiButton variant="default" :disabled="busy || running || !pick || !d?.live" @click="run"><Loader v-if="running" class="animate-spin" />{{ running ? L('جارٍ التحليل', 'Analyzing') : L('حلّل الآن', 'Analyze now') }}</UiButton><span v-if="r" class="small muted">{{ L('آخر تحليل', 'Last analysis') }} <span class="num">{{ when(r.at) }}</span></span></div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="d && !d.live" class="muted">{{ L('التحليل يعمل مع الأسعار الحقيقية فقط. ابدأ محاكاة بأسعار حقيقية من الإعدادات.', 'Analysis works with real prices only. Start a simulation with real prices in Settings.') }}</p>

    <UiCard v-if="running"><h2>{{ L('الفريق يعمل', 'The team at work') }}</h2><ol class="!m-0 grid !list-none gap-2 !p-0 sm:grid-cols-2 lg:grid-cols-5"><li v-for="[k, n] in steps" :key="k" class="flex items-center gap-2.5 rounded-2xl border px-4 py-3 text-sm" :class="d.job.steps[k!]?.state === 'start' && 'border-primary bg-secondary'"><Check v-if="d.job.steps[k!]?.state === 'done'" class="size-5 shrink-0 text-up" /><Loader v-else-if="d.job.steps[k!]?.state === 'start'" class="size-5 shrink-0 animate-spin text-primary" /><CircleAlert v-else-if="d.job.steps[k!]?.state === 'failed'" class="size-5 shrink-0 text-warn" /><i v-else class="size-5 shrink-0 rounded-full border-2" />{{ n }}</li></ol></UiCard>

    <template v-if="r">
      <section class="rise mb-4 rounded-3xl p-6 sm:p-8" :class="VERDICT[r.verdict]?.c"><div class="flex flex-wrap items-center gap-5"><component :is="VERDICT[r.verdict]?.i" class="size-12 shrink-0" aria-hidden="true" /><div class="min-w-0 flex-1"><h2 class="!m-0 !text-3xl"><bdi>{{ r.symbol }}</bdi>: {{ VERDICT[r.verdict]?.t }}</h2><p class="!m-0 mt-1">{{ VERDICT[r.verdict]?.s }}</p></div><div v-if="r.agents" class="text-center"><b class="num block font-display text-4xl">{{ r.agents.confidence }}%</b><span class="text-sm">{{ L('ثقة اللجنة', 'Committee confidence') }}</span></div></div>
        <p v-if="d.sharia !== 'PASS'" class="!m-0 mt-5 rounded-2xl bg-black/15 px-4 py-3 font-medium">{{ L('لا شراء قبل حسم الفحص الشرعي، مهما كانت نتيجة التحليل.', 'Nothing is bought before the Sharia check is settled, whatever the analysis says.') }}</p></section>

      <div class="cols">
        <div>
          <UiCard v-if="r.agents"><h2>{{ L('رأي اللجنة', 'The committee\'s view') }}</h2><p v-if="r.agents.summary">{{ r.agents.summary }}</p>
            <div class="grid gap-4 sm:grid-cols-3"><div v-for="[k, n] in [['reasons', L('الأسباب', 'Reasons')], ['risks', L('المخاطر', 'Risks')], ['wouldChange', L('ما يغيّر الرأي', 'What would change it')]]" :key="k"><b>{{ n }}</b><ul><li v-for="x in r.agents[k!]" :key="x">{{ x }}</li><li v-if="!r.agents[k!].length" class="muted">—</li></ul></div></div>
            <div class="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5"><div v-for="[k, n] in TEAM.slice(2, 7)" :key="k" class="rounded-2xl border p-4"><div class="flex items-center justify-between gap-2"><b class="text-sm">{{ n }}</b><UiBadge v-if="r.agents.views[k!]?.verdict">{{ SHORT[r.agents.views[k!].verdict] }}</UiBadge></div><p class="small muted !m-0 mt-2">{{ r.agents.views[k!]?.points?.[0] || L('لم يُكمل', 'Did not finish') }}</p></div></div>
            <p class="small muted !m-0 mt-4">{{ L('صوّت رئيس اللجنة', 'The chair voted') }} <span class="num">{{ r.agents.votes }}</span> {{ L('مرات، واتفقت', 'times;') }} <span class="num">{{ p(r.agents.agreement) }}</span> {{ L('منها. وحُذفت', 'agreed.') }} <span class="num">{{ r.agents.dropped }}</span> {{ L('جملة لم تُسند أرقامها إلى الأدلة.', 'sentences were removed because the evidence did not support their numbers.') }}</p></UiCard>
          <UiCard v-else><h2>{{ L('رأي اللجنة', 'The committee\'s view') }}</h2><p class="muted">{{ d.agentsReady ? L('لم يُكمل المحللون هذه المرة. النتيجة أعلاه من القواعد والحسابات.', 'The analysts did not finish this time. The result above comes from rules and calculations.') : L('النتيجة من القواعد والحسابات. محللو الذكاء الاصطناعي غير مفعّلين بعد.', 'The result comes from rules and calculations. The AI analysts are not switched on yet.') }}</p></UiCard>

          <UiCard v-if="fan"><h2>{{ L('المدى المتوقع خلال 20 يوم تداول', 'Simulated range over 20 trading days') }}</h2>
            <div dir="ltr"><svg :viewBox="`0 0 ${W} ${H}`" class="w-full" role="img" :aria-label="L('رسم المدى المتوقع', 'Simulated range chart')"><path :d="fan.wide" fill="var(--primary)" opacity="0.14" /><path :d="fan.mid" fill="var(--primary)" opacity="0.26" /><line x1="0" :y1="fan.y0" :x2="W" :y2="fan.y0" stroke="var(--muted-foreground)" stroke-dasharray="4 5" /><path :d="fan.line" fill="none" stroke="var(--primary)" stroke-width="2.5" class="draw" pathLength="1" /></svg></div>
            <div class="tiles !mt-3 !mb-0"><div class="tile"><span class="small muted">{{ L('الآن', 'Now') }}</span><b class="num">{{ num(q.price) }}</b></div><div class="tile"><span class="small muted">{{ L('حالة سيئة (1 من 20)', 'Bad case (1 in 20)') }}</span><b class="num">{{ num(fan.last[0]) }}</b></div><div class="tile"><span class="small muted">{{ L('الوسط', 'Middle') }}</span><b class="num">{{ num(fan.last[2]) }}</b></div><div class="tile"><span class="small muted">{{ L('حالة جيدة (1 من 20)', 'Good case (1 in 20)') }}</span><b class="num">{{ num(fan.last[4]) }}</b></div></div>
            <p class="small muted !m-0 mt-3">{{ L('محاكاة من أيام سابقة بتقلب اليوم. ليست توقعًا للسعر.', 'Simulated from past days at today\'s volatility. It is not a price prediction.') }}</p></UiCard>

          <UiCard v-if="h"><h2>{{ L('الشركة', 'The company') }} <span class="small muted">{{ r.facts.industry }} · {{ h.period }}</span></h2><div class="tiles !mb-0"><div v-for="[n, v] in [[L('القيمة السوقية', 'Market value'), big(h.marketCap)], [L('نمو الإيرادات', 'Revenue growth'), p(h.revenueGrowth)], [L('هامش الربح', 'Profit margin'), p(h.netMargin)], [L('النقد الحر من الإيرادات', 'Free cash of revenue'), p(h.freeCashMargin)], [L('الدين إلى حقوق الملكية', 'Debt to equity'), p(h.debtToEquity)], [L('مكرر الربح', 'Price to earnings'), num(h.pe, 1)], [L('علامات الصحة', 'Health signs'), h.piotroski ? `${h.piotroski.score}/${h.piotroski.of}` : '—'], [L('النمو الذي يفترضه السعر', 'Growth the price assumes'), p(h.pricedInGrowth)]]" :key="n" class="tile"><span class="small muted">{{ n }}</span><b class="num">{{ v }}</b></div></div></UiCard>
        </div>
        <div>
          <UiCard><h2>{{ L('لماذا هذه النتيجة', 'Why this result') }}</h2><div v-for="[k, n] in VIEWS" :key="k" class="border-b py-2.5 last:border-0"><div class="flex items-center justify-between gap-3"><span class="font-medium">{{ n }}</span><span v-if="r.rules.views[k!]" class="relative h-2 w-24 rounded-full bg-muted" role="img" :aria-label="`${n} ${Math.round(r.rules.views[k!].score * 100)}`"><i class="absolute inset-y-0 rounded-full" :class="r.rules.views[k!].score >= 0 ? 'bg-up' : 'bg-down'" :style="{ [r.rules.views[k!].score >= 0 ? 'insetInlineStart' : 'insetInlineEnd']: '50%', width: `${Math.max(3, Math.abs(r.rules.views[k!].score) * 50)}%` }" /></span><span v-else class="small muted">{{ t('nf') }}</span></div><ul v-if="r.rules.views[k!]" class="small muted !m-0 mt-1"><li v-for="x in r.rules.views[k!].reasons" :key="x.en">{{ ar ? x.ar : x.en }}</li></ul></div></UiCard>
          <UiCard v-if="r.rules.cautions.length"><h2>{{ L('تنبيهات', 'Cautions') }}</h2><ul class="!m-0"><li v-for="x in r.rules.cautions" :key="x.en" class="text-down">{{ ar ? x.ar : x.en }}</li></ul></UiCard>
          <UiCard v-if="q"><h2>{{ L('المخاطر', 'Risk') }}</h2><dl class="!m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2"><template v-for="[n, v] in [[L('خسارة يوم سيئ (1 من 20)', 'Bad day loss (1 in 20)'), p(q.risk.var95, 1)], [L('متوسط الأيام الأسوأ', 'Average of the worst days'), p(q.risk.cvar95, 1)], [L('أكبر تراجع سابق', 'Largest past drop'), p(q.risk.drawdown.max)], [L('مرحلة مضطربة', 'Turbulent phase'), p(q.regime?.turbulentProb)], [L('الحركة مع السوق', 'Moves with the market'), num(q.market?.beta, 2)], [L('حجم مركز معتدل', 'Moderate position size'), `${num(q.sizing.pct, 1)}%`]]" :key="n"><dt class="muted">{{ n }}</dt><dd class="num !m-0 font-semibold">{{ v }}</dd></template></dl></UiCard>
          <UiCard v-if="q?.forecast?.available"><h2>{{ L('هل تستطيع النماذج التوقع؟', 'Can the models predict?') }}</h2><p :class="q.forecast.edge ? 'up' : 'muted'">{{ q.forecast.edge ? L('تفوقت على التخمين البسيط في أيام لم ترها.', 'They beat a simple guess on days they had not seen.') : L('لا. لم تتفوق على التخمين البسيط، فلم تُحسب.', 'No. They did not beat a simple guess, so they were not counted.') }}</p><p class="small muted !m-0">{{ L('أصابت', 'Right on') }} <span class="num">{{ p(q.forecast.accuracy) }}</span> {{ L('من', 'of') }} <span class="num">{{ q.forecast.tested }}</span> {{ L('يومًا، والتخمين البسيط', 'days; a simple guess') }} <span class="num">{{ p(q.forecast.naiveAccuracy) }}</span>.<template v-if="q.analogues"> {{ L('في', 'In') }} <span class="num">{{ q.analogues.count }}</span> {{ L('فترة مشابهة ارتفع السعر بعدها في', 'similar periods the price then rose in') }} <span class="num">{{ p(q.analogues.upShare) }}</span>.</template></p></UiCard>
          <UiCard v-if="r.facts?.news?.items?.length"><h2>{{ t('news') }}</h2><article v-for="n in r.facts.news.items.slice(0, 6)" :key="n.title" class="item small"><a v-if="n.url" :href="n.url" target="_blank" rel="noopener noreferrer"><bdi>{{ n.title }}</bdi></a><bdi v-else>{{ n.title }}</bdi></article></UiCard>
        </div>
      </div>
    </template>
    <UiCard v-if="d"><label class="flex items-center gap-3"><UiSwitch :model-value="d.gate" @update:model-value="setGate" /><span><b class="block">{{ L('امنع الشراء الآلي إذا كانت النتيجة «تجنب»', 'Block automatic buying when the result leans against') }}</b><span class="small muted">{{ L('ليوم واحد بعد التحليل. التحليل لا يشتري ولا يتجاوز الفحص الشرعي أو حدود المخاطر.', 'For one day after the analysis. Analysis never buys and never skips the Sharia check or risk limits.') }}</span></span></label>
      <p class="small muted !m-0 mt-4"><template v-if="d.record.graded">{{ L('سجل اللجنة: أصابت', 'Committee record: right') }} <span class="num">{{ d.record.right }}/{{ d.record.graded }}</span>. </template><template v-else>{{ L('يُقيَّم كل رأي بعد 5 أيام تداول. لا نتائج بعد.', 'Every result is graded after 5 trading days. None yet.') }} </template>{{ L('أداة دراسة للتداول الورقي، وليست نصيحة استثمارية.', 'A study tool for paper trading, not investment advice.') }}</p></UiCard>
  </div>
</template>
