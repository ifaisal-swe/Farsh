'use strict';
/**
 * Runs one process per customer: starts on demand, restarts after a crash (with backoff), kills a process that
 * stops answering, limits its memory, and stops it gracefully. A failing customer never affects another one.
 */
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const fail = (status, message) => Object.assign(new Error(message), { status });

class Supervisor {
  constructor({ root, max = 25, memoryMb = 384, prepare = async () => null, options = async () => ({}), script = path.join(__dirname, 'tenant.js'), pingMs = 10000, misses = 3, startMs = 60000, backoffMs = 1000, log = console.error }) {
    Object.assign(this, { root, max, memoryMb, prepare, options, script, pingMs, misses, startMs, backoffMs, log });
    this.items = new Map(); // id -> { ready: Promise, child, port, token, state, fails }
    this.stopping = false;
    this.timer = setInterval(() => this.check(), pingMs);
    this.timer.unref();
  }

  get size() { return this.items.size; }
  has(id) { const x = this.items.get(id); return !!x && x.state === 'RUNNING'; }

  /** Resolves with { port, token } once the customer's terminal accepts requests. */
  get(id) {
    if (this.stopping) return Promise.reject(fail(503, 'Shutting down'));
    let x = this.items.get(id);
    if (!x) {
      if (this.items.size >= this.max) return Promise.reject(fail(503, 'The platform is at capacity'));
      x = { id, fails: 0 };
      this.items.set(id, x);
      this.launch(x);
    }
    if (x.state === 'WAITING') return Promise.reject(fail(503, 'Your terminal is restarting'));
    return x.ready;
  }

  launch(x) {
    x.state = 'STARTING';
    x.child = null;
    x.ready = (async () => {
      let postgres;
      let options;
      try { options = await this.options(x.id); postgres = await this.prepare(x.id); } catch (e) { this.later(x, e.message); throw fail(503, 'Your terminal could not be started'); }
      if (this.stopping || x.state === 'STOPPING') throw fail(503, 'Shutting down');
      return this.spawn(x, postgres, options);
    })();
    x.ready.catch(() => {});
  }

  spawn(x, postgres, options) {
    const dir = path.join(this.root, x.id);
    fs.mkdirSync(dir, { recursive: true });
    x.token = crypto.randomBytes(32).toString('hex');
    x.missed = 0;
    x.startedAt = Date.now();
    // a minimal environment: operator secrets never reach a customer process
    const env = {};
    for (const k of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TZ', 'LANG', 'NODE_ENV', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) if (process.env[k]) env[k] = process.env[k];
    const child = fork(this.script, [], { env, execArgv: ['--disable-warning=ExperimentalWarning', `--max-old-space-size=${this.memoryMb}`], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    x.child = child;
    x.exited = new Promise((r) => child.once('exit', r));
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(fail(503, 'Your terminal did not start in time')); child.kill('SIGKILL'); }, this.startMs);
      child.on('message', (m) => {
        if (m && m.type === 'pong') x.missed = 0;
        if (m && m.type === 'ready') { clearTimeout(timer); x.state = 'RUNNING'; x.port = m.port; x.missed = 0; resolve({ port: m.port, token: x.token }); }
      });
      child.once('error', (e) => { clearTimeout(timer); reject(fail(503, `Your terminal could not be started: ${e.message}`)); });
      child.once('exit', () => { clearTimeout(timer); reject(fail(503, 'Your terminal could not be started')); this.exited(x, child); });
    });
    this.send(x, { type: 'start', dataDir: dir, token: x.token, postgres, ...options });
    return ready;
  }

  /** A message for one customer's process, if it is running. */
  tell(id, m) { const x = this.items.get(id); if (x && x.state === 'RUNNING') this.send(x, m); }

  send(x, m) { try { if (x.child && x.child.connected) x.child.send(m, () => {}); } catch { /* the exit handler deals with it */ } }

  exited(x, child) {
    if (x.child !== child) return;
    this.later(x, 'stopped unexpectedly');
  }

  /** Try again after a growing delay. */
  later(x, why) {
    if (x.state === 'STOPPING' || this.stopping) return;
    x.fails = Date.now() - x.startedAt > 300000 ? 1 : x.fails + 1;
    x.state = 'WAITING';
    const delay = Math.min(60000, this.backoffMs * 2 ** Math.min(x.fails - 1, 10));
    this.log(`[gateway] terminal of ${x.id}: ${why}; restarting in ${delay} ms`);
    x.retry = setTimeout(() => { if (!this.stopping && this.items.get(x.id) === x) this.launch(x); }, delay);
  }

  check() {
    for (const x of this.items.values()) {
      if (x.state !== 'RUNNING') continue;
      if (x.missed >= this.misses) { this.log(`[gateway] terminal of ${x.id} does not answer; killing it`); x.child.kill('SIGKILL'); continue; }
      x.missed++;
      this.send(x, { type: 'ping' });
    }
  }

  async stop(id) {
    const x = this.items.get(id);
    if (!x) return;
    clearTimeout(x.retry);
    if (x.state !== 'WAITING') {
      x.state = 'STOPPING';
      if (!x.child) await x.ready.catch(() => {});
    }
    if (x.child && x.state === 'STOPPING') {
      this.send(x, { type: 'stop' });
      const kill = setTimeout(() => x.child.kill('SIGKILL'), 20000);
      await x.exited;
      clearTimeout(kill);
    }
    this.items.delete(id); // only now may the same data directory be opened again
  }

  async stopAll() {
    this.stopping = true;
    clearInterval(this.timer);
    await Promise.all([...this.items.keys()].map((id) => this.stop(id)));
  }
}

module.exports = { Supervisor };
