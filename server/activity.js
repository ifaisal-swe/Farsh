'use strict';
/**
 * AI LIVE ACTIVITY: every event is produced by a real application operation and carries
 * timestamp, category, status, message, details and the data source. Persisted + broadcast.
 */
const { EventEmitter } = require('node:events');

const CATEGORIES = ['SYSTEM', 'MARKET', 'ANALYSIS', 'AI', 'NEWS', 'BUY_PROPOSAL', 'SELL_PROPOSAL', 'RISK', 'EXECUTION', 'PORTFOLIO', 'WARNING', 'ERROR'];

class ActivityLog extends EventEmitter {
  constructor({ store, redactor, getSessionId = () => null, ring = 800, echo = false }) {
    super();
    this.store = store;
    this.redactor = redactor;
    this.getSessionId = getSessionId;
    this.buffer = [];
    this.ring = ring;
    this.echo = echo;
    this.seq = 0;
  }

  log(category, message, { status = 'info', details = null, source = null, ts = Date.now() } = {}) {
    const cat = CATEGORIES.includes(category) ? category : 'SYSTEM';
    const red = this.redactor;
    const evt = {
      id: null, seq: ++this.seq, ts, category: cat, status,
      message: red ? red.redactString(message) : message,
      details: red ? red.redact(details) : details,
      source, sessionId: this.getSessionId(),
    };
    try { if (this.store) evt.id = this.store.insertActivity(evt); } catch (e) {
      evt.details = { ...(evt.details || {}), persistError: e.message };
    }
    this.buffer.push(evt);
    if (this.buffer.length > this.ring) this.buffer.splice(0, this.buffer.length - this.ring);
    if (this.echo) console.log(`[${new Date(ts).toISOString()}] ${cat.padEnd(13)} ${status.padEnd(7)} ${evt.message}`);
    this.emit('event', evt);
    return evt;
  }

  info(cat, msg, o) { return this.log(cat, msg, { ...o, status: (o && o.status) || 'info' }); }
  ok(cat, msg, o) { return this.log(cat, msg, { ...o, status: 'ok' }); }
  warn(msg, o) { return this.log('WARNING', msg, { ...o, status: 'warn' }); }
  error(msg, o) { return this.log('ERROR', msg, { ...o, status: 'error' }); }
  recent(n = 300) { return this.buffer.slice(-n); }
}

module.exports = { ActivityLog, CATEGORIES };
