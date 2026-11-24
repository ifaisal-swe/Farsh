<script setup lang="ts">
// the brand's dot field, fainter at the top; sits behind night sections
const id = useId()
</script>

<template>
  <svg class="pointer-events-none absolute inset-0 size-full" aria-hidden="true"><defs><pattern :id="`${id}p`" width="40" height="40" patternUnits="userSpaceOnUse"><circle cx="20" cy="20" r="3.5" fill="#fff" /></pattern><linearGradient :id="`${id}g`" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.02" /><stop offset="1" stop-color="#fff" stop-opacity="0.2" /></linearGradient><mask :id="`${id}m`"><rect width="100%" height="100%" :fill="`url(#${id}g)`" /></mask></defs><rect width="100%" height="100%" :fill="`url(#${id}p)`" :mask="`url(#${id}m)`" /></svg>
</template>
