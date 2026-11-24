<script setup lang="ts">
// what to buy, what to sell and why, with the losing side beside the gain
import { CalendarDays, CircleAlert, ExternalLink, Newspaper, RefreshCw, Users } from '@lucide/vue'
import { ACTIONS, isSell, isBuy } from '~/lib/calls'
import { plain } from '~/lib/plain'
const { lang, num } = useLang()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const say = (x: any) => (x ? (ar.value ? x.ar : x.en) : '')
const d = ref<any>(null)
const error = ref('')
const busy = ref(false)
const filter = ref('ALL')
let timer: any
let alive = true
async function load() { try { d.value = await api('opportunities'); error.value = '' } catch (e: any) { error.value = e.message } finally { if (alive) timer = setTimeout(load, d.value?.reviewing ? 3000 : 15000) } }
async function act(path: string, body: any = {}) { if (busy.value) return; busy.value = true; error.value = ''; try { d.value = await api(path, body) } catch (e: any) { error.value = e.message } finally { busy.value = false } }
onMounted(load)
onBeforeUnmount(() => { alive = false; clearTimeout(timer) })
const all = computed<any[]>(() => d.value?.items || [])
const FILTERS = computed(() => [['ALL', L('الكل', 'All')], ['BUY', L('شراء', 'Buy')], ['SELL', L('بيع', 'Sell')], ['OTHER', L('انتظار ومتابعة', 'Wait and watch')]] as [string, string][])
const pick = (k: string) => all.value.filter((x) => k === 'ALL' || (k === 'BUY' ? isBuy(x) : k === 'SELL' ? isSell(x) : !isBuy(x) && !isSell(x)))
const items = computed(() => pick(filter.value))
const money = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? `$${num(x)}` : '—')
const pct = (x: any, n = 0) => (typeof x === 'number' ? `${(x * 100).toFixed(n)}%` : '—')
const SURE = computed<Record<string, string>>(() => ({ HIGH: L('أدلة قوية', 'Strong evidence'), MEDIUM: L('أدلة متوسطة', 'Moderate evidence'), LOW: L('أدلة ضعيفة', 'Weak evidence') }))
const KIND = computed<Record<string, string>>(() => ({ MARKET: L('بسعر السوق', 'at market'), LIMIT: L('عند النزول إليه', 'when it falls to it'), STOP: L('عند اختراقه', 'when it breaks above') }))
const STANCE = computed<Record<string, string>>(() => ({ CONFIRM: L('الفريق يؤيد', 'The team agrees'), CAREFUL: L('الفريق يطلب الحذر', 'The team asks for care'), REJECT: L('الفريق يعترض', 'The team objects') }))
const STEPS = computed<Record<string, string>>(() => ({ scout: L('الباحث عن الفرصة', 'The scout'), skeptic: L('المعترض', 'The skeptic'), planner: L('مخطط السيناريوهات', 'The planner'), guide: L('صاحب الخلاصة', 'The guide') }))
const END = computed<Record<string, string>>(() => ({ WAITING: L('تنتظر السعر', 'Waiting for its price'), ACTIVE: L('جارية', 'Running'), REACHED: L('بلغت الهدف', 'Reached the target'), STOPPED: L('بلغت الوقف', 'Hit the stop'), ENDED: L('انتهت مدتها', 'Time ran out'), EXPIRED: L('لم يأتِ سعرها', 'Its price never came'), DROPPED: L('انتهت المحاكاة', 'Simulation ended') }))
const day = (ms: number) => new Date(ms).toLocaleDateString(ar.value ? 'ar-u-nu-latn' : 'en-GB', { day: 'numeric', month: 'short' })
// the plan on one line: stop, entry, price and target in their true distances
const at = (x: any, p: number) => { const v = [x.plan.stop, x.plan.target, x.plan.entry, x.price]; const lo = Math.min(...v); const hi = Math.max(...v); return `${hi > lo ? ((p - lo) / (hi - lo)) * 100 : 50}%` }
const order = (x: any) => ({ path: '/app/orders', query: isSell(x) ? { symbol: x.symbol, side: 'SELL', type: 'MARKET' } : { symbol: x.symbol, side: 'BUY', type: x.plan.type, ...(x.plan.type === 'MARKET' ? {} : { price: x.plan.entry }), stop: x.plan.stop, target: x.plan.target } })
const ready = (x: any) => isSell(x) || (isBuy(x) && x.plan)
const record = computed(() => d.value?.record)
</script>

<template>
  <div>
    <p v-if="error" class="err" role="alert">{{ error }}</p>
    <p v-if="!d && !error" class="muted" role="status">{{ L('نراجع أسواقك…', 'Going through your markets…') }}</p>
    <template v-if="d">
      <UiCard v-if="!d.session"><h2>{{ L('ابدأ محاكاة أولًا', 'Start a simulation first') }}</h2><p class="muted">{{ L('بعدها نراقب أسواقك ونخبرك متى تشتري ومتى تبيع.', 'Then we watch your markets and tell you when to buy and when to sell.') }}</p><NuxtLink to="/app">{{ L('إلى لوحة التداول', 'To the trading page') }}</NuxtLink></UiCard>
      <template v-else>
        <section class="product-night relative mb-4 overflow-hidden rounded-3xl p-6 text-white [--ring:#ffd32e] sm:p-8"><NightField />
          <div class="relative flex flex-wrap items-center gap-x-10 gap-y-5"><div class="min-w-60 flex-1"><h2 class="!m-0 !text-3xl">{{ pick('BUY').length || pick('SELL').length ? L('هذا ما ظهر الآن', 'What stands out now') : L('لا فرصة واضحة الآن', 'No clear opportunity now') }}</h2><p class="!mt-1 !mb-0">{{ pick('BUY').length || pick('SELL').length ? L('رأي من قواعد ثابتة على محاكاة ورقية، وقد يخطئ. القرار لك.', 'A view from fixed rules on a paper simulation. It can be wrong; the decision is yours.') : L('الانتظار قرار. سنخبرك إذا تغيّر شيء.', 'Waiting is a decision. We will tell you when something changes.') }}</p></div>
            <dl class="flex gap-8"><div><dt class="text-sm">{{ L('شراء', 'Buy') }}</dt><dd class="!m-0"><b class="num font-display text-4xl text-sun">{{ pick('BUY').length }}</b></dd></div><div><dt class="text-sm">{{ L('بيع', 'Sell') }}</dt><dd class="!m-0"><b class="num font-display text-4xl">{{ pick('SELL').length }}</b></dd></div><div><dt class="text-sm">{{ L('نراقب', 'Watching') }}</dt><dd class="!m-0"><b class="num font-display text-4xl">{{ all.length }}</b></dd></div></dl>
            <UiButton class="!border-white/45 !bg-transparent !text-white hover:!bg-white hover:!text-[#0d0f26]" :disabled="busy" @click="act('opportunities/scan')"><RefreshCw :class="busy && 'motion-safe:animate-spin'" />{{ L('راجع الآن', 'Check now') }}</UiButton></div>
        </section>

        <div class="mb-4 flex flex-wrap gap-2" role="group" :aria-label="L('تصفية', 'Filter')"><button v-for="[k, n] in FILTERS" :key="k" type="button" :aria-pressed="filter === k" class="min-h-11 rounded-full border px-5 text-sm font-medium transition-colors" :class="filter === k ? 'border-primary bg-primary text-primary-foreground' : 'bg-card hover:bg-accent'" @click="filter = k">{{ n }} <span class="num">{{ pick(k).length }}</span></button></div>
        <p v-if="!items.length" class="muted">{{ L('لا شيء هنا الآن.', 'Nothing here now.') }}</p>

        <div class="mb-4 grid items-start gap-4 xl:grid-cols-2">
          <article v-for="x in items" :key="x.symbol" class="min-w-0 rounded-3xl border bg-card p-5 sm:p-7">
            <header class="flex flex-wrap items-center gap-x-4 gap-y-3"><SymbolIcon :symbol="x.symbol" class="!size-12" /><div class="min-w-0 flex-1"><h3 class="!m-0 text-2xl leading-tight"><bdi>{{ x.symbol }}</bdi></h3><span class="small muted"><span class="num">{{ money(x.price) }}</span><template v-if="!x.live"> · {{ L('سعر تجريبي', 'demo price') }}</template></span></div><span class="rounded-full px-5 py-2 font-display text-lg font-semibold" :class="ACTIONS[x.action]!.c">{{ L(...ACTIONS[x.action]!.n) }}</span></header>
            <p class="!mt-4 !mb-0 text-lg">{{ say(x.why) }}</p>
            <p v-if="x.position" class="!mt-4 !mb-0 rounded-2xl bg-secondary px-4 py-3 text-secondary-foreground">{{ L('تملك', 'You hold') }} <bdi class="font-semibold">{{ x.position.qty }}</bdi> · {{ L('النتيجة', 'Result') }} <b class="num">{{ x.position.value > 0 ? '+' : x.position.value < 0 ? '−' : '' }}${{ num(Math.abs(x.position.value)) }} ({{ pct(x.position.gain, 1) }})</b></p>

            <template v-if="x.plan?.entry">
              <div class="relative mt-6 h-3 rounded-full bg-secondary" dir="ltr" aria-hidden="true"><i class="absolute inset-y-0 rounded-s-full bg-down/75" :style="{ left: at(x, x.plan.stop), right: `calc(100% - ${at(x, x.plan.entry)})` }" /><i class="absolute inset-y-0 rounded-e-full bg-up/75" :style="{ left: at(x, x.plan.entry), right: `calc(100% - ${at(x, x.plan.target)})` }" /><i class="absolute -top-1 h-5 w-1.5 -translate-x-1/2 rounded-full bg-foreground ring-2 ring-card" :style="{ left: at(x, x.price) }" /></div>
              <dl dir="ltr" class="mt-4 grid grid-cols-3 gap-2 text-center"><div class="rounded-2xl bg-secondary/60 p-3"><dt class="small muted">{{ L('الوقف', 'Stop') }}</dt><dd class="!m-0"><b class="num down">{{ money(x.plan.stop) }}</b><span class="small num block">−{{ pct(x.plan.lossPct, 1) }}</span></dd></div><div class="rounded-2xl bg-secondary/60 p-3"><dt class="small muted">{{ L('الدخول', 'Entry') }}</dt><dd class="!m-0"><b class="num">{{ money(x.plan.entry) }}</b><span class="small block">{{ KIND[x.plan.type] }}</span></dd></div><div class="rounded-2xl bg-secondary/60 p-3"><dt class="small muted">{{ L('الهدف', 'Target') }}</dt><dd class="!m-0"><b class="num up">{{ money(x.plan.target) }}</b><span class="small num block">+{{ pct(x.plan.gainPct, 1) }}</span></dd></div></dl>
              <p v-if="x.plan.size" class="!mt-4 !mb-0">{{ L('بحجم يناسب حدودك', 'At a size within your limits') }} (<bdi class="num">{{ x.plan.size.qty }}</bdi>): <b class="num up">+{{ money(x.plan.size.gain) }}</b> {{ L('عند الهدف، أو', 'at the target, or') }} <b class="num down">−{{ money(x.plan.size.loss) }}</b> {{ L('عند الوقف.', 'at the stop.') }}</p>
              <p v-if="x.plan.odds" class="small muted !mt-1 !mb-0">{{ L('من أيام سابقة مُعادة: الهدف أولًا', 'From replayed past days: target first') }} <b class="num">{{ pct(x.plan.odds.target) }}</b>، {{ L('الوقف أولًا', 'stop first') }} <b class="num">{{ pct(x.plan.odds.stop) }}</b>. {{ L('ليست توقعًا.', 'Not a forecast.') }}</p>
            </template>
            <p v-else-if="x.plan?.stop" class="!mt-4 !mb-0">{{ L('احمِ ما تملكه بوقف عند', 'Protect it with a stop at') }} <b class="num">{{ money(x.plan.stop) }}</b><template v-if="x.plan.target"> · {{ L('المقاومة أو الهدف', 'target or resistance') }} <b class="num">{{ money(x.plan.target) }}</b></template></p>

            <ul v-if="x.evidence?.length" class="mt-5 grid !list-none gap-2.5 !p-0"><li v-for="e in x.evidence" :key="e.kind" class="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-x-4"><span><b>{{ say(e.name) }}</b><span v-if="e.text" class="small muted block">{{ say(e.text) }}</span></span><span class="relative h-2.5 rounded-full bg-secondary" role="img" :aria-label="e.score > 0 ? L('لصالحه', 'In its favour') : e.score < 0 ? L('ضده', 'Against it') : L('محايد', 'Neutral')"><i class="absolute inset-y-0 rounded-full" :class="e.score >= 0 ? 'bg-up' : 'bg-down'" :style="e.score >= 0 ? { insetInlineStart: '50%', width: `${e.score * 50}%` } : { insetInlineEnd: '50%', width: `${-e.score * 50}%` }" /><i class="absolute inset-y-[-3px] start-1/2 w-px bg-muted-foreground" /></span></li></ul>
            <p v-if="x.confidence" class="!mt-4 !mb-0 font-medium">{{ SURE[x.confidence] }}</p>
            <ul v-if="x.cautions?.length" class="!mt-2 grid !list-none gap-1.5 !p-0 text-warn"><li v-for="c in x.cautions" :key="c.en" class="flex gap-2"><CircleAlert class="mt-1 size-4 shrink-0" aria-hidden="true" />{{ say(c) }}</li></ul>
            <ul v-if="x.events?.length" class="!mt-4 grid !list-none gap-1.5 !p-0"><li v-for="e in x.events.slice(0, 3)" :key="e.at + e.label.en" class="flex gap-2"><CalendarDays class="mt-1 size-4 shrink-0 text-primary" aria-hidden="true" /><span><bdi class="font-semibold">{{ day(e.at) }}</bdi> · {{ say(e.label) }}</span></li></ul>
            <ul v-if="x.news?.length" class="!mt-4 grid !list-none gap-1.5 !p-0"><li v-for="n in x.news.slice(0, 3)" :key="n.title" class="flex gap-2"><Newspaper class="mt-1 size-4 shrink-0 text-muted-foreground" aria-hidden="true" /><a v-if="n.url" :href="n.url" target="_blank" rel="noopener noreferrer" class="underline"><bdi>{{ n.title }}</bdi> <ExternalLink class="inline size-3" aria-hidden="true" /></a><bdi v-else>{{ n.title }}</bdi></li></ul>

            <section v-if="x.review" class="mt-5 rounded-2xl bg-secondary p-5 text-secondary-foreground"><h4 class="flex items-center gap-2 text-lg"><Users class="size-5" aria-hidden="true" />{{ STANCE[x.review.stance] }}</h4><p class="!mt-1 !mb-0">{{ x.review.why }}</p><ul v-if="x.review.risks?.length" class="!mt-2 !mb-0"><li v-for="r in x.review.risks" :key="r">{{ r }}</li></ul><dl v-if="x.review.scenarios?.length" class="mt-3 grid gap-2"><div v-for="s in x.review.scenarios" :key="s.if"><dt class="font-semibold">{{ L('إذا', 'If') }}: {{ s.if }}</dt><dd class="!m-0">{{ s.then }}</dd></div></dl></section>
            <ul v-if="d.reviewing?.symbol === x.symbol" class="mt-5 flex !list-none flex-wrap gap-2 !p-0" role="status"><li v-for="(n, k) in STEPS" :key="k" class="rounded-full px-4 py-1.5 text-sm" :class="d.reviewing.steps[k]?.state === 'done' ? 'bg-primary text-primary-foreground' : 'bg-secondary'">{{ n }}</li></ul>
            <p v-if="x.change" class="!mt-4 !mb-0 text-muted-foreground">{{ say(x.change) }}</p>
            <div class="mt-5 flex flex-wrap gap-2.5"><NuxtLink v-if="ready(x)" :to="order(x)" class="inline-flex min-h-11 items-center rounded-full bg-primary px-6 font-semibold text-primary-foreground">{{ L('جهّز الأمر الورقي', 'Prepare the paper order') }}</NuxtLink><NuxtLink :to="{ path: '/app/technical', query: { symbol: x.symbol } }" class="inline-flex min-h-11 items-center rounded-full border px-5">{{ L('افتح الرسم', 'Open the chart') }}</NuxtLink><UiButton v-if="d.agentsReady" size="lg" variant="ghost" :disabled="busy || !!d.reviewing || !d.reviewsLeft" @click="act('opportunities/review', { symbol: x.symbol, lang })"><Users />{{ L('اسأل الفريق', 'Ask the team') }}</UiButton></div>
          </article>
        </div>

        <UiCard v-if="record">
          <h2>{{ L('هل أصابت الفرص السابقة؟', 'Were earlier calls right?') }}</h2>
          <p v-if="!record.done" class="muted !mb-0">{{ L('لم تنتهِ أي فرصة بعد. كل فرصة شراء تُسجَّل هنا بنتيجتها، ربحت أو خسرت.', 'None has finished yet. Every buy call is kept here with its result, won or lost.') }}</p>
          <p v-else class="!mb-0">{{ L('انتهت', 'Finished') }} <b class="num">{{ record.done }}</b> · {{ L('ربحت', 'gained') }} <b class="num up">{{ record.won }}</b> · {{ L('خسرت', 'lost') }} <b class="num down">{{ record.lost }}</b> · {{ L('المتوسط', 'average') }} <b class="num">{{ pct(record.average, 1) }}</b><template v-if="record.done < 20"> · <span class="muted">{{ L('العدد قليل، فلا يُبنى عليه', 'Too few to rely on') }}</span></template></p>
          <div v-if="record.list.length" class="relative mt-4 overflow-x-auto"><table class="w-full min-w-[34rem] text-sm"><thead><tr class="text-muted-foreground"><th scope="col" class="py-2 text-start">{{ L('السوق', 'Market') }}</th><th scope="col" class="py-2 text-start">{{ L('التاريخ', 'Date') }}</th><th scope="col" class="py-2 text-start">{{ L('الدخول', 'Entry') }}</th><th scope="col" class="py-2 text-start">{{ L('الحالة', 'State') }}</th><th scope="col" class="py-2 text-start">{{ L('النتيجة', 'Result') }}</th></tr></thead><tbody><tr v-for="t in record.list" :key="t.id" class="border-t"><th scope="row" class="py-2.5 text-start"><bdi>{{ t.symbol }}</bdi></th><td>{{ day(t.at) }}</td><td><span class="num">{{ money(t.entry) }}</span></td><td>{{ END[t.status] }}</td><td><span class="num" :class="t.result > 0 ? 'up' : t.result < 0 ? 'down' : ''">{{ pct(t.result, 1) }}</span></td></tr></tbody></table></div>
          <p class="small muted !mt-4 !mb-0">{{ L('محاكاة ورقية وليست نصيحة استثمارية، ولا ربح مضمون.', 'Paper simulation, not investment advice, and no profit is guaranteed.') }}</p>
        </UiCard>
      </template>
    </template>
  </div>
</template>
