/* TradingView Lightweight Charts v5 wrapper: real candles, volume, overlays, trade markers, price lines,
 * plus app-computed technical annotations (swings, S/R zones, trend lines, ranges, breakouts, candle patterns)
 * and the latest AI analysis (levels, proposed entry/stop/target) drawn by a custom series primitive.
 * Chronology always runs left→right (the chart container is LTR in both languages). */
(function () {
  'use strict';
  const LWC = window.LightweightCharts;
  const TA = window.Technicals;
  const I = window.I18N;
  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const TF_SEC = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400 };
  const OVERLAY_STYLE = {
    ema9: { color: '#f472b6', lineWidth: 1 }, ema21: { color: '#facc15', lineWidth: 1 }, ema50: { color: '#fb923c', lineWidth: 1 },
    sma20: { color: '#60a5fa', lineWidth: 1 }, sma50: { color: '#a78bfa', lineWidth: 1 }, sma200: { color: '#e5e7eb', lineWidth: 2 },
    vwap: { color: '#22d3ee', lineWidth: 2, lineStyle: 2 },
    bbUpper: { color: 'rgba(148,163,184,.55)', lineWidth: 1 }, bbMid: { color: 'rgba(148,163,184,.35)', lineWidth: 1, lineStyle: 2 }, bbLower: { color: 'rgba(148,163,184,.55)', lineWidth: 1 },
  };
  const MA_KEYS = ['ema9', 'ema21', 'ema50', 'sma20', 'sma50', 'sma200', 'vwap', 'bb'];
  const DEFAULT_LAYERS = {
    swings: true, levels: true, trend: true, breaks: true, patterns: true, fills: true, ai: true, stops: true, targets: true, ma: true, momentum: false, volume: true, extended: true,
    maSet: { ema9: false, ema21: true, ema50: false, sma20: false, sma50: true, sma200: false, vwap: true, bb: false },
  };
  const C = {
    sup: [34, 197, 94], res: [239, 68, 68], broken: [148, 163, 184], ai: [167, 139, 250], watch: [250, 204, 21], range: [96, 165, 250], trend: [56, 189, 248],
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  /** Trading session of a bar (US/Eastern wall clock): RTH 9:30–16:00, PRE 4:00–9:30, POST 16:00–20:00, else overnight. */
  function barSession(b) {
    if (b.session === 'OVERNIGHT') return 'ON';
    const m = U.etParts(b.time * 1000).minuteOfDay;
    if (m >= 570 && m < 960) return 'RTH';
    if (m >= 240 && m < 570) return 'PRE';
    if (m >= 960 && m < 1200) return 'POST';
    return 'ON';
  }
  const SESSION_SHADE = { PRE: 'rgba(250,204,21,0.045)', POST: 'rgba(250,204,21,0.045)', ON: 'rgba(167,139,250,0.07)' };
  /** Overnight candles from a secondary venue (BOATS) are drawn muted so they are never mistaken for primary-feed bars. */
  function candleOf(b) {
    const c = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close };
    if (b.session === 'OVERNIGHT') {
      const col = b.close >= b.open ? 'rgba(167,139,250,0.75)' : 'rgba(167,139,250,0.4)';
      Object.assign(c, { color: col, borderColor: 'rgba(167,139,250,0.9)', wickColor: 'rgba(167,139,250,0.7)' });
    }
    return c;
  }

  function tickFmt(time, type) {
    const ms = time * 1000;
    if (type === 0) return U.etYear(ms);
    if (type === 1 || type === 2) return U.etDate(ms);
    return U.etHM(ms);
  }

  // ------------------------------------------------------------ custom primitive (zones, lines, boxes, labels)
  class AnnotationPrimitive {
    constructor(owner) {
      this.owner = owner;
      this.views = [
        { zOrder: () => 'bottom', renderer: () => ({ draw: (t) => owner.drawLayer(t, 'bottom') }) },
        { zOrder: () => 'top', renderer: () => ({ draw: (t) => owner.drawLayer(t, 'top') }) },
      ];
    }
    attached(p) { this.p = p; }
    detached() { this.p = null; }
    updateAllViews() {}
    paneViews() { return this.views; }
    request() { if (this.p) this.p.requestUpdate(); }
  }

  class TerminalChart {
    constructor(el, opts = {}) {
      this.el = el;
      this.tf = '1m';
      this.bars = [];
      this.fills = [];
      this.decisions = [];
      this.ai = null;
      this.tech = null;
      this.techSig = '';
      this.hits = [];
      this.now = opts.now || (() => Date.now());
      this.layers = this.loadLayers();
      this.chart = LWC.createChart(el, {
        autoSize: true,
        layout: { background: { type: 'solid', color: '#0e1218' }, textColor: '#8b95a7', fontSize: 11, panes: { separatorColor: '#1f2733', separatorHoverColor: '#2a3444', enableResize: true } },
        grid: { vertLines: { color: 'rgba(31,39,51,.55)' }, horzLines: { color: 'rgba(31,39,51,.55)' } },
        rightPriceScale: { borderColor: '#1f2733', scaleMargins: { top: 0.08, bottom: 0.08 } },
        timeScale: { borderColor: '#1f2733', timeVisible: true, secondsVisible: false, rightOffset: 10, barSpacing: 8, tickMarkFormatter: tickFmt },
        crosshair: { mode: LWC.CrosshairMode.Normal },
        localization: { timeFormatter: (t) => `${U.etDateTime(t * 1000)} ET`, priceFormatter: (p) => (Math.abs(p) >= 1 ? p.toFixed(2) : p.toFixed(4)) },
      });
      this.candles = this.chart.addSeries(LWC.CandlestickSeries, {
        upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444', priceLineColor: '#64748b',
      });
      this.volume = null;
      this.rsi = null;
      this.rebuildPanes();
      this.markerApi = LWC.createSeriesMarkers(this.candles, []);
      this.markerSig = '';
      this.markerList = [];
      this.lines = {};
      this.priceLines = new Map();
      this.overlayTimer = null;
      this.prim = new AnnotationPrimitive(this);
      this.candles.attachPrimitive(this.prim);
      this.onMarkerClick = null;
      this.onCandleClick = null;
      this.onAnnotationClick = null;
      this.chart.subscribeClick((param) => this.handleClick(param));
      this.chart.subscribeCrosshairMove((param) => { this.legend(param); this.hover(param); });
    }

    // ------------------------------------------------------------ layers
    loadLayers() {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('terminal.chartLayers') || 'null'); } catch { saved = null; }
      const l = { ...DEFAULT_LAYERS, ...(saved || {}) };
      l.maSet = { ...DEFAULT_LAYERS.maSet, ...((saved && saved.maSet) || {}) };
      return l;
    }
    saveLayers() { try { localStorage.setItem('terminal.chartLayers', JSON.stringify(this.layers)); } catch { /* ignore */ } }
    setLayer(key, on) {
      if (MA_KEYS.includes(key)) this.layers.maSet[key] = on; else this.layers[key] = on;
      this.saveLayers();
      if (key === 'extended') { this.setData(this.allBars || this.bars); if (this.onLayersChange) this.onLayersChange(this.layers); return; }
      if (key === 'volume' || key === 'momentum') { this.rebuildPanes(); this.fillPaneData(); }
      this.recomputeOverlays();
      this.renderMarkers(true);
      this.prim.request();
      if (this.onLayersChange) this.onLayersChange(this.layers);
    }
    preset(kind) {
      const clean = kind === 'clean';
      Object.assign(this.layers, {
        swings: !clean, levels: true, trend: !clean, breaks: !clean, patterns: !clean, fills: true, ai: true, stops: true, targets: true, ma: !clean, momentum: !clean, volume: true,
      });
      this.saveLayers();
      this.rebuildPanes(); this.fillPaneData(); this.recomputeOverlays(); this.renderMarkers(true); this.prim.request();
      if (this.onLayersChange) this.onLayersChange(this.layers);
    }

    rebuildPanes() {
      if (this.volume) { this.chart.removeSeries(this.volume); this.volume = null; }
      if (this.rsi) { this.chart.removeSeries(this.rsi); this.rsi = null; }
      try { const ps = this.chart.panes(); for (let i = ps.length - 1; i >= 1; i--) this.chart.removePane(i); } catch { /* older API */ }
      let idx = 1;
      if (this.layers.volume) { this.volume = this.chart.addSeries(LWC.HistogramSeries, { priceFormat: { type: 'volume' }, priceLineVisible: false, lastValueVisible: false }, idx++); }
      if (this.layers.momentum) {
        this.rsi = this.chart.addSeries(LWC.LineSeries, { color: '#c084fc', lineWidth: 1, priceLineVisible: false, lastValueVisible: true, title: 'RSI 14', autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }) }, idx++);
        this.rsi.createPriceLine({ price: 70, color: 'rgba(239,68,68,.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
        this.rsi.createPriceLine({ price: 30, color: 'rgba(34,197,94,.45)', lineWidth: 1, lineStyle: 2, axisLabelVisible: false, title: '' });
      }
      try {
        const ps = this.chart.panes();
        ps[0].setStretchFactor(5);
        for (let i = 1; i < ps.length; i++) ps[i].setStretchFactor(1);
      } catch { /* older API */ }
    }

    fillPaneData() {
      if (this.volume) this.volume.setData(this.bars.map((b) => ({ time: b.time, value: b.volume || 0, color: b.close >= b.open ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)' })));
      if (this.rsi) {
        const s = this.series || {};
        this.rsi.setData(this.bars.map((b, i) => (s.rsi14 && s.rsi14[i] != null ? { time: b.time, value: s.rsi14[i] } : { time: b.time })));
      }
    }

    // ------------------------------------------------------------ data
    setTimeframe(tf) { this.tf = tf; this.chart.applyOptions({ timeScale: { secondsVisible: false, timeVisible: tf !== '1d' } }); }

    /** Regular-hours-only view hides pre/after-hours and overnight bars on intraday timeframes (data is kept). */
    showBar(b) { return this.layers.extended || this.tf === '1d' || barSession(b) === 'RTH'; }
    setData(bars) {
      this.allBars = bars.map((b) => ({ ...b }));
      this.bars = this.allBars.filter((b) => this.showBar(b));
      this.candles.setData(this.bars.map(candleOf));
      this.recomputeOverlays();
      this.fillPaneData();
      this.techSig = '';
      this.computeTechnicals(true);
      this.renderMarkers(true);
      this.legend({});
      this.prim.request();
    }

    updateBar(bar) {
      if (!bar) return;
      if (this.allBars) {
        const la = this.allBars[this.allBars.length - 1];
        if (la && bar.time === la.time) this.allBars[this.allBars.length - 1] = { ...bar };
        else if (!la || bar.time > la.time) this.allBars.push({ ...bar });
      }
      if (!this.showBar(bar)) return;
      const last = this.bars[this.bars.length - 1];
      if (last && bar.time < last.time) return; // never rewrite history out of order
      if (last && bar.time === last.time) this.bars[this.bars.length - 1] = { ...bar };
      else this.bars.push({ ...bar });
      this.candles.update(candleOf(bar));
      if (this.volume) this.volume.update({ time: bar.time, value: bar.volume || 0, color: bar.close >= bar.open ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)' });
      // indicator overlays and technicals are throttled; the live candle itself is never delayed
      if (!this.overlayTimer) {
        this.overlayTimer = setTimeout(() => {
          this.overlayTimer = null;
          this.recomputeOverlays();
          if (this.rsi) this.fillPaneData();
          if (this.computeTechnicals(false)) this.renderMarkers(false);
          this.prim.request();
        }, 1000);
      }
      this.legend({});
    }

    isComplete(b) {
      const sec = TF_SEC[this.tf] || 60;
      return (b.time + sec) * 1000 <= this.now();
    }
    completedBars() {
      const n = this.bars.length;
      if (!n) return [];
      return this.isComplete(this.bars[n - 1]) ? this.bars : this.bars.slice(0, -1);
    }

    /** Recompute app technicals only when completed bars change (or periodically for level roles). */
    computeTechnicals(force) {
      if (!TA) return false;
      const done = this.completedBars();
      const lb = done[done.length - 1];
      const lastPx = this.bars.length ? this.bars[this.bars.length - 1].close : null;
      const sig = lb ? `${done.length}|${lb.time}|${lb.close}|${lb.high}|${lb.low}` : 'none';
      const now = Date.now();
      const priceStale = this.tech && this.tech.available && isNum(lastPx) && Math.abs(lastPx - this.tech.price) / lastPx > 0.001 && now - (this.techAt || 0) > 5000;
      if (!force && sig === this.techSig && !priceStale) return false;
      this.techSig = sig;
      this.techAt = now;
      const tfSec = TF_SEC[this.tf] || 60;
      const win = done.slice(-600);
      this.techOffset = done.length - win.length;
      this.tech = TA.analyze(win, { tfSec, price: lastPx, session: this.session || {} });
      if (this.onTechnicals) this.onTechnicals(this.tech);
      return true;
    }
    setSessionLevels(s) { this.session = s || {}; }

    toggle(key, on) { this.setLayer(key, on); }

    recomputeOverlays() {
      if (!window.Indicators) return;
      const s = window.Indicators.computeSeries(this.bars, U.sessionOf(this.tf));
      this.series = s;
      const want = new Set();
      if (this.layers.ma) {
        for (const k of MA_KEYS) {
          if (!this.layers.maSet[k]) continue;
          if (k === 'bb') { want.add('bbUpper'); want.add('bbMid'); want.add('bbLower'); } else want.add(k);
        }
      }
      for (const k of Object.keys(this.lines)) if (!want.has(k)) { this.chart.removeSeries(this.lines[k]); delete this.lines[k]; }
      for (const k of want) {
        if (!s[k]) continue;
        if (!this.lines[k]) this.lines[k] = this.chart.addSeries(LWC.LineSeries, { ...OVERLAY_STYLE[k], priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        const data = [];
        for (let i = 0; i < this.bars.length; i++) {
          const v = s[k][i];
          data.push(v == null ? { time: this.bars[i].time } : { time: this.bars[i].time, value: v });
        }
        this.lines[k].setData(data);
      }
    }

    bucket(tsMs) {
      const sec = Math.floor(tsMs / 1000);
      if (this.tf === '1d') {
        const p = U.etParts(tsMs);
        const day = this.bars.find((b) => U.etParts(b.time * 1000).dateStr === p.dateStr);
        return day ? day.time : null;
      }
      const s = TF_SEC[this.tf];
      return Math.floor(sec / s) * s;
    }
    /** Bar time at or before a timestamp (for annotations anchored to an analysis time). */
    barTimeAtOrBefore(tsSec) {
      let lo = 0; let hi = this.bars.length - 1; let ans = null;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (this.bars[m].time <= tsSec) { ans = this.bars[m].time; lo = m + 1; } else hi = m - 1; }
      return ans;
    }

    setFills(fills) { this.fills = [...(fills || [])]; this.renderMarkers(true); }
    addFill(f) { if (!this.fills.some((x) => x.id === f.id)) this.fills.push(f); this.renderMarkers(true); }
    setDecisions(d) { this.decisions = (d || []).slice(0, 40); this.renderMarkers(true); }
    setAI(ca) { this.ai = ca || null; this.prim.request(); }
    relabel() { this.renderMarkers(true); this.prim.request(); this.legend({}); }

    // ------------------------------------------------------------ markers
    renderMarkers(force) {
      const times = new Set(this.bars.map((b) => b.time));
      const list = [];
      const L = this.layers;
      const ar = I.isAr;
      if (L.fills) {
        for (const f of this.fills) {
          const t = this.bucket(f.ts);
          if (t == null || !times.has(t)) continue;
          const buy = f.side === 'BUY';
          const kind = f.kind && f.kind !== 'AI' ? ` · ${I.en('fillKind', f.kind)}` : '';
          list.push({ id: f.id, time: t, position: 'atPriceMiddle', price: f.price, shape: buy ? 'arrowUp' : 'arrowDown', color: buy ? '#22c55e' : '#ef4444', text: `${I.en('side', f.side)} ${f.qty}${kind}`, size: 1.4 });
        }
      }
      const tech = this.tech && this.tech.available ? this.tech : null;
      if (tech && L.swings) {
        const pts = tech.swings.points;
        const labelFrom = pts.length - 8;
        pts.forEach((p, i) => {
          const lab = p.label === 'EQ' ? (p.type === 'H' ? 'EQH' : 'EQL') : (p.label || p.type);
          list.push({ id: `sw:${p.type}:${p.time}`, time: p.time, position: p.type === 'H' ? 'aboveBar' : 'belowBar', shape: 'circle', color: p.type === 'H' ? '#f87171' : '#4ade80', size: 0.45, text: i >= labelFrom ? I.en('swing', lab) : '' });
        });
      }
      if (tech && L.breaks) {
        for (const e of tech.events.slice(-6)) {
          const up = e.type === 'BREAKOUT';
          list.push({ id: `brk:${e.type}:${e.time}`, time: e.time, position: up ? 'belowBar' : 'aboveBar', shape: up ? 'arrowUp' : 'arrowDown', color: up ? '#38bdf8' : '#fb923c', size: 0.8, text: up ? (ar ? 'اختراق' : 'Breakout') : (ar ? 'كسر' : 'Breakdown') });
        }
      }
      if (tech && L.patterns) {
        const from = tech.bars - 60;
        for (const p of tech.patterns) {
          if (p.index < from) continue;
          list.push({ id: `pat:${p.id}`, time: p.time, position: p.direction === 'BULLISH' ? 'belowBar' : 'aboveBar', shape: 'square', color: p.direction === 'BULLISH' ? '#86efac' : p.direction === 'BEARISH' ? '#fca5a5' : '#fbbf24', size: 0.6, text: I.en('pattern', p.code) });
        }
      }
      if (L.ai) {
        const execStatuses = new Set(['EXECUTED', 'PARTIALLY_EXECUTED']);
        for (const d of this.decisions.slice(0, 15)) {
          if (!d.action || execStatuses.has(d.status)) continue;
          const t = this.bucket(d.ts);
          if (t == null || !times.has(t)) continue;
          list.push({ id: `dec:${d.id}`, time: t, position: 'aboveBar', shape: 'circle', color: '#a78bfa', size: 0.7, text: `AI: ${I.en('action', d.action)}` });
        }
      }
      list.sort((a, b) => a.time - b.time);
      const sig = list.map((m) => `${m.id}|${m.time}|${m.text}`).join(';');
      if (!force && sig === this.markerSig) return;
      this.markerSig = sig;
      this.markerList = list;
      this.markerApi.setMarkers(list);
    }

    /** lines: [{key, price, color, title, style(0 solid|2 dashed|1 dotted), width, axis}] — real position & pending orders. */
    syncPriceLines(lines) {
      const keep = new Set();
      for (const l of lines) {
        if (!isNum(l.price)) continue;
        keep.add(l.key);
        const opts = { price: l.price, color: l.color, lineWidth: l.width || 1, lineStyle: l.style == null ? 2 : l.style, axisLabelVisible: l.axis !== false, title: l.title || '' };
        const ex = this.priceLines.get(l.key);
        if (ex) {
          if (ex.sig !== JSON.stringify(opts)) { ex.line.applyOptions(opts); ex.sig = JSON.stringify(opts); }
        } else {
          this.priceLines.set(l.key, { line: this.candles.createPriceLine(opts), sig: JSON.stringify(opts) });
        }
      }
      for (const [k, v] of this.priceLines) if (!keep.has(k)) { this.candles.removePriceLine(v.line); this.priceLines.delete(k); }
    }

    // ------------------------------------------------------------ drawing
    xOf(time) { const x = this.chart.timeScale().timeToCoordinate(time); return x == null ? null : x; }
    yOf(price) { const y = this.candles.priceToCoordinate(price); return y == null ? null : y; }

    drawLayer(target, layer) {
      target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
        const W = mediaSize.width;
        const H = mediaSize.height;
        if (layer === 'bottom') this.hits = [];
        const labels = [];
        try {
          if (layer === 'bottom') this.drawBottom(ctx, W, H);
          else { this.drawTop(ctx, W, H, labels); this.drawLabels(ctx, W, labels); }
        } catch (e) { /* drawing must never break the chart */ if (window.console) console.warn('annotation draw', e); }
      });
    }

    /** Shade pre/after-hours and overnight stretches so session boundaries are obvious. */
    drawSessions(ctx, H) {
      if (!this.layers.extended || this.tf === '1d' || !this.bars.length) return;
      const ts = this.chart.timeScale();
      const r = ts.getVisibleLogicalRange && ts.getVisibleLogicalRange();
      const n = this.bars.length;
      const i0 = r ? Math.max(0, Math.floor(r.from) - 1) : 0;
      const i1 = r ? Math.min(n - 1, Math.ceil(r.to) + 1) : n - 1;
      if (i1 < i0) return;
      const sp = (ts.options().barSpacing || 6) / 2;
      let runStart = null; let runKind = null; let prevX = null;
      const flush = (xEnd) => {
        if (runKind && runKind !== 'RTH' && runStart != null && xEnd != null) { ctx.fillStyle = SESSION_SHADE[runKind]; ctx.fillRect(runStart - sp, 0, Math.max(1, xEnd - runStart + 2 * sp), H); }
      };
      for (let i = i0; i <= i1; i++) {
        const b = this.bars[i];
        const x = this.xOf(b.time);
        if (x == null) continue;
        const k = barSession(b);
        if (k !== runKind) { flush(prevX); runKind = k; runStart = x; }
        prevX = x;
      }
      flush(prevX);
    }

    drawBottom(ctx, W, H) {
      const L = this.layers;
      this.drawSessions(ctx, H);
      const tech = this.tech && this.tech.available ? this.tech : null;
      if (tech && L.levels) {
        const show = [...tech.levels.supports.slice(0, 2), ...tech.levels.resistances.slice(0, 2)];
        for (const l of show) {
          const y1 = this.yOf(l.zoneHigh); const y2 = this.yOf(l.zoneLow);
          if (y1 == null || y2 == null) continue;
          const sup = l.role === 'support' || (l.role === 'at' && l.rank && l.rank[0] === 'S');
          const x0 = l.firstTime != null ? Math.max(0, this.xOf(l.firstTime) ?? 0) : 0;
          ctx.fillStyle = rgba(sup ? C.sup : C.res, 0.09);
          ctx.fillRect(x0, Math.min(y1, y2), W - x0, Math.max(2, Math.abs(y2 - y1)));
          this.hits.push({ kind: 'level', data: l, y1: Math.min(y1, y2) - 3, y2: Math.max(y1, y2) + 3, x1: x0, x2: W });
        }
        for (const l of tech.levels.broken) {
          const y = this.yOf(l.price);
          if (y == null) continue;
          ctx.strokeStyle = rgba(C.broken, 0.45); ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
          const x0 = l.brokenAt != null ? Math.max(0, this.xOf(l.brokenAt) ?? 0) : 0;
          ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
          this.hits.push({ kind: 'level', data: l, y1: y - 4, y2: y + 4, x1: x0, x2: W });
        }
      }
      if (tech && L.trend && tech.range) {
        const r = tech.range;
        const x1 = this.xOf(r.startTime); const x2 = this.xOf(r.endTime);
        const y1 = this.yOf(r.high); const y2 = this.yOf(r.low);
        if ([x1, x2, y1, y2].every((v) => v != null)) {
          ctx.fillStyle = rgba(C.range, 0.05); ctx.strokeStyle = rgba(C.range, 0.5); ctx.setLineDash([5, 4]); ctx.lineWidth = 1;
          ctx.fillRect(x1, y1, Math.max(4, x2 - x1), y2 - y1); ctx.strokeRect(x1, y1, Math.max(4, x2 - x1), y2 - y1); ctx.setLineDash([]);
          this.hits.push({ kind: 'range', data: r, y1, y2, x1, x2: x2 + 2, edgeOnly: true });
        }
      }
      // AI plan boxes (proposal, never an execution)
      const ai = L.ai && this.ai;
      if (ai && ai.plan && isNum(ai.plan.entry)) {
        const t0 = this.barTimeAtOrBefore(Math.floor(ai.at / 1000));
        const x0 = t0 != null ? this.xOf(t0) : null;
        const xs = x0 == null ? W * 0.75 : Math.max(0, x0);
        const ye = this.yOf(ai.plan.entry);
        if (ye != null) {
          if (L.targets && isNum(ai.plan.target)) { const yt = this.yOf(ai.plan.target); if (yt != null) { ctx.fillStyle = rgba(C.sup, 0.10); ctx.fillRect(xs, Math.min(ye, yt), W - xs, Math.abs(yt - ye)); } }
          if (L.stops && isNum(ai.plan.stop)) { const ys = this.yOf(ai.plan.stop); if (ys != null) { ctx.fillStyle = rgba(C.res, 0.10); ctx.fillRect(xs, Math.min(ye, ys), W - xs, Math.abs(ys - ye)); } }
        }
      }
    }

    drawTop(ctx, W, H, labels) {
      const L = this.layers;
      const ar = I.isAr;
      const tech = this.tech && this.tech.available ? this.tech : null;
      const off = this.techOffset || 0;
      const compact = W < 520; // phones: fewer labels
      if (tech && L.levels) {
        for (const l of [...tech.levels.supports.slice(0, compact ? 1 : 2), ...tech.levels.resistances.slice(0, compact ? 1 : 2)]) {
          const y = this.yOf(l.price);
          if (y == null) continue;
          const sup = l.rank && l.rank[0] === 'S';
          ctx.strokeStyle = rgba(sup ? C.sup : C.res, 0.75); ctx.lineWidth = 1; ctx.setLineDash([]);
          ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
          labels.push({ y, text: `${EX.levelName(l)} ${U.price(l.price)} · ${l.strength}`, color: rgba(sup ? C.sup : C.res, 0.95), kind: 'level', data: l });
        }
        for (const l of compact ? [] : tech.levels.broken) {
          const y = this.yOf(l.price);
          if (y != null) labels.push({ y, text: `${EX.levelName(l)} ${U.price(l.price)}`, color: rgba(C.broken, 0.85), kind: 'level', data: l, faint: true });
        }
      }
      if (tech && L.trend) {
        for (const t of tech.trendlines) {
          const xa = this.xOf(t.from.time); const xb = this.xOf(t.end.time);
          const ya = this.yOf(t.from.price); const yb = this.yOf(t.end.price);
          if ([xa, xb, ya, yb].some((v) => v == null)) continue;
          const up = t.kind === 'SUPPORT_UP';
          ctx.strokeStyle = t.status === 'broken' ? rgba(C.broken, 0.6) : rgba(up ? C.sup : C.res, 0.85);
          ctx.lineWidth = 1.4; ctx.setLineDash(t.status === 'broken' ? [4, 4] : []);
          ctx.beginPath(); ctx.moveTo(xa, ya); ctx.lineTo(xb, yb); ctx.stroke(); ctx.setLineDash([]);
          this.hits.push({ kind: 'trendline', data: t, seg: [xa, ya, xb, yb] });
        }
        if (tech.range) {
          const x1 = this.xOf(tech.range.startTime); const y1 = this.yOf(tech.range.high);
          if (x1 != null && y1 != null) this.text(ctx, ar ? 'نطاق تداول' : 'Trading range', x1 + 4, y1 - 4, rgba(C.range, 0.95), 'left');
        }
      }
      if (tech && L.swings) {
        for (const p of tech.swings.provisional) {
          const x = this.xOf(p.time); const y = this.yOf(p.price);
          if (x == null || y == null) continue;
          const dy = p.type === 'H' ? -12 : 12;
          ctx.strokeStyle = p.type === 'H' ? '#f87171' : '#4ade80'; ctx.lineWidth = 1.2; ctx.setLineDash([2, 2]);
          ctx.beginPath(); ctx.arc(x, y + dy, 5, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
          this.text(ctx, '?', x, y + dy + 3.5, ctx.strokeStyle, 'center', 9);
          this.hits.push({ kind: 'provisional', data: p, cx: x, cy: y + dy, r: 8 });
        }
      }
      // AI analysis: levels and the proposed plan
      const ai = L.ai && this.ai;
      if (ai) {
        const t0 = this.barTimeAtOrBefore(Math.floor(ai.at / 1000));
        const x0 = t0 != null ? this.xOf(t0) : null;
        const xs = x0 == null ? 0 : Math.max(0, x0);
        const inval = this.aiInvalidation();
        for (const lv of ai.levels || []) {
          const y = this.yOf(lv.price);
          if (y == null) continue;
          const bad = inval.get(lv.price);
          const color = bad ? rgba(C.broken, 0.7) : lv.kind === 'support' ? rgba(C.sup, 0.9) : lv.kind === 'resistance' ? rgba(C.res, 0.9) : rgba(C.watch, 0.95);
          ctx.strokeStyle = color; ctx.lineWidth = lv.kind === 'breakout' || lv.kind === 'watch' ? 1.5 : 1;
          ctx.setLineDash(lv.verified ? [6, 3] : [2, 3]);
          ctx.beginPath(); ctx.moveTo(xs, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
          const kindTxt = { support: ar ? 'دعم' : 'Support', resistance: ar ? 'مقاومة' : 'Resistance', breakout: ar ? 'مستوى الاختراق المحتمل' : 'Potential breakout', breakdown: ar ? 'مستوى الكسر المحتمل' : 'Potential breakdown', watch: ar ? 'مستوى المراقبة' : 'Watch level' }[lv.kind];
          const tag = bad ? (ar ? ' (أُلغي)' : ' (invalidated)') : lv.verified ? ' ✓' : (ar ? ' (غير مؤكد)' : ' (unverified)');
          labels.push({ y, text: `AI ${kindTxt} ${U.price(lv.price)}${tag}`, color, kind: 'ailevel', data: { ...lv, invalidatedAt: bad || null } });
        }
        const p = ai.plan;
        if (p && isNum(p.entry)) {
          const ye = this.yOf(p.entry);
          const entryTxt = { PROPOSED_ENTRY: I.T('proposed_entry'), PROPOSED_LIMIT: I.T('proposed_limit'), CONDITIONAL: I.T('conditional_entry') }[p.kind] || I.T('entry');
          if (ye != null) {
            ctx.strokeStyle = 'rgba(229,231,235,.9)'; ctx.setLineDash([6, 4]); ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(xs, ye); ctx.lineTo(W, ye); ctx.stroke(); ctx.setLineDash([]);
            labels.push({ y: ye, text: `${entryTxt} ${U.price(p.entry)} · ${I.T('rr_short')} ${p.rewardToRisk}`, color: 'rgba(229,231,235,.95)', kind: 'plan', data: p });
          }
          if (L.stops && isNum(p.stop)) {
            const ys = this.yOf(p.stop);
            if (ys != null) { ctx.strokeStyle = rgba(C.res, 0.9); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(xs, ys); ctx.lineTo(W, ys); ctx.stroke(); ctx.setLineDash([]); labels.push({ y: ys, text: `${ar ? 'وقف مقترح' : 'Proposed stop'} ${U.price(p.stop)}`, color: rgba(C.res, 0.95), kind: 'plan', data: p }); }
          }
          if (L.targets && isNum(p.target)) {
            const yt = this.yOf(p.target);
            if (yt != null) { ctx.strokeStyle = rgba(C.sup, 0.9); ctx.setLineDash([6, 4]); ctx.beginPath(); ctx.moveTo(xs, yt); ctx.lineTo(W, yt); ctx.stroke(); ctx.setLineDash([]); labels.push({ y: yt, text: `${ar ? 'هدف مقترح' : 'Proposed target'} ${U.price(p.target)}`, color: rgba(C.sup, 0.95), kind: 'plan', data: p }); }
          }
        }
        if (ai.forecast) {
          for (const v of [ai.forecast.low, ai.forecast.high]) {
            const y = isNum(v) ? this.yOf(v) : null;
            if (y == null) continue;
            ctx.strokeStyle = rgba(C.ai, 0.6); ctx.setLineDash([1, 4]); ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(xs, y); ctx.lineTo(W, y); ctx.stroke(); ctx.setLineDash([]);
            if (!compact) labels.push({ y, text: `${ar ? 'نطاق متوقع (توقع)' : 'Expected range (forecast)'} ${U.price(v)}`, color: rgba(C.ai, 0.85), kind: 'forecast', data: ai.forecast, faint: true });
          }
        }
      }
      void off; void H;
    }

    /** AI levels invalidated by later completed candles (support closed below / resistance closed above). */
    aiInvalidation() {
      const out = new Map();
      if (!this.ai) return out;
      const tol = this.ai.tolerance || 0;
      const fromSec = Math.floor(this.ai.at / 1000);
      const done = this.completedBars().filter((b) => b.time >= fromSec);
      for (const lv of this.ai.levels || []) {
        for (const b of done) {
          if ((lv.kind === 'support' && b.close < lv.price - tol) || (lv.kind === 'resistance' && b.close > lv.price + tol)) { out.set(lv.price, b.time); break; }
        }
      }
      return out;
    }

    text(ctx, s, x, y, color, align = 'left', size = 11) {
      ctx.font = `600 ${size}px ${getComputedStyle(document.body).fontFamily}`;
      ctx.fillStyle = color; ctx.textAlign = align; ctx.direction = I.isAr ? 'rtl' : 'ltr';
      if (I.isAr && align === 'left') { ctx.textAlign = 'right'; x += ctx.measureText(s).width; }
      ctx.fillText(s, x, y);
    }

    /** Right-aligned pill labels, pushed apart vertically so they never overlap. */
    drawLabels(ctx, W, labels) {
      if (!labels.length) return;
      const font = `600 11px ${getComputedStyle(document.body).fontFamily}`;
      ctx.font = font;
      labels.sort((a, b) => a.y - b.y);
      // merge labels that sit on (almost) the same price line: one pill, parts joined with " · "
      const merged = [];
      for (const l of labels) {
        const prev = merged[merged.length - 1];
        if (prev && Math.abs(l.y - prev.y) < 3) {
          const part = l.text.replace(/\s[\d.,]+(\s|$).*$/, '').replace(/^AI\s/, '');
          if (!prev.text.includes(part)) prev.text = `${prev.text} · ${part}`;
          prev.faint = prev.faint && l.faint;
          continue;
        }
        merged.push({ ...l });
      }
      labels = merged;
      const H = 16;
      let lastY = -Infinity;
      for (const l of labels) { l.ly = Math.max(l.y, lastY + H + 2); lastY = l.ly; }
      for (const l of labels) {
        ctx.direction = I.isAr ? 'rtl' : 'ltr';
        const w = ctx.measureText(l.text).width + 12;
        const x2 = W - 6;
        const x1 = x2 - w;
        const y = l.ly - H / 2;
        ctx.globalAlpha = l.faint ? 0.75 : 1;
        ctx.fillStyle = 'rgba(14,18,24,.88)';
        ctx.strokeStyle = l.color; ctx.lineWidth = 1;
        if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x1, y, w, H, 3); ctx.fill(); ctx.stroke(); } else { ctx.fillRect(x1, y, w, H); ctx.strokeRect(x1, y, w, H); }
        if (Math.abs(l.ly - l.y) > 1) { ctx.beginPath(); ctx.moveTo(x1, l.ly); ctx.lineTo(x1 - 10, l.y); ctx.stroke(); }
        ctx.fillStyle = l.color; ctx.textBaseline = 'middle';
        ctx.textAlign = I.isAr ? 'right' : 'left';
        ctx.fillText(l.text, I.isAr ? x2 - 6 : x1 + 6, l.ly + 0.5);
        ctx.textBaseline = 'alphabetic'; ctx.globalAlpha = 1;
        this.hits.push({ kind: l.kind, data: l.data, x1, x2, y1: y, y2: y + H, label: true });
      }
    }

    // ------------------------------------------------------------ interaction
    hitTest(pt) {
      if (!pt) return null;
      const { x, y } = pt;
      // labels first, then lines/zones (closest)
      for (const h of this.hits) if (h.label && x >= h.x1 && x <= h.x2 && y >= h.y1 && y <= h.y2) return h;
      for (const h of this.hits) {
        if (h.kind === 'provisional' && Math.hypot(x - h.cx, y - h.cy) <= h.r) return h;
        if (h.kind === 'trendline') {
          const [x1, y1, x2, y2] = h.seg;
          if (x < Math.min(x1, x2) - 4 || x > Math.max(x1, x2) + 4) continue;
          const d = Math.abs((y2 - y1) * x - (x2 - x1) * y + x2 * y1 - y2 * x1) / Math.hypot(y2 - y1, x2 - x1);
          if (d <= 5) return h;
        }
      }
      let best = null;
      for (const h of this.hits) {
        if (h.label || h.kind === 'trendline' || h.kind === 'provisional' || h.kind === 'range') continue;
        if (x < h.x1 || x > h.x2) continue;
        const mid = (h.y1 + h.y2) / 2;
        const thin = h.y2 - h.y1 <= 10;
        if ((thin && Math.abs(y - mid) <= 5) || (!thin && Math.abs(y - h.y1) <= 4) || (!thin && Math.abs(y - h.y2) <= 4)) {
          const d = Math.abs(y - mid);
          if (!best || d < best.d) best = { d, h };
        }
      }
      return best ? best.h : null;
    }

    handleClick(param) {
      const id = (param.hoveredInfo && param.hoveredInfo.objectId) || param.hoveredObjectId;
      if (id != null && this.onMarkerClick) {
        const sid = String(id);
        if (sid.startsWith('fill_') || sid.startsWith('dec:') || sid.startsWith('pat:') || sid.startsWith('sw:') || sid.startsWith('brk:')) return this.onMarkerClick(sid);
      }
      const h = this.hitTest(param.point);
      if (h && this.onAnnotationClick) return this.onAnnotationClick(h);
      if (param.time != null && this.onCandleClick) {
        const bar = this.bars.find((b) => b.time === param.time);
        if (bar) this.onCandleClick(bar);
      }
    }

    hover(param) {
      const tip = document.getElementById('candle-tip');
      if (!tip) return;
      if (!param || param.time == null || !param.point) { tip.classList.add('hidden'); return; }
      const bar = this.bars.find((b) => b.time === param.time);
      if (!bar) { tip.classList.add('hidden'); return; }
      const up = bar.close > bar.open;
      const dn = bar.close < bar.open;
      const range = bar.high - bar.low;
      const body = Math.abs(bar.close - bar.open);
      const forming = !this.isComplete(bar);
      tip.innerHTML = `<div class="t">${U.esc(U.etDateTime(bar.time * 1000))}${forming ? ` · ${U.esc(I.T('forming'))}` : ''}</div>
        <div><b class="${up ? 'up' : dn ? 'down' : ''}">${U.esc(up ? I.T('dir_up') : dn ? I.T('dir_down') : I.T('dir_flat'))}</b></div>
        <div>${U.esc(I.T('open'))} <span class="num">${U.price(bar.open)}</span> · ${U.esc(I.T('close_px'))} <span class="num">${U.price(bar.close)}</span></div>
        <div>${U.esc(I.T('high'))} <span class="num">${U.price(bar.high)}</span> · ${U.esc(I.T('low'))} <span class="num">${U.price(bar.low)}</span></div>
        <div>${U.esc(I.T('volume'))} <span class="num">${U.num(bar.volume)}</span> · ${U.esc(I.T('body_size'))} <span class="num">${range > 0 ? ((body / range) * 100).toFixed(0) : 0}%</span></div>`;
      tip.classList.remove('hidden');
      const wrap = this.el.parentElement.getBoundingClientRect();
      const tw = tip.offsetWidth; const th = tip.offsetHeight;
      let x = param.point.x + 16; let y = param.point.y + 16;
      if (x + tw > wrap.width - 70) x = param.point.x - tw - 16;
      if (y + th > wrap.height - 30) y = param.point.y - th - 16;
      tip.style.left = `${Math.max(4, x)}px`; tip.style.top = `${Math.max(4, y)}px`;
    }

    legend(param) {
      const el = document.getElementById('chart-legend');
      if (!el) return;
      let bar = null;
      if (param && param.time != null) bar = this.bars.find((b) => b.time === param.time);
      if (!bar) bar = this.bars[this.bars.length - 1];
      if (!bar) { el.textContent = ''; return; }
      const i = this.bars.indexOf(bar);
      const s = this.series || {};
      const v = (k) => (s[k] && s[k][i] != null ? s[k][i].toFixed(2) : 'n/a');
      el.textContent = `${U.etDateTime(bar.time * 1000)}  O ${U.price(bar.open)} H ${U.price(bar.high)} L ${U.price(bar.low)} C ${U.price(bar.close)} V ${U.num(bar.volume)}${!this.isComplete(bar) ? ' *' : ''}  RSI ${s.rsi14 && s.rsi14[i] != null ? s.rsi14[i].toFixed(1) : 'n/a'}  VWAP ${v('vwap')}`;
    }

    latestIndicatorValues() {
      if (!window.Indicators || !this.bars.length) return null;
      return window.Indicators.latestValues(this.completedBars(), U.sessionOf(this.tf));
    }
    seriesValuesAt(time) {
      const i = this.bars.findIndex((b) => b.time === time);
      const s = this.series || {};
      const g = (k) => (i >= 0 && s[k] && s[k][i] != null ? s[k][i] : null);
      return { rsi14: g('rsi14'), ema9: g('ema9'), ema21: g('ema21'), ema50: g('ema50'), vwap: g('vwap'), relVol: g('relVol') };
    }

    zoom(factor) {
      const ts = this.chart.timeScale();
      const r = ts.getVisibleLogicalRange();
      if (!r) return;
      const len = Math.max(10, (r.to - r.from) * factor);
      ts.setVisibleLogicalRange({ from: r.to - len, to: r.to });
    }
    fit() { this.chart.timeScale().fitContent(); }
    scrollToRealtime() { this.chart.timeScale().scrollToRealTime(); }
    /** Show the most recent `n` bars (default view: large candles, not the whole history squeezed). */
    showRecent(n = 150) {
      const len = this.bars.length;
      if (!len) return;
      if (len <= n) { this.fit(); return; }
      this.chart.timeScale().setVisibleLogicalRange({ from: len - n, to: len + 8 });
    }
  }

  class EquityChart {
    constructor(el) {
      this.el = el;
      this.chart = LWC.createChart(el, {
        autoSize: true,
        layout: { background: { type: 'solid', color: '#0e1218' }, textColor: '#8b95a7', fontSize: 10 },
        grid: { vertLines: { color: 'rgba(31,39,51,.5)' }, horzLines: { color: 'rgba(31,39,51,.5)' } },
        rightPriceScale: { borderColor: '#1f2733' }, timeScale: { borderColor: '#1f2733', timeVisible: true, tickMarkFormatter: tickFmt },
        localization: { timeFormatter: (t) => `${U.etDateTime(t * 1000)} ET`, priceFormatter: (p) => `$${p.toFixed(2)}` },
      });
      this.eq = this.chart.addSeries(LWC.LineSeries, { color: '#a78bfa', lineWidth: 2 });
      this.bh = this.chart.addSeries(LWC.LineSeries, { color: '#64748b', lineWidth: 1, lineStyle: 2 });
      this.points = [];
    }
    norm(points) {
      const out = new Map();
      for (const p of points) out.set(Math.floor(p.ts / 1000), p);
      return [...out.entries()].sort((a, b) => a[0] - b[0]);
    }
    setData(points) {
      this.points = points.slice();
      const n = this.norm(this.points);
      this.eq.setData(n.map(([t, p]) => ({ time: t, value: p.equity })));
      this.bh.setData(n.filter(([, p]) => U.isNum(p.benchmark)).map(([t, p]) => ({ time: t, value: p.benchmark })));
      this.chart.timeScale().fitContent();
    }
    add(p) {
      const last = this.points[this.points.length - 1];
      if (last && Math.floor(p.ts / 1000) < Math.floor(last.ts / 1000)) return;
      this.points.push(p);
      const t = Math.floor(p.ts / 1000);
      this.eq.update({ time: t, value: p.equity });
      if (U.isNum(p.benchmark)) this.bh.update({ time: t, value: p.benchmark });
    }
  }

  window.TerminalChart = TerminalChart;
  window.EquityChart = EquityChart;
  window.CHART_MA_KEYS = MA_KEYS;
  window.CHART_TF_SEC = TF_SEC;
})();
