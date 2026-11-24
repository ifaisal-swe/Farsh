// Chart colors per theme. lightweight-charts needs plain colors, so they are read from the same tokens as the page.
const token = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(`--${n}`).trim()
// the chart library shows UTC unless told otherwise; the tables use the reader's own time, so the charts must too
const at = (t: any) => new Date(Number(t) * 1000)
const clock = (t: any) => at(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
const tick = (t: any, kind: number) => (kind === 0 ? String(at(t).getFullYear()) : kind === 1 ? at(t).toLocaleDateString('en-GB', { month: 'short' }) : kind === 2 ? String(at(t).getDate()) : kind === 4 ? at(t).toLocaleTimeString('en-GB') : clock(t))
export function chartColors(dark: boolean) {
  return {
    up: token('up'), down: token('down'), entry: token('buy'), line: token('buy'),
    overlays: dark
      ? { ema21: '#3987e5', ema50: '#d95926', sma200: '#9085e9', vwap: '#199e70', bbUpper: '#9a9fc0', bbLower: '#9a9fc0' }
      : { ema21: '#2a78d6', ema50: '#eb6834', sma200: '#4a3aa7', vwap: '#1baf7a', bbUpper: '#6a6f8e', bbLower: '#6a6f8e' } as Record<string, string>,
    options: { layout: { background: { color: token('card') }, textColor: token('muted-foreground'), fontSize: Math.round(parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.72), fontFamily: '"IBM Plex Sans Arabic", system-ui, sans-serif' }, grid: { vertLines: { color: token('muted') }, horzLines: { color: token('muted') } }, rightPriceScale: { borderColor: token('border') }, localization: { timeFormatter: (t: any) => `${at(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${clock(t)}` }, timeScale: { timeVisible: true, borderColor: token('border'), tickMarkFormatter: tick } },
  }
}
