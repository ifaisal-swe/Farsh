<script setup lang="ts">
import { plain } from '~/lib/plain'
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const d = ref<any>(null)
const email = ref('')
const link = ref('')
const error = ref('')
const busy = ref(false)
async function call(url: string, body?: any) {
  const r = await fetch(url, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify(body) } : {})
  const x = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(plain.error(x.error || '', lang.value === 'ar'))
  return x
}
const load = async () => { d.value = await call('/admin/data') }
async function run(fn: () => Promise<any>) { busy.value = true; error.value = ''; try { await fn(); await load() } catch (e: any) { error.value = e.message } finally { busy.value = false } }
const inviteTo = (to: string) => run(async () => { link.value = `${location.origin}/invite#${(await call('/admin/invite', { email: to })).token}` })
const invite = async () => { await inviteTo(email.value); if (!error.value) email.value = '' }
const reset = (id: string) => run(async () => { link.value = `${location.origin}/reset#${(await call('/admin/reset', { id })).token}` })
onMounted(() => run(async () => {}))
</script>

<template>
  <div class="mx-auto max-w-6xl px-4 py-10 sm:px-6">
    <h1 class="text-3xl">{{ L('الحسابات والدعوات', 'Accounts and invitations') }}</h1>
    <p v-if="error" role="alert" class="mt-3 text-destructive">{{ error }}</p>
    <UiCard class="mt-6"><form class="flex flex-wrap items-end gap-3" @submit.prevent="invite"><label class="grid gap-1.5 text-sm font-medium" for="inv">{{ L('دعوة بريد إلكتروني', 'Invite an e-mail') }}<UiInput id="inv" v-model="email" type="email" dir="ltr" required class="w-72" /></label><UiButton type="submit" variant="default" :disabled="busy">{{ L('إنشاء دعوة', 'Create invitation') }}</UiButton></form>
      <div v-if="link" class="mt-4 rounded-md bg-muted p-3"><p class="text-sm text-muted-foreground">{{ L('أرسل هذا الرابط بنفسك. لن يظهر مرة أخرى.', 'Send this link yourself. It will not be shown again.') }}</p><bdi dir="ltr" class="block break-all font-medium">{{ link }}</bdi></div></UiCard>
    <UiCard v-if="d"><UiTable><thead><tr><th>{{ L('البريد', 'E-mail') }}</th><th>{{ L('الدور', 'Role') }}</th><th>{{ L('الحالة', 'Status') }}</th><th>{{ L('النشاط', 'Activity') }}</th><th /></tr></thead><tbody>
      <tr v-for="u in d.users" :key="u.id"><td><bdi>{{ u.email }}</bdi></td><td>{{ u.role === 'ADMIN' ? L('مدير', 'Manager') : L('عميل', 'Customer') }}</td><td><UiBadge :tone="u.status === 'ACTIVE' ? 'PASS' : 'FAIL'">{{ u.status === 'ACTIVE' ? L('فعّال', 'Active') : L('موقوف', 'Suspended') }}</UiBadge></td><td>{{ u.running ? L('نشط الآن', 'Active now') : '—' }}</td>
        <td><div v-if="u.role !== 'ADMIN'" class="flex flex-wrap gap-2"><UiButton size="sm" :disabled="busy" @click="run(() => call('/admin/status', { id: u.id, status: u.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE' }))">{{ u.status === 'ACTIVE' ? L('إيقاف', 'Suspend') : L('تفعيل', 'Activate') }}</UiButton><UiButton size="sm" :disabled="busy" @click="reset(u.id)">{{ L('رابط كلمة مرور جديدة', 'New password link') }}</UiButton><UiButton v-if="u.totp" size="sm" :disabled="busy" @click="run(() => call('/admin/totp/clear', { id: u.id }))">{{ L('إلغاء الدخول بخطوتين', 'Turn off two-step') }}</UiButton></div></td></tr></tbody></UiTable></UiCard>
    <UiCard v-if="d"><h2 class="mb-3 text-lg">{{ L('طلبات الدعوة', 'Invitation requests') }}</h2><UiTable><tbody><tr v-for="i in d.requests" :key="i.email"><td><bdi>{{ i.email }}</bdi></td><td class="num">{{ new Date(i.createdAt).toLocaleString('en-GB') }}</td><td><div class="flex gap-2"><UiButton size="sm" variant="default" :disabled="busy" @click="inviteTo(i.email)">{{ L('دعوة', 'Invite') }}</UiButton><UiButton size="sm" :disabled="busy" @click="run(() => call('/admin/request/drop', { email: i.email }))">{{ L('حذف', 'Remove') }}</UiButton></div></td></tr><tr v-if="!d.requests.length"><td class="text-muted-foreground">{{ L('لا توجد', 'None') }}</td></tr></tbody></UiTable></UiCard>
    <UiCard v-if="d"><h2 class="mb-3 text-lg">{{ L('دعوات معلقة', 'Pending invitations') }}</h2><UiTable><tbody><tr v-for="i in d.invites" :key="i.email"><td><bdi>{{ i.email }}</bdi></td><td class="num">{{ new Date(i.expiresAt).toLocaleString('en-GB') }}</td><td><UiButton size="sm" :disabled="busy" @click="run(() => call('/admin/invite/revoke', { email: i.email }))">{{ L('إلغاء', 'Revoke') }}</UiButton></td></tr><tr v-if="!d.invites.length"><td class="text-muted-foreground">{{ L('لا توجد', 'None') }}</td></tr></tbody></UiTable></UiCard>
    <NuxtLink to="/app" class="inline-flex min-h-10 items-center text-primary hover:underline">{{ L('العودة إلى المنصة', 'Back to the platform') }}</NuxtLink>
  </div>
</template>
