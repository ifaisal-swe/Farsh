<script setup lang="ts">
// the four steps light up in order once, when first seen; a pointer or a replay of the section is not needed to read them
defineProps<{ steps: string[][] }>()
const el = ref<HTMLElement | null>(null)
const at = ref(3)
const timers: any[] = []
let io: IntersectionObserver | null = null
onMounted(() => {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)) return
  at.value = -1
  io = new IntersectionObserver(([e]) => { if (!e?.isIntersecting) return; io!.disconnect(); [0, 1, 2, 3].forEach((i) => timers.push(setTimeout(() => { at.value = i }, 250 + i * 1000))) }, { threshold: 0.35 })
  io.observe(el.value!)
})
onBeforeUnmount(() => { io?.disconnect(); timers.forEach(clearTimeout) })
</script>

<template>
  <ol ref="el" class="grid gap-x-6 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
    <li v-for="([name, text], i) in steps" :key="i"><div class="flex items-center gap-4"><span class="step num inline-flex size-14 shrink-0 items-center justify-center rounded-full font-display text-2xl font-bold" :class="[at >= i ? (i === 3 ? 'bg-sun text-sun-foreground' : 'bg-brand text-white') : 'bg-secondary text-secondary-foreground', at === i && 'now']">{{ i + 1 }}</span><span v-if="i < 3" class="relative hidden h-4 flex-1 lg:block" aria-hidden="true"><i class="track absolute inset-x-0 top-1 text-input/50" /><i class="track run absolute inset-x-0 top-1 text-primary" :class="{ on: at > i }" /><i class="ball absolute top-0 size-4 rounded-full bg-sun" :class="{ go: at === i + 1 }" /></span></div><h3 class="mt-5 text-2xl">{{ name }}</h3><p class="mt-1.5 text-muted-foreground">{{ text }}</p></li>
  </ol>
</template>

<style scoped>
.step { transition: background-color 0.4s, color 0.4s; }
.now { animation: hop 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
@keyframes hop { 40% { transform: scale(1.25); } }
.run { clip-path: inset(0 100% 0 0); transition: clip-path 0.8s ease-in-out; }
[dir="rtl"] .run { clip-path: inset(0 0 0 100%); }
[dir] .run.on { clip-path: inset(0); }
.ball { inset-inline-start: 0; opacity: 0; }
.ball.go { animation: roll 0.8s ease-in-out; }
@keyframes roll { 0% { inset-inline-start: 0; opacity: 1; } 90% { opacity: 1; } 100% { inset-inline-start: calc(100% - 1rem); opacity: 0; } }
</style>
