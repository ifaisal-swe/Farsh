'use strict';
/**
 * Time helpers. All internal timestamps are true UTC (ms or s since epoch).
 * Exchange-local (America/New_York) wall time is derived only for session logic and display.
 */
const ET_TZ = 'America/New_York';

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: ET_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});

const partsCache = new Map();
function etParts(ms) {
  const key = Math.floor(ms / 1000);
  const hit = partsCache.get(key);
  if (hit) return hit;
  const p = {};
  for (const x of dtf.formatToParts(new Date(key * 1000))) p[x.type] = x.value;
  const out = {
    year: +p.year, month: +p.month, day: +p.day, hour: (+p.hour) % 24, minute: +p.minute, second: +p.second,
    weekday: p.weekday, dateStr: `${p.year}-${p.month}-${p.day}`,
  };
  if (partsCache.size > 5000) partsCache.clear();
  partsCache.set(key, out);
  return out;
}

/** Offset (ms) such that etWall = utc + offset (negative in US, e.g. -5h / -4h). */
function etOffsetMs(ms) {
  const p = etParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Convert an ET wall-clock date + time to a UTC epoch in ms (DST-safe). */
function etWallToUtcMs(dateStr, hour = 0, minute = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  let utc = guess - etOffsetMs(guess);
  const off2 = etOffsetMs(utc);
  utc = guess - off2;
  return utc;
}

function etDateStr(ms) { return etParts(ms).dateStr; }
function etMinuteOfDay(ms) { const p = etParts(ms); return p.hour * 60 + p.minute; }
function etTimeStr(ms, withSeconds = true) {
  const p = etParts(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return withSeconds ? `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}` : `${pad(p.hour)}:${pad(p.minute)}`;
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

const TIMEFRAMES = {
  '1m': { sec: 60, alpaca: '1Min', lookbackDays: 7 },
  '3m': { sec: 180, alpaca: '3Min', lookbackDays: 12 },
  '5m': { sec: 300, alpaca: '5Min', lookbackDays: 18 },
  '15m': { sec: 900, alpaca: '15Min', lookbackDays: 45 },
  '30m': { sec: 1800, alpaca: '30Min', lookbackDays: 80 },
  '1h': { sec: 3600, alpaca: '1Hour', lookbackDays: 150 },
  '1d': { sec: 86400, alpaca: '1Day', lookbackDays: 800 },
};
const TF_KEYS = Object.keys(TIMEFRAMES);

function isValidTf(tf) { return Object.prototype.hasOwnProperty.call(TIMEFRAMES, tf); }

/** Bucket (bar open) time in UTC seconds for a timestamp in UTC seconds. */
function bucketStart(tf, tsSec) {
  if (tf === '1d') return Math.floor(etWallToUtcMs(etDateStr(tsSec * 1000), 0, 0) / 1000);
  const s = TIMEFRAMES[tf].sec;
  return Math.floor(tsSec / s) * s;
}

function parseTs(value) {
  if (value == null) return NaN;
  if (typeof value === 'number') return value;
  return Date.parse(value); // RFC-3339; sub-ms digits are truncated by Date.parse
}

module.exports = {
  ET_TZ, etParts, etOffsetMs, etWallToUtcMs, etDateStr, etMinuteOfDay, etTimeStr, addDays,
  TIMEFRAMES, TF_KEYS, isValidTf, bucketStart, parseTs,
};
