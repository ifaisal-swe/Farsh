'use strict';
/**
 * Report scheduler: every 30 s checks the configured local time (reports.timezone) and queues the
 * daily / weekly (on weeklyDay) / monthly (last calendar day) report exactly once per date key.
 * Markers live in tg_state and every queued row has idem key `${reportKey}:${chatId}`, so restarts
 * never queue the same report twice.
 */
const F = require('./format');

const TICK_MS = 30 * 1000;

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  return [hh, mm];
}

function lastDayOfMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); } // m is 1-based

/** Which reports are due right now: [{ kind, key }]. Pure (for tests). */
function dueReports(reports, nowMs) {
  const r = reports || {};
  if (!r.daily && !r.weekly && !r.monthly) return [];
  const tz = F.safeTz(r.timezone || F.DEFAULT_TZ);
  const at = parseTime(r.time) || [20, 0];
  const p = F.localParts(nowMs, tz);
  if (p.hh * 60 + p.mm < at[0] * 60 + at[1]) return [];
  const out = [];
  if (r.daily) out.push({ kind: 'daily', key: `report:daily:${p.dateKey}` });
  const wd = Number.isInteger(r.weeklyDay) && r.weeklyDay >= 0 && r.weeklyDay <= 6 ? r.weeklyDay : 5;
  if (r.weekly && p.weekday === wd) out.push({ kind: 'weekly', key: `report:weekly:${p.dateKey}` });
  if (r.monthly && p.d === lastDayOfMonth(p.y, p.m)) out.push({ kind: 'monthly', key: `report:monthly:${p.dateKey}` });
  return out;
}

function createReportScheduler({ tgStore, service, getTgConfig, now, setTimeoutImpl, log, redact, enqueueReport }) {
  let running = false;
  let gen = 0;
  let timer = null;
  let busy = false;

  /** One scheduler pass; returns the report keys queued in this pass. */
  async function tick() {
    if (busy) return [];
    busy = true;
    const queued = [];
    try {
      const c = getTgConfig();
      if (!c.enabled) return queued;
      const chats = [...new Set((c.authorizedChatIds || []).map(String).filter(Boolean))];
      if (!chats.length) return queued;
      const tz = F.safeTz((c.reports && c.reports.timezone) || F.DEFAULT_TZ);
      for (const { kind, key } of dueReports(c.reports, now())) {
        if (tgStore.getState(key)) continue;
        let rep;
        try {
          rep = await service.report(kind);
        } catch (e) {
          log('warn', `telegram: report(${kind}) failed: ${redact(e && e.message)}`);
          continue;
        }
        if (!rep) continue;
        enqueueReport({ key, kind, report: rep, chats, tz });
        tgStore.setState(key, { queuedAt: now() });
        queued.push(key);
      }
    } catch (e) {
      log('warn', `telegram: report scheduler error: ${redact(e && e.message)}`);
    } finally {
      busy = false;
    }
    return queued;
  }

  function schedule(delay) {
    const my = ++gen;
    timer = setTimeoutImpl(async () => {
      if (my !== gen || !running) return;
      await tick();
      if (running && my === gen) schedule(TICK_MS);
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  return {
    start() { if (running) return; running = true; schedule(1000); },
    stop() { running = false; gen++; if (timer) { try { clearTimeout(timer); } catch { /* ignore */ } timer = null; } },
    tick,
  };
}

module.exports = { createReportScheduler, dueReports, parseTime, lastDayOfMonth, TICK_MS };
