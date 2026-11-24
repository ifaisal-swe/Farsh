// US stock market hours: where the day stands and how long until it changes. Times are exchange times turned into the visitor's clock.
export type Day = { date: string, weekend: boolean, holiday: string | null, early: boolean, pre: number | null, open: number | null, close: number | null, post: number | null }
type Phase = 'REGULAR' | 'PRE' | 'POST' | 'CLOSED'
const hours = ref<{ official: boolean, closedUntil: number | null, days: Day[] } | null>(null)
const offset = ref(0) // server clock minus this device's clock
let started = false

async function load() {
  try { const d = await api('market/hours'); offset.value = d.now - Date.now(); hours.value = d } catch { /* tried again later; the last known hours stay */ }
}

export function useMarketHours() {
  const { lang } = useLang()
  const { now } = useTerminal()
  if (!started && import.meta.client) { started = true; load(); setInterval(load, 300000) }
  const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
  const clock = computed(() => now.value + offset.value)
  const view = computed(() => {
    const h = hours.value
    if (!h) return null
    const t = clock.value
    const shut = h.closedUntil && t < h.closedUntil ? h.closedUntil : 0
    const next = h.days.find((d) => d.open && d.open > t && d.open >= shut) || null
    const day = h.days.find((d) => d.pre && d.post && t >= d.pre && t < d.post) || null
    const phase: Phase = shut || !day ? 'CLOSED' : t < day.open! ? 'PRE' : t < day.close! ? 'REGULAR' : 'POST'
    const open = phase === 'REGULAR'
    const target = open ? day!.close! : next?.open ?? null
    return { phase, open, day, next, target, left: target ? Math.max(0, target - t) : null, t }
  })
  const two = (n: number) => String(n).padStart(2, '0')
  // 2 days 03:22:10, or 05:12:33 within a day
  const count = (ms: number | null) => { if (ms === null) return '—'; const s = Math.floor(ms / 1000); const d = Math.floor(s / 86400); const rest = `${two(Math.floor(s / 3600) % 24)}:${two(Math.floor(s / 60) % 60)}:${two(s % 60)}`; return d ? `${d}${L('ي', 'd')} ${rest}` : rest }
  const short = (ms: number | null) => { if (ms === null) return '—'; const m = Math.max(1, Math.ceil(ms / 60000)); const h = Math.floor(m / 60); return h >= 24 ? `${Math.floor(h / 24)} ${L('ي', 'd')} ${h % 24} ${L('س', 'h')}` : h ? `${h} ${L('س', 'h')} ${m % 60} ${L('د', 'min')}` : `${m} ${L('د', 'min')}` }
  const locale = computed(() => (lang.value === 'ar' ? 'ar-u-nu-latn-ca-gregory' : 'en-GB'))
  const time = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleTimeString(locale.value, { hour: 'numeric', minute: '2-digit', hour12: true }))
  const ny = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/New_York' }))
  // the exchange's own date, so a Monday session stays Monday even when it ends after midnight here
  const dayName = (date: string, long = false) => new Date(`${date}T12:00:00Z`).toLocaleDateString(locale.value, { weekday: long ? 'long' : 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
  const localDay = (ms: number | null) => (ms === null ? '—' : new Date(ms).toLocaleDateString(locale.value, { weekday: 'long', day: 'numeric', month: 'short' }))
  const HOLIDAY = computed<Record<string, string>>(() => ({ NEW_YEAR: L('رأس السنة', 'New Year’s Day'), MLK: L('يوم مارتن لوثر كينغ', 'Martin Luther King Day'), PRESIDENTS: L('يوم الرؤساء', 'Presidents’ Day'), GOOD_FRIDAY: L('الجمعة العظيمة', 'Good Friday'), MEMORIAL: L('يوم الذكرى', 'Memorial Day'), JUNETEENTH: L('يوم الحرية', 'Juneteenth'), INDEPENDENCE: L('عيد الاستقلال', 'Independence Day'), LABOR: L('عيد العمال', 'Labor Day'), THANKSGIVING: L('عيد الشكر', 'Thanksgiving'), CHRISTMAS: L('عيد الميلاد', 'Christmas') }))
  const why = (d: Day) => (d.holiday ? HOLIDAY.value[d.holiday] || L('عطلة', 'Holiday') : d.weekend ? L('عطلة نهاية الأسبوع', 'Weekend') : L('عطلة', 'Holiday'))
  const PHASE = computed<Record<Phase, string>>(() => ({ REGULAR: L('السوق مفتوح', 'Market open'), PRE: L('ما قبل الافتتاح', 'Pre-market'), POST: L('ما بعد الإغلاق', 'After hours'), CLOSED: L('السوق مغلق', 'Market closed') }))
  return { hours, view, count, short, time, ny, dayName, localDay, why, PHASE }
}
