'use strict';
/**
 * Telegram persistence (own tables on the app's PostgreSQL schema).
 * - tg_notifications: persistent outbound queue (one row per (event, chat), idempotent via idem_key)
 * - tg_audit: every interactive action / denial
 * - tg_nonces: one-time confirmation tokens for sensitive actions
 * - tg_state: small key/value state (polling offset, report markers)
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tg_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, idem_key TEXT UNIQUE, priority INTEGER NOT NULL DEFAULT 1, kind TEXT,
  chat_id TEXT NOT NULL, text TEXT NOT NULL, reply_markup TEXT, status TEXT NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  sent_at INTEGER, error TEXT, symbol TEXT
);
CREATE INDEX IF NOT EXISTS idx_tg_notif_queue ON tg_notifications(status, next_attempt_at);
CREATE TABLE IF NOT EXISTS tg_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, user_id TEXT, chat_id TEXT, action TEXT NOT NULL,
  params TEXT, result TEXT
);
CREATE INDEX IF NOT EXISTS idx_tg_audit_ts ON tg_audit(ts);
CREATE TABLE IF NOT EXISTS tg_nonces (
  nonce TEXT PRIMARY KEY, user_id TEXT, chat_id TEXT, action TEXT NOT NULL, params TEXT,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, used_at INTEGER
);
CREATE TABLE IF NOT EXISTS tg_state (key TEXT PRIMARY KEY, value TEXT);
`;

/** Priority encoding: lower number = sent first. */
const PRIORITY = { high: 0, normal: 1, low: 2 };

function createTgStore(store, { redact = (s) => s } = {}) {
  if (!store || !store.db) throw new Error('telegram store requires store.db');
  const db = store.db;
  db.exec(SCHEMA);
  const cache = {};
  const st = (sql) => (cache[sql] || (cache[sql] = db.prepare(sql)));
  const pj = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };

  return {
    // ---- key/value state
    getState(key, fallback = null) {
      const r = st('SELECT value FROM tg_state WHERE key = ?').get(key);
      return r ? pj(r.value) : fallback;
    },
    setState(key, value) {
      st('INSERT INTO tg_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
    },

    // ---- audit
    audit({ ts, userId, chatId, action, params, result }) {
      const p = params == null ? null : redact(typeof params === 'string' ? params : JSON.stringify(params));
      st('INSERT INTO tg_audit(ts, user_id, chat_id, action, params, result) VALUES (?,?,?,?,?,?)')
        .run(ts, userId == null ? null : String(userId), chatId == null ? null : String(chatId), String(action),
          p, result == null ? null : redact(String(result)).slice(0, 1000));
    },
    listAudit(limit = 100) {
      return st('SELECT * FROM tg_audit ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r }));
    },

    // ---- nonces
    createNonce({ nonce, userId, chatId, action, params, now, ttlMs }) {
      st('INSERT INTO tg_nonces(nonce, user_id, chat_id, action, params, created_at, expires_at, used_at) VALUES (?,?,?,?,?,?,?,NULL)')
        .run(nonce, String(userId), String(chatId), action, JSON.stringify(params || {}), now, now + ttlMs);
    },
    getNonce(nonce) {
      const r = st('SELECT * FROM tg_nonces WHERE nonce = ?').get(nonce);
      return r ? { ...r, params: pj(r.params) || {} } : null;
    },
    /** Atomically marks a nonce used; true only for the single winning caller of an unexpired, unused nonce. */
    consumeNonce(nonce, now) {
      const r = st('UPDATE tg_nonces SET used_at = ? WHERE nonce = ? AND used_at IS NULL AND expires_at > ?').run(now, nonce, now);
      return Number(r.changes) === 1;
    },
    pruneNonces(now) {
      st('DELETE FROM tg_nonces WHERE expires_at < ?').run(now - 24 * 3600 * 1000);
    },

    // ---- notifications queue
    /** Returns the new row id, or null when the idem key already exists. */
    enqueue({ idemKey, priority, kind, chatId, text, replyMarkup, now, symbol = null, status = 'QUEUED', error = null }) {
      const r = st(`INSERT OR IGNORE INTO tg_notifications(idem_key, priority, kind, chat_id, text, reply_markup, status, attempts, next_attempt_at, created_at, sent_at, error, symbol)
        VALUES (?,?,?,?,?,?,?,0,?,?,NULL,?,?)`)
        .run(idemKey, priority, kind || null, String(chatId), text, replyMarkup ? JSON.stringify(replyMarkup) : null, status, now, now, error, symbol);
      return Number(r.changes) === 1 ? Number(r.lastInsertRowid) : null;
    },
    hasIdem(idemKey) { return !!st('SELECT 1 FROM tg_notifications WHERE idem_key = ?').get(idemKey); },
    /** Latest still-queued, never-attempted low-priority row of the same kind+symbol for a chat (for grouping). */
    findGroupable({ chatId, kind, symbol, since, priority }) {
      return st(`SELECT * FROM tg_notifications WHERE chat_id = ? AND kind = ? AND COALESCE(symbol,'') = ? AND status = 'QUEUED'
        AND attempts = 0 AND priority = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`).get(String(chatId), kind, symbol || '', priority, since) || null;
    },
    updateText(id, text) { st('UPDATE tg_notifications SET text = ? WHERE id = ?').run(text, id); },
    getNotification(id) { const r = st('SELECT * FROM tg_notifications WHERE id = ?').get(id); return r ? { ...r } : null; },
    dueNotifications(now, limit = 100) {
      return st(`SELECT * FROM tg_notifications WHERE status = 'QUEUED' AND next_attempt_at <= ? ORDER BY priority ASC, id ASC LIMIT ?`)
        .all(now, limit).map((r) => ({ ...r }));
    },
    nextAttemptAt() {
      const r = st("SELECT MIN(next_attempt_at) AS t FROM tg_notifications WHERE status = 'QUEUED'").get();
      return r && r.t != null ? Number(r.t) : null;
    },
    markSent(id, now) { st("UPDATE tg_notifications SET status = 'SENT', sent_at = ?, attempts = attempts + 1, error = NULL WHERE id = ?").run(now, id); },
    markRetry(id, nextAt, error) {
      st('UPDATE tg_notifications SET attempts = attempts + 1, next_attempt_at = ?, error = ? WHERE id = ?').run(nextAt, error ? redact(String(error)).slice(0, 500) : null, id);
    },
    /** Postpone without counting an attempt (e.g. token not configured yet). */
    defer(id, nextAt) { st('UPDATE tg_notifications SET next_attempt_at = ? WHERE id = ?').run(nextAt, id); },
    markFailed(id, error) {
      st("UPDATE tg_notifications SET status = 'FAILED', attempts = attempts + 1, error = ? WHERE id = ?").run(redact(String(error || '')).slice(0, 500), id);
    },
    counts() {
      const r = st(`SELECT SUM(CASE WHEN status = 'QUEUED' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN status = 'FAILED' THEN 1 ELSE 0 END) AS failed FROM tg_notifications`).get();
      return { queued: Number(r.queued || 0), failed: Number(r.failed || 0) };
    },
    sentSince(ts) {
      return Number(st("SELECT COUNT(*) AS n FROM tg_notifications WHERE status = 'SENT' AND sent_at >= ?").get(ts).n || 0);
    },
    listNotifications(limit = 100) {
      return st('SELECT * FROM tg_notifications ORDER BY id ASC LIMIT ?').all(limit).map((r) => ({ ...r }));
    },
  };
}

module.exports = { createTgStore, PRIORITY, SCHEMA };
