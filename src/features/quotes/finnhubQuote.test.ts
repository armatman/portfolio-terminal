import { describe, expect, it } from 'vitest';
import { parseFinnhubQuoteDetails } from './finnhubQuote';

describe('Finnhub quote details', () => {
  it('keeps valid zero and negative movements and day-range values', () => {
    expect(parseFinnhubQuoteDetails({ d: -1.25, dp: -0.5, h: 250, l: 245 })).toEqual({
      change: -1.25,
      changePercent: -0.5,
      high: 250,
      low: 245
    });
    expect(parseFinnhubQuoteDetails({ d: 0, dp: 0, h: 250, l: 0 })).toEqual({
      change: 0,
      changePercent: 0,
      high: 250,
      low: 0
    });
  });

  it('ignores invalid fields and returns null when no quote details are available', () => {
    expect(parseFinnhubQuoteDetails({ d: '1.2', dp: Number.NaN, h: null, l: Infinity })).toBeNull();
    expect(parseFinnhubQuoteDetails(null)).toBeNull();
  });
});
