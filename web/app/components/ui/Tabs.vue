<script setup lang="ts">
import { TabsList, TabsPanel, TabsRoot, TabsTab } from 'base-ui-vue'
defineProps<{ modelValue: string, tabs: { value: string, label: string }[] }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()
</script>

<template>
  <TabsRoot data-slot="tabs" :value="modelValue" @value-change="(v: any) => emit('update:modelValue', String(v))">
    <TabsList class="inline-flex flex-wrap gap-1 rounded-full bg-muted p-1"><TabsTab v-for="x in tabs" :key="x.value" :value="x.value" class="rounded-full px-2.5 py-1.5 text-[0.8rem] sm:px-3 sm:text-sm text-muted-foreground transition-colors data-[active]:bg-card data-[active]:text-foreground data-[active]:shadow-sm">{{ x.label }}</TabsTab></TabsList>
    <TabsPanel v-for="x in tabs" :key="x.value" :value="x.value" class="mt-4"><slot :name="x.value" /></TabsPanel>
  </TabsRoot>
</template>
