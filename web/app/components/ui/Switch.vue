<script setup lang="ts">
import { SwitchRoot, SwitchThumb } from 'base-ui-vue'
defineOptions({ inheritAttrs: false })
defineProps<{ modelValue?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [v: boolean] }>()
</script>

<template>
  <SwitchRoot data-slot="switch" v-bind="$attrs" :checked="!!modelValue" class="inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-input p-px transition-colors data-[checked]:bg-primary data-[disabled]:opacity-50" @checked-change="(v: boolean) => emit('update:modelValue', v)">
    <SwitchThumb class="block size-4 rounded-full bg-white shadow-sm transition-transform data-[checked]:translate-x-4 rtl:data-[checked]:-translate-x-4" />
  </SwitchRoot>
</template>
