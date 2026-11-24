<script setup lang="ts">
// try the platform without an account
import { CircleCheck } from '@lucide/vue'
import { plain } from '~/lib/plain'
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
useHead({ title: () => L('تجربة فرصة', 'Try Forsah') })
const s = ref<any>(null)
const busy = ref(false)
const error = ref('')
const POINTS = computed(() => [L('محفظة ورقية فيها 10,000 دولار افتراضي', 'A paper wallet with 10,000 practice dollars'), L('أسعار تجريبية غير حقيقية، لا تطابق السوق', 'Invented demo prices that do not match the market'), L('كل الصفحات: الفرص والأوامر والتحليل والأهداف', 'Every page: opportunities, orders, analysis and goals'), L('مدتها ساعتان، أو نصف ساعة بلا استخدام، ثم تُمسح', 'Lasts two hours, or half an hour unused, then it is erased')])
async function go() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await fetch('/demo/start', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: '{}' })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error)
    location.href = '/app'
  } catch (e: any) { error.value = plain.error(e.message || '', lang.value === 'ar'); busy.value = false }
}
onMounted(async () => { try { const r = await fetch('/demo/status'); if (r.ok) s.value = await r.json() } catch { /* the button still works */ } })
</script>

<template>
  <section class="night relative flex min-h-[42rem] items-center overflow-hidden text-white [--ring:#ffd32e]">
    <NightField />
    <div class="relative mx-auto w-full max-w-3xl px-4 py-16 text-center">
      <h1 class="display">{{ L('جرّب فرصة', 'Try Forsah') }} <span class="block text-sun">{{ L('بلا حساب', 'without an account') }}</span></h1>
      <ul class="mx-auto mt-8 grid max-w-xl !list-none gap-3 !p-0 text-start text-lg"><li v-for="p in POINTS" :key="p" class="flex items-start gap-3"><CircleCheck class="mt-1 size-5 shrink-0 text-sun" aria-hidden="true" />{{ p }}</li></ul>
      <div class="mt-10 flex flex-wrap justify-center gap-3">
        <a v-if="s?.signedIn" href="/app" class="inline-flex h-13 items-center rounded-full bg-sun px-9 text-lg font-semibold text-sun-foreground hover:bg-white">{{ L('أنت مسجّل الدخول. افتح حسابك', 'You are signed in. Open your account') }}</a>
        <button v-else type="button" class="inline-flex h-13 items-center rounded-full bg-sun px-9 text-lg font-semibold text-sun-foreground transition-colors hover:bg-white disabled:opacity-60" :disabled="busy || s?.available === false" @click="go">{{ busy ? L('نجهّز محفظتك…', 'Preparing your wallet…') : s?.running ? L('تابع تجربتك', 'Continue your demo') : L('ابدأ التجربة', 'Start the demo') }}</button>
      </div>
      <p v-if="s?.available === false" class="mt-5" role="status">{{ L('التجربة غير متاحة الآن.', 'The demo is not available now.') }}</p>
      <p v-if="error" class="mx-auto mt-5 w-fit rounded-2xl bg-white px-5 py-3 text-[#bd2638]" role="alert">{{ error }}</p>
      <p class="mt-8 text-sm text-white">{{ L('تداول ورقي (محاكاة) فقط. لا أموال حقيقية ولا نصيحة استثمارية.', 'Paper trading (simulation) only. No real money and no investment advice.') }}</p>
    </div>
  </section>
</template>
