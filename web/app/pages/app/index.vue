<script setup lang="ts">
// the wallet first, then every market it can trade; the chart is the detail of one of them
import { Ban, Minus, Pause, Play, Plus, Sparkles, Square, TrendingDown, TrendingUp, X } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { t, num, lang } = useLang()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const { state, symbol, tf, now, feed, stale } = useTerminal()
const { view: market, short } = useMarketHours()
const notice = useState('startNotice', () => '')
const happened = computed(() => [...feed.value].reverse().map((e) => ({ ...e, text: plain.event(e, ar.value) })).filter((e) => e.text).slice(0, 40))
const TF = computed(() => [['1m', L('دقيقة', '1 minute')], ['5m', L('5 دقائق', '5 minutes')], ['15m', L('15 دقيقة', '15 minutes')], ['1h', L('ساعة', '1 hour')], ['1d', L('يوم', '1 day')]] as [string, string][])
// a price that moves flashes once in its direction
const flash = reactive<Record<string, string>>({})
watch(() => (state.value?.watchlist || []).map((w: any) => [w.symbol, w.price]), (a, b) => { const old = new Map(b as any); for (const [k, v] of a) if (old.has(k) && old.get(k) !== v) { flash[k] = ''; nextTick(() => { flash[k] = v > (old.get(k) as number) ? 'flash-up' : 'flash-down' }) } })
const error = ref('')
const busy = ref(false)
const confirming = ref('')
const newSym = ref('')
const sharia = ref<Record<string, any>>({})
const side = ref('BUY')
const curve = ref<number[]>([])
const lines = ref<Record<string, number[]>>({})

async function run(path: string, body: unknown = {}) {
  busy.value = true
  error.value = ''
  try { return await api(path, body) } catch (e: any) { error.value = e.message } finally { busy.value = false }
}
async function loadSharia() {
  try { sharia.value = Object.fromEntries((await api('sharia')).items.map((x: any) => [x.symbol, x])) } catch { /* shown as unresolved */ }
}
async function loadCurve() { try { curve.value = (await api('equity')).map((p: any) => p.equity).slice(-240) } catch { /* the number stays */ } }
async function loadLines() {
  for (const { symbol: x } of s.value.watchlist || []) {
    try { lines.value[x] = ((await api(`bars?symbol=${encodeURIComponent(x)}&tf=15m`)).bars || []).slice(-60).map((b: any) => b.close) } catch { /* no line for this one */ }
  }
}
async function removeSym(x: string) { if (await run('watchlist/remove', { symbol: x, confirm: true }) && symbol.value === x) symbol.value = s.value.primarySymbol }
async function add() {
  const bad: string[] = []
  for (const x of newSym.value.toUpperCase().split(/[\s,،]+/).filter(Boolean)) if (!(await run('watchlist/add', { symbol: x }))) bad.push(`${x}: ${error.value}`)
  newSym.value = ''
  error.value = bad.join(' · ')
  loadSharia()
}
// asks for a fresh analysis of every monitored market
async function analyzeAll() {
  const bad: string[] = []
  for (const w of s.value.watchlist || []) if (w.status !== 'PAUSED' && !(await run('ai/analyze', { symbol: w.symbol }))) bad.push(`${w.symbol}: ${error.value}`)
  error.value = bad.join(' · ')
}
// continues the existing session: the server requires its exact symbol, capital and mode
const start = () => run('session/start', { symbol: s.value.primarySymbol, initialCapital: s.value.tradingSession.initialCapital, targetCapital: s.value.tradingSession.targetCapital, demo: s.value.tradingSession.dataMode === 'DEMO' })
async function close() { const x = confirming.value; confirming.value = ''; await run('position/close', { symbol: x }) }
function trade(x: string, how: string) { symbol.value = x; side.value = how; nextTick(() => document.getElementById('trade')?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })) }
const timers: any[] = []
onMounted(() => { loadSharia(); loadCurve(); timers.push(setInterval(loadSharia, 30000), setInterval(loadCurve, 30000), setInterval(loadLines, 60000)) })
onBeforeUnmount(() => timers.forEach(clearInterval))

const s = computed(() => state.value || {})
watch(() => (s.value.watchlist || []).map((w: any) => w.symbol).join(), (x) => { if (x) { loadLines(); loadSharia() } }, { immediate: true })
const ai = computed(() => s.value.ai || {})
const demo = computed(() => s.value.tradingSession?.dataMode !== 'LIVE')
const money = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? `$${num(x)}` : '—')
const signed = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? `${x > 0 ? '+' : x < 0 ? '−' : ''}$${num(Math.abs(x))}` : '—')
const tone = (x: any) => (x > 0 ? 'up' : x < 0 ? 'down' : '')
const blocks = computed(() => {
  const out = [...new Set<string>(((s.value.risk && s.value.risk.blocks) || []).map((b: string) => plain.block(b, ar.value)))]
  const x = sharia.value[symbol.value]
  if (s.value.dataMode === 'LIVE' && symbol.value && (!x || x.status !== 'PASS')) out.push(`${t('sharia')} (${symbol.value}): ${t(x ? x.status : 'UNKNOWN')}`)
  if (stale.value) out.push(t('offline'))
  return out
})
const change = computed(() => { const a = s.value.portfolio?.equity; const b = s.value.tradingSession?.initialCapital; return a == null || !(b > 0) ? null : Math.round((a - b) * 100) / 100 })
const FACTS = computed(() => { const p = s.value.portfolio || {}; return [[t('cash'), money(p.cash), ''], [L('قيمة ما تملكه', 'Value held'), money(p.positionValue), ''], [t('unreal'), signed(p.unrealizedPnl), p.unrealizedPnl], [L('ربح محقق', 'Realized P&L'), signed(p.realizedPnl), p.realizedPnl]] as [string, string, any][] })
const STATUS = computed(() => [[t('ai'), plain.auto(ai.value.display?.code, ar.value)], [demo.value ? L('السوق التجريبي', 'Demo market') : t('market'), plain.market(s.value.session?.session, ar.value)], [t('data'), plain.prices(s.value, ar.value)]] as [string, string][])
// the wallet: every position and the cash, each with its share of the whole
const COLORS = ['#4254f5', '#6cbcff', '#6a45e0', '#ffd32e', '#8b97ff', '#2c3bd0', '#b5a3ff', '#1f6fbf', '#e0ac00', '#555b78']
const held = computed(() => {
  const all = s.value.portfolio?.equity || 0
  return (s.value.positions || []).map((p: any) => { const value = p.mark ? p.qty * p.mark : null; return { ...p, value, share: value !== null && all > 0 ? value / all : 0, pct: p.mark && p.avgPrice ? (p.mark / p.avgPrice - 1) * 100 : null } }).sort((a: any, b: any) => (b.value || 0) - (a.value || 0)).map((p: any, i: number) => ({ ...p, color: COLORS[i % COLORS.length] }))
})
const cashShare = computed(() => { const p = s.value.portfolio; return p?.equity > 0 ? Math.max(0, p.cash / p.equity) : 1 })
const limit = computed(() => s.value.risk?.limits?.maxOpenPositions)
const pc = (x: number) => `${(x * 100).toFixed(1)}%`
const SUN = '!border-transparent !bg-sun !px-5 !font-semibold !text-sun-foreground hover:!bg-white'
const LINE = '!border-white/45 !bg-transparent !text-white hover:!bg-white hover:!text-[#0d0f26]'
const age = (ts: number) => { if (!ts) return '—'; const n = Math.max(0, Math.round((now.value - ts) / 1000)); return n < 90 ? `${n} ${L('ث', 's')}` : n < 5400 ? `${Math.round(n / 60)} ${L('د', 'min')}` : `${Math.round(n / 3600)} ${L('س', 'h')}` }
const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB')
</script>

<template>
  <div>
  <p v-if="error" class="err" role="alert">{{ error }}</p>
  <p v-if="notice" class="mb-4 flex items-center gap-3 rounded-3xl bg-brass-soft px-5 py-3 text-brass" role="status"><span class="flex-1">{{ notice }}</span><UiButton size="icon" variant="ghost" class="!size-8" :aria-label="L('إخفاء', 'Dismiss')" @click="notice = ''"><X /></UiButton></p>
  <UiCard v-if="state && !s.tradingSession" class="mx-auto max-w-3xl !p-6 sm:!p-10"><h2 class="!mb-1 !text-2xl">{{ L('ابدأ أول محاكاة', 'Start your first simulation') }}</h2><p class="muted !mb-7">{{ L('أربع خطوات قصيرة، ثم ترى محفظتك وأسواقك هنا.', 'Four short steps, then your wallet and markets appear here.') }}</p><StartForm /></UiCard>
  <template v-else-if="state">
  <div v-if="ai.approvals?.length" class="mb-4 grid gap-3" role="status"><div v-for="a in ai.approvals" :key="a.id" class="rise flex flex-wrap items-center gap-x-5 gap-y-3 rounded-3xl bg-sun px-6 py-5 text-sun-foreground"><SymbolIcon :symbol="a.symbol" class="!size-11" /><b class="font-display text-xl">{{ t('approvals') }}: {{ plain.action(a.action, ar) }} <bdi>{{ a.symbol || '' }}</bdi></b><span class="num font-medium">{{ Math.max(0, Math.round((a.expiresAt - now) / 1000)) }} {{ L('ث', 's') }}</span><span class="grow" /><div class="flex gap-2 max-sm:w-full"><UiButton class="!border-transparent !bg-[#0a0b1a] !text-white max-sm:flex-1" :disabled="busy" @click="run(`proposals/${a.id}/approve`)">{{ t('approve') }}</UiButton><UiButton class="!border-[#0a0b1a] !bg-transparent !text-[#0a0b1a] max-sm:flex-1" :disabled="busy" @click="run(`proposals/${a.id}/reject`)">{{ t('reject') }}</UiButton></div></div></div>

  <section class="product-night relative mb-4 overflow-hidden rounded-3xl p-6 text-white [--ring:#ffd32e] sm:p-9"><NightField />
    <div class="relative flex flex-wrap items-start justify-between gap-x-10 gap-y-6">
      <div><h1 class="font-sans text-base font-medium">{{ L('محفظتك الورقية', 'Your paper wallet') }}</h1><p class="!m-0 flex flex-wrap items-center gap-x-4 gap-y-2"><b class="num font-display text-5xl leading-tight font-bold sm:text-6xl">{{ money(s.portfolio?.equity) }}</b><span v-if="change !== null" class="num inline-flex items-center gap-1.5 rounded-full bg-white px-3.5 py-1 font-semibold" :class="change > 0 ? 'text-[#0c7446]' : change < 0 ? 'text-[#bd2638]' : 'text-[#0d0f26]'"><component :is="change > 0 ? TrendingUp : change < 0 ? TrendingDown : Minus" class="size-4" aria-hidden="true" />{{ signed(change) }}</span></p></div>
      <div class="flex flex-wrap items-center gap-2.5">
        <label class="flex items-center gap-2 text-sm">{{ t('mode') }} <UiNativeSelect class="text-foreground" :value="ai.autonomy" :disabled="busy" @change="run('settings', { ai: { autonomy: ($event.target as HTMLSelectElement).value } })"><option v-for="m in ['FULL', 'SEMI', 'ADVISORY']" :key="m" :value="m">{{ t(m) }}</option></UiNativeSelect></label>
        <UiButton v-if="ai.state === 'PAUSED'" :class="SUN" :disabled="busy" @click="run('ai/resume')"><Play />{{ t('resume') }}</UiButton>
        <UiButton v-else-if="ai.state !== 'RUNNING'" :class="SUN" :disabled="busy" @click="start"><Play />{{ t('start') }}</UiButton>
        <template v-else><UiButton :class="SUN" :disabled="busy" @click="analyzeAll"><Sparkles />{{ L('حلّل الكل', 'Analyze all') }}</UiButton><UiButton :class="LINE" :disabled="busy" @click="run('ai/pause')"><Pause />{{ t('pause') }}</UiButton><UiButton :class="LINE" :disabled="busy" @click="run('ai/stop')"><Square />{{ t('stop') }}</UiButton></template>
      </div>
    </div>
    <SparkLine v-if="curve.length > 1" :points="[...curve, s.portfolio?.equity]" area class="relative mt-5 h-24 w-full text-sky" />
    <ul class="relative mt-5 grid !list-none grid-cols-2 gap-3 !p-0 xl:grid-cols-4"><li v-for="[k, v] in FACTS" :key="k" class="min-w-0 rounded-2xl bg-[#0d0f26]/55 px-5 py-3.5"><span class="block text-sm text-panel-muted">{{ k }}</span><b class="block font-display text-xl leading-snug font-semibold"><span class="num">{{ v }}</span></b></li></ul>
    <p class="relative !mt-5 !mb-0 flex flex-wrap gap-x-6 gap-y-1 text-sm"><span v-for="[k, v] in STATUS" :key="k"><span class="text-white/80">{{ k }}:</span> <b>{{ v }}</b></span></p>
  </section>

  <MarketHours />

  <div class="cols">
    <div>
      <UiCard>
        <div class="row"><h2>{{ L('ما في محفظتك', 'In your wallet') }}</h2><span class="grow" /><span v-if="limit" class="small muted">{{ L('حد المراكز للتداول الآلي', 'Position limit for automation') }} <span class="num">{{ limit }}</span> · {{ L('المفتوح', 'open') }} <span class="num">{{ held.length }}</span> <NuxtLink to="/app/settings" class="underline">{{ L('غيّر الحد', 'Change limit') }}</NuxtLink></span></div>
        <div class="mb-5 flex h-4 gap-0.5 overflow-hidden rounded-full bg-secondary" aria-hidden="true"><span v-for="p in held" :key="p.symbol" class="transition-[width] duration-500" :style="{ width: pc(p.share), background: p.color }" /></div>
        <ul class="!list-none !p-0">
          <li v-for="p in held" :key="p.symbol" class="flex flex-wrap items-center gap-x-4 gap-y-2 border-b py-4">
            <button type="button" class="flex min-w-44 flex-1 items-center gap-3 rounded-xl text-start" @click="symbol = p.symbol"><SymbolIcon :symbol="p.symbol" class="!size-11" /><span><b class="flex items-center gap-2 text-base"><i class="size-2.5 rounded-full" :style="{ background: p.color }" /><bdi>{{ p.symbol }}</bdi></b><span class="small muted num">{{ p.qty }} × {{ money(p.avgPrice) }}</span></span></button>
            <span class="min-w-28"><b class="block"><span class="num">{{ money(p.value) }}</span></b><span class="small muted block"><span class="num">{{ pc(p.share) }}</span></span></span>
            <span class="min-w-24"><b class="block"><span class="num" :class="tone(p.unrealizedPnl)">{{ signed(p.unrealizedPnl) }}</span></b><span class="small num" :class="tone(p.pct)">{{ p.pct === null ? '—' : `${num(p.pct)}%` }}</span></span>
            <span class="small min-w-28 max-sm:hidden"><span class="muted">{{ t('stopLoss') }}</span> <span class="num">{{ num(p.stop) }}</span><br><span class="muted">{{ t('target') }}</span> <span class="num">{{ num(p.takeProfit) }}</span></span>
            <span class="flex gap-2"><UiButton size="sm" @click="trade(p.symbol, 'BUY')">{{ L('زِد', 'Buy more') }}</UiButton><UiButton size="sm" variant="destructive" :disabled="busy" @click="confirming = p.symbol">{{ t('close') }}</UiButton></span>
          </li>
          <li class="flex items-center gap-4 pt-4"><span class="inline-flex size-11 items-center justify-center rounded-full bg-secondary font-display font-semibold text-secondary-foreground" aria-hidden="true">$</span><b class="flex-1 text-base">{{ t('cash') }}</b><span class="text-end"><b class="block"><span class="num">{{ money(s.portfolio?.cash) }}</span></b><span class="small muted num">{{ pc(cashShare) }}</span></span></li>
        </ul>
        <p v-if="!held.length" class="muted !mt-4 !mb-0">{{ L('لا مراكز الآن. كل محفظتك نقد، ويمكنك الشراء من «تداول سريع» أو ترك التداول الآلي يقترح.', 'No positions now. Your wallet is all cash: buy with Quick trade, or let automation suggest.') }}</p>
      </UiCard>
    </div>
    <div><TradeBox v-model:symbol="symbol" v-model:side="side" /></div>
  </div>

  <section class="mt-4 mb-4" aria-labelledby="markets">
    <div class="mb-4 flex flex-wrap items-center gap-3"><h2 id="markets" class="!m-0 !text-2xl">{{ L('أسواقك', 'Your markets') }} <span class="num muted text-base">{{ (s.watchlist || []).length }} / {{ s.maxSymbols }}</span></h2><UiBadge v-if="demo" tone="warn">{{ L('أسعار تجريبية', 'Demo prices') }}</UiBadge><span class="grow" />
      <form class="flex gap-2 max-sm:w-full" @submit.prevent="add"><UiInput v-model="newSym" dir="ltr" maxlength="60" class="max-sm:flex-1 sm:w-56" placeholder="AAPL, TSLA, BTC/USD" :aria-label="L('رموز تضاف، بينها فاصلة', 'Symbols to add, separated by commas')" /><UiButton type="submit" variant="default" :disabled="busy || !newSym.trim()"><Plus />{{ t('add') }}</UiButton></form></div>
    <ul class="grid !list-none gap-4 !p-0 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      <li v-for="w in s.watchlist || []" :key="w.symbol" class="flex min-w-0 flex-col rounded-3xl border bg-card p-5" :class="w.symbol === symbol && 'border-primary ring-2 ring-primary'">
        <button type="button" class="block w-full rounded-2xl text-start" :aria-pressed="w.symbol === symbol" @click="symbol = w.symbol">
          <span class="flex items-center gap-3"><SymbolIcon :symbol="w.symbol" class="!size-11" /><span class="min-w-0 flex-1"><b class="block text-lg leading-tight"><bdi>{{ w.symbol }}</bdi></b><span class="small" :class="w.fresh ? 'muted' : 'down'">{{ t('updated') }} {{ age(w.priceTs) }}</span></span><span class="text-end"><b class="block rounded-md font-display text-lg leading-tight"><span class="num" :class="flash[w.symbol]">{{ money(w.price) }}</span></b><span class="num small" :class="tone(w.changePct)">{{ num(w.changePct) }}%</span></span></span>
          <SparkLine :points="lines[w.symbol] ? [...lines[w.symbol]!, w.price] : []" area class="my-4 h-16 w-full" :class="tone(w.changePct) || 'muted'" />
        </button>
        <p class="!mb-4 flex flex-wrap items-center gap-2"><UiBadge :tone="sharia[w.symbol]?.status || 'UNKNOWN'">{{ t(sharia[w.symbol]?.status || 'UNKNOWN') }}</UiBadge><UiBadge v-if="w.symbol.includes('/')"><bdi>24/7</bdi></UiBadge><UiBadge v-else-if="market">{{ market.open ? L('يغلق بعد', 'Closes in') : L('يفتح بعد', 'Opens in') }}&nbsp;<bdi>{{ short(market.left) }}</bdi></UiBadge><UiBadge v-if="w.status === 'PAUSED'">{{ L('المراقبة متوقفة', 'Monitoring paused') }}</UiBadge><UiBadge v-else>{{ w.analyzing ? L('يحلل الآن', 'Analyzing') : w.aiAction ? `${t('decision')}: ${plain.action(w.aiAction, ar)}` : L('لا قرار بعد', 'No decision yet') }}</UiBadge><UiBadge v-if="w.positionQty">{{ L('تملك', 'Held') }}&nbsp;<bdi>{{ w.positionQty }}</bdi></UiBadge></p>
        <div class="mt-auto flex items-center gap-2"><UiButton variant="default" class="flex-1" @click="trade(w.symbol, 'BUY')">{{ L('شراء', 'Buy') }}</UiButton><UiButton class="flex-1" :disabled="!w.positionQty" @click="trade(w.symbol, 'SELL')">{{ L('بيع', 'Sell') }}</UiButton><UiButton size="icon" variant="ghost" :disabled="busy" :aria-label="`${w.status === 'PAUSED' ? L('استأنف مراقبة', 'Resume') : L('أوقف مراقبة', 'Pause')} ${w.symbol}`" @click="run(w.status === 'PAUSED' ? 'watchlist/resume' : 'watchlist/pause', { symbol: w.symbol })"><component :is="w.status === 'PAUSED' ? Play : Pause" /></UiButton><UiButton v-if="w.symbol !== s.primarySymbol && !w.positionQty" size="icon" variant="ghost" :aria-label="`${L('إزالة', 'Remove')} ${w.symbol}`" :disabled="busy" @click="removeSym(w.symbol)"><X /></UiButton></div>
      </li>
    </ul>
  </section>

  <div class="cols">
    <div>
      <UiCard>
        <div class="row"><SymbolIcon :symbol="symbol" class="!size-11" /><h2 class="!text-2xl"><bdi>{{ symbol || '—' }}</bdi></h2><UiBadge v-if="demo" tone="warn">{{ L('سعر تجريبي', 'Demo price') }}</UiBadge><span class="grow" />
          <UiNativeSelect v-model="symbol" :aria-label="t('symbol')"><option v-for="w in s.watchlist || []" :key="w.symbol" :value="w.symbol">{{ w.symbol }}</option></UiNativeSelect>
          <UiNativeSelect v-model="tf" :aria-label="L('المدة', 'Interval')"><option v-for="[x, n] in TF" :key="x" :value="x">{{ n }}</option></UiNativeSelect></div>
        <PriceChart />
      </UiCard>
    </div>
    <div>
      <UiCard v-if="blocks.length">
        <h2>{{ t('blocks') }}</h2>
        <ul class="!list-none !p-0"><li v-for="b in blocks" :key="b" class="flex gap-3 border-b py-2.5 last:border-0 last:pb-0"><Ban class="mt-1 size-4 shrink-0 text-down" aria-hidden="true" />{{ b }}</li></ul>
      </UiCard>
      <UiCard>
        <h2>{{ t('activity') }}</h2>
        <div class="scroll" style="max-height:26rem"><TransitionGroup name="feed"><div v-for="e in happened" :key="e.seq" class="step-item relative ps-7 pb-4"><bdi class="block">{{ e.text }}</bdi><span class="num small muted">{{ time(e.ts) }}</span></div></TransitionGroup><p v-if="!happened.length" class="muted">{{ t('none') }}</p></div>
      </UiCard>
    </div>
  </div>
  <UiConfirm :open="!!confirming" :title="`${t('close')} ${confirming}`" :text="t('close_text')" :confirm="t('confirm_close')" :cancel="t('cancel')" :busy="busy" @confirm="close" @close="confirming = ''" />
  </template>
  </div>
</template>

<style scoped>
/* what happened, as dots on one line */
.step-item::before { content: ""; position: absolute; inset-inline-start: 0.1rem; top: 0.45rem; width: 0.7rem; height: 0.7rem; border-radius: 99px; background: var(--brand); z-index: 1; }
.step-item::after { content: ""; position: absolute; inset-inline-start: 0.4rem; top: 0.9rem; bottom: -0.5rem; width: 2px; background: var(--border); }
.step-item:last-child::after { display: none; }
.step-item:first-child::before { background: var(--sun); }
</style>
