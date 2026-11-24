<script setup lang="ts">
// counts to its number once, when first seen; readers of the page text always get the final value
const props = defineProps<{ value: string }>()
const el = ref<HTMLElement | null>(null)
const m = /^(\d+)(.*)$/.exec(props.value)
const shown = ref(props.value)
let io: IntersectionObserver | null = null
onMounted(() => {
  if (!m || props.value.includes('/') || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  shown.value = `0${m[2]}`
  io = new IntersectionObserver(([e]) => {
    if (!e?.isIntersecting) return
    io!.disconnect()
    const t0 = performance.now()
    const step = (t: number) => { const k = Math.min(1, (t - t0) / 1100); shown.value = `${Math.round(Number(m[1]) * (1 - (1 - k) ** 3))}${m[2]}`; if (k < 1) requestAnimationFrame(step) }
    requestAnimationFrame(step)
  }, { threshold: 0.4 })
  io.observe(el.value!)
})
onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <span ref="el"><span class="sr-only">{{ value }}</span><span aria-hidden="true">{{ shown }}</span></span>
</template>
