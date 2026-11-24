// One live connection per page, with a visible "last update" time.
import { plain } from '~/lib/plain'
const state = ref<any>(null)
const connected = ref(false)
const lastAt = ref(0)
const now = ref(Date.now())
const feed = ref<any[]>([]) // newest last
let feedSeq = 0
let feedBusy = false
export async function loadFeed() {
  if (feedBusy) return
  feedBusy = true
  try {
    const r = await api(feedSeq ? `events?after=${feedSeq}&limit=200` : 'events?latest=1&limit=200')
    if (r.items.length) { feedSeq = r.items.at(-1).seq; feed.value = [...feed.value, ...r.items].slice(-200) }
  } catch { /* tried again with the next event */ } finally { feedBusy = false }
}
const bar = ref<any>(null)
const symbol = ref('')
const tf = ref('5m')
let ws: WebSocket | null = null
let started = false
let retry = 1000

function subscribe() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'subscribe', tf: tf.value, ...(symbol.value ? { symbol: symbol.value } : {}) }))
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
  ws.onopen = () => { connected.value = true; retry = 1000; subscribe() }
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    lastAt.value = Date.now()
    if (m.type === 'hello') { state.value = m.state; loadFeed() }
    else if (m.type === 'state') state.value = m.state
    else if (m.type === 'appEvent') loadFeed()
    else if (m.type === 'candle' && m.tf === tf.value) bar.value = m
    if (state.value && !symbol.value && state.value.selectedSymbol) symbol.value = state.value.selectedSymbol
  }
  ws.onclose = (e) => {
    connected.value = false
    if (e.code === 4401) { location.href = '/login'; return }
    setTimeout(connect, retry)
    retry = Math.min(retry * 2, 15000)
  }
}

export async function api(path: string, body?: unknown) {
  const r = await fetch(`/api/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify(body) })
  if (r.status === 401) { location.href = '/login'; throw new Error('Login required') }
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(plain.error(d.error || '', useLang().lang.value === 'ar'))
  return d
}

export function useTerminal() {
  if (!started && import.meta.client) {
    started = true
    connect()
    setInterval(() => { now.value = Date.now() }, 1000)
    watch([symbol, tf], subscribe)
  }
  const stale = computed(() => !connected.value || now.value - lastAt.value > 10000)
  return { state, connected, lastAt, now, stale, feed, bar, symbol, tf }
}
