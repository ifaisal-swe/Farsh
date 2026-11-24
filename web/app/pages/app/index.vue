<script setup lang="ts">
import { X } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { t, num, lang } = useLang()
const ar = computed(() => lang.value === 'ar')
const { state, symbol, tf, now, feed, stale } = useTerminal()
const happened = computed(() => [...feed.value].reverse().map((e) => ({ ...e, text: plain.event(e, ar.value) })).filter((e) => e.text).slice(0, 40))
const TF = computed(() => [['1m', ar.value ? 'دقيقة' : '1 minute'], ['5m', ar.value ? '5 دقائق' : '5 minutes'], ['15m', ar.value ? '15 دقيقة' : '15 minutes'], ['1h', ar.value ? 'ساعة' : '1 hour'], ['1d', ar.value ? 'يوم' : '1 day']])
// a price that moves flashes once in its direction
const flash = reactive<Record<string, string>>({})
watch(() => (state.value?.watchlist || []).map((w: any) => [w.symbol, w.price]), (a, b) => { const old = new Map(b as any); for (const [k, v] of a) if (old.has(k) && old.get(k) !== v) { flash[k] = ''; nextTick(() => { flash[k] = v > (old.get(k) as number) ? 'flash-up' : 'flash-down' }) } })
const error = ref('')
const busy = ref(false)
const confirming = ref('')
const newSym = ref('')
const sharia = ref<Record<string, any>>({})

async function run(path: string, body: unknown = {}) {
  busy.value = true
  error.value = ''
  try { return await api(path, body) } catch (e: any) { error.value = e.message } finally { busy.value = false }
}
async function loadSharia() {
  try { sharia.value = Object.fromEntries((await api('sharia')).items.map((x: any) => [x.symbol, x])) } catch { /* shown as unresolved */ }
}
async function removeSym(x: string) { if (await run('watchlist/remove', { symbol: x, confirm: true }) && symbol.value === x) symbol.value = s.value.primarySymbol }
async function add() { if (await run('watchlist/add', { symbol: newSym.value })) { newSym.value = ''; loadSharia() } }
// continues the existing session: the server requires its exact symbol, capital and mode
const start = () => run('session/start', { symbol: s.value.primarySymbol, initialCapital: s.value.tradingSession.initialCapital, targetCapital: s.value.tradingSession.targetCapital, demo: s.value.tradingSession.dataMode === 'DEMO' })
async function close() { const s = confirming.value; confirming.value = ''; await run('position/close', { symbol: s }) }
let timer: any
onMounted(() => { loadSharia(); timer = setInterval(loadSharia, 30000) })
onBeforeUnmount(() => clearInterval(timer))

const s = computed(() => state.value || {})
const ai = computed(() => s.value.ai || {})
// the state push is for one symbol: never show another symbol's position under the selected name
const pos = computed(() => (s.value.selectedSymbol === symbol.value ? s.value.position : null))
const blocks = computed(() => {
  const out = [...new Set<string>(((s.value.risk && s.value.risk.blocks) || []).map((b: string) => plain.block(b, ar.value)))]
  const x = sharia.value[symbol.value]
  if (s.value.dataMode === 'LIVE' && symbol.value && (!x || x.status !== 'PASS')) out.push(`${t('sharia')}: ${t(x ? x.status : 'UNKNOWN')}`)
  if (stale.value) out.push(t('offline'))
  return out
})
const age = (ts: number) => { if (!ts) return '—'; const n = Math.max(0, Math.round((now.value - ts) / 1000)); return n < 90 ? `${n} ${ar.value ? 'ث' : 's'}` : n < 5400 ? `${Math.round(n / 60)} ${ar.value ? 'د' : 'min'}` : `${Math.round(n / 3600)} ${ar.value ? 'س' : 'h'}` }
const time = (ts: number) => new Date(ts).toLocaleTimeString('en-GB')
</script>

<template>
  <div>
  <p v-if="error" class="err" role="alert">{{ error }}</p>
  <UiCard v-if="state && !s.tradingSession" class="mx-auto max-w-3xl !p-6 sm:!p-10"><h2 class="!mb-1 !text-2xl">{{ ar ? 'ابدأ أول محاكاة' : 'Start your first simulation' }}</h2><p class="muted !mb-7">{{ ar ? 'أربع خطوات قصيرة، ثم ترى الأسعار والقرارات هنا.' : 'Four short steps, then prices and decisions appear here.' }}</p><StartForm /></UiCard>
  <template v-else-if="state">
  <div v-if="ai.approvals?.length" class="mb-4 grid gap-3" role="status"><div v-for="a in ai.approvals" :key="a.id" class="rise flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl bg-sun px-5 py-4 text-sun-foreground"><b class="font-display text-lg">{{ t('approvals') }}: {{ plain.action(a.action, ar) }} <bdi>{{ a.symbol || '' }}</bdi></b><span class="num font-medium">{{ Math.max(0, Math.round((a.expiresAt - now) / 1000)) }} {{ ar ? 'ث' : 's' }}</span><span class="grow" /><div class="flex gap-2 max-sm:w-full"><UiButton class="!border-transparent !bg-[#0a0b1a] !text-white max-sm:flex-1" :disabled="busy" @click="run(`proposals/${a.id}/approve`)">{{ t('approve') }}</UiButton><UiButton class="!border-[#0a0b1a] !bg-transparent !text-[#0a0b1a] max-sm:flex-1" :disabled="busy" @click="run(`proposals/${a.id}/reject`)">{{ t('reject') }}</UiButton></div></div></div>
  <div class="tiles">
    <div class="tile"><span class="small muted">{{ t('equity') }}</span><b class="num">{{ num(s.portfolio?.equity) }}</b></div>
    <div class="tile"><span class="small muted">{{ t('cash') }}</span><b class="num">{{ num(s.portfolio?.cash) }}</b></div>
    <div class="tile"><span class="small muted">{{ t('ai') }}</span><b>{{ plain.auto(ai.display?.code, ar) }}</b></div>
    <div class="tile"><span class="small muted">{{ t('market') }}</span><b>{{ plain.market(s.session?.session, ar) }}</b></div>
    <div class="tile"><span class="small muted">{{ t('data') }}</span><b>{{ plain.prices(s, ar) }}</b></div>
  </div>
  <div class="cols dash">
    <div>
      <UiCard class="o1">
        <div class="row"><h2><bdi>{{ symbol || '—' }}</bdi></h2><UiBadge v-if="s.tradingSession?.dataMode !== 'LIVE'" tone="warn">{{ ar ? 'سعر تجريبي' : 'Demo price' }}</UiBadge><span class="grow" />
          <UiNativeSelect v-model="tf" :aria-label="ar ? 'المدة' : 'Interval'"><option v-for="[x, n] in TF" :key="x" :value="x">{{ n }}</option></UiNativeSelect></div>
        <PriceChart />
      </UiCard>
      <UiCard class="o4">
        <div class="row"><h2>{{ t('watchlist') }}</h2><span class="grow" />
          <UiInput v-model="newSym" dir="ltr" maxlength="10" class="max-sm:min-w-0 max-sm:flex-1" :placeholder="t('symbol')" :aria-label="t('symbol')" @keyup.enter="add" /><UiButton variant="outline" :disabled="busy || !newSym" @click="add">{{ t('add') }}</UiButton></div>
        <ul class="!list-none !p-0 sm:hidden"><li v-for="w in s.watchlist || []" :key="w.symbol"><button type="button" class="flex w-full items-center gap-3 border-b py-3 text-start" :class="w.symbol === symbol && 'font-semibold text-primary'" :aria-pressed="w.symbol === symbol" @click="symbol = w.symbol"><span class="min-w-0 flex-1"><bdi class="block font-semibold">{{ w.symbol }}</bdi><UiBadge class="mt-1" :tone="sharia[w.symbol]?.status || 'UNKNOWN'">{{ t(sharia[w.symbol]?.status || 'UNKNOWN') }}</UiBadge></span><span class="text-end"><span class="num block rounded-md font-semibold" :class="flash[w.symbol]">{{ num(w.price) }}</span><span class="num small" :class="w.changePct > 0 ? 'up' : w.changePct < 0 ? 'down' : ''">{{ num(w.changePct) }}%</span></span></button></li></ul>
        <UiTable class="max-sm:hidden">
          <thead><tr><th v-for="k in ['symbol', 'price', 'age', 'change', 'sharia', 'decision', 'position', 'pnl']" :key="k">{{ k === 'price' && s.tradingSession?.dataMode !== 'LIVE' ? (ar ? 'سعر تجريبي' : 'Demo price') : t(k) }}</th><th /></tr></thead>
          <tbody><tr v-for="w in s.watchlist || []" :key="w.symbol" class="pick" :class="{ on: w.symbol === symbol }" tabindex="0" @click="symbol = w.symbol" @keyup.enter="symbol = w.symbol">
            <td><bdi>{{ w.symbol }}</bdi></td><td class="num" :class="flash[w.symbol]">{{ num(w.price) }}</td><td :class="w.fresh ? 'muted' : 'down'">{{ age(w.priceTs) }}</td>
            <td><span class="num" :class="w.changePct > 0 ? 'up' : w.changePct < 0 ? 'down' : ''">{{ num(w.changePct) }}%</span></td>
            <td><UiBadge :tone="sharia[w.symbol]?.status || 'UNKNOWN'">{{ t(sharia[w.symbol]?.status || 'UNKNOWN') }}</UiBadge></td>
            <td>{{ w.aiAction ? plain.action(w.aiAction, ar) : '—' }}</td><td class="num">{{ w.positionQty || '—' }}</td><td><span class="num" :class="w.unrealizedPnl > 0 ? 'up' : w.unrealizedPnl < 0 ? 'down' : ''">{{ num(w.unrealizedPnl) }}</span></td><td><UiButton v-if="w.symbol !== s.primarySymbol && !w.positionQty" size="icon" variant="ghost" class="!size-8" :aria-label="`${ar ? 'إزالة' : 'Remove'} ${w.symbol}`" :disabled="busy" @click.stop="removeSym(w.symbol)"><X /></UiButton></td>
          </tr></tbody>
        </UiTable>
      </UiCard>
    </div>
    <div>
      <UiCard class="o2">
        <h2>{{ t('auto') }}</h2>
        <p v-if="!s.tradingSession" class="muted">{{ t('no_session') }}</p>
        <template v-else>
          <div class="row"><label>{{ t('mode') }} <UiNativeSelect :value="ai.autonomy" :disabled="busy" @change="run('settings', { ai: { autonomy: ($event.target as HTMLSelectElement).value } })"><option v-for="m in ['FULL', 'SEMI', 'ADVISORY']" :key="m" :value="m">{{ t(m) }}</option></UiNativeSelect></label></div>
          <div class="row">
            <UiButton v-if="ai.state === 'PAUSED'" variant="default" :disabled="busy" @click="run('ai/resume')">{{ t('resume') }}</UiButton>
            <UiButton v-else-if="ai.state !== 'RUNNING'" variant="default" :disabled="busy" @click="start">{{ t('start') }}</UiButton>
            <UiButton variant="outline" :disabled="busy || ai.state !== 'RUNNING'" @click="run('ai/pause')">{{ t('pause') }}</UiButton>
            <UiButton variant="outline" :disabled="busy || ai.state !== 'RUNNING'" @click="run('ai/stop')">{{ t('stop') }}</UiButton>
            <UiButton variant="outline" :disabled="busy || ai.state !== 'RUNNING'" @click="run('ai/analyze', { symbol })">{{ t('analyze') }}</UiButton>
          </div>
        </template>
      </UiCard>
      <UiCard v-if="blocks.length" class="o3">
        <h2>{{ t('blocks') }}</h2>
        <ul><li v-for="b in blocks" :key="b">{{ b }}</li></ul>
      </UiCard>
      <UiCard v-if="pos" class="o2">
        <h2>{{ t('position') }} <bdi>{{ symbol }}</bdi></h2>
        <p><span class="num">{{ pos.qty }} @ {{ num(pos.avgPrice) }}</span><br>{{ t('stopLoss') }}: <span class="num">{{ num(pos.stop) }}</span> · {{ t('target') }}: <span class="num">{{ num(pos.takeProfit) }}</span></p>
        <UiButton variant="destructive" @click="confirming = symbol">{{ t('close') }}</UiButton>
        <UiConfirm :open="!!confirming" :title="`${t('close')} ${confirming}`" :text="t('close_text')" :confirm="t('confirm_close')" :cancel="t('cancel')" :busy="busy" @confirm="close" @close="confirming = ''" />
      </UiCard>
      <UiCard class="o5">
        <h2>{{ t('activity') }}</h2>
        <div class="scroll" style="max-height:320px"><TransitionGroup name="feed"><div v-for="e in happened" :key="e.seq" class="item small"><span class="num muted">{{ time(e.ts) }}</span> <bdi>{{ e.text }}</bdi></div></TransitionGroup><p v-if="!happened.length" class="muted">{{ t('none') }}</p></div>
      </UiCard>
    </div>
  </div>
  </template>
  </div>
</template>
