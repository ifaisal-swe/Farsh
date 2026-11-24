<script setup lang="ts">
// when the US stock market opens and closes: a countdown, today's sessions on one line, and the coming days
import { Bitcoin, Clock } from '@lucide/vue'
const { lang } = useLang()
const { state } = useTerminal()
const { hours, view, count, time, ny, dayName, localDay, why, PHASE } = useMarketHours()
const L = (a: string, e: string) => (lang.value === 'ar' ? a : e)
const demo = computed(() => state.value?.tradingSession?.dataMode !== 'LIVE')
const zone = computed(() => { try { return new Intl.DateTimeFormat(lang.value === 'ar' ? 'ar' : 'en-GB', { timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value || '' } catch { return '' } })
// the line shows the running day, or the next trading day when the market is fully closed
const shown = computed(() => view.value?.day || view.value?.next || null)
const parts = computed(() => {
  const d = shown.value
  if (!d?.pre || !d.open || !d.close || !d.post) return []
  const all = d.post - d.pre
  return ([['PRE', d.pre, d.open, 'bg-sky text-[#0a0b1a]'], ['REGULAR', d.open, d.close, 'bg-brand text-white'], ['POST', d.close, d.post, 'bg-[#6a45e0] text-white']] as [keyof typeof PHASE.value, number, number, string][]).map(([k, from, to, c]) => ({ k, from, to, c, w: (to - from) / all * 100 }))
})
const spot = computed(() => { const d = view.value?.day; return d?.pre && d.post && view.value!.phase !== 'CLOSED' ? (view.value!.t - d.pre) / (d.post - d.pre) * 100 : null })
</script>

<template>
  <UiCard v-if="view && hours" class="!p-0 overflow-hidden" aria-labelledby="hours">
    <div class="grid lg:grid-cols-[19rem_minmax(0,1fr)]">
      <div class="flex flex-col justify-center p-6 sm:p-7" :class="view.open ? 'bg-brand text-white' : 'bg-panel text-panel-foreground'">
        <h2 id="hours" class="!m-0 flex items-center gap-2.5"><i class="size-3 rounded-full" :class="view.open ? 'bg-sun' : view.phase === 'CLOSED' ? 'bg-[#ff8089]' : 'bg-sky'" aria-hidden="true" />{{ PHASE[view.phase] }}</h2>
        <p class="!mt-4 !mb-0">{{ view.open ? L('يغلق بعد', 'Closes in') : L('يفتح بعد', 'Opens in') }}</p>
        <p class="!m-0" role="timer" aria-live="off"><b class="num font-display text-4xl leading-tight font-bold sm:text-5xl lg:text-[2.6rem]">{{ count(view.left) }}</b></p>
        <p class="!mt-2 !mb-0 text-sm">{{ localDay(view.target) }}{{ L('، ', ', ') }}<bdi>{{ time(view.target) }}</bdi></p>
      </div>
      <div class="min-w-0 p-6 sm:p-7">
        <div class="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1"><h3 class="text-lg">{{ L('ساعات السوق الأمريكي', 'US market hours') }} <span v-if="shown" class="small muted font-sans font-normal">{{ dayName(shown.date, true) }}</span></h3><span class="small muted flex items-center gap-1.5"><Clock class="size-4" aria-hidden="true" />{{ L('بتوقيتك', 'Your time') }}{{ zone ? ` · ${zone}` : '' }}</span></div>
        <div v-if="parts.length" class="relative" :class="spot !== null && 'pt-3'">
          <i v-if="spot !== null" class="absolute top-0 z-10 h-12 w-1 -translate-x-1/2 rounded-full bg-sun ring-2 ring-card transition-[inset-inline-start] duration-1000 rtl:translate-x-1/2" :style="{ insetInlineStart: `${spot}%` }" aria-hidden="true" />
          <div class="flex h-9 gap-0.5 overflow-hidden rounded-full" aria-hidden="true"><span v-for="p in parts" :key="p.k" :class="[p.c, view.phase !== p.k && view.day && 'opacity-60']" :style="{ width: `${p.w}%` }" /></div>
          <ul class="mt-4 grid !list-none gap-3 !p-0 sm:grid-cols-3"><li v-for="p in parts" :key="p.k" class="flex gap-2.5" :aria-current="view.phase === p.k ? 'time' : undefined"><i class="mt-1.5 size-3 shrink-0 rounded-full" :class="p.c" aria-hidden="true" /><span><b class="block">{{ p.k === 'REGULAR' ? L('التداول الرئيسي', 'Main session') : PHASE[p.k] }}</b><bdi class="block">{{ time(p.from) }} – {{ time(p.to) }}</bdi><span class="small muted">{{ L('نيويورك', 'New York') }} <span class="num">{{ ny(p.from) }}–{{ ny(p.to) }}</span></span></span></li></ul>
        </div>
      </div>
    </div>
    <ul class="grid !list-none grid-cols-2 gap-px border-t bg-border !p-0 sm:grid-cols-4 2xl:grid-cols-8"><li v-for="d in hours.days" :key="d.date" class="bg-card px-5 py-3.5"><b class="block">{{ dayName(d.date) }}</b><span v-if="d.open" class="small block"><bdi>{{ time(d.open) }} – {{ time(d.close) }}</bdi></span><span v-else class="small block text-down">{{ L('مغلق', 'Closed') }}: {{ why(d) }}</span><span v-if="d.close && view.t >= d.close" class="small muted block">{{ L('انتهت الجلسة', 'Session ended') }}</span><span v-else-if="d === view.day && view.open" class="small block font-semibold text-up">{{ L('مفتوح الآن', 'Open now') }}</span><span v-if="d.early" class="small block text-warn">{{ L('إغلاق مبكر', 'Early close') }}</span></li></ul>
    <p class="small !m-0 flex flex-wrap items-center gap-x-5 gap-y-1 border-t px-6 py-3.5 sm:px-7"><span class="flex items-center gap-1.5 font-semibold"><Bitcoin class="size-4" aria-hidden="true" />{{ L('العملات الرقمية: مفتوحة على مدار الساعة', 'Crypto: open around the clock') }}</span><span class="muted">{{ hours.official ? L('المواعيد من التقويم الرسمي للسوق.', 'Times come from the official market calendar.') : L('المواعيد من جدول عطلات بورصة نيويورك المعلن، ولا تشمل الإغلاق الطارئ.', 'Times follow the published NYSE holiday schedule and cannot know an emergency closure.') }}</span><span v-if="demo" class="text-warn">{{ L('هذه مواعيد السوق الحقيقي. أسعارك التجريبية تعمل دائمًا.', 'These are the real market’s hours. Your demo prices always run.') }}</span></p>
  </UiCard>
</template>
