<script setup lang="ts">
import { cn } from '~/lib/utils'
defineOptions({ inheritAttrs: false })
</script>

<template>
  <section data-slot="card" v-bind="$attrs" :class="cn('mb-4 min-w-0 rounded-3xl border bg-card p-5 text-card-foreground sm:p-7', $attrs.class as string)"><slot /></section>
</template>
