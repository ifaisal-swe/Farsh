// light (default), dark or the device setting. The inline script in nuxt.config.ts applies the stored choice before first paint.
export type Theme = 'system' | 'light' | 'dark'
const theme = ref<Theme>('light')
const systemDark = ref(false)
const dark = computed(() => theme.value === 'dark' || (theme.value === 'system' && systemDark.value))
let init = false

export function useTheme() {
  if (!init && import.meta.client) {
    init = true
    try { const x = localStorage.getItem('dt.theme'); if (x === 'light' || x === 'dark' || x === 'system') theme.value = x } catch { /* storage unavailable */ }
    const mq = matchMedia('(prefers-color-scheme: dark)')
    systemDark.value = mq.matches
    mq.addEventListener('change', (e) => { systemDark.value = e.matches })
    watch(dark, (d) => document.documentElement.classList.toggle('dark', d), { immediate: true, flush: 'sync' })
    watch(theme, (x) => { try { localStorage.setItem('dt.theme', x) } catch { /* ignore */ } })
  }
  return { theme, dark }
}
