<script setup lang="ts">
// an AI assistant asks for access to the research team
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
useHead({ title: () => L('ربط مساعد', 'Connect an assistant') })
const ask = ref<any>(null)
const state = ref<'load' | 'ready' | 'login' | 'refused' | 'failed'>('load')
const busy = ref(false)
const query = () => Object.fromEntries(new URLSearchParams(location.search))
const post = (path: string) => fetch(`/account/connect/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify(query()) })
const loginUrl = ref('/login')
onMounted(async () => {
  loginUrl.value = `/login?next=${encodeURIComponent(location.pathname.replace(/\/$/, '') + location.search)}`
  try {
    const r = await post('check')
    if (r.status === 401) { state.value = 'login'; return }
    if (r.status === 404) { state.value = 'refused'; return }
    if (!r.ok) { state.value = 'failed'; return }
    ask.value = await r.json()
    state.value = 'ready'
  } catch { state.value = 'failed' }
})
async function go(path: 'approve' | 'deny') {
  if (busy.value) return
  busy.value = true
  try {
    const r = await post(path)
    if (!r.ok) { state.value = 'failed'; return }
    const { url } = await r.json()
    if (/^(https:|http:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/])/.test(url)) location.href = url
    else state.value = 'failed'
  } catch { state.value = 'failed' } finally { busy.value = false }
}
</script>

<template>
  <div class="mx-auto w-full max-w-md px-4 py-14">
    <section class="rise rounded-3xl border bg-card p-6 sm:p-8">
      <h1 class="text-2xl">{{ L('ربط مساعد بفريق التحليل', 'Connect an assistant to the research team') }}</h1>
      <p v-if="state === 'load'" class="muted mt-4">…</p>
      <template v-else-if="state === 'login'"><p class="mt-4">{{ L('سجّل الدخول أولًا، ثم نكمل الربط.', 'Sign in first, then we continue.') }}</p><a :href="loginUrl" class="mt-6 inline-flex h-11 items-center rounded-full bg-primary px-6 font-semibold text-primary-foreground">{{ L('تسجيل الدخول', 'Sign in') }}</a></template>
      <p v-else-if="state === 'refused'" class="mt-4">{{ L('هذا الربط متاح لصاحب المنصة فقط.', 'Only the owner of the platform can do this.') }}</p>
      <p v-else-if="state === 'failed'" class="mt-4">{{ L('تعذّر إكمال الربط. ابدأ من جديد من المساعد.', 'This could not be completed. Start again from the assistant.') }}</p>
      <template v-else>
        <p class="mt-4"><b><bdi>{{ ask.name }}</bdi></b> {{ L('يطلب الوصول إلى فريق التحليل في حسابك.', 'asks for access to the research team in your account.') }}</p>
        <p class="small muted mt-2">{{ L('سيعود إلى:', 'It will return to:') }} <bdi dir="ltr"><b>{{ ask.host }}</b></bdi></p>
        <p class="small muted mt-1">{{ L('الاسم يختاره المساعد بنفسه، فتأكد من العنوان.', 'The assistant chose its own name, so check the address.') }}</p>
        <ul class="mt-5 grid gap-2 ps-5"><li>{{ L('يقرأ أسهمك المتابعة ومعلوماتها وأخبارها', 'Reads your followed stocks, their facts and news') }}</li><li>{{ L('يحفظ ملاحظات وتقارير التحليل', 'Saves analysis notes and reports') }}</li><li>{{ L('لا يستطيع التداول أو تغيير الإعدادات أو رؤية حسابات أخرى', 'Cannot trade, change settings or see other accounts') }}</li></ul>
        <div class="mt-7 flex flex-wrap gap-3"><UiButton variant="default" size="lg" :disabled="busy" @click="go('approve')">{{ L('أوافق', 'Allow') }}</UiButton><UiButton variant="outline" size="lg" :disabled="busy" @click="go('deny')">{{ L('رفض', 'Refuse') }}</UiButton></div>
      </template>
    </section>
  </div>
</template>
