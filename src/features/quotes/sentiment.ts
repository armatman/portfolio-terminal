export type SentimentDirection = 'bullish' | 'bearish' | 'neutral' | 'unknown';

export interface SentimentBadge {
  direction: SentimentDirection;
  label: string;
}

export interface DailyQuoteHolding {
  shares: number;
  quoteDetails?: {
    change?: number;
    changePercent?: number;
  };
}

export function classifySentimentScore(score: number, neutralBand = 0.05): SentimentDirection {
  if (!Number.isFinite(score)) return 'unknown';
  if (score > neutralBand) return 'bullish';
  if (score < -neutralBand) return 'bearish';
  return 'neutral';
}

export function classifyRecommendationCounts(counts: {
  strongBuy?: number;
  buy?: number;
  hold?: number;
  sell?: number;
  strongSell?: number;
}): SentimentDirection {
  const bullish = (counts.strongBuy || 0) + (counts.buy || 0);
  const bearish = (counts.sell || 0) + (counts.strongSell || 0);
  const total = bullish + bearish + (counts.hold || 0);
  if (total === 0) return 'unknown';
  if (bullish > bearish) return 'bullish';
  if (bearish > bullish) return 'bearish';
  return 'neutral';
}

export function classifyActualVsEstimate(actual: number, estimate: number): SentimentDirection {
  if (!Number.isFinite(actual) || !Number.isFinite(estimate)) return 'unknown';
  if (actual > estimate) return 'bullish';
  if (actual < estimate) return 'bearish';
  return 'neutral';
}

export function summarizeGrowth(values: number[]): SentimentDirection {
  const valid = values.filter(Number.isFinite);
  if (valid.length === 0) return 'unknown';
  const average = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  if (average > 0) return 'bullish';
  if (average < 0) return 'bearish';
  return 'neutral';
}

export function calculateTargetUpsidePercent(targetPrice: number, currentPrice: number): number | undefined {
  if (!Number.isFinite(targetPrice) || targetPrice <= 0 || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return undefined;
  }
  return ((targetPrice - currentPrice) / currentPrice) * 100;
}

export function summarizeDailyQuote(
  holdings: DailyQuoteHolding[]
): { direction: SentimentDirection; change: number; coverage: number; total: number } {
  let change = 0;
  let coverage = 0;
  holdings.forEach(holding => {
    const shares = Number(holding.shares);
    const quoteChange = holding.quoteDetails?.change;
    if (!Number.isFinite(shares) || shares <= 0 || typeof quoteChange !== 'number' || !Number.isFinite(quoteChange)) return;
    coverage += 1;
    change += shares * quoteChange;
  });
  const direction = coverage === 0 ? 'unknown' : change > 0 ? 'bullish' : change < 0 ? 'bearish' : 'neutral';
  return { direction, change, coverage, total: holdings.length };
}

export function sentimentLabel(direction: SentimentDirection): string {
  if (direction === 'bullish') return 'Bullish';
  if (direction === 'bearish') return 'Bearish';
  if (direction === 'neutral') return 'Neutral';
  return 'No signal';
}
