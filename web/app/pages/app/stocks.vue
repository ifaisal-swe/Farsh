<script setup lang="ts">
// your list through the published rules of well-known investors
import { CircleAlert, CircleCheck, CircleHelp, CircleX, ExternalLink } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { lang } = useLang()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const say = (x: any) => (x ? (ar.value ? x.ar : x.en) : '')
const d = ref<any>(null)
const error = ref('')
const pick = ref('')
const open = ref('')
let timer: any
let alive = true
async function load() { try { d.value = await api('investors'); error.value = ''; if (!pick.value && d.value.items.length) pick.value = [...d.value.items].sort((a: any, b: any) => b.fits - a.fits)[0].symbol } catch (e: any) { error.value = plain.error(e.message, ar.value) } finally { if (alive) timer = setTimeout(load, d.value?.items.some((x: any) => x.loading) ? 5000 : 60000) } }
onMounted(load)
onBeforeUnmount(() => { alive = false; clearTimeout(timer) })
const items = computed<any[]>(() => d.value?.items || [])
const methods = computed<any[]>(() => items.value[0]?.methods || [])
const one = computed(() => items.value.find((x) => x.symbol === pick.value) || null)
const OUT = computed<Record<string, { n: string, i: any, c: string }>>(() => ({ FITS: { n: L('يوافق', 'Fits'), i: CircleCheck, c: 'text-up' }, PARTLY: { n: L('جزئيًا', 'Partly'), i: CircleAlert, c: 'text-warn' }, NOT: { n: L('لا يوافق', 'Does not fit'), i: CircleX, c: 'text-down' }, UNKNOWN: { n: L('غير معروف', 'Unknown'), i: CircleHelp, c: 'text-muted-foreground' } }))
const RULE: Record<string, { i: any, c: string }> = { PASS: { i: CircleCheck, c: 'text-up' }, FAIL: { i: CircleX, c: 'text-down' }, UNKNOWN: { i: CircleHelp, c: 'text-muted-foreground' } }
const ZONE = computed<Record<string, string>>(() => ({ SAFE: L('بعيدة عن الضائقة', 'Far from distress'), GREY: L('منطقة رمادية', 'Grey zone'), DISTRESS: L('علامة ضائقة مالية', 'A sign of distress') }))
const why = computed(() => { const x = one.value; if (!x) return ''; if (x.crypto) return L('العملات الرقمية بلا قوائم مالية، فتُقاس بالسعر فقط.', 'Crypto has no financial statements, so only the price is measured.'); if (!x.live) return L('الأسعار تجريبية، ولا نخلطها بقوائم شركة حقيقية. ابدأ محاكاة بأسعار حقيقية لترى بقية الطرق.', 'Prices are invented, and are never mixed with a real company’s statements. Start a simulation with real prices to see the other methods.'); if (x.loading) return L('نقرأ قوائم الشركة الآن…', 'Reading the company’s statements…'); if (!d.value.companyData) return L('القوائم المالية غير متصلة في هذا الحساب.', 'Financial statements are not connected for this account.'); return x.hasCompany ? '' : L('لم نجد قوائم مالية لهذه الشركة.', 'No statements were found for this company.') })
const LESSONS = computed(() => [
  [L('اشترِ شركة لا رمزًا', 'Buy a business, not a ticker'), L('غراهام وبافيت يبدآن من القوائم: ربح مستقر ودين قليل ونقد حقيقي، ثم ينظران إلى السعر.', 'Graham and Buffett start with the statements: steady profit, little debt, real cash. Price comes after.')],
  [L('لا تدفع أي ثمن للنمو', 'Do not pay any price for growth'), L('لينش يقارن السعر بسرعة النمو، وغرينبلات يرتّب الشركات بالجودة والرخص معًا.', 'Lynch compares price with growth; Greenblatt ranks companies by quality and cheapness together.')],
  [L('لا تعاند الاتجاه', 'Do not fight the trend'), L('أونيل ومينرفيني لا يشتريان إلا سهمًا قويًا في سوق صاعد، ويقطعان الخسارة مبكرًا: أونيل عند 7–8%.', 'O’Neil and Minervini buy only strong stocks in a rising market and cut losses early: O’Neil at 7–8%.')],
  [L('لا طريقة تفوز دائمًا', 'No method always wins'), L('دراسة على السوق الأمريكي بين 1963 و2022 وجدت أن أربع طرق معروفة كسبت، لكن لا واحدة تفوقت دائمًا.', 'A study of the US market from 1963 to 2022 found four known formulas paid off, yet none was consistently best.')],
])
const SOURCES = [['Piotroski F-score', 'https://en.wikipedia.org/wiki/Piotroski_F-score'], ['CAN SLIM', 'https://en.wikipedia.org/wiki/CAN_SLIM'], ['Magic formula', 'https://en.wikipedia.org/wiki/Magic_formula_investing'], ['Altman Z-score', 'https://en.wikipedia.org/wiki/Altman_Z-score'], ['Momentum', 'https://en.wikipedia.org/wiki/Momentum_investing'], ['Graham', 'https://www.gurufocus.com/news/878628'], ['Buffett', 'https://global.morningstar.com/en-ca/stocks/what-makes-an-attractive-warren-buffett-stock'], ['Lynch', 'https://www.validea.com/peter-lynch'], ['Minervini', 'https://www.mql5.com/en/articles/22790']]
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="!d && !error" class="muted" role="status">{{ L('نراجع قائمتك…', 'Going through your list…') }}</p>
    <template v-if="d">
      <UiCard v-if="!items.length"><h2>{{ L('لا أسواق في قائمتك', 'Your list is empty') }}</h2><p class="muted">{{ L('أضف أسهمًا من لوحة التداول لتراها بعيون كبار المستثمرين.', 'Add stocks on the trading page to see them through great investors’ eyes.') }}</p><NuxtLink to="/app">{{ L('إلى لوحة التداول', 'To the trading page') }}</NuxtLink></UiCard>
      <UiCard v-else>
        <h2>{{ L('قائمتك بعيون كبار المستثمرين', 'Your list through great investors’ eyes') }}</h2>
        <div class="relative overflow-x-auto"><table class="w-full min-w-[56rem] border-collapse text-sm"><thead><tr><th scope="col" class="px-3 py-2 text-start font-medium text-muted-foreground">{{ L('السهم', 'Stock') }}</th><th scope="col" class="px-3 py-2 text-start font-medium text-muted-foreground">{{ L('يوافق', 'Fits') }}</th><th v-for="m in methods" :key="m.id" scope="col" class="px-2 py-2 text-center font-medium text-muted-foreground">{{ say(m.name) }}</th></tr></thead>
          <tbody><tr v-for="x in items" :key="x.symbol" class="border-t" :class="x.symbol === pick && 'bg-secondary'"><th scope="row" class="px-3 py-3 text-start"><button type="button" class="inline-flex items-center gap-3 rounded-full font-semibold" :aria-pressed="x.symbol === pick" @click="pick = x.symbol"><SymbolIcon :symbol="x.symbol" /><span><bdi class="block text-start">{{ x.symbol }}</bdi><span v-if="x.loading" class="small muted font-normal">{{ L('يقرأ القوائم…', 'Reading…') }}</span></span></button></th>
            <td class="px-3 py-3"><b class="font-display text-lg"><span class="num">{{ x.judged ? `${x.fits}/${x.judged}` : '—' }}</span></b></td>
            <td v-for="m in x.methods" :key="m.id" class="px-2 py-3 text-center"><span class="inline-flex flex-col items-center gap-0.5" :class="OUT[m.result]!.c" :title="`${say(m.name)}: ${OUT[m.result]!.n}`"><component :is="OUT[m.result]!.i" class="size-5" aria-hidden="true" /><span class="sr-only">{{ OUT[m.result]!.n }}</span><span v-if="m.known" class="num text-xs text-muted-foreground">{{ m.passed }}/{{ m.known }}</span></span></td></tr></tbody></table></div>
        <ul class="mt-4 flex !list-none flex-wrap gap-x-5 gap-y-1 !p-0 text-sm"><li v-for="(o, k) in OUT" :key="k" class="flex items-center gap-1.5"><component :is="o.i" class="size-4" :class="o.c" aria-hidden="true" />{{ o.n }}</li><li class="muted">{{ L('الرقم: ما تحقق من القواعد المعروفة', 'Number: rules met out of those known') }}</li></ul>
      </UiCard>

      <template v-if="one">
        <section class="product-night relative mb-4 overflow-hidden rounded-3xl p-6 text-white sm:p-8"><NightField /><div class="relative flex flex-wrap items-center gap-x-6 gap-y-4"><SymbolIcon :symbol="one.symbol" class="!size-16" /><div class="min-w-48 flex-1"><h2 class="!m-0 !text-3xl"><bdi>{{ one.symbol }}</bdi></h2><p class="!m-0"><bdi v-if="one.name">{{ one.name }}</bdi><template v-if="one.period"> · {{ L('القوائم حتى', 'Statements to') }} <bdi>{{ one.period }}</bdi></template></p></div><div v-if="one.judged"><b class="num font-display text-5xl font-bold">{{ one.fits }}/{{ one.judged }}</b><span class="block text-sm">{{ L('طرق توافق من التي أمكن الحكم بها', 'methods fit, of those that could judge') }}</span></div><div v-if="one.distress" class="rounded-2xl bg-[#0d0f26]/55 px-5 py-3"><span class="block text-sm text-panel-muted">{{ L('خطر الضائقة (Altman)', 'Distress risk (Altman)') }}</span><b class="font-display text-lg"><span class="num">{{ one.distress.score }}</span> · {{ ZONE[one.distress.zone] }}</b></div></div><p v-if="why" class="relative !mt-5 !mb-0 rounded-2xl bg-[#0d0f26]/55 px-5 py-3">{{ why }}</p></section>
        <p v-if="/financ/i.test(one.sector || '')" class="mb-4 flex items-center gap-3 rounded-3xl bg-brass-soft px-6 py-4 text-brass"><CircleAlert class="size-5 shrink-0" aria-hidden="true" />{{ L('هذه شركة مالية. قواعد الدين والهوامش والسيولة لا تناسب البنوك، فلا تعتمد على نتائج طرق القوائم هنا.', 'This is a financial company. Debt, margin and liquidity rules do not suit banks, so do not rely on the statement-based methods here.') }}</p>
        <div class="mb-4 grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
          <section v-for="m in one.methods.filter((y: any) => y.rules.length)" :key="m.id" class="flex flex-col rounded-3xl border bg-card p-6">
            <div class="flex items-start gap-3"><div class="min-w-0 flex-1"><h3 class="text-xl leading-snug">{{ say(m.name) }}</h3><p class="!mt-1 !mb-0 text-muted-foreground">{{ say(m.idea) }}</p></div><span class="inline-flex shrink-0 items-center gap-1.5 font-semibold" :class="OUT[m.result]!.c"><component :is="OUT[m.result]!.i" class="size-6" aria-hidden="true" />{{ OUT[m.result]!.n }}</span></div>
            <div class="mt-4 flex gap-1" role="img" :aria-label="`${m.passed} / ${m.known}`"><i v-for="(r, i) in m.rules.filter((y: any) => !y.gate)" :key="i" class="h-2 flex-1 rounded-full" :class="r.state === 'PASS' ? 'bg-up' : r.state === 'FAIL' ? 'bg-down' : 'bg-muted-foreground/25'" /></div>
            <ul class="mt-4 !list-none !p-0"><li v-for="r in m.rules" :key="r.text.en" class="flex gap-3 border-b py-2.5 last:border-0"><component :is="RULE[r.state]!.i" class="mt-0.5 size-5 shrink-0" :class="RULE[r.state]!.c" aria-hidden="true" /><span class="min-w-0 flex-1">{{ say(r.text) }}<span class="sr-only">: {{ r.state === 'PASS' ? L('تحقق', 'met') : r.state === 'FAIL' ? L('لم يتحقق', 'not met') : L('غير معروف', 'unknown') }}</span><span v-if="r.approx" class="small muted block">{{ L('رقم شائع، وليس رقم المستثمر نفسه', 'A common rule of thumb, not the investor’s own number') }}</span></span><bdi v-if="r.value" dir="ltr" class="shrink-0 font-semibold tabular-nums">{{ r.value }}</bdi></li></ul>
          </section>
        </div>
      </template>

      <UiCard><h2>{{ L('كيف يختار كبار المستثمرين', 'How great investors choose') }}</h2><div class="grid gap-x-8 gap-y-5 sm:grid-cols-2 xl:grid-cols-4"><div v-for="[h, p] in LESSONS" :key="h"><h3 class="text-lg">{{ h }}</h3><p class="!mt-1 !mb-0 text-muted-foreground">{{ p }}</p></div></div>
        <p class="small !mt-6 flex flex-wrap gap-x-4 gap-y-1"><span class="muted">{{ L('المصادر', 'Sources') }}:</span><a v-for="[n, u] in SOURCES" :key="n" :href="u" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 underline"><bdi>{{ n }}</bdi><ExternalLink class="size-3" aria-hidden="true" /></a></p>
        <p class="small muted !m-0">{{ L('أداة دراسة للتداول الورقي وليست نصيحة استثمارية. ما لا نعرفه يبقى «غير معروف» ولا نقدّره.', 'A study tool for paper trading, not investment advice. What we do not know stays unknown and is never estimated.') }}</p></UiCard>
    </template>
  </div>
</template>
