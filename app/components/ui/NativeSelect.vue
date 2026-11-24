<script setup lang="ts">
import { ChevronDown } from '@lucide/vue'
import { cn } from '~/lib/utils'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue?: string | number }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
const control = computed(() => (props.modelValue === undefined ? {} : { value: props.modelValue }))
</script>

<template>
  <span class="relative inline-flex max-w-full">
    <select data-slot="native-select" v-bind="{ ...$attrs, ...control }" :class="cn('h-10 max-w-full appearance-none rounded-md border border-input bg-card ps-3 pe-9 text-sm disabled:opacity-50', $attrs.class as string)" @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"><slot /></select>
    <ChevronDown class="pointer-events-none absolute end-2.5 top-3 size-4 text-muted-foreground" aria-hidden="true" />
  </span>
</template>
