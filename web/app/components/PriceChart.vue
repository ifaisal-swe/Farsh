<script setup lang="ts">
import { createChart, createSeriesMarkers, CandlestickSeries, HistogramSeries, LineSeries, LineStyle, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import { chartColors } from '~/lib/chart'
const { symbol, tf, bar, state } = useTerminal()
const { lang } = useLang()
const { dark } = useTheme()
let C = chartColors(dark.value)
const legend = ref(C.overlays)
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
// fixed order; every line is also named on its button
const OVERLAYS: [string, string, string][] = [['ema21', 'اتجاه قصير', 'Short trend'], ['ema50', 'اتجاه متوسط', 'Medium trend'], ['sma200', 'اتجاه طويل', 'Long trend'], ['vwap', 'متوسط اليوم', 'Day average'], ['bbUpper', 'النطاق الأعلى', 'Upper range'], ['bbLower', 'النطاق الأدنى', 'Lower range']]
const on = ref<string[]>(['ema21', 'vwap'])
const box = ref<HTMLElement | null>(null)
const error = ref('')
let chart: IChartApi | null = null
let candles: ISeriesApi<'Candlestick'> | null = null
let volume: ISeriesApi<'Histogram'> | null = null
let markers: any = null
let data: any = null
let seq = 0
const lines = new Map<string, ISeriesApi<'Line'>>()
let priceLines: any[] = []
const toggle = (k: string) => { on.value = on.value.includes(k) ? on.value.filter((x) => x !== k) : [...on.value, k]; overlays() }
const vol = (b: any) => ({ time: b.time, value: b.volume || 0, color: (b.close >= b.open ? C.up : C.down) + '55' })

function overlays() {
  if (!chart || !data) return
  for (const [k] of OVERLAYS) {
    const color = C.overlays[k]!
    if (on.value.includes(k)) {
      if (!lines.has(k)) lines.set(k, chart.addSeries(LineSeries, { color, lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }))
      const at = new Map((data.overlays?.[k] || []).map((p: any) => [p.time, p.value]))
      lines.get(k)!.applyOptions({ color })
      const bars = data.bars || []
      // the chart connects across missing values: the piece that leads into a gap, or out of it, is made invisible
      const gap = (i: number) => bars[i] && !at.has(bars[i].time)
      lines.get(k)!.setData(bars.map((b: any, i: number) => (!at.has(b.time) ? { time: b.time } : { time: b.time, value: at.get(b.time) as number, ...(gap(i + 1) || gap(i - 1) ? { color: 'transparent' } : {}) })))
    } else if (lines.has(k)) { chart.removeSeries(lines.get(k)!); lines.delete(k) }
  }
}
function levels() {
  if (!candles) return
  for (const p of priceLines) candles.removePriceLine(p)
  priceLines = []
  const s = state.value
  const pos = s && s.selectedSymbol === symbol.value ? s.position : null
  if (!pos) return
  for (const [price, title, color] of [[pos.avgPrice, L('الشراء', 'Entry'), C.entry], [pos.stop, L('الوقف', 'Stop'), C.down], [pos.takeProfit, L('الهدف', 'Target'), C.up]] as [number, string, string][]) if (price > 0) priceLines.push(candles.createPriceLine({ price, title, color, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: true }))
}
function marks() {
  if (!markers || !data) return
  markers.setMarkers((data.markers || []).map((m: any) => ({ time: m.time, position: m.side === 'BUY' ? 'belowBar' : 'aboveBar', color: m.side === 'BUY' ? C.up : C.down, shape: m.side === 'BUY' ? 'arrowUp' : 'arrowDown', text: String(m.qty) })).sort((a: any, b: any) => a.time - b.time))
}
const candleColors = () => ({ upColor: C.up, downColor: C.down, borderVisible: false, wickUpColor: C.up, wickDownColor: C.down })
function paint() {
  C = chartColors(dark.value)
  legend.value = C.overlays
  if (!chart) return
  chart.applyOptions(C.options)
  candles!.applyOptions(candleColors())
  if (data) volume!.setData((data.bars || []).map(vol))
  marks()
  overlays()
  levels()
}
async function load() {
  if (!symbol.value || !candles) return
  const id = ++seq
  try {
    const d = await api(`bars?symbol=${encodeURIComponent(symbol.value)}&tf=${tf.value}`)
    if (id !== seq || !candles) return
    data = d
    candles.setData(d.bars || [])
    volume!.setData((d.bars || []).map(vol))
    marks()
    overlays()
    levels()
    chart!.timeScale().fitContent()
    error.value = ''
  } catch (e: any) { if (id === seq) error.value = e.message }
}
onMounted(() => {
  chart = createChart(box.value!, { autoSize: true, ...C.options })
  volume = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false })
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } })
  candles = chart.addSeries(CandlestickSeries, candleColors())
  markers = createSeriesMarkers(candles, [])
  load()
})
watch([symbol, tf], load)
watch(() => { const p = state.value?.selectedSymbol === symbol.value ? state.value?.position : null; return p ? [p.qty, p.avgPrice, p.stop, p.takeProfit].join() : '' }, (now, before) => { levels(); if (String(now).split(',')[0] !== String(before).split(',')[0]) load() })
watch(lang, levels)
watch(dark, () => nextTick(paint))
watch(bar, (m) => { if (m && m.symbol === symbol.value && m.tf === tf.value) { try { candles?.update(m.bar); volume?.update(vol(m.bar)) } catch { load() } } })
onBeforeUnmount(() => { seq++; chart?.remove(); chart = null; candles = null; lines.clear() })
</script>

<template>
  <p v-if="error" class="err">{{ error }}</p>
  <div class="row"><UiToggle v-for="[k, ar, en] in OVERLAYS" :key="k" :model-value="on.includes(k)" @update:model-value="toggle(k)"><i class="key" :style="{ background: legend[k] }" /><bdi>{{ L(ar, en) }}</bdi></UiToggle></div>
  <div ref="box" class="chart" />
</template>
