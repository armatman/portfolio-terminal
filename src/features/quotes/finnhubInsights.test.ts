import { beforeEach, describe, expect, it } from 'vitest';
import { clearFinnhubInsightCache, fetchFinnhubInsight } from './finnhubInsights';

describe('Finnhub insights client', () => {
  beforeEach(() => clearFinnhubInsightCache());

  it('caches an endpoint response and supports forced refresh', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({ name: `Company ${calls}` }), { status: 200 });
    };

    expect(await fetchFinnhubInsight('key', 'stock/profile2', { symbol: 'AAPL' }, { fetcher, now: 10 }))
      .toEqual({ name: 'Company 1' });
    expect(await fetchFinnhubInsight('key', 'stock/profile2', { symbol: 'AAPL' }, { fetcher, now: 20 }))
      .toEqual({ name: 'Company 1' });
    expect(await fetchFinnhubInsight('key', 'stock/profile2', { symbol: 'AAPL' }, { fetcher, now: 20, force: true }))
      .toEqual({ name: 'Company 2' });
    expect(calls).toBe(2);
  });

  it('surfaces HTTP and Finnhub endpoint errors', async () => {
    const forbidden: typeof fetch = async () => new Response('{}', { status: 403 });
    await expect(fetchFinnhubInsight('key', 'stock/candle', {}, { fetcher: forbidden }))
      .rejects.toMatchObject({ status: 403 });

    const endpointError: typeof fetch = async () => new Response(JSON.stringify({ error: 'Invalid symbol' }));
    await expect(fetchFinnhubInsight('key', 'stock/profile2', {}, { fetcher: endpointError }))
      .rejects.toThrow('Invalid symbol');
  });
});
