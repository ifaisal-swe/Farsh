<script setup lang="ts">
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const email = () => ({ name: 'email', label: L('البريد الإلكتروني', 'E-mail'), type: 'email', ac: 'username' })
const fresh = () => ({ name: 'password', label: L('كلمة المرور (12 حرفًا على الأقل)', 'Password (at least 12 characters)'), type: 'password', ac: 'new-password', min: 12 })
</script>

<template>
  <AccountForm url="/account/register" done="/app" :title="L('قبول الدعوة', 'Accept your invitation')" :note="L('استخدم البريد الذي وصلته الدعوة.', 'Use the e-mail address that was invited.')" :submit="L('إنشاء الحساب', 'Create account')" :fields="[{ name: 'token', label: L('رمز الدعوة', 'Invitation code'), ac: 'off' }, email(), fresh()]" />
</template>
