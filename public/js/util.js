/* Shared browser helpers (no secrets ever reach the browser). */
(function () {
  'use strict';
  const TZ = 'America/New_York';
  const fTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fHM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' });
  // Dates follow the interface language (Arabic month names with Western digits); times stay HH:MM:SS.
  const dateFmt = (l) => new Intl.DateTimeFormat(l === 'ar' ? 'ar-u-nu-latn' : 'en-US', { timeZone: TZ, month: 'short', day: '2-digit' });
  let fDate = dateFmt(window.I18N ? window.I18N.lang : 'en');
  if (window.I18N) window.I18N.onChange((l) => { fDate = dateFmt(l); });
  const fYear = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric' });
  const fParts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const partsCache = new Map();

  function etParts(ms) {
    const k = Math.floor(ms / 60000);
    if (partsCache.has(k)) return partsCache.get(k);
    const p = {};
    for (const x of fParts.formatToParts(new Date(k * 60000))) p[x.type] = x.value;
    const out = { dateStr: `${p.year}-${p.month}-${p.day}`, minuteOfDay: (Number(p.hour) % 24) * 60 + Number(p.minute) };
    if (partsCache.size > 20000) partsCache.clear();
    partsCache.set(k, out);
    return out;
  }

  const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
  const U = {
    etTime: (ms) => (isNum(ms) ? fTime.format(new Date(ms)) : '—'),
    etHM: (ms) => (isNum(ms) ? fHM.format(new Date(ms)) : '—'),
    etDate: (ms) => (isNum(ms) ? fDate.format(new Date(ms)) : '—'),
    etYear: (ms) => fYear.format(new Date(ms)),
    etDateTime: (ms) => (isNum(ms) ? `${fDate.format(new Date(ms))} ${fTime.format(new Date(ms))}` : '—'),
    etParts,
    isNum,
    price: (x) => (isNum(x) ? x.toFixed(Math.abs(x) >= 1 ? 2 : 4) : '—'),
    price4: (x) => (isNum(x) ? x.toFixed(4) : '—'),
    money: (x, d = 2) => (isNum(x) ? `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '—'),
    smoney: (x, d = 2) => (isNum(x) ? `${x > 0 ? '+' : x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '—'),
    pct: (x, d = 2) => (isNum(x) ? `${x > 0 ? '+' : ''}${x.toFixed(d)}%` : '—'),
    upct: (x, d = 2) => (isNum(x) ? `${x.toFixed(d)}%` : '—'),
    num: (x, d = 0) => (isNum(x) ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—'),
    cls: (x) => (isNum(x) ? (x > 0 ? 'up' : x < 0 ? 'down' : '') : ''),
    esc: (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
    $: (id) => document.getElementById(id),
    safeUrl(u) {
      try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; }
    },
    set(id, text, cls) {
      const el = document.getElementById(id);
      if (!el) return;
      if (el.textContent !== text) el.textContent = text;
      if (cls !== undefined) el.className = cls;
    },
    async api(path, { method = 'GET', body } = {}) {
      const res = await fetch(path, {
        method, headers: { 'Content-Type': 'application/json', 'X-Terminal-Client': '1' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      let data = null;
      try { data = await res.json(); } catch { data = null; }
      // session expired / signed out elsewhere: back to the login page (the engine keeps running)
      if (res.status === 401 && !/^\/api\/auth\//.test(path)) { location.replace('/login'); throw new Error('Login required'); }
      if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
      return data;
    },
    toast(msg, kind = '') {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.className = `toast ${kind}`;
      clearTimeout(U._tt);
      U._tt = setTimeout(() => t.classList.add('hidden'), kind === 'err' ? 7000 : 3500);
    },
    ago(ms) {
      if (!isNum(ms)) return '—';
      const s = Math.max(0, ms / 1000);
      if (s < 1) return `${Math.round(ms)}ms`;
      if (s < 120) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
      if (s < 7200) return `${Math.round(s / 60)}m`;
      return `${(s / 3600).toFixed(1)}h`;
    },
    /** VWAP session function shared with the server's indicator code. */
    sessionOf(tf) {
      const secs = { '1m': 60, '3m': 180, '5m': 300, '15m': 900, '30m': 1800, '1h': 3600, '1d': 86400 }[tf] || 60;
      return (t) => {
        const p = etParts(t * 1000);
        return { key: p.dateStr, include: tf !== '1d' && p.minuteOfDay < 960 && p.minuteOfDay + secs / 60 > 570 };
      };
    },
  };
  window.U = U;
})();
