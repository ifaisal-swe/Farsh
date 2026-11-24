<script setup lang="ts">
// The public brand kit. Rules come from docs/brand. The Arabic and English logos never share one space, so the page shows the logo of its language.
import { Check, Copy, Download, FileText, X } from '@lucide/vue'
const { lang } = useLang()
const L = (a: string, e: string) => (lang.value === 'ar' ? a : e)
useHead({ title: () => L('هوية فرصة', 'Forsah brand kit') })
const LOGOS = computed(() => [[`forsah-${lang.value}.svg`, L('على الأبيض', 'On white'), '#ffffff', false], [`forsah-${lang.value}-white.svg`, L('على الكحلي', 'On navy'), '#0d0f26', true], [`forsah-${lang.value}.svg`, L('على الأصفر', 'On yellow'), '#ffd32e', false]] as [string, string, string, boolean][])
const MARKS = computed(() => [['forsah-icon.svg', L('الملوّنة', 'Colour')], ['forsah-icon-ink.svg', L('الحبر', 'Ink')], ['forsah-icon-sun.svg', L('الشمس', 'Sun')], ['forsah-mark.svg', L('الحرف الملوّن', 'Colour mark')], ['forsah-mark-mono.svg', L('الحرف أحادي اللون', 'One-colour mark')]] as [string, string][])
const COLORS = computed(() => [[L('نيلي فرصة', 'Forsah indigo'), '#4254F5', L('الأساسي', 'Primary'), true], [L('أصفر الشمس', 'Sun yellow'), '#FFD32E', L('الفعل والنقطة', 'Action and the dot'), false], [L('سماوي', 'Sky'), '#6CBCFF', L('مساند', 'Support'), false], [L('بنفسجي', 'Violet'), '#6A45E0', L('مساند', 'Support'), true], [L('كحلي', 'Navy'), '#0D0F26', L('الأقسام الداكنة', 'Dark sections'), true], [L('أبيض', 'White'), '#FFFFFF', L('البطاقات', 'Cards'), false]] as [string, string, string, boolean][])
const ICONS = computed(() => [['trending-up', L('سعر', 'Price')], ['chart-candlestick', L('شموع', 'Candles')], ['sparkles', L('اقتراح', 'Suggestion')], ['newspaper', L('خبر', 'News')], ['shield-check', L('الفحص الشرعي', 'Sharia screen')], ['scale', L('حدود المخاطر', 'Risk limits')], ['circle-check', L('مجتاز', 'Pass')], ['ban', L('ممنوع', 'Blocked')], ['triangle-alert', L('غير محسوم', 'Unresolved')], ['hand', L('موافقتك', 'Your approval')], ['target', L('الهدف', 'Target')], ['wallet', L('المحفظة', 'Portfolio')], ['bell', L('تنبيه', 'Alert')], ['clock', L('على مدار الساعة', 'Around the clock')], ['history', L('السجل', 'History')], ['landmark', L('السوق', 'Market')], ['bitcoin', L('عملات رقمية', 'Crypto')], ['lock', L('دخول بخطوتين', 'Two-step sign-in')], ['eye-off', L('الخصوصية', 'Privacy')], ['user-check', L('الحساب', 'Account')], ['settings', L('الإعدادات', 'Settings')], ['file-text', L('تقرير', 'Report')], ['download', L('تنزيل', 'Download')], ['hand-coins', L('استثمار', 'Investing')]] as [string, string][])
const DO = computed(() => [L('اترك حول الشعار مسافة تساوي ضعف قطر النقطة.', 'Leave clear space of twice the dot’s diameter around the logo.'), L('لا يقل عرض الشعار عن 72 بكسل، والأيقونة عن 16.', 'Keep the logo at least 72 px wide and the icon at least 16.'), L('اجعل النيلي يقود، والأصفر في عُشر المساحة على الأكثر.', 'Let indigo lead, and keep yellow to a tenth of the area at most.')])
const DONT = computed(() => [L('لا تُمِل الشعار ولا تغيّر نسبه أو ألوانه.', 'Do not tilt, stretch or recolour the logo.'), L('لا تضف ظلًا أو إطارًا ولا تخفّف شفافيته.', 'Do not add a shadow or frame, or fade it.'), L('لا تفصل النقطة عن الحرف ولا تكررها.', 'Do not detach or repeat the dot.')])
const copied = ref('')
const said = ref('')
let timer: any
async function copy(hex: string) {
  try { await navigator.clipboard.writeText(hex); copied.value = hex; said.value = L(`نُسخ ${hex}`, `Copied ${hex}`) } catch { said.value = L(`تعذّر النسخ. الرمز ${hex}`, `Could not copy. The code is ${hex}`) }
  clearTimeout(timer)
  timer = setTimeout(() => { copied.value = ''; said.value = '' }, 2500)
}
onBeforeUnmount(() => clearTimeout(timer))
const wrap = 'mx-auto max-w-7xl px-4 sm:px-6'
</script>

<template>
  <div>
    <section class="sunrise text-white"><div :class="wrap" class="flex min-h-[30rem] flex-wrap items-end justify-between gap-8 pt-40 pb-16">
      <div><h1 class="display">{{ L('هوية فرصة', 'Forsah brand kit') }}</h1><p class="mt-3 text-lg">{{ L('الشعار والألوان والخطوط والأيقونات، جاهزة للاستخدام.', 'Logo, colours, type and icons, ready to use.') }}</p></div>
      <div class="flex flex-wrap gap-3">
        <a href="/brand/forsah-brand-kit.zip" download class="inline-flex h-12 items-center gap-2 rounded-full bg-sun px-7 font-semibold text-sun-foreground transition-colors hover:bg-white"><Download class="size-4" aria-hidden="true" />{{ L('حمّل كل الملفات', 'Download everything') }}</a>
        <a href="/brand/forsah-brand-identity-ar.pdf" target="_blank" rel="noopener" class="inline-flex h-12 items-center gap-2 rounded-full bg-white px-7 font-semibold text-[#0d0f26] transition-colors hover:bg-sun"><FileText class="size-4" aria-hidden="true" />{{ L('دليل الهوية PDF', 'Guidelines PDF (Arabic)') }}</a>
      </div>
    </div></section>

    <div :class="wrap" class="grid gap-20 py-16 sm:gap-24 sm:py-24">
      <section aria-labelledby="b-logo"><h2 id="b-logo" class="text-3xl sm:text-4xl">{{ L('الشعار', 'Logo') }}</h2>
        <ul class="mt-6 grid gap-4 md:grid-cols-3"><li v-for="[file, name, bg, dark] in LOGOS" :key="name"><a :href="`/brand/${file}`" download class="relative flex min-h-60 items-center justify-center rounded-3xl border" :class="dark ? 'text-white' : 'text-[#0d0f26]'" :style="{ background: bg }"><img :src="`/brand/${file}`" :alt="L('شعار فرصة', 'Forsah logo')" class="w-48" width="192" height="57"><span class="absolute inset-x-5 bottom-4 flex items-center justify-between text-sm">{{ name }}<span class="num inline-flex items-center gap-1.5">SVG<Download class="size-4" aria-hidden="true" /></span></span></a></li></ul>
        <ul class="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5"><li v-for="[file, name] in MARKS" :key="file"><a :href="`/brand/${file}`" download class="grid justify-items-center gap-4 rounded-3xl border bg-white px-4 pt-8 pb-5 text-[#0d0f26]"><img :src="`/brand/${file}`" alt="" class="size-20" width="80" height="80"><span class="inline-flex items-center gap-2 text-sm">{{ name }}<Download class="size-4" aria-hidden="true" /></span></a></li></ul>
      </section>

      <section aria-labelledby="b-rules"><h2 id="b-rules" class="text-3xl sm:text-4xl">{{ L('قواعد الشعار', 'Logo rules') }}</h2>
        <div class="mt-6 grid gap-4 md:grid-cols-2"><div class="rounded-3xl bg-secondary p-7 text-secondary-foreground"><h3 class="text-xl">{{ L('افعل', 'Do') }}</h3><ul class="mt-4 grid gap-3"><li v-for="r in DO" :key="r" class="flex gap-3"><Check class="mt-1 size-4 shrink-0" aria-hidden="true" />{{ r }}</li></ul></div><div class="rounded-3xl border bg-card p-7"><h3 class="text-xl">{{ L('تجنّب', 'Avoid') }}</h3><ul class="mt-4 grid gap-3"><li v-for="r in DONT" :key="r" class="flex gap-3"><X class="mt-1 size-4 shrink-0 text-destructive" aria-hidden="true" />{{ r }}</li></ul></div></div>
      </section>

      <section aria-labelledby="b-color"><h2 id="b-color" class="text-3xl sm:text-4xl">{{ L('الألوان', 'Colours') }}</h2><p class="mt-2 text-muted-foreground">{{ L('اضغط على اللون لنسخ رمزه.', 'Select a colour to copy its code.') }}</p>
        <ul class="mt-6 grid grid-cols-2 overflow-hidden rounded-3xl border sm:grid-cols-3 lg:grid-cols-[2.4fr_1.2fr_1fr_1fr_1.2fr_1fr]"><li v-for="[name, hex, role, dark] in COLORS" :key="hex"><button type="button" class="flex h-full min-h-56 w-full flex-col justify-end p-5 text-start -outline-offset-4!" :class="dark ? 'text-white' : 'text-[#0d0f26]'" :style="{ background: hex, outlineColor: 'currentColor' }" :aria-label="L(`انسخ لون ${name} ${hex}`, `Copy ${name} ${hex}`)" @click="copy(hex)"><span class="font-display text-lg font-semibold">{{ name }}</span><span class="num inline-flex items-center gap-1.5 self-start">{{ hex }}<component :is="copied === hex ? Check : Copy" class="size-4" aria-hidden="true" /></span><span class="text-sm">{{ role }}</span></button></li></ul>
        <p class="mt-3 min-h-6 text-sm text-muted-foreground" role="status">{{ said }}</p>
      </section>

      <section aria-labelledby="b-type"><h2 id="b-type" class="text-3xl sm:text-4xl">{{ L('الخطوط', 'Type') }}</h2>
        <div class="mt-6 grid gap-4 md:grid-cols-2"><div class="rounded-3xl bg-brand p-8 text-white"><p class="font-display text-7xl leading-normal font-bold" lang="ar" dir="rtl">أ ب ت <span class="num">24</span></p><h3 class="num mt-6 text-2xl">Readex Pro</h3><p>{{ L('للعناوين والأرقام الكبيرة، 600 و700', 'Headings and large numbers, 600 and 700') }}</p></div><div class="rounded-3xl border bg-card p-8"><p class="text-7xl leading-normal font-semibold" lang="ar" dir="rtl">أ ب ت ث</p><h3 class="num mt-6 text-2xl">IBM Plex Sans Arabic</h3><p class="text-muted-foreground">{{ L('للنصوص والواجهات والجداول، 400 و600', 'Text, interface and tables, 400 and 600') }}</p></div></div>
      </section>

      <section aria-labelledby="b-icons"><h2 id="b-icons" class="text-3xl sm:text-4xl">{{ L('الأيقونات', 'Icons') }}</h2><p class="mt-2 text-muted-foreground">{{ L('اضغط على الأيقونة لتنزيلها بصيغة SVG. من مجموعة', 'Select an icon to download its SVG. From the') }} <a href="https://lucide.dev" target="_blank" rel="noopener" class="font-medium text-primary underline underline-offset-4">Lucide</a>{{ L('، برخصة ISC.', ' set, ISC licence.') }}</p>
        <ul class="mt-6 grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8"><li v-for="[file, name] in ICONS" :key="file"><a :href="`/brand/icons/${file}.svg`" download class="grid h-full justify-items-center gap-3 rounded-2xl border bg-white px-2 py-6 text-center text-sm text-[#0d0f26] transition-colors hover:border-[#4254f5]"><img :src="`/brand/icons/${file}.svg`" alt="" class="size-9" width="36" height="36">{{ name }}</a></li></ul>
      </section>
    </div>
  </div>
</template>
