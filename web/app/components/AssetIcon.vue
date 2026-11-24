<script setup lang="ts">
import { LOGOS } from '~/lib/logos'
defineProps<{ symbol: string }>()
</script>

<template>
  <svg v-if="LOGOS[symbol]" viewBox="0 0 24 24" class="size-5 shrink-0" aria-hidden="true"><path :d="LOGOS[symbol]!.d" :fill="LOGOS[symbol]!.c" /></svg>
</template>
