<script setup lang="ts">
// a small line of real values; decorative, the numbers stand next to it
const props = defineProps<{ points: number[], area?: boolean }>()
const W = 200
const H = 60
const path = computed(() => {
  const p = props.points.filter((x) => Number.isFinite(x))
  if (p.length < 2) return ''
  const lo = Math.min(...p)
  const span = Math.max(...p) - lo
  return p.map((v, i) => `${i ? 'L' : 'M'}${(i / (p.length - 1) * W).toFixed(1)} ${(span ? H - 4 - (v - lo) / span * (H - 8) : H / 2).toFixed(1)}`).join('')
})
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" dir="ltr" aria-hidden="true"><path v-if="area && path" :d="`${path}L${W} ${H}L0 ${H}Z`" fill="currentColor" opacity="0.16" /><path v-if="path" :d="path" fill="none" stroke="currentColor" stroke-width="2.5" vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round" /></svg>
</template>
