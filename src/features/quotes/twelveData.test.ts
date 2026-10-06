import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearTwelveDataQuoteCache,
  fetchTwelveDataQuote,
  parseTwelveDataQuote,
  TwelveDataError
} from './twelveData';

describe('Twelve Data quotes', () => {
  beforeEach(() => clearTwelveDataQuoteCache());

  it('parses the quote values while preserving zero and negative movement', () => {
    expect(parseTwelveDataQuote({
      close: '96.80',
      change: '-1.20',
      percent_change: '-1.224%',
      high: '99.10',
      low: '96.50'
    })).toEqual({
      price: 96.8,
      change: -1.2,
      changePercent: -1.224,
      high: 99.1,
      low: 96.5
    });
    expect(parseTwelveDataQuote({ price: 100, change: 0, percent_change: 0 })).toEqual({
      price: 100,
      change: 0,
      changePercent: 0
    });
  });

  it('surfaces API and malformed quote responses', () => {
    expect(() => parseTwelveDataQuote({ status: 'error', message: 'Invalid API key' }))
      .toThrow('Invalid API key');
    expect(() => parseTwelveDataQuote({ symbol: 'CHRW' })).toThrow('no valid current price');
  });

  it('requests quotes, caches by ticker, and allows forced refresh', async () => {
    let calls = 0;
    let requestedUrl = '';
    const fetcher: typeof fetch = async input => {
      calls += 1;
      requestedUrl = String(input);
      return new Response(JSON.stringify({ close: String(95 + calls), change: '1.0' }));
    };

    expect(await fetchTwelveDataQuote('key', 'chrw', { fetcher, now: 1 })).toMatchObject({ price: 96 });
    expect(new URL(requestedUrl).searchParams.get('symbol')).toBe('CHRW');
    expect(await fetchTwelveDataQuote('key', 'CHRW', { fetcher, now: 2 })).toMatchObject({ price: 96 });
    expect(await fetchTwelveDataQuote('key', 'CHRW', { fetcher, now: 2, force: true })).toMatchObject({ price: 97 });
    expect(calls).toBe(2);
  });

  it('rejects empty API keys', async () => {
    await expect(fetchTwelveDataQuote('', 'CHRW')).rejects.toBeInstanceOf(TwelveDataError);
  });
});
