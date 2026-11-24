<script setup lang="ts">
// a quick paper trade at the market price for any watched asset, paid from the one wallet. Other order types live on the orders page.
import { CircleCheck } from '@lucide/vue'
const symbol = defineModel<string>('symbol', { required: true })
const side = defineModel<string>('side', { required: true })
const { lang, num } = useLang()
const { state } = useTerminal()
const L = (a: string, e: string) => (lang.value === 'ar' ? a : e)
const money = (x: any) => (typeof x === 'number' ? `$${num(x)}` : '—')
const dollars = ref<any>('')
const part = ref(100)
const asking = ref(false)
const busy = ref(false)
const error = ref('')
const done = ref('')
const free = ref<number | null>(null)
const list = computed<any[]>(() => state.value?.watchlist || [])
const w = computed(() => list.value.find((x) => x.symbol === symbol.value))
const held = computed(() => Number(w.value?.positionQty) || 0)
const demo = computed(() => state.value?.tradingSession?.dataMode !== 'LIVE')
// whole shares stay whole; fractions keep six places
const qty = computed(() => (Number.isInteger(held.value) ? Math.floor(held.value * part.value / 100) : Math.floor(held.value * part.value / 100 * 1e6) / 1e6))
const ready = computed(() => !!w.value && (side.value === 'BUY' ? Number(dollars.value) > 0 && (free.value === null || Number(dollars.value) <= free.value) : qty.value > 0))
const about = computed(() => (side.value === 'BUY' ? L(`شراء ${symbol.value} بمبلغ ${money(Number(dollars.value))}`, `Buy ${money(Number(dollars.value))} of ${symbol.value}`) : L(`بيع ${part.value === 100 ? 'كل' : qty.value} ${symbol.value}`, `Sell ${part.value === 100 ? 'all' : qty.value} ${symbol.value}`)))
async function load() { try { const d = await api('commands'); free.value = typeof d.free === 'number' ? d.free : null } catch { /* the server checks the cash again */ } }
async function send() {
  asking.value = false
  busy.value = true
  error.value = ''
  done.value = ''
  try {
    const sell = side.value === 'SELL'
    const d = await api('commands', { side: side.value, symbol: symbol.value, type: 'MARKET', price: '', all: sell && part.value === 100, qty: sell && part.value < 100 ? qty.value : '', dollars: sell ? '' : dollars.value, stop: '', target: '', trail: 5, day: false })
    free.value = typeof d.free === 'number' ? d.free : free.value
    dollars.value = ''
    done.value = L('استُلم الأمر. تابعه في صفحة الأوامر.', 'The order is in. Follow it on the orders page.')
  } catch (e: any) { error.value = e.message } finally { busy.value = false }
}
watch([symbol, side], () => { error.value = ''; done.value = ''; part.value = 100 })
let timer: any
onMounted(() => { load(); timer = setInterval(load, 5000) })
onBeforeUnmount(() => clearInterval(timer))
const chip = (on: boolean) => ['min-h-10 flex-1 rounded-full border px-2 text-sm font-semibold transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent']
</script>

<template>
  <UiCard id="trade" class="scroll-mt-24">
    <h2>{{ L('تداول سريع', 'Quick trade') }}</h2>
    <form class="grid gap-4" @submit.prevent="asking = true">
      <div class="grid grid-cols-2 gap-1 rounded-full bg-muted p-1"><button v-for="[k, n] in [['BUY', L('شراء', 'Buy')], ['SELL', L('بيع', 'Sell')]]" :key="k" type="button" :aria-pressed="side === k" class="min-h-11 rounded-full font-semibold transition-colors" :class="side === k ? (k === 'BUY' ? 'bg-up text-white dark:text-[#0a0b1a]' : 'bg-down text-white dark:text-[#0a0b1a]') : 'text-muted-foreground'" @click="side = k!">{{ n }}</button></div>
      <label class="grid gap-1.5"><span class="small muted">{{ L('الأصل', 'Asset') }}</span><UiNativeSelect v-model="symbol" class="h-12 font-semibold"><option v-for="x in list" :key="x.symbol" :value="x.symbol">{{ x.symbol }}</option></UiNativeSelect></label>
      <p class="!m-0 flex justify-between gap-3"><span class="muted">{{ demo ? L('سعر تجريبي', 'Demo price') : L('السعر الآن', 'Price now') }}</span><b class="num">{{ money(w?.price) }}</b></p>
      <template v-if="side === 'BUY'">
        <label class="grid gap-1.5"><span class="small muted">{{ L('المبلغ بالدولار', 'Amount in dollars') }}</span><UiInput v-model="dollars" type="number" step="any" min="1" inputmode="decimal" dir="ltr" required class="h-12 text-lg font-semibold" /></label>
        <div v-if="free" class="flex gap-2"><button v-for="p in [10, 25, 50, 100]" :key="p" type="button" :class="chip(false)" @click="dollars = Math.floor(free * p) / 100"><bdi dir="ltr">{{ p }}%</bdi></button></div>
        <p class="small muted !m-0 flex justify-between gap-3"><span>{{ L('النقد المتاح', 'Free cash') }}</span><span class="num">{{ money(free) }}</span></p>
        <p v-if="free !== null && Number(dollars) > free" class="small down !m-0">{{ L('المبلغ أكبر من النقد المتاح.', 'The amount is more than your free cash.') }}</p>
      </template>
      <template v-else>
        <div class="flex gap-2"><button v-for="p in [25, 50, 100]" :key="p" type="button" :aria-pressed="part === p" :class="chip(part === p)" @click="part = p"><bdi dir="ltr">{{ p }}%</bdi></button></div>
        <p class="small muted !m-0 flex justify-between gap-3"><span>{{ held ? L('تملك', 'You hold') : L('لا تملك هذا الأصل.', 'You do not hold this asset.') }}</span><span v-if="held" class="num">{{ qty }} / {{ held }}</span></p>
      </template>
      <UiButton type="submit" variant="default" class="!h-12 !text-base !font-semibold" :disabled="busy || !ready">{{ L('راجع الصفقة', 'Review the trade') }}</UiButton>
      <p v-if="error" class="err !m-0" role="alert">{{ error }}</p>
      <p v-if="done" class="up !m-0 flex items-center gap-2" role="status"><CircleCheck class="size-4 shrink-0" aria-hidden="true" />{{ done }}</p>
      <p class="small muted !m-0">{{ L('تريد سعرًا محددًا أو وقفًا وهدفًا؟', 'Want a set price, a stop or a target?') }} <NuxtLink :to="{ path: '/app/orders', query: { symbol, side } }" class="underline">{{ L('صفحة الأوامر', 'Orders page') }}</NuxtLink></p>
    </form>
    <UiConfirm :open="asking" :title="about" :text="L('بسعر السوق. محاكاة ورقية بأموال غير حقيقية.', 'At the market price. Paper simulation with no real money.')" :confirm="L('أكّد', 'Confirm')" :cancel="L('تراجع', 'Back')" :busy="busy" @confirm="send" @close="asking = false" />
  </UiCard>
</template>
