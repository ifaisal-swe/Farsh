<script setup lang="ts">
import { Languages, Monitor, Moon, Sun } from '@lucide/vue'
import { ToggleGroup, Toggle } from 'base-ui-vue'
const { theme, dark } = useTheme()
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const opts = computed(() => [{ v: 'light', i: Sun, t: L('فاتح', 'Light') }, { v: 'dark', i: Moon, t: L('داكن', 'Dark') }, { v: 'system', i: Monitor, t: L('حسب الجهاز', 'Device setting') }])
defineProps<{ full?: boolean }>()
</script>

<template>
  <div class="flex items-center gap-1 sm:gap-2">
    <ToggleGroup :value="[theme]" :aria-label="L('المظهر', 'Theme')" :class="full ? 'inline-flex' : 'hidden sm:inline-flex'" class="rounded-full border bg-card p-0.5" @value-change="(v: any[]) => { if (v[0]) theme = v[0] }">
      <Toggle v-for="o in opts" :key="o.v" :value="o.v" :aria-label="o.t" :title="o.t" class="inline-flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground data-[pressed]:bg-accent data-[pressed]:text-foreground" :class="full ? 'size-10' : 'size-8'"><component :is="o.i" class="size-4" /></Toggle>
    </ToggleGroup>
    <UiButton v-if="!full" class="sm:hidden" size="icon" variant="ghost" :aria-label="dark ? L('المظهر الفاتح', 'Light theme') : L('المظهر الداكن', 'Dark theme')" @click="theme = dark ? 'light' : 'dark'"><Sun v-if="dark" /><Moon v-else /></UiButton>
    <UiButton variant="ghost" :class="!full && 'max-sm:!px-2.5'" @click="lang = lang === 'ar' ? 'en' : 'ar'"><Languages class="max-sm:hidden" />{{ lang === 'ar' ? 'EN' : 'ع' }}<span class="sr-only">{{ lang === 'ar' ? 'English' : 'العربية' }}</span></UiButton>
  </div>
</template>
