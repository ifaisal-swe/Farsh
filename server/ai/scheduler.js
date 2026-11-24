'use strict';
/**
 * Smart AI analysis scheduling. Market data never waits for the AI: triggers are queued here,
 * coalesced, de-duplicated and rate limited, and only ONE analysis runs at a time so that
 * overlapping requests can never produce conflicting trades.
 */
const { EventEmitter } = require('node:events');
const { newId } = require('../util/misc');

const TRIGGERS = {
  START: { cooldownMs: 0, priority: 2 },
  MANUAL: { cooldownMs: 10000, priority: 3 },
  CANDLE_CLOSE: { cooldownMs: 0, priority: 1 },
  INTERVAL: { cooldownMs: 0, priority: 0 },
  LEVEL_BREAK: { cooldownMs: 10 * 60000, priority: 2 },
  UNUSUAL_VOLUME: { cooldownMs: 5 * 60000, priority: 2 },
  NEWS: { cooldownMs: 5 * 60000, priority: 3 },
  RISK_CHANGE: { cooldownMs: 2 * 60000, priority: 3 },
  NEAR_STOP: { cooldownMs: 3 * 60000, priority: 3 },
  NEAR_TARGET: { cooldownMs: 3 * 60000, priority: 3 },
  STALE_PROPOSAL: { cooldownMs: 60000, priority: 2 },
  POSITION_CHANGE: { cooldownMs: 30000, priority: 2 },
  DATA_READY: { cooldownMs: 60000, priority: 2 },
  THESIS_INVALIDATED: { cooldownMs: 15 * 60000, priority: 3 },
  // adaptive monitoring (deduplicated, scored and rate limited before they get here; never above normal priority)
  SIGNAL_EVENT: { cooldownMs: 60000, priority: 2 },
  SIGNAL_CONFIRMED: { cooldownMs: 60000, priority: 2 },
};

class AnalysisScheduler extends EventEmitter {
  constructor({ run, getCfg, now = () => Date.now() }) {
    super();
    this.run = run;
    this.getCfg = getCfg;
    this.now = now;
    this.running = false;
    this.inFlight = null;
    this.pending = null;
    this.lastStartAt = 0;
    this.cooldowns = new Map();
    this.timer = null;
    this.intervalTimer = null;
    this.completed = 0;
  }

  start() {
    this.running = true;
    this.resetInterval();
  }

  resetInterval() {
    clearInterval(this.intervalTimer);
    const sec = this.getCfg().regularIntervalSec;
    this.intervalTimer = setInterval(() => this.trigger({ type: 'INTERVAL', detail: `regular ${sec}s interval` }), sec * 1000);
    if (this.intervalTimer.unref) this.intervalTimer.unref();
  }

  stop() {
    this.running = false;
    clearInterval(this.intervalTimer);
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }

  /** @returns {'queued'|'merged'|'cooldown'|'ignored'} */
  trigger({ type, detail = '', key = null, priority = null, cooldownMs = null }) {
    if (!this.running) return 'ignored';
    const def = TRIGGERS[type] || { cooldownMs: 30000, priority: 1 };
    const k = `${type}:${key || ''}`;
    const now = this.now();
    const until = this.cooldowns.get(k) || 0;
    if (until > now) return 'cooldown';
    const cd = cooldownMs != null ? cooldownMs : def.cooldownMs;
    if (cd > 0) this.cooldowns.set(k, now + cd);
    if (this.cooldowns.size > 500) for (const [ck, t] of this.cooldowns) if (t <= now) this.cooldowns.delete(ck); // 24/7 process: drop expired keys
    const reason = { type, detail, at: now };
    const prio = priority != null ? priority : def.priority;
    if (this.pending) {
      if (!this.pending.reasons.some((r) => r.type === type && r.detail === detail)) this.pending.reasons.push(reason);
      this.pending.priority = Math.max(this.pending.priority, prio);
      this.emit('merged', this.pending, reason);
      this.pump();
      return 'merged';
    }
    this.pending = { id: newId('job'), reasons: [reason], priority: prio, createdAt: now };
    this.emit('queued', this.pending);
    this.pump();
    return 'queued';
  }

  pump() {
    if (!this.running || this.inFlight || !this.pending) return;
    const cfg = this.getCfg();
    const now = this.now();
    const minGap = this.pending.priority >= 3 ? 3000 : cfg.minIntervalSec * 1000;
    const wait = this.lastStartAt + minGap - now;
    if (wait > 0) {
      if (!this.timer) {
        this.timer = setTimeout(() => { this.timer = null; this.pump(); }, wait);
        if (this.timer.unref) this.timer.unref();
        this.emit('waiting', this.pending, wait);
      }
      return;
    }
    const job = this.pending;
    this.pending = null;
    this.inFlight = job;
    const prevStart = this.lastStartAt;
    this.lastStartAt = now;
    this.emit('start', job);
    Promise.resolve()
      .then(() => this.run(job))
      .then((r) => { if (r && r.skipped) this.lastStartAt = prevStart; }) // gated jobs (no API call) don't consume the interval
      .catch((e) => this.emit('jobError', job, e))
      .finally(() => {
        this.inFlight = null;
        this.completed++;
        this.emit('done', job);
        this.pump();
      });
  }

  status() {
    return {
      running: this.running, inFlight: this.inFlight ? { id: this.inFlight.id, reasons: this.inFlight.reasons } : null,
      pending: this.pending ? { id: this.pending.id, reasons: this.pending.reasons } : null, lastStartAt: this.lastStartAt, completed: this.completed,
    };
  }
}

module.exports = { AnalysisScheduler, TRIGGERS };
