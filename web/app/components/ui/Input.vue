<script setup lang="ts">
import { Input } from 'base-ui-vue'
import { cn } from '~/lib/utils'
defineOptions({ inheritAttrs: false })
const props = defineProps<{ modelValue?: string | number | null }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
// controlled only when v-model is used; otherwise the plain value attribute passes through
const control = computed(() => (props.modelValue === undefined ? {} : { value: String(props.modelValue ?? '') }))
</script>

<template>
  <Input data-slot="input" v-bind="{ ...$attrs, ...control }" :class="cn('h-10 min-w-0 max-w-full rounded-full border border-input bg-card px-4 text-sm placeholder:text-muted-foreground disabled:opacity-50', $attrs.class as string)" @value-change="(v: string) => emit('update:modelValue', v)" />
</template>
