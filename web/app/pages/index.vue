<script setup lang="ts">
import { ArrowUpRight, Bell, CircleCheck, EyeOff, Lock, UserCheck } from '@lucide/vue'
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
  open: { rows: [[L('نشاط الشركة', 'Business activity'), L('برمجيات', 'Software'), 'ok'], [L('الدين / القيمة السوقية', 'Debt / market cap'), '3.9% < 30%', 'ok'], [L('الودائع / القيمة السوقية', 'Deposits / market cap'), '18.2% < 30%', 'ok'], [L('دخل غير مباح / الإيرادات', 'Impermissible income / revenue'), L('غير مذكور', 'Not stated'), 'unknown'], [L('المخاطرة على الصفقة', 'Risk on this trade'), '—', 'skip']], result: L('لا شراء حتى تسجّل نتيجة من مصدر موثوق', 'No buy until you record a result from a source you trust') },
}))
const STEPS = computed(() => [[L('يراقب', 'Watch'), L('تتابع فرصة الأسعار والأخبار عنك طوال الوقت.', 'Forsah follows prices and news for you, all the time.')], [L('يقترح', 'Propose'), L('تقترح عليك صفقة، وتشرح سببها ومتى يتغير الرأي فيها.', 'It suggests a trade, explains why, and says what would change its mind.')], [L('يفحص', 'Check'), L('يمر كل اقتراح على الفحص الشرعي ثم حدود المخاطر، ولا شيء يتجاوزهما.', 'Every suggestion goes through the Sharia screen and then your risk limits. Nothing skips them.')], [L('ينفّذ أو ينتظرك', 'Act, or ask you'), L('تنفيذ آلي، أو موافقتك على كل صفقة، أو اقتراحات فقط. والتنبيه يصلك على تيليجرام.', 'Automatic, with your approval on each trade, or suggestions only. Alerts reach you on Telegram.')]])
const FAQ = computed(() => [{ q: L('هل تتداول المنصة بأموال حقيقية؟', 'Does the platform trade real money?'), a: L('لا. كل الصفقات محاكاة للتعلّم والتجربة، ولا تُرسل المنصة أي أمر إلى وسيط.', 'No. Every trade is a simulation for learning and practice, and no order is ever sent to a broker.') }, { q: L('كيف يعمل الفحص الشرعي؟', 'How does the Sharia screen work?'), a: L('هو فحص آلي أولي من التقارير المعلنة للشركات. إذا نقصت المعلومات يبقى السهم ممنوعًا حتى تسجّل نتيجة باسم مصدرها.', 'It is an automated first check based on what companies publish. When information is missing, the stock stays blocked until you record a result with its source.') }, { q: L('ماذا عن العملات الرقمية؟', 'What about crypto?'), a: L('أزواج فورية مقابل الدولار مثل BTC/USD، على مدار الساعة، دون رافعة أو بيع على المكشوف. كل زوج محظور حتى تسجّل له نتيجة من مصدر موثوق.', 'Spot pairs against the dollar such as BTC/USD, around the clock, with no leverage or short selling. Each pair is blocked until you record a result.') }, { q: L('كيف أسجّل؟', 'How do I join?'), a: L('التسجيل بالدعوة حاليًا. اترك بريدك في أسفل الصفحة لطلب دعوة.', 'Registration is by invitation for now. Leave your e-mail at the bottom of this page to ask for one.') }])
const wrap = 'mx-auto max-w-7xl px-4 sm:px-6'
const METERS = computed(() => [[L('الدين / القيمة السوقية', 'Debt / market cap'), 8.4, 30], [L('الودائع / القيمة السوقية', 'Deposits / market cap'), 12.1, 30], [L('دخل غير مباح / الإيرادات', 'Impermissible income / revenue'), 1.2, 5]] as [string, number, number][])
const NOTES = computed(() => [L('اكتمل شراء ورقي', 'Paper buy done'), L('بلغت حد المخاطرة اليومي', 'Daily risk limit reached'), L('سهم جديد اجتاز الفحص', 'A new stock passed')])
const COINS = ['BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'LTC', 'LINK']
const STEPPED = [38, 24, 60, 30, 14, 20, 46, 78, 58, 96] // column heights behind the last section
</script>

<template>
  <div>
    <section class="night relative overflow-hidden text-white">
      <NightField />
      <div :class="wrap" class="relative flex flex-col items-center pt-12 text-center sm:pt-16">
        <h1 class="display">{{ L('اقتص الفرصة', 'Seize the opportunity') }} <span class="block text-sun">{{ L('اول بأول', 'as it comes') }}</span></h1>
        <p class="mt-4 max-w-[52ch] text-lg">{{ L('فرصة منصة عربية للتداول الورقي الآلي. تفحص كل سهم شرعيًا، وتضبط المخاطرة، ثم تنفّذ أو تنتظر موافقتك.', 'Forsah is an Arabic-first platform for automated paper trading. It screens every stock, limits the risk, then acts or waits for your approval.') }}</p>
        <div class="mt-7 flex flex-wrap justify-center gap-3"><a href="#join" class="inline-flex h-13 items-center rounded-full bg-sun px-9 text-lg font-semibold text-sun-foreground transition-colors hover:bg-white">{{ L('اطلب دعوة', 'Ask for an invitation') }}</a><NuxtLink to="/demo" class="inline-flex h-13 items-center rounded-full border border-white/45 px-8 text-lg font-semibold transition-colors hover:bg-white hover:text-[#0d0f26]">{{ L('جرّب بلا حساب', 'Try without an account') }}</NuxtLink></div>
        <HeroScene class="mt-11" />
      </div>
    </section>

    <section id="products" :class="wrap" class="scroll-mt-20 py-20 sm:py-28">
      <h2 class="mx-auto max-w-[18ch] text-center text-4xl leading-tight sm:text-5xl">{{ L('أسواق متعددة وضوابط واحدة', 'Several markets, one set of rules') }}</h2>
      <div class="mt-12 grid gap-4 md:grid-cols-2 lg:mt-16 lg:gap-5">
        <article class="tile-lg bg-brand text-white">
          <div><h3>{{ L('أسهم أمريكية بأسعار حقيقية', 'US stocks at real prices') }}</h3><p>{{ L('تتابع فرصة الأسعار والأخبار لأسهم تختارها، وتشرح كل قرار في شاشة واحدة.', 'Forsah follows prices and news for the stocks you choose, and explains every decision on one screen.') }}</p></div>
          <div class="art relative -mx-7 overflow-hidden sm:-mx-9" aria-hidden="true" style="--c-up: #fff; --c-down: #a9b3ff" dir="ltr"><LandingChart class="absolute bottom-0 left-0 h-full !w-auto min-w-[112%]" /><span v-for="([x, l, t]) in [['AAPL', '8%', '22%'], ['NVDA', '34%', '8%'], ['TSLA', '62%', '84%']]" :key="x" class="absolute inline-flex items-center gap-2 rounded-full bg-white px-4 py-2 text-sm font-semibold text-[#0d0f26]" :style="{ left: l, top: t }"><AssetIcon :symbol="x!" />{{ x }}</span></div>
          <a href="#tools">{{ L('استكشف أدوات التحليل', 'See the analysis tools') }}<ArrowUpRight aria-hidden="true" /></a>
        </article>
        <article class="tile-lg bg-secondary">
          <div><h3>{{ L('عملات رقمية على مدار الساعة', 'Crypto around the clock') }}</h3><p>{{ L('أزواج فورية مقابل الدولار، دون رافعة أو بيع على المكشوف. وكل زوج محظور حتى تسجّل له نتيجة من مصدر موثوق.', 'Spot pairs against the dollar, with no leverage or short selling. Each pair is blocked until you record a result.') }}</p></div>
          <div class="art -mx-7 grid content-center gap-3 overflow-hidden sm:-mx-9" aria-hidden="true" dir="ltr"><div v-for="row in 3" :key="row" class="flex gap-3" :style="{ transform: `translateX(${[-30, -78, -8][row - 1]}px)` }"><span v-for="n in 8" :key="n" class="inline-flex shrink-0 items-center gap-2 rounded-full border bg-card py-2 ps-2.5 pe-5 font-semibold text-card-foreground"><i class="inline-flex size-7 items-center justify-center rounded-full bg-white"><AssetIcon :symbol="COINS[(n + row * 3) % 8]!" /></i>{{ COINS[(n + row * 3) % 8] }}</span></div></div>
          <a href="#faq">{{ L('كيف تعمل العملات الرقمية', 'How crypto works here') }}<ArrowUpRight aria-hidden="true" /></a>
        </article>
        <article class="tile-lg bg-accent">
          <div><h3>{{ L('تداول آلي بقرارك', 'Automation on your terms') }}</h3><p>{{ L('تنفيذ آلي، أو موافقتك على كل صفقة، أو اقتراحات فقط.', 'Automatic, with your approval on each trade, or suggestions only.') }}</p></div>
          <div class="art flex items-end justify-center overflow-hidden pt-6" aria-hidden="true"><div class="w-64 rounded-[2.25rem] border-[7px] border-[#0d0f26] bg-card p-4 pt-3 text-sm text-card-foreground"><i class="mx-auto mb-4 block h-4 w-16 rounded-full bg-[#0d0f26]" /><p class="font-display text-base font-semibold">{{ L('بانتظار موافقتك', 'Waiting for your approval') }}</p><p class="text-muted-foreground">{{ L('مثال: شراء ورقي', 'Example: paper buy') }}</p><div class="mt-3 flex justify-between border-y py-2"><span>{{ L('المخاطرة', 'Risk') }}</span><b class="num">0.5%</b></div><div class="mt-3 grid grid-cols-2 gap-2 pb-2 text-center font-semibold"><span class="rounded-full bg-brand py-2 text-white">{{ L('موافقة', 'Approve') }}</span><span class="rounded-full border py-2">{{ L('رفض', 'Reject') }}</span></div></div></div>
          <a href="#how">{{ L('اعرف الخطوات الأربع', 'See the four steps') }}<ArrowUpRight aria-hidden="true" /></a>
        </article>
        <article class="tile-lg bg-panel text-panel-foreground">
          <div><h3>{{ L('فحص شرعي يمنع، لا يكتفي بالتنبيه', 'A Sharia screen that blocks, not warns') }}</h3><p>{{ L('إذا لم يجتز السهم، أو كانت معلوماته قديمة أو ناقصة، فلن يُشترى.', 'If a stock fails, or its information is old or missing, it is not bought.') }}</p></div>
          <div class="art grid content-center gap-5"><div v-for="[name, v, max] in METERS" :key="name"><div class="mb-2 flex justify-between gap-4 text-sm"><span>{{ name }}</span><bdi dir="ltr" class="tabular-nums">{{ v }}% / {{ max }}%</bdi></div><div class="h-2 overflow-hidden rounded-full bg-panel-2" role="meter" :aria-label="name" :aria-valuenow="v" aria-valuemin="0" :aria-valuemax="max"><div class="h-full rounded-full bg-sky" :style="{ width: `${v / max * 100}%` }" /></div></div><small class="text-sm text-panel-muted">{{ L('مثال توضيحي لسهم مجتاز، والشريط يمثل الحد كاملًا', 'Worked example of a passing stock; each bar is the whole limit') }}</small></div>
          <a href="#sharia">{{ L('جرّب الفحص', 'Try the screen') }}<ArrowUpRight aria-hidden="true" /></a>
        </article>
      </div>
    </section>

    <section id="features" :class="wrap" class="scroll-mt-20 pb-20 sm:pb-28">
      <h2 class="mx-auto max-w-[24ch] text-center text-4xl leading-tight sm:text-5xl">{{ L('معك من أول اقتراح إلى آخر صفقة', 'With you from first suggestion to last trade') }}</h2>
      <div class="mt-12 grid gap-4 sm:grid-cols-2 lg:mt-16 lg:grid-cols-3 lg:gap-5">
        <article class="tile-sm bg-sky text-[#0d0f26]"><h3>{{ L('خطة لمحفظتك بنسب تحددها', 'A portfolio plan with your own percentages') }}</h3><svg viewBox="0 0 220 120" class="mt-auto h-32 self-end" aria-hidden="true"><rect y="78" width="66" height="42" rx="8" fill="#4254f5" /><rect x="76" y="42" width="66" height="78" rx="8" fill="#4254f5" /><rect x="152" width="66" height="120" rx="8" fill="#0d0f26" /></svg></article>
        <article class="tile-sm border bg-card"><h3 class="flex items-start justify-between gap-3">{{ L('تنبيهات تصلك على تيليجرام', 'Alerts on Telegram') }}<AssetIcon symbol="TELEGRAM" class="mt-1 !size-8" /></h3><ul class="mt-auto grid gap-2.5 font-medium"><li v-for="x in NOTES" :key="x" class="flex items-center gap-3 rounded-full bg-secondary px-4 py-2.5 text-secondary-foreground"><Bell class="size-4 shrink-0" aria-hidden="true" />{{ x }}</li></ul></article>
        <article class="tile-sm bg-brand text-white"><h3>{{ L('حساب مستقل لا يطّلع عليه عميل آخر', 'A separate account no other customer can see') }}</h3><EyeOff class="mt-auto size-24 self-end" :stroke-width="1.25" aria-hidden="true" /></article>
        <article class="tile-sm bg-[#6a45e0] text-white"><h3>{{ L('دخول بخطوتين', 'Two-step sign-in') }}</h3><p>{{ L('رمز إضافي يتغيّر باستمرار يحمي حسابك.', 'An extra code that keeps changing protects your account.') }}</p><div class="mt-auto flex items-center gap-3 self-end" aria-hidden="true"><i v-for="n in 6" :key="n" class="size-4 rounded-full bg-current" :class="n > 4 && 'opacity-40'" /><Lock class="ms-2 size-9" /></div></article>
        <article class="tile-sm bg-secondary text-secondary-foreground"><h3>{{ L('كل اقتراح معه سببه', 'Every suggestion comes with its reason') }}</h3><p>{{ L('ومتى يتغيّر الرأي فيه، قبل أن تقرر.', 'And what would change it, before you decide.') }}</p><svg viewBox="0 0 240 90" class="mt-auto w-full rtl:-scale-x-100" aria-hidden="true"><path d="M8 78C60 78 70 46 116 46S178 14 222 14" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="14" stroke-linecap="round" /><circle cx="222" cy="14" r="12" fill="#ffd32e" /></svg></article>
        <article class="tile-sm bg-panel text-panel-foreground"><h3>{{ L('لا أموال حقيقية ولا أوامر لوسيط', 'No real money, no broker orders') }}</h3><p class="text-panel-muted">{{ L('كل صفقة محاكاة للتعلّم والتجربة.', 'Every trade is a simulation for learning and practice.') }}</p><UserCheck class="mt-auto size-24 self-end text-sky" :stroke-width="1.25" aria-hidden="true" /></article>
      </div>
    </section>

    <section id="tools" class="dusk scroll-mt-16 overflow-hidden text-white">
      <div :class="wrap" class="grid items-center gap-14 py-24 lg:grid-cols-[1fr_1.45fr] lg:py-40">
        <div><h2 class="text-4xl leading-tight sm:text-5xl">{{ L('أدوات لمن يريد أن يرى التفاصيل', 'Tools for people who want the detail') }}</h2><p class="mt-5 max-w-[48ch] text-lg">{{ L('شموع ومؤشرات ومستويات دعم ومقاومة، مع نقاط الدخول والوقف والهدف على الرسم نفسه، وتمارين تختبر قراءتك.', 'Candles, indicators, support and resistance, with entry, stop and target on the chart itself, and practice that tests your reading.') }}</p><div class="mt-8 flex flex-wrap gap-3"><a href="#join" class="inline-flex h-12 items-center rounded-full bg-brand px-7 font-semibold transition-colors hover:bg-brand-deep">{{ L('اطلب دعوة', 'Ask for an invitation') }}</a><a href="#how" class="inline-flex h-12 items-center rounded-full bg-white px-7 font-semibold text-[#0d0f26] transition-colors hover:bg-sun">{{ L('كيف تعمل', 'How it works') }}</a></div></div>
        <div class="laptop px-[4%]"><div class="rounded-t-2xl border-[10px] border-b-0 border-[#05060f] bg-card p-4 text-card-foreground ring-1 ring-white/20 sm:p-6"><div class="mb-4 flex items-center justify-between gap-3 text-sm"><span class="flex items-center gap-2 font-semibold"><BrandMark class="!size-6" />{{ L('التحليل الفني', 'Technical analysis') }}</span><UiBadge tone="warn">{{ L('مثال توضيحي', 'Example') }}</UiBadge></div><LandingChart levels /></div><div class="-mx-[4.5%] h-4 rounded-b-2xl bg-[#2a2e5a]" aria-hidden="true"><i class="mx-auto block h-1.5 w-1/6 rounded-b-lg bg-[#0d0f26]" /></div></div>
      </div>
    </section>

    <section id="how" :class="wrap" class="scroll-mt-20 py-20 sm:py-28">
      <h2 class="mx-auto max-w-[20ch] text-center text-4xl leading-tight sm:text-5xl">{{ L('من الفكرة إلى الصفقة في أربع خطوات', 'From idea to trade in four steps') }}</h2>
      <HowSteps :steps="STEPS" class="mt-12 lg:mt-16" />
    </section>

    <section id="sharia" class="scroll-mt-16 overflow-hidden bg-secondary text-foreground"><div :class="wrap" class="grid items-center gap-14 py-20 sm:py-28 lg:grid-cols-[1.25fr_1fr] lg:gap-20">
      <div class="min-w-0"><h2 class="text-4xl leading-tight sm:text-5xl">{{ L('جرّب الفحص قبل الصفقة', 'Try the check before the trade') }}</h2><p class="mt-4 max-w-[54ch] text-lg">{{ L('أربعة معايير، ثم حدود المخاطر. وما لم يُحسم لا يُشترى، أما البيع فمسموح دائمًا.', 'Four tests, then your risk limits. Anything unresolved is not bought; selling is always allowed.') }}</p>
        <div class="mt-8 overflow-hidden rounded-2xl bg-card p-2 sm:p-4"><UiTable><thead><tr><th>{{ L('المعيار', 'Test') }}</th><th>{{ L('الحد', 'Limit') }}</th><th>{{ L('المصدر', 'Source') }}</th></tr></thead><tbody>
          <tr><td>{{ L('النشاط الأساسي', 'Core business') }}</td><td>{{ L('غير محظور', 'Not excluded') }}</td><td>{{ L('نشاط الشركة المعلن', 'Published business') }}</td></tr>
          <tr><td>{{ L('الدين بفائدة', 'Interest-bearing debt') }}</td><td><span class="num">&lt; 30%</span></td><td>{{ L('من القيمة السوقية', 'of market cap') }}</td></tr>
          <tr><td>{{ L('النقد والأوراق المالية', 'Cash and securities') }}</td><td><span class="num">&lt; 30%</span></td><td>{{ L('من القيمة السوقية', 'of market cap') }}</td></tr>
          <tr><td>{{ L('الدخل غير المباح', 'Impermissible income') }}</td><td><span class="num">&lt; 5%</span></td><td>{{ L('من الإيرادات السنوية', 'of annual revenue') }}</td></tr>
        </tbody></UiTable></div>
        <p class="mt-5 max-w-[65ch] text-sm">{{ L('حدود على نهج معايير أيوفي، ويمكنك جعلها أشد، وتسجيل نتيجة من جهة تثق بها مع اسم المصدر. فحص آلي أولي.', 'Limits in the style of AAOIFI standards. You can make them stricter, and record a result from a source you trust. An automated first check.') }}</p></div>
      <HeroPhone :cases="CASES" :tabs="tabs" />
    </div></section>

    <section id="faq" class="scroll-mt-16"><div :class="wrap" class="grid gap-8 py-20 sm:py-28 lg:grid-cols-[1fr_1.6fr]"><h2 class="text-4xl sm:text-5xl">{{ L('أسئلة شائعة', 'Questions') }}</h2><UiAccordion :items="FAQ" /></div></section>

    <section id="join" class="relative scroll-mt-16 overflow-hidden bg-brand text-white [--ring:#ffd32e]">
      <div class="pointer-events-none absolute inset-x-0 bottom-0 flex h-3/4 items-end" aria-hidden="true"><i v-for="(h, i) in STEPPED" :key="i" class="flex-1 bg-gradient-to-b from-white/10 to-transparent" :style="{ height: h + '%' }" /></div>
      <div :class="wrap" class="relative flex flex-col items-center py-24 text-center sm:py-32">
        <h2 class="display">{{ L('اطلب دعوتك وابدأ بالتجربة', 'Ask for your invitation') }}</h2>
        <p v-if="asked" role="status" class="mt-9 flex items-center gap-3 text-xl font-semibold"><CircleCheck class="size-7 text-sun" aria-hidden="true" />{{ L('وصلنا طلبك. سنراسلك عند توفر مكان.', 'We have your request and will write when a place opens.') }}</p>
        <form v-else class="mt-8 w-full max-w-xl" @submit.prevent="ask"><label class="mb-2 block font-medium" for="ask">{{ L('بريدك الإلكتروني', 'Your e-mail') }}</label><div class="flex flex-col gap-2 rounded-[2rem] bg-white p-2 sm:flex-row sm:rounded-full"><input id="ask" v-model="email" type="email" dir="ltr" autocomplete="email" required class="h-12 min-w-0 flex-1 rounded-full px-5 text-[#0d0f26] max-sm:flex-none"><button type="submit" :disabled="asking" class="h-12 rounded-full bg-sun px-8 font-semibold text-sun-foreground transition-colors hover:bg-[#0d0f26] hover:text-white disabled:opacity-60">{{ L('أرسل الطلب', 'Send request') }}</button></div><p v-if="askError" role="alert" class="mt-3 inline-block rounded-full bg-white px-5 py-2 text-sm font-medium text-[#b42335]">{{ askError }}</p></form>
        <p class="mt-6">{{ L('وصلتك دعوة؟', 'Already invited?') }} <NuxtLink to="/invite" class="font-semibold underline underline-offset-4">{{ L('أنشئ حسابك', 'Create your account') }}</NuxtLink></p>
      </div>
    </section>
  </div>
</template>

<style scoped>
.tile-lg { display: flex; flex-direction: column; min-height: 31rem; padding: 1.75rem; overflow: hidden; border-radius: 1.5rem; }
.tile-lg h3 { font-size: 1.875rem; line-height: 1.4; }
.tile-lg > div:first-child p { margin-top: 0.5rem; max-width: 46ch; font-size: 1rem; }
.tile-lg .art { flex: 1; min-height: 14rem; }
.tile-lg > a { display: inline-flex; align-items: center; align-self: flex-start; gap: 0.5rem; margin-top: 1.5rem; font-weight: 600; text-underline-offset: 4px; }
.tile-lg > a:hover { text-decoration: underline; }
.tile-lg > a svg { width: 1.25rem; height: 1.25rem; }
[dir="rtl"] .tile-lg > a svg { transform: scaleX(-1); }
.tile-sm { display: flex; flex-direction: column; gap: 0.5rem; min-height: 20rem; padding: 1.75rem; overflow: hidden; border-radius: 1.5rem; }
.tile-sm h3 { font-size: 1.5rem; line-height: 1.4; }
@media (min-width: 640px) { .tile-lg { padding: 2.25rem; } }
@media (min-width: 1024px) { .tile-lg { min-height: 33rem; } }
</style>
