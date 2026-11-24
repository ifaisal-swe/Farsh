<script setup lang="ts">
import { plain } from '~/lib/plain'
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const email = ref('')
const password = ref('')
const code = ref('')
const step = ref<'password' | 'code'>('password')
const error = ref('')
const busy = ref(false)
// the code is asked for only after the password is right, and only when the account uses one
async function send() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    const r = await fetch('/account/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify({ email: email.value, password: password.value, ...(step.value === 'code' ? { code: code.value } : {}) }) })
    if (r.ok) { location.href = '/app'; return }
    const { error: m } = await r.json().catch(() => ({ error: '' }))
    if (m === 'Two-factor code required' && step.value === 'password') { step.value = 'code'; code.value = ''; await nextTick(); document.getElementById('f-code')?.focus(); return }
    error.value = plain.error(m, lang.value === 'ar')
    if (step.value === 'code') { code.value = ''; await nextTick(); document.getElementById('f-code')?.focus() }
  } catch { error.value = plain.error('', lang.value === 'ar') } finally { busy.value = false }
}
watch(code, (v) => { const d = v.replace(/[٠-٩]/g, (x) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(x))).replace(/\D/g, '').slice(0, 6); if (d !== v) { code.value = d; return } if (d.length === 6) send() })
function back() { step.value = 'password'; password.value = ''; code.value = ''; error.value = '' }
</script>

<template>
  <div class="mx-auto w-full max-w-md px-4 py-14">
    <form class="rise rounded-3xl border bg-card p-6 sm:p-8" @submit.prevent="send">
      <template v-if="step === 'password'">
        <h1 class="text-2xl">{{ L('تسجيل الدخول', 'Sign in') }}</h1>
        <div class="mt-6 grid gap-4">
          <label class="grid gap-1.5 text-sm font-medium" for="f-email">{{ L('البريد الإلكتروني', 'E-mail') }}<UiInput id="f-email" v-model="email" name="email" type="email" autocomplete="username" required dir="ltr" class="h-11 w-full font-normal" /></label>
          <label class="grid gap-1.5 text-sm font-medium" for="f-password">{{ L('كلمة المرور', 'Password') }}<UiInput id="f-password" v-model="password" name="password" type="password" autocomplete="current-password" required dir="ltr" class="h-11 w-full font-normal" /></label>
        </div>
      </template>
      <div v-else class="tick">
        <h1 class="text-2xl">{{ L('رمز التحقق', 'Verification code') }}</h1>
        <p class="mt-1 text-sm text-muted-foreground">{{ L('أدخل الأرقام الستة من تطبيق المصادقة.', 'Enter the six digits from your authenticator app.') }}</p>
        <UiInput id="f-code" v-model="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required dir="ltr" placeholder="000000" :aria-label="L('رمز التحقق', 'Verification code')" class="mt-6 h-14 w-full text-center font-display text-2xl tracking-[0.4em]" />
      </div>
      <p v-if="error" role="alert" class="mt-4 text-sm text-destructive">{{ error }}</p>
      <UiButton type="submit" variant="default" size="lg" class="mt-6 w-full" :disabled="busy">{{ step === 'password' ? L('دخول', 'Sign in') : L('تأكيد', 'Confirm') }}</UiButton>
      <div class="mt-4 text-center text-sm text-muted-foreground"><template v-if="step === 'password'">{{ L('نسيت كلمة المرور؟ اطلب رابطًا جديدًا من فريق فرصة.', 'Forgot your password? Ask the Forsah team for a new link.') }}</template><button v-else type="button" class="font-medium text-primary hover:underline" @click="back">{{ L('الرجوع', 'Back') }}</button></div>
    </form>
    <p class="mt-5 text-center">{{ L('ليس لديك حساب؟', 'No account?') }} <NuxtLink to="/demo" class="font-semibold text-primary underline">{{ L('جرّب فرصة', 'Try Forsah') }}</NuxtLink></p>
  </div>
</template>
