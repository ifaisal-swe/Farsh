<script setup lang="ts">
import { BrainCircuit, Ellipsis, House, LogOut, Settings, Sunrise, Users, Wallet } from '@lucide/vue'
const { t, lang } = useLang()
const { state, stale, lastAt, now } = useTerminal()
// invented prices under a real symbol must never pass for the market
const demo = computed(() => !!state.value?.tradingSession && state.value.tradingSession.dataMode !== 'LIVE')
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const { view: market, count, PHASE } = useMarketHours()
const route = useRoute()
const open = ref(false)
const me = ref<any>(null)
const trial = ref<any>(null)
// five clear places; related pages are small tabs inside each one
const GROUPS = [
  { id: 'home', icon: House, name: ['الرئيسية', 'Home'], pages: [['/app', 'nav_dash']] },
  { id: 'find', icon: Sunrise, name: ['الفرص', 'Opportunities'], pages: [['/app/opportunities', 'nav_opps'], ['/app/team', 'nav_team'], ['/app/stocks', 'nav_pick']] },
  { id: 'study', icon: BrainCircuit, name: ['تحليل سهم', 'Analyse a stock'], pages: [['/app/analysis', 'nav_analysis'], ['/app/technical', 'nav_tech'], ['/app/research', 'nav_research'], ['/app/sharia', 'nav_sharia']] },
  { id: 'wallet', icon: Wallet, name: ['محفظتي', 'My portfolio'], pages: [['/app/orders', 'nav_orders'], ['/app/plan', 'nav_plan'], ['/app/invest', 'nav_invest'], ['/app/history', 'nav_history']] },
  { id: 'settings', icon: Settings, name: ['الإعدادات', 'Settings'], pages: [['/app/settings', 'nav_settings'], ['/app/alerts', 'nav_alerts']] },
] as { id: string, icon: any, name: [string, string], pages: [string, string][] }[]
const SHORT: Record<string, [string, string]> = { study: ['تحليل', 'Analyse'], wallet: ['محفظتي', 'Portfolio'], find: ['الفرص', 'Find'], settings: ['الإعدادات', 'Settings'], home: ['الرئيسية', 'Home'] }
const TAB: Record<string, [string, string]> = { nav_opps: ['الفرص الآن', 'Now'], nav_team: ['فريق التحليل', 'Research team'], nav_pick: ['مقارنة الأسهم', 'Compare stocks'], nav_analysis: ['الخلاصة', 'Summary'], nav_tech: ['الرسم', 'Chart'], nav_research: ['الأخبار', 'News'], nav_sharia: ['الفحص الشرعي', 'Sharia'], nav_orders: ['الأوامر', 'Orders'], nav_plan: ['الخطة', 'Plan'], nav_invest: ['الأهداف', 'Goals'], nav_history: ['السجل', 'History'], nav_settings: ['عام', 'General'], nav_alerts: ['التنبيهات', 'Alerts'] }
const canLive = ref(false)
onMounted(async () => { try { const c = await api('connections'); canLive.value = c.prices && (c.assistant || c.rules) } catch { /* stays hidden */ } })
const active = (to: string) => route.path.replace(/\/$/, '') === to
watch(() => route.path, () => { open.value = false })
onMounted(async () => { try { const r = await fetch('/account/me'); if (r.ok && r.headers.get('content-type')?.includes('json')) me.value = await r.json(); else { const q = await fetch('/demo/status'); if (q.ok && q.headers.get('content-type')?.includes('json')) { const x = await q.json(); if (x.running) trial.value = x } } } catch { /* single-user mode */ } })
async function signOut() { try { await fetch(trial.value ? '/demo/end' : me.value ? '/account/logout' : '/api/auth/logout', { method: 'POST', headers: { 'X-Terminal-Client': '1' } }) } finally { location.href = me.value || trial.value ? '/' : '/login' } }
const item = 'flex items-center gap-3 rounded-full px-3.5 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground'
const night = 'flex min-h-11 items-center gap-3 rounded-full px-4 text-[0.9375rem] text-panel-muted transition-colors hover:bg-white/10 hover:text-white'
const group = computed(() => GROUPS.find((g) => g.pages.some(([to]) => active(to))))
const here = computed(() => group.value?.pages.find(([to]) => active(to)))
const ABOUT: Record<string, [string, string]> = { nav_opps: ['متى تشتري ومتى تبيع، ولماذا، وما الذي قد تخسره.', 'When to buy, when to sell, why, and what you could lose.'], nav_orders: ['اكتب أمرك، وراجعه قبل أن يُنفّذ ورقيًا.', 'Write an order and review it before it is placed on paper.'], nav_tech: ['ما يقوله الرسم، بخطوات ومستويات واضحة.', 'What the chart says, in clear steps and levels.'], nav_pick: ['أسهمك بقواعد كبار المستثمرين، مع ما تحقق وما لم يتحقق.', 'Your stocks under great investors’ rules: what is met and what is not.'], nav_plan: ['نسب لمحفظتك الورقية، وكيف تُبنى وتُوازن.', 'Percentages for your paper portfolio, and how it is built and balanced.'], nav_invest: ['أهدافك، والاستثمارات الورقية التي تتبعها.', 'Your goals, and the paper investments that follow them.'], nav_analysis: ['رأي المحللين والأرقام وراءه.', 'What the analysts say and the numbers behind it.'], nav_team: ['تقارير فريق التحليل الذي يعمل عبر مساعدك الذكي.', 'Reports of the research team that works through your AI assistant.'], nav_research: ['أخبار وبحوث مؤرخة ومسندة إلى مصادرها.', 'Dated news and research with its sources.'], nav_history: ['صفقاتك الورقية ونتائجها.', 'Your paper trades and their results.'], nav_sharia: ['نتيجة الفحص، للمعلومة فقط.', 'The screen result, for information only.'], nav_alerts: ['ما يصلك على تيليجرام، ومتى.', 'What reaches you on Telegram, and when.'], nav_settings: ['المحاكاة والمخاطر وطريقة العمل.', 'The simulation, its risk and how it runs.'] }
</script>

<template>
  <div class="product min-h-dvh lg:grid lg:grid-cols-[16rem_minmax(0,1fr)]">
    <aside class="hidden bg-[#0d0f26] text-white [--ring:#ffd32e] lg:sticky lg:top-0 lg:block lg:h-dvh">
      <div class="flex h-full flex-col overflow-y-auto p-4">
        <NuxtLink to="/app" data-slot="brand" class="mt-1 mb-7 flex items-center gap-3 px-2"><BrandMark /><span class="font-display text-xl font-bold text-white">{{ t('brand') }}</span></NuxtLink>
        <nav class="grid gap-1" :aria-label="L('الأقسام', 'Sections')"><NuxtLink v-for="g in GROUPS" :key="g.id" :to="g.pages[0]![0]" data-slot="nav" :class="[night, group?.id === g.id && '!bg-brand font-semibold !text-white']" :aria-current="group?.id === g.id ? (active(g.pages[0]![0]) ? 'page' : 'true') : undefined"><component :is="g.icon" class="size-5" aria-hidden="true" />{{ L(...g.name) }}</NuxtLink></nav>
        <div class="mt-auto grid gap-1 border-t border-white/15 pt-3"><NuxtLink v-if="me?.role === 'ADMIN'" to="/admin" data-slot="nav" :class="night"><Users class="size-5" aria-hidden="true" />{{ L('الحسابات', 'Accounts') }}</NuxtLink><button type="button" :class="night" @click="signOut"><LogOut class="size-5" aria-hidden="true" />{{ trial ? L('إنهاء التجربة', 'End the demo') : L('تسجيل الخروج', 'Sign out') }}</button></div>
      </div>
    </aside>
    <div class="min-w-0">
      <header class="sticky top-0 z-20 flex min-h-[4.5rem] items-center gap-2.5 border-b bg-card px-4 py-2 sm:gap-3 sm:px-6">
        <NuxtLink to="/app" data-slot="brand" class="flex items-center lg:hidden" :aria-label="t('brand')"><BrandMark /></NuxtLink>
        <UiBadge tone="warn" class="!px-3.5 !py-0.5 text-sm whitespace-nowrap">{{ t('paper') }}</UiBadge>
        <span class="small min-w-0 truncate max-sm:hidden" :class="stale ? 'down' : 'muted'" role="status"><i class="me-1.5 inline-block size-2 rounded-full" :class="stale ? 'bg-down' : 'bg-up live-dot'" />{{ stale ? t('offline') : t('live') }}<span v-if="lastAt" class="max-sm:hidden"> · {{ t('updated') }} <bdi dir="ltr">{{ Math.max(0, Math.round((now - lastAt) / 1000)) }}</bdi> {{ t('ago') }}</span></span>
        <span class="grow" /><NuxtLink v-if="market" to="/app#hours" data-slot="nav" class="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full bg-secondary px-3.5 text-sm text-secondary-foreground"><i class="size-2 shrink-0 rounded-full" :class="market.open ? 'bg-up' : market.phase === 'CLOSED' ? 'bg-down' : 'bg-sky'" aria-hidden="true" /><span class="max-md:hidden">{{ PHASE[market.phase] }}</span><span>{{ market.open ? L('يغلق بعد', 'closes in') : L('يفتح بعد', 'opens in') }}</span><b class="num">{{ count(market.left) }}</b></NuxtLink><ThemeLang class="max-lg:!hidden" /><button type="button" class="inline-flex size-11 shrink-0 items-center justify-center rounded-full hover:bg-accent lg:hidden" aria-controls="more" :aria-expanded="open" :aria-label="L('المزيد', 'More')" @click="open = !open"><Ellipsis class="size-5" aria-hidden="true" /></button>
      </header>
      <p v-if="demo" role="note" class="!m-0 flex flex-wrap items-center justify-center gap-x-2 bg-sun px-4 py-2 text-center text-sm font-semibold text-sun-foreground">{{ L('أسعار تجريبية غير حقيقية. لا تطابق السوق ولا تعتمد عليها.', 'Demo prices, not real. They do not match the market; do not rely on them.') }}<span v-if="trial">{{ L('تنتهي التجربة بعد', 'The demo ends in') }} <bdi class="num">{{ Math.max(0, Math.ceil((trial.endsAt - now) / 60000)) }}</bdi> {{ L('دقيقة', 'minutes') }} · <a href="/#join" class="!text-current underline">{{ L('اطلب دعوة', 'Ask for an invitation') }}</a></span><NuxtLink v-if="canLive" to="/app/settings" data-slot="nav" class="inline-flex min-h-8 items-center rounded-full bg-[#0a0b1a] px-4 text-white">{{ L('انتقل إلى الأسعار الحقيقية', 'Switch to real prices') }}</NuxtLink></p>
      <main class="mx-auto max-w-[110rem] p-4 pb-28 sm:p-6 sm:pb-28 lg:pb-8">
        <div v-if="here && here[0] !== '/app'" class="mb-5"><h1 class="text-2xl leading-snug sm:text-3xl">{{ t(here[1]) }}</h1><p class="muted !m-0">{{ L(...ABOUT[here[1]]!) }}</p>
          <nav v-if="group && group.pages.length > 1" class="mt-4 flex gap-2 overflow-x-auto pb-1" :aria-label="L(...group.name)"><NuxtLink v-for="[to, k] in group.pages" :key="to" :to="to" data-slot="nav" class="inline-flex min-h-11 shrink-0 items-center rounded-full border px-5 text-sm font-medium transition-colors" :class="active(to) ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'" :aria-current="active(to) ? 'page' : undefined">{{ TAB[k] ? L(...TAB[k]!) : t(k) }}</NuxtLink></nav></div>
        <slot />
      </main>
    </div>
    <div v-if="open" class="fixed inset-0 z-30 bg-black/40 lg:hidden" @click="open = false" />
    <div v-show="open" id="more" class="sheet fixed inset-x-0 bottom-0 z-40 rounded-t-3xl border-t bg-card p-4 pb-24 lg:hidden">
      <NuxtLink v-if="me?.role === 'ADMIN'" to="/admin" data-slot="nav" :class="[item, 'min-h-12 !text-base']"><Users class="size-5" aria-hidden="true" />{{ L('الحسابات', 'Accounts') }}</NuxtLink>
      <button type="button" :class="[item, 'min-h-12 w-full !text-base']" @click="signOut"><LogOut class="size-5" aria-hidden="true" />{{ trial ? L('إنهاء التجربة', 'End the demo') : L('تسجيل الخروج', 'Sign out') }}</button>
      <div class="mt-3 border-t pt-3"><ThemeLang full /></div>
    </div>
    <ChatHelper />
    <nav class="fixed inset-x-0 bottom-0 z-50 grid grid-cols-5 bg-[#0d0f26] [--ring:#ffd32e] pb-[env(safe-area-inset-bottom)] lg:hidden" :aria-label="L('الأقسام', 'Sections')" @keydown.esc="open = false">
      <NuxtLink v-for="g in GROUPS" :key="g.id" :to="g.pages[0]![0]" data-slot="nav" class="flex min-h-16 flex-col items-center justify-center gap-1 text-xs" :class="group?.id === g.id && !open ? 'font-semibold text-sun' : 'text-panel-muted'" :aria-current="group?.id === g.id ? (active(g.pages[0]![0]) ? 'page' : 'true') : undefined"><component :is="g.icon" class="size-5" aria-hidden="true" />{{ L(...SHORT[g.id]!) }}</NuxtLink>
    </nav>
  </div>
</template>
