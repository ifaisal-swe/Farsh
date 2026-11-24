<script setup lang="ts">
import { ArrowUpRight, Bell, Bitcoin, ChartCandlestick, CircleCheck, EyeOff, Lock, UserCheck, UserRound } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
useHead({ title: () => L('فرصة', 'Forsah') })
const email = ref('')
const asked = ref(false)
const askError = ref('')
const asking = ref(false)
async function ask() {
  asking.value = true
  askError.value = ''
  try {
    const r = await fetch('/account/request', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify({ email: email.value }) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error)
    asked.value = true
  } catch (e: any) { askError.value = plain.error(e.message, lang.value === 'ar') } finally { asking.value = false }
}
const tabs = computed(() => [{ value: 'pass', label: L('سهم مجتاز', 'Passes') }, { value: 'fail', label: L('سهم غير متوافق', 'Fails') }, { value: 'open', label: L('بيانات ناقصة', 'Missing data') }])
type Row = [string, string, 'ok' | 'bad' | 'unknown' | 'skip']
// worked examples, not real companies; the limits are the ones the product applies
const CASES = computed<Record<string, { rows: Row[], result: string }>>(() => ({
  pass: { rows: [[L('نشاط الشركة', 'Business activity'), L('أشباه موصلات', 'Semiconductors'), 'ok'], [L('الدين / القيمة السوقية', 'Debt / market cap'), '8.4% < 30%', 'ok'], [L('الودائع / القيمة السوقية', 'Deposits / market cap'), '12.1% < 30%', 'ok'], [L('دخل غير مباح / الإيرادات', 'Impermissible income / revenue'), '1.2% < 5%', 'ok'], [L('المخاطرة على الصفقة', 'Risk on this trade'), '0.5%', 'ok']], result: L('يُنفّذ الشراء الورقي مع وقف خسارة وهدف', 'The paper buy is placed with a stop and a target') },
  fail: { rows: [[L('نشاط الشركة', 'Business activity'), L('طيران', 'Airline'), 'ok'], [L('الدين / القيمة السوقية', 'Debt / market cap'), '41.0% > 30%', 'bad'], [L('الودائع / القيمة السوقية', 'Deposits / market cap'), '9.7% < 30%', 'ok'], [L('دخل غير مباح / الإيرادات', 'Impermissible income / revenue'), '0.8% < 5%', 'ok'], [L('المخاطرة على الصفقة', 'Risk on this trade'), '—', 'skip']], result: L('لا شراء. ويصلك تنبيه إذا كنت تملك السهم', 'No buy. You are alerted if you hold the stock') },
  open: { rows: [[L('نشاط الشركة', 'Business activity'), L('برمجيات', 'Software'), 'ok'], [L('الدين / القيمة السوقية', 'Debt / market cap'), '3.9% < 30%', 'ok'], [L('الودائع / القيمة السوقية', 'Deposits / market cap'), '18.2% < 30%', 'ok'], [L('دخل غير مباح / الإيرادات', 'Impermissible income / revenue'), L('غير مذكور', 'Not stated'), 'unknown'], [L('المخاطرة على الصفقة', 'Risk on this trade'), '—', 'skip']], result: L('لا شراء حتى تسجّل حكمًا من مصدر موثوق', 'No buy until you record a ruling from a source you trust') },
}))
const STEPS = computed(() => [[L('يراقب', 'Watch'), L('تتابع فرصة الأسعار والأخبار عنك طوال الوقت.', 'Forsah follows prices and news for you, all the time.')], [L('يقترح', 'Propose'), L('تقترح عليك صفقة، وتشرح سببها ومتى يتغير الرأي فيها.', 'It suggests a trade, explains why, and says what would change its mind.')], [L('يفحص', 'Check'), L('يمر كل اقتراح على الفحص الشرعي ثم حدود المخاطر، ولا شيء يتجاوزهما.', 'Every suggestion goes through the Sharia screen and then your risk limits. Nothing skips them.')], [L('ينفّذ أو ينتظرك', 'Act, or ask you'), L('تنفيذ آلي، أو موافقتك على كل صفقة، أو اقتراحات فقط. والتنبيه يصلك على تيليجرام.', 'Automatic, with your approval on each trade, or suggestions only. Alerts reach you on Telegram.')]])
const SAFE = computed(() => [[UserRound, L('حساب مستقل', 'A separate account'), L('محفظتك وإعداداتك لك وحدك، ولا تختلط بحساب غيرك.', 'Your portfolio and settings are yours and never mix with anyone else\'s.')], [EyeOff, L('خصوصية كاملة', 'Full privacy'), L('لا يطّلع عميل على حساب عميل آخر.', 'No customer can see another customer\'s account.')], [Lock, L('دخول بخطوتين', 'Two-step sign-in'), L('رمز إضافي يتغيّر باستمرار يحمي حسابك.', 'An extra code that keeps changing protects your account.')], [UserCheck, L('أنت صاحب القرار', 'You decide'), L('اختر التنفيذ الآلي، أو وافق على كل صفقة بنفسك.', 'Let it run, or approve every trade yourself.')]])
const FAQ = computed(() => [{ q: L('هل تتداول المنصة بأموال حقيقية؟', 'Does the platform trade real money?'), a: L('لا. كل الصفقات محاكاة للتعلّم والتجربة، ولا تُرسل المنصة أي أمر إلى وسيط.', 'No. Every trade is a simulation for learning and practice, and no order is ever sent to a broker.') }, { q: L('هل الفحص الشرعي فتوى؟', 'Is the Sharia screen a fatwa?'), a: L('لا. هو فحص آلي أولي من التقارير المعلنة للشركات. إذا نقصت المعلومات يبقى السهم ممنوعًا حتى تسجّل حكمًا باسم مصدره.', 'No. It is an automated first check based on what companies publish. When information is missing, the stock stays blocked until you record a ruling with its source.') }, { q: L('ماذا عن العملات الرقمية؟', 'What about crypto?'), a: L('أزواج فورية مقابل الدولار مثل BTC/USD، على مدار الساعة، دون رافعة أو بيع على المكشوف. كل زوج محظور حتى تسجّل له حكمًا.', 'Spot pairs against the dollar such as BTC/USD, around the clock, with no leverage or short selling. Each pair is blocked until you record a ruling.') }, { q: L('كيف أسجّل؟', 'How do I join?'), a: L('التسجيل بالدعوة حاليًا. اترك بريدك في أسفل الصفحة لطلب دعوة.', 'Registration is by invitation for now. Leave your e-mail at the bottom of this page to ask for one.') }])
const wrap = 'mx-auto max-w-6xl px-4 sm:px-6'
// facts about the product, not performance figures
const FACTS = computed(() => [['30%', L('أقصى دين بفائدة', 'Debt limit')], ['30%', L('أقصى ودائع وأوراق', 'Deposit limit')], ['5%', L('أقصى دخل غير مباح', 'Impermissible income limit')], ['24/7', L('مراقبة العملات الرقمية', 'Crypto monitoring')]])
const METERS = computed(() => [[L('الدين / القيمة السوقية', 'Debt / market cap'), 8.4, 30], [L('الودائع / القيمة السوقية', 'Deposits / market cap'), 12.1, 30], [L('دخل غير مباح / الإيرادات', 'Impermissible income / revenue'), 1.2, 5]] as [string, number, number][])
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE']
const NOTES = computed(() => [L('اكتمل شراء ورقي', 'Paper buy done'), L('بلغت حد المخاطرة اليومي', 'Daily risk limit reached'), L('سهم جديد اجتاز الفحص', 'A new stock passed')])
const BENEFITS = computed(() => [[ChartCandlestick, L('أسهم أمريكية', 'US stocks'), L('الأسعار والأخبار والقرارات في شاشة واحدة.', 'Prices, news and decisions on one screen.')], [Bitcoin, L('عملات رقمية', 'Crypto'), L('متابعة على مدار الساعة، دون رافعة أو بيع على المكشوف.', 'Followed around the clock, with no leverage or short selling.')], [Bell, L('تنبيهات تيليجرام', 'Telegram alerts'), L('تصلك الصفقات والمخاطر وتغيّر الحالة الشرعية فورًا.', 'Trades, risks and Sharia changes reach you at once.')]])
</script>

<template>
  <div>
    <section class="px-3 sm:px-5">
      <div class="relative mx-auto max-w-[87.5rem] overflow-hidden rounded-[2rem] bg-brand text-white">
        <BrandField />
        <div class="relative mx-auto grid max-w-6xl items-center gap-12 px-5 py-14 sm:px-8 lg:grid-cols-[1.1fr_1fr] lg:py-20">
          <div>
            <h1 class="display rise">{{ L('افحص الفرصة', 'Check the opportunity') }} <span class="block text-sun">{{ L('قبل أن تنفّذها', 'before you take it') }}</span></h1>
            <p class="rise mt-6 max-w-[46ch] text-lg" style="--d: 140ms">{{ L('فرصة منصة عربية للتداول الورقي الآلي. تفحص كل سهم شرعيًا، وتضبط المخاطرة، ثم تنفّذ أو تنتظر موافقتك.', 'Forsah is an Arabic-first platform for automated paper trading. It screens every stock, limits the risk, then acts or waits for your approval.') }}</p>
            <div class="rise mt-9 flex flex-wrap items-center gap-3" style="--d: 280ms"><a href="#join" class="ripple inline-flex h-12 items-center gap-2 rounded-full bg-sun px-7 font-semibold text-sun-foreground transition-colors hover:bg-white">{{ L('اطلب دعوة', 'Ask for an invitation') }}<ArrowUpRight class="size-4 rtl:-scale-x-100" aria-hidden="true" /></a><NuxtLink to="/login" class="inline-flex h-12 items-center rounded-full border border-white/60 bg-brand-deep px-7 font-semibold transition-colors hover:bg-white hover:text-[#1d2895]">{{ L('تسجيل الدخول', 'Sign in') }}</NuxtLink></div>
          </div>
          <HeroPhone :cases="CASES" :tabs="tabs" />
        </div>
      </div>
    </section>

    <section :class="wrap" class="grid gap-4 py-16 sm:py-24 md:grid-cols-3">
      <div v-for="([icon, name, text], i) in BENEFITS" :key="i" v-reveal="i" class="lift flex flex-col overflow-hidden rounded-3xl border bg-card">
        <div class="p-7 pb-4"><span class="inline-flex size-14 items-center justify-center rounded-2xl" :class="['bg-brand text-white', 'bg-sun text-sun-foreground', 'bg-sky text-[#0a0b1a]'][i]"><component :is="icon" class="size-7" aria-hidden="true" /></span><h2 class="mt-6 text-2xl">{{ name }}</h2><p class="mt-2 text-muted-foreground">{{ text }}</p></div>
        <div class="mt-auto h-40 overflow-hidden" aria-hidden="true">
          <div v-if="i === 0" class="bars flex h-full items-end justify-center gap-3 px-7"><i v-for="(h, n) in [38, 62, 50, 84, 70, 96, 118]" :key="n" class="w-full rounded-t-xl" :class="n === 6 ? 'bg-brand' : 'bg-secondary'" :style="{ height: h + 'px', '--i': n }" /></div>
          <div v-else-if="i === 1" class="marquee-box grid h-full content-center gap-3"><div v-for="row in 2" :key="row" class="marquee" :style="{ animationDuration: row === 1 ? '24s' : '32s' }"><span v-for="(c, n) in [...COINS, ...COINS, ...COINS, ...COINS]" :key="n" class="rounded-full px-4 py-1.5 text-sm font-semibold" :class="['bg-secondary text-secondary-foreground', 'bg-sun text-sun-foreground', 'bg-sky text-[#0a0b1a]', 'bg-leaf text-leaf-foreground'][(n + row) % 4]">{{ c }}</span></div></div>
          <div v-else class="fan relative mx-auto h-full w-64"><div v-for="(x, n) in NOTES" :key="n" class="absolute inset-x-0 flex items-center gap-2.5 rounded-2xl border bg-card px-4 py-3 text-sm font-medium shadow-lg" :style="{ '--i': n, top: 8 + n * 44 + 'px', transform: `rotate(${[-4, 3, -2][n]}deg)` }"><CircleCheck class="size-5 shrink-0" :class="['text-up', 'text-warn', 'text-primary'][n]" />{{ x }}</div></div>
        </div>
      </div>
    </section>

    <section id="how" class="scroll-mt-20"><div :class="wrap" class="pb-20 sm:pb-28">
      <h2 v-reveal class="max-w-[18ch] text-4xl leading-tight sm:text-5xl">{{ L('من الفكرة إلى الصفقة', 'From idea to trade') }} <span class="text-primary">{{ L('في أربع خطوات', 'in four steps') }}</span></h2>
      <ol class="mt-10 grid gap-10 sm:grid-cols-2 lg:grid-cols-4"><li v-for="([name, text], i) in STEPS" :key="i" v-reveal="i"><span class="num inline-flex size-14 items-center justify-center rounded-full font-display text-2xl font-bold" :class="['bg-sun text-sun-foreground', 'bg-sky text-[#0a0b1a]', 'bg-leaf text-leaf-foreground', 'bg-brand text-white'][i]">{{ i + 1 }}</span><h3 class="mt-6 text-xl">{{ name }}</h3><p class="mt-1 text-muted-foreground">{{ text }}</p></li></ol>
    </div></section>

    <section class="bg-sun text-sun-foreground"><dl :class="wrap" class="grid grid-cols-2 gap-y-10 py-14 lg:grid-cols-4"><div v-for="([v, k], i) in FACTS" :key="i" class="px-4 text-center lg:not-first:border-s lg:not-first:border-black/15"><dd class="num block font-display text-5xl font-bold sm:text-6xl"><CountUp :value="v!" /></dd><dt class="mt-1 font-medium">{{ k }}</dt></div></dl></section>

    <section id="sharia" class="grid scroll-mt-16 lg:grid-cols-2">
      <div class="relative overflow-hidden bg-panel px-4 py-16 text-panel-foreground sm:px-10 lg:py-28"><div class="relative ms-auto max-w-xl">
        <h2 v-reveal class="text-4xl leading-tight sm:text-5xl">{{ L('فحص يمنع،', 'A screen that blocks') }} <span class="text-sun">{{ L('لا يكتفي بالتنبيه', 'instead of warning') }}</span></h2>
        <p class="mt-4 text-panel-muted">{{ L('إذا لم يجتز السهم، أو كانت معلوماته قديمة أو ناقصة، فلن يُشترى. أما البيع فمسموح دائمًا.', 'If a stock fails, or its information is old or missing, it is not bought. Selling is always allowed.') }}</p>
        <p class="mt-8 mb-4 text-sm text-panel-muted">{{ L('مثال توضيحي لسهم مجتاز، والشريط يمثل الحد كاملًا', 'Worked example of a passing stock; each bar is the whole limit') }}</p>
        <div v-for="([name, v, max], i) in METERS" :key="i" class="mb-6"><div class="mb-2 flex justify-between gap-4 font-medium"><span>{{ name }}</span><bdi dir="ltr" class="tabular-nums">{{ v }}% / {{ max }}%</bdi></div><div v-reveal class="fill-in h-2 overflow-hidden rounded-full bg-panel-2" role="meter" :aria-label="name" :aria-valuenow="v" aria-valuemin="0" :aria-valuemax="max"><div class="h-full rounded-full" :class="i === 1 ? 'bg-sun' : 'bg-sky'" :style="{ width: `${v / max * 100}%` }" /></div></div>
      </div></div>
      <div class="bg-card px-4 py-16 sm:px-10 lg:py-28"><div v-reveal class="me-auto max-w-xl">
        <h3 class="mb-5 text-2xl">{{ L('المعايير الأربعة', 'The four tests') }}</h3>
        <UiTable><thead><tr><th>{{ L('المعيار', 'Test') }}</th><th>{{ L('الحد', 'Limit') }}</th><th>{{ L('المصدر', 'Source') }}</th></tr></thead><tbody>
          <tr><td>{{ L('النشاط الأساسي', 'Core business') }}</td><td>{{ L('غير محظور', 'Not excluded') }}</td><td>{{ L('نشاط الشركة المعلن', 'Published business') }}</td></tr>
          <tr><td>{{ L('الدين بفائدة', 'Interest-bearing debt') }}</td><td><span class="num">&lt; 30%</span></td><td>{{ L('من القيمة السوقية', 'of market cap') }}</td></tr>
          <tr><td>{{ L('النقد والأوراق المالية', 'Cash and securities') }}</td><td><span class="num">&lt; 30%</span></td><td>{{ L('من القيمة السوقية', 'of market cap') }}</td></tr>
          <tr><td>{{ L('الدخل غير المباح', 'Impermissible income') }}</td><td><span class="num">&lt; 5%</span></td><td>{{ L('من الإيرادات السنوية', 'of annual revenue') }}</td></tr>
        </tbody></UiTable>
        <p class="mt-5 text-muted-foreground">{{ L('حدود على نهج معايير أيوفي، ويمكنك جعلها أشد، وتسجيل حكم هيئة أو عالم مع اسم المصدر. فحص آلي أولي وليس فتوى.', 'Limits in the style of AAOIFI standards. You can make them stricter, and record a ruling from a board or scholar with its source. An automated first check, not a fatwa.') }}</p>
      </div></div>
    </section>

    <section id="security" :class="wrap" class="scroll-mt-20 py-20 sm:py-28"><h2 class="text-4xl sm:text-5xl">{{ L('حسابك', 'Your account') }} <span class="text-primary">{{ L('لك وحدك', 'is yours alone') }}</span></h2>
      <div class="mt-12 grid gap-4 md:grid-cols-5"><div v-for="([icon, name, text], i) in SAFE" :key="i" v-reveal="i" class="lift flex min-h-64 flex-col justify-between rounded-3xl border p-7" :class="[i === 0 || i === 3 ? 'md:col-span-3' : 'md:col-span-2', i === 0 ? 'border-transparent bg-brand text-white' : i === 3 ? 'border-transparent bg-sun text-sun-foreground' : 'bg-card']"><component :is="icon" class="size-9" :class="i === 1 ? 'text-leaf' : i === 2 ? 'text-primary' : ''" aria-hidden="true" /><div class="mt-8"><h3 class="text-2xl sm:text-3xl">{{ name }}</h3><p class="mt-2 max-w-[46ch]" :class="i === 0 || i === 3 ? '' : 'text-muted-foreground'">{{ text }}</p></div></div></div>
    </section>

    <section id="faq" class="scroll-mt-16 border-t"><div :class="wrap" class="grid gap-8 py-20 sm:py-28 lg:grid-cols-[1fr_1.6fr]"><h2 class="text-4xl sm:text-5xl">{{ L('أسئلة شائعة', 'Questions') }}</h2><div v-reveal><UiAccordion :items="FAQ" /></div></div></section>

    <section id="join" class="scroll-mt-24 px-3 pb-3 sm:px-5 sm:pb-5"><div v-reveal class="relative mx-auto max-w-[87.5rem] overflow-hidden rounded-[2rem] bg-brand text-white"><BrandField /><div class="relative mx-auto grid max-w-6xl items-center gap-10 px-5 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1.2fr_1fr]">
      <h2 class="display max-w-[14ch]">{{ L('اطلب دعوتك', 'Ask for your invitation') }} <span class="text-sun">{{ L('وابدأ بالتجربة', 'and start practising') }}</span></h2>
      <div class="rounded-3xl bg-card p-6 text-card-foreground sm:p-8">
        <p v-if="asked" role="status" class="flex items-center gap-3 text-lg font-semibold"><CircleCheck class="size-7 text-up" aria-hidden="true" />{{ L('وصلنا طلبك. سنراسلك عند توفر مكان.', 'We have your request and will write when a place opens.') }}</p>
        <form v-else class="grid gap-4" @submit.prevent="ask"><label class="grid gap-1.5 text-sm font-medium" for="ask">{{ L('بريدك الإلكتروني', 'Your e-mail') }}<UiInput id="ask" v-model="email" type="email" dir="ltr" autocomplete="email" required class="h-12 w-full rounded-full px-5 font-normal" /></label><p v-if="askError" role="alert" class="text-sm text-destructive">{{ askError }}</p><UiButton type="submit" variant="default" size="lg" class="!h-12" :disabled="asking">{{ L('أرسل الطلب', 'Send request') }}</UiButton></form>
        <p class="mt-4 text-sm text-muted-foreground">{{ L('وصلتك دعوة؟', 'Already invited?') }} <NuxtLink to="/invite" class="font-medium text-primary hover:underline">{{ L('أنشئ حسابك', 'Create your account') }}</NuxtLink></p>
      </div>
    </div></div></section>
  </div>
</template>
