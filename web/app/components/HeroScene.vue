<script setup lang="ts">
// One paper trade, played as a story: watch, propose, check, approve. Illustrative: no prices or results.
// It runs only while on screen, can be paused, and stands still for visitors who ask for less motion.
import { Bell, CircleCheck, Hand, Pause, Play, ShieldCheck, Sparkles } from '@lucide/vue'
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const TIME = [3200, 3000, 4200, 4400] // ms per stage
const CHECKS = computed(() => [[L('نشاط الشركة', 'Business activity'), L('أشباه موصلات', 'Semiconductors')], [L('الدين / القيمة السوقية', 'Debt / market cap'), '8.4% < 30%'], [L('دخل غير مباح', 'Impermissible income'), '1.2% < 5%'], [L('المخاطرة على الصفقة', 'Risk on this trade'), '0.5%']] as [string, string][])
const WATCH = [['AAPL', 'M0 22C10 20 14 12 24 14S40 20 50 10 66 8 80 3'], ['NVDA', 'M0 18C12 22 18 10 30 12S48 18 56 12 70 12 80 5'], ['BTC', 'M0 8C10 4 18 16 28 14S44 6 54 14 70 20 80 12']] as [string, string][]
const stage = ref(0)
const run = ref(0) // restarts the stage's animations
const checked = ref(0)
const placed = ref(false)
const playing = ref(false)
const still = ref(false)
const el = ref<HTMLElement | null>(null)
let timers: any[] = []
let seen = false
const clear = () => { timers.forEach(clearTimeout); timers = [] }
const later = (ms: number, f: () => void) => timers.push(setTimeout(f, ms))
function show(i: number) {
  clear()
  stage.value = i
  run.value++
  const live = playing.value && seen
  checked.value = i < 2 ? 0 : i === 2 && live ? 0 : CHECKS.value.length
  placed.value = i === 3 && !live
  if (!live) return
  if (i === 2) CHECKS.value.forEach((_, n) => later(500 + n * 650, () => { checked.value = n + 1 }))
  if (i === 3) later(2000, () => { placed.value = true })
  later(TIME[i]!, () => show((i + 1) % 4))
}
function toggle() { playing.value = !playing.value; show(stage.value) }
let io: IntersectionObserver | null = null
onMounted(() => {
  still.value = matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)
  if (still.value) return show(3)
  playing.value = true
  io = new IntersectionObserver(([e]) => { const now = !!e?.isIntersecting; if (now === seen) return; seen = now; if (now) show(stage.value); else clear() }, { threshold: 0.15 })
  io.observe(el.value!)
})
onBeforeUnmount(() => { io?.disconnect(); clear() })
</script>

<template>
  <div ref="el" class="relative mx-auto h-[26rem] w-full max-w-6xl text-start sm:h-[28rem]">
    <div class="side start-0 hidden lg:block" :class="{ on: stage === 2 }" style="--r: 4deg" aria-hidden="true">
      <p class="flex items-center gap-2 font-display text-lg font-semibold"><ShieldCheck class="size-6 text-up" />{{ L('فحص قبل الشراء', 'Checked before buying') }}</p>
      <ul class="mt-3"><li v-for="([name, value], i) in CHECKS" :key="i" class="flex items-center gap-2.5 border-t py-2.5 text-sm"><span class="relative size-5 shrink-0"><i class="absolute inset-0 rounded-full border-2" :class="stage === 2 && checked === i && 'spin'" /><CircleCheck class="tick-in absolute inset-0 size-5 bg-card text-up" :class="{ yes: checked > i }" /></span><span class="flex-1">{{ name }}</span><bdi class="font-semibold tabular-nums transition-opacity duration-300" :class="checked > i ? 'opacity-100' : 'opacity-25'">{{ value }}</bdi></li></ul>
    </div>

    <div class="side end-0 hidden lg:block" :class="{ on: stage === 3 }" style="--r: -4deg" aria-hidden="true">
      <p class="flex items-center gap-2 font-display text-lg font-semibold"><Hand class="size-6 text-primary" />{{ L('بانتظار موافقتك', 'Waiting for your approval') }}</p>
      <p class="mt-1.5 text-sm text-muted-foreground">{{ L('شراء ورقي مع وقف خسارة وهدف', 'A paper buy with a stop and a target') }}</p>
      <LandingChart class="my-3" />
      <div class="relative grid grid-cols-2 gap-2 text-center text-sm font-semibold"><span class="rounded-full bg-brand py-2.5 text-white" :class="stage === 3 && playing && 'press'">{{ L('موافقة', 'Approve') }}</span><span class="rounded-full border py-2.5">{{ L('رفض', 'Reject') }}</span><span class="done absolute inset-0 flex items-center justify-center gap-2 rounded-full bg-sun text-sun-foreground" :class="{ yes: placed }"><CircleCheck class="size-5" />{{ L('نُفّذ الشراء الورقي', 'Paper buy placed') }}</span></div>
    </div>

    <div class="phone absolute inset-x-0 top-0 z-10 mx-auto w-[19.5rem] rounded-[3rem] border-[9px] border-[#05060f] bg-card px-5 pt-3 pb-8 text-card-foreground ring-2 ring-white/25 sm:w-[21.5rem]" role="img" :aria-label="L('شاشة توضيحية من تطبيق فرصة', 'Illustrative screen of the Forsah app')">
      <i class="mx-auto block h-6 w-24 rounded-full bg-[#05060f]" />
      <div class="mt-4 flex items-center justify-between gap-2"><span class="flex items-center gap-2 font-display text-lg font-semibold whitespace-nowrap"><BrandMark class="!size-8" />{{ L('محفظتك الورقية', 'Paper portfolio') }}</span><UiBadge tone="warn">{{ L('مثال', 'Example') }}</UiBadge></div>
      <div class="relative mt-4 h-40 overflow-hidden rounded-2xl bg-brand text-white">
        <Transition name="face">
          <div v-if="stage === 0" key="0" class="face"><p class="font-semibold">{{ L('نراقب الأسعار والأخبار', 'Watching prices and news') }}</p><svg :key="run" viewBox="0 0 280 76" class="mt-auto w-full" aria-hidden="true"><path d="M2 66C26 60 38 46 62 50S104 68 126 54 158 22 186 34 222 46 242 26 262 14 270 12" pathLength="1" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" class="hero-line" /><circle cx="270" cy="12" r="7" fill="#ffd32e" class="hero-dot" /></svg></div>
          <div v-else-if="stage === 1" key="1" class="face"><p class="flex items-center gap-2 font-semibold"><Sparkles class="size-5 text-sun" />{{ L('اقتراح شراء جديد', 'A new buy is suggested') }}</p><p class="mt-2 text-sm">{{ L('السبب: اختراق مستوى مقاومة', 'Reason: broke a resistance level') }}</p><p class="text-sm">{{ L('يتغيّر الرأي إذا عاد تحته', 'It changes if price falls back') }}</p><span class="mt-auto h-1.5 w-full overflow-hidden rounded-full bg-white/25"><i :key="run" class="sweep block h-full rounded-full bg-sun" /></span></div>
          <div v-else-if="stage === 2" key="2" class="face"><p class="font-semibold">{{ L('الفحص الشرعي وحدود المخاطر', 'Sharia screen and risk limits') }}</p><p class="num mt-auto font-display text-5xl font-bold">{{ checked }} / 4</p><span class="mt-3 grid grid-cols-4 gap-1.5"><i v-for="n in 4" :key="n" class="h-2 rounded-full transition-colors duration-500" :class="checked >= n ? 'bg-sun' : 'bg-white/25'" /></span></div>
          <div v-else key="3" class="face items-center justify-center text-center"><component :is="placed ? CircleCheck : Hand" :key="String(placed)" class="bump size-14" :class="placed && 'text-sun'" /><p class="mt-3 text-lg font-semibold">{{ placed ? L('نُفّذ الشراء الورقي', 'Paper buy placed') : L('هل توافق على الصفقة؟', 'Do you approve this trade?') }}</p></div>
        </Transition>
      </div>
      <ul class="mt-2"><li v-for="([x, d], i) in WATCH" :key="x" class="flex items-center gap-3 border-b py-3"><span class="inline-flex size-9 shrink-0 items-center justify-center rounded-full border bg-white"><AssetIcon :symbol="x" /></span><span class="flex-1 leading-tight"><b class="block font-semibold"><bdi>{{ x }}</bdi></b><small class="text-muted-foreground">{{ L('تحت المراقبة', 'Being watched') }}</small></span><svg :key="run" viewBox="0 0 80 26" class="h-7 w-20" aria-hidden="true"><path :d="d" pathLength="1" fill="none" stroke="var(--primary)" stroke-width="2.5" stroke-linecap="round" :class="stage === 0 && 'hero-line'" :style="{ animationDelay: `${i * 250}ms` }" /></svg></li></ul>
    </div>

    <span class="alert absolute top-24 z-20 hidden items-center gap-2 rounded-full bg-sun px-5 py-2.5 font-semibold whitespace-nowrap text-sun-foreground sm:inline-flex" :class="{ yes: placed }" aria-hidden="true"><Bell class="size-5" />{{ L('وصلك تنبيه', 'New alert') }}</span>

    <button v-if="!still" type="button" class="absolute end-0 bottom-4 z-20 inline-flex size-10 items-center justify-center rounded-full bg-[#0d0f26]/60 text-white transition-colors hover:bg-[#0d0f26] [--ring:#ffd32e]" :aria-label="playing ? L('أوقف الحركة', 'Pause animation') : L('شغّل الحركة', 'Play animation')" @click="toggle"><component :is="playing ? Pause : Play" class="size-4" /></button>
  </div>
</template>

<style scoped>
.side { position: absolute; top: 4rem; width: 23.5rem; padding: 1.5rem; border-radius: 1.75rem; background: var(--card); color: var(--card-foreground); rotate: var(--r); transition: translate 0.7s cubic-bezier(0.34, 1.4, 0.64, 1), rotate 0.7s cubic-bezier(0.22, 1, 0.36, 1), scale 0.7s cubic-bezier(0.22, 1, 0.36, 1); scale: 0.94; animation: side-in 1s cubic-bezier(0.22, 1, 0.36, 1) 0.5s both; }
[dir="ltr"] .side { rotate: calc(var(--r) * -1); }
[dir] .side.on { rotate: 0deg; scale: 1.04; translate: 0 -1.5rem; }
@keyframes side-in { from { opacity: 0; transform: translateY(5rem); } }
.face { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 1rem; }
.face-enter-active, .face-leave-active { transition: transform 0.55s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.35s; }
.face-enter-from { transform: translateY(100%); opacity: 0; }
.face-leave-to { transform: translateY(-100%); opacity: 0; }
.hero-line { stroke-dasharray: 1; animation: draw 1.6s ease-out both; }
.hero-dot { transform-box: fill-box; transform-origin: center; animation: pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) 1.5s both, beat 1.2s ease-in-out 2s 2; }
.bump { animation: pop-in 0.5s cubic-bezier(0.34, 1.56, 0.64, 1) both; }
@keyframes pop-in { from { transform: scale(0); } }
@keyframes beat { 50% { transform: scale(1.45); } }
.sweep { transform-origin: left; animation: grow 2.4s ease-in-out both; }
[dir="rtl"] .sweep { transform-origin: right; }
@keyframes grow { from { transform: scaleX(0); } }
.spin { border-top-color: var(--primary); animation: turn 0.65s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }
.tick-in { scale: 0; border-radius: 99px; transition: scale 0.4s cubic-bezier(0.34, 1.7, 0.64, 1); }
.tick-in.yes { scale: 1; }
.press { animation: press 0.5s ease-in-out 1.45s; }
@keyframes press { 50% { transform: scale(0.88); } }
.done { opacity: 0; scale: 0.8; transition: opacity 0.3s, scale 0.45s cubic-bezier(0.34, 1.56, 0.64, 1); }
.done.yes { opacity: 1; scale: 1; }
.alert { inset-inline-start: calc(50% + 8.5rem); opacity: 0; translate: 0 1.5rem; scale: 0.7; transition: opacity 0.3s, translate 0.5s cubic-bezier(0.34, 1.56, 0.64, 1), scale 0.5s cubic-bezier(0.34, 1.56, 0.64, 1); }
.alert.yes { opacity: 1; translate: 0 0; scale: 1; }
@media (min-width: 1024px) { .alert { top: -0.5rem; } }
</style>
