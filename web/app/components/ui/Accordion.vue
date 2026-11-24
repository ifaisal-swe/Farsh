<script setup lang="ts">
import { AccordionHeader, AccordionItem, AccordionPanel, AccordionRoot, AccordionTrigger } from 'base-ui-vue'
import { ChevronDown } from '@lucide/vue'
defineProps<{ items: { q: string, a: string }[] }>()
</script>

<template>
  <AccordionRoot data-slot="accordion" class="border-t">
    <AccordionItem v-for="(x, i) in items" :key="i" :value="i" class="border-b">
      <AccordionHeader class="m-0"><AccordionTrigger class="group flex w-full items-center justify-between gap-4 py-4 text-start text-base font-medium">{{ x.q }}<ChevronDown class="size-4 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-180" aria-hidden="true" /></AccordionTrigger></AccordionHeader>
      <AccordionPanel class="acc text-muted-foreground"><div class="pb-4">{{ x.a }}</div></AccordionPanel>
    </AccordionItem>
  </AccordionRoot>
</template>
