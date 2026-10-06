import { describe, expect, it } from 'vitest';
import {
  classifyActualVsEstimate,
  classifyRecommendationCounts,
  classifySentimentScore,
  calculateTargetUpsidePercent,
  sentimentLabel,
  summarizeDailyQuote,
  summarizeGrowth
} from './sentiment';

describe('market sentiment helpers', () => {
  it('classifies provider sentiment scores and recommendation counts', () => {
    expect(classifySentimentScore(0.25)).toBe('bullish');
    expect(classifySentimentScore(-0.25)).toBe('bearish');
    expect(classifySentimentScore(0.01)).toBe('neutral');
    expect(classifySentimentScore(Number.NaN)).toBe('unknown');
    expect(classifyRecommendationCounts({ strongBuy: 2, buy: 3, hold: 1, sell: 1 })).toBe('bullish');
    expect(classifyRecommendationCounts({ buy: 1, sell: 2 })).toBe('bearish');
    expect(classifyRecommendationCounts({ buy: 1, sell: 1 })).toBe('neutral');
    expect(classifyRecommendationCounts({ hold: 3 })).toBe('neutral');
  });

  it('classifies reported earnings and growth using values only', () => {
    expect(classifyActualVsEstimate(1.2, 1)).toBe('bullish');
    expect(classifyActualVsEstimate(0.8, 1)).toBe('bearish');
    expect(classifyActualVsEstimate(1, 1)).toBe('neutral');
    expect(summarizeGrowth([0.1, 0.05])).toBe('bullish');
    expect(summarizeGrowth([-0.1, 0.05])).toBe('bearish');
    expect(summarizeGrowth([])).toBe('unknown');
  });

  it('summarizes weighted per-share changes and labels unavailable data honestly', () => {
    expect(summarizeDailyQuote([
      { shares: 10, quoteDetails: { change: 2 } },
      { shares: 5, quoteDetails: { change: -1 } },
      { shares: 8 }
    ])).toEqual({ direction: 'bullish', change: 15, coverage: 2, total: 3 });
    expect(sentimentLabel('unknown')).toBe('No signal');
    expect(summarizeDailyQuote([]).direction).toBe('unknown');
  });

  it('compares analyst target with the current price as a percentage', () => {
    expect(calculateTargetUpsidePercent(120, 100)).toBe(20);
    expect(calculateTargetUpsidePercent(80, 100)).toBe(-20);
    expect(calculateTargetUpsidePercent(100, 100)).toBe(0);
    expect(calculateTargetUpsidePercent(100, 0)).toBeUndefined();
  });
});
