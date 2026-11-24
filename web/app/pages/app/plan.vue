<script setup lang="ts">
import { CircleAlert } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { lang, num } = useLang()
const { state } = useTerminal()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
type Cls = 'stocks' | 'crypto' | 'gold' | 'funds'
const KEYS: Cls[] = ['stocks', 'crypto', 'gold', 'funds']
const COLOR: Record<string, string> = { stocks: '#4b5bf5', crypto: '#12a37f', gold: '#e0a100', funds: '#8a63d2', cash: '#b9bfd0', others: '#6b7280' }
const d = ref<any>(null)
const sim = ref<any>(null)
const simBusy = ref(false)
const error = ref('')
const saved = ref('')
const busy = ref(false)
const sure = ref(false)
const f = reactive({ targets: { stocks: 30, crypto: 50, gold: 20, funds: 0 } as Record<Cls, number>, symbols: { stocks: '', crypto: 'BTC/USD, ETH/USD', gold: 'PAXG/USD', funds: '' } as Record<Cls, string>, smart: true, pace: 3, band: 5, guard: 20 })
let timer: any
let filled = false
function fill() {
  const p = d.value?.plan
  if (p) { for (const c of KEYS) { f.targets[c] = p.targets[c]; if (p.symbols[c].length) f.symbols[c] = p.symbols[c].join(', ') } f.smart = p.smart; f.pace = p.pace; f.band = p.band; f.guard = p.guard } else {
    const mine = (state.value?.watchlist || []).map((w: any) => w.symbol).filter((s: string) => !s.includes('/'))
    if (mine.length && !f.symbols.stocks) f.symbols.stocks = mine.join(', ')
  }
}
async function load() { try { d.value = await api('plan'); if (!filled && (d.value.plan || state.value)) { filled = true; fill() } } catch (e: any) { error.value = plain.error(e.message, ar.value) } }
const list = (s: string) => s.split(/[\s,،]+/).filter(Boolean).map((x) => x.toUpperCase())
const body = () => ({ targets: { ...f.targets }, symbols: Object.fromEntries(KEYS.map((c) => [c, list(f.symbols[c]).map((s) => (['crypto', 'gold'].includes(c) && !s.includes('/') ? `${s}/USD` : s))])), smart: f.smart, pace: Number(f.pace), band: Number(f.band), guard: Number(f.guard) })
async function act(fn: () => Promise<any>) { busy.value = true; error.value = ''; saved.value = ''; try { return await fn() } catch (e: any) { error.value = plain.error(e.message, ar.value); return null } finally { busy.value = false } }
async function save() { const x = await act(() => api('plan', body())); if (x) { d.value = x; fill(); saved.value = L('حُفظت الخطة', 'The plan is saved'); simulate() } }
async function toggle(on: boolean) { sure.value = false; const x = await act(() => api('plan/toggle', { on })); if (x) d.value = x }
async function answer(id: string, yes: boolean) { const x = await act(() => api('plan/answer', { id, yes })); if (x && !x.ok) error.value = WAIT.value[x.code] || L('تغيّرت الحال، فلم يُنفذ', 'Things changed, so it was not placed'); await load() }
async function simulate() { simBusy.value = true; try { sim.value = await api('plan/simulate') } catch { sim.value = null } finally { simBusy.value = false } }
onMounted(() => { load(); timer = setInterval(load, 5000) })
onBeforeUnmount(() => clearInterval(timer))

const total = computed(() => Math.round(KEYS.reduce((a, c) => a + (Number(f.targets[c]) || 0), 0) * 10) / 10)
const dirty = computed(() => { const p = d.value?.plan; if (!p) return true; const b: any = body(); return JSON.stringify([b.targets, KEYS.map((c) => (b.targets[c] > 0 ? b.symbols[c] : [])), b.smart, b.pace, b.band, b.guard]) !== JSON.stringify([p.targets, KEYS.map((c) => p.symbols[c]), p.smart, p.pace, p.band, p.guard]) })
const NAME = computed<Record<string, string>>(() => ({ stocks: L('أسهم', 'Stocks'), crypto: L('عملات رقمية', 'Crypto'), gold: L('ذهب', 'Gold'), funds: L('صناديق', 'Funds'), cash: L('نقد', 'Cash'), others: L('خارج الخطة', 'Outside the plan') }))
const HINT = computed<Record<Cls, string>>(() => ({ stocks: 'NVDA, AAPL', crypto: 'BTC/USD, ETH/USD', gold: 'PAXG/USD', funds: 'SPUS, HLAL' }))
const WAIT = computed<Record<string, string>>(() => ({ SHARIA: L('ينتظر حكمًا شرعيًا', 'Waits for a Sharia ruling'), ANALYSIS: L('التحليل يميل إلى التجنب', 'The analysis leans against it'), LIMITS: L('الشراء متوقف بسبب حدود الخسارة أو الصفقات', 'Buying is stopped by your loss or trade limits'), PAUSED: L('المتابعة متوقفة', 'Following is paused'), CLOSED: L('ينتظر فتح السوق', 'Waits for the market to open'), PRICE: L('ينتظر سعرًا مؤكدًا', 'Waits for a reliable price'), SPREAD: L('الفرق بين البيع والشراء كبير', 'The buy and sell prices are far apart'), SMALL: L('المبلغ أقل من سهم واحد', 'The amount is less than one share'), CASH: L('النقد غير كافٍ', 'Not enough cash'), MARKET: L('ينتظر', 'Waiting'), SUGGESTION: L('اقتراح فقط', 'Suggestion only'), DECLINED: L('رفضته، ويُسأل لاحقًا', 'You declined; asked again later'), HELD: L('بيع خارج الخطة، فيُنتظر يومًا', 'Sold outside the plan; waits a day') }))
const WHY = computed<Record<string, string>>(() => ({ BUILD: L('بناء الخطة', 'Building the plan'), UNDER: L('أقل من نسبته', 'Below its share'), OVER: L('أكثر من نسبته', 'Above its share'), REMOVED: L('أزلته من الخطة', 'You removed it'), GUARD: L('حد تراجع المحفظة', 'Portfolio drop limit') }))
const pct = (x: any, n = 1) => (typeof x === 'number' ? `${(x * 100).toFixed(n)}%` : '—')
const bars = computed(() => {
  if (!d.value) return []
  const now: Record<string, number> = { stocks: 0, crypto: 0, gold: 0, funds: 0 }
  for (const r of d.value.rows) now[r.cls] += r.now
  return [...KEYS.map((c) => ({ k: c as string, now: now[c]!, goal: (d.value.plan?.targets[c] || 0) / 100 })), { k: 'others', now: d.value.others, goal: 0 }, { k: 'cash', now: d.value.cash ?? 0, goal: Math.max(0, 1 - KEYS.reduce((a, c) => a + (d.value.plan?.targets[c] || 0), 0) / 100) }].filter((x) => x.now > 0.0005 || x.goal > 0)
})
const status = computed(() => {
  const x = d.value
  if (!x) return ''
  if (x.on && x.stopped) return L('بلغت المحفظة حد التراجع، والخطة تبيع ما اشترته', 'The portfolio reached its drop limit and the plan is selling what it bought')
  if (x.stopped) return L('توقفت الخطة عند حد التراجع الذي حددته', 'The plan stopped at the drop limit you set')
  if (!x.on) return L('متوقفة', 'Off')
  if (!x.running) return L('مفعّلة، وتنتظر تشغيل التداول الآلي', 'On, waiting for automation to start')
  return x.mode === 'FULL' ? L('تعمل آليًا', 'Working automatically') : x.mode === 'SEMI' ? L('تعمل وتطلب موافقتك', 'Working, and asks you first') : L('تقترح فقط', 'Suggesting only')
})
const when = (x: number) => new Date(x).toLocaleString('en-GB')
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="d && !d.session" class="muted">{{ L('ابدأ محاكاة من لوحة التداول أولًا.', 'Start a simulation from the trading page first.') }}</p>

    <UiCard v-if="d">
      <div class="flex flex-wrap items-center gap-4"><div class="min-w-0 flex-1"><h2 class="!mb-1">{{ L('حالة الخطة', 'Plan status') }}</h2><p class="muted !m-0" role="status">{{ status }}</p></div>
        <UiButton v-if="!d.on" variant="default" :disabled="busy || !d.plan || dirty || !d.session" @click="sure = true">{{ L('شغّل الخطة', 'Start the plan') }}</UiButton><UiButton v-else :disabled="busy" @click="toggle(false)">{{ L('أوقف الخطة', 'Stop the plan') }}</UiButton></div>
      <template v-if="d.plan && d.equity">
        <div class="mt-5 flex h-4 overflow-hidden rounded-full bg-secondary" aria-hidden="true"><span v-for="b in bars" :key="b.k" :style="{ width: `${b.now * 100}%`, background: COLOR[b.k] }" /></div>
        <div class="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3"><div v-for="b in bars" :key="b.k" class="flex items-center gap-3 rounded-2xl border px-4 py-3"><span class="size-3 shrink-0 rounded-full" :style="{ background: COLOR[b.k] }" aria-hidden="true" /><span class="min-w-0 flex-1 font-medium">{{ NAME[b.k] }}</span><span class="small"><b class="num">{{ pct(b.now) }}</b> <span class="muted">{{ L('من', 'of') }} <span class="num">{{ pct(b.goal, 0) }}</span></span></span></div></div>
        <p v-if="d.on" class="small muted !m-0 mt-3">{{ L('التراجع من أعلى قيمة', 'Drop from the highest value') }}: <span class="num">{{ pct(d.drop) }}</span> / <span class="num">{{ d.plan.guard }}%</span></p>
      </template>
    </UiCard>

    <div v-for="a in d?.asks || []" :key="a.id" class="rise mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl bg-sun px-5 py-4 text-sun-foreground" role="status"><span class="min-w-0 flex-1 font-semibold">{{ a.side === 'BUY' ? L('شراء', 'Buy') : L('بيع', 'Sell') }} <bdi>{{ a.symbol }}</bdi> · <span class="num">${{ num(a.value) }}</span> · {{ WHY[a.why] }}</span><UiButton variant="default" :disabled="busy" @click="answer(a.id, true)">{{ L('موافق', 'Approve') }}</UiButton><UiButton :disabled="busy" @click="answer(a.id, false)">{{ L('لا', 'Decline') }}</UiButton></div>

    <div class="cols">
      <div>
        <UiCard><div class="flex items-center justify-between gap-3"><h2>{{ L('النسب', 'Percentages') }}</h2><b class="num" :class="total > 100 ? 'down' : ''">{{ total }}%</b></div>
          <div v-for="c in KEYS" :key="c" class="border-b py-4 last:border-0">
            <div class="flex items-center gap-3"><span class="size-3 shrink-0 rounded-full" :style="{ background: COLOR[c] }" aria-hidden="true" /><label :for="`r-${c}`" class="min-w-0 flex-1 font-semibold">{{ NAME[c] }}</label><UiInput v-model="f.targets[c]" type="number" min="0" max="100" inputmode="decimal" class="num w-20 text-center" :aria-label="NAME[c]" /><span>%</span></div>
            <input :id="`r-${c}`" v-model.number="f.targets[c]" type="range" min="0" max="100" step="5" class="mt-1 h-9 w-full" style="accent-color: var(--primary)">
            <div v-if="Number(f.targets[c]) > 0" class="mt-2"><UiInput v-model="f.symbols[c]" dir="ltr" class="w-full" :placeholder="HINT[c]" :aria-label="`${NAME[c]}: ${L('الرموز', 'Symbols')}`" />
              <p v-if="c === 'gold'" class="small muted !m-0 mt-1">{{ L('يُتابَع الذهب عبر وحدة رقمية مرتبطة بأونصة ذهب، وتُتداول طوال اليوم.', 'Gold is followed through a digital unit tied to one ounce of gold. It trades all day.') }}</p></div>
          </div>
          <p class="small muted !m-0 mt-3">{{ total > 100 ? L('قلّل النسب حتى لا تتجاوز 100.', 'Lower the percentages to 100 or less.') : `${L('الباقي يبقى نقدًا', 'The rest stays in cash')}: ${Math.round((100 - total) * 10) / 10}%` }}</p></UiCard>

        <UiCard><h2>{{ L('طريقة القرار', 'How it decides') }}</h2>
          <label class="flex items-center gap-3"><UiSwitch :model-value="f.smart" @update:model-value="f.smart = $event" /><span><b class="block">{{ L('استعن بالتحليل', 'Use the analysis') }}</b><span class="small muted">{{ L('يشتري النصيب كاملًا إذا أيّد التحليل، وثلاثة أرباعه إذا لم يحسم، ولا يشتري إذا مال إلى التجنب.', 'Buys the full share when the analysis is in favour, three quarters when it is undecided, and nothing when it leans against.') }}</span></span></label>
          <div class="mt-5 grid gap-4 sm:grid-cols-3"><label class="grid gap-1.5"><span class="small muted">{{ L('مدة بناء الخطة', 'Build over') }}</span><UiNativeSelect v-model="f.pace"><option v-for="n in [1, 3, 5, 10]" :key="n" :value="n">{{ n === 1 ? L('يوم واحد', 'One day') : `${n} ${L('أيام', 'days')}` }}</option></UiNativeSelect></label><label class="grid gap-1.5"><span class="small muted">{{ L('يعيد الموازنة إذا ابتعدت', 'Rebalance when off by') }}</span><UiNativeSelect v-model="f.band"><option v-for="n in [3, 5, 10]" :key="n" :value="n">{{ n }}%</option></UiNativeSelect></label><label class="grid gap-1.5"><span class="small muted">{{ L('يتوقف ويبيع إذا تراجعت المحفظة', 'Stop and sell if it drops') }}</span><UiNativeSelect v-model="f.guard"><option v-for="n in [10, 15, 20, 30]" :key="n" :value="n">{{ n }}%</option></UiNativeSelect></label></div>
          <div class="row mt-5"><UiButton variant="default" :disabled="busy || total > 100 || total < 1 || !dirty || !d?.session" @click="save">{{ L('احفظ الخطة', 'Save the plan') }}</UiButton><span v-if="saved && !dirty" class="up" role="status">{{ saved }}</span></div></UiCard>
      </div>
      <div>
        <UiCard v-if="d?.rows.length"><h2>{{ L('ما في الخطة', 'In the plan') }}</h2><div v-for="r in d.rows" :key="r.symbol" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-3 last:border-0"><span class="size-3 shrink-0 rounded-full" :style="{ background: COLOR[r.cls] }" aria-hidden="true" /><SymbolIcon :symbol="r.symbol" /><b class="flex-1"><bdi>{{ r.symbol }}</bdi></b><UiBadge v-if="d.live" :tone="r.sharia">{{ r.sharia === 'PASS' ? L('مجتاز', 'Pass') : r.sharia === 'FAIL' ? L('غير متوافق', 'Fail') : L('ينتظر حكمك', 'Your ruling') }}</UiBadge><span class="small num">{{ pct(r.now) }} / {{ pct(r.full) }}</span><span v-if="r.wait" class="small muted flex basis-full items-center gap-1.5"><CircleAlert class="size-4 shrink-0" aria-hidden="true" />{{ WAIT[r.wait] || WAIT.MARKET }}</span></div>
          <p v-if="d.live && d.rows.some((r: any) => r.sharia === 'UNKNOWN')" class="small muted !m-0 mt-3">{{ L('ما ينتظر حكمك لا يُشترى، ويبقى نصيبه نقدًا.', 'What waits for your ruling is not bought; its share stays in cash.') }} <NuxtLink to="/app/sharia" class="text-primary underline">{{ L('سجّل الحكم', 'Record a ruling') }}</NuxtLink></p></UiCard>

        <UiCard v-if="d?.plan"><div class="flex items-center justify-between gap-3"><h2>{{ L('ماذا قد يحدث خلال سنة؟', 'What could a year look like?') }}</h2><UiButton size="sm" :disabled="simBusy || dirty" @click="simulate">{{ simBusy ? L('يحسب…', 'Working…') : L('احسب', 'Work it out') }}</UiButton></div>
          <template v-if="sim"><div class="tiles !mb-0"><div class="tile"><span class="small muted">{{ L('حالة سيئة (1 من 20)', 'Bad case (1 in 20)') }}</span><b class="num down">${{ num(sim.end[0]) }}</b></div><div class="tile"><span class="small muted">{{ L('الوسط', 'Middle') }}</span><b class="num">${{ num(sim.end[1]) }}</b></div><div class="tile"><span class="small muted">{{ L('حالة جيدة (1 من 20)', 'Good case (1 in 20)') }}</span><b class="num up">${{ num(sim.end[2]) }}</b></div><div class="tile"><span class="small muted">{{ L('أكبر تراجع معتاد', 'Usual largest drop') }}</span><b class="num">{{ pct(sim.typicalDrop, 0) }}</b></div></div>
            <p v-if="sim.missing.length" class="small muted">{{ L('لم يدخل في الحساب', 'Left out') }}: <bdi>{{ sim.missing.join(', ') }}</bdi></p></template>
          <p class="small muted !m-0 mt-3">{{ L('محاكاة من أيام سابقة لا تفترض أن المكاسب تتكرر. ليست توقعًا.', 'Replayed from past days without assuming gains repeat. It is not a prediction.') }}</p></UiCard>

        <UiCard v-if="d?.log.length"><h2>{{ L('ما فعلته الخطة', 'What the plan did') }}</h2><div v-for="x in [...d.log].reverse()" :key="x.at + (x.symbol || '') + x.what" class="item small"><b>{{ x.what === 'BUY' ? L('شراء', 'Bought') : x.what === 'SELL' ? L('بيع', 'Sold') : x.what === 'ON' ? L('شُغّلت الخطة', 'Plan started') : x.what === 'OFF' ? L('أُوقفت الخطة', 'Plan stopped') : L('حد تراجع المحفظة', 'Portfolio drop limit') }}</b> <template v-if="x.symbol"><bdi>{{ x.symbol }}</bdi> <span class="num">${{ num(x.value) }}</span> · {{ WHY[x.why] }}</template><span class="muted num block">{{ when(x.at) }}</span></div></UiCard>
      </div>
    </div>
    <UiConfirm :open="sure" :title="L('تشغيل الخطة؟', 'Start the plan?')" :text="d?.mode === 'FULL' ? L('ستشتري الخطة وتبيع وحدها في محفظتك الورقية. نسبك تحل محل حد حجم المركز، ولا يوجد وقف خسارة لكل رمز، بل حد التراجع للمحفظة كلها. ويبقى الفحص الشرعي وحدود الخسارة.', 'The plan will buy and sell by itself in your paper portfolio. Your percentages replace the position-size limit, and there is no stop for each symbol, only the drop limit for the whole portfolio. The Sharia check and loss limits stay.') : L('لن يُنفذ شيء دون موافقتك. نسبك تحل محل حد حجم المركز، ولا يوجد وقف خسارة لكل رمز.', 'Nothing is placed without you. Your percentages replace the position-size limit, and there is no stop for each symbol.')" :confirm="L('شغّل', 'Start')" :cancel="L('تراجع', 'Cancel')" :busy="busy" @confirm="toggle(true)" @close="sure = false" />
  </div>
</template>
