<script setup lang="ts">
const { t, num } = useLang()
const data = ref<any>(null)
const error = ref('')
const busy = ref('')
const form = reactive({ symbol: '', status: 'PASS', source: '' })
async function load() { try { data.value = await api('sharia') } catch (e: any) { error.value = e.message } }
async function run(key: string, path: string, body: unknown) {
  busy.value = key
  error.value = ''
  try { await api(path, body); await load(); return true } catch (e: any) { error.value = e.message } finally { busy.value = '' }
}
async function save() { if (await run('save', 'sharia/ruling', { ...form })) form.source = '' }
const chk = (x: any, id: string) => (x.checks || []).find((c: any) => c.id === id)
onMounted(load)
</script>

<template>
  <div>
  <p class="muted">{{ t('s_intro') }}</p>
  <p v-if="error" class="err" role="alert">{{ error }}</p>
  <p v-if="data && !data.enabled" class="err">{{ t('s_off') }}</p>
  <p v-if="data && !data.secConfigured" class="err">{{ t('s_nosec') }}</p>
  <p v-if="data?.mode === 'BUSINESS'" class="muted">{{ t('s_business') }}</p><p v-else-if="data && data.secConfigured && !data.filings" class="err">{{ t('s_nofilings') }}</p>
  <UiCard v-if="data"><h2>{{ t('nav_sharia') }}</h2><UiTable>
    <thead><tr><th>{{ t('symbol') }}</th><th>{{ t('sharia') }}</th><th>{{ t('basis') }}</th><th>{{ t('business') }}</th><th v-for="[k, l] in (data.mode === 'BUSINESS' ? [] : [['debt', data.limits.maxDebtPct], ['deposits', data.limits.maxDepositsPct], ['income', data.limits.maxIncomePct]])" :key="k">{{ t(String(k)) }} <bdi dir="ltr">&lt; {{ l }}%</bdi></th><th /></tr></thead>
    <tbody><tr v-for="x in data.items" :key="x.symbol">
      <td><bdi>{{ x.symbol }}</bdi></td><td><UiBadge :tone="x.status">{{ t(x.status) }}</UiBadge></td>
      <td class="small">{{ t(x.basis) }}<template v-if="x.ruling"> · {{ x.ruling.source }}</template></td>
      <td v-for="id in (data.mode === 'BUSINESS' ? ['business'] : ['business', 'debt', 'deposits', 'income'])" :key="id"><template v-if="chk(x, id)"><UiBadge :tone="chk(x, id).status">{{ t(chk(x, id).status) }}</UiBadge> <span v-if="chk(x, id).value != null" class="num">{{ num(chk(x, id).value) }}%</span><div v-if="chk(x, id).asOf" class="num small muted">{{ chk(x, id).asOf }}</div></template><template v-else>—</template></td>
      <td><UiButton variant="outline" :disabled="!!busy || !data.secConfigured" @click="run(x.symbol, 'sharia/screen', { symbol: x.symbol })">{{ t('screen') }}</UiButton> <UiButton v-if="x.ruling" variant="outline" :disabled="!!busy" @click="run(x.symbol, 'sharia/ruling/clear', { symbol: x.symbol })">{{ t('clear') }}</UiButton></td>
    </tr></tbody></UiTable></UiCard>
  <UiCard><h2>{{ t('ruling') }}</h2><div class="row">
    <UiInput v-model="form.symbol" dir="ltr" maxlength="10" :placeholder="t('symbol')" :aria-label="t('symbol')" /><UiNativeSelect v-model="form.status" :aria-label="t('sharia')"><option value="PASS">{{ t('PASS') }}</option><option value="FAIL">{{ t('FAIL') }}</option></UiNativeSelect>
    <UiInput v-model="form.source" maxlength="200" :placeholder="t('source')" :aria-label="t('source')" /><UiButton variant="default" :disabled="!!busy || !form.symbol || form.source.trim().length < 3" @click="save">{{ t('save') }}</UiButton></div></UiCard>
  </div>
</template>
