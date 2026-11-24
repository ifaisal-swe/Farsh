<script setup lang="ts">
import { Bell, BrainCircuit, ChartCandlestick, Ellipsis, History, LogOut, Newspaper, ChartPie, Scale, Settings, SlidersHorizontal, Target, Zap, ShieldCheck, Users } from '@lucide/vue'
const { t, lang } = useLang()
const { state, stale, lastAt, now } = useTerminal()
// invented prices under a real symbol must never pass for the market
const demo = computed(() => !!state.value?.tradingSession && state.value.tradingSession.dataMode !== 'LIVE')
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const { view: market, count, PHASE } = useMarketHours()
const route = useRoute()
const open = ref(false)
const me = ref<any>(null)
const NAV = [['/app', 'nav_dash', ChartCandlestick], ['/app/orders', 'nav_orders', Zap], ['/app/technical', 'nav_tech', SlidersHorizontal], ['/app/stocks', 'nav_pick', Scale], ['/app/plan', 'nav_plan', ChartPie], ['/app/invest', 'nav_invest', Target], ['/app/analysis', 'nav_analysis', BrainCircuit], ['/app/research', 'nav_research', Newspaper], ['/app/history', 'nav_history', History], ['/app/sharia', 'nav_sharia', ShieldCheck], ['/app/alerts', 'nav_alerts', Bell], ['/app/settings', 'nav_settings', Settings]] as const
const TABS = computed(() => [NAV[0], NAV[1], NAV[2], NAV[3]])
const MORE = computed(() => [NAV[4], NAV[5], NAV[6], NAV[7], NAV[8], NAV[9], NAV[10], NAV[11]])
const SHORT: Record<string, [string, string]> = { nav_dash: ['التداول', 'Trading'], nav_analysis: ['التحليل', 'Analysis'], nav_plan: ['الخطة', 'Plan'], nav_tech: ['الفني', 'Technical'], nav_pick: ['الاختيار', 'Picking'], nav_orders: ['الأوامر', 'Orders'], nav_invest: ['الأهداف', 'Goals'], nav_sharia: ['الشرعي', 'Sharia'], nav_alerts: ['التنبيهات', 'Alerts'] }
const canLive = ref(false)
onMounted(async () => { try { const c = await api('connections'); canLive.value = c.prices && (c.assistant || c.rules) } catch { /* stays hidden */ } })
const active = (to: string) => route.path.replace(/\/$/, '') === to
watch(() => route.path, () => { open.value = false })
onMounted(async () => { try { const r = await fetch('/account/me'); if (r.ok && r.headers.get('content-type')?.includes('json')) me.value = await r.json() } catch { /* single-user mode */ } })
async function signOut() { try { await fetch(me.value ? '/account/logout' : '/api/auth/logout', { method: 'POST', headers: { 'X-Terminal-Client': '1' } }) } finally { location.href = me.value ? '/' : '/login' } }
const item = 'flex items-center gap-3 rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
const night = 'flex min-h-11 items-center gap-3 rounded-full px-4 text-[0.9375rem] text-panel-muted transition-colors hover:bg-white/10 hover:text-white'
const here = computed(() => NAV.find(([to]) => active(to)))
const ABOUT: Record<string, [string, string]> = { nav_orders: ['اكتب أمرك، وراجعه قبل أن يُنفّذ ورقيًا.', 'Write an order and review it before it is placed on paper.'], nav_tech: ['ما يقوله الرسم، بخطوات ومستويات واضحة.', 'What the chart says, in clear steps and levels.'], nav_pick: ['أسهمك بقواعد كبار المستثمرين، مع ما تحقق وما لم يتحقق.', 'Your stocks under great investors’ rules: what is met and what is not.'], nav_plan: ['نسب لمحفظتك الورقية، وكيف تُبنى وتُوازن.', 'Percentages for your paper portfolio, and how it is built and balanced.'], nav_invest: ['أهدافك، والاستثمارات الورقية التي تتبعها.', 'Your goals, and the paper investments that follow them.'], nav_analysis: ['رأي المحللين والأرقام وراءه.', 'What the analysts say and the numbers behind it.'], nav_research: ['أخبار وبحوث مؤرخة ومسندة إلى مصادرها.', 'Dated news and research with its sources.'], nav_history: ['صفقاتك الورقية ونتائجها.', 'Your paper trades and their results.'], nav_sharia: ['ما اجتاز الفحص وما ينتظر حكمك.', 'What passed the screen and what waits for your ruling.'], nav_alerts: ['ما يصلك على تيليجرام، ومتى.', 'What reaches you on Telegram, and when.'], nav_settings: ['المحاكاة والمخاطر وطريقة العمل.', 'The simulation, its risk and how it runs.'] }
</script>

<template>
  <div class="product min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
    <aside class="hidden bg-[#0d0f26] text-white [--ring:#ffd32e] lg:sticky lg:top-0 lg:block lg:h-dvh">
      <div class="flex h-full flex-col overflow-y-auto p-4">
        <NuxtLink to="/app" data-slot="brand" class="mt-1 mb-7 flex items-center gap-3 px-2"><BrandMark /><span class="font-display text-xl font-bold text-white">{{ t('brand') }}</span></NuxtLink>
        <nav class="grid gap-1" :aria-label="L('الأقسام', 'Sections')"><NuxtLink v-for="[to, k, icon] in NAV" :key="to" :to="to" data-slot="nav" :class="[night, active(to) && '!bg-brand font-semibold !text-white']" :aria-current="active(to) ? 'page' : undefined"><component :is="icon" class="size-5" aria-hidden="true" />{{ t(k) }}</NuxtLink></nav>
        <div class="mt-auto grid gap-1 border-t border-white/15 pt-3"><NuxtLink v-if="me?.role === 'ADMIN'" to="/admin" data-slot="nav" :class="night"><Users class="size-5" aria-hidden="true" />{{ L('الحسابات', 'Accounts') }}</NuxtLink><button type="button" :class="night" @click="signOut"><LogOut class="size-5" aria-hidden="true" />{{ L('تسجيل الخروج', 'Sign out') }}</button></div>
      </div>
    </aside>
    <div class="min-w-0">
      <header class="sticky top-0 z-20 flex min-h-[4.5rem] items-center gap-2.5 border-b bg-card px-4 py-2 sm:gap-3 sm:px-6">
        <NuxtLink to="/app" data-slot="brand" class="flex items-center lg:hidden" :aria-label="t('brand')"><BrandMark /></NuxtLink>
        <UiBadge tone="warn" class="!px-3.5 !py-0.5 text-sm whitespace-nowrap">{{ t('paper') }}</UiBadge>
        <span class="small min-w-0 truncate max-sm:hidden" :class="stale ? 'down' : 'muted'" role="status"><i class="me-1.5 inline-block size-2 rounded-full" :class="stale ? 'bg-down' : 'bg-up live-dot'" />{{ stale ? t('offline') : t('live') }}<span v-if="lastAt" class="max-sm:hidden"> · {{ t('updated') }} <bdi dir="ltr">{{ Math.max(0, Math.round((now - lastAt) / 1000)) }}</bdi> {{ t('ago') }}</span></span>
        <span class="grow" /><NuxtLink v-if="market" to="/app#hours" data-slot="nav" class="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full bg-secondary px-3.5 text-sm text-secondary-foreground"><i class="size-2 shrink-0 rounded-full" :class="market.open ? 'bg-up' : market.phase === 'CLOSED' ? 'bg-down' : 'bg-sky'" aria-hidden="true" /><span class="max-md:hidden">{{ PHASE[market.phase] }}</span><span>{{ market.open ? L('يغلق بعد', 'closes in') : L('يفتح بعد', 'opens in') }}</span><b class="num">{{ count(market.left) }}</b></NuxtLink><ThemeLang class="max-lg:!hidden" />
      </header>
      <p v-if="demo" role="note" class="!m-0 flex flex-wrap items-center justify-center gap-x-2 bg-sun px-4 py-2 text-center text-sm font-semibold text-sun-foreground">{{ L('أسعار تجريبية غير حقيقية. لا تطابق السوق ولا تعتمد عليها.', 'Demo prices, not real. They do not match the market; do not rely on them.') }}<NuxtLink v-if="canLive" to="/app/settings" data-slot="nav" class="inline-flex min-h-8 items-center rounded-full bg-[#0a0b1a] px-4 text-white">{{ L('انتقل إلى الأسعار الحقيقية', 'Switch to real prices') }}</NuxtLink></p>
      <main class="mx-auto max-w-[110rem] p-4 pb-28 sm:p-6 sm:pb-28 lg:pb-8">
        <div v-if="here && here[0] !== '/app'" class="mb-5 flex items-center gap-4 rounded-3xl bg-secondary p-5 text-secondary-foreground sm:gap-5 sm:p-7"><span class="inline-flex size-14 shrink-0 items-center justify-center rounded-2xl bg-brand text-white"><component :is="here[2]" class="size-7" aria-hidden="true" /></span><div class="min-w-0"><h1 class="text-2xl leading-snug sm:text-3xl">{{ t(here[1]) }}</h1><p class="!m-0">{{ L(...ABOUT[here[1]]!) }}</p></div></div>
        <slot />
      </main>
    </div>
    <div v-if="open" class="fixed inset-0 z-30 bg-black/40 lg:hidden" @click="open = false" />
    <div v-show="open" id="more" class="sheet fixed inset-x-0 bottom-0 z-40 rounded-t-3xl border-t bg-card p-4 pb-24 lg:hidden">
      <NuxtLink v-for="[to, k, icon] in MORE" :key="to" :to="to" data-slot="nav" :class="[item, 'min-h-12 !text-base']"><component :is="icon" class="size-5" aria-hidden="true" />{{ t(k) }}</NuxtLink>
      <NuxtLink v-if="me?.role === 'ADMIN'" to="/admin" data-slot="nav" :class="[item, 'min-h-12 !text-base']"><Users class="size-5" aria-hidden="true" />{{ L('الحسابات', 'Accounts') }}</NuxtLink>
      <button type="button" :class="[item, 'min-h-12 w-full !text-base']" @click="signOut"><LogOut class="size-5" aria-hidden="true" />{{ L('تسجيل الخروج', 'Sign out') }}</button>
      <div class="mt-3 border-t pt-3"><ThemeLang full /></div>
    </div>
    <nav class="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 bg-[#0d0f26] [--ring:#ffd32e] pb-[env(safe-area-inset-bottom)] lg:hidden" :aria-label="L('الأقسام', 'Sections')" @keydown.esc="open = false">
      <NuxtLink v-for="[to, k, icon] in TABS" :key="to" :to="to" data-slot="nav" class="flex min-h-16 flex-col items-center justify-center gap-1 text-xs" :class="active(to) && !open ? 'font-semibold text-sun' : 'text-panel-muted'" :aria-current="active(to) ? 'page' : undefined"><component :is="icon" class="size-5" aria-hidden="true" />{{ (SHORT[k] ? L(...SHORT[k]!) : t(k)) }}</NuxtLink>
      <button type="button" class="flex min-h-16 flex-col items-center justify-center gap-1 text-xs" :class="open || MORE.some(([to]) => active(to)) ? 'font-semibold text-sun' : 'text-panel-muted'" aria-controls="more" :aria-expanded="open" @click="open = !open"><Ellipsis class="size-5" aria-hidden="true" />{{ L('المزيد', 'More') }}</button>
    </nav>
  </div>
</template>
