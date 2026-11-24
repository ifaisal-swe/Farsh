<script setup lang="ts">
import { DirectionProvider } from 'base-ui-vue'
const { lang } = useLang()
useTheme()
const dir = computed<'rtl' | 'ltr'>(() => (lang.value === 'ar' ? 'rtl' : 'ltr'))
// Nuxt owns the <html> attributes: set them through it, or its defaults come back after a reload
useHead({ htmlAttrs: { lang, dir } })
const route = useRoute()
const layout = computed(() => (/^\/app(\/|$)/.test(route.path) ? 'product' : 'site'))
</script>

<template>
  <DirectionProvider :direction="dir"><NuxtLayout :name="layout"><NuxtPage :transition="{ name: 'page', mode: 'out-in' }" /></NuxtLayout></DirectionProvider>
</template>
