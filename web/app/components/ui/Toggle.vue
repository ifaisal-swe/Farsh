<script setup lang="ts">
import { Toggle } from 'base-ui-vue'
import { cn } from '~/lib/utils'
defineOptions({ inheritAttrs: false })
defineProps<{ modelValue?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()
</script>

<template>
  <Toggle data-slot="toggle" v-bind="$attrs" :pressed="!!modelValue" :class="cn('inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[0.8125rem] text-muted-foreground transition-colors hover:bg-accent data-[pressed]:border-input data-[pressed]:bg-accent data-[pressed]:text-foreground', $attrs.class as string)" @pressed-change="(v: boolean) => emit('update:modelValue', v)"><slot /></Toggle>
</template>
