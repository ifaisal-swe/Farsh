<script setup lang="ts">
// an illustrative candle chart: fixed shapes, not market prices
defineProps<{ levels?: boolean }>()
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const MOVES = [9, -6, 12, 7, -10, -8, 5, 14, 10, -7, 8, -12, -6, 9, 15, 7, -9, 11, 8, -5, 13, 6, -8, 10, 12]
let at = 186
const CANDLES = MOVES.map((m, i) => { const open = at; at -= m * 1.4; return { x: 22 + i * 21, up: m > 0, top: Math.min(open, at), h: Math.abs(open - at), hi: Math.min(open, at) - 4 - (i * 7) % 6, lo: Math.max(open, at) + 4 + (i * 5) % 7 } })
const LEVELS = computed(() => [[26, L('الهدف', 'Target'), 'var(--up)'], [122, L('الدخول', 'Entry'), 'var(--primary)'], [172, L('الوقف', 'Stop'), 'var(--down)']] as [number, string, string][])
</script>

<template>
  <svg viewBox="0 0 640 250" class="w-full" dir="ltr" role="img" :aria-label="L('رسم شموع توضيحي', 'Illustrative candle chart')">
    <g stroke="currentColor" opacity="0.1"><path v-for="y in [40, 90, 140, 190, 240]" :key="y" :d="`M0 ${y}H560`" /></g>
    <g v-for="(c, i) in CANDLES" :key="i" :fill="c.up ? 'var(--c-up, var(--up))' : 'var(--c-down, var(--down))'"><rect :x="c.x - 0.75" :y="c.hi" width="1.5" :height="c.lo - c.hi" /><rect :x="c.x - 5" :y="c.top" width="10" :height="c.h" rx="2" /></g>
    <g v-if="levels" font-size="15" font-weight="600"><g v-for="[y, name, c] in LEVELS" :key="y"><path :d="`M0 ${y}H568`" :stroke="c" stroke-width="1.5" stroke-dasharray="5 5" /><text x="604" :y="y + 5" text-anchor="middle" :fill="c">{{ name }}</text></g></g>
  </svg>
</template>
