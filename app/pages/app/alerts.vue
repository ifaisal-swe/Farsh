<script setup lang="ts">
import { plain } from '~/lib/plain'
const { t, lang } = useLang()
const ar = computed(() => lang.value === 'ar')
const { feed } = useTerminal()
const CATS = ['enabled', 'trades', 'ai', 'risk', 'news', 'data', 'market', 'watchlist', 'breakouts', 'monitoring']
const tg = ref<any>(null)
const prefs = ref<any>(null)
const error = ref('')
const sent = ref(false)
const busy = ref(false)
async function account(path: string, body?: any) {
  const r = await fetch(`/account/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify(body) } : {})
  const x = r.headers.get('content-type')?.includes('json') ? await r.json() : {}
  if (!r.ok) throw new Error(plain.error(x.error || '', ar.value))
  return x
}
async function load() {
  try { prefs.value = (await api('settings')).config.telegram.notifications } catch (e: any) { error.value = e.message }
  try { const x = await account('telegram'); tg.value = 'available' in x ? x : { available: false, linked: false } } catch { tg.value = { available: false, linked: false } }
}
async function set(k: string, v: boolean) {
  error.value = ''
  try { prefs.value = (await api('settings', { telegram: { notifications: { [k]: v } } })).config.telegram.notifications } catch (e: any) { error.value = e.message; await load() }
}
async function run(fn: () => Promise<any>) { busy.value = true; error.value = ''; sent.value = false; try { await fn() } catch (e: any) { error.value = e.message } finally { busy.value = false } }
// the window opens inside the click, so the browser does not block it; linking is confirmed when the visitor returns
const link = () => { const w = window.open('', '_blank'); if (w) w.opener = null; return run(async () => { try { const { url } = await account('telegram/link', {}); if (w) w.location.href = url; else location.href = url } catch (e) { w?.close(); throw e } }) }
const unlink = () => run(async () => { await account('telegram/unlink', {}); await load() })
const test = () => run(async () => { const r = await api('telegram/test', {}); if (!r.ok) throw new Error(plain.error('Telegram', ar.value)); sent.value = true })
const seen = () => { if (!document.hidden && tg.value && !tg.value.linked) load() }
const happened = computed(() => [...feed.value].reverse().map((e) => ({ ...e, text: plain.event(e, ar.value), kind: plain.kind(e.type) })).filter((e) => e.text).slice(0, 60))
const time = (ts: number) => new Date(ts).toLocaleString('en-GB')
onMounted(() => { load(); document.addEventListener('visibilitychange', seen) })
onBeforeUnmount(() => document.removeEventListener('visibilitychange', seen))
</script>

<template>
  <div>
    <p class="muted">{{ t('a_intro') }}</p>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <div class="cols">
      <UiCard><h2>{{ t('recent') }}</h2><TransitionGroup name="feed"><div v-for="e in happened" :key="e.seq" class="item"><i class="me-2 inline-block size-2 rounded-full" :class="e.kind === 'up' ? 'bg-up' : e.kind === 'warn' ? 'bg-down' : 'bg-primary'" /><bdi>{{ e.text }}</bdi><div class="num small muted">{{ time(e.ts) }}</div></div></TransitionGroup><span v-if="!happened.length" class="muted">{{ t('none') }}</span></UiCard>
      <div>
        <UiCard v-if="tg"><h2>{{ tg.linked ? t('tg_on') : t('tg_off') }}</h2>
          <p v-if="!tg.available" class="muted">{{ t('tg_none') }}</p>
          <template v-else-if="!tg.linked"><p class="muted">{{ t('tg_setup') }}</p><UiButton variant="default" :disabled="busy" @click="link">{{ t('tg_link') }}</UiButton></template>
          <div v-else class="row"><UiButton variant="default" :disabled="busy" @click="test">{{ t('test') }}</UiButton><UiButton :disabled="busy" @click="unlink">{{ t('tg_unlink') }}</UiButton><span v-if="sent" class="up" role="status">{{ t('sent') }}</span></div></UiCard>
        <UiCard v-if="prefs"><h2>{{ t('nav_alerts') }}</h2><label v-for="k in CATS" :key="k" class="row"><UiSwitch :model-value="!!prefs[k]" @update:model-value="set(k, $event)" />{{ t(`c_${k}`) }}</label></UiCard>
      </div>
    </div>
  </div>
</template>
