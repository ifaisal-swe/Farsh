<script setup lang="ts">
// The chart workspace: chart types, averages, indicator panes, levels and candle patterns that carry their own record.
import { Camera, Expand, Minimize2 } from '@lucide/vue'
import { createChart, createSeriesMarkers, AreaSeries, BarSeries, CandlestickSeries, HistogramSeries, LineSeries, LineStyle, PriceScaleMode, type IChartApi, type ISeriesApi } from 'lightweight-charts'
import { chartColors } from '~/lib/chart'
import { plain } from '~/lib/plain'
const props = defineProps<{ symbol: string }>()
const { lang, num } = useLang()
const { dark } = useTheme()
const { state } = useTerminal()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const PERIODS = [10, 20, 50, 100, 200]
const LIGHT = ['#e87ba4', '#2a78d6', '#eb6834', '#1baf7a', '#4a3aa7']
const DARK = ['#d55181', '#3987e5', '#d95926', '#199e70', '#9085e9']
const LINE = computed(() => (dark.value ? DARK : LIGHT))
const TF = computed(() => [['5m', L('5 د', '5m')], ['15m', L('15 د', '15m')], ['1h', L('ساعة', '1h')], ['1d', L('يوم', 'Day')], ['1w', L('أسبوع', 'Week')]] as [string, string][])
const TYPES = computed(() => [['candles', L('شموع', 'Candles')], ['hollow', L('شموع مفرغة', 'Hollow candles')], ['heikin', L('هايكن آشي', 'Heikin Ashi')], ['bars', L('أعمدة', 'Bars')], ['line', L('خط', 'Line')], ['area', L('مساحة', 'Area')]] as [string, string][])
const RANGE = computed(() => [[21, L('شهر', '1M')], [63, L('3 أشهر', '3M')], [126, L('6 أشهر', '6M')], [252, L('سنة', '1Y')], [0, L('الكل', 'All')]] as [number, string][])
const PANES = computed(() => [['volume', L('الكميات', 'Volume')], ['flow', L('السيولة', 'Money flow')], ['rsi', 'RSI'], ['macd', 'MACD'], ['stoch', L('ستوكاستك', 'Stochastic')], ['mfi', 'MFI']] as [string, string][])
const EXTRA = computed(() => [['bands', L('النطاق المعتاد', 'Usual range')], ['levels', L('دعم ومقاومة', 'Support and resistance')], ['fib', L('فيبوناتشي', 'Fibonacci')], ['patterns', L('أشكال الشموع', 'Candle patterns')]] as [string, string][])
const opt = reactive({ tf: '1d', type: 'candles', kind: 'sma', avg: [20, 50, 200] as number[], panes: ['volume', 'rsi'] as string[], extra: ['levels', 'patterns'] as string[], log: false, range: 126 })
const KEY = 'forsah.chart'
try { const s = JSON.parse(localStorage.getItem(KEY) || 'null'); if (s) for (const k of Object.keys(opt) as (keyof typeof opt)[]) if (typeof s[k] === typeof opt[k] && Array.isArray(s[k]) === Array.isArray(opt[k])) (opt as any)[k] = s[k] } catch { /* defaults */ }
if (!PERIODS.some((p) => opt.avg.includes(p))) opt.avg = []
const flip = (k: 'avg' | 'panes' | 'extra', v: any) => { const a = opt[k] as any[]; (opt as any)[k] = a.includes(v) ? a.filter((x) => x !== v) : [...a, v] }
const box = ref<HTMLElement | null>(null)
const shell = ref<HTMLElement | null>(null)
const full = ref(false)
const d = ref<any>(null)
const error = ref('')
const busy = ref(false)
const at = ref<number | null>(null) // the bar under the pointer
let chart: IChartApi | null = null
let main: ISeriesApi<any> | null = null
let seq = 0
let timer: any
let drawn = '' // symbol and frame whose view is set
const demo = computed(() => state.value?.tradingSession?.dataMode !== 'LIVE')
const bars = computed<any[]>(() => d.value?.bars || [])
const shown = computed(() => (at.value !== null && bars.value[at.value] ? at.value : bars.value.length - 1))
const bar = computed(() => bars.value[shown.value] || null)
const prev = computed(() => bars.value[shown.value - 1] || null)
const move = computed(() => (bar.value && prev.value ? bar.value.close / prev.value.close - 1 : null))
const money = (x: any) => (typeof x === 'number' ? num(x) : '—')
const big = (x: any) => (typeof x !== 'number' ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(x))
const pct = (x: any, n = 0) => (typeof x === 'number' ? `${(x * 100).toFixed(n)}%` : '—')
const day = (t: number) => new Date(t * 1000).toLocaleDateString(ar.value ? 'ar-u-nu-latn-ca-gregory' : 'en-GB', opt.tf === '1d' || opt.tf === '1w' ? { day: 'numeric', month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

async function load() {
  if (!props.symbol) return
  const id = ++seq
  busy.value = true
  try {
    const x = await api(`chart?symbol=${encodeURIComponent(props.symbol)}&tf=${opt.tf}`)
    if (id !== seq) return
    d.value = x
    error.value = ''
    draw()
  } catch (e: any) { if (id === seq) error.value = plain.error(e.message, ar.value) } finally { if (id === seq) busy.value = false }
}
function heikin(list: any[]) {
  const out: any[] = []
  for (const b of list) { const p = out.at(-1); const close = (b.open + b.high + b.low + b.close) / 4; const open = p ? (p.open + p.close) / 2 : (b.open + b.close) / 2; out.push({ time: b.time, open, close, high: Math.max(b.high, open, close), low: Math.min(b.low, open, close) }) }
  return out
}
const series = (a: any[]) => bars.value.map((b, i) => (typeof a?.[i] === 'number' ? { time: b.time, value: a[i] } : { time: b.time }))
const quiet = { priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false } as const
function draw() {
  if (!box.value || !bars.value.length) return
  const C = chartColors(dark.value)
  const key = `${props.symbol}|${opt.tf}`
  const view = chart && drawn === key ? chart.timeScale().getVisibleLogicalRange() : null
  chart?.remove()
  const ch = (chart = createChart(box.value, { autoSize: true, ...C.options, rightPriceScale: { borderColor: C.options.rightPriceScale.borderColor, mode: opt.log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal }, layout: { ...C.options.layout, panes: { separatorColor: C.options.rightPriceScale.borderColor, enableResize: true } } } as any))
  const x = d.value
  const candle = { borderVisible: true, upColor: C.up, downColor: C.down, borderUpColor: C.up, borderDownColor: C.down, wickUpColor: C.up, wickDownColor: C.down }
  if (opt.type === 'line') main = ch.addSeries(LineSeries, { color: C.line, lineWidth: 2 })
  else if (opt.type === 'area') main = ch.addSeries(AreaSeries, { lineColor: C.line, topColor: `${C.line}55`, bottomColor: `${C.line}05`, lineWidth: 2 })
  else if (opt.type === 'bars') main = ch.addSeries(BarSeries, { upColor: C.up, downColor: C.down })
  else main = ch.addSeries(CandlestickSeries, opt.type === 'hollow' ? { ...candle, upColor: C.options.layout.background.color } : candle)
  main!.setData(opt.type === 'line' || opt.type === 'area' ? bars.value.map((b) => ({ time: b.time, value: b.close })) : opt.type === 'heikin' ? heikin(bars.value) : bars.value)
  if (x.available) {
    PERIODS.forEach((p, i) => { if (opt.avg.includes(p)) ch.addSeries(LineSeries, { ...quiet, color: LINE.value[i]!, lineWidth: 2, lineStyle: opt.kind === 'ema' ? LineStyle.Dashed : LineStyle.Solid }).setData(series(x.averages[`${opt.kind}${p}`]) as any) })
    if (opt.extra.includes('bands')) for (const k of ['upper', 'lower']) ch.addSeries(LineSeries, { ...quiet, color: C.overlays.bbUpper!, lineWidth: 1 }).setData(series(x.bands[k]) as any)
    const line = (price: number, title: string, color: string, style: any) => main!.createPriceLine({ price, title, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true } as any)
    if (opt.extra.includes('levels')) { x.support.slice(0, 3).forEach((z: any) => line(z.price, L('دعم', 'Support'), C.up, LineStyle.Dashed)); x.resistance.slice(0, 3).forEach((z: any) => line(z.price, L('مقاومة', 'Resistance'), C.down, LineStyle.Dashed)) }
    if (opt.extra.includes('fib') && x.fib) for (const f of x.fib.levels) line(f.price, `${(f.ratio * 100).toFixed(1)}%`, C.overlays.bbUpper!, LineStyle.Dotted)
    if (opt.extra.includes('patterns')) createSeriesMarkers(main!, x.patterns.map((p: any) => ({ time: p.time, position: p.direction === 'BEARISH' ? 'aboveBar' : 'belowBar', shape: p.direction === 'BEARISH' ? 'arrowDown' : p.direction === 'BULLISH' ? 'arrowUp' : 'circle', color: p.direction === 'BEARISH' ? C.down : p.direction === 'BULLISH' ? C.up : C.overlays.bbUpper, size: p.status === 'CONFIRMED' ? 1 : 0.6 })))
    let pane = 0
    const guide = (s: any, list: number[]) => list.forEach((v) => s.createPriceLine({ price: v, color: C.overlays.bbUpper!, lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false, title: '' }))
    for (const [k] of PANES.value) {
      if (!opt.panes.includes(k)) continue
      pane++
      if (k === 'volume') ch.addSeries(HistogramSeries, { ...quiet, priceFormat: { type: 'volume' } }, pane).setData(bars.value.map((b) => ({ time: b.time, value: b.volume, color: (b.close >= b.open ? C.up : C.down) + '99' })))
      if (k === 'flow') ch.addSeries(HistogramSeries, { ...quiet, priceFormat: { type: 'volume' } }, pane).setData(bars.value.map((b, i) => ({ time: b.time, value: x.flow[i], color: (x.flow[i] >= 0 ? C.up : C.down) + '99' })))
      if (k === 'rsi') { const s = ch.addSeries(LineSeries, { ...quiet, color: LINE.value[1]!, lineWidth: 2 }, pane); s.setData(series(x.rsi) as any); guide(s, [30, 70]) }
      if (k === 'mfi') { const s = ch.addSeries(LineSeries, { ...quiet, color: LINE.value[1]!, lineWidth: 2 }, pane); s.setData(series(x.mfi) as any); guide(s, [20, 80]) }
      if (k === 'stoch') { const s = ch.addSeries(LineSeries, { ...quiet, color: LINE.value[1]!, lineWidth: 2 }, pane); s.setData(series(x.stoch.k) as any); ch.addSeries(LineSeries, { ...quiet, color: LINE.value[2]!, lineWidth: 1 }, pane).setData(series(x.stoch.d) as any); guide(s, [20, 80]) }
      if (k === 'macd') { ch.addSeries(HistogramSeries, quiet, pane).setData(bars.value.flatMap((b, i) => (typeof x.macd.hist[i] === 'number' ? [{ time: b.time, value: x.macd.hist[i], color: (x.macd.hist[i] >= 0 ? C.up : C.down) + '99' }] : []))); ch.addSeries(LineSeries, { ...quiet, color: LINE.value[1]!, lineWidth: 2 }, pane).setData(series(x.macd.line) as any); ch.addSeries(LineSeries, { ...quiet, color: LINE.value[2]!, lineWidth: 1 }, pane).setData(series(x.macd.signal) as any) }
    }
    ch.panes().forEach((p, i) => p.setStretchFactor(i ? 1 : Math.max(3, pane * 1.1 + 2)))
  }
  const index = new Map(bars.value.map((b, i) => [b.time, i]))
  ch.subscribeCrosshairMove((m) => { at.value = m.time !== undefined ? index.get(m.time as number) ?? null : null })
  if (view) ch.timeScale().setVisibleLogicalRange(view)
  else fit()
  drawn = key
}
function fit() { const n = bars.value.length; if (!chart) return; if (!opt.range || (opt.tf !== '1d' && opt.tf !== '1w')) { chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - (opt.range || n)) - 1, to: n + 4 }); return } chart.timeScale().setVisibleLogicalRange({ from: n - (opt.tf === '1w' ? Math.ceil(opt.range / 5) : opt.range) - 1, to: n + 4 }) }
function zoom(r: number) { opt.range = r; fit() }
function photo() { const c = chart?.takeScreenshot(); if (!c) return; const a = document.createElement('a'); a.href = c.toDataURL('image/png'); a.download = `forsah-${props.symbol.replace('/', '-')}-${opt.tf}.png`; a.click() }
async function screen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await shell.value?.requestFullscreen() } catch { /* not allowed here */ } }
const onFull = () => { full.value = document.fullscreenElement === shell.value }
watch(() => [props.symbol, opt.tf], () => { at.value = null; load() })
watch(() => [opt.type, opt.kind, opt.avg, opt.panes, opt.extra, opt.log, dark.value, lang.value], () => nextTick(draw))
watch(opt, () => { try { localStorage.setItem(KEY, JSON.stringify(opt)) } catch { /* not kept */ } }, { deep: true })
onMounted(() => { load(); timer = setInterval(load, 60000); document.addEventListener('fullscreenchange', onFull) })
onBeforeUnmount(() => { seq++; clearInterval(timer); document.removeEventListener('fullscreenchange', onFull); chart?.remove(); chart = null })

const TEXT = computed<Record<string, [string, string]>>(() => ({
  DOJI: [L('دوجي', 'Doji'), L('تعادل المشترون والبائعون بعد حركة واضحة. السوق متردد.', 'Buyers and sellers tied after a clear move. The market hesitates.')],
  HAMMER: [L('مطرقة', 'Hammer'), L('نزل السعر ثم رُفض وأغلق قرب الأعلى، بعد هبوط.', 'After a fall, a lower price was rejected and the bar closed near its top.')],
  SHOOTING_STAR: [L('نجمة ساقطة', 'Shooting star'), L('صعد السعر ثم رُفض وأغلق قرب الأدنى، بعد صعود.', 'After a rise, a higher price was rejected and the bar closed near its bottom.')],
  BULLISH_ENGULFING: [L('ابتلاع صاعد', 'Bullish engulfing'), L('شمعة صاعدة غطّت الشمعة الهابطة قبلها كاملة.', 'An up bar covered the whole down bar before it.')],
  BEARISH_ENGULFING: [L('ابتلاع هابط', 'Bearish engulfing'), L('شمعة هابطة غطّت الشمعة الصاعدة قبلها كاملة.', 'A down bar covered the whole up bar before it.')],
  MORNING_STAR: [L('نجمة الصباح', 'Morning star'), L('هبوط ثم تردد ثم صعود قوي استعاد أكثر من نصف الهبوط.', 'A fall, a pause, then a strong rise that took back over half of it.')],
  EVENING_STAR: [L('نجمة المساء', 'Evening star'), L('صعود ثم تردد ثم هبوط قوي أخذ أكثر من نصف الصعود.', 'A rise, a pause, then a strong fall that took back over half of it.')],
}))
const STATUS = computed<Record<string, [string, string]>>(() => ({ CONFIRMED: [L('تأكدت', 'Confirmed'), 'PASS'], FAILED: [L('فشلت', 'Failed'), 'FAIL'], UNCONFIRMED: [L('لم تتأكد', 'Not confirmed'), 'UNKNOWN'], AWAITING_NEXT_BAR: [L('تنتظر الشمعة التالية', 'Awaits the next bar'), 'warn'], NOT_APPLICABLE: [L('تردد', 'Hesitation'), ''] }))
const recent = computed(() => [...(d.value?.patterns || [])].reverse().slice(0, 5))
const rec = (c: string) => d.value?.record?.[c]
// the bars of a pattern, drawn small
function mini(p: any) {
  const i = bars.value.findIndex((b) => b.time === p.startTime); const j = bars.value.findIndex((b) => b.time === p.time)
  const w = bars.value.slice(Math.max(0, i - 3), j + 2); if (!w.length) return []
  const hi = Math.max(...w.map((b) => b.high)); const lo = Math.min(...w.map((b) => b.low)); const y = (v: number) => 4 + (hi - v) / (hi - lo || 1) * 48
  return w.map((b, k) => ({ x: 8 + k * 15, t: y(b.high), b: y(b.low), o: y(Math.max(b.open, b.close)), h: Math.max(1.5, Math.abs(y(b.open) - y(b.close))), up: b.close >= b.open, on: b.time >= p.startTime && b.time <= p.time }))
}
function look(p: any) { const i = bars.value.findIndex((b) => b.time === p.time); if (i < 0 || !chart) return; chart.timeScale().setVisibleLogicalRange({ from: i - 30, to: i + 20 }); at.value = i; shell.value?.scrollIntoView({ block: 'nearest' }) }
const inflow = computed(() => d.value?.inflow ?? null)
const chip = (on: boolean) => ['inline-flex min-h-9 items-center gap-2 rounded-full border px-3.5 text-sm font-medium transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent']
</script>

<template>
  <section ref="shell" class="mb-4 overflow-hidden rounded-3xl border bg-card" :class="full && 'flex h-full flex-col !rounded-none'" :aria-label="L('الرسم البياني', 'Chart')">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2 bg-[#0d0f26] px-5 py-4 text-white sm:px-7 [--ring:#ffd32e]">
      <SymbolIcon :symbol="symbol" class="!size-11" /><h2 class="!m-0 !text-2xl"><bdi>{{ symbol }}</bdi></h2><UiBadge v-if="demo" tone="warn">{{ L('سعر تجريبي', 'Demo price') }}</UiBadge>
      <template v-if="bar"><b class="num font-display text-2xl">{{ money(bar.close) }}</b><span v-if="move !== null" class="num rounded-full bg-white px-3 py-0.5 font-semibold" :class="move > 0 ? 'text-[#0c7446]' : move < 0 ? 'text-[#bd2638]' : 'text-[#0d0f26]'">{{ move > 0 ? '+' : '' }}{{ pct(move, 2) }}</span></template>
      <span class="grow" />
      <div class="flex gap-1" role="group" :aria-label="L('المدة', 'Interval')"><button v-for="[k, n] in TF" :key="k" type="button" :aria-pressed="opt.tf === k" class="min-h-9 rounded-full px-3.5 text-sm font-semibold transition-colors" :class="opt.tf === k ? 'bg-sun text-sun-foreground' : 'hover:bg-white/15'" @click="opt.tf = k">{{ n }}</button></div>
      <button type="button" class="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/15" :aria-label="L('احفظ صورة الرسم', 'Save chart image')" @click="photo"><Camera class="size-5" /></button>
      <button type="button" class="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/15" :aria-label="full ? L('صغّر', 'Exit full screen') : L('ملء الشاشة', 'Full screen')" @click="screen"><component :is="full ? Minimize2 : Expand" class="size-5" /></button>
    </div>
    <div class="grid gap-3 border-b px-5 py-4 sm:px-7">
      <div class="swipe flex flex-wrap items-center gap-2"><UiNativeSelect v-model="opt.type" :aria-label="L('نوع الرسم', 'Chart type')"><option v-for="[k, n] in TYPES" :key="k" :value="k">{{ n }}</option></UiNativeSelect>
        <UiNativeSelect v-model="opt.kind" :aria-label="L('نوع المتوسط', 'Average type')"><option value="sma">{{ L('متوسط بسيط', 'Simple average') }}</option><option value="ema">{{ L('متوسط أسي', 'Exponential average') }}</option></UiNativeSelect>
        <button v-for="(p, i) in PERIODS" :key="p" type="button" :aria-pressed="opt.avg.includes(p)" class="inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-sm font-semibold" :class="opt.avg.includes(p) ? 'bg-accent' : 'text-muted-foreground'" @click="flip('avg', p)"><i class="h-0.5 w-4" :style="{ background: LINE[i] }" aria-hidden="true" /><bdi>{{ p }}</bdi></button></div>
      <div class="swipe flex flex-wrap items-center gap-2"><button v-for="[k, n] in EXTRA" :key="k" type="button" :aria-pressed="opt.extra.includes(k)" :class="chip(opt.extra.includes(k))" @click="flip('extra', k)">{{ n }}</button><i class="mx-1 h-6 w-px bg-border" aria-hidden="true" /><button v-for="[k, n] in PANES" :key="k" type="button" :aria-pressed="opt.panes.includes(k)" :class="chip(opt.panes.includes(k))" @click="flip('panes', k)">{{ n }}</button><i class="mx-1 h-6 w-px bg-border" aria-hidden="true" /><button type="button" :aria-pressed="opt.log" :class="chip(opt.log)" @click="opt.log = !opt.log">{{ L('مقياس نسبي', 'Log scale') }}</button></div>
    </div>
    <p v-if="error" class="err !m-0 px-7 py-3" role="alert">{{ error }}</p>
    <dl v-if="bar" class="!m-0 flex flex-wrap gap-x-5 gap-y-1 px-5 pt-3 text-sm sm:px-7"><div class="flex gap-1.5"><dt class="muted">{{ L('التاريخ', 'Date') }}</dt><dd>{{ day(bar.time) }}</dd></div><div v-for="[n, v] in [[L('افتتاح', 'Open'), money(bar.open)], [L('أعلى', 'High'), money(bar.high)], [L('أدنى', 'Low'), money(bar.low)], [L('إغلاق', 'Close'), money(bar.close)], [L('كمية', 'Volume'), big(bar.volume)]]" :key="n" class="flex gap-1.5"><dt class="muted">{{ n }}</dt><dd class="num font-semibold">{{ v }}</dd></div><template v-if="d.available"><div v-for="(p, i) in PERIODS.filter((y) => opt.avg.includes(y))" :key="p" class="flex items-center gap-1.5"><dt class="flex items-center gap-1.5 muted"><i class="h-0.5 w-3" :style="{ background: LINE[PERIODS.indexOf(p)] }" aria-hidden="true" /><span>{{ L('متوسط', 'Average') }} <bdi>{{ p }}</bdi></span></dt><dd class="num font-semibold">{{ money(d.averages[`${opt.kind}${p}`][shown]) }}</dd></div><div v-if="opt.panes.includes('rsi')" class="flex gap-1.5"><dt class="muted">RSI</dt><dd class="num font-semibold">{{ d.rsi[shown]?.toFixed(0) ?? '—' }}</dd></div><div v-if="opt.panes.includes('mfi')" class="flex gap-1.5"><dt class="muted">MFI</dt><dd class="num font-semibold">{{ d.mfi[shown]?.toFixed(0) ?? '—' }}</dd></div></template></dl>
    <div class="relative px-2 pt-2 sm:px-4" dir="ltr"><div ref="box" class="w-full" :class="full ? 'h-[calc(100dvh-17rem)]' : 'h-[clamp(26rem,66vh,48rem)]'" role="img" :aria-label="L('رسم السعر والمؤشرات', 'Price chart with indicators')" /><p v-if="busy && !d" class="muted absolute inset-0 grid place-items-center" role="status">{{ L('يحمّل الرسم…', 'Loading the chart…') }}</p></div>
    <div class="flex flex-wrap items-center gap-2 px-5 pt-2 pb-5 sm:px-7"><span class="small muted">{{ L('اعرض آخر', 'Show last') }}</span><button v-for="[r, n] in RANGE" :key="r" type="button" :aria-pressed="opt.range === r" class="min-h-9 rounded-full px-3 text-sm font-semibold" :class="opt.range === r ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:bg-accent'" @click="zoom(r)">{{ n }}</button></div>
  </section>

  <div v-if="d?.available && !full" class="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
    <UiCard class="!mb-0"><h2>{{ L('ماذا تقول الشموع', 'What the candles say') }}</h2>
      <ul v-if="recent.length" class="!list-none !p-0"><li v-for="p in recent" :key="p.code + p.time" class="border-b last:border-0"><button type="button" class="flex w-full flex-wrap items-center gap-4 py-4 text-start" @click="look(p)">
        <svg viewBox="0 0 104 56" class="h-14 w-26 shrink-0" dir="ltr" aria-hidden="true"><g v-for="c in mini(p)" :key="c.x" :opacity="c.on ? 1 : 0.3" :fill="c.up ? 'var(--up)' : 'var(--down)'"><rect :x="c.x - 0.75" :y="c.t" width="1.5" :height="c.b - c.t" /><rect :x="c.x - 4.5" :y="c.o" width="9" :height="c.h" rx="1.5" /></g></svg>
        <span class="min-w-48 flex-1"><b class="flex flex-wrap items-center gap-2">{{ TEXT[p.code]?.[0] || p.code }}<UiBadge :tone="STATUS[p.status]?.[1] || undefined">{{ STATUS[p.status]?.[0] }}</UiBadge><span class="small muted font-normal">{{ day(p.time) }}</span></b><span class="block">{{ TEXT[p.code]?.[1] }}</span><span v-if="rec(p.code)" class="small muted block">{{ L('هنا من قبل', 'Here before') }}: <span class="num">{{ rec(p.code).times }}</span> {{ L('مرة، وصدقت', 'times, right') }} <span class="num">{{ pct(rec(p.code).rate) }}</span> {{ L('بعد', 'after') }} <span class="num">{{ rec(p.code).ahead }}</span> {{ L('شموع، والمعتاد', 'bars; usual') }} <span class="num">{{ pct(rec(p.code).usualRate) }}</span></span></span>
        <UiBadge v-if="rec(p.code)" :tone="rec(p.code).useful ? 'PASS' : undefined">{{ rec(p.code).useful ? L('أفضل من المعتاد', 'Better than usual') : rec(p.code).times < 12 ? L('حالات قليلة', 'Too few cases') : L('لا ميزة هنا', 'No edge here') }}</UiBadge></button></li></ul>
      <p v-else class="muted">{{ L('لا أشكال واضحة في الشموع الأخيرة.', 'No clear patterns in recent bars.') }}</p>
      <p class="small muted !m-0 mt-3">{{ L('الدراسات مختلفة في أشكال الشموع، وكثير منها يفقد قيمته بعد الرسوم. لذلك ترى هنا سجلها على هذا الرمز نفسه.', 'Studies disagree about candle patterns, and many lose their value after costs. That is why you see their record on this very symbol.') }}</p></UiCard>
    <UiCard class="!mb-0"><h2>{{ L('السيولة', 'Money flow') }}</h2>
      <template v-if="inflow !== null"><p class="!m-0"><b class="num font-display text-5xl font-bold">{{ pct(inflow) }}</b></p><p class="!mt-1">{{ L('حصة السيولة الداخلة في آخر 20 شمعة', 'Share of money coming in over the last 20 bars') }}</p>
        <div class="flex h-4 gap-0.5 overflow-hidden rounded-full" aria-hidden="true"><span class="bg-up" :style="{ width: pct(inflow, 1) }" /><span class="flex-1 bg-down" /></div><p class="small mt-2 flex justify-between !mb-4"><span class="up">{{ L('داخلة', 'In') }} <span class="num">{{ pct(inflow) }}</span></span><span class="down">{{ L('خارجة', 'Out') }} <span class="num">{{ pct(1 - inflow) }}</span></span></p></template>
      <p class="small muted !m-0">{{ L('تقدير من موضع إغلاق كل شمعة وقيمة تداولها، وليس حركة أموال مسجلة.', 'An estimate from where each bar closed and how much was traded, not recorded cash movement.') }}</p></UiCard>
  </div>
</template>

<style scoped>
/* phones: one line of tools, swiped sideways */
@media (max-width: 639px) { .swipe { flex-wrap: nowrap; overflow-x: auto; margin-inline: -1.25rem; padding-inline: 1.25rem; padding-bottom: 0.25rem; } .swipe > * { flex-shrink: 0; } }
</style>
