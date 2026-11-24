<script setup lang="ts">
import { plain } from '~/lib/plain'
const emit = defineEmits<{ started: [] }>()
const { t, lang } = useLang()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const f = reactive({ symbol: '', capital: '10000', risk: 'BALANCED', mode: 'SEMI', live: false })
const conn = ref<any>({})
const error = ref('')
const busy = ref(false)
const IDEAS = ['NVDA', 'AAPL', 'MSFT', 'AMZN', 'TSLA']
const AMOUNTS = ['5000', '10000', '50000']
const RISKS = ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE']
const MODES = computed(() => [['SEMI', L('أوافق على كل صفقة', 'I approve each trade')], ['FULL', L('آلي بالكامل', 'Fully automatic')], ['ADVISORY', L('اقتراحات فقط', 'Suggestions only')]])
const canLive = computed(() => conn.value.prices && (conn.value.assistant || conn.value.rules))
const chip = (on: boolean) => ['min-h-11 rounded-full border px-5 text-sm font-medium transition-colors', on ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent']
async function start() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    // the mode is saved first, so nothing can trade before it applies
    await api('settings', { ai: { autonomy: f.mode } })
    await api('session/start', { symbol: f.symbol.trim().toUpperCase(), initialCapital: Number(f.capital), targetCapital: null, demo: !f.live })
    await api('risk/profile', { profile: f.risk })
    emit('started')
  } catch (e: any) { error.value = e.message } finally { busy.value = false }
}
onMounted(async () => { try { conn.value = await api('connections'); f.live = !!canLive.value } catch { /* demo prices only */ } })
</script>

<template>
  <form class="grid gap-7" @submit.prevent="start">
    <fieldset class="grid gap-2.5"><legend class="mb-2.5 font-display font-semibold">{{ L('1. اختر السهم', '1. Choose a stock') }}</legend>
      <div class="flex flex-wrap gap-2"><button v-for="x in IDEAS" :key="x" type="button" :aria-pressed="f.symbol === x" :class="chip(f.symbol === x)" @click="f.symbol = x">{{ x }}</button><UiInput v-model="f.symbol" dir="ltr" maxlength="10" :placeholder="L('رمز آخر', 'Other')" :aria-label="L('رمز السهم', 'Stock symbol')" class="h-11 w-32 rounded-full px-5 uppercase" /></div></fieldset>
    <fieldset><legend class="mb-2.5 font-display font-semibold">{{ L('2. رأس المال الافتراضي', '2. Practice capital') }}</legend>
      <div class="flex flex-wrap items-center gap-2"><button v-for="x in AMOUNTS" :key="x" type="button" :aria-pressed="f.capital === x" :class="chip(f.capital === x)" @click="f.capital = x"><bdi dir="ltr">${{ Number(x).toLocaleString('en-US') }}</bdi></button><UiInput v-model="f.capital" type="number" min="10" dir="ltr" :aria-label="L('رأس المال', 'Capital')" class="h-11 w-32 rounded-full px-5" /></div></fieldset>
    <fieldset><legend class="mb-2.5 font-display font-semibold">{{ L('3. مستوى المخاطرة', '3. Risk level') }}</legend><div class="flex flex-wrap gap-2"><button v-for="x in RISKS" :key="x" type="button" :aria-pressed="f.risk === x" :class="chip(f.risk === x)" @click="f.risk = x">{{ plain.risk(x, ar) }}</button></div></fieldset>
    <fieldset><legend class="mb-2.5 font-display font-semibold">{{ L('4. من يقرر؟', '4. Who decides?') }}</legend><div class="flex flex-wrap gap-2"><button v-for="[k, n] in MODES" :key="k" type="button" :aria-pressed="f.mode === k" :class="chip(f.mode === k)" @click="f.mode = k!">{{ n }}</button></div></fieldset>
    <label v-if="canLive" class="flex items-center gap-3"><UiSwitch v-model="f.live" />{{ L('أسعار حية', 'Live prices') }}</label>
    <p v-if="error" role="alert" class="!m-0 text-destructive">{{ error }}</p>
    <div class="flex flex-wrap items-center gap-4"><UiButton type="submit" variant="default" size="lg" class="max-sm:w-full" :disabled="busy || !f.symbol.trim() || !(Number(f.capital) >= 10)">{{ L('ابدأ المحاكاة', 'Start the simulation') }}</UiButton><span v-if="f.live && !conn.assistant" class="small muted">{{ L('أسعار حقيقية. الاقتراحات بقواعد ثابتة، وتنتظر الفحص الشرعي.', 'Real prices. Suggestions follow fixed rules and wait for the Sharia check.') }}</span><span v-if="!f.live" class="small muted">{{ L('بأسعار تجريبية غير حقيقية، للتدرّب فقط.', 'With invented demo prices, for practice only.') }}</span></div>
  </form>
</template>
