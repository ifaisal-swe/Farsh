'use strict';
/**
 * Alpaca crypto market data (READ-ONLY), spot USD pairs such as BTC/USD. Docs checked 2026-11-23:
 *   stream:  wss://stream.data.alpaca.markets/v1beta3/crypto/us  (trades, quotes, bars, updatedBars, dailyBars)
 *   REST:    https://data.alpaca.markets/v1beta3/crypto/us/bars | snapshots
 * The stream has no halt / LULD channels. Prices come from a single venue (Alpaca US).
 */
const { AlpacaProvider } = require('./alpaca');
const { TIMEFRAMES, parseTs, etDateStr, addDays } = require('../util/time');

const CRYPTO_RE = /^[A-Z0-9]{2,6}\/USD$/;
const isCrypto = (s) => CRYPTO_RE.test(String(s || ''));
/** Execution settings for crypto: fractional, taker fee as a percentage, no equity regulatory fees. */
const CRYPTO_EXECUTION = { fractionalShares: true, commissionPct: 0.25, commissionPerShare: 0, commissionPerOrder: 0, secFeeRate: 0, finraTafPerShare: 0, extendedHours: false };
const PATH = '/v1beta3/crypto/us';
const toBar = (b) => ({ time: Math.floor(parseTs(b.t) / 1000), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v, vw: b.vw, trades: b.n });

class CryptoProvider extends AlpacaProvider {
  constructor(o) {
    super({ ...o, feed: 'iex' });
    this.feed = 'crypto';
    this.streamUrl = `${o.cfg.streamBaseUrl}${PATH}`;
    this.channels.statuses = false;
    this.channels.lulds = false;
  }

  get name() { return 'alpaca-crypto'; }
  feedInfo() { return { provider: 'Alpaca', feed: 'crypto', name: 'ALPACA CRYPTO', realtime: true, label: 'LIVE — ALPACA CRYPTO', note: 'Real-time crypto from one venue (Alpaca US). Prices on other exchanges can differ.', mode: 'LIVE' }; }

  async bars(symbol, params) {
    const d = await this.get(this.dataBase, `${PATH}/bars`, { symbols: symbol, ...params });
    return ((d && d.bars && d.bars[symbol]) || []).map(toBar);
  }

  async fetchBars(symbol, tf, { limit = 500, start, end } = {}) {
    const t = TIMEFRAMES[tf];
    const rows = await this.bars(symbol, { timeframe: t.alpaca, start: start || addDays(etDateStr(Date.now()), -t.lookbackDays), end: end ? new Date(end).toISOString() : undefined, limit: Math.min(10000, limit), sort: 'desc' });
    return rows.reverse();
  }

  async fetchMinuteWindow(symbol, startMs) {
    return this.bars(symbol, { timeframe: '1Min', start: new Date(startMs).toISOString(), limit: 10000, sort: 'asc' });
  }

  async fetchSnapshots(symbols) {
    const list = symbols.filter(isCrypto);
    if (!list.length) return {};
    const d = await this.get(this.dataBase, `${PATH}/snapshots`, { symbols: list.join(',') });
    return (d && d.snapshots) || {};
  }

  async fetchSnapshot(symbol) { return (await this.fetchSnapshots([symbol]))[symbol] || null; }

  /** A pair exists when the venue returns a snapshot for it. */
  async fetchAsset(symbol) {
    const s = await this.fetchSnapshot(symbol);
    if (!s || (!s.latestTrade && !s.latestQuote)) throw Object.assign(new Error(`Pair ${symbol} not found`), { status: 404 });
    return { symbol, name: symbol, exchange: 'CRYPTO', status: 'active', tradable: true, fractionable: true };
  }

  async fetchNews(symbol, o) { return super.fetchNews(symbol.replace('/', ''), o); }
}

module.exports = { CryptoProvider, isCrypto, CRYPTO_RE, CRYPTO_EXECUTION };
