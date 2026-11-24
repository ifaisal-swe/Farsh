<script setup lang="ts">
const { t, lang } = useLang()
const { state, symbol } = useTerminal()
const liveNews = computed(() => (state.value?.news || []).slice(0, 30))
const when = (x: number) => (x ? new Date(x).toLocaleString('en-GB') : '—')
const d = ref<any>(null)
const error = ref('')
const group = ref('')
const side = ref('')
const q = ref('')
const BUY = ['new', 'add', 'buy']
const SELL = ['trim', 'exit', 'sell']
const sideOf = (r: any) => (BUY.includes(r.dir) ? 'buy' : SELL.includes(r.dir) ? 'sell' : '')
const dirText = (x: string) => t(x === 'add' ? 'added' : x)
const grade = (g: string) => t(g === 'M' ? 'Mx' : g)
onMounted(async () => { try { d.value = await api('research') } catch (e: any) { error.value = e.message } })
const rows = computed(() => (d.value?.trades || []).filter((r: any) => (!group.value || r.group === group.value) && (!side.value || sideOf(r) === side.value) && (!q.value || `${r.ticker} ${r.who}`.toLowerCase().includes(q.value.trim().toLowerCase()))))
const flows = computed(() => {
  const by = new Map<string, { buy: Set<string>, sell: Set<string> }>()
  for (const r of d.value?.trades || []) {
    const s = sideOf(r)
    if (r.signal === false || !s) continue
    if (!by.has(r.ticker)) by.set(r.ticker, { buy: new Set(), sell: new Set() })
    by.get(r.ticker)![s as 'buy' | 'sell'].add(r.who)
  }
  return [...by].map(([ticker, v]) => ({ ticker, buy: [...v.buy], sell: [...v.sell] })).filter((x) => x.buy.length + x.sell.length >= 3)
    .sort((a, b) => (b.buy.length - b.sell.length) - (a.buy.length - a.sell.length))
})
const max = computed(() => Math.max(1, ...flows.value.map((x) => Math.max(x.buy.length, x.sell.length))))
const days = computed(() => (d.value ? Math.max(0, Math.floor((Date.now() - Date.parse(d.value.asOf)) / 86400000)) : 0))
</script>

<template>
  <div>
  <UiCard><h2>{{ t('live_news') }} <bdi>{{ symbol }}</bdi></h2>
    <article v-for="n in liveNews" :key="n.id || n.url || n.title" class="item"><div class="small muted"><span class="num">{{ when(n.publishedAt) }}</span> · <bdi>{{ n.source }}</bdi></div><a v-if="/^https?:/.test(n.url || '')" :href="n.url" target="_blank" rel="noopener noreferrer"><bdi>{{ n.title }}</bdi></a><bdi v-else>{{ n.title }}</bdi></article>
    <p v-if="!liveNews.length" class="muted">{{ t('no_live_news') }}</p></UiCard>
  <p v-if="error" class="err">{{ error }}</p>
  <template v-if="d">
    <p class="muted">{{ t('r_note') }} {{ t('asof') }} <span class="num">{{ d.asOf }}</span>. <span :class="days > 7 ? 'down' : ''">{{ t('r_old') }} <span class="num">{{ days }}</span></span></p>
    <h2>{{ t('r_market') }}</h2>
    <div class="tiles"><div v-for="m in d.macro" :key="m.label.en" class="tile"><span class="small muted">{{ m.label[lang] }}</span><b class="num">{{ m.value }}</b><div v-if="m.note" class="small">{{ m.note[lang] }}</div><div class="small muted"><span class="num">{{ m.asOf }}</span> · {{ grade(m.ev) }} · <a :href="m.url" target="_blank" rel="noopener noreferrer">{{ t('src') }}</a></div></div></div>
    <UiCard><h2>{{ t('flows') }}</h2><p class="small muted">{{ t('flows_note') }}</p>
      <div class="row small"><span><i class="key" style="background:var(--sell)" /> {{ t('sellers') }}</span><span><i class="key" style="background:var(--buy)" /> {{ t('buyers') }}</span></div>
      <div dir="ltr"><div v-for="f in flows" :key="f.ticker" class="flow" tabindex="0" :title="`${t('sellers')}: ${f.sell.join(', ') || '—'}\n${t('buyers')}: ${f.buy.join(', ') || '—'}`"><span>{{ f.ticker }}</span>
        <div class="half l"><template v-if="f.sell.length"><span class="small">{{ f.sell.length }}</span><div class="bar sell" :style="{ width: `${f.sell.length / max * 85}%` }" /></template></div>
        <div class="half r"><template v-if="f.buy.length"><div class="bar buy" :style="{ width: `${f.buy.length / max * 85}%` }" /><span class="small">{{ f.buy.length }}</span></template></div></div></div></UiCard>
    <UiCard><h2>{{ t('trades') }}</h2>
      <div class="row"><UiNativeSelect v-model="group" :aria-label="t('who')"><option value="">{{ t('all') }}</option><option v-for="g in ['fund', 'insider', 'congress', 'sovereign']" :key="g" :value="g">{{ t(g) }}</option></UiNativeSelect><UiNativeSelect v-model="side" :aria-label="t('dir')"><option value="">{{ t('all') }}</option><option value="buy">{{ t('buyers') }}</option><option value="sell">{{ t('sellers') }}</option></UiNativeSelect><UiInput v-model="q" :placeholder="t('search')" :aria-label="t('search')" /></div>
      <UiTable><thead><tr><th v-for="k in ['who', 'symbol', 'dir', 'size', 'tdate', 'filed', 'ev', 'note']" :key="k">{{ t(k) }}</th></tr></thead><tbody>
        <tr v-for="(r, i) in rows" :key="i"><td><bdi>{{ r.who }}</bdi></td><td><bdi>{{ r.ticker }}</bdi></td><td>{{ sideOf(r) === 'buy' ? '▲' : '▼' }} {{ dirText(r.dir) }}</td><td><bdi dir="ltr">{{ r.size }}</bdi></td><td class="num">{{ r.date }}</td><td class="num">{{ r.filed || t('nf') }}</td><td class="small">{{ grade(r.ev) }} <a v-for="(u, j) in r.urls" :key="j" :href="u" target="_blank" rel="noopener noreferrer">[{{ j + 1 }}]</a></td><td class="small muted">{{ r.note?.[lang] }}</td></tr></tbody></UiTable></UiCard>
    <UiCard><h2>{{ t('news') }}</h2><article v-for="n in d.news" :key="n.date + n.title.en" class="item"><div class="small muted"><span class="num">{{ n.date }}</span> <UiBadge v-for="k in n.tickers" :key="k">{{ k }}</UiBadge> {{ grade(n.ev) }} <a v-for="(u, j) in n.urls" :key="j" :href="u" target="_blank" rel="noopener noreferrer">[{{ j + 1 }}]</a></div><b>{{ n.title[lang] }}</b><p>{{ n.why[lang] }}</p></article></UiCard>
    <UiCard><h2>{{ t('events') }}</h2><ul><li v-for="c in d.catalysts" :key="c.date + c.label.en"><span class="num">{{ c.date }}</span> {{ c.label[lang] }} <a :href="c.url" target="_blank" rel="noopener noreferrer">{{ t('src') }}</a></li></ul></UiCard>
    <UiCard><h2>{{ t('gaps') }}</h2><ul><li v-for="g in d.gaps" :key="g.en">{{ g[lang] }}</li></ul></UiCard>
  </template>
  </div>
</template>
