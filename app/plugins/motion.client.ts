// v-reveal: an element rises in when it first enters the screen. v-reveal="n" delays it, for staggered groups.
export default defineNuxtPlugin((nuxt) => {
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches || !('IntersectionObserver' in window)
  const io = still ? null : new IntersectionObserver((list) => { for (const e of list) if (e.isIntersecting) { e.target.classList.add('in'); io!.unobserve(e.target) } }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' })
  nuxt.vueApp.directive('reveal', {
    mounted(el: HTMLElement, b) { if (!io) return; el.classList.add('reveal'); if (b.value) el.style.setProperty('--d', `${b.value * 90}ms`); if (b.arg) el.classList.add(`reveal-${b.arg}`); io.observe(el) },
    unmounted(el: HTMLElement) { io?.unobserve(el) },
  })
})
