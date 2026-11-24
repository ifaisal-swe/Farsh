<script setup lang="ts">
import { plain } from '~/lib/plain'
const props = defineProps<{ url: string, done: string, title: string, note?: string, submit: string, fields: { name: string, label: string, type?: string, ac: string, optional?: boolean, min?: number }[] }>()
const { lang } = useLang()
const v = reactive<Record<string, string>>({})
const error = ref('')
const busy = ref(false)
onMounted(() => {
  // the code travels in the fragment, which browsers never send to a server or write to its logs
  if (props.fields.some((f) => f.name === 'token') && location.hash.length > 1) { v.token = location.hash.slice(1); history.replaceState(history.state, '', location.pathname) }
})
async function send() {
  busy.value = true
  error.value = ''
  try {
    const r = await fetch(props.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify(v) })
    const d = await r.json()
    if (!r.ok) throw new Error(d.error)
    location.href = props.done
  } catch (e: any) { error.value = plain.error(e.message, lang.value === 'ar') } finally { busy.value = false }
}
</script>

<template>
  <div class="mx-auto w-full max-w-md px-4 py-14">
    <form class="rise rounded-3xl border bg-card p-6 sm:p-8" @submit.prevent="send">
      <h1 class="text-2xl">{{ title }}</h1><p v-if="note" class="mt-1 text-sm text-muted-foreground">{{ note }}</p>
      <div class="mt-6 grid gap-4"><label v-for="f in fields" :key="f.name" class="grid gap-1.5 text-sm font-medium" :for="`f-${f.name}`">{{ f.label }}<UiInput :id="`f-${f.name}`" :model-value="v[f.name] || ''" :name="f.name" :type="f.type || 'text'" :autocomplete="f.ac" :minlength="f.min" :required="!f.optional" dir="ltr" class="h-10 w-full font-normal" @update:model-value="v[f.name] = $event" /></label></div>
      <p v-if="error" role="alert" class="mt-4 text-sm text-destructive">{{ error }}</p>
      <UiButton type="submit" variant="default" size="lg" class="mt-6 w-full" :disabled="busy">{{ submit }}</UiButton>
      <div class="mt-4 text-center text-sm text-muted-foreground"><slot /></div>
    </form>
  </div>
</template>
