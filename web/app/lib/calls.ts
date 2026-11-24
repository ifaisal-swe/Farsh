// the calls of the opportunities page, shared with the dashboard
export const ACTIONS: Record<string, { n: [string, string], c: string }> = {
  BUY: { n: ['اشترِ الآن', 'Buy now'], c: 'bg-sun text-sun-foreground' },
  BUY_AT: { n: ['اشترِ عند السعر', 'Buy at its price'], c: 'bg-sun text-sun-foreground' },
  SELL: { n: ['بِع', 'Sell'], c: 'bg-destructive text-white' },
  SELL_PART: { n: ['بِع جزءًا', 'Sell part'], c: 'bg-destructive text-white' },
  HOLD: { n: ['احتفظ', 'Hold'], c: 'bg-brand text-white' },
  WAIT: { n: ['انتظر الشرط', 'Wait for it'], c: 'bg-secondary text-secondary-foreground' },
  WATCH: { n: ['راقب', 'Watch'], c: 'bg-secondary text-secondary-foreground' },
  AVOID: { n: ['تجنّب', 'Avoid'], c: 'bg-secondary text-secondary-foreground' },
  UNKNOWN: { n: ['غير معروف', 'Unknown'], c: 'bg-secondary text-secondary-foreground' },
}
export const isBuy = (x: any) => ['BUY', 'BUY_AT'].includes(x.action)
export const isSell = (x: any) => ['SELL', 'SELL_PART'].includes(x.action)
