'use strict';
/**
 * Persistence on PostgreSQL: one schema per terminal (db-postgres.js).
 * Stores sessions (with portfolio/risk/order state), fills, AI decisions, market snapshots,
 * news references, the activity log, the equity curve, AI usage, settings and encrypted credentials.
 */
const { PostgresSync } = require('./db-postgres');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS credentials (name TEXT PRIMARY KEY, iv TEXT NOT NULL, tag TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, symbol TEXT NOT NULL, data_mode TEXT NOT NULL DEFAULT 'LIVE',
  initial_capital REAL NOT NULL, target_capital REAL, started_at INTEGER NOT NULL, ended_at INTEGER,
  ai_state TEXT NOT NULL DEFAULT 'IDLE', portfolio_json TEXT, orders_json TEXT, risk_json TEXT, benchmark_json TEXT,
  meta_json TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY, session_id INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, qty REAL NOT NULL,
  price REAL NOT NULL, fees REAL NOT NULL, ts INTEGER NOT NULL, order_type TEXT, status TEXT, reason TEXT,
  strategy TEXT, decision_id TEXT, realized_pnl REAL, json TEXT
);
CREATE INDEX IF NOT EXISTS idx_fills_session ON fills(session_id, ts);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY, session_id INTEGER, snapshot_id TEXT, ts INTEGER NOT NULL, symbol TEXT, action TEXT,
  confidence REAL, strategy TEXT, status TEXT, model TEXT, latency_ms INTEGER, proposal_json TEXT, risk_json TEXT,
  execution_json TEXT, audit_json TEXT, usage_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id, ts);
CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, session_id INTEGER, ts INTEGER NOT NULL, symbol TEXT, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS news (
  id TEXT PRIMARY KEY, symbol TEXT, source TEXT, source_type TEXT, title TEXT, url TEXT, published_at INTEGER,
  retrieved_at INTEGER, official INTEGER, relevance REAL, impact TEXT, sentiment TEXT, duplicate_of TEXT, json TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_symbol ON news(symbol, published_at);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER, ts INTEGER NOT NULL, category TEXT NOT NULL,
  status TEXT NOT NULL, message TEXT NOT NULL, source TEXT, details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_session ON activity(session_id, id);
CREATE TABLE IF NOT EXISTS equity_curve (
  session_id INTEGER NOT NULL, ts INTEGER NOT NULL, equity REAL NOT NULL, cash REAL, position_value REAL, benchmark REAL
);
CREATE INDEX IF NOT EXISTS idx_equity_session ON equity_curve(session_id, ts);
CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, model TEXT, purpose TEXT, ok INTEGER,
  prompt_tokens INTEGER, completion_tokens INTEGER, cache_hit INTEGER, cache_miss INTEGER, reasoning_tokens INTEGER,
  cost_usd REAL, latency_ms INTEGER, error TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_day ON ai_usage(day);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY, session_id INTEGER, symbol TEXT NOT NULL, side TEXT NOT NULL, type TEXT, qty REAL, limit_price REAL,
  status TEXT NOT NULL, filled_qty REAL NOT NULL DEFAULT 0, avg_fill_price REAL, source TEXT, reason TEXT, reject_reason TEXT,
  decision_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, json TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_session ON orders(session_id, created_at);
CREATE TABLE IF NOT EXISTS watchlist (
  symbol TEXT NOT NULL, data_mode TEXT NOT NULL DEFAULT 'LIVE', status TEXT NOT NULL DEFAULT 'ACTIVE',
  added_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, removed_at INTEGER, PRIMARY KEY (symbol, data_mode)
);
CREATE TABLE IF NOT EXISTS ai_cache (
  symbol TEXT NOT NULL, data_mode TEXT NOT NULL DEFAULT 'LIVE', updated_at INTEGER NOT NULL, decision_id TEXT, state_hash TEXT,
  snapshot_id TEXT, next_review_at INTEGER, processed_news TEXT, json TEXT, PRIMARY KEY (symbol, data_mode)
);
CREATE TABLE IF NOT EXISTS ai_avoided (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, symbol TEXT, reason TEXT);
CREATE INDEX IF NOT EXISTS idx_avoided_day ON ai_avoided(day);
CREATE TABLE IF NOT EXISTS app_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, ts INTEGER NOT NULL, type TEXT NOT NULL, symbol TEXT, priority TEXT, data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_app_events_ts ON app_events(ts);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, ip TEXT, user_agent TEXT
);
`;

/** Schema version stored in table schema_version. Each step is idempotent and runs inside a transaction. */
const SCHEMA_VERSION = 3;
const MIGRATIONS = {
  // one live entry order per decision (skipped when an old database already contains duplicates)
  3: (db) => {
    const live = "side = 'BUY' AND decision_id IS NOT NULL AND status IN ('PENDING','PARTIALLY_FILLED','FILLED') AND id NOT LIKE 'ord_m_%'";
    if (db.prepare(`SELECT 1 FROM orders WHERE ${live} GROUP BY decision_id HAVING COUNT(*) > 1 LIMIT 1`).get()) return;
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_live_entry ON orders(decision_id) WHERE ${live}`);
  },
  // v2: per-provider AI usage (DeepSeek / Gemini), provider recorded on decisions
  2: (db, hasColumn) => {
    if (!hasColumn('ai_usage', 'provider')) db.exec('ALTER TABLE ai_usage ADD COLUMN provider TEXT');
    db.exec(`UPDATE ai_usage SET provider = CASE WHEN lower(model) LIKE 'gemini%' THEN 'gemini' WHEN lower(model) LIKE 'deepseek%' THEN 'deepseek' ELSE NULL END WHERE provider IS NULL`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_usage_provider_day ON ai_usage(provider, day)');
    if (!hasColumn('decisions', 'provider')) db.exec('ALTER TABLE decisions ADD COLUMN provider TEXT');
  },
};

const j = (x) => (x == null ? null : JSON.stringify(x));
const pj = (s) => { if (s == null) return null; try { return JSON.parse(s); } catch { return null; } };

class Store {
  /** o: { url, schema, createSchema?, dropOnClose?, onFatal?, timeoutMs? } */
  constructor(o) {
    if (!o || !o.url) throw Object.assign(new Error('DATABASE_URL must be set (PostgreSQL)'), { code: 'CONFIG' });
    this.db = new PostgresSync(o.url, o);
    this.s = {};
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_version (v INTEGER NOT NULL)');
    const row = this.db.prepare('SELECT v FROM schema_version').get();
    const from = row ? row.v : 0;
    if (!row) this.db.prepare('INSERT INTO schema_version(v) VALUES (?)').run(0);
    this.migration = { from, to: SCHEMA_VERSION, applied: [] };
    if (from > SCHEMA_VERSION) throw new Error(`Database schema v${from} is newer than this program (v${SCHEMA_VERSION})`);
    this.transaction(() => {
      this.db.exec(SCHEMA);
      this.db.exec('ALTER TABLE fills ADD COLUMN IF NOT EXISTS rowid BIGINT GENERATED BY DEFAULT AS IDENTITY');
    });
    this.migrate(from);
  }

  /** Run fn inside one IMMEDIATE transaction (nested calls join the outer one). */
  transaction(fn) {
    if (this.txDepth) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.txDepth = 1;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    } finally { this.txDepth = 0; }
  }

  hasLiveOrderForDecision(decisionId) {
    return !!this.stmt("SELECT 1 FROM orders WHERE decision_id = ? AND status IN ('PENDING','PARTIALLY_FILLED','FILLED') LIMIT 1").get(decisionId);
  }

  hasTable(name) {
    return !!this.db.prepare('SELECT 1 AS x FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = ?').get(name);
  }
  hasColumn(table, col) {
    return !!this.db.prepare('SELECT 1 AS x FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ? AND column_name = ?').get(table, col);
  }

  migrate(from) {
    for (let v = from + 1; v <= SCHEMA_VERSION; v++) {
      const step = MIGRATIONS[v];
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (step) step(this.db, (t, c) => this.hasColumn(t, c));
        this.db.prepare('UPDATE schema_version SET v = ?').run(v);
        this.db.exec('COMMIT');
        this.migration.applied.push(v);
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch { /* ignore */ }
        throw new Error(`Database migration to v${v} failed (database left at v${v - 1}): ${e.message}`);
      }
    }
  }

  /** ['ok'] when the data can be read; the server verifies its own pages (checksums). */
  quickCheck() {
    this.db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
    return ['ok'];
  }

  counts() {
    const out = {};
    for (const t of ['sessions', 'fills', 'orders', 'decisions', 'watchlist', 'ai_usage', 'news', 'activity', 'equity_curve', 'snapshots', 'app_events']) {
      out[t] = this.hasTable(t) ? this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n : null;
    }
    return out;
  }

  sizeBytes() {
    const r = this.db.prepare("SELECT COALESCE(SUM(pg_total_relation_size(c.oid)), 0) AS n FROM pg_class c WHERE c.relnamespace = current_schema()::regnamespace AND c.relkind = 'r'").get();
    return { total: Number(r.n) };
  }

  stmt(sql) {
    if (!this.s[sql]) this.s[sql] = this.db.prepare(sql);
    return this.s[sql];
  }

  close() { try { this.db.close(); } catch { /* ignore */ } }

  // settings
  getSetting(key, fallback = null) {
    const r = this.stmt('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? pj(r.value) : fallback;
  }
  setSetting(key, value) {
    this.stmt('INSERT INTO settings(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, JSON.stringify(value), Date.now());
  }

  // credentials (already encrypted by SecretStore)
  setCredential(name, { iv, tag, data }) {
    this.stmt('INSERT INTO credentials(name, iv, tag, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(name) DO UPDATE SET iv=excluded.iv, tag=excluded.tag, data=excluded.data, updated_at=excluded.updated_at')
      .run(name, iv, tag, data, Date.now());
  }
  getCredential(name) { return this.stmt('SELECT iv, tag, data, updated_at FROM credentials WHERE name = ?').get(name) || null; }
  deleteCredential(name) { this.stmt('DELETE FROM credentials WHERE name = ?').run(name); }

  // sessions
  createSession({ symbol, dataMode = 'LIVE', initialCapital, targetCapital, meta = {} }) {
    const now = Date.now();
    const r = this.stmt('INSERT INTO sessions(symbol, data_mode, initial_capital, target_capital, started_at, ai_state, meta_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(symbol, dataMode, initialCapital, targetCapital ?? null, now, 'IDLE', j(meta), now);
    return Number(r.lastInsertRowid);
  }
  getSession(id) { return this.rowToSession(this.stmt('SELECT * FROM sessions WHERE id = ?').get(id)); }
  getActiveSession() { return this.rowToSession(this.stmt('SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1').get()); }
  rowToSession(r) {
    if (!r) return null;
    return {
      id: r.id, symbol: r.symbol, dataMode: r.data_mode, initialCapital: r.initial_capital, targetCapital: r.target_capital,
      startedAt: r.started_at, endedAt: r.ended_at, aiState: r.ai_state, portfolio: pj(r.portfolio_json), orders: pj(r.orders_json),
      risk: pj(r.risk_json), benchmark: pj(r.benchmark_json), meta: pj(r.meta_json) || {}, updatedAt: r.updated_at,
    };
  }
  saveSessionState(id, { aiState, portfolio, orders, risk, benchmark, symbol, meta }) {
    this.stmt(`UPDATE sessions SET ai_state = COALESCE(?, ai_state), portfolio_json = COALESCE(?, portfolio_json), orders_json = COALESCE(?, orders_json),
      risk_json = COALESCE(?, risk_json), benchmark_json = COALESCE(?, benchmark_json), symbol = COALESCE(?, symbol), meta_json = COALESCE(?, meta_json), updated_at = ? WHERE id = ?`)
      .run(aiState ?? null, j(portfolio), j(orders), j(risk), j(benchmark), symbol ?? null, j(meta), Date.now(), id);
  }
  endSession(id) { this.stmt('UPDATE sessions SET ended_at = ?, ai_state = ?, updated_at = ? WHERE id = ?').run(Date.now(), 'ENDED', Date.now(), id); }

  // fills
  insertFill(f) {
    this.stmt('INSERT INTO fills(id, session_id, symbol, side, qty, price, fees, ts, order_type, status, reason, strategy, decision_id, realized_pnl, json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(f.id, f.sessionId, f.symbol, f.side, f.qty, f.price, f.fees, f.ts, f.orderType || null, f.status || null, f.reason || null,
        f.strategy || null, f.decisionId || null, f.realizedPnl ?? null, j(f));
  }
  listFills(sessionId) { return this.stmt('SELECT json FROM fills WHERE session_id = ? ORDER BY ts ASC, rowid ASC').all(sessionId).map((r) => pj(r.json)); }

  // decisions
  insertDecision(d) {
    this.stmt('INSERT INTO decisions(id, session_id, snapshot_id, ts, symbol, action, confidence, strategy, status, model, latency_ms, proposal_json, risk_json, execution_json, audit_json, usage_json, provider) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(d.id, d.sessionId ?? null, d.snapshotId ?? null, d.ts, d.symbol ?? null, d.action ?? null, d.confidence ?? null, d.strategy ?? null,
        d.status ?? null, d.model ?? null, d.latencyMs ?? null, j(d.proposal), j(d.risk), j(d.execution), j(d.audit), j(d.usage), d.provider ?? null);
  }
  updateDecision(id, { status, risk, execution, audit }) {
    this.stmt('UPDATE decisions SET status = COALESCE(?, status), risk_json = COALESCE(?, risk_json), execution_json = COALESCE(?, execution_json), audit_json = COALESCE(?, audit_json) WHERE id = ?')
      .run(status ?? null, j(risk), j(execution), j(audit), id);
  }
  rowToDecision(r) {
    if (!r) return null;
    return {
      id: r.id, sessionId: r.session_id, snapshotId: r.snapshot_id, ts: r.ts, symbol: r.symbol, action: r.action, confidence: r.confidence,
      strategy: r.strategy, status: r.status, model: r.model, provider: r.provider ?? null, latencyMs: r.latency_ms, proposal: pj(r.proposal_json), risk: pj(r.risk_json),
      execution: pj(r.execution_json), audit: pj(r.audit_json), usage: pj(r.usage_json),
    };
  }
  listDecisions(sessionId, limit = 50) { return this.stmt('SELECT * FROM decisions WHERE session_id = ? ORDER BY ts DESC LIMIT ?').all(sessionId, limit).map((r) => this.rowToDecision(r)); }
  getDecision(id) { return this.rowToDecision(this.stmt('SELECT * FROM decisions WHERE id = ?').get(id)); }

  // snapshots
  insertSnapshot(s) { this.stmt('INSERT OR REPLACE INTO snapshots(id, session_id, ts, symbol, json) VALUES (?,?,?,?,?)').run(s.id, s.sessionId ?? null, s.createdAt, s.symbol, JSON.stringify(s)); }
  getSnapshot(id) { const r = this.stmt('SELECT json FROM snapshots WHERE id = ?').get(id); return r ? pj(r.json) : null; }

  // news
  upsertNews(n) {
    this.stmt(`INSERT INTO news(id, symbol, source, source_type, title, url, published_at, retrieved_at, official, relevance, impact, sentiment, duplicate_of, json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET sentiment = excluded.sentiment, json = excluded.json`)
      .run(n.id, n.symbol, n.source, n.sourceType, n.title, n.url ?? null, n.publishedAt ?? null, n.retrievedAt, n.officialConfirmed ? 1 : 0,
        n.relevance ?? null, n.marketImpact ?? null, n.sentiment ?? null, n.duplicateOf ?? null, JSON.stringify(n));
  }
  hasNews(id) { return !!this.stmt('SELECT 1 FROM news WHERE id = ?').get(id); }
  listNews(symbol, limit = 60) {
    return this.stmt("SELECT json FROM news WHERE symbol = ? OR symbol = '*MACRO*' ORDER BY COALESCE(published_at, retrieved_at) DESC LIMIT ?").all(symbol, limit).map((r) => pj(r.json));
  }

  // activity
  insertActivity(e) {
    const r = this.stmt('INSERT INTO activity(session_id, ts, category, status, message, source, details_json) VALUES (?,?,?,?,?,?,?)')
      .run(e.sessionId ?? null, e.ts, e.category, e.status, e.message, e.source ?? null, j(e.details));
    return Number(r.lastInsertRowid);
  }
  listActivity(sessionId, limit = 300) {
    const rows = sessionId == null
      ? this.stmt('SELECT * FROM activity ORDER BY id DESC LIMIT ?').all(limit)
      : this.stmt('SELECT * FROM activity WHERE session_id = ? OR session_id IS NULL ORDER BY id DESC LIMIT ?').all(sessionId, limit);
    return rows.reverse().map((r) => ({ id: r.id, sessionId: r.session_id, ts: r.ts, category: r.category, status: r.status, message: r.message, source: r.source, details: pj(r.details_json) }));
  }

  // application events (fills, orders, decisions, risk, data…): lets a reconnecting dashboard catch up by sequence number
  insertAppEvent(e) {
    const r = this.stmt('INSERT OR IGNORE INTO app_events(id, ts, type, symbol, priority, data_json) VALUES (?,?,?,?,?,?)')
      .run(String(e.id), e.ts, e.type, e.symbol ?? null, e.priority ?? null, j(e.data));
    if (!r.changes) return null;
    return Number(r.lastInsertRowid);
  }
  listAppEvents({ afterSeq = 0, limit = 200 } = {}) {
    return this.stmt('SELECT * FROM app_events WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterSeq, limit)
      .map((r) => ({ seq: r.seq, id: r.id, ts: r.ts, type: r.type, symbol: r.symbol, priority: r.priority, data: pj(r.data_json) }));
  }
  latestEventSeq() { const r = this.stmt('SELECT MAX(seq) AS m FROM app_events').get(); return r && r.m ? r.m : 0; }

  // dashboard login sessions (only a SHA-256 of the token is stored)
  insertAuthSession(s) { this.stmt('INSERT INTO auth_sessions(token_hash, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?,?,?,?,?,?)').run(s.tokenHash, s.createdAt, s.lastSeenAt, s.expiresAt, s.ip ?? null, s.userAgent ?? null); }
  getAuthSession(tokenHash) { const r = this.stmt('SELECT * FROM auth_sessions WHERE token_hash = ?').get(tokenHash); return r ? { tokenHash: r.token_hash, createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at, ip: r.ip, userAgent: r.user_agent } : null; }
  touchAuthSession(tokenHash, at) { this.stmt('UPDATE auth_sessions SET last_seen_at = ? WHERE token_hash = ?').run(at, tokenHash); }
  deleteAuthSession(tokenHash) { this.stmt('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash); }
  deleteAllAuthSessions() { return this.stmt('DELETE FROM auth_sessions').run().changes; }
  purgeAuthSessions(now, idleMs) { return this.stmt('DELETE FROM auth_sessions WHERE expires_at < ? OR last_seen_at < ?').run(now, now - idleMs).changes; }

  /** Retention for high-volume, non-accounting tables. Fills, orders, decisions and sessions are never pruned. */
  prune({ activityBefore, eventsBefore, snapshotsBefore }) {
    const out = { activity: 0, events: 0, snapshots: 0 };
    if (activityBefore) out.activity = this.stmt('DELETE FROM activity WHERE ts < ?').run(activityBefore).changes;
    if (eventsBefore) out.events = this.stmt('DELETE FROM app_events WHERE ts < ?').run(eventsBefore).changes;
    if (snapshotsBefore) {
      // keep the market snapshot behind every decision that produced an order (audit trail of real paper trades)
      out.snapshots = this.stmt(`DELETE FROM snapshots WHERE ts < ? AND id NOT IN (
        SELECT snapshot_id FROM decisions WHERE snapshot_id IS NOT NULL AND id IN (SELECT decision_id FROM orders WHERE decision_id IS NOT NULL))`).run(snapshotsBefore).changes;
    }
    return out;
  }

  // equity curve
  insertEquity(sessionId, p) { this.stmt('INSERT INTO equity_curve(session_id, ts, equity, cash, position_value, benchmark) VALUES (?,?,?,?,?,?)').run(sessionId, p.ts, p.equity, p.cash ?? null, p.positionValue ?? null, p.benchmark ?? null); }
  listEquity(sessionId, limit = 5000) {
    return this.stmt('SELECT ts, equity, cash, position_value AS positionValue, benchmark FROM equity_curve WHERE session_id = ? ORDER BY ts ASC LIMIT ?').all(sessionId, limit).map((r) => ({ ...r }));
  }

  // AI usage
  insertUsage(u) {
    this.stmt('INSERT INTO ai_usage(ts, day, model, purpose, ok, prompt_tokens, completion_tokens, cache_hit, cache_miss, reasoning_tokens, cost_usd, latency_ms, error, provider) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(u.ts, u.day, u.model ?? null, u.purpose ?? null, u.ok ? 1 : 0, u.promptTokens || 0, u.completionTokens || 0, u.cacheHit || 0, u.cacheMiss || 0,
        u.reasoningTokens || 0, u.costUsd || 0, u.latencyMs || 0, u.error ?? null, u.provider ?? null);
  }
  /** Totals for one ET day; `provider` ('deepseek' | 'gemini') narrows to one AI provider. */
  usageForDay(day, provider = null) {
    const where = provider ? 'day = ? AND provider = ?' : 'day = ?';
    return this.stmt(`SELECT COUNT(*) AS requests, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS errors, COALESCE(SUM(prompt_tokens),0) AS promptTokens, COALESCE(SUM(completion_tokens),0) AS completionTokens,
      COALESCE(SUM(cache_hit),0) AS cacheHit, COALESCE(SUM(cache_miss),0) AS cacheMiss, COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
      COALESCE(SUM(cost_usd),0) AS costUsd, COALESCE(AVG(CASE WHEN ok = 1 THEN latency_ms END),0) AS avgLatencyMs FROM ai_usage WHERE ${where}`).get(...(provider ? [day, provider] : [day]));
  }
  /** Application-level reliability of one provider over its last `n` requests (not a provider SLA). */
  providerStats(provider, n = 50) {
    const rows = this.stmt('SELECT ok, latency_ms, ts, error FROM ai_usage WHERE provider = ? AND purpose = ? ORDER BY id DESC LIMIT ?').all(provider, 'decision', n);
    const ok = rows.filter((r) => r.ok === 1);
    const lastOk = this.stmt('SELECT ts FROM ai_usage WHERE provider = ? AND ok = 1 ORDER BY id DESC LIMIT 1').get(provider);
    const lastErr = this.stmt('SELECT ts, error FROM ai_usage WHERE provider = ? AND ok = 0 ORDER BY id DESC LIMIT 1').get(provider);
    return {
      samples: rows.length, successRate: rows.length ? ok.length / rows.length : null,
      avgLatencyMs: ok.length ? Math.round(ok.reduce((a, r) => a + (r.latency_ms || 0), 0) / ok.length) : null,
      lastSuccessAt: lastOk ? lastOk.ts : null, lastErrorAt: lastErr ? lastErr.ts : null, lastError: lastErr ? lastErr.error : null,
    };
  }
  lastUsage() { return this.stmt('SELECT * FROM ai_usage ORDER BY id DESC LIMIT 1').get() || null; }
  usageBetween(fromDay, toDay, provider = null) {
    const where = provider ? 'day >= ? AND day <= ? AND provider = ?' : 'day >= ? AND day <= ?';
    return this.stmt(`SELECT COUNT(*) AS requests, COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS errors, COALESCE(SUM(prompt_tokens),0) AS promptTokens,
      COALESCE(SUM(completion_tokens),0) AS completionTokens, COALESCE(SUM(cost_usd),0) AS costUsd FROM ai_usage WHERE ${where}`).get(...(provider ? [fromDay, toDay, provider] : [fromDay, toDay]));
  }
  recentUsageErrors(limit = 5) { return this.stmt('SELECT ts, model, purpose, error FROM ai_usage WHERE ok = 0 ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({ ...r })); }

  // AI requests avoided by the cache / limits (not API calls; never counted as usage)
  insertAvoided({ ts, day, symbol, reason }) { this.stmt('INSERT INTO ai_avoided(ts, day, symbol, reason) VALUES (?,?,?,?)').run(ts, day, symbol ?? null, reason ?? null); }
  avoidedBetween(fromDay, toDay) { return this.stmt('SELECT COUNT(*) AS n FROM ai_avoided WHERE day >= ? AND day <= ?').get(fromDay, toDay).n; }

  // AI analysis cache (one row per symbol and data mode)
  getAiCache(symbol, dataMode = 'LIVE') {
    const r = this.stmt('SELECT * FROM ai_cache WHERE symbol = ? AND data_mode = ?').get(symbol, dataMode);
    return r ? { symbol: r.symbol, dataMode: r.data_mode, updatedAt: r.updated_at, decisionId: r.decision_id, stateHash: r.state_hash, snapshotId: r.snapshot_id, nextReviewAt: r.next_review_at, processedNews: pj(r.processed_news) || [], data: pj(r.json) } : null;
  }
  setAiCache(c) {
    this.stmt(`INSERT INTO ai_cache(symbol, data_mode, updated_at, decision_id, state_hash, snapshot_id, next_review_at, processed_news, json) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(symbol, data_mode) DO UPDATE SET updated_at=excluded.updated_at, decision_id=excluded.decision_id, state_hash=excluded.state_hash, snapshot_id=excluded.snapshot_id,
      next_review_at=excluded.next_review_at, processed_news=excluded.processed_news, json=excluded.json`)
      .run(c.symbol, c.dataMode || 'LIVE', c.updatedAt, c.decisionId ?? null, c.stateHash ?? null, c.snapshotId ?? null, c.nextReviewAt ?? null, j(c.processedNews || []), j(c.data || null));
  }

  // orders (an order may have several fills; an order that never filled is not a trade)
  insertOrder(o) {
    this.stmt(`INSERT INTO orders(id, session_id, symbol, side, type, qty, limit_price, status, filled_qty, avg_fill_price, source, reason, reject_reason, decision_id, created_at, updated_at, json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(o.id, o.sessionId ?? null, o.symbol, o.side, o.type ?? null, o.qty ?? null, o.limitPrice ?? null, o.status, o.filledQty || 0, o.avgFillPrice ?? null,
        o.source ?? null, o.reason ?? null, o.rejectReason ?? null, o.decisionId ?? null, o.createdAt, o.updatedAt || o.createdAt, j(o.extra || null));
  }
  updateOrder(id, { status, filledQty, avgFillPrice, rejectReason, qty, updatedAt = Date.now() }) {
    this.stmt(`UPDATE orders SET status = COALESCE(?, status), filled_qty = COALESCE(?, filled_qty), avg_fill_price = COALESCE(?, avg_fill_price),
      reject_reason = COALESCE(?, reject_reason), qty = COALESCE(?, qty), updated_at = ? WHERE id = ?`)
      .run(status ?? null, filledQty ?? null, avgFillPrice ?? null, rejectReason ?? null, qty ?? null, updatedAt, id);
  }
  rowToOrder(r) {
    return r ? {
      id: r.id, sessionId: r.session_id, symbol: r.symbol, side: r.side, type: r.type, qty: r.qty, limitPrice: r.limit_price, status: r.status, filledQty: r.filled_qty,
      avgFillPrice: r.avg_fill_price, source: r.source, reason: r.reason, rejectReason: r.reject_reason, decisionId: r.decision_id, createdAt: r.created_at, updatedAt: r.updated_at, extra: pj(r.json),
    } : null;
  }
  getOrder(id) { return this.rowToOrder(this.stmt('SELECT * FROM orders WHERE id = ?').get(id)); }
  listOrders(sessionId) { return this.stmt('SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC').all(sessionId).map((r) => this.rowToOrder(r)); }
  /** Older fills (before the orders table existed) get one FILLED order each, so every execution belongs to an order. */
  migrateFillsToOrders() {
    const fills = this.stmt("SELECT json FROM fills WHERE json NOT LIKE '%\"orderId\"%'").all().map((r) => pj(r.json)).filter(Boolean);
    let n = 0;
    for (const f of fills) {
      const id = `ord_m_${f.id}`;
      if (!this.getOrder(id)) {
        this.insertOrder({ id, sessionId: f.sessionId, symbol: f.symbol, side: f.side, type: f.orderType || 'MARKET', qty: f.requestedQty || f.qty, limitPrice: null, status: 'FILLED', filledQty: f.qty, avgFillPrice: f.price, source: f.kind || 'AI', reason: f.reason, decisionId: f.decisionId, createdAt: f.ts, updatedAt: f.ts, extra: { migrated: true } });
        n++;
      }
      f.orderId = id;
      this.stmt('UPDATE fills SET json = ? WHERE id = ?').run(JSON.stringify(f), f.id);
    }
    return n;
  }

  // watchlist (monitored symbols; removing a symbol never touches its trades or positions)
  listWatchlist(dataMode = 'LIVE') { return this.stmt('SELECT * FROM watchlist WHERE data_mode = ? AND removed_at IS NULL ORDER BY added_at').all(dataMode).map((r) => ({ symbol: r.symbol, dataMode: r.data_mode, status: r.status, addedAt: r.added_at, updatedAt: r.updated_at })); }
  upsertWatch(symbol, dataMode = 'LIVE', status = 'ACTIVE', ts = Date.now()) {
    this.stmt(`INSERT INTO watchlist(symbol, data_mode, status, added_at, updated_at, removed_at) VALUES (?,?,?,?,?,NULL)
      ON CONFLICT(symbol, data_mode) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at, removed_at = NULL`).run(symbol, dataMode, status, ts, ts);
  }
  removeWatch(symbol, dataMode = 'LIVE', ts = Date.now()) { this.stmt('UPDATE watchlist SET removed_at = ?, updated_at = ? WHERE symbol = ? AND data_mode = ?').run(ts, ts, symbol, dataMode); }

  // equity snapshots around a period boundary (for period returns)
  equityAtOrBefore(sessionId, ts) { return this.stmt('SELECT ts, equity FROM equity_curve WHERE session_id = ? AND ts <= ? ORDER BY ts DESC LIMIT 1').get(sessionId, ts) || null; }
  equityFirstAfter(sessionId, ts) { return this.stmt('SELECT ts, equity FROM equity_curve WHERE session_id = ? AND ts >= ? ORDER BY ts ASC LIMIT 1').get(sessionId, ts) || null; }
  equityBetween(sessionId, from, to) { return this.stmt('SELECT ts, equity FROM equity_curve WHERE session_id = ? AND ts >= ? AND ts <= ? ORDER BY ts ASC').all(sessionId, from, to).map((r) => ({ ...r })); }
  decisionsBetween(sessionId, from, to) { return this.stmt('SELECT * FROM decisions WHERE session_id = ? AND ts >= ? AND ts <= ? ORDER BY ts DESC').all(sessionId, from, to).map((r) => this.rowToDecision(r)); }
  listDecisionsBySymbol(sessionId, symbol, limit = 50) { return this.stmt('SELECT * FROM decisions WHERE session_id = ? AND symbol = ? ORDER BY ts DESC LIMIT ?').all(sessionId, symbol, limit).map((r) => this.rowToDecision(r)); }
  activityBetween(sessionId, from, to, categories) {
    const rows = this.stmt('SELECT * FROM activity WHERE (session_id = ? OR session_id IS NULL) AND ts >= ? AND ts <= ? ORDER BY id DESC LIMIT 2000').all(sessionId, from, to);
    return rows.filter((r) => !categories || categories.includes(r.category)).map((r) => ({ ts: r.ts, category: r.category, status: r.status, message: r.message, source: r.source }));
  }
}

module.exports = { SCHEMA_VERSION, Store };
