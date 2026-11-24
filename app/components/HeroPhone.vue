<script setup lang="ts">
import { Ban, Bell, CircleCheck, CircleHelp, ShieldCheck } from '@lucide/vue'
const props = defineProps<{ cases: Record<string, { rows: [string, string, string][], result: string }>, tabs: { value: string, label: string }[] }>()
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const demo = ref('pass')
const ICON: Record<string, any> = { ok: CircleCheck, bad: Ban, unknown: CircleHelp, skip: CircleHelp }
const TONE: Record<string, string> = { ok: 'text-up', bad: 'text-down', unknown: 'text-warn', skip: 'text-muted-foreground' }
// plays through the three examples once, then rests; any touch takes over
let timer: any
const stop = () => clearInterval(timer)
onMounted(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
  let left = props.tabs.length
  timer = setInterval(() => { const i = props.tabs.findIndex((x) => x.value === demo.value); demo.value = props.tabs[(i + 1) % props.tabs.length]!.value; if (--left <= 0) stop() }, 4200)
})
onBeforeUnmount(stop)
</script>

<template>
  <div class="relative mx-auto w-full max-w-[25rem]" @pointerdown="stop" @pointerenter="stop" @focusin="stop">
    <div class="phone rounded-[2.75rem] border-[7px] border-white/90 bg-card p-5 pt-4 text-card-foreground shadow-[0_40px_90px_-25px_rgb(10_11_26/0.65)]">
      <div class="mx-auto mb-4 h-5 w-24 rounded-full bg-muted" aria-hidden="true" />
      <div class="mb-3 flex items-center justify-between gap-2"><p class="font-display text-lg font-semibold">{{ L('مسار أمر شراء', 'The path of a buy order') }}</p><UiBadge tone="warn">{{ L('مثال', 'Example') }}</UiBadge></div>
      <svg viewBox="0 0 320 84" class="mb-3 w-full" aria-hidden="true"><path class="draw-area" d="M0 70C26 66 38 48 62 52S104 74 128 58 168 22 196 34 232 52 256 30 296 10 320 14V84H0Z" /><path class="draw" pathLength="1" d="M0 70C26 66 38 48 62 52S104 74 128 58 168 22 196 34 232 52 256 30 296 10 320 14" /></svg>
      <UiTabs v-model="demo" :tabs="tabs">
        <template v-for="(x, k) in cases" :key="k" #[k]>
          <ul class="text-start"><li v-for="([name, value, state], i) in x.rows" :key="name" class="tick flex items-center gap-2.5 border-b py-2.5" :style="{ '--i': i }" :class="state === 'skip' && 'opacity-60'"><component :is="ICON[state]" class="size-5 shrink-0" :class="TONE[state]" aria-hidden="true" /><span class="min-w-0 flex-1 text-sm">{{ name }}</span><span class="text-sm font-medium tabular-nums"><bdi dir="auto">{{ value }}</bdi></span></li></ul>
          <p class="tick mt-4 min-h-16 rounded-2xl px-4 py-3 text-start text-sm font-medium" :style="{ '--i': 5 }" :class="k === 'pass' ? 'bg-secondary text-secondary-foreground' : 'bg-brass-soft text-brass'">{{ x.result }}</p>
        </template>
      </UiTabs>
    </div>
    <div class="pop absolute -top-7 -start-20 hidden items-center gap-3 rounded-2xl bg-card px-4 py-3 text-card-foreground shadow-xl xl:flex" style="--x: 4rem; --y: 3.5rem; --d: 700ms" aria-hidden="true"><ShieldCheck class="size-6 text-up" /><span class="text-sm font-semibold">{{ L('اجتاز الفحص الشرعي', 'Passed the Sharia screen') }}</span></div>
    <div class="pop absolute top-[24%] -end-24 hidden items-center gap-3 rounded-2xl bg-card px-4 py-3 text-card-foreground shadow-xl xl:flex" style="--x: -80px; --y: 0px; --d: 900ms" aria-hidden="true"><Bell class="size-6 text-primary" /><span class="text-sm font-semibold">{{ L('وصلك تنبيه', 'New alert') }}</span></div>
    <div class="pop absolute -bottom-6 -start-16 hidden rounded-2xl bg-sun px-5 py-3 text-sun-foreground shadow-xl xl:block" style="--x: 60px; --y: -50px; --d: 1100ms" aria-hidden="true"><span class="text-sm font-semibold">{{ L('المخاطرة', 'Risk') }} <bdi dir="ltr">0.5%</bdi></span></div>
  </div>
</template>
