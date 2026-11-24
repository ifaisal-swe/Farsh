<script setup lang="ts">
import { buttonVariants } from '~/lib/button'
const { t, lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const route = useRoute()
const LINKS = computed(() => [['#how', L('كيف تعمل', 'How it works')], ['#sharia', L('الفحص الشرعي', 'Sharia screen')], ['#security', L('الأمان', 'Security')], ['#faq', L('أسئلة شائعة', 'Questions')]])
</script>

<template>
  <div class="flex min-h-dvh flex-col">
    <div class="bg-sun text-sun-foreground"><p class="mx-auto flex max-w-6xl items-center justify-center gap-2 font-medium px-4 py-2 text-sm sm:px-6"><i class="inline-block size-2 shrink-0 rounded-full bg-sun-foreground" />{{ L('تداول ورقي (محاكاة) فقط. التسجيل بالدعوة.', 'Paper trading (simulation) only. By invitation.') }}</p></div>
    <header class="sticky top-0 z-30 px-3 py-3 sm:px-5"><div class="mx-auto max-w-6xl border bg-card/95 shadow-[0_8px_30px_-12px_rgb(10_11_26/0.18)] backdrop-blur rounded-full">
      <div class="mx-auto flex min-h-14 items-center gap-x-2 px-3 py-2 sm:gap-x-6 sm:px-4">
        <NuxtLink to="/" class="flex items-center gap-3"><BrandMark /><span class="text-lg font-semibold max-[380px]:sr-only">{{ t('brand') }}</span></NuxtLink>
        <nav v-if="route.path === '/'" class="hidden gap-5 text-sm text-muted-foreground lg:flex"><a v-for="[h, n] in LINKS" :key="h" :href="h" class="hover:text-foreground">{{ n }}</a></nav>
        <span class="grow" /><ThemeLang />
        <NuxtLink v-if="route.path === '/'" to="/login" :class="buttonVariants({ variant: 'default', size: 'sm' })" class="!rounded-full">{{ L('تسجيل الدخول', 'Sign in') }}</NuxtLink>
      </div>
    </div></header>
    <main class="flex-1"><slot /></main>
    <footer class="border-t bg-background">
      <div class="mx-auto grid max-w-6xl gap-3 px-4 py-10 text-sm text-muted-foreground sm:px-6 md:grid-cols-[auto_1fr] md:gap-10">
        <div class="flex items-center gap-3"><BrandMark /><span class="font-semibold text-foreground">{{ t('brand') }}</span></div>
        <p class="max-w-[70ch]">{{ L('تداول ورقي (محاكاة) فقط، ولا تُرسل أي أوامر حقيقية إلى وسيط. لا تقدم المنصة نصيحة استثمارية. الفحص الشرعي فحص آلي أولي وليس فتوى.', 'Paper trading (simulation) only. No real orders are sent to any broker. The platform gives no investment advice. The Sharia screen is an automated pre-screen, not a fatwa.') }}</p>
      </div>
    </footer>
  </div>
</template>
