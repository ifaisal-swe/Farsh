/* Modal helper + Settings dialog (credentials, AI, risk, execution, data & news) — localized. */
(function () {
  'use strict';
  const I = window.I18N;
  const T = I.T;
  const esc = U.esc;
  const tr = (s) => window.MSG.tr(s);
  const Modal = {
    open(title, html, onMount) {
      U.$('modal-title').textContent = title;
      U.$('modal-body').innerHTML = html;
      U.$('modal').classList.remove('hidden');
      if (onMount) onMount(U.$('modal-body'));
    },
    close() { U.$('modal').classList.add('hidden'); U.$('modal-body').innerHTML = ''; },
  };
  U.$('modal-close').addEventListener('click', () => Modal.close());
  U.$('modal').addEventListener('click', (e) => { if (e.target.id === 'modal') Modal.close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') Modal.close(); });

  const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const setPath = (obj, path, v) => { const ks = path.split('.'); let o = obj; ks.slice(0, -1).forEach((k) => { o[k] = o[k] || {}; o = o[k]; }); o[ks[ks.length - 1]] = v; };

  const AI_FIELDS = [
    { p: 'ai.usageMode', t: 'select', o: ['ECONOMY', 'BALANCED', 'DETAILED'] }, { p: 'ai.mode', t: 'select', o: ['AUTO', 'DEEPSEEK', 'GEMINI', 'DUAL'] }, { p: 'ai.fallback', t: 'bool' }, { p: 'ai.dualScope', t: 'select', o: ['IMPORTANT', 'ALL'] },
    { p: 'ai.deepseekDailyBudgetUsd', t: 'number', step: 0.1 }, { p: 'ai.geminiDailyBudgetUsd', t: 'number', step: 0.1 },
    { p: 'ai.model', t: 'model', prov: 'deepseek', d: ['deepseek-flash', 'deepseek-v4-pro'] }, { p: 'ai.gemini.model', t: 'model', prov: 'gemini', d: ['gemini-3.5-flash-lite'] },
    { p: 'ai.maxRequestsPerDay', t: 'number' }, { p: 'ai.maxRequestsPerSymbolPerHour', t: 'number' }, { p: 'ai.monthlyBudgetUsd', t: 'number', step: 0.5 }, { p: 'ai.reasoningEffort', t: 'select', o: ['none', 'low', 'high', 'max'] }, { p: 'ai.autonomy', t: 'select', o: ['FULL', 'SEMI', 'ADVISORY'] },
    { p: 'ai.analysisTimeframe', t: 'select', o: ['1m', '3m', '5m', '15m', '30m', '1h'] }, { p: 'ai.regularIntervalSec', t: 'number' }, { p: 'ai.minIntervalSec', t: 'number' },
    { p: 'ai.maxRequestsPerMinute', t: 'number' }, { p: 'ai.dailyBudgetUsd', t: 'number', step: 0.1 }, { p: 'ai.maxOutputTokens', t: 'number' }, { p: 'ai.requestTimeoutSec', t: 'number' },
    { p: 'ai.proposalMaxAgeSec', t: 'number' }, { p: 'ai.maxPriceDriftPct', t: 'number', step: 0.05 }, { p: 'ai.webResearch.enabled', t: 'bool' }, { p: 'ai.webResearch.intervalMin', t: 'number' },
  ];
  const PROFILE_FIELDS = [
    { p: 'risk.maxRiskPerTradePct', step: 0.05 }, { p: 'risk.maxDailyLossPct', step: 0.1 }, { p: 'risk.maxDrawdownPct', step: 0.5 }, { p: 'risk.maxPositionPct' },
    { p: 'risk.minRewardRisk', step: 0.1 }, { p: 'risk.maxOpenPositions' }, { p: 'risk.maxStopDistancePct', step: 0.5 }, { p: 'risk.maxConsecutiveLosses' },
    { p: 'risk.lossCooldownMin' }, { p: 'risk.maxTradesPerDay' },
  ].map((f) => ({ ...f, t: 'number', l: () => T(`p_${f.p.split('.')[1]}`) }));
  const RISK_FIELDS = [
    { p: 'risk.maxSpreadPct', t: 'number', step: 0.01 }, { p: 'risk.maxSlippagePct', t: 'number', step: 0.01 }, { p: 'risk.minStopDistancePct', t: 'number', step: 0.05 },
    { p: 'risk.minStopDistanceSpreads', t: 'number', step: 0.5 }, { p: 'risk.ipoMode.enabled', t: 'select', o: ['auto', 'on', 'off'] }, { p: 'risk.ipoMode.newListingSessions', t: 'number' },
    { p: 'risk.ipoMode.minMinutesAfterFirstTrade', t: 'number' }, { p: 'risk.ipoMode.maxSpreadPct', t: 'number', step: 0.05 }, { p: 'risk.ipoMode.allocationFactor', t: 'number', step: 0.05 },
    { p: 'risk.ipoMode.maxAtrPct', t: 'number', step: 0.1 },
  ];
  const EXEC_FIELDS = [
    { p: 'execution.slippageBps', t: 'number', step: 0.5 }, { p: 'execution.impactPerTierBps', t: 'number', step: 0.5 }, { p: 'execution.defaultTierSize', t: 'number' },
    { p: 'execution.requireQuoteSize', t: 'bool' }, { p: 'execution.fractionalShares', t: 'bool' }, { p: 'execution.extendedHours', t: 'bool' },
    { p: 'execution.commissionPerShare', t: 'number', step: 0.001 }, { p: 'execution.commissionPerOrder', t: 'number', step: 0.01 }, { p: 'execution.secFeeRate', t: 'number', step: 0.0000001 },
    { p: 'execution.finraTafPerShare', t: 'number', step: 0.000001 }, { p: 'execution.finraTafMax', t: 'number', step: 0.01 }, { p: 'execution.pendingLimitExpiryMin', t: 'number' },
    { p: 'execution.overnight', t: 'bool' },
  ];
  const DATA_FIELDS = [
    { p: 'market.feed', t: 'select', o: ['iex', 'sip', 'delayed_sip'] }, { p: 'market.adjustment', t: 'select', o: ['split', 'raw', 'all'] }, { p: 'market.quoteSizeUnit', t: 'select', o: ['shares', 'round_lots'] },
    { p: 'market.maxQuoteAgeMs', t: 'number' }, { p: 'market.maxExchangeLagMs', t: 'number' }, { p: 'market.historyBars', t: 'number' }, { p: 'news.breakingCooldownSec', t: 'number' },
    { p: 'retention.activityDays', t: 'number' }, { p: 'retention.snapshotsDays', t: 'number' },
    { p: 'market.overnight.enabled', t: 'bool' }, { p: 'market.overnight.provider', t: 'select', o: ['auto', 'alpaca', 'tiingo', 'none'] },
    { p: 'market.overnight.alpacaFeed', t: 'select', o: ['overnight', 'boats'] }, { p: 'market.overnight.pollSec', t: 'number' }, { p: 'tiingo.enabled', t: 'bool' }, { p: 'tiingo.pollSec', t: 'number' },
  ];
  const AM = 'adaptiveMonitoring';
  const MON_FIELDS = [
    { p: `${AM}.enabled`, t: 'bool' }, { p: `${AM}.preMarketMin`, t: 'number' }, { p: `${AM}.openingMin`, t: 'number' }, { p: `${AM}.postOpenMin`, t: 'number' }, { p: `${AM}.closingMin`, t: 'number' },
    { p: `${AM}.noNewEntriesLastMin`, t: 'number' }, { p: `${AM}.closingPositionReview`, t: 'bool' }, { p: `${AM}.followerCandleClose`, t: 'bool' },
    { p: `${AM}.volatility.enterRatio`, t: 'number', step: 0.1 }, { p: `${AM}.volatility.exitRatio`, t: 'number', step: 0.1 }, { p: `${AM}.volatility.confirmBars`, t: 'number' }, { p: `${AM}.volatility.exitBars`, t: 'number' },
    { p: `${AM}.volatility.minActiveMin`, t: 'number' }, { p: `${AM}.volatility.cooldownMin`, t: 'number' }, { p: `${AM}.volatility.openingFactor`, t: 'number', step: 0.1 }, { p: `${AM}.volatility.marketMovePct`, t: 'number', step: 0.1 },
    { p: `${AM}.events.confirmBars`, t: 'number' }, { p: `${AM}.events.requireVolumeConfirmation`, t: 'bool' }, { p: `${AM}.events.volumeConfirm`, t: 'number', step: 0.1 }, { p: `${AM}.events.volumeSpike`, t: 'number', step: 0.1 },
    { p: `${AM}.events.moveZ`, t: 'number', step: 0.1 }, { p: `${AM}.events.breakoutBufferAtr`, t: 'number', step: 0.05 }, { p: `${AM}.events.gapAtr`, t: 'number', step: 0.1 }, { p: `${AM}.events.ttlSec`, t: 'number' },
    { p: `${AM}.ai.minScore`, t: 'number' }, { p: `${AM}.ai.highPriorityScore`, t: 'number' }, { p: `${AM}.ai.symbolCooldownSec`, t: 'number' }, { p: `${AM}.ai.maxPerSymbolPerDay`, t: 'number' }, { p: `${AM}.ai.maxPerDay`, t: 'number' },
    { p: `${AM}.ai.maxQueued`, t: 'number' }, { p: `${AM}.ai.reserveSymbolRequests`, t: 'number' }, { p: `${AM}.ai.budgetReservePct`, t: 'number' }, { p: `${AM}.ai.enforceBudget`, t: 'bool' },
  ];
  const TG_NOTIF = ['enabled', 'trades', 'ai', 'risk', 'news', 'data', 'market', 'watchlist', 'breakouts', 'monitoring'];
  const TG_REPORTS = ['daily', 'weekly', 'monthly'];

  function fieldHtml(f, cfg, models) {
    const v = get(cfg, f.p);
    const id = `cfg-${f.p.replace(/\./g, '-')}`;
    const label = f.l ? f.l() : (I.field(f.p) || f.p);
    const help = I.field(f.p, 'help');
    let input;
    if (f.t === 'select') input = `<select id="${id}" data-p="${f.p}" dir="ltr">${f.o.map((o) => `<option ${o === v ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    else if (f.t === 'model') {
      const opts = [...new Set([...((models && models[f.prov]) || []), ...f.d, v])].filter(Boolean);
      input = `<select id="${id}" data-p="${f.p}" dir="ltr">${opts.map((o) => `<option ${o === v ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    } else if (f.t === 'bool') input = `<label class="check"><input type="checkbox" id="${id}" data-p="${f.p}" data-t="bool" ${v ? 'checked' : ''}> ${esc(T('s_enabled'))}</label>`;
    else if (f.t === 'text') input = `<input id="${id}" data-p="${f.p}" type="text" dir="ltr" value="${esc(v == null ? '' : v)}" spellcheck="false">`;
    else input = `<input id="${id}" data-p="${f.p}" data-t="number" type="number" dir="ltr" step="${f.step || 1}" value="${esc(v)}">`;
    return `<div><label class="f" for="${id}">${esc(label)}</label>${input}${help ? `<div class="help">${esc(help)}</div>` : ''}</div>`;
  }

  function credHtml(c) {
    const testable = { DEEPSEEK_API_KEY: 'deepseek', ALPACA_SECRET_KEY: 'alpaca', SEC_USER_AGENT: 'sec', GEMINI_API_KEY: 'gemini', TIINGO_API_KEY: 'tiingo', TELEGRAM_BOT_TOKEN: 'telegram' }[c.name];
    return `<div class="cred">
      <div class="row between"><b dir="auto">${esc(tr(c.label))}</b><span class="pill small ${c.configured ? 'green' : 'gray'}">${c.configured ? esc(T('s_set', { src: c.source, m: c.masked })) : esc(T('s_not_set'))}</span></div>
      <div class="help" dir="auto">${esc(tr(c.why))}</div>
      <div class="row" style="margin-top:6px">
        <input type="${c.name === 'SEC_USER_AGENT' ? 'text' : 'password'}" id="cred-${c.name}" dir="ltr" autocomplete="off" placeholder="${c.name === 'SEC_USER_AGENT' ? 'Your Name your.email@example.com' : esc(T('s_paste'))}">
        <button class="btn small" data-save="${c.name}">${esc(T('s_save'))}</button>
        ${c.configured && c.source !== 'environment' ? `<button class="btn small danger-outline" data-del="${c.name}">${esc(T('s_remove'))}</button>` : ''}
        ${testable ? `<button class="btn small ghost" data-test="${testable}">${esc(T('s_test'))}</button>` : ''}
      </div>
    </div>`;
  }

  async function open(tab = 'credentials') {
    let s;
    try { s = await U.api('/api/settings'); } catch (e) { U.toast(tr(e.message), 'err'); return; }
    let models = {};
    try { const m = await U.api('/api/models'); models = { [m.provider || 'deepseek']: (m.models || []).map((x) => x.id) }; } catch { /* key missing or offline */ }
    const cfg = s.config;
    const tabs = { credentials: T('s_credentials'), ai: T('s_ai'), risk: T('s_risk'), execution: T('s_execution'), data: T('s_data'), monitoring: T('tab_monitoring'), telegram: T('s_telegram') };
    const tg = cfg.telegram || { notifications: {}, reports: {} };
    let tgs = null;
    try { tgs = await U.api('/api/telegram/status'); } catch { /* status is informational */ }
    const tgChk = (path, key, label) => `<label class="check"><input type="checkbox" data-tg="${path}" ${get(tg, path) ? 'checked' : ''}> ${esc(T(label || key))}</label>`;
    const feeds = (cfg.news.customFeeds || []).map((f) => `${f.name || ''}|${f.url}|${f.official ? 'official' : ''}`).join('\n');
    const sym = (window.APP && window.APP.state && window.APP.state.symbol) || '';
    const prof = cfg.risk.profile || 'CUSTOM';
    const html = `
      <div class="settings-tabs">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'active' : ''}">${esc(v)}</button>`).join('')}</div>
      <div data-pane="credentials" class="${tab === 'credentials' ? '' : 'hidden'}">
        <p class="help">${esc(T('s_keys_help'))}</p>
        ${s.credentials.map(credHtml).join('')}
        <div id="test-out" class="small"></div>
        <p class="help">${esc(T('s_alpaca_help'))}</p>
      </div>
      <div data-pane="ai" class="${tab === 'ai' ? '' : 'hidden'}"><div class="grid2">${AI_FIELDS.map((f) => fieldHtml(f, cfg, models)).join('')}</div>
        <p class="help">${esc(T('s_pricing_help'))}</p></div>
      <div data-pane="risk" class="${tab === 'risk' ? '' : 'hidden'}">
        <h4>${esc(T('s_profile_section', { p: T(`profile_${prof}`) }))}</h4>
        <p class="help">${esc(T('advanced_note'))} ${esc(T('profile_note'))}</p>
        <div class="grid2">${PROFILE_FIELDS.map((f) => fieldHtml(f, cfg)).join('')}</div>
        <h4>${esc(T('s_other_risk'))}</h4>
        <div class="grid2">${RISK_FIELDS.map((f) => fieldHtml(f, cfg)).join('')}</div>
        <p class="help">${esc(T('s_risk_help'))}</p></div>
      <div data-pane="execution" class="${tab === 'execution' ? '' : 'hidden'}"><div class="grid2">${EXEC_FIELDS.map((f) => fieldHtml(f, cfg)).join('')}</div></div>
      <div data-pane="monitoring" class="${tab === 'monitoring' ? '' : 'hidden'}"><p class="help">${esc(T('mm_settings_help'))}</p><div class="grid2">${MON_FIELDS.map((f) => fieldHtml(f, cfg)).join('')}</div></div>
      <div data-pane="data" class="${tab === 'data' ? '' : 'hidden'}"><div class="grid2">${DATA_FIELDS.map((f) => fieldHtml(f, cfg)).join('')}</div>
        <h4>${esc(T('s_feeds'))}</h4>
        <textarea id="cfg-feeds" rows="4" dir="ltr" placeholder="Name|https://example.com/ir/rss.xml|official">${esc(feeds)}</textarea>
        <div class="help">${esc(T('s_feeds_help'))}</div>
        <h4>${esc(T('s_cik', { sym: sym ? T('s_cik_for', { sym }) : '' }))}</h4>
        <input id="cfg-cik" dir="ltr" placeholder="e.g. 0001234567" value="${esc(sym && cfg.news.cikOverrides ? (cfg.news.cikOverrides[sym] || '') : '')}" ${sym ? '' : 'disabled'}>
        <div class="help">${esc(T('s_cik_help'))}</div>
      </div>
      <div data-pane="telegram" class="${tab === 'telegram' ? '' : 'hidden'}">
        <h4>${esc(T('tg_title'))}</h4>
        <div class="row between"><span class="pill small ${tgs && tgs.running ? 'green' : 'gray'}">${esc(T('tg_status', { s: !tgs ? T('na') : !tgs.available ? T('tg_unavailable') : !tgs.configured ? T('tg_not_configured') : tgs.running ? T('tg_running') : T('tg_stopped') }))}</span>
          ${tgs && tgs.running ? `<span class="small muted">${esc(T('tg_queue', { q: tgs.queued || 0, f: tgs.failed || 0, n: tgs.sentToday || 0 }))}</span>` : ''}</div>
        ${tgs && tgs.lastError ? `<div class="small down">${esc(tr(tgs.lastError))}</div>` : ''}
        <p class="help">${esc(T('tg_token_help'))}</p>
        ${tgChk('enabled', 'tg_enabled')}
        <div class="grid2">
          <div><label class="f" for="tg-chats">${esc(T('tg_chat_ids'))}</label><input id="tg-chats" dir="ltr" value="${esc((tg.authorizedChatIds || []).join(', '))}" placeholder="123456789, -1001234567890"></div>
          <div><label class="f" for="tg-users">${esc(T('tg_user_ids'))}</label><input id="tg-users" dir="ltr" value="${esc((tg.authorizedUserIds || []).join(', '))}" placeholder="123456789"></div>
        </div>
        <div class="help">${esc(T('tg_ids_help'))}</div>
        <h4>${esc(T('tg_notif'))}</h4>
        <div class="grid2">${TG_NOTIF.map((k) => tgChk(`notifications.${k}`, k, `tg_n_${k}`)).join('')}</div>
        <div class="help">${esc(T('tg_mandatory_help'))}</div>
        <h4>${esc(T('tg_reports'))}</h4>
        <div class="grid2">${TG_REPORTS.map((k) => tgChk(`reports.${k}`, k, `tg_r_${k}`)).join('')}
          <div><label class="f" for="tg-time">${esc(T('tg_r_time'))}</label><input id="tg-time" dir="ltr" value="${esc((tg.reports || {}).time || '16:30')}" placeholder="16:30"></div>
          <div><label class="f" for="tg-tz">${esc(T('tg_r_tz'))}</label><input id="tg-tz" dir="ltr" value="${esc((tg.reports || {}).timezone || 'America/New_York')}"></div>
          <div><label class="f" for="tg-day">${esc(T('tg_r_day'))}</label><input id="tg-day" type="number" min="0" max="6" dir="ltr" value="${esc((tg.reports || {}).weeklyDay ?? 5)}"></div>
        </div>
        <div class="row" style="margin-top:8px"><button class="btn small" id="tg-test">${esc(T('tg_test'))}</button><span id="tg-test-out" class="small"></span></div>
        <p class="help">${esc(T('tg_paper_note'))}</p>
      </div>
      <div class="actions"><span id="settings-err" class="small down"></span><button class="btn" id="settings-cancel">${esc(T('close'))}</button><button class="btn primary" id="settings-save">${esc(T('s_save_settings'))}</button></div>`;
    Modal.open(T('s_title'), html, (root) => {
      root.querySelectorAll('.settings-tabs button').forEach((b) => b.addEventListener('click', () => {
        root.querySelectorAll('.settings-tabs button').forEach((x) => x.classList.toggle('active', x === b));
        root.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== b.dataset.tab));
        U.$('settings-save').classList.toggle('hidden', b.dataset.tab === 'credentials');
      }));
      U.$('settings-save').classList.toggle('hidden', tab === 'credentials');
      U.$('settings-cancel').addEventListener('click', () => Modal.close());
      root.querySelectorAll('[data-save]').forEach((b) => b.addEventListener('click', async () => {
        const name = b.dataset.save;
        const v = U.$(`cred-${name}`).value.trim();
        if (!v) return U.toast(T('s_enter_value'), 'err');
        try { await U.api('/api/credentials', { method: 'POST', body: { name, value: v } }); U.toast(T('s_saved'), 'ok'); open('credentials'); } catch (e) { U.toast(tr(e.message), 'err'); }
      }));
      root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
        try { await U.api(`/api/credentials/${b.dataset.del}`, { method: 'DELETE' }); open('credentials'); } catch (e) { U.toast(tr(e.message), 'err'); }
      }));
      root.querySelectorAll('[data-test]').forEach((b) => b.addEventListener('click', async () => {
        const out = U.$('test-out');
        out.textContent = T('s_testing', { x: b.dataset.test });
        try {
          if (b.dataset.test === 'telegram') { out.innerHTML = await testTelegram(); return; }
          const r = await U.api(`/api/test/${b.dataset.test}`, { method: 'POST' });
          if (b.dataset.test === 'deepseek') out.innerHTML = `<span class="up">${esc(T('s_ds_ok'))}</span> — ${esc(T('s_models'))}: <span dir="ltr">${esc(r.models.map((m) => m.id).join(', '))}</span>${r.balance && r.balance.balance_infos ? ` — ${esc(T('s_balance'))}: <span dir="ltr">${esc(r.balance.balance_infos.map((x) => `${x.total_balance} ${x.currency}`).join(', '))}</span>` : ''}${r.balance && r.balance.is_available === false ? ` <span class="down">${esc(T('s_topup'))}</span>` : ''}`;
          else if (b.dataset.test === 'alpaca') out.innerHTML = `<span class="up">${esc(T('s_alpaca_ok'))}</span> — ${esc(T('s_market_is', { s: r.clock.is_open ? I.en('market', 'OPEN') : I.en('market', 'CLOSED'), t: r.clock.next_open }))}؛ ${esc(T('s_feed'))}: ${esc(tr(r.feed.label))}${r.spy ? ` — ${esc(T('s_spy_last'))} <span class="num">${r.spy.p}</span>` : ''}${r.snapshotError ? ` <span class="down">${esc(T('s_snapshot_err'))}: ${esc(r.snapshotError)}</span>` : ''}`;
          else if (b.dataset.test === 'gemini') out.innerHTML = `<span class="up">${esc(T('s_gemini_ok'))}</span> — ${esc(T('s_models'))}: <span dir="ltr">${esc((r.models || []).slice(0, 12).map((m) => m.id).join(', '))}</span>`;
          else if (b.dataset.test === 'tiingo') out.innerHTML = `<span class="up">${esc(T('s_tiingo_ok'))}</span>${r.sample ? ` — SPY <span class="num">${esc(r.sample.tngoLast)}</span> <span class="muted" dir="ltr">${esc(r.sample.timestamp || '')}</span>` : ''}`;
          else if (b.dataset.test === 'telegram') { const tr2 = await testTelegram(); out.innerHTML = tr2; }
          else out.innerHTML = `<span class="up">${esc(T('s_sec_ok'))}</span> — ${esc(T('s_tickers_mapped', { n: r.companies }))}`;
        } catch (e) { out.innerHTML = `<span class="down">${esc(T('s_failed', { e: tr(e.message) }))}</span>`; }
      }));
      const tgBtn = U.$('tg-test');
      if (tgBtn) tgBtn.addEventListener('click', async () => { U.$('tg-test-out').textContent = T('s_testing', { x: 'Telegram' }); U.$('tg-test-out').innerHTML = await testTelegram(); });
      U.$('settings-save').addEventListener('click', async () => {
        const patch = {};
        root.querySelectorAll('[data-p]').forEach((el) => {
          const p = el.dataset.p;
          let v;
          if (el.dataset.t === 'bool') v = el.checked;
          else if (el.dataset.t === 'number') v = Number(el.value);
          else v = el.value;
          if (JSON.stringify(v) !== JSON.stringify(get(cfg, p))) setPath(patch, p, v);
        });
        const lines = U.$('cfg-feeds').value.split('\n').map((l) => l.trim()).filter(Boolean);
        const feedsNew = lines.map((l) => { const [name, url, off] = l.split('|').map((x) => (x || '').trim()); return { name, url, official: off === 'official' }; });
        if (JSON.stringify(feedsNew) !== JSON.stringify(cfg.news.customFeeds || [])) setPath(patch, 'news.customFeeds', feedsNew);
        const cik = U.$('cfg-cik') && U.$('cfg-cik').value.trim();
        if (sym && cik !== ((cfg.news.cikOverrides || {})[sym] || '')) setPath(patch, `news.cikOverrides.${sym}`, cik ? cik.replace(/^0+/, '') || '0' : null);
        // Telegram (ids are validated again on the server)
        const ids = (id) => U.$(id).value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
        const tgPatch = {};
        root.querySelectorAll('[data-tg]').forEach((el) => { if (el.checked !== !!get(tg, el.dataset.tg)) setPath(tgPatch, el.dataset.tg, el.checked); });
        const chats = ids('tg-chats'); const users = ids('tg-users');
        if (JSON.stringify(chats) !== JSON.stringify(tg.authorizedChatIds || [])) tgPatch.authorizedChatIds = chats;
        if (JSON.stringify(users) !== JSON.stringify(tg.authorizedUserIds || [])) tgPatch.authorizedUserIds = users;
        const rt = U.$('tg-time').value.trim(); const tz = U.$('tg-tz').value.trim(); const wd = Number(U.$('tg-day').value);
        const rep0 = tg.reports || {};
        if (rt !== (rep0.time || '16:30')) setPath(tgPatch, 'reports.time', rt);
        if (tz !== (rep0.timezone || 'America/New_York')) setPath(tgPatch, 'reports.timezone', tz);
        if (wd !== (rep0.weeklyDay ?? 5)) setPath(tgPatch, 'reports.weeklyDay', wd);
        if (Object.keys(tgPatch).length) patch.telegram = tgPatch;
        if (!Object.keys(patch).length) return Modal.close();
        try { await U.api('/api/settings', { method: 'POST', body: patch }); U.toast(T('s_saved_settings'), 'ok'); Modal.close(); } catch (e) { U.$('settings-err').textContent = tr(e.message); }
      });
    });
  }

  async function testTelegram() {
    try {
      const r = await U.api('/api/telegram/test', { method: 'POST' });
      if (r.ok) return `<span class="up">${esc(T('tg_test_ok'))}</span> <span class="muted" dir="ltr">${esc((r.results || []).map((x) => x.chatId).join(', '))}</span>`;
      const errs = (r.results || []).filter((x) => !x.ok).map((x) => `${x.chatId}: ${tr(x.error || '')}`);
      return `<span class="down">${esc(T('s_failed', { e: r.error || errs.join(' · ') || '—' }))}</span>`;
    } catch (e) { return `<span class="down">${esc(T('s_failed', { e: tr(e.message) }))}</span>`; }
  }

  window.Modal = Modal;
  window.Settings = { open };
})();
