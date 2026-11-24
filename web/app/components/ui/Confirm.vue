<script setup lang="ts">
// the browser's own modal dialog: focus is trapped, Escape closes it, and the page behind is inert
const props = defineProps<{ open: boolean, title: string, text?: string, confirm: string, cancel: string, busy?: boolean }>()
const emit = defineEmits<{ confirm: [], close: [] }>()
const el = ref<HTMLDialogElement | null>(null)
watch(() => props.open, (o) => { if (o) el.value?.showModal(); else el.value?.close() })
</script>

<template>
  <dialog ref="el" data-slot="dialog" class="m-auto w-[min(420px,calc(100vw-32px))] rounded-xl border bg-card p-6 text-card-foreground shadow-xl backdrop:bg-black/50" @close="emit('close')">
    <h2 class="text-lg">{{ title }}</h2><p v-if="text" class="mt-1 text-muted-foreground">{{ text }}</p>
    <div class="mt-5 flex justify-end gap-2"><UiButton @click="emit('close')">{{ cancel }}</UiButton><UiButton variant="destructive" :disabled="busy" @click="emit('confirm')">{{ confirm }}</UiButton></div>
  </dialog>
</template>
