<script setup lang="ts">
import { CircleAlert, Flag, Loader, Trash2 } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { lang, num } = useLang()
const { state } = useTerminal()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const d = ref<any>(null)
const error = ref('')
const busy = ref(false)
const f = reactive({ symbol: '', amount: 1000 as any, days: 30 as any, goalPct: '' as any, ai: true })
const v = reactive({ entry: '' as any, stop: '' as any, target: '' as any, near: 0.05 as any, follow: false })
const s = ref<any>(null)
const g = reactive({ name: '', amount: '' as any, by: '' })
const edit = ref<any>(null)
const leaving = ref<any>(null)
let timer: any
let tick = 0
async function load() { try { d.value = await api('invest'); const j = d.value.job; if (j?.state === 'DONE' && j.result && s.value?.at !== j.result.at && seen !== j.result.at) take(j.result); if (j?.state === 'FAILED' && failed !== j.startedAt) { failed = j.startedAt; error.value = plain.error(j.error, ar.value) } } catch (e: any) { error.value = plain.error(e.message, ar.value) } }
let seen = 0
let failed = 0
function take(r: any) { seen = r.at; s.value = r; v.entry = r.entry; v.stop = r.stop; v.target = r.target; f.symbol = r.symbol; f.amount = r.amount; f.days = r.days }
async function act(fn: () => Promise<any>) { busy.value = true; error.value = ''; try { return await fn() } catch (e: any) { error.value = plain.error(e.message, ar.value); return null } finally { busy.value = false } }
const running = computed(() => d.value?.job?.state === 'RUNNING')
async function suggest() { s.value = null; await act(() => api('invest/suggest', { ...f, lang: lang.value })); await load() }
async function start() {
  const r = s.value
  const own = !r || [r.entry, r.stop, r.target].some((x: number, i: number) => x !== Number([v.entry, v.stop, v.target][i]))
  const x = await act(() => api('invest', { symbol: r?.symbol || f.symbol, amount: f.amount, days: f.days, entry: v.entry, stop: v.stop, target: v.target, near: Number(v.near), follow: v.follow, reason: own ? 'OWN' : r.byAI ? 'AI' : 'RULES' }))
  if (x) { d.value = x; s.value = null }
}
async function stopIt(id: string) { leaving.value = null; const x = await act(() => api('invest/cancel', { id })); if (x) d.value = x }
async function saveEdit() { const e = edit.value; const x = await act(() => api('invest/update', { id: e.id, ...(e.status === 'WAITING' ? { entry: e.entry } : {}), stop: e.stop, target: e.target, near: Number(e.near) })); if (x) { d.value = x; edit.value = null } }
async function addGoal() { const x = await act(() => api('invest/goal', { ...g })); if (x) { d.value = x; g.name = ''; g.amount = ''; g.by = '' } }
async function drop(id: string) { const x = await act(() => api('invest/goal/remove', { id })); if (x) d.value = x }
onMounted(() => { load(); timer = setInterval(() => { tick++; if (running.value || tick % 2 === 0) load() }, 2000) })
onBeforeUnmount(() => clearInterval(timer))
watch(() => state.value?.watchlist, (w: any) => { if (!f.symbol && w?.length) f.symbol = w[0].symbol }, { immediate: true })

const pct = (x: any, n = 0) => (typeof x === 'number' ? `${(x * 100).toFixed(n)}%` : '—')
const money = (x: any) => (typeof x === 'number' ? `$${num(x)}` : '—')
const day = (x: number) => new Date(x).toLocaleDateString('en-GB')
const open = computed(() => (d.value?.items || []).filter((x: any) => ['WAITING', 'OPEN'].includes(x.status)))
const past = computed(() => (d.value?.items || []).filter((x: any) => !['WAITING', 'OPEN'].includes(x.status)))
const STEP = computed<Record<string, string>>(() => ({ data: L('جمع الأسعار', 'Collecting prices'), team: L('فريق المحللين يعمل، وقد يستغرق دقيقة أو دقيقتين', 'The analysts are working; this can take a minute or two'), prices: L('اختيار أسعار البداية والوقف والهدف', 'Choosing the start, stop and target'), chances: L('حساب الاحتمالات', 'Working out the chances') }))
const VERDICT = computed<Record<string, string>>(() => ({ SUPPORT: L('التحليل يميل إلى التأييد', 'The analysis leans in favour'), NEUTRAL: L('التحليل غير حاسم', 'The analysis is undecided'), AVOID: L('التحليل يميل إلى التجنب', 'The analysis leans against'), UNKNOWN: L('معلومات غير كافية', 'Not enough information') }))
const WHY = computed<Record<string, string>>(() => ({ ANALYSTS: L('اختاره المحللون', 'Chosen by the analysts'), NOW: L('السعر الحالي مناسب للبداية', 'The price now is a fair start'), STRETCHED: L('ارتفع السعر كثيرًا، فالأفضل انتظار نزوله', 'The price has run up, so wait for it to come down'), AVOID: L('التحليل ضده الآن، فالبداية أقل من السعر الحالي', 'The analysis is against it now, so the start is below the price'), LOW: L('تحت أدنى سعر في آخر 10 أيام', 'Below the lowest price of the last 10 days'), RANGE: L('خارج حركته المعتادة', 'Outside its usual movement'), GOAL: L('الربح الذي طلبته', 'The gain you asked for'), TWICE: L('ضعف ما تخاطر به', 'Twice what you risk') }))
const WAIT = computed<Record<string, string>>(() => ({ START: L('ينتظر سعر البداية', 'Waiting for the start price'), AUTOMATION: L('ينتظر تشغيل التداول الآلي', 'Waiting for automation to start'), ANALYSIS: L('التحليل يميل إلى التجنب، والمنع مفعّل في صفحة التحليل', 'The analysis leans against it, and blocking is on in the Analysis page'), LIMITS: L('الشراء متوقف بسبب حدود الخسارة أو الصفقات', 'Buying is stopped by your loss or trade limits'), PAUSED: L('المتابعة متوقفة', 'Following is paused'), CLOSED: L('ينتظر فتح السوق', 'Waits for the market to open'), PRICE: L('ينتظر سعرًا مؤكدًا', 'Waits for a reliable price'), SPREAD: L('الفرق بين البيع والشراء كبير', 'The buy and sell prices are far apart'), SMALL: L('المبلغ أقل من سهم واحد', 'The amount is less than one share'), CASH: L('النقد غير كافٍ', 'Not enough cash') }))
const END = computed<Record<string, string>>(() => ({ TAKE_PROFIT: L('بلغ الهدف', 'Reached the target'), STOP: L('بلغ الوقف', 'Reached the stop'), TRAILING_STOP: L('وقف متحرك', 'Moving stop'), GOAL: L('انتهت المدة', 'Time was up'), USER: L('قرارك', 'Your decision'), TIME: L('لم يصل إلى سعر البداية', 'Never reached the start'), PASSED: L('نزل تحت الوقف قبل الشراء', 'Fell below the stop before buying'), RESET: L('بدأت محاكاة جديدة', 'A new simulation started') }))
const LEVEL = computed<Record<string, string>>(() => ({ DONE: L('بلغته', 'Reached'), CALM: L('نمو هادئ', 'Calm growth'), HARD: L('نمو طموح', 'Ambitious growth'), VERY: L('طموح جدًا، ويحتاج إلى مخاطرة عالية', 'Very ambitious and needs high risk'), UNLIKELY: L('غير واقعي. زد المدة أو قلّل المبلغ', 'Not realistic. Allow more time or lower the amount') }))
const PERIODS = computed(() => [[7, L('أسبوع', 'One week')], [30, L('شهر', 'One month')], [90, L('3 أشهر', '3 months')], [180, L('6 أشهر', '6 months')], [365, L('سنة', 'One year')]] as [number, string][])
const risk = computed(() => { const [e, st, t, a] = [v.entry, v.stop, v.target, f.amount].map(Number) as [number, number, number, number]; return e > 0 && st > 0 && t > 0 && st < e && e < t ? { lose: (a * (e - st)) / e, win: (a * (t - e)) / e } : null })
// price line of the last days with the three prices
const W = 640; const H = 200
const chart = computed(() => {
  const h: number[] = s.value?.history || []
  if (h.length < 2) return null
  const [e, st, t] = [v.entry, v.stop, v.target].map(Number) as [number, number, number]
  const all = [...h, e, st, t].filter((x) => x > 0); const lo = Math.min(...all); const hi = Math.max(...all)
  const y = (x: number) => H - 10 - ((x - lo) / (hi - lo || 1)) * (H - 20)
  return { line: h.map((x, i) => `${i ? 'L' : 'M'}${(i / (h.length - 1)) * W},${y(x)}`).join(' '), marks: [[t, 'var(--up)'], [e, 'var(--primary)'], [st, 'var(--down)']].filter(([x]) => Number(x) > 0).map(([x, c]) => [y(x as number), c] as [number, string]) }
})
const pos = (x: any) => { const r = x.target - x.stop; return x.price && r > 0 ? Math.min(100, Math.max(0, ((x.price - x.stop) / r) * 100)) : 0 }
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="d && !d.session" class="muted">{{ L('ابدأ محاكاة من لوحة التداول أولًا.', 'Start a simulation from the trading page first.') }}</p>

    <div class="cols">
      <div>
        <UiCard><h2>{{ L('استثمار جديد', 'New investment') }}</h2>
          <form class="grid gap-4 sm:grid-cols-2" @submit.prevent="suggest">
            <label class="grid gap-1.5"><span class="small muted">{{ L('الرمز', 'Symbol') }}</span><UiInput v-model="f.symbol" dir="ltr" list="known" placeholder="NVDA, BTC/USD, PAXG/USD" required /><datalist id="known"><option v-for="w in state?.watchlist || []" :key="w.symbol" :value="w.symbol" /></datalist></label>
            <label class="grid gap-1.5"><span class="small muted">{{ L('المبلغ بالدولار', 'Amount in dollars') }}<template v-if="typeof d?.free === 'number'"> · {{ L('المتاح', 'free') }} <span class="num">{{ money(d.free) }}</span></template></span><UiInput v-model="f.amount" type="number" min="10" step="any" inputmode="decimal" required /></label>
            <label class="grid gap-1.5"><span class="small muted">{{ L('المدة', 'How long') }}</span><UiNativeSelect v-model="f.days"><option v-for="[n, x] in PERIODS" :key="n" :value="n">{{ x }}</option></UiNativeSelect></label>
            <label class="grid gap-1.5"><span class="small muted">{{ L('الربح المطلوب % (اختياري)', 'Gain wanted % (optional)') }}</span><UiInput v-model="f.goalPct" type="number" min="1" max="300" step="any" inputmode="decimal" :placeholder="L('يختاره التحليل', 'Let the analysis choose')" /></label>
            <label class="flex items-center gap-3 sm:col-span-2"><UiSwitch :model-value="f.ai" @update:model-value="f.ai = $event" /><span><b class="block">{{ L('استعن بفريق المحللين', 'Use the team of analysts') }}</b><span v-if="d && !d.agentsReady" class="small muted">{{ L('المحللون غير مفعّلين في حسابك، وستأتي الأسعار من القواعد والحسابات.', 'The analysts are not active in your account; prices come from rules and calculations.') }}</span></span></label>
            <div class="sm:col-span-2"><UiButton type="submit" variant="default" :disabled="busy || running || !d?.session"><Loader v-if="running" class="size-4 animate-spin" aria-hidden="true" />{{ running ? L('يحلل…', 'Analysing…') : L('حلّل واقترح الأسعار', 'Analyse and suggest prices') }}</UiButton><p v-if="running" class="small muted !m-0 mt-2" role="status">{{ STEP[d.job.step] }}</p></div>
          </form></UiCard>

        <UiCard v-if="s" class="rise"><div class="flex flex-wrap items-center justify-between gap-3"><h2><bdi>{{ s.symbol }}</bdi> <span class="num muted">{{ money(s.price) }}</span></h2><UiBadge :tone="s.verdict === 'SUPPORT' ? 'PASS' : s.verdict === 'AVOID' ? 'FAIL' : 'UNKNOWN'">{{ VERDICT[s.verdict || 'UNKNOWN'] }}</UiBadge></div>
          <div v-if="chart" dir="ltr"><svg :viewBox="`0 0 ${W} ${H}`" class="w-full" role="img" :aria-label="L('السعر مع البداية والوقف والهدف', 'Price with the start, stop and target')"><line v-for="[y, c] in chart.marks" :key="c" x1="0" :x2="W" :y1="y" :y2="y" :stroke="c" stroke-width="2" stroke-dasharray="6 5" /><path :d="chart.line" fill="none" stroke="var(--foreground)" stroke-width="2" /></svg></div>
          <div class="mt-4 grid gap-4 sm:grid-cols-3">
            <label class="grid gap-1.5"><b class="text-primary">{{ L('ابدأ عند أو أقل', 'Start at or below') }}</b><UiInput v-model="v.entry" type="number" step="any" min="0" inputmode="decimal" /><span class="small muted">{{ WHY[s.why.entry] }}</span></label>
            <label class="grid gap-1.5"><b class="down">{{ L('أوقف عند', 'Stop at') }}</b><UiInput v-model="v.stop" type="number" step="any" min="0" inputmode="decimal" /><span class="small muted">{{ WHY[s.why.stop] }}</span></label>
            <label class="grid gap-1.5"><b class="up">{{ L('بِع بربح عند', 'Sell with a gain at') }}</b><UiInput v-model="v.target" type="number" step="any" min="0" inputmode="decimal" /><span class="small muted">{{ WHY[s.why.target] }}</span></label>
          </div>
          <p v-if="s.note" class="mt-4">{{ s.note }}</p>
          <p class="small muted">{{ s.byAI ? L('اختار المحللون الأسعار داخل حدود آمنة.', 'The analysts chose the prices inside safe limits.') : L('الأسعار من القواعد والحسابات.', 'The prices come from rules and calculations.') }}</p>
          <div v-if="s.odds" class="tiles"><div class="tile"><span class="small muted">{{ L('يبلغ الهدف أولًا', 'Target first') }}</span><b class="num up">{{ pct(s.odds.target) }}</b></div><div class="tile"><span class="small muted">{{ L('يبلغ الوقف أولًا', 'Stop first') }}</span><b class="num down">{{ pct(s.odds.stop) }}</b></div><div class="tile"><span class="small muted">{{ L('لا هذا ولا ذاك', 'Neither in time') }}</span><b class="num">{{ pct(s.odds.neither) }}</b></div></div>
          <p v-if="s.odds" class="small muted !mt-0">{{ L('النسب للأسعار المقترحة، من أيام سابقة ودون افتراض أن المكاسب تتكرر. ليست توقعًا.', 'For the suggested prices, from past days, without assuming gains repeat. Not a prediction.') }}</p>
          <p v-if="risk"><span class="down">{{ L('قد تخسر نحو', 'You could lose about') }} <span class="num">{{ money(risk.lose) }}</span></span> · <span class="up">{{ L('أو تربح نحو', 'or gain about') }} <span class="num">{{ money(risk.win) }}</span></span> <span class="small muted">{{ L('قبل الرسوم، وقد يكون البيع بسعر أقل إذا قفز السعر.', 'before fees; a sudden jump can sell lower.') }}</span></p>
          <p v-else class="err">{{ L('يجب أن يكون الوقف أقل من البداية والهدف أعلى منها.', 'The stop must be below the start and the target above it.') }}</p>
          <div class="grid gap-4 sm:grid-cols-2"><label class="grid gap-1.5"><span class="small muted">{{ L('نفّذ إذا اقترب السعر', 'Act when the price is within') }}</span><UiNativeSelect v-model="v.near"><option v-for="n in [0, 0.05, 0.1, 0.25, 0.5]" :key="n" :value="n">{{ n ? `${n}%` : L('السعر نفسه فقط', 'The exact price only') }}</option></UiNativeSelect><span class="small muted">{{ L('مثال: هدف 72.99 يُباع عند 72.98 مع قرب 0.05%. والوقف يبيع فور بلوغه أو النزول تحته.', 'Example: a 72.99 target sells at 72.98 within 0.05%. The stop sells as soon as it is reached or passed.') }}</span></label><label class="flex items-start gap-3"><UiSwitch :model-value="v.follow" @update:model-value="v.follow = $event" /><span><b class="block">{{ L('ارفع الوقف مع السعر', 'Raise the stop with the price') }}</b><span class="small muted">{{ L('كلما ارتفع السعر ارتفع الوقف معه، ولا ينزل أبدًا.', 'As the price rises the stop rises with it, and it never moves down.') }}</span></span></label></div>
          <div class="row mt-5"><UiButton variant="default" :disabled="busy || !risk" @click="start">{{ L('ابدأ الاستثمار', 'Start the investment') }}</UiButton><UiButton :disabled="busy" @click="s = null">{{ L('تجاهل', 'Dismiss') }}</UiButton></div>
          <p class="small muted !m-0 mt-2">{{ L('يشتري ويبيع وحده في محفظتك الورقية عند بلوغ الأسعار. تداول ورقي وليس نصيحة.', 'It buys and sells by itself in your paper portfolio when the prices are reached. Paper trading, not advice.') }}</p></UiCard>

        <UiCard v-if="open.length"><h2>{{ L('استثمارات قائمة', 'Running investments') }}</h2>
          <div v-for="x in open" :key="x.id" class="border-b py-4 last:border-0"><div class="flex flex-wrap items-center gap-3"><b class="text-lg"><bdi>{{ x.symbol }}</bdi></b><UiBadge :tone="x.status === 'OPEN' ? 'PASS' : 'UNKNOWN'">{{ x.status === 'OPEN' ? L('مفتوح', 'Open') : L('ينتظر', 'Waiting') }}</UiBadge><span class="flex-1" /><span class="num">{{ money(x.price) }}</span><b v-if="typeof x.gain === 'number'" class="num" :class="x.gain >= 0 ? 'up' : 'down'">{{ pct(x.gain, 2) }}</b></div>
            <div class="mt-3 h-2 overflow-hidden rounded-full bg-secondary" dir="ltr" aria-hidden="true"><span class="block h-full rounded-full bg-primary" :style="{ width: `${pos(x)}%` }" /></div>
            <div class="small mt-2 grid grid-cols-3 gap-2" dir="ltr"><span class="down">{{ L('الوقف', 'Stop') }} <span class="num">{{ money(x.stop) }}</span></span><span class="text-center">{{ x.status === 'OPEN' ? L('اشتُري', 'Paid') : L('البداية', 'Start') }} <span class="num">{{ money(x.paid || x.entry) }}</span></span><span class="up text-end">{{ L('الهدف', 'Target') }} <span class="num">{{ money(x.target) }}</span></span></div>
            <p class="small muted !mb-0 mt-2">{{ money(x.amount) }} · {{ L('ينتهي', 'ends') }} <span class="num">{{ day(x.until) }}</span><template v-if="x.status === 'WAITING'"> · {{ L('يبدأ قبل', 'must start by') }} <span class="num">{{ day(x.startBy) }}</span></template></p>
            <p v-if="x.status === 'WAITING' && x.wait" class="small !mb-0 mt-1 flex items-center gap-1.5"><CircleAlert class="size-4 shrink-0" aria-hidden="true" />{{ WAIT[x.wait] || WAIT.PRICE }}</p>
            <form v-if="edit?.id === x.id" class="mt-3 grid gap-3 sm:grid-cols-4" @submit.prevent="saveEdit"><label v-if="x.status === 'WAITING'" class="grid gap-1 small">{{ L('البداية', 'Start') }}<UiInput v-model="edit.entry" type="number" step="any" /></label><label class="grid gap-1 small">{{ L('الوقف', 'Stop') }}<UiInput v-model="edit.stop" type="number" step="any" /></label><label class="grid gap-1 small">{{ L('الهدف', 'Target') }}<UiInput v-model="edit.target" type="number" step="any" /></label><div class="row sm:col-span-4"><UiButton type="submit" variant="default" size="sm" :disabled="busy">{{ L('احفظ', 'Save') }}</UiButton><UiButton size="sm" @click="edit = null">{{ L('تراجع', 'Cancel') }}</UiButton></div></form>
            <div v-else class="row mt-3"><UiButton size="sm" :disabled="busy" @click="edit = { ...x }">{{ L('عدّل الأسعار', 'Change prices') }}</UiButton><UiButton size="sm" :disabled="busy" @click="leaving = x">{{ x.status === 'OPEN' ? L('بِع الآن', 'Sell now') : L('ألغِ', 'Cancel') }}</UiButton></div></div></UiCard>
      </div>
      <div>
        <UiCard><h2>{{ L('أهدافي', 'My goals') }}</h2>
          <div v-for="x in d?.goals || []" :key="x.id" class="border-b py-3 last:border-0"><div class="flex items-center gap-3"><Flag class="size-5 shrink-0 text-primary" aria-hidden="true" /><b class="min-w-0 flex-1 break-words">{{ x.name }}</b><span class="num">{{ money(x.amount) }}</span><button type="button" class="p-2" :aria-label="`${L('احذف', 'Remove')} ${x.name}`" :disabled="busy" @click="drop(x.id)"><Trash2 class="size-4" aria-hidden="true" /></button></div>
            <div class="mt-2 h-2 overflow-hidden rounded-full bg-secondary" role="img" :aria-label="pct(x.progress)"><span class="block h-full rounded-full bg-primary" :style="{ width: `${x.progress * 100}%` }" /></div>
            <p class="small muted !mb-0 mt-2"><span class="num">{{ pct(x.progress) }}</span> · {{ L('بقي', 'left') }} <span class="num">{{ x.daysLeft }}</span> {{ L('يومًا', 'days') }}<template v-if="!x.done && typeof x.perYear === 'number'"> · {{ L('يحتاج نموًا سنويًا', 'needs yearly growth of') }} <span class="num">{{ x.perYear > 9.99 ? '+999%' : pct(x.perYear) }}</span></template></p>
            <p class="small !mb-0 mt-1" :class="['VERY', 'UNLIKELY'].includes(x.level) ? 'down' : 'muted'">{{ x.done ? LEVEL.DONE : LEVEL[x.level] }}</p></div>
          <form class="mt-4 grid gap-3" @submit.prevent="addGoal"><label class="grid gap-1.5"><span class="small muted">{{ L('اسم الهدف', 'Goal name') }}</span><UiInput v-model="g.name" maxlength="40" :placeholder="L('مثال: دفعة أولى لبيت', 'For example: a home deposit')" required /></label><div class="grid gap-3 sm:grid-cols-2"><label class="grid gap-1.5"><span class="small muted">{{ L('قيمة المحفظة المطلوبة', 'Portfolio value wanted') }}</span><UiInput v-model="g.amount" type="number" min="10" step="any" inputmode="decimal" required /></label><label class="grid gap-1.5"><span class="small muted">{{ L('بحلول', 'By') }}</span><UiInput v-model="g.by" type="date" required /></label></div><div><UiButton type="submit" :disabled="busy || !d?.session">{{ L('أضف الهدف', 'Add the goal') }}</UiButton></div></form></UiCard>

        <UiCard v-if="past.length"><h2>{{ L('استثمارات انتهت', 'Finished investments') }}</h2><div v-for="x in past" :key="x.id" class="item small"><b><bdi>{{ x.symbol }}</bdi></b> · {{ END[x.end] || L('انتهى', 'Ended') }} <b v-if="typeof x.result === 'number'" class="num" :class="x.result >= 0 ? 'up' : 'down'">{{ x.result >= 0 ? '+' : '−' }}${{ num(Math.abs(x.result)) }}</b><span class="muted num block">{{ day(x.closedAt) }}<template v-if="x.soldAt"> · {{ money(x.paid) }} → {{ money(x.soldAt) }}</template></span></div></UiCard>
      </div>
    </div>
    <UiConfirm :open="!!leaving" :title="leaving?.status === 'OPEN' ? L('البيع الآن؟', 'Sell now?') : L('إلغاء الاستثمار؟', 'Cancel the investment?')" :text="leaving?.symbol" :confirm="L('نعم', 'Yes')" :cancel="L('تراجع', 'Back')" :busy="busy" @confirm="stopIt(leaving.id)" @close="leaving = null" />
  </div>
</template>
