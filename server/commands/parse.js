'use strict';
/** Turns a typed order ("buy 5 NVDA at 160 stop 150 target 180", "اشتر 5 نفيديا عند 160") into fields. No AI; the person confirms the result. */
const NAMES = { 'نفيديا': 'NVDA', 'انفيديا': 'NVDA', 'إنفيديا': 'NVDA', 'nvidia': 'NVDA', 'ابل': 'AAPL', 'أبل': 'AAPL', 'آبل': 'AAPL', 'apple': 'AAPL', 'تسلا': 'TSLA', 'تيسلا': 'TSLA', 'tesla': 'TSLA', 'مايكروسوفت': 'MSFT', 'microsoft': 'MSFT', 'امازون': 'AMZN', 'أمازون': 'AMZN', 'amazon': 'AMZN', 'ميتا': 'META', 'قوقل': 'GOOGL', 'جوجل': 'GOOGL', 'google': 'GOOGL', 'بتكوين': 'BTC/USD', 'بيتكوين': 'BTC/USD', 'bitcoin': 'BTC/USD', 'btc': 'BTC/USD', 'ايثيريوم': 'ETH/USD', 'إيثيريوم': 'ETH/USD', 'ethereum': 'ETH/USD', 'eth': 'ETH/USD', 'ذهب': 'PAXG/USD', 'الذهب': 'PAXG/USD', 'gold': 'PAXG/USD', 'paxg': 'PAXG/USD', 'sol': 'SOL/USD' };
const N = '([0-9]+(?:\\.[0-9]+)?)';
const WORDS = new Set('BUY SELL AT ON IF WHEN STOP LOSS TARGET TP SL PRICE SHARES SHARE STOCK STOCKS OF THE A AN FOR USD DOLLAR DOLLARS WORTH ALL HALF LIMIT MARKET NOW AND THEN TODAY DAY BREAKS ABOVE BELOW UNDER OVER FALLS DROPS RISES HITS REACHES TO IT GETS TRAIL TRAILING BY GTC WITH PROFIT TAKE MY IS UNTIL GOES'.split(' '));

function parse(text) {
  let s = ` ${String(text || '').slice(0, 300)} `.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)).replace(/٫/g, '.').replace(/(\d)[,٬](\d{3})(?!\d)/g, '$1$2').replace(/(\d)\.(?=\s)/g, '$1 ').replace(/[،,;:!؟?]/g, ' ').replace(/ـ/g, '').replace(/\s+/g, ' ');
  const low = s.toLowerCase(); const out = { side: null, symbol: null, type: 'MARKET', price: null, qty: null, dollars: null, all: false, stop: null, target: null, trail: null, day: false, missing: [] };
  const buy = /(^| )(buy|اشتر|اشتري|اشترِ|شراء)( |$)/.exec(low); const sell = /(^| )(sell|بع|بيع|بِع|ابيع)( |$)/.exec(low);
  if (buy && (!sell || buy.index < sell.index)) out.side = 'BUY'; else if (sell) out.side = 'SELL';
  let rest = low;
  const take = (re) => { const m = re.exec(rest); if (!m) return null; rest = rest.slice(0, m.index) + ' ' + rest.slice(m.index + m[0].length); return m; };
  let m = take(new RegExp(`(?:trailing|trail|متحرك|يتبع)(?: stop)?(?: by| بنسبة)?\\s*${N}\\s*[%٪]`)); if (m) out.trail = Number(m[1]);
  m = take(new RegExp(`(?:take profit|target|tp|الهدف|هدف|وهدف|جني الربح)(?: at| price| عند| سعر)?\\s*\\$?${N}`)); if (m) out.target = Number(m[1]);
  if (out.side === 'BUY') { m = take(new RegExp(`(?:stop loss|stop|sl|وقف الخسارة|وقف|ووقف|الوقف)(?: at| price| عند| سعر)?\\s*\\$?${N}`)); if (m) out.stop = Number(m[1]); }
  const price = (re, kind) => { const r = take(re); if (r) { out.price = Number(r[1]); out.kind = kind; } return !!r; };
  const to = '(?: to| at| إلى| الى| عن| ل| سعر| the price| price)?';
  price(new RegExp(`(?:breaks above|goes above|rises above|rises|above|over|breaks|تجاوز|يتجاوز|ارتفع|يرتفع|فوق|اخترق)${to}\\s*\\$?${N}`), 'UP')
  || price(new RegExp(`(?:falls below|drops below|falls|drops|below|under|نزل|ينزل|انخفض|ينخفض|تحت|كسر|stop|وقف)${to}\\s*\\$?${N}`), 'DOWN')
  || price(new RegExp(`(?:at|on price|on|when it (?:hits|reaches|gets)|hits|reaches|limit|price|@|عند|بسعر|على سعر|سعر|وصل|يصل|بلغ)${to}\\s*\\$?${N}`), 'AT');
  m = take(new RegExp(`(?:\\$\\s*${N}|${N}\\s*(?:\\$|dollars?|usd|دولار(?:ا|ًا)?))`)); if (m) out.dollars = Number(m[1] || m[2]);
  if (/(^| )(all|everything|كل|كامل|جميع)( |$)/.test(rest)) out.all = true;
  m = take(new RegExp(`(?:^| )${N}(?= |$)`)); if (m) out.qty = Number(m[1]);
  if (/(^| )(today|day|اليوم)( |$)/.test(low)) out.day = true;
  for (const w of low.split(' ')) { const k = w.replace(/^[وبل](?=.{4,})/, ''); if (NAMES[w] || NAMES[k]) { out.symbol = NAMES[w] || NAMES[k]; break; } }
  if (!out.symbol) for (const w of s.toUpperCase().split(' ')) if ((/^[A-Z]{2,6}\/USD$/.test(w) || /^\$?[A-Z][A-Z.]{0,5}$/.test(w)) && !WORDS.has(w.replace('$', ''))) { out.symbol = w.replace('$', ''); break; }
  if (out.trail && out.side === 'SELL') out.type = 'TRAIL';
  else if (out.price) out.type = out.side === 'BUY' ? (out.kind === 'UP' ? 'STOP' : 'LIMIT') : out.kind === 'DOWN' ? 'STOP' : 'LIMIT';
  delete out.kind;
  if (!out.side) out.missing.push('side');
  if (!out.symbol) out.missing.push('symbol');
  if (!out.qty && !out.dollars && !out.all) out.missing.push('amount');
  return out;
}

module.exports = { parse };
