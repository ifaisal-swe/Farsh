<script setup lang="ts">
import { cn } from '~/lib/utils'
defineOptions({ inheritAttrs: false })
const TONE: Record<string, string> = { PASS: 'border-up/40 text-up', FAIL: 'border-down/40 text-down', UNKNOWN: 'border-warn/40 text-warn', warn: 'border-brass/40 bg-brass-soft text-brass' }
defineProps<{ tone?: string }>()
</script>

<template>
  <span data-slot="badge" v-bind="$attrs" :class="cn('inline-flex items-center rounded-full border px-2.5 text-xs font-semibold leading-6', tone ? TONE[tone] : 'text-muted-foreground', $attrs.class as string)"><slot /></span>
</template>
