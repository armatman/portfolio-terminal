import { beforeEach, describe, expect, it } from 'vitest';
import {
  AlphaVantageError,
  clearAlphaVantageCache,
  fetchAlphaVantageAnalysts,
  fetchAlphaVantageNews,
  fetchAlphaVantageQuote,
  parseAlphaVantageOverview,
  parseAlphaVantageQuote
} from './alphaVantageAnalysts';

describe('Alpha Vantage analyst data', () => {
  beforeEach(() => clearAlphaVantageCache());

  it('parses analyst target and rating counts from the company overview', () => {
    expect(parseAlphaVantageOverview({
      AnalystTargetPrice: '240.59',
      AnalystRatingStrongBuy: '3',
      AnalystRatingBuy: '10',
      AnalystRatingHold: '10',
      AnalystRatingSell: '1',
      AnalystRatingStrongSell: '1'
    })).toEqual({
      source: 'Alpha Vantage',
      targetPrice: 240.59,
      ratingCounts: { strongBuy: 3, buy: 10, hold: 10, sell: 1, strongSell: 1 }
    });
  });

  it('reports provider quota and missing-data messages as errors', () => {
    expect(() => parseAlphaVantageOverview({ Note: 'API call frequency exceeded.' })).toThrow('frequency exceeded');
    expect(() => parseAlphaVantageOverview({ Symbol: 'AAPL' })).toThrow('no analyst target price');
  });

  it('parses Global Quote values including zero movement', () => {
    expect(parseAlphaVantageQuote({
      'Global Quote': {
        '05. price': '200.5',
        '09. change': '0.00',
        '10. change percent': '0.0000%',
        '03. high': '203.0',
        '04. low': '198.0'
      }
    })).toEqual({ price: 200.5, change: 0, changePercent: 0, high: 203, low: 198 });
  });

  it('normalizes Alpha Vantage news and uses the ticker query parameter', async () => {
    let requestedUrl = '';
    const fetcher: typeof fetch = async input => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        feed: [{
          title: 'Market update',
          url: 'https://example.test/news',
          time_published: '20261006T070000',
          source: 'Example',
          summary: 'Company update'
        }]
      }));
    };
    const news = await fetchAlphaVantageNews('key', 'AAPL', { fetcher });
    expect(new URL(requestedUrl).searchParams.get('tickers')).toBe('AAPL');
    expect(news[0]).toMatchObject({
      headline: 'Market update',
      source: 'Example',
      datetime: Date.parse('2026-10-06T07:00:00Z') / 1000
    });
  });

  it('caches by ticker and allows forced refresh', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ AnalystTargetPrice: String(200 + calls) }));
    };
    expect(await fetchAlphaVantageAnalysts('key', 'aapl', { fetcher, now: 1 })).toMatchObject({ targetPrice: 201 });
    expect(await fetchAlphaVantageAnalysts('key', 'AAPL', { fetcher, now: 2 })).toMatchObject({ targetPrice: 201 });
    expect(await fetchAlphaVantageAnalysts('key', 'AAPL', { fetcher, now: 2, force: true })).toMatchObject({ targetPrice: 202 });
    expect(calls).toBe(2);
  });
});
