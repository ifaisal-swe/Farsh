import tailwindcss from '@tailwindcss/vite'

// Sets the theme before the first paint. The server allows this exact script by its hash (no 'unsafe-inline').
const themeScript = "(function(){var t='light';try{t=localStorage.getItem('dt.theme')||t}catch(e){}if(t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.classList.add('dark')})()"

// Static SPA: `npm run build` writes .output/public. The trading server serves /app/*; the hosted gateway also serves the public site.
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  ssr: false,
  telemetry: false,
  devtools: { enabled: false },
  css: ['@fontsource-variable/readex-pro/index.css', '@fontsource/ibm-plex-sans-arabic/400.css', '@fontsource/ibm-plex-sans-arabic/500.css', '@fontsource/ibm-plex-sans-arabic/600.css', '@fontsource/ibm-plex-sans-arabic/700.css', '~/assets/main.css'],
  components: [{ path: '~/components/ui', prefix: 'Ui', extensions: ['vue'] }, { path: '~/components', ignore: ['ui/**'] }],
  app: {
    baseURL: '/',
    buildAssetsDir: 'app/_nuxt/',
    head: {
      title: 'فرصة',
      htmlAttrs: { lang: 'ar', dir: 'rtl' },
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }, { name: 'color-scheme', content: 'light dark' }, { name: 'description', content: 'منصة عربية للتداول الورقي الآلي للأسهم الأمريكية والعملات الرقمية بضوابط شرعية.' }],
      link: [{ rel: 'icon', href: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='16' fill='%234254f5'/%3E%3Cg transform='translate(1.5 2.5)'%3E%3Cpath d='M46.5 29.5a9.5 9.5 0 1 1-19 0a9.5 9.5 0 1 1 19 0V38c0 8.5-4.5 11.5-12.5 11.5H25c-7 0-10.5-3.5-10.5-9.5v-3.5' fill='none' stroke='%23fff' stroke-width='7.5' stroke-linecap='round' stroke-linejoin='round' /%3E%3Ccircle cx='37' cy='8.5' r='5.25' fill='%23ffd32e' /%3E%3C/g%3E%3C/svg%3E" }],
      script: [{ innerHTML: themeScript, tagPosition: 'head' }],
    },
  },
  vite: { plugins: [tailwindcss()], build: { assetsInlineLimit: 0 } },
  nitro: {
    preset: 'static',
    devProxy: { '/api': { target: 'http://127.0.0.1:8787/api', changeOrigin: true }, '/ws': { target: 'ws://127.0.0.1:8787/ws', ws: true, changeOrigin: true } },
  },
})
