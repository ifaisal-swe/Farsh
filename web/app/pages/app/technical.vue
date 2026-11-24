<script setup lang="ts">
import { ArrowDown, ArrowUp, Minus } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { t, lang, num } = useLang()
const { state, symbol } = useTerminal()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const say = (x: any) => (x ? (ar.value ? x.ar : x.en) : '')
const pick = ref('')
const d = ref<any>(null)
const error = ref('')
const busy = ref(false)
const tab = ref<'hours' | 'days' | 'weeks'>('days')
const list = computed(() => (state.value?.watchlist || []).map((w: any) => w.symbol))
let timer: any
let seq = 0
async function load() { if (!pick.value) return; const id = ++seq; busy.value = true; try { const x = await api(`technical?symbol=${encodeURIComponent(pick.value)}`); if (id === seq) { d.value = x; error.value = '' } } catch (e: any) { if (id === seq) error.value = plain.error(e.message, ar.value) } finally { if (id === seq) busy.value = false } }
watch(list, (x) => { if (!pick.value && x.length) pick.value = x.includes(symbol.value) ? symbol.value : x[0] }, { immediate: true })
watch(pick, () => { d.value = null; ex.value = null; load() })
onMounted(() => { timer = setInterval(load, 60000) })
onBeforeUnmount(() => { seq++; clearInterval(timer) })
const r = computed(() => d.value?.report || null)
const h = computed(() => r.value?.horizons?.[tab.value] || r.value?.horizons?.days || null)
const VIEW = computed<Record<string, string>>(() => ({ STRONG_UP: L('صاعد بقوة', 'Strongly up'), UP: L('يميل إلى الصعود', 'Leans up'), SIDE: L('بلا اتجاه', 'Sideways'), DOWN: L('يميل إلى الهبوط', 'Leans down'), STRONG_DOWN: L('هابط بقوة', 'Strongly down') }))
const BG: Record<string, string> = { STRONG_UP: 'bg-up text-white', UP: 'bg-up text-white', SIDE: 'bg-sun text-sun-foreground', DOWN: 'bg-[#0d0f26] text-white', STRONG_DOWN: 'bg-[#0d0f26] text-white' }
const GROUP = computed<Record<string, string>>(() => ({ trend: L('الاتجاه', 'Trend'), momentum: L('الزخم', 'Momentum'), volume: L('الكميات', 'Volume'), volatility: L('الحركة', 'Movement'), pattern: L('الأشكال', 'Shapes') }))
const TABS = computed(() => [['hours', L('ساعات', 'Hours')], ['days', L('أيام', 'Days')], ['weeks', L('أسابيع', 'Weeks')]] as ['hours' | 'days' | 'weeks', string][])
const SETUP = computed<Record<string, string>>(() => ({ DIP: L('شراء عند النزول إلى الدعم', 'Buy a dip to support'), BREAK: L('شراء عند تجاوز المقاومة', 'Buy a break above resistance'), PROTECT: L('حماية ما تملكه', 'Protect what you hold') }))
const pct = (x: any, n = 0) => (typeof x === 'number' ? `${(x * 100).toFixed(n)}%` : '—')
const money = (x: any) => (typeof x === 'number' ? `$${num(x)}` : '—')
const link = (x: any) => ({ path: '/app/orders', query: { symbol: pick.value, side: x.side, type: x.type, price: String(x.price), ...(x.stop ? { stop: String(x.stop) } : {}), ...(x.target ? { target: String(x.target) } : {}) } })
// practice: a past moment, the person's choice, then what happened
const ex = ref<any>(null)
const choice = ref('')
const tally = reactive({ right: 0, all: 0 })
async function next() { choice.value = ''; try { ex.value = (await api(`technical/practice?symbol=${encodeURIComponent(pick.value)}&seed=${Math.floor(Math.random() * 1e9)}`)).item } catch (e: any) { error.value = plain.error(e.message, ar.value) } }
const answer = computed(() => (!ex.value ? '' : ex.value.change > ex.value.move ? 'BUY' : ex.value.change < -ex.value.move ? 'AVOID' : 'WAIT'))
function choose(c: string) { if (choice.value) return; choice.value = c; tally.all++; if (c === answer.value) tally.right++ }
const W = 640; const H = 220
const candles = computed(() => {
  if (!ex.value) return []
  const all = [...ex.value.bars, ...(choice.value ? ex.value.next : [])]; const room = ex.value.bars.length + ex.value.next.length
  const lo = Math.min(...all.map((b: any) => b.l)); const hi = Math.max(...all.map((b: any) => b.h)); const y = (v: number) => 8 + ((hi - v) / (hi - lo || 1)) * (H - 16); const w = W / room
  return all.map((b: any, i: number) => ({ x: i * w + w / 2, w: w * 0.6, t: y(b.h), b: y(b.l), o: y(Math.max(b.o, b.c)), c: Math.max(1, Math.abs(y(b.o) - y(b.c))), up: b.c >= b.o, later: i >= ex.value.bars.length }))
})
const CHOICES = computed(() => [['BUY', L('أشتري', 'Buy')], ['WAIT', L('أنتظر', 'Wait')], ['AVOID', L('أتجنب', 'Avoid')]] as [string, string][])
</script>

<template>
  <div>
    <div class="row"><UiNativeSelect v-model="pick" :aria-label="t('symbol')"><option v-for="x in list" :key="x" :value="x">{{ x }}</option></UiNativeSelect><span v-if="busy && !r" class="muted" role="status">{{ L('يحلل…', 'Analysing…') }}</span></div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="d && !d.live" class="muted">{{ L('الأسعار تجريبية، فالتحليل للتدريب فقط.', 'Demo prices, so this is for practice only.') }}</p>
    <p v-if="d && !r" class="muted">{{ L('لا توجد أسعار سابقة كافية لهذا الرمز.', 'There is too little price history for this symbol.') }}</p>
    <template v-if="r">
      <section class="rise mb-4 rounded-3xl p-6 sm:p-8" :class="BG[r.view]"><div class="flex flex-wrap items-center gap-4"><component :is="r.view.includes('UP') ? ArrowUp : r.view === 'SIDE' ? Minus : ArrowDown" class="size-10 shrink-0" aria-hidden="true" /><h2 class="!m-0 min-w-0 flex-1 !text-2xl sm:!text-3xl"><bdi>{{ pick }}</bdi>: {{ VIEW[r.view] }}</h2><span class="num text-2xl">{{ money(r.price) }}</span></div>
        <div class="mt-5 grid gap-2 sm:grid-cols-3"><div v-for="[k, n] in TABS" :key="k" class="rounded-2xl bg-black/15 px-4 py-3"><span class="small block opacity-80">{{ n }}</span><b>{{ r.horizons[k] ? VIEW[r.horizons[k].view] : '—' }}</b></div></div></section>
      <div class="cols">
        <div>
          <UiCard><h2>{{ L('ماذا تفعل؟', 'What to do') }}</h2><ol class="!m-0"><li v-for="x in r.steps" :key="x.en" class="py-1">{{ say(x) }}</li></ol></UiCard>
          <UiCard v-for="x in r.setups" :key="x.id"><div class="flex flex-wrap items-center gap-3"><h2 class="!m-0 min-w-0 flex-1">{{ SETUP[x.id] }}</h2><UiBadge v-if="x.against" tone="FAIL">{{ L('عكس الاتجاه', 'Against the trend') }}</UiBadge><UiBadge v-if="x.ratio" tone="UNKNOWN">{{ L('الربح إلى الخسارة', 'Gain to loss') }} {{ x.ratio }}</UiBadge></div>
            <p class="!mb-1">{{ say(x.why) }}</p><p class="muted">{{ say(x.practice) }}</p>
            <div class="tiles"><div class="tile"><span class="small muted">{{ x.side === 'SELL' ? L('بيع إذا نزل إلى', 'Sell if it falls to') : x.type === 'STOP' ? L('شراء إذا ارتفع إلى', 'Buy when it rises to') : L('شراء عند أو أقل', 'Buy at or below') }}</span><b class="num">{{ money(x.price) }}</b></div><template v-if="x.side === 'BUY'"><div class="tile"><span class="small muted">{{ L('الوقف', 'Stop') }}</span><b class="num down">{{ money(x.stop) }}</b></div><div class="tile"><span class="small muted">{{ L('الهدف', 'Target') }}</span><b class="num up">{{ money(x.target) }}</b></div></template></div>
            <p v-if="x.odds" class="small muted">{{ L('بعد الشراء وخلال 20 يومًا: الهدف أولًا', 'After buying, within 20 days: target first') }} <span class="num">{{ pct(x.odds.target) }}</span> · {{ L('الوقف أولًا', 'stop first') }} <span class="num">{{ pct(x.odds.stop) }}</span></p>
            <UiButton variant="default" @click="navigateTo(link(x))">{{ L('جهّز هذا الأمر', 'Prepare this order') }}</UiButton></UiCard>

          <UiCard><div class="flex flex-wrap items-center justify-between gap-3"><h2 class="!m-0">{{ L('القراءات', 'Readings') }}</h2><div class="flex gap-1"><button v-for="[k, n] in TABS" :key="k" type="button" :aria-pressed="tab === k" :disabled="!r.horizons[k]" class="min-h-9 rounded-full px-3 text-sm" :class="tab === k ? 'bg-primary text-primary-foreground' : 'border'" @click="tab = k">{{ n }}</button></div></div>
            <div v-for="x in h.readings" :key="x.id" class="border-b py-3 last:border-0"><div class="flex items-center gap-3"><span class="size-2.5 shrink-0 rounded-full" :class="x.score > 0.1 ? 'bg-up' : x.score < -0.1 ? 'bg-down' : 'bg-muted-foreground/40'" aria-hidden="true" /><b class="min-w-0 flex-1">{{ say(x.name) }}</b><span class="small muted">{{ GROUP[x.group] }}</span><span class="num small" dir="ltr">{{ x.value }}</span></div><p class="!mb-0 mt-1.5">{{ say(x.what) }}</p><p class="small !mb-0 mt-1 text-primary">← {{ say(x.todo) }}</p></div></UiCard>
        </div>
        <div>
          <UiCard><h2>{{ L('المستويات', 'Levels') }}</h2><div v-for="x in [...h.resistance].reverse()" :key="`r${x.price}`" class="flex justify-between border-b py-2"><span class="down">{{ L('مقاومة', 'Resistance') }} <span class="small muted">{{ x.touches }}×</span></span><span class="num">{{ money(x.price) }}</span></div><div class="my-1 flex justify-between rounded-xl bg-secondary px-3 py-2 font-semibold"><span>{{ L('السعر', 'Price') }}</span><span class="num">{{ money(r.price) }}</span></div><div v-for="x in h.support" :key="`s${x.price}`" class="flex justify-between border-b py-2 last:border-0"><span class="up">{{ L('دعم', 'Support') }} <span class="small muted">{{ x.touches }}×</span></span><span class="num">{{ money(x.price) }}</span></div></UiCard>
          <UiCard v-if="r.record.length"><h2>{{ L('هل نجحت الإشارات هنا من قبل؟', 'Did signals work here before?') }}</h2><p class="small muted">{{ L('نتيجة 10 أيام بعد كل إشارة في السنوات الماضية، مقارنة بأي يوم عادي.', 'Result 10 days after each signal over past years, against any ordinary day.') }}</p><div v-for="x in r.record" :key="x.id" class="border-b py-3 last:border-0"><div class="flex flex-wrap items-center gap-2"><b class="min-w-0 flex-1">{{ say(x.name) }}</b><UiBadge v-if="x.now" tone="warn">{{ L('ظهرت الآن', 'Now') }}</UiBadge><UiBadge v-if="x.useful" tone="PASS">{{ L('أفضل من المعتاد', 'Better than usual') }}</UiBadge></div><p class="small muted !mb-0 mt-1"><template v-if="x.times">{{ x.times }} {{ L('مرة', 'times') }} · {{ L('ربحت', 'won') }} <span class="num">{{ pct(x.won) }}</span> · {{ L('متوسط', 'average') }} <span class="num" dir="ltr">{{ pct(x.average, 1) }}</span> · {{ L('المعتاد', 'usual') }} <span class="num" dir="ltr">{{ pct(x.usual, 1) }}</span></template><template v-else>{{ L('لم تظهر', 'Never appeared') }}</template></p></div><p class="small muted !m-0 mt-3">{{ L('الماضي لا يضمن المستقبل، والعدد القليل لا يُعتمد عليه.', 'The past promises nothing, and a few cases prove little.') }}</p></UiCard>
          <UiCard><div class="flex items-center justify-between gap-3"><h2>{{ L('تدرّب', 'Practise') }}</h2><span v-if="tally.all" class="num">{{ tally.right }}/{{ tally.all }}</span></div>
            <p class="small muted">{{ L('لحظة سابقة من هذا السهم. قرّر، ثم شاهد ما حدث في 15 يومًا.', 'A past moment of this symbol. Decide, then see the next 15 days.') }}</p>
            <template v-if="ex"><div dir="ltr"><svg :viewBox="`0 0 ${W} ${H}`" class="w-full" role="img" :aria-label="L('رسم الأسعار', 'Price chart')"><g v-for="(b, i) in candles" :key="i" :style="{ color: b.up ? 'var(--up)' : 'var(--down)' }" :opacity="b.later ? 1 : 0.75"><line :x1="b.x" :x2="b.x" :y1="b.t" :y2="b.b" stroke="currentColor" /><rect :x="b.x - b.w / 2" :y="b.o" :width="b.w" :height="b.c" fill="currentColor" /></g><line v-if="choice" :x1="(ex.bars.length / (ex.bars.length + ex.next.length)) * W" :x2="(ex.bars.length / (ex.bars.length + ex.next.length)) * W" y1="0" :y2="H" stroke="var(--primary)" stroke-dasharray="4 4" /></svg></div>
              <ul class="small"><li v-for="x in ex.readings" :key="x.name.en">{{ say(x.what) }}</li></ul>
              <div v-if="!choice" class="row"><UiButton v-for="[k, n] in CHOICES" :key="k" :disabled="!!choice" @click="choose(k)">{{ n }}</UiButton></div>
              <div v-else role="status"><p class="font-semibold" :class="choice === answer ? 'up' : 'down'">{{ choice === answer ? L('قرار صحيح', 'Good decision') : `${L('الأفضل كان', 'Better was')}: ${CHOICES.find(([k]) => k === answer)![1]}` }} · <span class="num" dir="ltr">{{ pct(ex.change, 1) }}</span></p><p class="small muted">{{ L('أسوأ نزول في الطريق', 'Worst fall on the way') }} <span class="num" dir="ltr">{{ pct(ex.worst, 1) }}</span>. {{ L('حتى القرار الجيد قد يخسر مرة، فالوقف ضروري.', 'Even a good decision can lose once, so the stop matters.') }}</p></div></template>
            <UiButton :variant="ex ? undefined : 'default'" class="mt-2" @click="next">{{ ex ? L('لحظة أخرى', 'Another moment') : L('ابدأ التدريب', 'Start practising') }}</UiButton></UiCard>
        </div>
      </div>
      <p class="small muted">{{ L('قراءة للرسم وليست نصيحة. الفحص الشرعي يبقى قبل أي شراء.', 'A reading of the chart, not advice. The Sharia check still comes before any purchase.') }}</p>
    </template>
  </div>
</template>
