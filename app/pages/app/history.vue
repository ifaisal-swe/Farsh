<script setup lang="ts">
import { plain } from '~/lib/plain'
import { buttonVariants } from '~/lib/button'
import { chartColors } from '~/lib/chart'
import { createChart, LineSeries, type IChartApi } from 'lightweight-charts'
const { lang, num } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const PERIODS: [string, string, string][] = [['today', 'اليوم', 'Today'], ['week', 'الأسبوع', 'Week'], ['month', 'الشهر', 'Month'], ['all', 'الكل', 'All']]
const period = ref('all')
const side = ref('')
const tab = ref<'fills' | 'orders'>('fills')
const page = ref(0)
const list = ref<any>({ total: 0, items: [] })
const stats = ref<any>(null)
const error = ref('')
const box = ref<HTMLElement | null>(null)
const hasCurve = ref(true)
const SIZE = 50
const KINDS: Record<string, string> = { today: 'daily', week: 'weekly', month: 'monthly' }
const report = ref<any>(null)
let chart: IChartApi | null = null
let line: any = null
const { dark } = useTheme()
watch(dark, () => nextTick(() => { const c = chartColors(dark.value); chart?.applyOptions(c.options); line?.applyOptions({ color: c.line }) }))
let seq = 0
async function load() {
  const id = ++seq
  error.value = ''
  try {
    const q = `period=${period.value}&limit=${SIZE}&offset=${page.value * SIZE}${side.value ? `&side=${side.value}` : ''}`
    const [a, s] = await Promise.all([api(`${tab.value === 'fills' ? 'trades' : 'orders'}?${q}`), api(`stats?period=${period.value}`)])
    const r = KINDS[period.value] ? await api(`report/${KINDS[period.value]}`) : null
    if (id === seq) { list.value = a; stats.value = s; report.value = r }
  } catch (e: any) { if (id === seq) error.value = e.message }
}
async function curve() {
  try {
    const pts = await api('equity')
    const byTime = new Map<number, number>()
    for (const p of pts) byTime.set(Math.floor(p.ts / 1000), p.equity)
    hasCurve.value = byTime.size > 1
    if (!box.value || !hasCurve.value) return
    chart = createChart(box.value, { autoSize: true, ...chartColors(dark.value).options })
    line = chart.addSeries(LineSeries, { color: chartColors(dark.value).line, lineWidth: 2 })
    line.setData([...byTime].sort((x, y) => x[0] - y[0]).map(([time, value]) => ({ time: time as any, value })))
    chart.timeScale().fitContent()
  } catch (e: any) { error.value = e.message }
}
watch([period, side, tab], () => { page.value = 0; load() })
watch(page, load)
onMounted(() => { load(); curve() })
onBeforeUnmount(() => { seq++; chart?.remove(); chart = null; line = null })
const when = (t: number) => new Date(t).toLocaleString('en-GB')
const tiles = computed(() => {
  const s = stats.value
  if (!s) return []
  return [[L("ربح محقق", "Realized P&L"), s.portfolio?.realizedPnl], [L("نسبة الصفقات الرابحة %", "Win rate %"), s.trading?.winRatePct], [L("أقصى تراجع %", "Max drawdown %"), s.risk?.maxDrawdownPct], [L("الرسوم", "Fees"), s.trading?.fees]].filter(([, v]) => typeof v === "number")
})
</script>

<template>
  <div>
  <p v-if="error" class="err" role="alert">{{ error }}</p>
  <div class="row"><UiNativeSelect v-model="period" :aria-label="L('الفترة', 'Period')"><option v-for="[k, ar, en] in PERIODS" :key="k" :value="k">{{ L(ar, en) }}</option></UiNativeSelect>
    <a data-slot="button" :class="buttonVariants({ variant: 'outline' })" href="/api/export/trades.csv">{{ L('تنزيل السجل', 'Download') }}</a></div>
  <div class="tiles"><div v-for="[k, v] in tiles" :key="String(k)" class="tile"><span class="small muted">{{ k }}</span><b class="num">{{ num(v) }}</b></div></div>
  <UiCard v-if="report"><h2>{{ L('تقرير الفترة', 'Period report') }}</h2>
    <p>{{ L('الأكثر ربحًا', 'Best') }}: <bdi>{{ report.topContributor ? `${report.topContributor.symbol} ${num(report.topContributor.pnl)}` : '—' }}</bdi> · {{ L('الأكثر خسارة', 'Worst') }}: <bdi>{{ report.worstContributor ? `${report.worstContributor.symbol} ${num(report.worstContributor.pnl)}` : '—' }}</bdi></p>
    <template v-for="[k, title] in [['aiHighlights', L('تغيّر الرأي', 'Changes of view')], ['newsEvents', L('أخبار مهمة', 'Important news')]]" :key="k"><b>{{ title }}</b><ul><li v-for="(e, n) in report[k]" :key="n" class="small"><span class="num muted">{{ when(e.ts) }}</span> <bdi>{{ e.symbol }} {{ e.title || `${plain.action(e.from, lang === 'ar')} ${lang === 'ar' ? '←' : '→'} ${plain.action(e.to, lang === 'ar')}` }}</bdi></li><li v-if="!report[k].length" class="small muted">—</li></ul></template></UiCard>
  <UiCard><h2>{{ L('قيمة المحفظة', 'Equity') }}</h2><div v-show="hasCurve" ref="box" class="chart" style="height:260px" /><p v-if="!hasCurve" class="muted">{{ L('لا بيانات كافية بعد.', 'Not enough data yet.') }}</p></UiCard>
  <UiCard>
    <div class="row"><UiButton :variant="tab === 'fills' ? 'default' : 'outline'" @click="tab = 'fills'">{{ L('الصفقات المنفذة', 'Executed trades') }}</UiButton><UiButton :variant="tab === 'orders' ? 'default' : 'outline'" @click="tab = 'orders'">{{ L('الأوامر', 'Orders') }}</UiButton>
      <UiNativeSelect v-model="side" :aria-label="L('الاتجاه', 'Side')"><option value="">{{ L('الكل', 'All') }}</option><option value="BUY">{{ L('شراء', 'Buy') }}</option><option value="SELL">{{ L('بيع', 'Sell') }}</option></UiNativeSelect><span class="grow" /><span class="num muted">{{ list.total }}</span></div>
    <ul class="!list-none !p-0 sm:hidden"><li v-for="x in list.items" :key="x.id" class="flex items-center gap-3 border-b py-3"><span class="min-w-0 flex-1"><b>{{ x.side === 'BUY' ? L('شراء', 'Buy') : L('بيع', 'Sell') }} <bdi>{{ x.symbol }}</bdi></b><span class="num small muted block">{{ when(x.ts || x.createdAt) }}</span></span><span class="text-end"><span class="num block">{{ x.qty ?? '—' }} × {{ num(x.price ?? x.avgFillPrice ?? x.limitPrice) }}</span><span v-if="tab === 'fills'" class="num small" :class="x.realizedPnl > 0 ? 'up' : x.realizedPnl < 0 ? 'down' : 'muted'">{{ x.side === 'SELL' ? num(x.realizedPnl) : '' }}</span><span v-else class="small muted">{{ plain.order(x.status, lang === 'ar') }}</span></span></li><li v-if="!list.items.length" class="muted">{{ L('لا نتائج', 'Nothing here') }}</li></ul>
    <UiTable class="max-sm:hidden"><thead><tr><th>{{ L('الوقت', 'Time') }}</th><th>{{ L('السهم', 'Symbol') }}</th><th>{{ L('الاتجاه', 'Side') }}</th><th>{{ L('الكمية', 'Quantity') }}</th><th>{{ L('السعر', 'Price') }}</th><th>{{ tab === 'fills' ? L('الربح المحقق', 'Realized P&L') : L('الحالة', 'Status') }}</th><th>{{ L('السبب', 'Reason') }}</th></tr></thead>
      <tbody><tr v-for="x in list.items" :key="x.id"><td class="num">{{ when(x.ts || x.createdAt) }}</td><td><bdi>{{ x.symbol }}</bdi></td><td>{{ x.side === 'BUY' ? L('شراء', 'Buy') : L('بيع', 'Sell') }}</td><td class="num">{{ x.qty ?? '—' }}</td><td class="num">{{ num(x.price ?? x.avgFillPrice ?? x.limitPrice) }}</td>
        <td><span v-if="tab === 'fills'" class="num" :class="x.realizedPnl > 0 ? 'up' : x.realizedPnl < 0 ? 'down' : ''">{{ x.side === 'SELL' ? num(x.realizedPnl) : '—' }}</span><bdi v-else>{{ plain.order(x.status, lang === 'ar') }}</bdi></td><td class="small muted">{{ plain.why(x.kind || x.source, lang === 'ar') }}</td></tr>
        <tr v-if="!list.items.length"><td colspan="7" class="muted">{{ L('لا نتائج', 'Nothing here') }}</td></tr></tbody></UiTable>
    <div v-if="list.total > SIZE" class="row"><UiButton variant="outline" :disabled="page === 0" @click="page--">‹</UiButton><span class="num">{{ page + 1 }} / {{ Math.ceil(list.total / SIZE) }}</span><UiButton variant="outline" :disabled="(page + 1) * SIZE >= list.total" @click="page++">›</UiButton></div>
  </UiCard>
  </div>
</template>
