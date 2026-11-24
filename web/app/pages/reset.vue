<script setup lang="ts">
const { lang } = useLang()
const L = (ar: string, en: string) => (lang.value === 'ar' ? ar : en)
const email = () => ({ name: 'email', label: L('البريد الإلكتروني', 'E-mail'), type: 'email', ac: 'username' })
const fresh = () => ({ name: 'password', label: L('كلمة المرور (12 حرفًا على الأقل)', 'Password (at least 12 characters)'), type: 'password', ac: 'new-password', min: 12 })
</script>

<template>
  <AccountForm url="/account/reset" done="/login" :title="L('كلمة مرور جديدة', 'Set a new password')" :submit="L('حفظ', 'Save')" :fields="[{ name: 'token', label: L('رمز إعادة التعيين', 'Reset code'), ac: 'off' }, fresh()]" />
</template>
