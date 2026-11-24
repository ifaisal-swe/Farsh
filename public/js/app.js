/* AI Trading Terminal — dashboard controller (Arabic-first, RTL-aware). */
(function () {
  'use strict';
  const $ = U.$;
  const I = window.I18N;
  const T = I.T;
  const tr = (s) => window.MSG.tr(s);
  const isNum = U.isNum;
  const APP = { state: null, tf: '1m', ws: null, fills: [], decisions: [], events: [], filter: 'ALL', chart: null, equity: null, chartSymbol: null, inputsInit: false, explainFull: false, symbol: null, hist: { view: 'trades', symbol: '', period: 'all', side: '', result: '', strategy: '', status: '' } };
  try { APP.symbol = localStorage.getItem('terminal.symbol') || null; } catch { /* ignore */ }
  const symFills = () => APP.fills.filter((f) => f.symbol === APP.chartSymbol);
  window.APP = APP;
  const serverNow = () => Date.now() - (APP.serverOffset || 0);
  const ageOf = (ts) => (isNum(ts) ? Math.max(0, serverNow() - ts) : null);
  const ago = (ms) => window.MSG.dur(U.ago(ms));
  const setHTML = (el, html) => { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } };
  const esc = U.esc;
  const PROFILES = ['CONSERVATIVE', 'BALANCED', 'AGGRESSIVE', 'VERY_AGGRESSIVE'];
  const PROFILE_KEYS = ['maxRiskPerTradePct', 'maxDailyLossPct', 'maxDrawdownPct', 'maxPositionPct', 'minRewardRisk', 'maxOpenPositions', 'maxStopDistancePct', 'maxConsecutiveLosses', 'lossCooldownMin', 'maxTradesPerDay'];
  const PROFILE_BOUNDS = {
    maxRiskPerTradePct: [0.05, 5, 0.05], maxDailyLossPct: [0.5, 20, 0.1], maxDrawdownPct: [1, 50, 0.5], maxPositionPct: [1, 100, 1], minRewardRisk: [0.5, 10, 0.1],
    maxOpenPositions: [1, 4, 1], maxStopDistancePct: [0.5, 50, 0.5], maxConsecutiveLosses: [1, 20, 1], lossCooldownMin: [0, 1440, 5], maxTradesPerDay: [1, 200, 1],
  };

  // ------------------------------------------------------------ layout state (persisted per browser)
  const LAYOUT_KEY = 'terminal.layout';
  let layout = { sideW: null, dockH: null, dockCollapsed: false, chartMax: false, sec: {}, overlayMin: false };
  try { layout = { ...layout, ...(JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}')) }; } catch { /* ignore */ }
  const saveLayout = () => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* ignore */ } };
  function applyLayout() {
    const root = document.documentElement;
    // sizes follow the viewport (CSS clamp) until the user drags a splitter
    if (layout.sideW) root.style.setProperty('--side-w', `${layout.sideW}px`); else root.style.removeProperty('--side-w');
    if (layout.dockH) root.style.setProperty('--dock-h', `${layout.dockH}px`); else root.style.removeProperty('--dock-h');
    $('app').classList.toggle('dock-collapsed', !!layout.dockCollapsed);
    $('app').classList.toggle('chart-max', !!layout.chartMax);
    $('btn-expand').title = T(layout.chartMax ? 'restore' : 'expand');
    $('btn-dock').title = T(layout.dockCollapsed ? 'expand_panel' : 'collapse');
    document.querySelectorAll('.sec').forEach((s) => { const k = s.dataset.sec; if (k in layout.sec) s.classList.toggle('collapsed', !!layout.sec[k]); });
  }

  // ------------------------------------------------------------ chart setup
  APP.chart = new TerminalChart($('chart'), { now: serverNow });
  APP.chart.onMarkerClick = (id) => onMarker(id);
  APP.chart.onCandleClick = (bar) => openInspector(bar);
  APP.chart.onAnnotationClick = (h) => openAnnotation(h);
  APP.chart.onTechnicals = () => { renderExplain(); if (activeTab() === 'indicators') renderIndicators(); };
  APP.chart.onLayersChange = () => { buildLayersMenu(); renderPriceLines(); renderOverlay(); };

  async function loadChart() {
    if (APP.chartLoading) { APP.chartReload = true; return; }
    APP.chartLoading = true;
    try {
      const d = await U.api(`/api/bars?tf=${APP.tf}${APP.symbol ? `&symbol=${encodeURIComponent(APP.symbol)}` : ''}`);
      const symbolChanged = APP.chartSymbol !== (APP.state && APP.state.symbol) || APP.chartTf !== APP.tf;
      APP.chart.setTimeframe(APP.tf);
      APP.chart.setData(d.bars || []);
      APP.chartSymbol = d.symbol || (APP.state && APP.state.symbol);
      APP.chart.setFills(symFills());
      APP.chart.setDecisions(APP.decisions);
      APP.overnightInfo = d.overnight || null;
      if (symbolChanged) APP.chart.showRecent(APP.tf === '1d' ? 260 : 160);
      APP.chartTf = APP.tf;
      renderIndicators();
      renderPriceLines();
      renderExplain();
    } catch (e) { U.toast(T('chart_load_failed', { e: e.message }), 'err'); }
    APP.chartLoading = false;
    if (APP.chartReload) { APP.chartReload = false; loadChart(); }
  }

  document.querySelectorAll('#tf-seg button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#tf-seg button').forEach((x) => x.classList.toggle('active', x === b));
    APP.tf = b.dataset.tf;
    subscribe();
    closeInspector();
    loadChart();
  }));
  $('btn-zoom-in').addEventListener('click', () => APP.chart.zoom(0.7));
  $('btn-zoom-out').addEventListener('click', () => APP.chart.zoom(1.4));
  $('btn-fit').addEventListener('click', () => APP.chart.fit());
  $('btn-live').addEventListener('click', () => APP.chart.scrollToRealtime());
  $('btn-expand').addEventListener('click', () => { layout.chartMax = !layout.chartMax; saveLayout(); applyLayout(); });
  $('btn-fullscreen').addEventListener('click', () => {
    const el = $('chart-area');
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (el.requestFullscreen) el.requestFullscreen().catch((e) => U.toast(e.message, 'err'));
  });
  document.addEventListener('fullscreenchange', () => { $('btn-fullscreen').title = T(document.fullscreenElement ? 'exit_fullscreen' : 'fullscreen'); $('btn-fullscreen').classList.toggle('active', !!document.fullscreenElement); });

  // ------------------------------------------------------------ layers menu
  function buildLayersMenu() {
    const L = APP.chart.layers;
    const item = (k, label) => `<label class="chk"><input type="checkbox" data-layer="${k}" ${L[k] ? 'checked' : ''}> ${esc(T(label))}</label>`;
    const maNames = { ema9: 'EMA9', ema21: 'EMA21', ema50: 'EMA50', sma20: 'SMA20', sma50: 'SMA50', sma200: 'SMA200', vwap: 'VWAP', bb: 'BB' };
    setHTML($('layers-menu'), `<h5>${esc(T('layers_title'))}</h5>
      ${item('swings', 'layer_swings')}${item('levels', 'layer_levels')}${item('trend', 'layer_trend')}${item('breaks', 'layer_breaks')}${item('patterns', 'layer_patterns')}
      ${item('fills', 'layer_fills')}${item('ai', 'layer_ai')}${item('stops', 'layer_stops')}${item('targets', 'layer_targets')}${item('ma', 'layer_ma')}
      <div class="chips" dir="ltr">${window.CHART_MA_KEYS.map((k) => `<button data-ma="${k}" class="${L.maSet[k] ? 'active' : ''}">${maNames[k]}</button>`).join('')}</div>
      ${item('momentum', 'layer_momentum')}${item('volume', 'layer_volume')}${item('extended', 'layer_extended')}
      <div class="presets"><button class="btn small" data-preset="clean">${esc(T('preset_clean'))}</button><button class="btn small" data-preset="detailed">${esc(T('preset_detailed'))}</button></div>
      <h5>${esc(T('legend_styles'))}</h5>
      <ul class="legend-list"><li>${esc(T('style_exec'))}</li><li>${esc(T('style_position'))}</li><li>${esc(T('style_pending'))}</li><li>${esc(T('style_proposed'))}</li><li>${esc(T('style_forecast'))}</li><li>${esc(T('style_levels'))}</li><li>${esc(T('style_sessions'))}</li><li>${esc(T('overnight_bars'))}</li></ul>`);
  }
  $('layers-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('button');
    if (b && b.dataset.ma) APP.chart.setLayer(b.dataset.ma, !APP.chart.layers.maSet[b.dataset.ma]);
    else if (b && b.dataset.preset) APP.chart.preset(b.dataset.preset);
  });
  $('layers-menu').addEventListener('change', (e) => { const c = e.target.closest('input[data-layer]'); if (c) APP.chart.setLayer(c.dataset.layer, c.checked); });
  function toggleMenu(menuId, btnId) {
    const m = $(menuId);
    const open = m.classList.contains('hidden');
    document.querySelectorAll('.menu').forEach((x) => x.classList.add('hidden'));
    if (open) { if (menuId === 'layers-menu') buildLayersMenu(); m.classList.remove('hidden'); }
    void btnId;
  }
  $('btn-layers').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('layers-menu'); });
  $('btn-more').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('more-menu'); });
  $('more-menu').addEventListener('click', () => $('more-menu').classList.add('hidden'));
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu-wrap')) document.querySelectorAll('.menu').forEach((x) => x.classList.add('hidden')); });

  // ------------------------------------------------------------ panels: collapse, splitters, dock
  document.querySelectorAll('.sec-h').forEach((h) => h.addEventListener('click', () => {
    const s = h.parentElement;
    s.classList.toggle('collapsed');
    layout.sec[s.dataset.sec] = s.classList.contains('collapsed');
    saveLayout();
  }));
  $('btn-dock').addEventListener('click', () => { layout.dockCollapsed = !layout.dockCollapsed; saveLayout(); applyLayout(); });
  function dragger(el, onMove) {
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      el.setPointerCapture(e.pointerId);
      el.classList.add('dragging'); document.body.classList.add('resizing');
      const move = (ev) => onMove(ev);
      const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.classList.remove('dragging'); document.body.classList.remove('resizing'); saveLayout(); };
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', up);
    });
  }
  dragger($('split-side'), (e) => {
    const r = $('side').getBoundingClientRect();
    const rtl = document.documentElement.dir === 'rtl';
    const w = rtl ? e.clientX - r.left : r.right - e.clientX;
    layout.sideW = Math.round(Math.max(260, Math.min(window.innerWidth * 0.45, w)));
    document.documentElement.style.setProperty('--side-w', `${layout.sideW}px`);
  });
  dragger($('split-dock'), (e) => {
    const h = window.innerHeight - e.clientY;
    layout.dockH = Math.round(Math.max(110, Math.min(window.innerHeight * 0.6, h)));
    layout.dockCollapsed = false;
    document.documentElement.style.setProperty('--dock-h', `${layout.dockH}px`);
    $('app').classList.remove('dock-collapsed');
  });

  // ------------------------------------------------------------ language
  document.querySelectorAll('.lang-switch button').forEach((b) => b.addEventListener('click', () => switchLang(b.dataset.lang, true)));
  function markLang() { document.querySelectorAll('.lang-switch button').forEach((b) => b.classList.toggle('active', b.dataset.lang === I.lang)); }
  function switchLang(l, sync) {
    I.setLang(l);
    markLang();
    if (sync) U.api('/api/settings', { method: 'POST', body: { ui: { language: l } } }).catch((e) => U.toast(e.message, 'err'));
  }
  I.onChange(() => {
    markLang(); applyLayout(); buildLayersMenu(); updateTargetNote();
    APP.chart.relabel();
    rerenderActivity();
    if (APP.state) applyState(APP.state, false);
    renderDecisions(); renderTrades(); renderAnalyses(); renderIndicators(); renderExplain();
    if (APP.inspecting) openInspector(APP.inspecting);
    if (activeTab() === 'equity') loadEquity();
  });

  // ------------------------------------------------------------ websocket
  let wsRetry = 0;
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    APP.ws = ws;
    ws.onopen = () => { wsRetry = 0; subscribe(); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'hello') {
        APP.events = [];
        $('activity').innerHTML = '';
        for (const e of m.activity || []) addActivity(e, false);
        scrollActivity(true);
        if (!I.hasStoredPref() && m.state && m.state.ui && m.state.ui.language && m.state.ui.language !== I.lang) switchLang(m.state.ui.language, false);
        applyState(m.state, true);
      } else if (m.type === 'state') applyState(m.state, false);
      else if (m.type === 'activity') addActivity(m.event, true);
      else if (m.type === 'candle') { if (m.tf === APP.tf && (!m.symbol || m.symbol === APP.chartSymbol)) { APP.chart.updateBar(m.bar); throttleIndicators(); } }
      else if (m.type === 'fill') { if (!APP.fills.some((x) => x.id === m.fill.id)) APP.fills.push(m.fill); if (m.fill.symbol === APP.chartSymbol) APP.chart.addFill(m.fill); if (activeTab() === 'trades') loadHistory(); }
      else if (m.type === 'decision') upsertDecision(m.decision);
      else if (m.type === 'appEvent') { if (m.event && m.event.seq) rememberSeq(m.event.seq); }
      else if (m.type === 'aiProgress') renderProgress(m.progress);
      else if (m.type === 'equity') { if (APP.equity && APP.equityLoaded) APP.equity.add(m.point); }
    };
    ws.onclose = (ev) => {
      if (ev && ev.code === 4401) { location.replace('/login'); return; }
      setPill('h-feed', T('ui_disconnected'), 'red');
      // a refused upgrade (e.g. login expired) also closes the socket: check before retrying
      if (wsRetry > 1) fetch('/api/auth/status', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => { if (j.required && !j.authenticated) location.replace('/login'); }).catch(() => {});
      const delay = Math.min(10000, 500 * 2 ** wsRetry++);
      setTimeout(connect, delay);
    };
  }
  function send(m) { if (APP.ws && APP.ws.readyState === 1) APP.ws.send(JSON.stringify(m)); }
  function subscribe() { send({ type: 'subscribe', tf: APP.tf, symbol: APP.symbol || undefined }); }
  function selectSymbol(sym) {
    if (!sym || sym === APP.symbol) return;
    APP.symbol = sym;
    try { localStorage.setItem('terminal.symbol', sym); } catch { /* ignore */ }
    closeInspector();
    subscribe();
    U.toast(T('wl_selected', { sym }), 'ok');
  }

  // ------------------------------------------------------------ state rendering
  function setPill(id, text, color) { U.set(id, text, `pill ${color || ''}`); }
  const TONE = { green: 'green', amber: 'amber', red: 'red', gray: 'gray' };

  function applyState(s, initial) {
    const wl = s.watchlist || [];
    // the server may push the main symbol's state before our subscription is processed: wait for ours
    if (APP.symbol && s.selectedSymbol && s.selectedSymbol !== APP.symbol && wl.some((w) => w.symbol === APP.symbol)) { subscribe(); return; }
    if (!APP.symbol || !wl.some((w) => w.symbol === APP.symbol)) APP.symbol = s.selectedSymbol || s.symbol || null;
    const prev = APP.state;
    APP.state = s;
    if (isNum(s.serverTime)) APP.serverOffset = Date.now() - s.serverTime;
    const sessionChanged = !prev || (prev.tradingSession && prev.tradingSession.id) !== (s.tradingSession && s.tradingSession.id);
    const symbolChanged = !prev || prev.symbol !== s.symbol || prev.dataMode !== s.dataMode;
    if (!APP.inputsInit || sessionChanged) {
      APP.inputsInit = true;
      if (s.symbol) $('in-symbol').value = s.symbol;
      if (s.tradingSession) {
        $('in-capital').value = s.tradingSession.initialCapital;
        if (s.tradingSession.targetCapital) $('in-target').value = s.tradingSession.targetCapital;
        $('in-demo').checked = s.tradingSession.dataMode === 'DEMO';
      }
      updateTargetNote();
      if (!('session' in layout.sec)) document.querySelector('.sec[data-sec="session"]').classList.toggle('collapsed', !!s.tradingSession);
    }
    if (initial || sessionChanged) { loadFills(); loadDecisions(); APP.equityLoaded = false; if (activeTab() === 'equity') loadEquity(); }
    else if (symbolChanged) loadDecisions();
    if (s.symbol && (initial || symbolChanged || s.chartVersion !== APP.chartVersion)) {
      APP.chartVersion = s.chartVersion;
      loadChart();
    }
    const caKey = s.ai.chartAnalysis ? `${s.ai.chartAnalysis.decisionId}|${s.ai.chartAnalysis.status}` : '';
    if (caKey !== APP.caKey) { APP.caKey = caKey; APP.chart.setAI(s.ai.chartAnalysis); }
    renderHeader(s); renderAI(s); renderNews(s); renderPortfolio(s); renderPosition(s); renderMetrics(s); renderRiskState(s); renderUsage(s);
    renderDataStrip(s); renderBanner(s); renderControls(s); renderApprovals(s); renderPriceLines(); renderRiskProfile(s); renderOverlay(); renderExplain();
    renderWatchlist(s); renderPositions(s); renderReference(s); renderOps(s);
  }

  function renderHeader(s) {
    const md = s.market;
    U.set('h-symbol', s.symbol || '—');
    U.set('h-name', s.asset ? `${s.asset.name || ''}${s.asset.exchange ? ` · ${s.asset.exchange}` : ''}` : '');
    const last = md && md.lastTrade ? md.lastTrade.price : null;
    U.set('h-price', last ? U.price(last) : '—', `px mono num ${U.cls(s.changePct)}`);
    U.set('h-change', s.changePct != null ? U.pct(s.changePct) : '—', `chg mono num ${U.cls(s.changePct)}`);
    U.set('h-pxtime', md && md.lastTrade ? `${T('last_trade')} ${U.etDateTime(md.lastTrade.ts)}` : '');
    const si = s.session;
    if (!si) setPill('h-market', '—');
    else if (md && md.halted) setPill('h-market', I.en('market', 'HALTED'), 'red');
    else setPill('h-market', I.en('market', si.marketStatus) + (si.estimated ? '*' : ''), si.session === 'REGULAR' ? 'green' : si.session === 'CLOSED' ? 'gray' : 'amber');
    if (si) $('h-market').title = sessionTitle(si);
    if (md && md.dataStatus) {
      setPill('h-feed', tr(md.dataStatus.label), TONE[md.dataStatus.tone] || 'red');
      $('h-feed').title = `${tr(md.statusDetail || md.dataStatus.detail || '')}\n${tr(md.feed.note || '')}`.trim();
    } else setPill('h-feed', T('no_data'), 'red');
    const d = s.ai.display;
    const aiColor = { RUNNING: 'green', ANALYZING: 'purple', PAUSED: 'amber', STOPPED: 'gray', IDLE: 'gray', AI_ERROR: 'red', TRADING_DISABLED: 'red', HALTED: 'red', NO_DATA: 'amber', MARKET_CLOSED: 'gray', RISK_PAUSE: 'amber' }[d.code];
    setPill('h-ai', aiLabel(d), aiColor);
    $('h-ai').title = tr(d.detail || '');
    const ts = s.tradingSession;
    setPill('h-session', ts ? `#${ts.id} ${ts.dataMode === 'DEMO' ? (I.isAr ? 'تجريبي' : 'DEMO') : T('paper')} · ${I.en('aiState', s.ai.state)}` : T('no_session'), ts ? (s.ai.state === 'RUNNING' ? 'green' : 'gray') : 'gray');
  }
  function aiLabel(d) {
    if (d.code === 'NO_DATA') return I.isAr ? (d.label === 'WAITING FOR MARKET DATA' ? 'بانتظار بيانات السوق' : 'بانتظار بيانات موثوقة') : d.label;
    return I.en('aiCode', d.code, d.label);
  }

  function sessionTitle(si) {
    const t = (ms) => (isNum(ms) ? `${U.etDate(ms)} ${U.etHM(ms)}` : '—');
    const lines = [`${I.en('market', si.marketStatus)} (${si.source}${si.estimated ? `, ${T('estimated')}` : ''})`];
    if (si.reason && si.session === 'CLOSED') lines.push(tr(si.reason));
    if (si.feed && si.feed.name && si.feed.name !== 'feed') lines.push(T('feed_data', { feed: si.feed.name, s: si.feed.active ? T('expected_now') : T('not_now', { r: tr(si.feed.reason || '') }) }));
    if (si.nextOpenMs) lines.push(T('next_open', { t: t(si.nextOpenMs) }));
    if (si.clock) lines.push(T('alpaca_clock', { s: si.clock.isOpen ? T('clock_open') : T('clock_closed') }));
    return lines.join('\n');
  }

  function actionBadge(a) {
    if (!a) return ['—', 'badge'];
    const t = I.en('action', a);
    if (a === 'BUY') return [t, 'badge buy'];
    if (['SELL', 'EXIT_POSITION', 'REDUCE_POSITION'].includes(a)) return [t, 'badge sell'];
    if (a === 'HOLD') return [t, 'badge hold'];
    return [t, 'badge wait'];
  }

  function renderAI(s) {
    const d = s.ai.display;
    setPill('ai-status', aiLabel(d), { RUNNING: 'green', ANALYZING: 'purple', PAUSED: 'amber', AI_ERROR: 'red', TRADING_DISABLED: 'red', HALTED: 'red', NO_DATA: 'amber', RISK_PAUSE: 'amber' }[d.code] || 'gray');
    U.set('ai-status-detail', d.detail ? tr(d.detail) : (s.ai.decider ? `${T('engine')}: ${tr(s.ai.decider)} · ${T('autonomy')} ${s.ai.autonomy} · ${T('analysis_tf', { tf: s.ai.analysisTimeframe })}` : T('no_engine')));
    U.set('ai-model', s.ai.decider ? tr(s.ai.decider) : '');
    if (!s.ai.progress) renderProgress(null);
    const ld = s.ai.lastDecision;
    const p = ld && ld.proposal;
    const [t, c] = actionBadge(p && p.action);
    U.set('ai-action', t, `${c} big`);
    U.set('ai-conf', p ? `${p.confidence}%` : '—');
    $('ai-conf-bar').style.width = p ? `${p.confidence}%` : '0';
    U.set('ai-trend', p ? I.en('trend', p.trend) : (s.ai.lastAnalysis ? tr(s.ai.lastAnalysis.trend) : '—'));
    U.set('ai-bias', p ? `${I.en('bias', p.directionalBias)} / ${I.en('bias', p.sentiment)}` : '—', p ? (p.directionalBias === 'BULLISH' ? 'up' : p.directionalBias === 'BEARISH' ? 'down' : '') : '');
    U.set('ai-strategy', p ? I.en('strategy', p.strategy) : '—');
    U.set('ai-when', ld ? `${T('last_analysis')}: ${U.etTime(ld.ts)} · ${I.en('decStatus', ld.status)}` : '');
    U.set('ai-rationale', p ? tr(p.rationale) || '—' : (ld && ld.status === 'AI_ERROR' ? T('ai_failed_see_log') : T('no_ai_analysis')));
    U.set('ai-next', p ? `${I.en('action', p.action)}${p.nextAction ? ` — ${tr(p.nextAction)}` : ''}${p.watchLevel ? ` (${T('watch')} ${U.price(p.watchLevel)})` : ''}` : '—');
    U.set('ai-condition', p ? tr(p.marketCondition) || '—' : '—');
    setHTML($('ai-evidence'), p && p.evidence.length ? p.evidence.map((e) => `<li>${esc(tr(e))}</li>`).join('') : '<li class="muted">—</li>');
    U.set('ai-bull', p ? tr(p.bullCase) || '—' : '—');
    U.set('ai-bear', p ? tr(p.bearCase) || '—' : '—');
    U.set('ai-base', p ? tr(p.baseCase) || '—' : '—');
    U.set('ai-invalid', p ? tr(p.invalidation) || '—' : '—');
    U.set('ai-uncert', p ? tr(p.uncertainty) || '—' : '—');
    // decision change vs previous assessment
    const ca = s.ai.chartAnalysis;
    const ch = $('ai-change');
    if (ca && ca.change) {
      const c2 = ca.change;
      ch.classList.remove('hidden');
      ch.className = `decision-change${c2.changed ? '' : ' same'}`;
      setHTML(ch, `<b>${esc(c2.changed ? T('decision_changed', { from: I.en('action', c2.from), to: I.en('action', c2.to) }) : T('decision_same', { to: I.en('action', c2.to) }))}</b>
        <div>${c2.reason ? `${esc(T('reason'))}: ${esc(tr(c2.reason))}` : (c2.changed ? esc(T('no_reason_given')) : '')}</div>
        <div class="muted small">${esc(T('previous_at', { t: `${U.etDate(c2.previousAt)} ${U.etTime(c2.previousAt)}` }))}</div>`);
    } else ch.classList.add('hidden');
    const plan = $('ai-plan');
    if (ca && ca.plan && isNum(ca.plan.entry)) {
      plan.classList.remove('hidden');
      const kind = { PROPOSED_ENTRY: T('proposed_entry'), PROPOSED_LIMIT: T('proposed_limit'), CONDITIONAL: T('conditional_entry') }[ca.plan.kind] || T('plan');
      setHTML(plan, `<div><label>${esc(kind)}</label><b class="num">${U.price(ca.plan.entry)}</b></div><div><label>${esc(T('stop_loss'))}</label><b class="num down">${U.price(ca.plan.stop)}</b></div><div><label>${esc(T('take_profit'))}</label><b class="num up">${U.price(ca.plan.target)}</b></div><div><label>${esc(T('rr_short'))}</label><b class="num">${ca.plan.rewardToRisk}</b></div>
        <div class="note">${esc(I.isAr ? 'مستويات مقترحة من الذكاء الاصطناعي — ليست صفقة منفذة. يتحقق محرك المخاطر منها قبل أي تنفيذ.' : 'AI-proposed levels — not an executed trade. The risk engine validates them before any execution.')}</div>`);
    } else plan.classList.add('hidden');
  }

  function renderProgress(p) {
    const el = $('ai-progress');
    if (!p || p.phase === 'done') { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const secs = p.startedAt ? ((Date.now() - p.startedAt) / 1000).toFixed(0) : '';
    const ar = I.isAr;
    const txt = {
      waiting: ar ? 'بانتظار DeepSeek…' : 'Waiting for DeepSeek…',
      thinking: ar ? `النموذج يفكر (تفكير مخفي) · ${U.num(p.reasoningChars)} حرف` : `Model reasoning (hidden) · ${U.num(p.reasoningChars)} chars`,
      answering: ar ? `استلام القرار المنظم · ${U.num(p.contentChars)} حرف` : `Receiving structured decision · ${U.num(p.contentChars)} chars`,
      tool: ar ? `أداة ويب: ${p.tool || ''}` : `Web tool: ${p.tool || ''}`,
    }[p.phase] || p.phase;
    U.set('ai-progress-text', `${txt}${secs ? ` · ${secs}${ar ? ' ث' : 's'}` : ''}`);
  }

  function renderNews(s) {
    const items = s.news || [];
    U.set('news-count', T('news_count', { n: items.length }));
    setHTML($('news-sources'), (s.newsSources || []).map((x) => `<span class="${x.state === 'ok' ? 'ok' : x.state === 'error' ? 'error' : x.state === 'disabled' ? 'disabled' : ''}" title="${esc(tr(x.lastError || x.note || ''))}">${esc(x.name)}${x.state === 'disabled' ? ` ${T('source_off')}` : x.state === 'error' ? ' ✕' : ''}</span>`).join(''));
    const ld = s.ai.lastDecision;
    const notes = new Map(((ld && ld.proposal && ld.proposal.newsAssessment) || []).map((n) => [n.newsId, n]));
    const html = items.slice(0, 25).map((n) => {
      const url = U.safeUrl(n.url);
      const verCls = n.officialConfirmed ? 'official' : /MEDIA/.test(n.verification) ? 'media' : 'unverified';
      const note = notes.get(n.id);
      const title = `<span dir="auto">${esc(n.title)}</span>`;
      return `<div class="news-item ${n.officialConfirmed ? 'official' : ''} ${n.marketImpact === 'HIGH' ? 'high' : ''}">
        ${url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(T('original_headline'))}">${title}</a>` : `<span class="ttl">${title}</span>`}
        ${note && note.note ? `<div class="ainote">${esc(T('ai_note_on_news'))}${esc(note.note)}</div>` : ''}
        <div class="news-meta"><span dir="ltr">${esc(n.source)}</span><span>${esc(T('pub'))} ${n.publishedAt ? U.etDateTime(n.publishedAt) : T('na')}</span><span>${esc(T('got'))} ${U.etTime(n.retrievedAt)}</span></div>
        <div class="news-meta"><span class="chip ${verCls}">${esc(I.en('verification', n.verification, n.verification))}</span><span class="chip">${esc(T('impact', { x: I.en('impact', n.marketImpact, n.marketImpact) }))}</span><span class="chip ${esc(n.sentiment)}">${esc(I.en('bias', n.sentiment, n.sentiment))}</span><span class="chip">${esc(I.en('retrieval', n.retrievalLevel, n.retrievalLevel))}</span><span class="chip" title="${esc(tr(n.relevanceReason))}">${esc(T('relevance', { x: (n.relevance * 100).toFixed(0) }))}</span>${n.duplicateOf ? `<span class="chip dup">${esc(T('duplicate'))}</span>` : ''}</div>
      </div>`;
    }).join('');
    setHTML($('news-list'), html || `<div class="muted small">${esc(T('no_news'))}</div>`);
    const wr = s.ai.webResearch;
    const w = $('web-research');
    if (wr) {
      w.classList.remove('hidden');
      setHTML(w, `<div class="lbl">${esc(T('web_research', { t: U.etTime(Date.parse(wr.at)) }))}</div><div class="txt small" dir="auto">${esc(wr.text).slice(0, 1200)}</div>${(wr.citations || []).slice(0, 8).map((c) => { const u = U.safeUrl(c.url); return u ? `<div class="small" dir="ltr"><a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(c.title || u)}</a></div>` : ''; }).join('')}`);
    } else w.classList.add('hidden');
  }

  function renderPortfolio(s) {
    const p = s.portfolio;
    U.set('p-initial', p ? U.money(p.initialCapital) : '—');
    U.set('p-equity', p ? U.money(p.equity) : '—');
    U.set('p-cash', p ? U.money(p.cash) : '—');
    U.set('p-posval', p ? U.money(p.positionValue) : '—');
    U.set('p-real', p ? U.smoney(p.realizedPnl) : '—', `num ${p ? U.cls(p.realizedPnl) : ''}`);
    U.set('p-unreal', p ? U.smoney(p.unrealizedPnl) : '—', `num ${p ? U.cls(p.unrealizedPnl) : ''}`);
    U.set('p-ret', p ? U.pct(p.totalReturnPct) : '—', `num ${p ? U.cls(p.totalReturnPct) : ''}`);
    U.set('p-expo', p ? U.upct(p.exposurePct) : '—');
    const car = s.capitalAtRisk;
    U.set('p-atrisk', car ? (car.noStop ? T('review_nostop') : `${U.money(car.toStopUsd)} (${U.upct(car.pctOfEquity)})`) : (p ? U.money(0) : '—'), `num ${car && car.toStopUsd > 0 ? 'down' : ''}`);
    const ts = s.tradingSession;
    if (p && ts && ts.targetCapital) {
      const prog = ((p.equity - ts.initialCapital) / (ts.targetCapital - ts.initialCapital)) * 100;
      $('tgt-bar').style.width = `${Math.max(0, Math.min(100, prog))}%`;
      U.set('tgt-pct', T('of_goal', { pct: I.iso(prog.toFixed(1)), ret: I.iso(U.pct(p.totalReturnPct)), tgt: I.iso((((ts.targetCapital - ts.initialCapital) / ts.initialCapital) * 100).toFixed(0)) }));
      U.set('tgt-start', U.money(ts.initialCapital));
      U.set('tgt-end', T('target_label', { v: I.iso(U.money(ts.targetCapital)) }));
    } else {
      $('tgt-bar').style.width = '0';
      U.set('tgt-pct', ts ? T('no_target') : '—'); U.set('tgt-start', '—'); U.set('tgt-end', '—');
    }
  }

  function renderPosition(s) {
    const pos = s.position;
    if (!pos) {
      setPill('pos-status', T('flat'), 'gray');
      ['pos-avg', 'pos-stop', 'pos-tp', 'pos-trail', 'pos-risk'].forEach((id) => U.set(id, '—'));
      U.set('pos-qty', '0');
    } else {
      const upnl = pos.mark ? pos.qty * (pos.mark - pos.avgPrice) : null;
      setPill('pos-status', `${T('long')} ${U.smoney(upnl)}`, upnl >= 0 ? 'green' : 'red');
      U.set('pos-qty', String(pos.qty));
      U.set('pos-avg', U.price4(pos.avgPrice));
      U.set('pos-stop', U.price4(pos.stop));
      U.set('pos-tp', U.price4(pos.takeProfit));
      U.set('pos-trail', pos.trailingStopPct ? `${pos.trailingStopPct}%` : T('off'));
      U.set('pos-risk', pos.stop && pos.mark ? U.money(pos.qty * Math.max(0, pos.mark - pos.stop)) : '—');
    }
    setHTML($('pending-orders'), (s.pendingOrders || []).map((o) => `<div class="pill amber small" style="margin-top:6px">${esc(T('pending_limit', { qty: o.qty, px: U.price4(o.limitPrice), t: U.etHM(o.expiresAt) }))}</div>`).join(''));
  }

  function renderMetrics(s) {
    const m = s.metrics;
    U.set('m-trades', m ? String(m.closedTrades) : '—');
    U.set('m-exec', m ? String(m.executions) : '—');
    U.set('m-wl', m ? `${m.winningTrades} / ${m.losingTrades}` : '—');
    U.set('m-winrate', m && m.winRatePct != null ? U.upct(m.winRatePct, 1) : '—');
    U.set('m-avgwin', m ? U.money(m.averageWin) : '—', 'num up');
    U.set('m-avgloss', m ? U.money(m.averageLoss) : '—', 'num down');
    U.set('m-pf', m ? (m.profitFactor != null ? m.profitFactor.toFixed(2) : (m.profitFactorNote ? T('na') : '—')) : '—');
    $('m-pf').title = m && m.profitFactorNote ? tr(m.profitFactorNote) : '';
    U.set('m-dd', m ? `-${m.maxDrawdownPct.toFixed(2)}%` : '—', `num ${m && m.maxDrawdownPct > 0 ? 'down' : ''}`);
    U.set('m-fees', m ? U.money(m.tradingFees) : '—');
    const b = s.benchmark;
    U.set('m-bh', b && b.equity != null ? `${U.money(b.equity)} (${U.pct(((b.equity - s.portfolio.initialCapital) / s.portfolio.initialCapital) * 100)})` : T('bh_starts'), b && b.equity != null ? 'num' : '');
    $('m-bh').title = b ? tr(b.note) : '';
    U.set('m-warning', m && m.sampleWarning ? tr(m.sampleWarning) : '');
  }

  function renderRiskState(s) {
    const r = s.risk;
    if (!r) { setPill('risk-status', '—', 'gray'); ['r-day', 'r-dd', 'r-cl', 'r-tt'].forEach((id) => U.set(id, '—')); U.set('risk-limits', ''); setHTML($('risk-blocks'), ''); return; }
    setPill('risk-status', r.disabled ? T('disabled') : r.tradingAllowed ? T('entries_allowed') : T('entries_blocked'), r.disabled ? 'red' : r.tradingAllowed ? 'green' : 'amber');
    U.set('r-day', U.pct(r.dayPnlPct), `num ${U.cls(r.dayPnlPct)}`);
    U.set('r-dd', `-${(r.drawdownPct || 0).toFixed(2)}%`, `num ${r.drawdownPct > 0 ? 'down' : ''}`);
    U.set('r-cl', `${r.consecutiveLosses} / ${r.limits.maxConsecutiveLosses}`);
    U.set('r-tt', `${r.tradesToday} / ${r.limits.maxTradesPerDay}`);
    const L = r.limits;
    U.set('risk-limits', T('limits_line', { a: I.iso(L.maxRiskPerTradePct), b: I.iso(L.maxDailyLossPct), c: I.iso(L.maxDrawdownPct), d: I.iso(L.maxPositionPct), e: I.iso(L.maxSpreadPct), f: I.iso(L.maxSlippagePct), g: I.iso(L.minRewardRisk) }));
    setHTML($('risk-blocks'), r.blocks.map((b) => `<div class="down">⚠ ${esc(tr(b))}</div>`).join('') + (r.disabled ? `<button class="btn tiny danger-outline" id="btn-clear-dd" style="margin-top:4px">${esc(T('clear_disable'))}</button>` : ''));
    const cb = $('btn-clear-dd');
    if (cb && !cb._wired) { cb._wired = true; cb.addEventListener('click', () => act('/api/risk/clear-disable', T('cleared_disable'))); }
  }

  function renderUsage(s) {
    const u = s.ai.usage;
    U.set('u-req', `${u.requests} (${u.requestsLastMinute}/${u.maxRequestsPerMinute}${T('per_min')})`);
    U.set('u-in', U.num(u.inputTokens));
    U.set('u-out', U.num(u.outputTokens));
    U.set('u-cost', `$${u.estimatedCostUsd.toFixed(4)}`);
    U.set('u-left', `$${u.budgetRemainingUsd.toFixed(4)} / $${u.dailyBudgetUsd}`, `num ${u.budgetRemainingUsd <= 0 ? 'down' : ''}`);
    U.set('u-lat', u.lastLatencyMs != null ? `${(u.lastLatencyMs / 1000).toFixed(1)}s` : '—');
    U.set('u-note', T('pricing_note', { p: u.pricingPeriod === 'peak' ? T('peak') : u.pricingPeriod === 'off-peak' ? T('offpeak') : u.pricingPeriod }));
  }

  // ------------------------------------------------------------ risk level (single control)
  function renderRiskProfile(s) {
    const rp = s.riskProfile;
    if (!rp) return;
    const cur = rp.profile;
    const presets = rp.presets || {};
    const cards = PROFILES.map((id) => `<button class="risk-card ${cur === id ? 'active' : ''}" data-p="${id}" role="radio" aria-checked="${cur === id}">
      <span class="dot"></span><span class="nm">${esc(T(`profile_${id}`))}</span><span class="sb">${esc(I.isAr ? T(`profile_sub_${id}`) : '')}</span>
      <span class="rk num">${presets[id] ? `${presets[id].maxRiskPerTradePct}% · ${presets[id].maxDailyLossPct}%` : ''}</span></button>`).join('');
    setHTML($('risk-cards'), cards);
    setPill('risk-profile-badge', T(`profile_${cur}`), { CONSERVATIVE: 'green', BALANCED: 'amber', AGGRESSIVE: 'amber', VERY_AGGRESSIVE: 'red', CUSTOM: 'purple' }[cur]);
    const ex = EX.profile(cur, rp.limits);
    const L = rp.limits;
    const extra = I.isAr
      ? `أقصى مسافة لوقف الخسارة ${I.iso(L.maxStopDistancePct)}%، وتهدئة ${I.iso(L.lossCooldownMin)} دقيقة بعد ${I.iso(L.maxConsecutiveLosses)} خسائر متتالية، وحتى ${I.iso(L.maxTradesPerDay)} صفقات دخول يوميًا.`
      : `Max stop distance ${L.maxStopDistancePct}%, ${L.lossCooldownMin}-min cooldown after ${L.maxConsecutiveLosses} consecutive losses, up to ${L.maxTradesPerDay} entries per day.`;
    setHTML($('risk-explain'), `<b>${esc(ex.head)}</b><div>${esc(ex.desc)} ${esc(extra)}</div>${(s.watchlist || []).length > 1 ? `<div class="note">${esc(T('multi_symbol_note', { n: L.maxOpenPositions, m: s.watchlist.length }))}</div>` : (L.maxOpenPositions > 1 ? `<div class="note">${esc(T('single_symbol_note'))}</div>` : '')}<div class="note">${esc(T('profile_note'))}</div>`);
    if (!$('risk-adv').classList.contains('hidden') && !$('risk-adv').contains(document.activeElement)) renderRiskAdvanced(L);
    renderRiskReview(s);
  }
  function renderRiskAdvanced(L) {
    setHTML($('risk-adv'), PROFILE_KEYS.map((k) => {
      const [lo, hi, st] = PROFILE_BOUNDS[k];
      return `<div><label for="adv-${k}">${esc(T(`p_${k}`))}</label><input id="adv-${k}" data-k="${k}" type="number" dir="ltr" min="${lo}" max="${hi}" step="${st}" value="${esc(L[k])}"></div>`;
    }).join('') + `<div class="full small muted">${esc(T('advanced_note'))}</div><div class="full"><button class="btn small primary" id="adv-apply">${esc(T('apply'))}</button></div>`);
    $('adv-apply').addEventListener('click', applyAdvanced);
  }
  async function applyAdvanced() {
    const L = APP.state.riskProfile.limits;
    const patch = {};
    document.querySelectorAll('#risk-adv input[data-k]').forEach((el) => { const v = Number(el.value); if (Number.isFinite(v) && v !== L[el.dataset.k]) patch[el.dataset.k] = v; });
    if (!Object.keys(patch).length) return;
    try {
      await U.api('/api/settings', { method: 'POST', body: { risk: patch } });
      U.toast(T('s_saved_settings'), 'ok');
      const st = await U.api('/api/state');
      applyState(st, false);
      renderRiskAdvanced(st.riskProfile.limits);
    } catch (e) { U.toast(tr(e.message), 'err'); }
  }
  $('btn-risk-adv').addEventListener('click', () => {
    const el = $('risk-adv');
    el.classList.toggle('hidden');
    $('btn-risk-adv').textContent = T(el.classList.contains('hidden') ? 'advanced_show' : 'advanced_hide');
    $('btn-risk-adv').dataset.i18n = el.classList.contains('hidden') ? 'advanced_show' : 'advanced_hide';
    if (!el.classList.contains('hidden') && APP.state) renderRiskAdvanced(APP.state.riskProfile.limits);
  });
  $('risk-cards').addEventListener('click', async (e) => {
    const b = e.target.closest('.risk-card');
    if (!b || !APP.state || b.classList.contains('active')) return;
    const id = b.dataset.p;
    document.querySelectorAll('.risk-card').forEach((x) => { x.disabled = true; });
    try {
      const r = await U.api('/api/risk/profile', { method: 'POST', body: { profile: id } });
      U.toast(T('profile_applied', { name: T(`profile_${id}`) }), 'ok');
      APP.reviewDismissed = null;
      if (r.state) applyState(r.state, false);
    } catch (err) { U.toast(tr(err.message), 'err'); }
    document.querySelectorAll('.risk-card').forEach((x) => { x.disabled = false; });
  });

  function renderRiskReview(s) {
    const el = $('risk-review');
    const rv = s.riskReview;
    if (!rv || !rv.findings || APP.reviewDismissed === rv.at) { el.classList.add('hidden'); return; }
    const bad = rv.findings.filter((f) => !f.ok);
    const hasPos = !!s.position;
    if (!bad.length && !(rv.to && hasPos)) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.classList.toggle('ok', !bad.length);
    const li = bad.map((f) => {
      const p = f.params || {};
      if (f.code === 'allocation') return T('review_alloc', { pct: I.iso(p.valuePct.toFixed(1)), limit: I.iso(p.limit) });
      if (f.code === 'risk_to_stop') return p.noStop ? T('review_nostop') : T('review_risk', { usd: I.iso(U.money(p.risk)), pct: I.iso(p.riskPct.toFixed(2)), limit: I.iso(p.limit) });
      if (f.code === 'stop_distance') return T('review_stopdist', { pct: I.iso(p.distPct.toFixed(2)), limit: I.iso(p.limit), stop: I.iso(U.price(p.suggestedStop)) });
      if (f.code === 'daily_loss') return T('review_daily', { pct: I.iso(Math.abs(p.dayPnlPct).toFixed(2)), limit: I.iso(p.limit) });
      if (f.code === 'drawdown') return T('review_dd', { pct: I.iso(p.drawdownPct.toFixed(2)), limit: I.iso(p.limit) });
      return f.code;
    });
    const canReduce = hasPos && rv.reduceQty > 0;
    setHTML(el, `<b>${esc(T('review_title'))}</b>${bad.length ? `<ul>${li.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<div>${esc(hasPos ? T('review_ok') : T('review_flat'))}</div>`}
      ${canReduce ? `<div>${esc(T('review_reduce', { qty: rv.reduceQty }))}</div>` : ''}<div class="small muted">${esc(T('stops_active'))}</div>
      <div class="actions">${canReduce ? `<button class="btn small danger" id="rv-reduce">${esc(T('review_reduce_btn', { qty: rv.reduceQty }))}</button>` : ''}<button class="btn small" id="rv-keep">${esc(bad.length ? T('review_keep') : T('close'))}</button></div>`);
    const rb = $('rv-reduce');
    if (rb) rb.onclick = () => confirmReduce(rv.reduceQty);
    $('rv-keep').onclick = () => { APP.reviewDismissed = rv.at; el.classList.add('hidden'); };
  }
  function confirmReduce(qty) {
    Modal.open(T('reduce_confirm_title'), `<p>${esc(T('reduce_confirm', { qty, sym: APP.state.symbol }))}</p><div class="actions"><button class="btn" id="rd-no">${esc(T('cancel'))}</button><button class="btn danger" id="rd-yes">${esc(T('confirm'))}</button></div>`, () => {
      $('rd-no').addEventListener('click', () => Modal.close());
      $('rd-yes').addEventListener('click', async () => { Modal.close(); await act('/api/position/reduce', T('reduce_done'), { qty, confirm: true }); });
    });
  }

  // ------------------------------------------------------------ AI chart explanation panel
  function renderExplain() {
    const el = $('explain');
    const s = APP.state;
    const tech = APP.chart.tech;
    const ld = s && s.ai.lastDecision;
    const p = ld && ld.proposal;
    const ca = s && s.ai.chartAnalysis;
    const aiEx = (ca && ca.explanation) || (p && p.chartExplanation) || {};
    const lastBar = APP.chart.bars[APP.chart.bars.length - 1];
    const sv = lastBar ? APP.chart.seriesValuesAt(lastBar.time) : {};
    const app = tech && tech.available ? EX.sections(tech, { ...sv, close: lastBar && lastBar.close }, { partialVolume: s && s.market && s.market.feed && s.market.feed.feed === 'iex' }) : null;
    if (!app && !p) { setHTML(el, `<div class="muted small">${esc(tech && !tech.available ? T('ex_wait_data') : T('no_ai_analysis'))}</div>`); return; }
    const sec = (key, appText, aiText) => {
      const sum = aiText || appText;
      if (!sum) return '';
      return `<div class="ex-sec"><div class="ex-h">${esc(T(key))}</div>
        <div class="ex-sum">${esc(tr(sum))}</div>
        <div class="detail">${appText ? `<div class="ex-app"><span class="ex-tag">${esc(T('ex_app_data'))}</span>${esc(appText)}</div>` : ''}${aiText ? `<div class="ex-ai"><span class="ex-tag">${esc(T('ex_ai_view'))}</span>${esc(tr(aiText))}</div>` : ''}</div></div>`;
    };
    const a = app || {};
    const stale = ld && serverNow() - ld.ts > 30 * 60000;
    const rows = p ? [
      [T('decision'), `${I.en('action', p.action)} · ${T('confidence')} ${p.confidence}%`],
      [T('reason'), tr(p.rationale) || '—'],
      [T('ex_entry_cond'), aiEx.entryConditions ? tr(aiEx.entryConditions) : (p.watchLevel ? `${T('watch')} ${U.price(p.watchLevel)}` : '—')],
      [T('ex_exit_cond'), aiEx.exitConditions ? tr(aiEx.exitConditions) : (isNum(p.stopLoss) || isNum(p.takeProfit) ? `${T('stop_loss')} ${U.price(p.stopLoss)} · ${T('take_profit')} ${U.price(p.takeProfit)}` : '—')],
      [T('ex_invalid'), tr(p.invalidation) || '—'],
      [T('ex_risk_level'), T(`profile_${p.riskProfile || (s.riskProfile && s.riskProfile.profile) || 'CUSTOM'}`)],
      [T('ex_provider'), `${tr(p.decider || '—')}${p.fallbackFrom ? ` ${T('ex_fallback', { p: p.fallbackFrom === 'gemini' ? 'Gemini' : 'DeepSeek' })}` : ''}`],
      [T('ex_timestamp'), `${U.etDate(ld.ts)} ${U.etTime(ld.ts)}${stale ? ` · ${T('analysis_stale')}` : ''}`],
    ] : [];
    const html = [
      sec('ex_trend', a.trend, aiEx.trend), sec('ex_swings', a.swings, aiEx.swings), sec('ex_levels', a.levels, aiEx.levels), sec('ex_candles', a.candles, aiEx.candles),
      sec('ex_volume', a.volume, aiEx.volume), sec('ex_bull', a.bull, p && p.bullCase), sec('ex_bear', a.bear, p && p.bearCase),
      p ? `<div class="ex-sec"><div class="ex-h">${esc(T('ex_decision'))}</div><div class="ex-rows">${rows.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div></div>` : '',
      p && p.dual && p.dual.providers ? dualHtml(p.dual) : '',
      `<div class="ex-note">${esc(T('ex_app_note'))}</div>`,
      `<button class="link-btn" id="ex-toggle">${esc(T(APP.explainFull ? 'ex_less' : 'ex_more'))}</button>`,
    ].join('');
    el.classList.toggle('full', APP.explainFull);
    setHTML(el, html);
    const tg = $('ex-toggle');
    if (tg) tg.onclick = () => { APP.explainFull = !APP.explainFull; renderExplain(); };
  }

  /** Dual AI analysis: both assessments, agreement / disagreement and the conservative policy applied. */
  function dualHtml(d) {
    const one = (id, name) => {
      const x = d.providers[id];
      if (!x) return '';
      if (x.error) return `<div class="dual-col"><b>${esc(name)}</b><div class="small down">${esc(x.error)}</div></div>`;
      return `<div class="dual-col"><b>${esc(name)}</b> <span class="small muted" dir="ltr">${esc(x.model || '')}</span>
        <div><span class="${actionBadge(x.action)[1]}">${esc(I.en('action', x.action))}</span> · ${esc(T('confidence'))} ${x.confidence}% · ${esc(I.en('trend', x.trend, x.trend || ''))}</div>
        <div class="small">${esc(tr(x.rationale || ''))}</div>${(x.evidence || []).length ? `<ul class="small">${x.evidence.map((e) => `<li>${esc(tr(typeof e === 'string' ? e : JSON.stringify(e)))}</li>`).join('')}</ul>` : ''}</div>`;
    };
    const fld = (arr) => (arr || []).map((a) => `<span class="chip">${esc(a.field)}</span>`).join(' ') || '—';
    return `<div class="ex-sec dual"><div class="ex-h">${esc(T('dual_title'))}</div>
      ${d.policy ? `<div class="small ${d.policy === 'DISAGREE_WAIT' ? 'down' : 'up'}">${esc(T(`dual_policy_${d.policy}`))}</div>` : `<div class="small down">${esc(tr(d.note || ''))}</div>`}
      <div class="dual-grid">${one('deepseek', 'DeepSeek')}${one('gemini', 'Gemini')}</div>
      ${d.policy ? `<div class="ex-rows"><span>${esc(T('dual_agree'))}</span><span>${fld(d.agreement)}</span><span>${esc(T('dual_disagree'))}</span><span>${fld(d.disagreement)}</span>
      <span>${esc(T('dual_unc'))}</span><span>${esc(T(`unc_${d.combinedUncertainty}`))}</span>${(d.missingInformation || []).length ? `<span>${esc(T('dual_missing'))}</span><span>${esc(d.missingInformation.map((x) => tr(x)).join(' · '))}</span>` : ''}</div>
      <div class="small muted">${esc(T('dual_note'))}</div>` : ''}</div>`;
  }

  // ------------------------------------------------------------ chart AI overlay card
  function renderOverlay() {
    const el = $('ai-overlay');
    const s = APP.state;
    if (!s || !APP.chart.layers.ai || !s.tradingSession) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.classList.toggle('min', overlayMin());
    const ld = s.ai.lastDecision;
    const p = ld && ld.proposal;
    const ca = s.ai.chartAnalysis;
    const head = `<div class="ov-h">◆ ${esc(T('ai_overlay_title'))}${ld ? ` <span class="muted small">${esc(T('analysis_age', { age: ago(ageOf(ld.ts)) }))}</span>` : ''}${ld && serverNow() - ld.ts > 30 * 60000 ? ` <span class="stale">${esc(T('analysis_stale'))}</span>` : ''}<button class="x" id="ov-min" title="${esc(T(overlayMin() ? 'show' : 'hide'))}">${overlayMin() ? '▸' : '▾'}</button></div>`;
    if (!p) { setHTML(el, `${head}<div class="ov-body muted">${esc(T('no_ai_analysis'))}</div>`); wireOverlay(); return; }
    const aiEx = (ca && ca.explanation) || p.chartExplanation || {};
    const [bt, bc] = actionBadge(p.action);
    const cond = aiEx.entryConditions || (p.action === 'WAITING_FOR_BREAKOUT' && p.watchLevel ? `${I.isAr ? 'إغلاق فوق' : 'A close above'} ${U.price(p.watchLevel)}` : '') || p.invalidation;
    const change = ca && ca.change && ca.change.changed ? `<div class="ov-row small"><b>↺</b><span>${esc(T('decision_changed', { from: I.en('action', ca.change.from), to: I.en('action', ca.change.to) }))}</span></div>` : '';
    setHTML(el, `${head}<div class="ov-body">
      <div class="ov-row"><b>${esc(T('current_trend'))}:</b><span>${esc(I.en('trend', p.trend))} · ${esc(I.en('bias', p.directionalBias))}</span></div>
      <div class="ov-row"><b>${esc(T('decision'))}:</b><span class="${bc}">${esc(bt)}</span><span class="muted small num">${p.confidence}%</span></div>
      ${change}
      <div class="ov-txt"><b class="muted">${esc(T('reason'))}:</b> ${esc(tr(p.rationale) || '—')}</div>
      ${cond ? `<div class="ov-txt"><b class="muted">${esc(T('required_conditions'))}:</b> ${esc(tr(cond))}</div>` : ''}
      ${ca && ca.unverifiedLevels ? `<div class="small muted">${esc(I.isAr ? `${ca.unverifiedLevels} مستوى غير مؤكد من بيانات التطبيق (خط منقط)` : `${ca.unverifiedLevels} level(s) not confirmed by app data (dotted)`)}</div>` : ''}
    </div>`);
    wireOverlay();
  }
  // on phones the card starts collapsed so it does not cover the chart
  const narrow = window.matchMedia('(max-width: 640px)');
  function overlayMin() { return narrow.matches ? layout.overlayMinMobile !== false : !!layout.overlayMin; }
  function wireOverlay() {
    const b = $('ov-min');
    if (b) b.onclick = () => { if (narrow.matches) layout.overlayMinMobile = !overlayMin(); else layout.overlayMin = !layout.overlayMin; saveLayout(); renderOverlay(); };
  }

  // ------------------------------------------------------------ data strip & banner
  function renderDataStrip(s) {
    const md = s.market;
    const q = md && md.quote;
    const ds = md && md.dataStatus;
    U.set('d-status', ds ? tr(ds.label) : T('no_data'), `pill status-btn ${ds ? (TONE[ds.tone] || 'red') : 'red'}`);
    U.set('d-bid', q ? U.price4(q.bid) : '—'); U.set('d-bidsz', q && q.bidSize != null ? `×${q.bidSize}` : '');
    U.set('d-ask', q ? U.price4(q.ask) : '—'); U.set('d-asksz', q && q.askSize != null ? `×${q.askSize}` : '');
    U.set('d-spread', md && md.spread != null ? `${md.spread.toFixed(4)} (${md.spreadPct.toFixed(3)}%)` : '—');
    const lt = md && md.lastTrade;
    U.set('d-last', lt ? `${U.price4(lt.price)} ×${lt.size}` : '—');
    U.set('d-time', lt ? `${U.etTime(lt.ts)}${lt.source === 'snapshot' ? ` (${T('snapshot_src')})` : ''}` : '');
    U.set('d-qtime', q ? U.etTime(q.ts) : '—');
    const fresh = md && md.freshness && !md.freshness.stale;
    U.set('d-age', q ? `${T('old', { a: ago(ageOf(q.ts)) })}${q.source === 'snapshot' ? ` · ${T('snapshot_src')}` : ''}` : '', q ? (fresh ? 'up' : 'down') : 'muted');
    const lb = md && md.lastBar;
    U.set('d-btime', lb ? U.etHM(lb.time * 1000) : '—');
    U.set('d-sess', s.session ? `${I.en('market', s.session.marketStatus)}${s.session.estimated ? ` (${T('estimated')})` : ''}` : '—');
    U.set('d-link', md ? linkText(md) : '—', md && md.link && md.link.subscribed ? 'up' : 'down');
    U.set('d-src', md ? (md.feed.name || md.feed.label) : '—');
    const dk = md && md.dataKind;
    U.set('d-kind', dk ? T(`dk_${dk}`) : '—', `pill kind-pill ${dk === 'LIVE_TRADE' || dk === 'LIVE_QUOTE' ? 'green' : dk === 'INDICATIVE' ? 'purple' : dk === 'DELAYED' || dk === 'SYNTHETIC' || dk === 'REPLAY' ? 'amber' : dk === 'MARKET_CLOSED' ? 'gray' : 'red'}`);
  }
  function linkText(md) {
    const L = md.link || {};
    const st = md.connection.state;
    const stTxt = I.isAr ? ({ SUBSCRIBED: 'مشترك', CONNECTING: 'جارٍ الاتصال', AUTHENTICATING: 'مصادقة', AUTHENTICATED: 'مصادَق', DISCONNECTED: 'منقطع', RECONNECTING: 'إعادة اتصال', ERROR: 'خطأ', UNAVAILABLE: 'غير متاح' }[st] || st) : st;
    if (st === 'SUBSCRIBED') return `${stTxt}${L.heartbeat && L.heartbeat.lastAt ? ` · ♥ ${ago(ageOf(L.heartbeat.lastAt))}` : ''}`;
    if (md.outage) return `${stTxt} · ${I.isAr ? 'محاولة' : 'attempt'} ${md.outage.attempts}`;
    return stTxt;
  }

  function renderBanner(s) {
    const b = $('chart-banner');
    const wm = $('chart-watermark');
    const md = s.market;
    const ds = md && md.dataStatus;
    let html = null;
    let cls = 'red';
    const lastPx = md && md.lastTrade ? T('last_price_at', { px: I.iso(`$${U.price4(md.lastTrade.price)}`), t: U.etDateTime(md.lastTrade.ts) }) : T('no_trade_yet');
    const sub = (t) => `<span class="sub">${t}</span>`;
    if (!s.symbol) { html = `${esc(T('select_stock'))}${sub(esc(T('select_stock_sub')))}`; cls = 'gray'; }
    else if (ds) {
      const diag = md.diagnosis && ['STALE', 'WAITING'].includes(ds.code) ? sub(esc(tr(md.diagnosis.message))) : '';
      const si = s.session || {};
      const label = esc(tr(ds.label));
      switch (ds.code) {
        case 'LIVE': case 'DEMO': case 'REPLAY': break;
        case 'CLOSED': {
          const named = si.feed && si.feed.name && si.feed.name !== 'feed';
          const next = named && si.nextFeedOpenMs ? T('data_resumes', { feed: si.feed.name, t: `${U.etDate(si.nextFeedOpenMs)} ${U.etHM(si.nextFeedOpenMs)}` }) : (si.nextOpenMs ? T('opens_at', { t: `${U.etDate(si.nextOpenMs)} ${U.etHM(si.nextOpenMs)}` }) : '');
          html = `${label}${sub(esc(lastPx + next))}${sub(esc(tr(ds.detail || '')))}`; cls = 'gray'; break;
        }
        case 'QUIET': html = `${label}${sub(esc(lastPx))}${sub(esc(tr(ds.detail)))}`; cls = 'gray'; break;
        case 'WAITING': case 'CONNECTING': html = `${label}${sub(esc(tr(ds.detail || '')))}${diag}`; cls = 'amber'; break;
        case 'STALE': html = `${label}${sub(esc(md.freshness.reasons.map(tr).join(I.isAr ? '؛ ' : '; ')))}${diag}`; cls = 'amber'; break;
        case 'DELAYED': html = `${label}${sub(esc(T('delayed_sub')))}`; cls = 'amber'; break;
        case 'HALTED': html = `${label}${sub(`${esc(tr(ds.detail))} · ${esc((md.haltInfo && md.haltInfo.source) || '')}`)}`; break;
        case 'RECONNECTING': html = `${label}${sub(esc(tr(ds.detail)))}${sub(esc(lastPx))}`; cls = ds.tone === 'gray' ? 'gray' : 'red'; break;
        default: html = `${label}${sub(esc(tr(ds.detail || 'Unknown error')))}`;
      }
    }
    if (html) { setHTML(b, html); b.className = `chart-banner ${cls}`; } else b.className = 'chart-banner hidden';
    if (s.dataMode === 'DEMO') { wm.textContent = T('demo_watermark'); wm.classList.remove('hidden'); } else wm.classList.add('hidden');
  }

  function healthBody() {
    const st = APP.state;
    const md = st.market;
    const L = md.link || {};
    const si = st.session || {};
    const ds = md.dataStatus;
    const mark = { ok: '✓', bad: '✗', warn: '!', na: '·' };
    const row = (state, k, v) => `<span class="${state}">${mark[state]}</span><span class="k">${esc(k)}</span><span>${v}</span>`;
    const when = (x) => (x ? `${U.etDateTime(x.ts)} · ${esc(T('h_ago_exch', { a: ago(ageOf(x.ts)) }))}${x.source && x.source !== 'stream' ? ` · ${esc(T('h_from', { s: x.source }))}` : ''}` : esc(T('h_none')));
    const sb = L.subscription;
    const closed = ds.code === 'CLOSED';
    const yes = (b) => (b ? '✓' : '✗');
    const rows = [
      row(L.socketOpen ? 'ok' : 'bad', T('h_ws'), esc(`${linkText(md)}${md.connection.detail ? ` — ${tr(md.connection.detail)}` : ''} (${T('h_since', { t: U.etTime(md.connection.since) })})`)),
      row(L.authenticated ? 'ok' : 'bad', T('h_auth'), esc(L.authenticated ? T('h_auth_ok') : T('h_auth_no'))),
      row(sb && sb.trades && sb.quotes && sb.bars ? 'ok' : 'bad', T('h_sub'), sb ? `${esc(st.symbol)}: ${esc(T('h_trades'))} ${yes(sb.trades)} · ${esc(T('h_quotes'))} ${yes(sb.quotes)} · ${esc(T('h_bars'))} ${yes(sb.bars)}${sb.statuses ? ` · ${esc(T('h_halts'))} ✓` : ''} ${esc(T('h_confirmed', { t: U.etTime(sb.confirmedAt) }))}` : esc(T('h_not_confirmed'))),
      row(L.heartbeat && L.heartbeat.lastAt ? 'ok' : 'na', T('h_heartbeat'), L.heartbeat && L.heartbeat.lastAt ? `${esc(ago(ageOf(L.heartbeat.lastAt)))}${L.heartbeat.rttMs != null ? ` · ${esc(T('h_rtt', { ms: L.heartbeat.rttMs }))}` : ''}` : esc(T('h_none'))),
      row(L.sinceSubscribe && L.sinceSubscribe.firstAt ? 'ok' : (closed ? 'na' : 'warn'), T('h_live_msgs'), L.sinceSubscribe ? `${L.sinceSubscribe.trades} ${esc(T('h_trades'))} · ${L.sinceSubscribe.quotes} ${esc(T('h_quotes'))} · ${L.sinceSubscribe.bars} ${esc(T('h_bars'))}${md.msgRate ? ` · ${esc(T('h_last_min', { t: md.msgRate.tradesPerMin.toFixed(0), q: md.msgRate.quotesPerMin.toFixed(0) }))}` : ''}` : '—'),
      row(md.lastTrade ? 'ok' : 'na', T('h_latest_trade'), md.lastTrade ? `<span class="num">$${U.price4(md.lastTrade.price)} × ${md.lastTrade.size}</span> · ${when(md.lastTrade)}` : esc(T('h_none'))),
      row(md.quote ? (md.freshness.stale ? 'warn' : 'ok') : 'na', T('h_latest_quote'), md.quote ? `<span class="num">${U.price4(md.quote.bid)} / ${U.price4(md.quote.ask)}</span> · ${when(md.quote)}` : esc(T('h_none'))),
      row(md.lastBar ? 'ok' : 'na', T('h_latest_bar'), md.lastBar ? `${U.etDate(md.lastBar.time * 1000)} ${U.etHM(md.lastBar.time * 1000)} · ${esc(T('close_px'))} <span class="num">${U.price4(md.lastBar.close)}</span>` : esc(T('h_none'))),
      row(!md.freshness.stale ? 'ok' : (closed ? 'na' : 'bad'), T('h_exec_quality'), !md.freshness.stale ? esc(T('h_fresh', { a: ago(md.freshness.quoteAgeMs) })) : esc(md.freshness.reasons.map(tr).join('؛ '))),
      row(si.session === 'REGULAR' ? 'ok' : 'na', T('h_session'), esc(`${I.en('market', si.marketStatus || '—')}${si.reason && si.session === 'CLOSED' ? ` — ${tr(si.reason)}` : ''} · ${si.source || ''}${si.clock ? ` · ${T('alpaca_clock', { s: si.clock.isOpen ? T('clock_open') : T('clock_closed') })}` : ''}`)),
      row(si.feed && si.feed.active ? 'ok' : 'na', T('h_coverage', { feed: (si.feed && si.feed.name) || '' }), esc(si.feed ? (si.feed.active ? T('h_expected') : T('h_not_expected', { r: tr(si.feed.reason || '') })) : '—')),
    ];
    if (si.clock && si.clock.skewMs != null) rows.push(row(Math.abs(si.clock.skewMs) > 2000 ? 'warn' : 'ok', T('h_clock'), `${(Math.abs(si.clock.skewMs) / 1000).toFixed(1)}${I.isAr ? ' ث' : 's'} ${esc(si.clock.skewMs >= 0 ? T('h_ahead') : T('h_behind'))}`));
    if (md.diagnosis) rows.push(row('warn', T('h_diag'), esc(tr(md.diagnosis.message))));
    return `<p><span class="pill ${TONE[ds.tone] || 'red'}">${esc(tr(ds.label))}</span></p>
      <div class="health-grid">${rows.join('')}</div>
      <p class="health-note">${esc(tr(md.statusDetail || ''))}</p>
      <p class="health-note">${esc(tr(md.feed.note || ''))}${si.feed && si.feed.note ? ` ${esc(tr(si.feed.note))}` : ''}</p>`;
  }
  function openDataHealth() {
    if (!APP.state || !APP.state.market) { U.toast(T('no_market_loaded')); return; }
    Modal.open(T('health_title'), `<div id="health-body">${healthBody()}</div><div class="actions"><button class="btn" id="hl-close">${esc(T('close'))}</button></div>`, () => {
      $('hl-close').addEventListener('click', () => Modal.close());
      const t = setInterval(() => { const el = $('health-body'); if (!el || !APP.state || !APP.state.market) { clearInterval(t); return; } el.innerHTML = healthBody(); }, 1000);
    });
  }

  function renderControls(s) {
    const hasSession = !!s.tradingSession;
    const st = s.ai.state;
    const startDisabled = hasSession && (st === 'RUNNING' || st === 'PAUSED');
    $('btn-start').disabled = startDisabled;
    $('btn-start-big').disabled = startDisabled;
    $('btn-start-big').textContent = hasSession && st === 'STOPPED' ? T('start_continue') : T('start');
    $('btn-pause').disabled = st !== 'RUNNING';
    $('btn-resume').disabled = !(hasSession && (st === 'PAUSED' || st === 'STOPPED'));
    $('btn-stop').disabled = !(hasSession && (st === 'RUNNING' || st === 'PAUSED'));
    $('btn-analyze').disabled = !hasSession;
    $('btn-close').disabled = !s.position;
    $('btn-change-capital').disabled = !hasSession;
    $('btn-reset').disabled = !hasSession;
  }

  function renderApprovals(s) {
    const el = $('approvals');
    const list = s.ai.approvals || [];
    const html = list.map((a) => `<div class="approval"><b>${esc(T('approval_awaiting'))}</b> ${esc(I.en('action', a.action))} · ${esc(T('expires'))} ${U.etTime(a.expiresAt)}<div class="row" style="margin-top:5px"><button class="btn small primary" data-approve="${esc(a.id)}">${esc(T('approve'))}</button><button class="btn small" data-reject="${esc(a.id)}">${esc(T('reject'))}</button><button class="btn small ghost" data-view="${esc(a.id)}">${esc(T('details'))}</button></div></div>`).join('');
    if (el._h === html) return;
    setHTML(el, html);
    el.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => act(`/api/proposals/${b.dataset.approve}/approve`, T('approved_ok'))));
    el.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => act(`/api/proposals/${b.dataset.reject}/reject`, T('rejected_ok'))));
    el.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => openDecision(b.dataset.view)));
  }

  /** Price lines of the ACTUAL position and pending orders (solid = real, dotted amber = pending). */
  function renderPriceLines() {
    const s = APP.state;
    if (!s) return;
    const L = APP.chart.layers;
    const lines = [];
    const ar = I.isAr;
    if (s.position) {
      lines.push({ key: 'entry', price: s.position.avgPrice, color: '#e5e7eb', title: `${ar ? 'دخول فعلي' : 'ENTRY'} ${s.position.qty}`, style: 0 });
      if (L.stops) lines.push({ key: 'stop', price: s.position.stop, color: '#ef4444', title: ar ? 'وقف الخسارة' : 'STOP', style: 0, width: 2 });
      if (L.targets) lines.push({ key: 'tp', price: s.position.takeProfit, color: '#22c55e', title: ar ? 'جني الأرباح' : 'TARGET', style: 0, width: 2 });
    }
    for (const o of s.pendingOrders || []) lines.push({ key: `pend_${o.id}`, price: o.limitPrice, color: '#f59e0b', title: `${ar ? 'شراء معلق' : 'PENDING BUY'} ${o.qty}`, style: 1, width: 2 });
    APP.chart.syncPriceLines(lines);
  }

  // ------------------------------------------------------------ chart interaction: inspector & annotations
  function closeInspector() { $('inspector').classList.add('hidden'); APP.inspecting = null; }
  function showInspector(html) {
    const el = $('inspector');
    el.innerHTML = html;
    el.classList.remove('hidden');
    const x = el.querySelector('.x');
    if (x) x.onclick = closeInspector;
    el.querySelectorAll('[data-open-fill]').forEach((b) => b.addEventListener('click', () => openFill(b.dataset.openFill)));
    el.querySelectorAll('[data-open-dec]').forEach((b) => b.addEventListener('click', () => openDecision(b.dataset.openDec)));
  }
  const hdr = (title, extra = '') => `<div class="in-h"><b>${esc(title)}</b>${extra}<button class="x" title="${esc(T('close'))}">✕</button></div>`;

  function openInspector(bar) {
    APP.inspecting = bar;
    const tech = APP.chart.tech;
    const atr = tech && tech.available ? tech.atr : null;
    const a = window.Technicals.anatomy(bar, { atr, levels: tech && tech.available ? tech.levels : null });
    const sv = APP.chart.seriesValuesAt(bar.time);
    const ex = EX.candle(a, { relVol: sv.relVol });
    const forming = !APP.chart.isComplete(bar);
    const dirTxt = a.direction === 'UP' ? T('dir_up') : a.direction === 'DOWN' ? T('dir_down') : T('dir_flat');
    const pctOf = (x) => (a.range > 0 ? ` (${((x / a.range) * 100).toFixed(0)}%)` : '');
    const kv = [
      [T('open'), U.price(bar.open)], [T('high'), U.price(bar.high)], [T('low'), U.price(bar.low)], [T('close_px'), U.price(bar.close)],
      [T('volume'), U.num(bar.volume)], [T('candle_tf'), T(`tf_name_${APP.tf}`)], [T('candle_dir'), dirTxt], [T('candle_range'), U.price(a.range)],
      [T('body_size'), `${U.price(a.body)}${pctOf(a.body)}`], [T('upper_wick'), `${U.price(a.upperWick)}${pctOf(a.upperWick)}`], [T('lower_wick'), `${U.price(a.lowerWick)}${pctOf(a.lowerWick)}`], ['RSI 14', sv.rsi14 != null ? sv.rsi14.toFixed(1) : T('na')],
    ];
    let more = '';
    if (tech && tech.available) {
      const pats = tech.patterns.filter((p) => p.time === bar.time);
      for (const p of pats) {
        const near = a.near ? { name: a.near.rank ? EX.levelName({ rank: a.near.rank }) : EX.levelName({ role: a.near.origin, status: a.near.status, origin: a.near.origin }), price: a.near.price, touched: a.near.touched, distancePct: a.near.distancePct } : null;
        const e = EX.pattern(p, { near });
        more += `<div class="pat"><b>${esc(e.name)}</b> <span class="tag-dir">${esc(I.en('bias', p.direction === 'NEUTRAL' ? 'NEUTRAL' : p.direction))}</span><p>${esc(e.why)}</p><p>${esc(e.meaning)}</p><p class="muted">${esc(e.context)}</p><p><b>${esc(e.confirmation)}</b> — ${esc(e.needs)}</p><p class="note">${esc(e.disclaimer)}</p></div>`;
      }
      for (const sw of tech.swings.points.filter((p) => p.time === bar.time)) { const e = EX.swing(sw); more += `<div class="pat"><b>${esc(e.title)}</b><p>${esc(e.text)}</p></div>`; }
      for (const ev of tech.events.filter((x) => x.time === bar.time)) { const e = EX.breakEvent(ev); more += `<div class="pat"><b>${esc(e.title)}</b><p>${esc(e.text)}</p></div>`; }
    }
    for (const f of APP.fills.filter((x) => APP.chart.bucket(x.ts) === bar.time)) more += `<div class="pat"><button class="link-btn" data-open-fill="${esc(f.id)}">${esc(`${I.en('side', f.side)} ${f.qty} @ ${U.price4(f.price)}`)}</button></div>`;
    for (const d of APP.decisions.filter((x) => x.action && APP.chart.bucket(x.ts) === bar.time).slice(0, 3)) more += `<div class="pat"><button class="link-btn" data-open-dec="${esc(d.id)}">${esc(`AI: ${I.en('action', d.action)} · ${I.en('decStatus', d.status)}`)}</button></div>`;
    showInspector(`${hdr(`${T('candle_inspector')} · ${U.etDateTime(bar.time * 1000)}`, forming ? `<span class="pill amber small">${esc(T('forming'))}</span>` : '')}
      <div class="kv">${kv.map(([k, v]) => `<span>${esc(k)}</span><span class="num">${esc(v)}</span>`).join('')}</div>
      <p><b>${esc(ex.title)}</b></p><p>${esc(ex.body)}</p>${ex.extras.map((x) => `<p class="muted">${esc(x)}</p>`).join('')}
      ${forming ? `<p class="note">${esc(T('forming_note'))}</p>` : ''}
      ${more ? `<div class="lbl">${esc(T('patterns_here'))}</div>${more}` : ''}`);
  }

  function openAnnotation(h) {
    const price = APP.chart.bars.length ? APP.chart.bars[APP.chart.bars.length - 1].close : null;
    if (h.kind === 'level') {
      const e = EX.level(h.data, price);
      showInspector(`${hdr(e.title)}<div class="kv2">${e.rows.map(([k, v]) => `<span>${esc(k)}</span><span>${esc(v)}</span>`).join('')}</div><p class="note">${esc(e.note)}</p>`);
    } else if (h.kind === 'trendline') { const e = EX.trendline(h.data); showInspector(`${hdr(e.title)}<p>${esc(e.text)}</p>`); }
    else if (h.kind === 'range') { const e = EX.range(h.data); showInspector(`${hdr(e.title)}<p>${esc(e.text)}</p>`); }
    else if (h.kind === 'provisional') showInspector(`${hdr(I.isAr ? 'نقطة تحول غير مؤكدة' : 'Unconfirmed pivot')}<p>${esc(EX.provisional(h.data))}</p>`);
    else if (h.kind === 'ailevel') {
      const l = h.data;
      const ca = APP.state && APP.state.ai.chartAnalysis;
      const kindTxt = { support: I.isAr ? 'دعم' : 'Support', resistance: I.isAr ? 'مقاومة' : 'Resistance', breakout: I.isAr ? 'مستوى الاختراق المحتمل' : 'Potential breakout', breakdown: I.isAr ? 'مستوى الكسر المحتمل' : 'Potential breakdown', watch: I.isAr ? 'مستوى المراقبة' : 'Watch level' }[l.kind];
      const match = l.match ? (I.isAr ? `يطابق مستوى محسوبًا من التطبيق: ${l.match.label} عند ${U.price(l.match.price)} (فارق ${l.match.distancePct}%).` : `Matches an app-computed level: ${l.match.label} at ${U.price(l.match.price)} (${l.match.distancePct}% apart).`) : (I.isAr ? 'لم يطابق أي مستوى محسوب من التطبيق — تقدير من الذكاء الاصطناعي.' : 'Did not match any app-computed level — the AI\'s own estimate.');
      const inv = l.invalidatedAt ? `<p class="down">${esc(T('invalidated_since'))}: ${esc(EX.when(l.invalidatedAt))}</p>` : '';
      showInspector(`${hdr(`AI ${kindTxt} ${U.price(l.price)}`)}<p><b>${esc(l.verified ? T('verified') : T('unverified'))}</b></p><p>${esc(match)}</p>${inv}${ca ? `<p class="muted">${esc(T('last_analysis'))}: ${esc(`${U.etDate(ca.at)} ${U.etTime(ca.at)}`)} · ${esc(I.en('action', ca.action))}</p>` : ''}${ca ? `<button class="link-btn" data-open-dec="${esc(ca.decisionId)}">${esc(T('fm_open_dec'))}</button>` : ''}`);
    } else if (h.kind === 'plan') {
      const p = h.data;
      const ca = APP.state && APP.state.ai.chartAnalysis;
      const v = (m) => (m ? `✓ ${m.label}` : (I.isAr ? 'تقدير الذكاء الاصطناعي' : 'AI estimate'));
      showInspector(`${hdr(I.isAr ? 'خطة مقترحة (غير منفذة)' : 'Proposed plan (not executed)')}
        <div class="kv2"><span>${esc(T('entry'))}</span><span class="num">${U.price(p.entry)}</span><span>${esc(T('stop_loss'))}</span><span><span class="num">${U.price(p.stop)}</span> · ${esc(v(p.stopMatch))}</span><span>${esc(T('take_profit'))}</span><span><span class="num">${U.price(p.target)}</span> · ${esc(v(p.targetMatch))}</span><span>${esc(T('rr_short'))}</span><span class="num">${p.rewardToRisk}</span></div>
        <p class="note">${esc(I.isAr ? 'لا تُعد هذه صفقة منفذة. يحسب محرك المخاطر الحجم والتكاليف ويقرر قبل أي تنفيذ محاكى.' : 'This is not an executed trade. The risk engine sizes it, adds costs and decides before any simulated execution.')}</p>${ca ? `<button class="link-btn" data-open-dec="${esc(ca.decisionId)}">${esc(T('fm_open_dec'))}</button>` : ''}`);
    } else if (h.kind === 'forecast') {
      showInspector(`${hdr(I.isAr ? 'نطاق متوقع (توقع من الذكاء الاصطناعي)' : 'Expected range (AI forecast)')}<p>${esc(I.isAr ? `بين ${U.price(h.data.low)} و${U.price(h.data.high)}. هذا توقع وليس بيانات سوق، وقد لا يتحقق.` : `Between ${U.price(h.data.low)} and ${U.price(h.data.high)}. A forecast, not market data; it may not happen.`)}</p>`);
    }
  }

  function onMarker(id) {
    const tech = APP.chart.tech;
    if (id.startsWith('fill_')) return openFill(id);
    if (id.startsWith('dec:')) return openDecision(id.slice(4));
    if (!tech || !tech.available) return;
    if (id.startsWith('pat:')) {
      const p = tech.patterns.find((x) => `pat:${x.id}` === id);
      const bar = p && APP.chart.bars.find((b) => b.time === p.time);
      if (bar) openInspector(bar);
    } else if (id.startsWith('sw:')) {
      const [, type, t] = id.split(':');
      const p = tech.swings.points.find((x) => x.type === type && String(x.time) === t);
      if (p) { const e = EX.swing(p); showInspector(`${hdr(e.title)}<p>${esc(e.text)}</p>`); }
    } else if (id.startsWith('brk:')) {
      const [, type, t] = id.split(':');
      const ev = tech.events.find((x) => x.type === type && String(x.time) === t);
      if (ev) { const e = EX.breakEvent(ev); showInspector(`${hdr(e.title)}<p>${esc(e.text)}</p>`); }
    }
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeInspector(); });

  // ------------------------------------------------------------ operating states (server / monitoring / AI trading)
  const MON_CLS = { MAXIMUM: 'amber', HIGH: 'amber', ELEVATED: 'amber', NORMAL: 'green', LOW: 'gray', IDLE: 'gray' };
  const OPS_CLS = { ONLINE: 'green', ACTIVE: 'green', DEGRADED: 'amber', PAUSED: 'gray', RISK_BLOCKED: 'amber', ERROR: 'red', OFFLINE: 'red' };
  function renderOps(s) {
    const o = s.operating;
    if (!o) return;
    const srv = APP.serverState || 'ONLINE';
    const pill = (id, short, st, reason) => { const el = $(id); el.textContent = `${T(short)}: ${T(`st_${st}`)}`; el.className = `pill small ${OPS_CLS[st] || 'gray'}`; el.title = reason ? tr(reason) : ''; };
    pill('h-server', 'sv_short', srv, (APP.serverReasons || []).join(', '));
    pill('h-mon', 'mon_short', o.monitoring.state, o.monitoring.reason);
    pill('h-aitr', 'aitr_short', o.aiTrading.state, o.aiTrading.reason);
    U.set('btn-monitoring', T(o.monitoring.pausedByUser ? 'mon_resume' : 'mon_pause'));
    const a = s.adaptive;
    const mm = $('h-mmode');
    mm.classList.toggle('hidden', !(a && a.enabled && a.mode));
    if (a && a.enabled && a.mode) {
      mm.textContent = I.en('monMode', a.mode);
      mm.className = `pill small ${a.mode === 'HIGH_VOLATILITY' ? 'red' : MON_CLS[a.intensity] || 'gray'}`;
      mm.title = `${T('mm_title')}: ${I.en('monIntensity', a.intensity)}${a.highVolatility.length ? ` · ${T('mm_hv')}: ${a.highVolatility.join(', ')}` : ''}`;
    }
  }
  async function refreshServerState() {
    try { const h = await U.api('/api/ops/states'); APP.serverState = h.server.state; APP.serverReasons = h.server.reasons; } catch { APP.serverState = 'OFFLINE'; }
    if (APP.state) renderOps(APP.state);
  }
  setInterval(refreshServerState, 30000);
  $('btn-monitoring').addEventListener('click', () => {
    const o = APP.state && APP.state.operating;
    const resume = !!(o && o.monitoring.pausedByUser);
    const go = async () => { try { await U.api('/api/ops/monitoring', { method: 'POST', body: { active: !!resume } }); U.toast(T(resume ? 'mon_resume' : 'mon_pause'), 'ok'); refreshServerState(); } catch (e) { U.toast(tr(e.message), 'err'); } };
    if (resume) return go();
    Modal.open(T('mon_pause'), `<p>${esc(T('mon_pause_q'))}</p><div class="actions"><button class="btn" id="mp-no">${esc(T('cancel'))}</button><button class="btn warn" id="mp-yes">${esc(T('confirm'))}</button></div>`, () => {
      $('mp-no').onclick = () => Modal.close();
      $('mp-yes').onclick = () => { Modal.close(); go(); };
    });
  });
  // login / logout (the button appears only when the server requires a login)
  fetch('/api/auth/status', { credentials: 'same-origin' }).then((r) => r.json()).then((j) => { if (j.required) $('btn-logout').classList.remove('hidden'); }).catch(() => {});
  $('btn-logout').addEventListener('click', async () => {
    try { await U.api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
    location.replace('/login');
  });

  // ------------------------------------------------------------ "while you were away": catch up on recorded events
  const SEQ_KEY = 'terminal.lastEventSeq';
  const IMPORTANT_EV = new Set(['FILL_EXECUTED', 'ORDER_PENDING', 'ORDER_REJECTED', 'ORDER_CANCELLED', 'ORDER_EXPIRED', 'DECISION_CHANGED', 'RISK_LIMIT', 'AI_PROVIDER_DOWN', 'AI_PAUSED_ERROR', 'ENGINE_UNCLEAN_RESTART', 'ENGINE_CHECK_FAILED', 'MONITORING_STOPPED', 'MONITORING_STARTED', 'NEWS_MATERIAL']);
  // read the marker NOW (page load): live events that arrive before the catch-up must not hide what was missed
  let seqAtLoad = 0;
  try { seqAtLoad = Number(localStorage.getItem(SEQ_KEY)) || 0; } catch { seqAtLoad = 0; }
  function rememberSeq(seq) { try { const cur = Number(localStorage.getItem(SEQ_KEY)) || 0; if (seq > cur) localStorage.setItem(SEQ_KEY, String(seq)); } catch { /* ignore */ } }
  async function catchUp() {
    const last = seqAtLoad;
    let r;
    try { r = await U.api(`/api/events?after=${last}&limit=500`); } catch { return; }
    if (!last) { rememberSeq(r.latestSeq); return; } // first visit on this browser: nothing to replay
    if (r.items.length) rememberSeq(r.items[r.items.length - 1].seq);
    const imp = r.items.filter((e) => IMPORTANT_EV.has(e.type));
    if (!imp.length) return;
    const line = (e) => {
      const d = e.data || {};
      let what = '';
      if (e.type === 'FILL_EXECUTED' && d.fill) what = `${I.en('side', d.fill.side)} ${d.fill.qty} @ ${U.price4(d.fill.price)}${d.fill.side === 'SELL' && isNum(d.fill.realizedPnl) ? ` · ${U.smoney(d.fill.realizedPnl)}` : ''}`;
      else if (e.type === 'DECISION_CHANGED') what = `${I.en('action', d.from)} → ${I.en('action', d.to)}`;
      else if (d.order) what = `${I.en('side', d.order.side)} ${d.order.qty ?? ''}${d.order.rejectReason ? ` · ${tr(d.order.rejectReason).slice(0, 90)}` : ''}`;
      else if (d.message) what = tr(d.message).slice(0, 120);
      else if (d.name) what = `${d.name}${d.code ? ` (${d.code})` : ''}`;
      else if (d.title) what = String(d.title).slice(0, 100);
      return `<tr><td class="num">${U.etDate(e.ts)} ${U.etTime(e.ts)}</td><td dir="ltr">${esc(e.symbol || '')}</td><td>${esc(T(`ev_${e.type}`))}</td><td class="wrap">${esc(what)}</td></tr>`;
    };
    const shown = imp.slice(-40).reverse();
    Modal.open(T('away_title'), `<table class="tbl small"><tbody>${shown.map(line).join('')}</tbody></table>${imp.length > shown.length ? `<p class="small muted">${esc(T('away_more', { n: imp.length - shown.length }))}</p>` : ''}<div class="actions"><button class="btn primary" id="aw-ok">${esc(T('close'))}</button></div>`, () => { $('aw-ok').onclick = () => Modal.close(); });
  }
  setTimeout(() => { catchUp(); refreshServerState(); }, 1500);

  // ------------------------------------------------------------ adaptive market monitoring (local layer; separate from AI trading)
  async function loadMonitoring() {
    let m;
    try { m = await U.api('/api/monitoring'); } catch (e) { setHTML($('adaptive'), `<div class="down">${esc(tr(e.message))}</div>`); return; }
    const cell = (k, v, cls = '') => `<div><label>${esc(T(k))}</label><b class="${cls}"${cls ? '' : ' style="font-family:var(--sans)"'}>${v}</b></div>`;
    const pill = (txt, cls) => `<span class="pill small ${cls}">${esc(txt)}</span>`;
    const mode = (x) => (x ? pill(I.en('monMode', x), x === 'HIGH_VOLATILITY' ? 'red' : x === 'NORMAL_SESSION' ? 'green' : x === 'AFTER_HOURS' || x === 'MARKET_CLOSED' ? 'gray' : 'amber') : '—');
    const num = (x, d = 1, suffix = '') => (isNum(x) ? `<span class="num">${x.toFixed(d)}${suffix}</span>` : '—');
    const rows = m.symbols.map((x) => `<tr><td dir="ltr"><b>${esc(x.symbol)}</b>${x.paused ? ` <span class="chip">${esc(T('wl_paused'))}</span>` : ''}</td><td>${mode(x.mode)}${x.override ? `<div class="small muted">${esc(tr(x.override.reason || ''))}</div>` : ''}</td>
      <td>${num(x.volRatio, 1, 'x')}</td><td>${num(x.relVol, 1, 'x')}</td><td>${num(x.moveZ, 1, 'σ')}</td>
      <td class="num">${x.openingRange && isNum(x.openingRange.high) ? `${U.price(x.openingRange.low)} – ${U.price(x.openingRange.high)}${x.openingRange.complete ? '' : ' …'}` : '—'}</td>
      <td class="num">${isNum(x.gapPct) ? `${U.pct(x.gapPct)}${x.gapIndicative ? ` (${esc(T('mm_indicative'))})` : ''}` : '—'}</td><td class="num">${x.aiToday} / ${m.ai.maxPerSymbolPerDay}</td>
      <td><span class="dot ${x.fresh ? 'ok' : 'bad'}"></span> <span class="small">${esc(tr(x.dataLabel || '—'))}${isNum(x.quoteAgeMs) ? ` · <span class="num">${Math.round(x.quoteAgeMs / 1000)}s</span>` : ''}</span></td></tr>`).join('');
    const why = (e) => Object.entries(e.breakdown || {}).filter(([, v]) => v > 0).map(([k, v]) => `${I.en('monScore', k)} ${v}`).join(' · ');
    const evs = m.recent.map((e) => `<tr><td class="num">${U.etTime(e.at)}</td><td dir="ltr">${esc(e.symbol)}</td><td>${esc(I.en('monEvent', e.type))} ${e.dir > 0 ? '↑' : e.dir < 0 ? '↓' : ''}${e.confirmed ? '' : ` <span class="chip">${esc(T('mm_unconfirmed'))}</span>`}</td>
      <td class="num"><b>${e.score}</b></td><td class="small wrap">${esc(why(e))}</td><td class="small">${e.status === 'DISPATCHED' ? pill(T('mm_dispatched'), 'green') : e.status === 'QUEUED' ? pill(T('mm_queued'), 'amber') : `<span class="muted">${esc(I.en('monReason', e.reason || 'other'))}</span>`}</td></tr>`).join('');
    const sup = Object.entries(m.counters.suppressed || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<span class="chip">${esc(I.en('monReason', k))}: <span class="num">${v}</span></span>`).join(' ');
    setHTML($('adaptive'), `<div class="row" style="gap:8px;flex-wrap:wrap">
        <span>${esc(T('ops_monitoring'))}: ${pill(T(`st_${m.monitoring.state}`), OPS_CLS[m.monitoring.state] || 'gray')}</span>
        <span>${esc(T('ops_ai_trading'))}: ${pill(T(`st_${m.aiTrading.state}`), OPS_CLS[m.aiTrading.state] || 'gray')}</span>
        <span class="small muted">${esc(T('mm_separate'))}</span></div>
      ${m.enabled ? '' : `<div class="small down">${esc(T('mm_disabled'))}</div>`}
      <div class="metrics usage-grid">
        ${cell('mm_session', m.session ? `${esc(I.en('market', m.session.label))}${m.session.earlyClose ? ` · ${esc(T('mm_early'))}` : ''}${m.session.estimated ? ` · ${esc(T('estimated'))}` : ''}` : '—')}
        ${cell('mm_mode', `${mode(m.mode)}${m.baseMode && m.baseMode !== m.mode ? ` <span class="small muted">${esc(T('mm_base'))}: ${esc(I.en('monMode', m.baseMode))}</span>` : ''}`)}
        ${cell('mm_intensity', m.intensity ? esc(I.en('monIntensity', m.intensity)) : '—')}
        ${cell('mm_next', m.next ? `${esc(I.en('monMode', m.next.mode))} <span class="num small">${U.etDate(m.next.at)} ${U.etHM(m.next.at)}</span>` : '—')}
        ${cell('mm_symbols', m.trackedSymbols, 'num')}${cell('mm_ai_today', m.ai.requestsToday, 'num')}${cell('mm_ai_events', `${m.ai.eventAnalysesToday} / ${m.ai.maxPerDay}`, 'num')}
        ${cell('mm_prevented', m.ai.preventedToday, 'num')}${cell('mm_high', m.counters.highPriority, 'num')}${cell('mm_queue', m.queued, 'num')}
      </div>
      ${m.highVolatility.length ? `<div class="small down">⚡ ${esc(T('mm_hv'))}: ${m.highVolatility.map((x) => `<b dir="ltr">${esc(x.symbol)}</b>`).join(', ')}</div>` : ''}
      ${m.marketWide ? `<div class="small down">⚡ ${esc(T('mm_market'))}: <span dir="ltr">${esc(m.marketWide.detail || '')}</span></div>` : ''}
      ${m.entryBlock ? `<div class="small down">${esc(tr(m.entryBlock))}</div>` : ''}
      ${m.problems.length ? `<div class="small">${m.problems.map((p) => `<div class="down">${p.symbol ? `<b dir="ltr">${esc(p.symbol)}</b>: ` : ''}${esc(I.en('monProblem', p.code))} — ${esc(tr(p.detail || ''))}</div>`).join('')}</div>` : ''}
      <div class="lbl">${esc(T('mm_per_symbol'))}</div>
      <table class="tbl small"><thead><tr><th>${esc(T('f_symbol'))}</th><th>${esc(T('mm_mode'))}</th><th>${esc(T('mm_vol'))}</th><th>${esc(T('mm_relvol'))}</th><th>${esc(T('mm_move'))}</th><th>${esc(T('mm_or'))}</th><th>${esc(T('mm_gap'))}</th><th>${esc(T('mm_ai_events'))}</th><th>${esc(T('mm_fresh'))}</th></tr></thead><tbody>${rows || `<tr><td colspan="9" class="muted">${esc(T('wl_empty'))}</td></tr>`}</tbody></table>
      <div class="lbl">${esc(T('mm_events'))}</div>
      <table class="tbl small"><thead><tr><th>${esc(T('th_time'))}</th><th>${esc(T('f_symbol'))}</th><th>${esc(T('mm_event'))}</th><th>${esc(T('mm_score'))}</th><th>${esc(T('mm_why'))}</th><th>${esc(T('mm_outcome'))}</th></tr></thead><tbody>${evs || `<tr><td colspan="6" class="muted">${esc(T('mm_no_events'))}</td></tr>`}</tbody></table>
      ${sup ? `<div class="lbl">${esc(T('mm_suppressed'))}</div><div class="small">${sup}</div>` : ''}
      <p class="small muted">${esc(T('mm_note'))}</p>`);
  }
  setInterval(() => { if (activeTab() === 'monitoring' && !document.hidden) loadMonitoring(); }, 10000);
  I.onChange(() => { if (activeTab() === 'monitoring') loadMonitoring(); });

  // ------------------------------------------------------------ resources & services
  async function loadResources() {
    let r; let h;
    try { [r, h] = await Promise.all([U.api('/api/system/resources'), U.api('/api/system/health')]); } catch (e) { setHTML($('resources'), `<div class="down">${esc(tr(e.message))}</div>`); return; }
    const m = (k, v, cls = '') => `<div><label>${esc(T(k))}</label><b class="num ${cls}">${v}</b></div>`;
    const dur = (sec) => { const d = Math.floor(sec / 86400); const hh = Math.floor((sec % 86400) / 3600); const mm = Math.floor((sec % 3600) / 60); return `${d ? `${d}d ` : ''}${hh}h ${mm}m`; };
    const mb = (x) => `${(x / 1048576).toFixed(2)} MB`;
    const comps = Object.entries(h.components).map(([k, v]) => `<tr><td>${esc(T(`comp_${k}`))}</td><td><span class="pill small ${v.state === 'ok' ? 'green' : v.state === 'error' ? 'red' : v.state === 'degraded' ? 'amber' : 'gray'}">${esc(T(`cs_${v.state}`))}</span></td><td class="wrap small muted">${esc(tr(v.detail || ''))}</td></tr>`).join('');
    const feeds = r.dataProviders.map((x) => `<tr><td dir="ltr">${esc(x.symbol)}</td><td>${esc(x.provider || '—')}</td><td>${esc(tr(x.dataLabel || ''))}</td><td class="num">${x.priceTs ? U.etTime(x.priceTs) : '—'}</td></tr>`).join('');
    const jobs = r.scheduler.map((x) => `<span class="chip">${esc(x.symbol)} ${x.paused ? '❚❚' : x.inFlight ? '…' : x.running ? '●' : '○'}</span>`).join(' ');
    setHTML($('resources'), `<div class="lbl">${esc(T('res_title'))} · <span class="pill small ${h.server.state === 'ONLINE' ? 'green' : 'amber'}">${esc(T(`st_${h.server.state}`))}</span>${h.server.reasons.length ? ` <span class="small muted">${esc(h.server.reasons.join(', '))}</span>` : ''}</div>
      <div class="lbl">${esc(T('res_hosting'))}</div>
      <div class="metrics usage-grid">
        ${m('res_uptime', dur(r.uptimeSec))}${m('res_memory', `${r.memory.rssMb} / ${r.memory.heapUsedMb} MB`)}${m('res_cpu', r.cpuPct == null ? '—' : `${r.cpuPct}%`)}${m('res_loop', `${r.eventLoopDelayMs} ms`)}
        ${m('res_db_size', mb(r.database.total))}${m('res_clients', r.websocketClients)}${m('res_symbols', r.monitoredSymbols)}
        ${m('res_conns', r.marketDataConnections)}${m('res_subs', r.marketSubscriptions)}${m('res_queue', `${r.queues.telegramQueued} / ${r.queues.telegramFailed}`)}
        ${m('u_provider', `${esc(T(`aim_${r.ai.mode}`))}`)}
        ${m('comp_deepseek', `${r.ai.deepseek.requestsToday} · $${(r.ai.deepseek.costTodayUsd || 0).toFixed(4)}`)}${m('comp_gemini', `${r.ai.gemini.requestsToday} · $${(r.ai.gemini.costTodayUsd || 0).toFixed(4)}`)}
        ${m('u_combined', `$${((r.ai.deepseek.costTodayUsd || 0) + (r.ai.gemini.costTodayUsd || 0)).toFixed(4)}`)}
      </div>
      <div class="lbl">${esc(T('res_components'))}</div><table class="tbl small"><tbody>${comps}</tbody></table>
      <div class="lbl">${esc(T('res_feeds'))}</div><table class="tbl small"><tbody>${feeds || `<tr><td class="muted">—</td></tr>`}</tbody></table>
      <div class="lbl">${esc(T('res_jobs'))}</div><div class="small">${jobs || '—'}</div>
      <div class="row" style="margin-top:8px;gap:6px;flex-wrap:wrap"><button class="btn small ghost" id="rs-int">${esc(T('res_integrity'))}</button><span id="rs-out" class="small"></span></div>
      <p class="small muted">${esc(T('res_note'))}</p>`);
    $('rs-int').onclick = async () => {
      try {
        const x = await U.api('/api/admin/integrity');
        const okDb = x.quickCheck.length === 1 && x.quickCheck[0] === 'ok';
        const ok = okDb && x.accounting.ok;
        U.set('rs-out', ok ? T('res_integrity_ok') : T('res_integrity_bad', { p: [...(okDb ? [] : x.quickCheck), ...(x.accounting.problems || [])].join('; ') }), ok ? 'small up' : 'small down');
      } catch (e) { U.toast(tr(e.message), 'err'); }
    };
  }

  // ------------------------------------------------------------ watchlist (multi-symbol, shared portfolio)
  async function addToWatchlist(sym) {
    try {
      await U.api('/api/watchlist/add', { method: 'POST', body: { symbol: sym } });
      U.toast(T('wl_added', { sym }), 'ok');
      selectSymbol(sym);
    } catch (e) { U.toast(tr(e.message), 'err'); }
  }
  $('wl-add-btn').addEventListener('click', () => { const v = $('wl-input').value.trim().toUpperCase(); if (v) { $('wl-input').value = ''; addToWatchlist(v); } });
  $('wl-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('wl-add-btn').click(); });
  function renderWatchlist(s) {
    const wl = s.watchlist || [];
    U.set('wl-count', wl.length ? T('wl_limit', { n: wl.length, m: s.maxSymbols || 10 }) : '');
    const trendTxt = (t) => { const c = String(t || '').toUpperCase(); return /UP/.test(c) ? '↗' : /DOWN/.test(c) ? '↘' : c ? '→' : ''; };
    const html = wl.map((w) => `<div class="wl-row ${w.symbol === APP.symbol ? 'active' : ''} ${w.status === 'PAUSED' ? 'paused' : ''}" data-sym="${esc(w.symbol)}" role="button" tabindex="0">
        <div class="wl-main"><b dir="ltr">${esc(w.symbol)}</b>${w.primary ? ` <span class="chip">${esc(T('wl_main'))}</span>` : ''}${w.status === 'PAUSED' ? ` <span class="chip">${esc(T('wl_paused'))}</span>` : ''}${w.monitorMode === 'HIGH_VOLATILITY' ? ` <span class="chip unverified" title="${esc(T('mm_hv'))}">⚡</span>` : ''}${w.analyzing ? ' <span class="spinner"></span>' : ''}</div>
        <div class="wl-px num">${w.price ? U.price(w.price) : '—'} <span class="${U.cls(w.changePct)}">${w.changePct != null ? U.pct(w.changePct) : ''}</span> <span class="muted">${trendTxt(w.trend)}</span></div>
        <div class="wl-sub small"><span class="${w.aiAction ? actionBadge(w.aiAction)[1] : ''}">${w.aiAction ? esc(I.en('action', w.aiAction)) : '—'}</span>${w.positionQty ? ` · <span class="num">${w.positionQty}</span> ${esc(T('sh'))} <span class="num ${U.cls(w.unrealizedPnl)}">${U.smoney(w.unrealizedPnl)}</span>` : ''}</div>
        <div class="wl-sub small muted"><span class="dot ${w.fresh ? 'ok' : (w.dataCode === 'CLOSED' ? 'idle' : 'bad')}"></span> ${esc(tr(w.dataLabel || ''))}${w.priceTs ? ` · ${U.etTime(w.priceTs)}` : ''}</div>
        <div class="wl-act">${w.status === 'PAUSED' ? `<button class="tool-btn" data-wl="resume" title="${esc(T('wl_resume'))}">▶</button>` : `<button class="tool-btn" data-wl="pause" title="${esc(T('wl_pause'))}">❚❚</button>`}${w.primary ? '' : `<button class="tool-btn" data-wl="remove" title="${esc(T('wl_remove'))}">✕</button>`}</div>
      </div>`).join('');
    const el = $('watchlist');
    setHTML(el, html || `<div class="muted small">${esc(T('wl_empty'))}</div>`);
    el.querySelectorAll('.wl-row').forEach((row) => {
      row.onclick = (e) => {
        const b = e.target.closest('[data-wl]');
        const sym = row.dataset.sym;
        if (!b) return selectSymbol(sym);
        e.stopPropagation();
        if (b.dataset.wl === 'pause') U.api('/api/watchlist/pause', { method: 'POST', body: { symbol: sym } }).catch((er) => U.toast(tr(er.message), 'err'));
        else if (b.dataset.wl === 'resume') U.api('/api/watchlist/resume', { method: 'POST', body: { symbol: sym } }).catch((er) => U.toast(tr(er.message), 'err'));
        else if (b.dataset.wl === 'remove') {
          Modal.open(T('wl_remove_title'), `<p>${esc(T('wl_remove_q', { sym }))}</p><div class="actions"><button class="btn" id="wr-no">${esc(T('cancel'))}</button><button class="btn danger" id="wr-yes">${esc(T('wl_remove'))}</button></div>`, () => {
            $('wr-no').onclick = () => Modal.close();
            $('wr-yes').onclick = async () => {
              Modal.close();
              try { await U.api('/api/watchlist/remove', { method: 'POST', body: { symbol: sym, confirm: true } }); U.toast(T('wl_removed', { sym }), 'ok'); if (APP.symbol === sym) selectSymbol(APP.state.primarySymbol); } catch (er) { U.toast(tr(er.message), 'err'); }
            };
          });
        }
      };
      row.onkeydown = (e) => { if (e.key === 'Enter') selectSymbol(row.dataset.sym); };
    });
  }
  function renderPositions(s) {
    const ps = s.positions || [];
    setHTML($('positions'), ps.length ? ps.map((p) => `<div class="pos-row" data-sym="${esc(p.symbol)}"><b dir="ltr">${esc(p.symbol)}</b><span class="num">${p.qty} @ ${U.price4(p.avgPrice)}</span><span class="num">${p.mark ? U.price(p.mark) : '—'}${p.markStale ? ` <span class="chip unverified">${esc(T('stale_mark'))}</span>` : ''}</span><span class="num ${U.cls(p.unrealizedPnl)}">${U.smoney(p.unrealizedPnl)}</span></div>`).join('') : `<div class="muted">${esc(T('no_positions'))}</div>`);
    $('positions').querySelectorAll('.pos-row').forEach((r) => { r.onclick = () => selectSymbol(r.dataset.sym); });
  }
  function renderReference(s) {
    const el = $('h-ref');
    const ref = s.market && s.market.reference;
    const dk = s.market && s.market.dataKind;
    if (!ref || !(dk === 'INDICATIVE' || dk === 'DELAYED' || (s.session && s.session.session === 'OVERNIGHT'))) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.textContent = T('ref_price', { kind: T(`dk_${ref.kind === 'INDICATIVE' ? 'INDICATIVE' : ref.kind === 'DELAYED' ? 'DELAYED' : 'LIVE_QUOTE'}`), px: U.price(ref.price), provider: ref.provider, t: U.etTime(ref.ts) });
    el.title = T('ref_note');
    el.className = `ref-pill ${ref.kind === 'INDICATIVE' ? 'purple' : 'amber'}`;
  }

  // ------------------------------------------------------------ trade history (executions vs orders, filters)
  function fillSelect(id, opts, cur) { const el = $(id); setHTML(el, opts.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('')); }
  function histFilters() {
    const syms = [...new Set([...(APP.state && APP.state.watchlist ? APP.state.watchlist.map((w) => w.symbol) : []), ...APP.fills.map((f) => f.symbol)])];
    fillSelect('hf-symbol', [['', T('f_any')], ...syms.map((x) => [x, x])], APP.hist.symbol);
    fillSelect('hf-period', [['all', T('p_all')], ['today', T('p_today')], ['week', T('p_week')], ['month', T('p_month')], ['7d', T('p_7d')], ['30d', T('p_30d')]], APP.hist.period);
    fillSelect('hf-side', [['', T('f_any')], ['BUY', I.en('side', 'BUY')], ['SELL', I.en('side', 'SELL')]], APP.hist.side);
    fillSelect('hf-result', [['', T('f_any')], ['profit', T('f_profit')], ['loss', T('f_loss')]], APP.hist.result);
    const strats = [...new Set(APP.fills.map((f) => f.strategy).filter(Boolean))];
    fillSelect('hf-strategy', [['', T('f_any')], ...strats.map((x) => [x, I.en('strategy', x)])], APP.hist.strategy);
    fillSelect('hf-status', [['', T('f_any')], ...['PENDING', 'FILLED', 'PARTIALLY_FILLED', 'REJECTED', 'CANCELLED', 'EXPIRED'].map((x) => [x, I.en('orderStatus', x)])], APP.hist.status);
    document.querySelectorAll('#hist-view button').forEach((b) => b.classList.toggle('active', b.dataset.v === APP.hist.view));
    document.querySelectorAll('.hf-trades').forEach((x) => x.classList.toggle('hidden', APP.hist.view !== 'trades'));
    document.querySelectorAll('.hf-orders').forEach((x) => x.classList.toggle('hidden', APP.hist.view !== 'orders'));
  }
  ['hf-symbol', 'hf-period', 'hf-side', 'hf-result', 'hf-strategy', 'hf-status'].forEach((id) => $(id).addEventListener('change', () => { APP.hist[id.slice(3)] = $(id).value; loadHistory(); }));
  document.querySelectorAll('#hist-view button').forEach((b) => b.addEventListener('click', () => { APP.hist.view = b.dataset.v; loadHistory(); }));
  async function loadHistory() {
    histFilters();
    const h = APP.hist;
    const q = new URLSearchParams({ period: h.period, limit: '300' });
    if (h.symbol) q.set('symbol', h.symbol);
    if (h.side) q.set('side', h.side);
    if (h.view === 'orders' && h.status) q.set('status', h.status);
    const csv = new URLSearchParams();
    if (h.symbol) csv.set('symbol', h.symbol); if (h.side) csv.set('side', h.side); if (h.result) csv.set('result', h.result); if (h.strategy) csv.set('strategy', h.strategy);
    $('hf-csv').href = `/api/export/trades.csv${csv.toString() ? `?${csv}` : ''}`;
    U.set('hf-note', h.view === 'orders' ? T('order_vs_exec') : T('sim_fills'));
    try {
      if (h.view === 'orders') {
        const r = await U.api(`/api/orders?${q}`);
        setHTML($('trades-head'), `<tr><th>${esc(T('th_time'))}</th><th>${esc(T('f_symbol'))}</th><th>${esc(T('th_side'))}</th><th>${esc(T('th_type'))}</th><th>${esc(T('th_qty'))}</th><th>${esc(T('th_filled'))}</th><th>${esc(T('th_price'))}</th><th>${esc(T('f_status'))}</th><th>${esc(T('th_source'))}</th><th>${esc(T('th_reason'))}</th><th>${esc(T('th_order'))}</th></tr>`);
        setHTML($('trades-body'), r.items.map((o) => `<tr><td class="num">${U.etDate(o.createdAt)} ${U.etTime(o.createdAt)}</td><td dir="ltr">${esc(o.symbol)}</td><td class="${o.side === 'BUY' ? 'up' : 'down'}">${esc(I.en('side', o.side))}</td><td>${esc(I.en('orderType', o.type, o.type || ''))}</td><td class="num">${o.qty ?? '—'}</td><td class="num">${o.filledQty || 0}</td><td class="num">${o.avgFillPrice ? U.price4(o.avgFillPrice) : (o.limitPrice ? U.price4(o.limitPrice) : '—')}</td><td>${esc(I.en('orderStatus', o.status))}</td><td>${esc(I.en('fillKind', o.source, o.source || ''))}</td><td class="wrap">${esc(tr(o.rejectReason || o.reason || '').slice(0, 160))}</td><td class="mono small">${esc(o.id)}</td></tr>`).join('') || `<tr><td colspan="11" class="muted">${esc(T(h.symbol || h.side || h.status || h.period !== 'all' ? 'no_match' : 'no_orders'))}</td></tr>`);
        return;
      }
      const r = await U.api(`/api/trades?${q}`);
      const items = r.items.filter((f) => (!h.result || (h.result === 'profit' ? f.realizedPnl > 0 : f.realizedPnl < 0)) && (!h.strategy || f.strategy === h.strategy));
      setHTML($('trades-head'), `<tr><th>${esc(T('th_time'))}</th><th>${esc(T('f_symbol'))}</th><th>${esc(T('th_side'))}</th><th>${esc(T('th_qty'))}</th><th>${esc(T('th_price'))}</th><th>${esc(T('th_fees'))}</th><th>${esc(T('th_pnl'))}</th><th>${esc(T('th_type'))}</th><th>${esc(T('th_profile'))}</th><th>${esc(T('th_reason'))}</th><th>${esc(T('th_order'))}</th></tr>`);
      setHTML($('trades-body'), items.map((f) => `<tr class="clickable" data-id="${esc(f.id)}"><td class="num">${U.etDate(f.ts)} ${U.etTime(f.ts)}</td><td dir="ltr">${esc(f.symbol)}</td><td class="${f.side === 'BUY' ? 'up' : 'down'}">${esc(I.en('side', f.side))}</td><td class="num">${f.qty}</td><td class="num">${U.price4(f.price)}</td><td class="num">${U.money(f.fees)}</td><td class="num ${U.cls(f.realizedPnl)}">${f.side === 'SELL' ? `${U.smoney(f.realizedPnl)}${f.returnPct != null ? ` (${U.pct(f.returnPct)})` : ''}` : ''}</td><td>${esc(I.en('fillKind', f.kind, f.kind || ''))}</td><td>${f.riskProfile ? esc(T(`profile_${f.riskProfile}`)) : '—'}</td><td class="wrap">${esc(tr(f.reason || '').slice(0, 120))}</td><td class="mono small">${esc(f.orderId || '')}</td></tr>`).join('') || `<tr><td colspan="11" class="muted">${esc(T(h.symbol || h.side || h.result || h.strategy || h.period !== 'all' ? 'no_match' : 'no_trades'))}</td></tr>`);
      $('trades-body').querySelectorAll('tr[data-id]').forEach((row) => { row.onclick = () => openFill(row.dataset.id); });
    } catch (e) { U.toast(tr(e.message), 'err'); }
  }

  // ------------------------------------------------------------ AI usage page
  async function loadUsage() {
    let u;
    try { u = await U.api('/api/ai/usage'); } catch (e) { setHTML($('usage'), `<div class="down">${esc(tr(e.message))}</div>`); return; }
    const m = (k, v, cls = '') => `<div><label>${esc(T(k))}</label><b class="num ${cls}">${v}</b></div>`;
    const modes = (u.modes || ['ECONOMY', 'BALANCED', 'DETAILED']).map((x) => `<button class="mode-card ${x === u.mode ? 'active' : ''}" data-mode="${x}"><b>${esc(T(`mode_${x}`))}</b><span>${esc(T(`mode_desc_${x}`))}</span></button>`).join('');
    const aiModes = (u.aiModes || ['DEEPSEEK', 'GEMINI', 'AUTO', 'DUAL']).map((x) => `<button class="mode-card ${x === u.aiMode ? 'active' : ''}" data-aimode="${x}"><b>${esc(T(`aim_${x}`))}</b><span>${esc(T(`aim_desc_${x}`))}</span></button>`).join('');
    const pv = u.providers || {};
    const col = (x) => (x ? `<td><b>${esc(x.name)}</b><div class="small muted" dir="ltr">${esc(x.model || '')}</div></td>
      <td><span class="pill small ${x.state === 'AVAILABLE' ? 'green' : x.state === 'NOT_CONFIGURED' ? 'gray' : 'red'}">${esc(T(`prov_state_${x.state}`))}</span>${x.openUntil ? `<div class="small muted">${esc(T('u_until', { t: U.etTime(x.openUntil) }))}</div>` : ''}${x.lastError && x.state !== 'AVAILABLE' ? `<div class="small down">${esc(tr(x.lastError).slice(0, 120))}</div>` : ''}</td>
      <td class="num">${x.requestsToday} / ${x.requestsMonth}</td><td class="num">$${(x.costTodayUsd || 0).toFixed(4)} / $${(x.costMonthUsd || 0).toFixed(4)}</td>
      <td class="num">${x.dailyBudgetUsd ? `$${(x.remainingBudgetUsd || 0).toFixed(4)} / $${x.dailyBudgetUsd}` : '—'}</td><td class="num">${x.avgLatencyMs ? `${(x.avgLatencyMs / 1000).toFixed(1)}s` : '—'}</td>
      <td class="num">${x.successRate == null ? '—' : `${Math.round(x.successRate * 100)}%`}</td><td class="num">${x.lastSuccessAt ? `${U.etDate(x.lastSuccessAt)} ${U.etTime(x.lastSuccessAt)}` : '—'}</td>` : '');
    const provTbl = `<div class="lbl">${esc(T('u_provider_tbl'))}</div><table class="tbl small"><thead><tr><th></th><th>${esc(T('f_status'))}</th><th>${esc(T('u_requests_today'))} / ${esc(T('u_requests_month'))}</th><th>${esc(T('u_cost_today'))} / ${esc(T('u_cost_month'))}</th><th>${esc(T('u_prov_budget'))}</th><th>${esc(T('u_latency'))}</th><th>${esc(T('u_success'))}</th><th>${esc(T('u_last_ok'))}</th></tr></thead><tbody><tr>${col(pv.deepseek)}</tr><tr>${col(pv.gemini)}</tr></tbody></table>`;
    setHTML($('usage'), `<div class="lbl">${esc(T('aim_title'))} · <label class="small"><input type="checkbox" id="u-fallback" ${u.fallback ? 'checked' : ''}> ${esc(T('aim_fallback'))}</label></div><div class="mode-cards">${aiModes}</div>
      ${provTbl}
      <div class="lbl">${esc(T('mode_title'))}</div><div class="usage-top"><div class="mode-cards">${modes}</div></div>
      <div class="metrics usage-grid">
        ${m('u_requests_today', `${u.requestsToday}${u.maxRequestsPerDay ? ` / ${u.maxRequestsPerDay}` : ''}`)}${m('u_requests_month', u.requestsMonth)}
        ${m('u_tokens_today', `${U.num(u.inputTokensToday)} / ${U.num(u.outputTokensToday)}`)}${m('u_tokens_month', `${U.num(u.inputTokensMonth)} / ${U.num(u.outputTokensMonth)}`)}
        ${m('u_cost_today', `$${(u.costTodayUsd || 0).toFixed(4)}`)}${m('u_cost_month', `$${(u.costMonthUsd || 0).toFixed(4)}`)}
        ${m('u_budget_left', `$${(u.remainingBudgetUsd || 0).toFixed(4)} / $${u.dailyBudgetUsd}`, u.remainingBudgetUsd <= 0 ? 'down' : '')}${m('u_avoided', u.avoidedToday, 'up')}
        ${m('u_last_analysis', u.lastAnalysisAt ? `${U.etDate(u.lastAnalysisAt)} ${U.etTime(u.lastAnalysisAt)}${u.lastDecision ? ` · ${u.lastDecision.symbol} ${I.en('action', u.lastDecision.action)}` : ''}` : '—')}
        ${m('u_api', `${esc(T(`u_api_${u.apiStatus}`))}${u.lastError ? ` — ${esc(tr(u.lastError))}` : ''}`, u.apiStatus === 'OK' ? 'up' : 'down')}${m('u_errors_month', u.errorsMonth || 0)}
      </div>
      <div class="lbl">${esc(T('u_errors'))}</div>
      <div class="small">${(u.recentErrors || []).length ? u.recentErrors.map((e) => `<div><span class="num">${U.etDate(e.ts)} ${U.etTime(e.ts)}</span> · ${esc(tr(e.error || ''))}</div>`).join('') : `<span class="muted">${esc(T('u_none'))}</span>`}</div>
      <p class="small muted">${esc(T('u_monitoring_note'))}</p><p class="small muted">${esc(T('u_budget_note'))}</p>`);
    $('usage').querySelectorAll('[data-mode]').forEach((b) => { b.onclick = async () => { try { await U.api('/api/settings', { method: 'POST', body: { ai: { usageMode: b.dataset.mode } } }); U.toast(T('mode_applied', { m: T(`mode_${b.dataset.mode}`) }), 'ok'); loadUsage(); } catch (e) { U.toast(tr(e.message), 'err'); } }; });
    $('usage').querySelectorAll('[data-aimode]').forEach((b) => { b.onclick = async () => { try { await U.api('/api/ai/mode', { method: 'POST', body: { mode: b.dataset.aimode } }); U.toast(T('aim_applied', { m: T(`aim_${b.dataset.aimode}`) }), 'ok'); loadUsage(); } catch (e) { U.toast(tr(e.message), 'err'); } }; });
    $('u-fallback').onchange = async (e) => { try { await U.api('/api/settings', { method: 'POST', body: { ai: { fallback: e.target.checked } } }); U.toast(T('s_saved_settings'), 'ok'); } catch (er) { U.toast(tr(er.message), 'err'); } };
  }

  // ------------------------------------------------------------ activity terminal
  const MAX_LINES = 1500;
  function matchFilter(e) {
    const f = APP.filter;
    if (f === 'ALL') return true;
    if (f === 'TRADE') return ['EXECUTION', 'BUY_PROPOSAL', 'SELL_PROPOSAL', 'PORTFOLIO'].includes(e.category);
    if (f === 'ALERT') return e.category === 'WARNING' || e.category === 'ERROR' || e.status === 'error' || e.status === 'warn';
    if (f === 'AI') return e.category === 'AI' || e.category === 'BUY_PROPOSAL' || e.category === 'SELL_PROPOSAL';
    return e.category === f;
  }
  function eventNode(e) {
    const d = document.createElement('div');
    const side = e.category === 'EXECUTION' ? (/\bBUY\b/.test(e.message) ? ' buy' : /\bSELL\b/.test(e.message) ? ' sell' : '') : '';
    d.className = `ev ${e.category}${side} ${e.status}`;
    const r = window.MSG.msg(e.message);
    d.innerHTML = `<span class="t">[${U.etTime(e.ts)}]</span><span class="c">${esc(I.en('category', e.category))}</span><span class="m${r.translated ? '' : ' ltr-msg'}">${esc(r.text)}</span><span class="s" title="${esc(e.source || '')}">${esc(e.source || '')}</span>`;
    if (I.isAr && r.translated && r.text !== e.message) d.title = `${T('original_text')}: ${e.message}`;
    if (!matchFilter(e)) d.classList.add('hidden');
    d._evt = e;
    return d;
  }
  function addActivity(e, live) {
    APP.events.push(e);
    if (APP.events.length > MAX_LINES) APP.events.splice(0, APP.events.length - MAX_LINES);
    const el = $('activity');
    el.appendChild(eventNode(e));
    while (el.childNodes.length > MAX_LINES) el.removeChild(el.firstChild);
    if (live) scrollActivity();
  }
  function rerenderActivity() {
    const el = $('activity');
    const frag = document.createDocumentFragment();
    for (const e of APP.events) frag.appendChild(eventNode(e));
    el.innerHTML = '';
    el.appendChild(frag);
    scrollActivity(true);
  }
  function scrollActivity(force) { const el = $('tab-activity'); if (force || $('act-autoscroll').checked) el.scrollTop = el.scrollHeight; }
  document.querySelectorAll('#act-filters button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#act-filters button').forEach((x) => x.classList.toggle('active', x === b));
    APP.filter = b.dataset.f;
    for (const n of $('activity').childNodes) n.classList.toggle('hidden', !matchFilter(n._evt));
    scrollActivity(true);
  }));

  // ------------------------------------------------------------ decisions / analyses / trades / equity / indicators
  async function loadDecisions() {
    try { APP.decisions = await U.api(`/api/decisions${APP.symbol ? `?symbol=${encodeURIComponent(APP.symbol)}` : ''}`); } catch { APP.decisions = []; }
    APP.chart.setDecisions(APP.decisions);
    renderDecisions(); renderAnalyses();
  }
  function upsertDecision(d) {
    const i = APP.decisions.findIndex((x) => x.id === d.id);
    if (i >= 0) APP.decisions[i] = { ...APP.decisions[i], ...d }; else APP.decisions.unshift(d);
    APP.chart.setDecisions(APP.decisions);
    renderDecisions(); renderAnalyses();
  }
  function renderDecisions() {
    const el = $('decisions');
    if (!APP.decisions.length) { setHTML(el, `<div class="muted small">${esc(T('no_decisions'))}</div>`); return; }
    setHTML(el, APP.decisions.slice(0, 80).map((d) => {
      const p = d.proposal;
      const [t, c] = actionBadge(d.action || (p && p.action));
      return `<div class="dec" data-id="${esc(d.id)}"><div class="small num">${U.etTime(d.ts)}<div class="st">${esc(I.en('decStatus', d.status))}</div></div><div><span class="${c}">${esc(t)}</span><div class="st">${p ? `${p.confidence}% · ${esc(I.en('strategy', p.strategy))}` : ''}</div></div><div class="why">${esc(p ? tr(p.rationale || p.marketCondition) : (d.status === 'AI_ERROR' ? T('ai_request_failed') : T('invalid_no_proposal')))}</div></div>`;
    }).join(''));
    el.querySelectorAll('.dec').forEach((n) => { n.onclick = () => openDecision(n.dataset.id); });
  }
  /** Current vs previous AI analyses (chart annotations history; executed trades are separate). */
  function renderAnalyses() {
    const el = $('analyses');
    const list = APP.decisions.filter((d) => d.proposal).slice(0, 30);
    if (!list.length) { setHTML(el, `<div class="muted small">${esc(T('no_analyses'))}</div>`); return; }
    setHTML(el, list.map((d, i) => {
      const p = d.proposal;
      const ch = p.chart;
      const [t, c] = actionBadge(p.action);
      const lv = ch && ch.levels ? ch.levels.slice(0, 6).map((l) => `${{ support: I.isAr ? 'دعم' : 'S', resistance: I.isAr ? 'مقاومة' : 'R', breakout: I.isAr ? 'اختراق' : 'BO', breakdown: I.isAr ? 'كسر' : 'BD', watch: I.isAr ? 'مراقبة' : 'W' }[l.kind]} ${U.price(l.price)}${l.verified ? '✓' : '?'}`).join(' · ') : '';
      const change = ch && ch.change && ch.change.changed ? ` · ${T('decision_changed', { from: I.en('action', ch.change.from), to: I.en('action', ch.change.to) })}` : '';
      return `<div class="ana ${i === 0 ? 'current' : ''}" data-id="${esc(d.id)}"><div class="ah"><span class="pill small ${i === 0 ? 'purple' : 'gray'}">${esc(T(i === 0 ? 'current' : 'previous'))}</span><span class="num small">${U.etDate(d.ts)} ${U.etTime(d.ts)}</span><span class="${c}">${esc(t)}</span><span class="muted small">${esc(I.en('trend', p.trend))} · ${p.confidence}% · ${esc(I.en('decStatus', d.status))}${esc(change)}</span></div>
        ${lv ? `<div class="lv num" dir="auto">${esc(lv)}</div>` : ''}<div class="lv">${esc(tr(p.rationale || ''))}</div></div>`;
    }).join(''));
    el.querySelectorAll('.ana').forEach((n) => { n.onclick = () => openDecision(n.dataset.id); });
  }

  async function loadFills() {
    try { APP.fills = await U.api('/api/fills'); } catch { APP.fills = []; }
    APP.chart.setFills(symFills());
    if (activeTab() === 'trades') loadHistory();
  }
  function renderTrades() { loadHistory(); }
  function renderTradesLegacy() {
    const body = $('trades-body');
    setHTML(body, APP.fills.slice().reverse().map((f) => `<tr class="clickable" data-id="${esc(f.id)}"><td class="num">${U.etDate(f.ts)} ${U.etTime(f.ts)}</td><td class="${f.side === 'BUY' ? 'up' : 'down'}">${esc(I.en('side', f.side))}</td><td class="num">${f.qty}</td><td class="num">${U.price4(f.price)}</td><td class="num">${U.money(f.fees)}</td><td class="num ${U.cls(f.realizedPnl)}">${f.side === 'SELL' ? U.smoney(f.realizedPnl) : ''}</td><td>${esc(I.en('fillKind', f.kind, f.kind || ''))} ${esc(I.en('fillStatus', f.status, f.status || ''))}</td><td>${f.riskProfile ? esc(T(`profile_${f.riskProfile}`)) : '—'}</td><td class="wrap">${esc(tr(f.reason || '').slice(0, 120))}</td></tr>`).join('') || `<tr><td colspan="9" class="muted">${esc(T('no_trades'))}</td></tr>`);
    body.querySelectorAll('tr[data-id]').forEach((r) => { r.onclick = () => openFill(r.dataset.id); });
  }

  function activeTab() { const b = document.querySelector('#dock-tabs button.active'); return b ? b.dataset.tab : 'activity'; }
  document.querySelectorAll('#dock-tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('#dock-tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.dock-body .tab').forEach((t) => t.classList.toggle('active', t.id === `tab-${b.dataset.tab}`));
    $('act-filters').classList.toggle('hidden', b.dataset.tab !== 'activity');
    if (layout.dockCollapsed) { layout.dockCollapsed = false; saveLayout(); applyLayout(); }
    if (b.dataset.tab === 'equity') loadEquity();
    if (b.dataset.tab === 'trades') loadHistory();
    if (b.dataset.tab === 'usage') loadUsage();
    if (b.dataset.tab === 'resources') loadResources();
    if (b.dataset.tab === 'monitoring') loadMonitoring();
    if (b.dataset.tab === 'indicators') renderIndicators();
    if (b.dataset.tab === 'activity') scrollActivity(true);
  }));
  async function loadEquity() {
    if (!APP.equity) APP.equity = new EquityChart($('equity-chart'));
    try {
      const pts = await U.api('/api/equity');
      APP.equity.setData(pts);
      APP.equityLoaded = true;
      U.set('equity-legend', pts.length ? T('equity_legend', { n: pts.length }) : T('equity_empty'));
    } catch (e) { U.set('equity-legend', tr(e.message)); }
  }

  let indTimer = null;
  function throttleIndicators() { if (!indTimer) indTimer = setTimeout(() => { indTimer = null; if (activeTab() === 'indicators') renderIndicators(); }, 1500); }
  function renderIndicators() {
    const v = APP.chart.latestIndicatorValues();
    const ar = I.isAr;
    const names = {
      sma9: 'SMA 9', sma20: 'SMA 20', sma50: 'SMA 50', sma200: 'SMA 200', ema9: 'EMA 9', ema21: 'EMA 21', ema50: 'EMA 50', rsi14: 'RSI 14', macd: 'MACD (12,26)',
      macdSignal: ar ? 'إشارة MACD (9)' : 'MACD signal (9)', macdHist: ar ? 'هيستوغرام MACD' : 'MACD histogram', atr14: 'ATR 14', bbUpper: ar ? 'بولينجر العلوي (20,2)' : 'Bollinger upper (20,2)',
      bbMid: ar ? 'بولينجر الأوسط' : 'Bollinger mid', bbLower: ar ? 'بولينجر السفلي' : 'Bollinger lower', bbWidth: ar ? 'عرض نطاق بولينجر' : 'Bollinger bandwidth', volSma20: ar ? 'متوسط الحجم 20' : 'Volume MA 20',
      relVol: ar ? 'الحجم النسبي' : 'Relative volume', vwap: ar ? 'VWAP (الجلسة الرسمية)' : 'VWAP (session, RTH)',
    };
    if (!v) { setHTML($('ind-body'), `<tr><td class="muted">${esc(T('no_bars'))}</td></tr>`); return; }
    const reason = (r) => (ar ? String(r || '').replace(/needs (\d+) bars, have (\d+)/, 'يحتاج $1 شمعة، المتوفر $2').replace('not applicable for current bar/session', 'لا ينطبق على الشمعة/الجلسة الحالية') : r);
    setHTML($('ind-body'), `<tr><th colspan="3">${esc(T('ind_header', { tf: T(`tf_${APP.tf}`), n: v.barsAvailable }))}</th></tr>` + Object.entries(names).map(([k, n]) => {
      const x = v[k];
      return `<tr><td>${esc(n)}</td><td class="num">${x && x.available ? (k === 'volSma20' ? U.num(x.value) : x.value.toFixed(k === 'relVol' || k === 'bbWidth' ? 3 : 4)) : `<span class="muted">${esc(T('unavailable'))}</span>`}</td><td class="muted">${x && !x.available ? esc(reason(x.reason)) : ''}</td></tr>`;
    }).join(''));
  }

  // ------------------------------------------------------------ detail modals
  function checksTable(checks) {
    if (!checks || !checks.length) return `<div class="muted small">${esc(T('no_checks'))}</div>`;
    return `<table class="checks">${checks.map((c) => `<tr><td class="${c.pass ? 'pass' : 'fail'}">${esc(T(c.pass ? 'pass' : 'fail'))}</td><td>${esc(I.en('check', c.name))}</td><td>${esc(tr(c.detail))}</td></tr>`).join('')}</table>`;
  }
  const STEP = { snapshot: ['لقطة البيانات', 'snapshot'], news: ['الأخبار', 'news'], ai_request: ['طلب الذكاء الاصطناعي', 'ai_request'], ai_response: ['استجابة الذكاء الاصطناعي', 'ai_response'], validated: ['تم التحقق', 'validated'], final: ['النتيجة', 'final'], budget_block: ['حظر الميزانية', 'budget_block'], web_research: ['بحث الويب', 'web_research'], web_research_failed: ['فشل بحث الويب', 'web_research_failed'] };
  async function openDecision(id) {
    let d;
    try { d = await U.api(`/api/decisions/${encodeURIComponent(id)}`); } catch (e) { return U.toast(tr(e.message), 'err'); }
    const p = d.proposal;
    const snap = d.snapshot;
    const a = d.audit || {};
    const ex = d.execution;
    const tfv = snap && snap.timeframes ? snap.timeframes[snap.analysisTimeframe] : null;
    const ch = p && p.chart;
    const html = `
      <div class="grid3 small">
        <div><label class="f">${esc(T('dm_time'))}</label>${U.etDateTime(d.ts)}</div><div><label class="f">${esc(T('dm_status'))}</label><b>${esc(I.en('decStatus', d.status))}</b></div><div><label class="f">${esc(T('dm_model'))}</label><span dir="ltr">${esc(d.model || '')}</span> ${d.latencyMs ? `· ${(d.latencyMs / 1000).toFixed(1)}s` : ''}</div>
        <div><label class="f">${esc(T('dm_triggers'))}</label>${esc((a.triggers || []).map((x) => window.MSG.msg(`Analysis started — trigger: ${x}`).text.replace(/^[^:]*—[^:]*:\s*/, '')).join(' | '))}</div><div><label class="f">${esc(T('dm_snapshot'))}</label><span class="mono" dir="ltr">${esc(d.snapshotId || '')}</span></div><div><label class="f">${esc(T('dm_tokens'))}</label><span class="num">${d.usage ? `${d.usage.promptTokens} / ${d.usage.completionTokens} · $${(d.usage.costUsd || 0).toFixed(5)}` : T('na')}</span></div>
      </div>
      ${p ? `<h4>${esc(T('dm_final'))}</h4>
      <div class="grid3 small">
        <div><label class="f">${esc(T('dm_action'))}</label><b>${esc(I.en('action', p.action))}</b> (${esc(I.en('orderType', p.orderType))})</div><div><label class="f">${esc(T('strategy'))}</label>${esc(I.en('strategy', p.strategy))}</div><div><label class="f">${esc(T('confidence'))}</label>${p.confidence}%</div>
        <div><label class="f">${esc(T('dm_levels'))}</label><span class="num">${U.price4(p.entryPrice)} / ${U.price4(p.stopLoss)} / ${U.price4(p.takeProfit)}</span></div><div><label class="f">${esc(T('dm_size'))}</label>${p.positionSizePct != null ? esc(T('of_equity', { x: p.positionSizePct })) : '—'}</div><div><label class="f">${esc(T('dm_rr'))}</label>${p.rewardToRiskClaimed != null ? p.rewardToRiskClaimed : '—'}</div>
      </div>
      ${ch && ch.change ? `<div class="decision-change${ch.change.changed ? '' : ' same'}"><b>${esc(ch.change.changed ? T('decision_changed', { from: I.en('action', ch.change.from), to: I.en('action', ch.change.to) }) : T('decision_same', { to: I.en('action', ch.change.to) }))}</b><div>${esc(ch.change.reason ? tr(ch.change.reason) : (ch.change.changed ? T('no_reason_given') : ''))}</div></div>` : ''}
      <p class="small"><b>${esc(T('market_interpretation'))}:</b> ${esc(tr(p.marketCondition))}</p><p class="small"><b>${esc(T('dm_rationale'))}:</b> ${esc(tr(p.rationale))}</p>
      <p class="small"><b class="up">${esc(T('bull_case'))}:</b> ${esc(tr(p.bullCase))}<br><b class="down">${esc(T('bear_case'))}:</b> ${esc(tr(p.bearCase))}<br><b>${esc(T('base_case'))}:</b> ${esc(tr(p.baseCase))}</p>
      <p class="small"><b>${esc(T('invalidation'))}:</b> ${esc(tr(p.invalidation))}<br><b>${esc(T('uncertainty'))}:</b> ${esc(tr(p.uncertainty))}</p>
      <div class="small"><b>${esc(T('evidence'))}:</b><ul class="list">${p.evidence.map((e) => `<li>${esc(tr(e))}</li>`).join('')}</ul></div>
      ${ch && ch.levels && ch.levels.length ? `<h4>${esc(T('dm_chart'))}</h4><table class="checks">${ch.levels.map((l) => `<tr><td class="${l.verified ? 'pass' : 'fail'}">${esc(l.verified ? '✓' : '?')}</td><td>${esc(l.kind)}</td><td class="num">${U.price(l.price)}</td><td>${esc(l.verified ? `${T('verified')}: ${l.match.label} ${U.price(l.match.price)}` : T('unverified'))}</td></tr>`).join('')}</table>` : ''}
      ${p.newsAssessment && p.newsAssessment.length ? `<div class="small"><b>${esc(T('dm_news'))}:</b><ul class="list">${p.newsAssessment.map((n) => `<li><span dir="ltr">${esc(n.newsId)}</span>: <b>${esc(I.en('bias', n.impact))}</b> — ${esc(tr(n.note))}</li>`).join('')}</ul></div>` : ''}` : `<h4>${esc(T('dm_no_proposal'))}</h4><pre>${esc(JSON.stringify(a.validationErrors || a.error || 'n/a', null, 1))}</pre>`}
      <h4>${esc(T('dm_risk'))}</h4>${d.risk ? `${d.risk.sizing && d.risk.sizing.limitingFactor ? `<div class="small num">${esc(T('dm_sizing', { q: d.risk.qty, r: U.num(d.risk.sizing.byRisk, 2), a: U.num(d.risk.sizing.byAllocation, 2), c: U.num(d.risk.sizing.byCash, 2), p: d.risk.sizing.byProposal !== null && d.risk.sizing.byProposal !== undefined && isFinite(d.risk.sizing.byProposal) ? T('dm_sizing_ai', { x: U.num(d.risk.sizing.byProposal, 2) }) : '' }))}</div>` : ''}${checksTable(d.risk.checks)}` : `<div class="muted small">${esc(T('dm_not_eval'))}</div>`}
      <h4>${esc(T('dm_exec'))}</h4>${ex ? `<pre>${esc(JSON.stringify({ status: ex.status, filledQty: ex.filledQty, avgPrice: ex.avgPrice, fees: ex.fees, touchPrice: ex.touchPrice, spread: ex.spread, reason: ex.reason, orderId: ex.orderId }, null, 1))}</pre>` : `<div class="muted small">${esc(T('dm_no_exec'))}</div>`}
      <h4>${esc(T('dm_audit'))}</h4><table class="checks">${(a.steps || []).map((s) => `<tr><td class="num">${U.etTime(Date.parse(s.at))}</td><td>${esc(STEP[s.name] ? STEP[s.name][I.isAr ? 0 : 1] : s.name)}</td><td class="small" dir="auto">${esc(typeof s.detail === 'string' ? I.en('decStatus', s.detail, tr(s.detail)) : JSON.stringify(s.detail))}</td></tr>`).join('')}</table>
      ${tfv ? `<h4>${esc(T('dm_data', { tf: snap.analysisTimeframe }))}</h4><pre>${esc(JSON.stringify({ dataSource: snap.dataSource, market: { lastPrice: snap.market.lastPrice, quote: snap.market.quote, session: snap.market.session }, indicators: tfv.indicators, structure: tfv.structure, technicals: tfv.technicals, signals: tfv.signals, risk: snap.risk && { profile: snap.risk.profile, limits: snap.risk.limits }, previousAnalysis: snap.previousAnalysis, news: snap.untrusted_external_content.news.map((n) => `${n.source}: ${n.title}`) }, null, 1))}</pre>` : ''}
      <p class="help">${esc(T('dm_hidden'))}</p>`;
    Modal.open(T('dm_title', { x: d.action ? I.en('action', d.action) : I.en('decStatus', d.status) }), html);
  }

  async function openFill(id) {
    let r;
    try { r = await U.api(`/api/fills/${encodeURIComponent(id)}`); } catch (e) { return U.toast(tr(e.message), 'err'); }
    const f = r.fill;
    const p = r.decision && r.decision.proposal;
    const newsItems = (APP.state.news || []).filter((n) => (f.newsIds || []).includes(n.id));
    const pos = APP.state.position;
    const unreal = f.side === 'BUY' && pos && pos.mark ? f.qty * (pos.mark - f.price) : null;
    const indRow = (o, label) => (o ? `<tr><td>${esc(label)}</td><td class="num" dir="ltr">${['rsi14', 'ema9', 'ema21', 'ema50', 'vwap', 'atr14', 'macdHist', 'relVol'].filter((k) => o[k] != null).map((k) => `${k.toUpperCase()} ${Number(o[k]).toFixed(k === 'rsi14' ? 1 : k === 'relVol' ? 2 : 3)}`).join(' · ')}${o.marketStructure ? ` · ${esc(I.en('structure', o.marketStructure))}` : ''}</td></tr>` : '');
    const html = `
      <div class="grid3 small">
        <div><label class="f">${esc(T('fm_dir'))}</label><b class="${f.side === 'BUY' ? 'up' : 'down'}">${esc(I.en('side', f.side))}</b> (${esc(I.en('fillKind', f.kind, f.kind))})</div>
        <div><label class="f">${esc(T('fm_time'))}</label>${U.etDateTime(f.ts)}</div>
        <div><label class="f">${esc(T('fm_qty'))}</label><span class="num">${f.qty}</span>${f.requestedQty && f.requestedQty !== f.qty ? ` ${esc(T('fm_partial', { r: f.requestedQty }))}` : ''}</div>
        <div><label class="f">${esc(T('fm_price'))}</label><span class="num">${U.price4(f.price)}</span></div>
        <div><label class="f">${esc(T('fm_quote'))}</label><span class="num">${U.price4(f.quoteAtFill && f.quoteAtFill.bid)} / ${U.price4(f.quoteAtFill && f.quoteAtFill.ask)}</span></div>
        <div><label class="f">${esc(T('fm_fees'))}</label><span class="num">${U.money(f.fees)}</span></div>
        <div><label class="f">${esc(T('fm_slip'))}</label><span class="num">${U.money(f.slippage, 4)}</span></div>
        <div><label class="f">${esc(f.side === 'SELL' ? T('fm_realized') : T('fm_unrealized'))}</label><b class="num ${U.cls(f.side === 'SELL' ? f.realizedPnl : unreal)}">${f.side === 'SELL' ? U.smoney(f.realizedPnl) : (unreal != null ? U.smoney(unreal) : T('fm_entry_na'))}</b></div>
        <div><label class="f">${esc(T('fm_strategy'))}</label>${esc(f.strategy ? I.en('strategy', f.strategy) : '—')}</div>
        <div><label class="f">${esc(T('fm_stop_target'))}</label><span class="num">${U.price4(f.stopLoss || f.protectiveStop)} / ${U.price4(f.takeProfit)}</span></div>
        <div><label class="f">${esc(T('fm_profile'))}</label>${esc(f.riskProfile ? T(`profile_${f.riskProfile}`) : T('fm_unknown_profile'))}</div>
        <div><label class="f">${esc(T('fm_source'))}</label>${esc(tr(f.dataSource || ''))}</div>
        <div><label class="f">${esc(T('fm_liq'))}</label>${esc(f.liquidityAssumed ? T('fm_liq_assumed') : T('fm_liq_quote'))}</div>
      </div>
      <h4>${esc(T('fm_reason'))}</h4><p class="small">${esc(tr(f.reason))}</p>
      ${f.indicatorsAtDecision || f.indicatorsAtFill ? `<h4>${esc(T('fm_ind'))}</h4><table class="checks">${indRow(f.indicatorsAtDecision, T('fm_at_decision'))}${indRow(f.indicatorsAtFill, T('fm_at_fill'))}</table>` : ''}
      ${p ? `<h4>${esc(T('fm_risk'))}</h4>${checksTable(r.decision.risk && r.decision.risk.checks)}<h4>${esc(T('fm_evidence'))}</h4><ul class="list small">${p.evidence.map((e) => `<li>${esc(tr(e))}</li>`).join('')}</ul>` : ''}
      <h4>${esc(T('fm_news'))}</h4>${newsItems.length ? newsItems.map((n) => `<div class="small" dir="auto">${esc(n.source)} — ${esc(n.title)}</div>`).join('') : `<div class="muted small">${esc(T('fm_none'))}</div>`}
      ${r.decision ? `<div class="actions"><button class="btn" id="fill-dec">${esc(T('fm_open_dec'))}</button></div>` : ''}`;
    Modal.open(T('fm_title', { side: I.en('side', f.side), sym: f.symbol }), html, () => { const b = $('fill-dec'); if (b) b.addEventListener('click', () => openDecision(r.decision.id)); });
  }

  // ------------------------------------------------------------ controls
  async function act(path, okMsg, body) {
    try {
      const r = await U.api(path, { method: 'POST', body: { symbol: APP.symbol || undefined, ...(body || {}) } });
      if (okMsg) U.toast(okMsg, 'ok');
      if (r && r.ai) applyState(r, false);
      return r;
    } catch (e) { U.toast(tr(e.message), 'err'); return null; }
  }
  function updateTargetNote() {
    const c = Number($('in-capital').value);
    const t = Number($('in-target').value);
    U.set('target-note', c > 0 && t > c ? T('target_note', { pct: I.iso((((t - c) / c) * 100).toFixed(0)) }) : T('target_note_none'));
  }
  $('in-capital').addEventListener('input', updateTargetNote);
  $('in-target').addEventListener('input', updateTargetNote);

  $('btn-verify').addEventListener('click', async () => {
    const sym = $('in-symbol').value.trim().toUpperCase();
    if (!sym) return U.toast(T('enter_ticker'), 'err');
    const sec = document.querySelector('.sec[data-sec="session"]');
    sec.classList.remove('collapsed');
    U.set('verify-result', T('verifying', { sym }), 'small muted');
    try {
      const r = await U.api('/api/symbol/verify', { method: 'POST', body: { symbol: sym, demo: $('in-demo').checked } });
      if (!r.ok) { $('verify-result').innerHTML = `<span class="down">✕ ${esc(tr(r.error))}</span>`; return; }
      $('verify-result').innerHTML = `<span class="up">✓ <span dir="ltr">${esc(r.symbol)}</span></span> ${esc(r.name || '')} · ${esc(r.exchange || '')} · ${esc(tr(r.feed.label))}${r.lastTrade ? ` · ${esc(T('last_px_at', { px: U.price(r.lastTrade.price), t: U.etDateTime(Date.parse(r.lastTrade.time)) }))}` : ''}${r.warnings.length ? `<br><span style="color:var(--amber)">${r.warnings.map((w) => esc(tr(w))).join('<br>')}</span>` : ''}`;
      const inList = (APP.state.watchlist || []).some((w) => w.symbol === r.symbol);
      if (inList) selectSymbol(r.symbol);
      else if (APP.state.tradingSession && APP.state.tradingSession.dataMode === (r.demo ? 'DEMO' : 'LIVE')) {
        // with a running session, a new ticker joins the watchlist (shared portfolio) instead of replacing the main symbol
        await addToWatchlist(r.symbol);
      } else if (!APP.state.tradingSession || !APP.state.position) {
        if (!APP.state.tradingSession || APP.state.tradingSession.dataMode === (r.demo ? 'DEMO' : 'LIVE')) {
          if (APP.state.symbol !== r.symbol || APP.state.dataMode !== (r.demo ? 'DEMO' : 'LIVE')) await act('/api/symbol/change', null, { symbol: r.symbol, demo: r.demo });
        }
      }
    } catch (e) { $('verify-result').innerHTML = `<span class="down">✕ ${esc(tr(e.message))}</span>`; }
  });
  $('in-symbol').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btn-verify').click(); });

  const startTrading = () => act('/api/session/start', T('started_ok'), {
    symbol: $('in-symbol').value.trim().toUpperCase(), initialCapital: Number($('in-capital').value), targetCapital: Number($('in-target').value) || null, demo: $('in-demo').checked,
  });
  $('btn-start').addEventListener('click', startTrading);
  $('btn-start-big').addEventListener('click', startTrading);
  $('btn-pause').addEventListener('click', () => act('/api/ai/pause', T('paused_ok')));
  $('btn-resume').addEventListener('click', () => act('/api/ai/resume', T('resumed_ok')));
  $('btn-stop').addEventListener('click', () => act('/api/ai/stop', T('stopped_ok')));
  $('btn-analyze').addEventListener('click', () => act('/api/ai/analyze', T('analyze_ok')));
  $('btn-close').addEventListener('click', () => {
    const pos = APP.state.position;
    Modal.open(T('close_pos'), `<p>${T('close_pos_q', { qty: pos ? pos.qty : 0, sym: esc(APP.state.symbol) })}</p><div class="actions"><button class="btn" id="cp-no">${esc(T('cancel'))}</button><button class="btn danger" id="cp-yes">${esc(T('close_pos_btn'))}</button></div>`, () => {
      $('cp-no').addEventListener('click', () => Modal.close());
      $('cp-yes').addEventListener('click', async () => { Modal.close(); await act('/api/position/close', T('closed_ok')); });
    });
  });
  $('btn-reset').addEventListener('click', () => {
    Modal.open(T('reset_sim'), `<p>${esc(T('reset_text', { id: APP.state.tradingSession && APP.state.tradingSession.id }))}</p><p>${T('reset_type')}</p><input id="reset-confirm" class="mono" dir="ltr" autocomplete="off"><div class="actions"><button class="btn" id="rs-no">${esc(T('cancel'))}</button><button class="btn danger" id="rs-yes" disabled>${esc(T('reset_btn'))}</button></div>`, () => {
      const inp = $('reset-confirm');
      inp.addEventListener('input', () => { $('rs-yes').disabled = inp.value !== 'RESET'; });
      inp.focus();
      $('rs-no').addEventListener('click', () => Modal.close());
      $('rs-yes').addEventListener('click', async () => { Modal.close(); await act('/api/session/reset', T('reset_ok'), { confirm: 'RESET' }); loadFills(); loadDecisions(); });
    });
  });
  $('btn-change-stock').addEventListener('click', () => {
    Modal.open(T('change_stock'), `<p class="small muted">${esc(T('change_stock_note'))}</p><label class="f">${esc(T('new_ticker'))}</label><input id="cs-sym" class="mono" dir="ltr" maxlength="10" value="${esc($('in-symbol').value)}"><div class="actions"><button class="btn" id="cs-no">${esc(T('cancel'))}</button><button class="btn primary" id="cs-yes">${esc(T('change_btn'))}</button></div>`, () => {
      $('cs-no').addEventListener('click', () => Modal.close());
      $('cs-yes').addEventListener('click', async () => {
        const v = $('cs-sym').value.trim().toUpperCase();
        Modal.close();
        $('in-symbol').value = v;
        await act('/api/symbol/change', T('switched_to', { sym: v }), { symbol: v, demo: $('in-demo').checked });
      });
    });
  });
  $('btn-change-capital').addEventListener('click', () => {
    const ts = APP.state.tradingSession;
    Modal.open(T('change_capital'), `<p class="small muted">${esc(T('capital_note'))}</p><div class="grid2"><div><label class="f">${esc(T('initial_capital_usd'))}</label><input id="cc-cap" type="number" dir="ltr" value="${ts ? ts.initialCapital : 500}"></div><div><label class="f">${esc(T('target_capital_usd'))}</label><input id="cc-tgt" type="number" dir="ltr" value="${ts && ts.targetCapital ? ts.targetCapital : ''}"></div></div><div class="actions"><button class="btn" id="cc-no">${esc(T('cancel'))}</button><button class="btn primary" id="cc-yes">${esc(T('apply'))}</button></div>`, () => {
      $('cc-no').addEventListener('click', () => Modal.close());
      $('cc-yes').addEventListener('click', async () => {
        const body = { initialCapital: Number($('cc-cap').value), targetCapital: $('cc-tgt').value ? Number($('cc-tgt').value) : null };
        Modal.close();
        const r = await act('/api/capital', T('capital_ok'), body);
        if (r) { $('in-capital').value = body.initialCapital; if (body.targetCapital) $('in-target').value = body.targetCapital; updateTargetNote(); }
      });
    });
  });
  $('btn-settings').addEventListener('click', () => Settings.open('credentials'));
  $('d-status').addEventListener('click', openDataHealth);
  $('btn-risk-settings').addEventListener('click', () => Settings.open('risk'));
  $('btn-ai-settings').addEventListener('click', () => Settings.open('ai'));

  // ET clock + live ages
  setInterval(() => {
    U.set('h-clock', U.etTime(Date.now()));
    if (APP.state && APP.state.ai && APP.state.ai.progress) renderProgress(APP.state.ai.progress);
    if (APP.state) { renderDataStrip(APP.state); renderOverlay(); }
  }, 1000);

  I.apply();
  markLang();
  applyLayout();
  buildLayersMenu();
  updateTargetNote();
  $('act-filters').classList.toggle('hidden', activeTab() !== 'activity');
  connect();
})();
