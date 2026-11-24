'use strict';
/**
 * ConditionLog — decides WHEN a recurring condition deserves an activity-log line.
 *
 * Each channel holds one current condition, identified by a STABLE key (codes, never changing
 * numbers such as ages). check() returns:
 *   { kind: 'change', prev }        the condition changed (log it; `prev` describes what it replaced)
 *   { kind: 'reminder', since }     unchanged, but `remindMs` passed since the last line (log a reminder)
 *   null                            unchanged — stay silent (the UI shows the persistent status)
 */
class ConditionLog {
  constructor({ remindMs = 5 * 60000, maxChannels = 500 } = {}) {
    this.remindMs = remindMs;
    this.maxChannels = maxChannels;
    this.channels = new Map();
  }

  check(channel, key, now, meta = null) {
    const cur = this.channels.get(channel);
    if (!cur || cur.key !== key) {
      if (this.channels.size >= this.maxChannels && !cur) this.channels.delete(this.channels.keys().next().value);
      this.channels.set(channel, { key, since: now, lastLogAt: now, meta, suppressed: 0 });
      return { kind: 'change', prev: cur ? { key: cur.key, since: cur.since, meta: cur.meta } : null };
    }
    if (this.remindMs > 0 && now - cur.lastLogAt >= this.remindMs) {
      const suppressed = cur.suppressed;
      cur.lastLogAt = now;
      cur.suppressed = 0;
      return { kind: 'reminder', since: cur.since, suppressed, meta: cur.meta };
    }
    cur.suppressed++;
    return null;
  }

  /** true when a repeating event (same channel+key) should be logged now: first time, or after remindMs. */
  shouldLog(channel, key, now) {
    return this.check(channel, key, now) !== null;
  }

  get(channel) { return this.channels.get(channel) || null; }
  reset(channel) { if (channel == null) this.channels.clear(); else this.channels.delete(channel); }
}

const fmtDuration = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, '0')}m`;
};

module.exports = { ConditionLog, fmtDuration };
