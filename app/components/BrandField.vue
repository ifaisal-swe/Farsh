<script setup lang="ts">
// the brand's dot field: round dots from the ف, brighter near the light; fixed pattern, so it never shifts between loads
const rnd = (x: number, y: number) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v) }
const DOTS = Array.from({ length: 20 * 36 }, (_, i) => ({ x: i % 36, y: Math.floor(i / 36) })).map((d) => ({ ...d, q: rnd(d.x, d.y) })).filter((d) => d.q > 0.45).map((d) => ({ cx: d.x * 40 + 20, cy: d.y * 40 + 20, o: +(Math.max(0.04, 0.32 * (1 - d.y / 15)) * d.q).toFixed(2) }))
</script>

<template>
  <div class="dawn pointer-events-none absolute inset-0" aria-hidden="true"><svg class="absolute inset-0 size-full" viewBox="0 0 1440 800" preserveAspectRatio="xMidYMin slice" fill="#fff"><circle v-for="(d, i) in DOTS" :key="i" :cx="d.cx" :cy="d.cy" r="6.5" :opacity="d.o" /></svg></div>
</template>
