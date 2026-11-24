'use strict';
/**
 * Try the platform without an account. Each visitor gets a separate temporary terminal with invented prices: no
 * service keys, no outside calls, no model, its own process and folder, erased when it ends. Nothing here can reach an
 * account. The number of running demos and the starts per address are limited.
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Supervisor } = require('./supervisor');

const COOKIE = 'dt_demo';
const HOUR = 3600000;
const fail = (status, message) => Object.assign(new Error(message), { status });
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');

class Demos {
  constructor({ root, max = 5, perAddress = 4, idleMs = HOUR / 2, maxMs = 2 * HOUR, perMinute = 900, memoryMb = 256, supervisor = {}, onEnd = () => {}, now = Date.now }) {
    Object.assign(this, { root, max, perAddress, idleMs, maxMs, perMinute, onEnd, now });
    this.items = new Map(); // token hash -> { id, at, seen, ready, ending, minute, hits }
    this.starts = new Map(); // address -> times
    this.tenants = new Supervisor({ max, memoryMb, ...supervisor, root, options: async () => ({ demo: true }) });
    this.timer = setInterval(() => this.sweep().catch(() => {}), 30000);
    this.timer.unref();
  }

  /** Leftovers of an earlier run belong to nobody. */
  init() { if (this.max > 0) { fs.rmSync(this.root, { recursive: true, force: true }); fs.mkdirSync(this.root, { recursive: true }); } }

  find(token) {
    const x = token ? this.items.get(hash(token)) : null; const t = this.now();
    if (!x || x.ending) return null;
    if (t - x.at >= this.maxMs || t - x.seen >= this.idleMs) { this.end(x).catch(() => {}); return null; }
    return x;
  }
  endsAt(x) { return x.at + this.maxMs; }
  touch(x) {
    const t = this.now(); const m = Math.floor(t / 60000);
    if (x.minute !== m) { x.minute = m; x.hits = 0; }
    if (++x.hits > this.perMinute) throw fail(429, 'Too many requests');
    x.seen = t;
  }

  async start(ip) {
    const t = this.now();
    for (const [k, v] of this.starts) { const l = v.filter((s) => t - s < HOUR); if (l.length) this.starts.set(k, l); else this.starts.delete(k); }
    const mine = this.starts.get(ip) || [];
    if (mine.length >= this.perAddress) throw fail(429, 'Too many demos from here; try again later');
    if (this.items.size >= this.max) throw fail(503, 'All demos are in use; try again in a few minutes');
    this.starts.set(ip, [...mine, t]);
    const token = crypto.randomBytes(32).toString('hex');
    const x = { id: crypto.randomBytes(12).toString('hex'), at: t, seen: t };
    this.items.set(hash(token), x);
    try { await this.tenants.get(x.id); } catch (e) { await this.end(x); throw fail(503, 'The demo could not be started'); }
    return { token, endsAt: this.endsAt(x) };
  }

  async end(x) {
    if (x.ending) return x.ending;
    x.ending = (async () => {
      this.onEnd(x.id);
      await this.tenants.stop(x.id);
      fs.rmSync(path.join(this.root, x.id), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    })().catch((e) => console.error(`[demo] ${e.message}`)).finally(() => { for (const [k, v] of this.items) if (v === x) this.items.delete(k); });
    return x.ending;
  }

  async sweep() { const t = this.now(); await Promise.all([...this.items.values()].filter((x) => t - x.at >= this.maxMs || t - x.seen >= this.idleMs).map((x) => this.end(x))); }
  async stopAll() { clearInterval(this.timer); await Promise.all([...this.items.values()].map((x) => this.end(x))); await this.tenants.stopAll(); }
}

module.exports = { Demos, COOKIE };
