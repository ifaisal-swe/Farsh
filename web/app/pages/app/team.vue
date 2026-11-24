<script setup lang="ts">
import { plain } from '~/lib/plain'
const { lang } = useLang()
const ar = computed(() => lang.value === 'ar')
const L = (a: string, e: string) => (ar.value ? a : e)
const d = ref<any>(null)
const tpl = ref<any>(null)
const links = ref<any[]>([])
const pick = ref('claude')
const error = ref('')
const copied = ref('')
const fresh = ref('')
const busy = ref(false)
let timer: any = null
const VIEW = computed<Record<string, [string, string]>>(() => ({ POSITIVE: [L('إيجابي', 'Positive'), 'up'], NEUTRAL: [L('محايد', 'Neutral'), ''], NEGATIVE: [L('سلبي', 'Negative'), 'down'] }))
const when = (x: number) => new Date(x).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })
const client = computed(() => tpl.value?.clients.find((c: any) => c.id === pick.value))
async function account(path: string, body?: any) {
  const r = await fetch(`/account/${path}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' }, body: JSON.stringify(body) } : {})
  const x = r.headers.get('content-type')?.includes('json') ? await r.json() : {}
  if (!r.ok) throw Object.assign(new Error(plain.error(x.error || '', ar.value)), { status: r.status })
  return x
}
async function load() { try { d.value = await api('team') } catch (e: any) { error.value = e.message } }
async function loadLinks() { try { tpl.value = await account('templates'); if (!tpl.value.clients) tpl.value = null; links.value = (await account('connections')).items || [] } catch { tpl.value = null } }
async function copy(k: string, v: string) { try { await navigator.clipboard.writeText(v); copied.value = k; setTimeout(() => { copied.value = '' }, 2000) } catch { /* it can be selected by hand */ } }
async function run(fn: () => Promise<any>) { busy.value = true; error.value = ''; try { await fn() } catch (e: any) { error.value = e.message } finally { busy.value = false } }
const makeKey = () => run(async () => { fresh.value = (await account('connections/key', { name: client.value?.name || '' })).key; await loadLinks() })
const remove = (id: string) => run(async () => { await account('connections/remove', { id }); fresh.value = ''; await loadLinks() })
const needText = (x: string) => {
  if (!ar.value) return x
  const m = /^price moved (.+) since/.exec(x); const n = /^(\d+) new headlines/.exec(x)
  return m ? `تحرك السعر ${m[1]}` : n ? `${n[1]} عناوين جديدة` : x === 'no report yet' ? 'لا تقرير بعد' : x === 'report is old' ? 'التقرير قديم' : 'مرّ موعد مهم'
}
onMounted(() => { load(); loadLinks(); timer = setInterval(load, 30000) })
onBeforeUnmount(() => clearInterval(timer))
</script>

<template>
  <div>
    <p v-if="error" class="err">{{ error }}</p>
    <UiCard v-if="d"><h2>{{ L('الأسهم المتابعة', 'Followed stocks') }}</h2>
      <div v-for="x in d.stocks" :key="x.symbol" class="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-3 last:border-0"><SymbolIcon :symbol="x.symbol" class="size-8" /><b><bdi>{{ x.symbol }}</bdi></b><span v-if="x.last" class="num small" :class="VIEW[x.last.view]?.[1]">{{ VIEW[x.last.view]?.[0] }} · {{ x.last.confidence }}%</span><span class="grow" /><span v-for="n in x.needs" :key="n" class="rounded-full bg-secondary px-3 py-1 text-sm">{{ needText(n) }}</span><span v-if="!x.needs.length" class="small muted">{{ L('محدّث', 'Up to date') }}</span></div>
      <p class="small muted !mb-0">{{ L('نتائج الآراء السابقة:', 'Earlier views:') }} <span v-if="d.record.finished" class="num">{{ d.record.right }} / {{ d.record.finished }}</span><span v-else>{{ L('لم يكتمل أي رأي بعد', 'none finished yet') }}</span></p></UiCard>

    <template v-if="d?.reports.length"><UiCard v-for="r in d.reports" :key="r.id"><div class="flex flex-wrap items-center gap-3"><h2 class="!m-0"><bdi>{{ r.symbol }}</bdi></h2><b :class="VIEW[r.view]?.[1]">{{ VIEW[r.view]?.[0] }}</b><span class="small num">{{ L('الثقة', 'Confidence') }} {{ r.confidence }}%</span><span class="grow" /><span class="small muted"><bdi>{{ r.by }}</bdi> · <span class="num">{{ when(r.at) }}</span></span></div>
      <p class="!mt-3 whitespace-pre-line">{{ ar ? r.summaryAr : r.summaryEn || r.summaryAr }}</p>
      <div class="grid gap-4 sm:grid-cols-2"><div><b>{{ L('ما يدفع السعر', 'What could push it') }}</b><ul class="!mt-1 ps-5"><li v-for="(x, i) in r.drivers" :key="i">{{ x }}</li></ul></div><div><b>{{ L('المخاطر', 'Risks') }}</b><ul class="!mt-1 ps-5"><li v-for="(x, i) in r.risks" :key="i">{{ x }}</li></ul></div></div>
      <p v-if="r.catalysts.length" class="small"><b>{{ L('مواعيد:', 'Dates:') }}</b> <span v-for="(c, i) in r.catalysts" :key="i" class="me-3"><span class="num">{{ c.date }}</span> {{ c.what }}</span></p>
      <p v-if="r.wouldChange.length" class="small"><b>{{ L('ما يغيّر الرأي:', 'What would change it:') }}</b> {{ r.wouldChange.join('، ') }}</p>
      <p v-if="r.result" class="small"><b>{{ L('ما حدث بعده:', 'What happened:') }}</b> <span class="num">{{ (r.result.move * 100).toFixed(1) }}%</span></p>
      <p class="small muted !mb-0 flex flex-wrap gap-x-3"><span>{{ L('المصادر:', 'Sources:') }}</span><a v-for="s in r.sources" :key="s.url" :href="s.url" target="_blank" rel="noopener noreferrer" class="underline">{{ s.title }}</a></p></UiCard></template>
    <UiCard v-else-if="d"><p class="muted !m-0">{{ L('لا تقارير بعد. اربط مساعدك الذكي من الأسفل وشغّل الفريق.', 'No reports yet. Connect your AI assistant below and run the team.') }}</p></UiCard>

    <UiCard v-if="tpl"><h2>{{ L('اربط مساعدك الذكي', 'Connect your AI assistant') }}</h2><p class="muted">{{ L('يعمل الفريق داخل مساعدك وعلى خطتك أنت، ويحفظ تقاريره هنا. للتحليل فقط، ولا يستطيع التداول.', 'The team works inside your assistant, on your own plan, and saves its reports here. Analysis only; it cannot trade.') }}</p>
      <div class="flex flex-wrap items-center gap-2 rounded-2xl bg-secondary px-4 py-3"><bdi dir="ltr" class="num min-w-0 break-all">{{ tpl.address }}</bdi><span class="grow" /><UiButton variant="outline" @click="copy('address', tpl.address)">{{ copied === 'address' ? L('نُسخ', 'Copied') : L('نسخ', 'Copy') }}</UiButton></div>
      <div class="mt-4 flex flex-wrap gap-2" role="group" :aria-label="L('المساعد', 'Assistant')"><UiButton v-for="c in tpl.clients" :key="c.id" :variant="pick === c.id ? 'default' : 'outline'" :aria-pressed="pick === c.id" @click="pick = c.id; fresh = ''">{{ c.name }}</UiButton></div>
      <template v-if="client"><ol class="mt-4 grid gap-2 ps-5"><li v-for="(s, i) in client.steps[lang]" :key="i">{{ s }}</li></ol>
        <div v-if="client.command" class="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-secondary px-4 py-3"><bdi dir="ltr" class="num min-w-0 text-sm break-all">{{ client.command }}</bdi><span class="grow" /><UiButton variant="outline" @click="copy('command', client.command)">{{ copied === 'command' ? L('نُسخ', 'Copied') : L('نسخ', 'Copy') }}</UiButton></div>
        <div class="mt-4 rounded-2xl border p-4"><div class="flex items-center gap-2"><b>{{ L('النص الجاهز', 'Ready text') }}</b><span class="grow" /><UiButton variant="default" @click="copy('prompt', client.prompt)">{{ copied === 'prompt' ? L('نُسخ', 'Copied') : L('نسخ النص', 'Copy text') }}</UiButton></div><p dir="ltr" class="!mt-3 !mb-0 text-start text-sm whitespace-pre-line">{{ client.prompt }}</p></div></template>
      <h3 class="!mt-6">{{ L('المساعدات المرتبطة', 'Connected assistants') }}</h3>
      <p v-if="!links.length" class="muted">{{ L('لا شيء مرتبط بعد.', 'Nothing is connected yet.') }}</p>
      <div v-for="x in links" :key="x.id" class="flex flex-wrap items-center gap-3 border-b py-2 last:border-0"><b><bdi>{{ x.name }}</bdi></b><span v-if="x.key" class="small muted">{{ L('رمز ربط', 'Access code') }}</span><span class="small muted">{{ L('آخر استخدام', 'Last used') }} <span class="num">{{ when(x.seenAt) }}</span></span><span class="grow" /><UiButton variant="outline" :disabled="busy" @click="remove(x.id)">{{ L('إلغاء الربط', 'Disconnect') }}</UiButton></div>
      <p class="small muted !mt-4">{{ L('إن كان برنامجك لا يدعم تسجيل الدخول، أنشئ رمز ربط يعمل 90 يومًا. يظهر مرة واحدة فقط، فلا تشاركه.', 'If your program cannot sign in, create an access code that works for 90 days. It is shown only once; do not share it.') }}</p>
      <UiButton variant="outline" :disabled="busy" @click="makeKey">{{ L('إنشاء رمز ربط', 'Create an access code') }}</UiButton>
      <div v-if="fresh" class="mt-3 flex flex-wrap items-center gap-2 rounded-2xl bg-secondary px-4 py-3"><bdi dir="ltr" class="num min-w-0 text-sm break-all">{{ fresh }}</bdi><span class="grow" /><UiButton variant="outline" @click="copy('fresh', fresh)">{{ copied === 'fresh' ? L('نُسخ', 'Copied') : L('نسخ', 'Copy') }}</UiButton></div></UiCard>
  </div>
</template>
