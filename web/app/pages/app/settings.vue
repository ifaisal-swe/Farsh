<script setup lang="ts">
import { Check } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { t, lang, num } = useLang()
const { state } = useTerminal()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const cfg = ref<any>(null)
const error = ref('')
const ok = ref('')
const busy = ref(false)
const resetting = ref(false)
const limits = reactive<Record<string, string>>({ maxDebtPct: '', maxDepositsPct: '', maxIncomePct: '' })
const saved: Record<string, string> = { ...limits }
const positions = ref('')
let savedPositions = ''
const me = ref<any>(null)
const totp = reactive({ secret: '', code: '', password: '' })
const pw = reactive({ current: '', next: '' })
const RISKS = computed(() => [['CONSERVATIVE', L('صفقات صغيرة وقليلة، وتوقف مبكر عند الخسارة.', 'Few, small trades and an early stop after losses.')], ['BALANCED', L('توازن بين عدد الصفقات وحجمها.', 'A balance of how many trades and how large.')], ['AGGRESSIVE', L('صفقات أكبر، واحتمال تراجع أكبر.', 'Larger trades and larger possible drops.')], ['VERY_AGGRESSIVE', L('أكبر حجم وأكبر تراجع محتمل.', 'The largest trades and the largest possible drops.')]])
const MODES = computed(() => [['FULL', L('تُنفّذ المحاكاة وحدها ضمن حدودك.', 'The simulation trades by itself within your limits.')], ['SEMI', L('تصلك كل صفقة لتوافق عليها أو ترفضها.', 'Every trade comes to you to approve or decline.')], ['ADVISORY', L('اقتراحات فقط، ولا تُنفّذ أي صفقة.', 'Suggestions only; nothing is traded.')]])
const SHARIA = computed(() => [['BUSINESS', L('نشاط الشركة فقط', 'The company\'s activity only'), L('يُمنع ما يبيع محرمًا أو يعمل فيه، مثل البنوك الربوية والخمور والقمار. لا ينظر إلى الديون والودائع والدخل.', 'Blocks companies whose business is not allowed, such as interest banking, alcohol and gambling. It does not look at debt, deposits or income.')], ['FULL', L('الفحص الكامل', 'The full check'), L('النشاط، ثم حدود الديون والودائع والدخل غير المباح. يحتاج إلى تقارير الشركات.', 'The activity, then limits on debt, deposits and impermissible income. It needs company reports.')]])
const LIMITS = computed(() => [['maxDebtPct', L('أقصى دين بفائدة', 'Debt limit')], ['maxDepositsPct', L('أقصى ودائع وأوراق', 'Deposit limit')], ['maxIncomePct', L('أقصى دخل غير مباح', 'Impermissible income limit')]])
async function load() {
  cfg.value = (await api('settings')).config
  // a field follows the saved value only while the reader has not changed it
  for (const k of Object.keys(limits)) { const v = String(cfg.value.sharia[k]); if (limits[k] === saved[k]) limits[k] = v; saved[k] = v }
  const p = String(cfg.value.risk.maxOpenPositions ?? ''); if (positions.value === savedPositions) positions.value = p; savedPositions = p
  try { const r = await fetch('/account/me'); me.value = r.ok && r.headers.get('content-type')?.includes('json') ? await r.json() : null } catch { me.value = null }
}
async function run(fn: () => Promise<any>) {
  busy.value = true; error.value = ''; ok.value = ''
  try { await fn(); await load(); ok.value = L('تم الحفظ', 'Saved') } catch (e: any) { error.value = e.message } finally { busy.value = false }
}
async function account(path: string, body: any) {
  const r = await fetch(`/account/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify(body) })
  const x = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(plain.error(x.error || '', ar.value))
  return x
}
const reset = () => run(async () => { resetting.value = false; await api('session/reset', { confirm: 'RESET' }) })
const saveLimits = () => run(() => {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(limits)) { const n = Number(v); if (!v.trim() || !Number.isFinite(n)) throw new Error(L('أدخل رقمًا', 'Enter a number')); out[k] = n }
  return api('settings', { sharia: out })
})
const savePositions = () => run(() => {
  const n = Number(positions.value)
  if (!Number.isInteger(n) || n < 1 || n > 30) throw new Error(L('أدخل عددًا صحيحًا من 1 إلى 30', 'Enter a whole number from 1 to 30'))
  return api('settings', { risk: { maxOpenPositions: n } })
})
const beginTotp = async () => { error.value = ''; try { totp.secret = (await account('totp/begin', { password: totp.password })).secret } catch (e: any) { error.value = e.message } }
const confirmTotp = () => run(async () => { await account('totp/confirm', { code: totp.code }); Object.assign(totp, { secret: '', code: '', password: '' }) })
const disableTotp = () => run(async () => { await account('totp/disable', { password: totp.password, code: totp.code }); Object.assign(totp, { secret: '', code: '', password: '' }) })
const changePw = () => run(async () => { await account('password', { ...pw }); location.href = '/login' })
const choice = (on: boolean) => ['rounded-2xl border p-4 text-start transition-colors disabled:opacity-50', on ? 'border-primary bg-secondary text-secondary-foreground' : 'bg-card hover:bg-accent']
onMounted(() => load().catch((e) => { error.value = e.message }))
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">{{ error }}</p><p v-if="ok" class="up" role="status">{{ ok }}</p>
    <template v-if="cfg">
      <UiCard><h2>{{ L('المحاكاة', 'Simulation') }}</h2>
        <template v-if="state?.tradingSession"><p><bdi>{{ state.primarySymbol }}</bdi> · {{ L('رأس المال', 'Capital') }} <span class="num">{{ num(state.tradingSession.initialCapital, 0) }}</span> · {{ L('الأسعار', 'Prices') }}: {{ plain.prices(state, ar) }}</p><UiButton variant="destructive" :disabled="busy" @click="resetting = true">{{ L('ابدأ من جديد', 'Start over') }}</UiButton>
          <UiConfirm :open="resetting" :title="L('البدء من جديد؟', 'Start over?')" :text="L('تنتهي المحاكاة الحالية وتبدأ محفظة جديدة.', 'The current simulation ends and a new portfolio begins.')" :confirm="L('نعم، ابدأ من جديد', 'Yes, start over')" :cancel="t('cancel')" :busy="busy" @confirm="reset" @close="resetting = false" /></template>
        <StartForm v-else @started="load" /></UiCard>
      <UiCard><h2>{{ L('مستوى المخاطرة', 'Risk level') }}</h2><div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><button v-for="[k, text] in RISKS" :key="k" type="button" :aria-pressed="cfg.risk.profile === k" :class="choice(cfg.risk.profile === k)" :disabled="busy || !state?.tradingSession" @click="run(() => api('risk/profile', { profile: k }))"><span class="flex items-center justify-between font-semibold">{{ plain.risk(k, ar) }}<Check v-if="cfg.risk.profile === k" class="size-5" aria-hidden="true" /></span><span class="small mt-1 block">{{ text }}</span></button></div><p v-if="!state?.tradingSession" class="small muted !mt-3">{{ t('no_session') }}</p></UiCard>
      <UiCard id="positions"><h2>{{ L('حد المراكز للتداول الآلي', 'Position limit for automation') }}</h2><form class="flex flex-wrap items-end gap-4" @submit.prevent="savePositions"><label class="grid gap-1.5 text-sm font-medium">{{ L('أقصى عدد للأسهم المفتوحة معًا', 'Most stocks held at once') }}<UiInput v-model="positions" type="number" step="1" min="1" max="30" dir="ltr" class="w-28" /></label><UiButton type="submit" :disabled="busy">{{ t('save') }}</UiButton></form><p class="small muted !m-0 mt-3">{{ L('تغيير هذا الحد يجعل مستوى المخاطرة «مخصصًا».', 'Changing this limit makes the risk level "custom".') }}</p></UiCard>
      <UiCard><h2>{{ t('mode') }}</h2><div class="grid gap-3 sm:grid-cols-3"><button v-for="[k, text] in MODES" :key="k" type="button" :aria-pressed="cfg.ai.autonomy === k" :class="choice(cfg.ai.autonomy === k)" :disabled="busy" @click="run(() => api('settings', { ai: { autonomy: k } }))"><span class="flex items-center justify-between font-semibold">{{ t(k!) }}<Check v-if="cfg.ai.autonomy === k" class="size-5" aria-hidden="true" /></span><span class="small mt-1 block">{{ text }}</span></button></div></UiCard>
      <UiCard><h2>{{ L('الذكاء الاصطناعي يختار أسواقك', 'The AI picks your markets') }}</h2><div class="grid gap-3 sm:grid-cols-2"><button v-for="on in [true, false]" :key="String(on)" type="button" :aria-pressed="!!cfg.ai.pickMarkets === on" :class="choice(!!cfg.ai.pickMarkets === on)" :disabled="busy" @click="run(() => api('settings', { ai: { pickMarkets: on } }))"><span class="flex items-center justify-between font-semibold">{{ on ? L('مفعّل', 'On') : L('متوقف', 'Off') }}<Check v-if="!!cfg.ai.pickMarkets === on" class="size-5" aria-hidden="true" /></span><span class="small mt-1 block">{{ on ? L('يضيف أقوى الأسهم مقارنة بالسوق إلى «أسواقك»، ويزيل ما أضافه إذا ضعف.', 'Adds the stocks strongest against the market to Your markets, and removes its own picks when they weaken.') : L('أنت وحدك تختار ما في «أسواقك».', 'Only you choose what is in Your markets.') }}</span></button></div>
        <label v-if="cfg.ai.pickMarkets" class="mt-4 grid max-w-xs gap-1.5"><span class="small muted">{{ L('أقصى عدد يضيفه', 'The most it adds') }}</span><UiNativeSelect :value="cfg.ai.pickMarketsCount" :disabled="busy" @change="run(() => api('settings', { ai: { pickMarketsCount: Number(($event.target as HTMLSelectElement).value) } }))"><option v-for="n in [3, 5, 10, 15, 20]" :key="n" :value="n">{{ n }}</option></UiNativeSelect></label>
        <p class="small muted !m-0 mt-3">{{ L('يعمل بالأسعار الحقيقية فقط. لا يزيل سهمًا أضفته أنت، ولا سهمًا تملكه أو تديره خطتك أو أمرك.', 'Works with real prices only. It never removes a stock you added, one you hold, or one your plan or order manages.') }}</p></UiCard>
      <UiCard><h2>{{ L('البيع عند الهدف', 'Selling at the target') }}</h2><label class="grid max-w-xs gap-1.5"><span class="small muted">{{ L('يُعد السعر قد بلغ الهدف إذا اقترب منه', 'The target counts as reached when the price is within') }}</span><UiNativeSelect :value="cfg.execution.nearTargetPct" :disabled="busy" @change="run(() => api('settings', { execution: { nearTargetPct: Number(($event.target as HTMLSelectElement).value) } }))"><option v-for="n in [0, 0.05, 0.1, 0.25, 0.5]" :key="n" :value="n">{{ n ? `${n}%` : L('السعر نفسه فقط', 'The exact price only') }}</option></UiNativeSelect></label><p class="small muted !m-0 mt-3">{{ L('مثال: هدف 72.99 وقرب 0.05% يعني البيع عند 72.96 فأعلى. ووقف الخسارة يبيع فور وصول السعر إليه أو نزوله تحته.', 'Example: a 72.99 target within 0.05% sells at 72.96 or higher. The stop sells as soon as the price reaches it or falls below it.') }}</p></UiCard>
      <UiCard><h2>{{ L('ماذا يشمل الفحص الشرعي؟', 'What does the Sharia check cover?') }}</h2><div class="grid gap-3 sm:grid-cols-2"><button v-for="[k, n, text] in SHARIA" :key="k" type="button" :aria-pressed="cfg.sharia.mode === k" :class="choice(cfg.sharia.mode === k)" :disabled="busy" @click="run(() => api('settings', { sharia: { mode: k } }))"><span class="flex items-center justify-between font-semibold">{{ n }}<Check v-if="cfg.sharia.mode === k" class="size-5" aria-hidden="true" /></span><span class="small mt-1 block">{{ text }}</span></button></div></UiCard>
      <UiCard v-if="cfg.sharia.mode !== 'BUSINESS'"><h2>{{ L('حدود الفحص الشرعي', 'Sharia limits') }}</h2><form class="flex flex-wrap items-end gap-4" @submit.prevent="saveLimits"><label v-for="[k, name] in LIMITS" :key="k" class="grid gap-1.5 text-sm font-medium">{{ name }}<span class="flex items-center gap-2"><UiInput v-model="limits[k!]" type="number" step="any" min="0" dir="ltr" class="w-28" />%</span></label><UiButton type="submit" :disabled="busy">{{ t('save') }}</UiButton></form></UiCard>
      <UiCard v-if="me"><h2>{{ L('الحساب', 'Account') }} <bdi class="small muted">{{ me.email }}</bdi></h2>
        <form class="row" @submit.prevent="changePw"><UiInput v-model="pw.current" type="password" autocomplete="current-password" :placeholder="L('كلمة المرور الحالية', 'Current password')" :aria-label="L('كلمة المرور الحالية', 'Current password')" /><UiInput v-model="pw.next" type="password" autocomplete="new-password" minlength="12" :placeholder="L('الجديدة (12 حرفًا أو أكثر)', 'New (12 or more characters)')" :aria-label="L('كلمة المرور الجديدة', 'New password')" /><UiButton type="submit" :disabled="busy || pw.next.length < 12">{{ L('تغيير كلمة المرور', 'Change password') }}</UiButton></form>
        <p>{{ L('الدخول بخطوتين', 'Two-step sign-in') }}: <UiBadge :tone="me.totp ? 'PASS' : 'UNKNOWN'">{{ me.totp ? L('مفعّل', 'On') : L('غير مفعّل', 'Off') }}</UiBadge></p>
        <p v-if="totp.secret">{{ L('أضف هذا الرمز في تطبيق المصادقة، ثم أدخل الأرقام الستة:', 'Add this code to your authenticator app, then enter the six digits:') }} <bdi dir="ltr" class="font-semibold">{{ totp.secret }}</bdi></p>
        <div class="row"><UiInput v-if="!totp.secret" v-model="totp.password" type="password" autocomplete="current-password" :placeholder="L('كلمة المرور', 'Password')" :aria-label="L('كلمة المرور', 'Password')" /><UiInput v-if="totp.secret || me.totp" v-model="totp.code" dir="ltr" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="000000" :aria-label="L('الرمز', 'Code')" /><UiButton v-if="totp.secret" variant="default" :disabled="busy" @click="confirmTotp">{{ L('تأكيد', 'Confirm') }}</UiButton><UiButton v-else-if="me.totp" variant="destructive" :disabled="busy" @click="disableTotp">{{ L('إيقاف', 'Turn off') }}</UiButton><UiButton v-else :disabled="busy" @click="beginTotp">{{ L('تفعيل', 'Turn on') }}</UiButton></div></UiCard>
    </template>
  </div>
</template>
