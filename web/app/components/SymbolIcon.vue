<script setup lang="ts">
// the asset's logo on a white disc; a symbol without one shows its first letter
import { LOGOS } from '~/lib/logos'
const props = defineProps<{ symbol?: string }>()
const base = computed(() => String(props.symbol || '').split('/')[0]!.toUpperCase())
</script>

<template>
  <span class="inline-flex size-9 shrink-0 items-center justify-center rounded-full" :class="LOGOS[base] ? 'border bg-white' : 'bg-secondary font-display font-semibold text-secondary-foreground'" aria-hidden="true"><AssetIcon v-if="LOGOS[base]" :symbol="base" /><template v-else>{{ base[0] || '?' }}</template></span>
</template>
