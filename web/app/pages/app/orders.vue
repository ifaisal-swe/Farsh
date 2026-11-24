<script setup lang="ts">
import { CircleAlert, Terminal } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { lang, num } = useLang()
const { state } = useTerminal()
const route = useRoute()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const d = ref<any>(null)
const error = ref('')
const done = ref('')
const busy = ref(false)
const text = ref('')
const asking = ref(false)
const edit = ref<any>(null)
const f = reactive({ side: 'BUY', symbol: '', type: 'LIMIT', price: '' as any, qty: '' as any, dollars: '' as any, by: 'qty', all: false, stop: '' as any, target: '' as any, trail: 5 as any, day: false })
let timer: any
async function load() { try { d.value = await api('commands') } catch (e: any) { error.value = plain.error(e.message, ar.value) } }
async function act(fn: () => Promise<any>) { busy.value = true; error.value = ''; done.value = ''; try { return await fn() } catch (e: any) { error.value = plain.error(e.message, ar.value); return null } finally { busy.value = false } }
const MISS = computed<Record<string, string>>(() => ({ side: L('شراء أم بيع؟', 'Buy or sell?'), symbol: L('أي رمز؟', 'Which symbol?'), amount: L('كم سهمًا أو كم دولارًا؟', 'How many shares or dollars?') }))
async function understand() {
  const r = await act(() => api('commands/read', { text: text.value }))
  if (!r) return
  f.side = r.side || f.side; f.symbol = r.symbol || f.symbol; f.type = r.type; f.price = r.price ?? ''; f.qty = r.qty ?? ''; f.dollars = r.dollars ?? ''; f.by = r.dollars ? 'dollars' : 'qty'; f.all = r.all && r.side === 'SELL'; f.stop = r.stop ?? ''; f.target = r.target ?? ''; f.trail = r.trail ?? 5; f.day = r.day
  if (r.missing.length) error.value = r.missing.map((m: string) => MISS.value[m]).join(' ')
  else asking.value = true
}
async function send() {
  asking.value = false
  const x = await act(() => api('commands', { side: f.side, symbol: f.symbol, type: f.type, price: f.price, all: f.all && f.side === 'SELL', qty: f.by === 'qty' ? f.qty : '', dollars: f.by === 'dollars' ? f.dollars : '', stop: f.stop, target: f.target, trail: f.trail, day: f.day }))
  if (x) { d.value = x; text.value = ''; f.qty = ''; f.dollars = ''; f.price = ''; f.stop = ''; f.target = ''; f.all = false; done.value = L('استُلم الأمر', 'The order is in') }
}
async function cancel(id: string) { const x = await act(() => api('commands/cancel', { id })); if (x) d.value = x }
async function saveEdit() { const x = await act(() => api('commands/change', { id: edit.value.id, price: edit.value.price, trail: edit.value.trail })); if (x) { d.value = x; edit.value = null } }
onMounted(() => {
  const q = route.query as Record<string, string>
  if (q.symbol) { f.symbol = q.symbol; f.side = q.side === 'SELL' ? 'SELL' : 'BUY'; f.type = ['LIMIT', 'STOP', 'MARKET', 'TRAIL'].includes(q.type || '') ? q.type! : 'LIMIT'; f.price = q.price || ''; f.stop = q.stop || ''; f.target = q.target || ''; if (f.side === 'SELL') f.all = true }
  load(); timer = setInterval(load, 2000)
})
onBeforeUnmount(() => clearInterval(timer))
watch(() => state.value?.watchlist, (w: any) => { if (!f.symbol && w?.length) f.symbol = w[0].symbol }, { immediate: true })
watch(() => f.side, (s) => { if (s === 'BUY' && f.type === 'TRAIL') f.type = 'LIMIT' })

const money = (x: any) => (typeof x === 'number' ? `$${num(x)}` : '—')
const sure = computed(() => { const w = (state.value?.watchlist || []).find((x: any) => x.symbol === f.symbol.toUpperCase()); return w?.price as number | undefined })
const TYPES = computed(() => (f.side === 'BUY' ? [['LIMIT', L('عند سعر أو أرخص', 'At a price or cheaper')], ['STOP', L('إذا ارتفع إلى سعر', 'When it rises to a price')], ['MARKET', L('بسعر السوق', 'At the market price')]] : [['LIMIT', L('عند سعر أو أعلى', 'At a price or higher')], ['STOP', L('إذا نزل إلى سعر', 'When it falls to a price')], ['TRAIL', L('يتبع الصعود', 'Follows the rise')], ['MARKET', L('بسعر السوق', 'At the market price')]]) as [string, string][])
const amount = computed(() => (f.all && f.side === 'SELL' ? L('كل ما تملكه', 'everything you hold') : f.by === 'dollars' ? money(Number(f.dollars)) : `${f.qty}`))
const price = computed(() => Number(f.price))
const now = computed(() => { const p = sure.value; if (!p || !price.value) return false; return f.side === 'BUY' ? (f.type === 'LIMIT' ? price.value >= p : f.type === 'STOP' && price.value <= p) : f.type === 'LIMIT' ? price.value <= p : f.type === 'STOP' && price.value >= p })
const say = (x: any, qty: string) => {
  const s = x.symbol; const p = money(Number(x.price))
  const head = x.side === 'BUY' ? L(`شراء ${qty} من ${s}`, `Buy ${qty} of ${s}`) : L(`بيع ${qty} من ${s}`, `Sell ${qty} of ${s}`)
  const when = x.type === 'MARKET' ? L('بسعر السوق', 'at the market price') : x.type === 'TRAIL' ? L(`إذا نزل ${x.trail}% من أعلى سعر`, `if it falls ${x.trail}% from its highest price`) : x.side === 'BUY' ? (x.type === 'LIMIT' ? L(`عند ${p} أو أقل`, `at ${p} or less`) : L(`إذا ارتفع إلى ${p}`, `when it rises to ${p}`)) : x.type === 'LIMIT' ? L(`عند ${p} أو أكثر`, `at ${p} or more`) : L(`إذا نزل إلى ${p}`, `when it falls to ${p}`)
  return `${head} ${when}`
}
const after = computed(() => (f.side !== 'BUY' ? '' : [f.stop ? L(`ثم بيع إذا نزل إلى ${money(Number(f.stop))}`, `then sell if it falls to ${money(Number(f.stop))}`) : '', f.target ? L(`أو بيع عند ${money(Number(f.target))}`, `or sell at ${money(Number(f.target))}`) : ''].filter(Boolean).join('، ')))
const WAIT = computed<Record<string, string>>(() => ({ REACH: L('ينتظر السعر', 'Waiting for the price'), CLOSED: L('ينتظر فتح السوق', 'Waits for the market to open'), PRICE: L('ينتظر سعرًا مؤكدًا', 'Waits for a reliable price'), SHARIA: L('ينتظر نتيجة الفحص الشرعي', 'Waits for the Sharia screen'), LIMITS: L('الشراء متوقف بسبب حدود الخسارة أو الصفقات', 'Buying is stopped by your loss or trade limits'), SPREAD: L('الفرق بين البيع والشراء كبير', 'The buy and sell prices are far apart'), CASH: L('النقد غير كافٍ', 'Not enough cash'), MORE: L('نُفذ جزء، والباقي ينتظر', 'Partly done; the rest is waiting'), MARKET: L('ينتظر', 'Waiting'), SMALL: L('ينتظر', 'Waiting') }))
const END = computed<Record<string, string>>(() => ({ USER: L('ألغيته', 'You cancelled it'), TIME: L('انتهت مدته', 'Its time ended'), OTHER: L('نُفذ الأمر المقابل', 'The paired order ran'), SOLD: L('بيع المركز قبله', 'The position was sold first'), RESET: L('بدأت محاكاة جديدة', 'A new simulation started') }))
const open = computed(() => (d.value?.orders || []).filter((x: any) => ['WAITING', 'PART'].includes(x.status)))
const past = computed(() => (d.value?.orders || []).filter((x: any) => !['WAITING', 'PART'].includes(x.status)))
const when = (x: number) => new Date(x).toLocaleString('en-GB')
const EX = computed(() => (ar.value ? ['اشتر 5 NVDA عند 160 وقف 150 هدف 180', 'اشتر بـ 500 دولار بيتكوين إذا نزل إلى 60000', 'بع كل NVDA إذا نزل عن 150'] : ['Buy 5 NVDA at 160 stop 150 target 180', 'Buy $500 of bitcoin at 60000', 'Sell all NVDA if it falls below 150']))
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">{{ error }}</p><p v-if="done" class="up" role="status">{{ done }}</p>
    <p v-if="d && !d.session" class="muted">{{ L('ابدأ محاكاة من لوحة التداول أولًا.', 'Start a simulation from the trading page first.') }}</p>
    <UiCard><form class="flex flex-wrap items-center gap-3" @submit.prevent="understand"><Terminal class="size-5 shrink-0 text-primary" aria-hidden="true" /><UiInput v-model="text" class="h-12 min-w-48 flex-1 text-base" :placeholder="EX[0]" :aria-label="L('اكتب أمرك', 'Write your order')" /><UiButton type="submit" variant="default" :disabled="busy || !text.trim() || !d?.session">{{ L('أرسل', 'Send') }}</UiButton></form><div class="mt-3 flex flex-wrap gap-2"><button v-for="x in EX" :key="x" type="button" class="min-h-9 rounded-full border px-3 text-start text-sm text-muted-foreground" @click="text = x"><bdi>{{ x }}</bdi></button></div></UiCard>
    <div class="cols">
      <div>
        <UiCard v-if="open.length"><h2>{{ L('أوامر تنتظر', 'Waiting orders') }} <span class="num muted">{{ open.length }}</span></h2>
          <div v-for="x in open" :key="x.id" class="border-b py-4 last:border-0"><div class="flex flex-wrap items-center gap-3"><UiBadge :tone="x.side === 'BUY' ? 'PASS' : 'FAIL'">{{ x.side === 'BUY' ? L('شراء', 'Buy') : L('بيع', 'Sell') }}</UiBadge><b class="min-w-0 flex-1"><bdi>{{ say(x, String(Math.round((x.qty - x.done) * 1e6) / 1e6)) }}</bdi></b><span v-if="typeof x.away === 'number' && x.type !== 'MARKET'" class="small num muted">{{ L('يبعد', 'away') }} {{ (Math.abs(x.away) * 100).toFixed(2) }}%</span></div>
            <p class="small muted !mb-0 mt-1.5">{{ L('السعر الآن', 'Price now') }} <span class="num">{{ money(x.now) }}</span><template v-if="x.type === 'TRAIL' && x.level"> · {{ L('يبيع عند', 'sells at') }} <span class="num">{{ money(x.level) }}</span></template><template v-if="x.stop"> · {{ L('الوقف', 'Stop') }} <span class="num">{{ money(x.stop) }}</span></template><template v-if="x.target"> · {{ L('الهدف', 'Target') }} <span class="num">{{ money(x.target) }}</span></template><template v-if="x.day"> · {{ L('اليوم فقط', 'Today only') }}</template></p>
            <p class="small !mb-0 mt-1 flex items-center gap-1.5"><CircleAlert class="size-4 shrink-0" aria-hidden="true" />{{ WAIT[x.wait] || WAIT.MARKET }}<template v-if="x.done"> · {{ L('نُفذ', 'done') }} <span class="num">{{ x.done }}/{{ x.qty }}</span></template></p>
            <form v-if="edit?.id === x.id" class="row mt-3" @submit.prevent="saveEdit"><UiInput v-if="x.type === 'TRAIL'" v-model="edit.trail" type="number" step="any" class="w-32" :aria-label="L('المسافة %', 'Distance %')" /><UiInput v-else v-model="edit.price" type="number" step="any" class="w-32" :aria-label="L('السعر', 'Price')" /><UiButton type="submit" variant="default" size="sm" :disabled="busy">{{ L('احفظ', 'Save') }}</UiButton><UiButton size="sm" @click="edit = null">{{ L('تراجع', 'Back') }}</UiButton></form>
            <div v-else class="row mt-3"><UiButton v-if="x.type !== 'MARKET' && !(x.done && x.side === 'BUY')" size="sm" :disabled="busy" @click="edit = { ...x }">{{ L('عدّل السعر', 'Change price') }}</UiButton><UiButton size="sm" :disabled="busy" @click="cancel(x.id)">{{ L('ألغِ', 'Cancel') }}</UiButton></div></div></UiCard>
        <UiCard v-else-if="d"><h2>{{ L('أوامر تنتظر', 'Waiting orders') }}</h2><p class="muted !m-0">{{ L('لا أوامر الآن. اكتب أمرًا أو استخدم النموذج.', 'No orders now. Type one or use the form.') }}</p></UiCard>
        <UiCard v-if="d?.held.length"><h2>{{ L('ما تملكه', 'What you hold') }}</h2><div v-for="h in d.held" :key="h.symbol" class="flex flex-wrap items-center gap-3 border-b py-3 last:border-0"><SymbolIcon :symbol="h.symbol" /><b class="flex-1"><bdi>{{ h.symbol }}</bdi></b><span class="small num">{{ h.qty }} × {{ money(h.paid) }}</span><b class="num" :class="(h.now || 0) >= h.paid ? 'up' : 'down'">{{ h.now ? `${((h.now / h.paid - 1) * 100).toFixed(2)}%` : '—' }}</b><UiButton size="sm" @click="f.side = 'SELL'; f.symbol = h.symbol; f.all = true; f.type = 'STOP'">{{ L('أمر بيع', 'Sell order') }}</UiButton></div></UiCard>
        <UiCard v-if="past.length"><h2>{{ L('أوامر انتهت', 'Finished orders') }}</h2><div v-for="x in past.slice(0, 20)" :key="x.id" class="item small"><b><bdi>{{ say(x, String(x.done || x.qty)) }}</bdi></b> · <span v-if="x.done" class="up">{{ L('نُفذ بسعر', 'done at') }} <span class="num">{{ money(x.average) }}</span></span><span v-else class="muted">{{ END[x.end] || '' }}</span> <b v-if="typeof x.result === 'number'" class="num" :class="x.result >= 0 ? 'up' : 'down'">{{ x.result >= 0 ? '+' : '−' }}${{ num(Math.abs(x.result)) }}</b><span class="muted num block">{{ when(x.closedAt) }}</span></div></UiCard>
      </div>
      <div>
        <UiCard><h2>{{ L('أمر جديد', 'New order') }}</h2>
          <form class="grid gap-4" @submit.prevent="asking = true">
            <div class="grid grid-cols-2 gap-2"><button v-for="[k, n] in [['BUY', L('شراء', 'Buy')], ['SELL', L('بيع', 'Sell')]]" :key="k" type="button" :aria-pressed="f.side === k" class="min-h-11 rounded-full border font-semibold" :class="f.side === k ? (k === 'BUY' ? 'bg-up text-white' : 'bg-down text-white') : ''" @click="f.side = k!">{{ n }}</button></div>
            <label class="grid gap-1.5"><span class="small muted">{{ L('الرمز', 'Symbol') }}<template v-if="sure"> · {{ L('السعر الآن', 'price now') }} <span class="num">{{ money(sure) }}</span></template></span><UiInput v-model="f.symbol" dir="ltr" list="osym" required /><datalist id="osym"><option v-for="w in state?.watchlist || []" :key="w.symbol" :value="w.symbol" /></datalist></label>
            <label class="grid gap-1.5"><span class="small muted">{{ L('متى؟', 'When?') }}</span><UiNativeSelect v-model="f.type"><option v-for="[k, n] in TYPES" :key="k" :value="k">{{ n }}</option></UiNativeSelect></label>
            <label v-if="f.type === 'LIMIT' || f.type === 'STOP'" class="grid gap-1.5"><span class="small muted">{{ L('السعر', 'Price') }}</span><UiInput v-model="f.price" type="number" step="any" min="0" inputmode="decimal" required /></label>
            <label v-if="f.type === 'TRAIL'" class="grid gap-1.5"><span class="small muted">{{ L('يبيع إذا نزل من أعلى سعر بنسبة %', 'Sells when it falls from its top by %') }}</span><UiInput v-model="f.trail" type="number" step="any" min="0.5" max="50" inputmode="decimal" required /></label>
            <label v-if="f.side === 'SELL'" class="flex items-center gap-3"><UiSwitch :model-value="f.all" @update:model-value="f.all = $event" /><b>{{ L('كل ما أملكه', 'Everything I hold') }}</b></label>
            <div v-if="!(f.all && f.side === 'SELL')" class="grid grid-cols-[1fr_auto] items-end gap-2"><label class="grid gap-1.5"><span class="small muted">{{ f.by === 'qty' ? L('الكمية', 'Quantity') : L('المبلغ بالدولار', 'Amount in dollars') }}</span><UiInput v-if="f.by === 'qty'" v-model="f.qty" type="number" step="any" min="0" inputmode="decimal" required /><UiInput v-else v-model="f.dollars" type="number" step="any" min="1" inputmode="decimal" required /></label><UiButton @click="f.by = f.by === 'qty' ? 'dollars' : 'qty'">{{ f.by === 'qty' ? L('بالدولار', 'Dollars') : L('بالكمية', 'Quantity') }}</UiButton></div>
            <div v-if="f.side === 'BUY'" class="grid grid-cols-2 gap-3"><label class="grid gap-1.5"><span class="small muted">{{ L('وقف بعد الشراء', 'Stop after buying') }}</span><UiInput v-model="f.stop" type="number" step="any" min="0" inputmode="decimal" /></label><label class="grid gap-1.5"><span class="small muted">{{ L('هدف بعد الشراء', 'Target after buying') }}</span><UiInput v-model="f.target" type="number" step="any" min="0" inputmode="decimal" /></label></div>
            <label class="flex items-center gap-3"><UiSwitch :model-value="f.day" @update:model-value="f.day = $event" /><span><b class="block">{{ L('اليوم فقط', 'Today only') }}</b><span class="small muted">{{ L('وإلا بقي 90 يومًا حتى يُنفذ أو تلغيه.', 'Otherwise it stays 90 days until it runs or you cancel it.') }}</span></span></label>
            <p v-if="typeof d?.free === 'number' && f.side === 'BUY'" class="small muted !m-0">{{ L('النقد المتاح', 'Free cash') }} <span class="num">{{ money(d.free) }}</span></p>
            <div><UiButton type="submit" variant="default" :disabled="busy || !d?.session">{{ L('راجع الأمر', 'Review the order') }}</UiButton></div>
          </form></UiCard>
        <UiCard><h2>{{ L('كيف تُنفذ الأوامر', 'How orders run') }}</h2><ul class="!m-0"><li>{{ L('بأسعار الشراء والبيع الفعلية وقت السوق، مع الرسوم.', 'At the real buy and sell prices while the market is open, with fees.') }}</li><li>{{ L('قد يُنفذ جزء أولًا إذا كانت الكمية المعروضة قليلة.', 'A part can run first when little is on offer.') }}</li><li>{{ L('يُحجز النقد للأمر حتى يُنفذ أو يُلغى.', 'Cash is held for the order until it runs or is cancelled.') }}</li><li>{{ L('تعمل حتى لو كان التداول الآلي متوقفًا.', 'They work even when automation is off.') }}</li><li>{{ L('لا يُشترى ما لم يجتز الفحص الشرعي.', 'Nothing is bought unless it passes the Sharia check.') }}</li><li>{{ L('التداول الآلي لا يتدخل فيما اشتريته بنفسك.', 'Automation does not touch what you bought yourself.') }}</li></ul></UiCard>
      </div>
    </div>
    <UiConfirm :open="asking" :title="say(f, amount)" :text="[after, now ? L('السعر بلغ هذا الحد الآن، فسيُنفذ مباشرة.', 'The price is already there, so it runs right away.') : '', L('محاكاة ورقية بأموال غير حقيقية.', 'Paper simulation with no real money.')].filter(Boolean).join(' · ')" :confirm="L('أكّد الأمر', 'Confirm')" :cancel="L('تراجع', 'Back')" :busy="busy" @confirm="send" @close="asking = false" />
  </div>
</template>
