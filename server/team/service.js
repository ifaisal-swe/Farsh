'use strict';
/**
 * The research team's desk: what needs a look, one file per stock, and the notes and reports an assistant saves. Saved
 * text is untrusted data. Nothing here trades or changes a setting. Each view is later compared with what happened.
 */
const crypto = require('node:crypto');
const { guide, templates } = require('./templates');

const DAY = 86400000;
const KEEP = 200; const NOTES = 120;
const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}(\/[A-Z]{3,4})?$/;
const VIEWS = ['POSITIVE', 'NEUTRAL', 'NEGATIVE'];
const ROLES = ['news', 'company', 'macro', 'technical', 'risk', 'bull', 'bear', 'head'];
const bad = (m) => Object.assign(new Error(m), { status: 400 });
const num = (x) => typeof x === 'number' && Number.isFinite(x);
const text = (x, max) => String(x == null ? '' : x).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, max);
const list = (x, n, max) => (Array.isArray(x) ? x : []).map((s) => text(s, max)).filter(Boolean).slice(0, n);
const sources = (x, n) => (Array.isArray(x) ? x : []).filter((s) => s && /^https:\/\/[^\s]+$/.test(String(s.url || '')) && String(s.url).length <= 500).map((s) => ({ title: text(s.title || s.url, 200), url: String(s.url) })).slice(0, n);

class TeamService {
  /** calls(): opportunity calls. research(symbol): company facts and headlines. price(symbol): number or null. */
  constructor({ store, calls, research, price, followed, hours = () => null, now = Date.now }) {
    Object.assign(this, { store, calls, research, price, followed, hours, now });
    const get = (k) => { try { const v = store.getSetting(k, []); return Array.isArray(v) ? v : []; } catch { return []; } };
    this.reports = get('team.reports'); this.notes = get('team.notes');
  }

  put() { this.store.setSetting('team.reports', this.reports); this.store.setSetting('team.notes', this.notes); }
  symbol(x) { const s = String(x || '').trim().toUpperCase(); if (!SYMBOL.test(s)) throw bad('Unknown symbol'); return s; }
  latest(s) { return this.reports.find((r) => r.symbol === s) || null; }

  needs(s) {
    const r = this.latest(s); const out = []; const px = this.price(s);
    if (!r) out.push('no report yet');
    else {
      if (this.now() - r.at > 20 * 3600000) out.push('report is old');
      if (num(px) && num(r.price) && r.price > 0 && Math.abs(px / r.price - 1) >= 0.04) out.push(`price moved ${((px / r.price - 1) * 100).toFixed(1)}% since the report`);
      const fresh = this.headlines(s).filter((n) => num(n.at) && n.at > r.at).length;
      if (fresh >= 3) out.push(`${fresh} new headlines`);
      if ((r.catalysts || []).some((c) => { const t = Date.parse(c.date); return num(t) && t >= r.at - DAY && t <= this.now(); })) out.push('a dated event has passed');
    }
    return out;
  }
  headlines(s) { const c = this.calls().find((x) => x.symbol === s); return (c && c.news) || []; }

  record() {
    const done = this.reports.filter((r) => r.result);
    const right = done.filter((r) => r.result.right).length;
    return { finished: done.length, right, rightPercent: done.length ? Math.round((right / done.length) * 100) : null, open: this.reports.length - done.length };
  }

  status() {
    this.settle();
    return { today: new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ') + ' UTC', market: this.hours(), stocks: this.followed().map((s) => { const r = this.latest(s); const px = this.price(s); return { symbol: s, price: num(px) ? px : null, needs: this.needs(s), last: r && { at: r.at, view: r.view, confidence: r.confidence, by: r.by } }; }), record: this.record(), reports: this.reports.slice(0, 30), notes: this.notes.slice(0, 30) };
  }

  async file(sym) {
    const s = this.symbol(sym); const c = this.calls().find((x) => x.symbol === s) || null; const r = await this.research(s).catch(() => null); const px = this.price(s);
    return { symbol: s, price: num(px) ? px : c ? c.price : null, chart: c && { rulesView: c.raw || c.action, confidence: c.confidence, evidence: (c.evidence || []).map((e) => ({ about: e.name && e.name.en, score: e.score, says: e.text && e.text.en })), plan: c.plan || null, cautions: (c.cautions || []).map((x) => x.en), changesIf: c.change && c.change.en }, events: c ? (c.events || []).map((e) => ({ date: new Date(e.at).toISOString().slice(0, 10), what: e.label && e.label.en })) : [], company: r && r.company, headlines: (r && r.news) || [], notes: this.notes.filter((n) => n.symbol === s).slice(0, 12), reports: this.reports.filter((x) => x.symbol === s).slice(0, 5) };
  }

  list(q) { const s = q.symbol ? this.symbol(q.symbol) : null; return { reports: this.reports.filter((r) => !s || r.symbol === s).slice(0, Math.min(50, Math.max(1, Number(q.limit) || 20))), record: this.record() }; }

  rate() { const t = this.now(); this.times = (this.times || []).filter((x) => t - x < 3600000); if (this.times.length >= 120) throw Object.assign(new Error('Too many saved items this hour'), { status: 429 }); this.times.push(t); }

  saveNote(b) {
    const s = this.symbol(b && b.symbol); const body = text(b.text, 3000);
    if (!ROLES.includes(b.role)) throw bad('Unknown role'); if (!body) throw bad('Write the note'); this.rate();
    const n = { id: crypto.randomUUID(), symbol: s, role: b.role, text: body, sources: sources(b.sources, 10), at: this.now() };
    this.notes = [n, ...this.notes].slice(0, NOTES); this.put();
    return { saved: true, id: n.id };
  }

  saveReport(b) {
    const s = this.symbol(b && b.symbol); const c = Number(b.confidence); const h = Math.round(Number(b.horizonDays));
    if (!VIEWS.includes(b.view)) throw bad('Unknown view'); if (!(c >= 0 && c <= 100)) throw bad('Confidence is 0 to 100'); if (!(h >= 1 && h <= 60)) throw bad('The horizon is 1 to 60 days');
    const summaryAr = text(b.summaryAr, 2500); const drivers = list(b.drivers, 8, 400); const risks = list(b.risks, 8, 400); const src = sources(b.sources, 20);
    if (!summaryAr) throw bad('Write the summary in Arabic'); if (!drivers.length || !risks.length) throw bad('Give at least one driver and one risk'); if (!src.length) throw bad('Give at least one https source');
    this.rate(); const px = this.price(s);
    const r = { id: crypto.randomUUID(), symbol: s, view: b.view, confidence: Math.round(c), horizonDays: h, summaryAr, summaryEn: text(b.summaryEn, 2500), drivers, risks, wouldChange: list(b.wouldChange, 6, 400), catalysts: (Array.isArray(b.catalysts) ? b.catalysts : []).filter((x) => x && /^\d{4}-\d{2}-\d{2}/.test(String(x.date || ''))).map((x) => ({ date: String(x.date).slice(0, 10), what: text(x.what, 300) })).slice(0, 8), sources: src, by: text(b.by, 60) || 'assistant', price: num(px) ? px : null, at: this.now(), result: null };
    this.reports = [r, ...this.reports].slice(0, KEEP); this.put();
    return { saved: true, id: r.id, priceAtReport: r.price };
  }

  /** Compares finished views with the price afterwards. */
  settle() {
    let changed = false;
    for (const r of this.reports) {
      if (r.result || !num(r.price) || !(r.price > 0) || this.now() < r.at + r.horizonDays * DAY) continue;
      const px = this.price(r.symbol); if (!num(px)) continue;
      const move = px / r.price - 1;
      r.result = { at: this.now(), price: px, move: Math.round(move * 10000) / 10000, right: r.view === 'POSITIVE' ? move > 0 : r.view === 'NEGATIVE' ? move < 0 : Math.abs(move) < 0.03 };
      changed = true;
    }
    if (changed) { try { this.put(); } catch { /* tried again later */ } }
  }

  guide() { return guide(); }
  templates(base) { return templates(base); }
}

module.exports = { TeamService, ROLES };
