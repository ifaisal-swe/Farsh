<script setup lang="ts">
// answers about the person's own wallet, calls and saving; it reads and never acts
import { MessageCircle, SendHorizontal, Trash2, X } from '@lucide/vue'
const { lang, num } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const open = ref(false)
const d = ref<any>(null)
const text = ref('')
const asking = ref('')
const error = ref('')
const box = ref<HTMLElement | null>(null)
const field = ref<HTMLTextAreaElement | null>(null)
const button = ref<HTMLElement | null>(null)
const IDEAS = computed(() => [L('ما الفرص الآن؟', 'What are the opportunities now?'), L('متى أبيع؟', 'When should I sell?'), L('كم في محفظتي؟', 'How is my wallet?'), L('كم يصبح 500 دولار شهريًا بعد 10 سنوات؟', 'What would $500 a month become in 10 years?')])
const down = () => nextTick(() => { if (box.value) box.value.scrollTop = box.value.scrollHeight })
async function show() { open.value = true; if (!d.value) { try { d.value = await api('helper') } catch (e: any) { error.value = e.message } } await nextTick(); field.value?.focus(); down() }
function hide() { open.value = false; nextTick(() => button.value?.focus()) }
async function send(q = text.value) {
  const t = q.trim()
  if (!t || asking.value) return
  asking.value = t; text.value = ''; error.value = ''; down()
  try { d.value = await api('helper', { text: t, lang: lang.value }) } catch (e: any) { error.value = e.message; text.value = t } finally { asking.value = ''; down() }
}
async function clear() { try { d.value = await api('helper/clear', {}) } catch (e: any) { error.value = e.message } }
function key(e: KeyboardEvent) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send() } }
const money = (x: number) => `$${num(x)}`
const share = (g: any, v: number) => `${Math.max(2, (v / Math.max(g.paid, ...g.cases.map((c: any) => c.value), 1)) * 100)}%`
</script>

<template>
  <div>
    <button v-show="!open" ref="button" type="button" class="fixed end-4 bottom-20 z-30 inline-flex h-14 items-center gap-2.5 rounded-full bg-brand px-5 font-semibold text-white shadow-lg transition-colors hover:bg-[#0d0f26] lg:bottom-6" aria-haspopup="dialog" @click="show"><MessageCircle class="size-6" aria-hidden="true" /><span class="max-sm:sr-only">{{ L('اسأل فرصة', 'Ask Forsah') }}</span></button>
    <section v-if="open" role="dialog" aria-labelledby="helper-title" class="sheet fixed inset-x-0 bottom-16 z-40 flex max-h-[calc(100dvh-5rem)] flex-col overflow-hidden rounded-t-3xl border bg-card shadow-2xl sm:inset-x-auto sm:end-4 sm:bottom-20 sm:h-[38rem] sm:max-h-[calc(100dvh-6rem)] sm:w-[25rem] sm:rounded-3xl lg:bottom-6" @keydown.esc="hide">
      <header class="flex items-center gap-3 bg-[#0d0f26] px-5 py-4 text-white [--ring:#ffd32e]"><BrandMark /><div class="min-w-0 flex-1"><h2 id="helper-title" class="!m-0 !text-lg text-white">{{ L('مساعد فرصة', 'Forsah helper') }}</h2><p class="!m-0 text-sm text-panel-muted">{{ L('يقرأ ويشرح، ولا ينفّذ', 'Reads and explains, never trades') }}</p></div><button v-if="d?.messages.length" type="button" class="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" :aria-label="L('امسح المحادثة', 'Clear the conversation')" @click="clear"><Trash2 class="size-5" /></button><button type="button" class="inline-flex size-10 items-center justify-center rounded-full hover:bg-white/10" :aria-label="L('إغلاق', 'Close')" @click="hide"><X class="size-5" /></button></header>
      <div ref="box" class="min-h-40 flex-1 overflow-y-auto p-4" role="log" aria-live="polite" tabindex="0" :aria-label="L('المحادثة', 'Conversation')">
        <template v-if="d && !d.messages.length && !asking"><p>{{ L('اسألني عن محفظتك أو الفرص أو الادخار.', 'Ask me about your wallet, opportunities or saving.') }}</p><div class="grid justify-items-start gap-2"><button v-for="q in IDEAS" :key="q" type="button" class="min-h-11 rounded-2xl bg-secondary px-4 py-2 text-start text-secondary-foreground hover:bg-accent" @click="send(q)">{{ q }}</button></div></template>
        <div v-for="(m, i) in d?.messages || []" :key="i" class="mb-3 flex" :class="m.role === 'user' && 'justify-end'">
          <div class="max-w-[88%] rounded-3xl px-4 py-3" :class="m.role === 'user' ? 'rounded-ee-md bg-brand text-white' : 'rounded-es-md bg-secondary text-secondary-foreground'"><p class="!m-0 break-words whitespace-pre-line" dir="auto">{{ m.text }}</p>
            <div v-if="m.growth" class="mt-3 grid gap-2" aria-hidden="true"><div v-for="c in m.growth.cases" :key="c.rate"><span class="flex justify-between text-sm"><span class="num">{{ (c.rate * 100).toFixed(0) }}%</span><b class="num">{{ money(c.value) }}</b></span><i class="mt-1 block h-2 rounded-full" :class="c.rate < 0 ? 'bg-down' : 'bg-brand'" :style="{ width: share(m.growth, c.value) }" /></div></div>
            <p v-if="m.links?.length" class="!mt-2 !mb-0 flex flex-wrap gap-x-4"><NuxtLink v-for="l in m.links" :key="l.to" :to="l.to" class="font-semibold underline" @click="open = false">{{ l.label }}</NuxtLink></p></div>
        </div>
        <template v-if="asking"><div class="mb-3 flex justify-end"><p class="!m-0 max-w-[88%] rounded-3xl rounded-ee-md bg-brand px-4 py-3 text-white" dir="auto">{{ asking }}</p></div><p class="muted" role="status">{{ L('يراجع بياناتك…', 'Reading your data…') }}</p></template>
      </div>
      <p v-if="error" class="err !mx-4" role="alert">{{ error }}</p>
      <form class="flex items-end gap-2 border-t p-3" @submit.prevent="send()"><textarea ref="field" v-model="text" rows="1" maxlength="1000" dir="auto" class="max-h-28 min-h-11 flex-1 resize-none rounded-3xl border bg-background px-4 py-2.5" :placeholder="L('اكتب سؤالك', 'Write your question')" :aria-label="L('سؤالك', 'Your question')" @keydown="key" /><UiButton type="submit" variant="default" size="icon" class="!size-11" :disabled="!text.trim() || !!asking" :aria-label="L('أرسل', 'Send')"><SendHorizontal class="rtl:-scale-x-100" /></UiButton></form>
      <p class="small muted !m-0 px-4 pb-3 text-center">{{ L('محاكاة ورقية، وليست نصيحة استثمارية.', 'Paper simulation, not investment advice.') }}</p>
    </section>
  </div>
</template>
