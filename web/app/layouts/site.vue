<script setup lang="ts">
import { Menu, X } from '@lucide/vue'
import { buttonVariants } from '~/lib/button'
const { t, lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const route = useRoute()
const home = computed(() => route.path === '/')
const full = computed(() => home.value || /^\/(brand|demo)\/?$/.test(route.path))
const menu = ref(false)
watch(() => route.fullPath, () => { menu.value = false })
const LINKS = computed(() => [['#products', L('المنتجات', 'Products')], ['#how', L('كيف تعمل', 'How it works')], ['#tools', L('الأدوات', 'Tools')], ['#sharia', L('الفحص الشرعي', 'Sharia screen')], ['#faq', L('أسئلة شائعة', 'Questions')]] as [string, string][])
const COLS = computed(() => [
  [L('المنتجات', 'Products'), [['#products', L('الأسهم والعملات الرقمية', 'Stocks and crypto')], ['#tools', L('أدوات التحليل', 'Analysis tools')], ['#features', L('الأمان والخصوصية', 'Security and privacy')]]],
  [L('عن فرصة', 'About Forsah'), [['#how', L('كيف تعمل', 'How it works')], ['#sharia', L('الفحص الشرعي', 'Sharia screen')], ['#faq', L('أسئلة شائعة', 'Questions')], ['/brand', L('هوية العلامة', 'Brand kit')]]],
  [L('حسابك', 'Your account'), [['/demo', L('جرّب بلا حساب', 'Try without an account')], ['#join', L('اطلب دعوة', 'Ask for an invitation')], ['/invite', L('أنشئ حسابك', 'Create your account')], ['/login', L('تسجيل الدخول', 'Sign in')]]],
] as [string, [string, string][]][])
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <div class="bg-brand text-white"><p class="mx-auto max-w-7xl px-4 py-2 text-center text-sm">{{ L('تداول ورقي (محاكاة) فقط. التسجيل بالدعوة.', 'Paper trading (simulation) only. By invitation.') }} <a v-if="home" href="#join" class="font-semibold underline underline-offset-4">{{ L('اطلب دعوة', 'Ask for an invitation') }}</a></p></div>
    <header class="sticky top-0 z-30 border-b bg-card" @keydown.esc="menu = false">
      <div class="mx-auto flex min-h-[4.5rem] max-w-7xl items-center gap-x-2 px-4 sm:gap-x-3 sm:px-6">
        <NuxtLink to="/" class="flex items-center gap-2.5"><BrandMark /><span class="font-display text-xl font-bold max-[400px]:sr-only">{{ t('brand') }}</span></NuxtLink>
        <nav v-if="home" class="ms-4 hidden gap-5 text-[0.9375rem] font-medium lg:flex xl:ms-6 xl:gap-6" :aria-label="L('أقسام الصفحة', 'Page sections')"><a v-for="[h, n] in LINKS" :key="h" :href="h" class="whitespace-nowrap hover:text-primary">{{ n }}</a></nav>
        <span class="grow" /><ThemeLang />
        <template v-if="home">
          <NuxtLink to="/login" class="hidden h-10 items-center rounded-full bg-foreground px-5 text-sm font-semibold whitespace-nowrap text-background transition-opacity hover:opacity-85 sm:inline-flex">{{ L('تسجيل الدخول', 'Sign in') }}</NuxtLink>
          <a href="#join" :class="buttonVariants({ variant: 'default' })" class="!font-semibold sm:!px-5">{{ L('اطلب دعوة', 'Get invited') }}</a>
          <button type="button" class="inline-flex size-10 items-center justify-center rounded-full hover:bg-accent lg:hidden" :aria-expanded="menu" aria-controls="site-menu" :aria-label="menu ? L('أغلق القائمة', 'Close menu') : L('افتح القائمة', 'Open menu')" @click="menu = !menu"><component :is="menu ? X : Menu" class="size-5" /></button>
        </template>
      </div>
      <nav v-if="home && menu" id="site-menu" class="grid border-t px-4 py-3 text-lg font-medium lg:hidden" :aria-label="L('أقسام الصفحة', 'Page sections')"><a v-for="[h, n] in LINKS" :key="h" :href="h" class="py-2.5" @click="menu = false">{{ n }}</a><NuxtLink to="/login" class="py-2.5 text-primary sm:hidden">{{ L('تسجيل الدخول', 'Sign in') }}</NuxtLink></nav>
    </header>
    <main class="flex-1"><slot /></main>
    <footer :class="full ? 'bg-[#0d0f26] text-panel-foreground [--ring:#ffd32e]' : 'border-t'">
      <div v-if="full" class="mx-auto max-w-7xl px-4 pt-16 sm:px-6 sm:pt-20">
        <div class="grid gap-10 border-b border-white/15 pb-12 sm:grid-cols-3 lg:grid-cols-[1.6fr_repeat(3,1fr)]">
          <div class="sm:col-span-3 lg:col-span-1"><img :src="`/brand/forsah-${lang}-white.svg`" :alt="t('brand')" width="136" height="40" class="h-10 w-auto"><p class="mt-5 max-w-[40ch] text-sm text-panel-muted">{{ L('منصة عربية للتداول الورقي الآلي للأسهم الأمريكية والعملات الرقمية بضوابط شرعية.', 'An Arabic-first platform for automated paper trading of US stocks and crypto under Sharia rules.') }}</p></div>
          <nav v-for="[title, items] in COLS" :key="title" :aria-label="title"><h3 class="text-base">{{ title }}</h3><ul class="mt-4 grid gap-2.5 text-sm text-panel-muted"><li v-for="[h, n] in items" :key="n"><a v-if="home && h.startsWith('#')" :href="h" class="hover:text-white">{{ n }}</a><NuxtLink v-else :to="h.startsWith('#') ? `/${h}` : h" class="hover:text-white">{{ n }}</NuxtLink></li></ul></nav>
        </div>
      </div>
      <div class="mx-auto flex max-w-7xl flex-wrap justify-between gap-x-10 gap-y-3 px-4 py-10 text-sm sm:px-6" :class="full ? 'text-panel-muted' : 'text-muted-foreground'">
        <p class="max-w-[80ch]">{{ L('تداول ورقي (محاكاة) فقط، ولا تُرسل أي أوامر حقيقية إلى وسيط. لا تقدم المنصة نصيحة استثمارية. الفحص الشرعي فحص آلي أولي وليس فتوى.', 'Paper trading (simulation) only. No real orders are sent to any broker. The platform gives no investment advice. The Sharia screen is an automated pre-screen, not a fatwa.') }}</p><p><bdi>© 2026</bdi> {{ t('brand') }}</p>
      </div>
    </footer>
  </div>
</template>
