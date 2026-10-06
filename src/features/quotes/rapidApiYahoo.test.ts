import { describe, expect, it } from 'vitest';
import {
  fetchRapidApiYahooAnalystTarget,
  fetchRapidApiYahooQuote,
  parseRapidApiYahooAnalystTarget,
  parseRapidApiYahooQuote
} from './rapidApiYahoo';

describe('RapidAPI Yahoo Finance analyst targets', () => {
  it('parses mean, range, median, and analyst count', () => {
    expect(parseRapidApiYahooAnalystTarget({
      financialData: {
        currentPrice: { raw: 210 },
        targetMeanPrice: { raw: 245 },
        targetHighPrice: { raw: 290 },
        targetLowPrice: { raw: 200 },
        targetMedianPrice: { raw: 240 },
        numberOfAnalystOpinions: { raw: 32 }
      }
    })).toEqual({
      source: 'Yahoo Finance via RapidAPI',
      targetPrice: 245,
      targets: { targetMean: 245, targetHigh: 290, targetLow: 200, targetMedian: 240 },
      analystCount: 32
    });
  });

  it('uses the median when the mean is missing and reports absent data', () => {
    expect(parseRapidApiYahooAnalystTarget({
      financialData: { targetMedianPrice: { raw: 120 } }
    }).targetPrice).toBe(120);
    expect(() => parseRapidApiYahooAnalystTarget({ financialData: {} }))
      .toThrow('no analyst price target');
  });

  it('returns a single-provider recommendation target without treating it as aggregate data', () => {
    expect(parseRapidApiYahooAnalystTarget({
      finance: {
        result: {
          symbol: 'CHRW',
          recommendation: {
            targetPrice: 142,
            provider: 'Argus Research',
            rating: 'HOLD'
          }
        },
        error: null
      }
    })).toMatchObject({
      source: 'Yahoo Finance via RapidAPI · Argus Research',
      targetPrice: 142
    });
  });

  it('averages every valid report target if no aggregate target is present', () => {
    expect(parseRapidApiYahooAnalystTarget({
      finance: {
        result: {
          reports: [
            { targetPrice: 135, provider: 'Broker A', reportDate: '2026-09-20T00:00:00Z' },
            { targetPrice: 142, provider: 'Broker B', reportDate: '2026-10-01T00:00:00Z' },
            { targetPrice: 130, provider: 'Broker C', reportDate: '2026-09-28T00:00:00Z' },
            { targetPrice: 0, provider: 'Invalid' },
            { provider: 'No target' }
          ]
        },
        error: null
      }
    })).toMatchObject({
      source: 'Yahoo Finance via RapidAPI',
      targetPrice: 407 / 3,
      basis: 'average of 3 analyst reports'
    });
  });

  it('averages only reports from the rolling last year', () => {
    const now = Date.parse('2026-10-06T00:00:00Z');
    expect(parseRapidApiYahooAnalystTarget({
      finance: {
        result: {
          reports: [
            { targetPrice: 100, reportDate: '2025-10-05T23:59:59Z' },
            { targetPrice: 200, reportDate: '2025-10-06T00:00:00Z' },
            { targetPrice: 300, reportDate: '2026-10-05T00:00:00Z' },
            { targetPrice: 400, reportDate: 'invalid-date' },
            { targetPrice: 500 }
          ]
        },
        error: null
      }
    }, now)).toMatchObject({
      targetPrice: 250,
      basis: 'average of 2 analyst reports'
    });
  });

  it('recognizes company outlook with no targets as valid empty target data', () => {
    expect(() => parseRapidApiYahooAnalystTarget({
      finance: {
        result: {
          metaData: { symbol: 'CHRW' },
          innovations: {},
          significantDevelopments: [],
          companyOutlookSummary: {}
        },
        error: null
      }
    })).toThrow('no analyst price target');
  });

  it('calls the maintained insights endpoint with symbol and required headers', async () => {
    let requestedUrl = '';
    let headers = new Headers();
    let requestInit: RequestInit | undefined;
    const result = await fetchRapidApiYahooAnalystTarget('test-key', 'aapl', async (input, init) => {
      requestedUrl = String(input);
      requestInit = init;
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({
        financialData: { targetMeanPrice: { raw: 200 } }
      }));
    });
    const url = new URL(requestedUrl);
    expect(url.hostname).toBe('apidojo-yahoo-finance-v1.p.rapidapi.com');
    expect(url.pathname).toBe('/stock/v3/get-insights');
    expect(url.searchParams.get('symbol')).toBe('AAPL');
    expect(url.searchParams.has('region')).toBe(false);
    expect(headers.get('x-rapidapi-key')).toBe('test-key');
    expect(headers.get('x-rapidapi-host')).toBe('apidojo-yahoo-finance-v1.p.rapidapi.com');
    expect(headers.get('accept')).toBe('application/json');
    expect(requestInit?.method).toBe('GET');
    expect(requestInit?.cache).toBe('no-store');
    expect(result.targetPrice).toBe(200);
  });

  it('surfaces RapidAPI HTTP errors with their status and provider message', async () => {
    await expect(fetchRapidApiYahooAnalystTarget('test-key', 'AAPL', async () =>
      new Response(JSON.stringify({ message: 'You are not subscribed to this API.' }), { status: 403 })
    )).rejects.toThrow('HTTP 403): You are not subscribed to this API.');
  });

  it('explains an empty HTTP 204 response as missing provider data', async () => {
    await expect(fetchRapidApiYahooAnalystTarget('test-key', 'CHRW', async () =>
      new Response(null, { status: 204 })
    )).rejects.toThrow('HTTP 204 No Content from /stock/v3/get-insights for CHRW; the endpoint provided no data.');
  });

  it('tries company outlook when insights has no target data', async () => {
    const requestedUrls: string[] = [];
    const result = await fetchRapidApiYahooAnalystTarget('test-key', 'CHRW', async input => {
      const url = new URL(String(input));
      requestedUrls.push(url.toString());
      if (url.pathname === '/stock/v3/get-insights') {
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify({
        quoteSummary: {
          result: [{
            financialData: {
              targetMeanPrice: { raw: 100 },
              targetHighPrice: { raw: 120 }
            }
          }]
        }
      }));
    });
    const insightsUrl = new URL(requestedUrls[0]);
    const outlookUrl = new URL(requestedUrls[1]);
    expect(insightsUrl.pathname).toBe('/stock/v3/get-insights');
    expect(insightsUrl.search).toBe('?symbol=CHRW');
    expect(outlookUrl.pathname).toBe('/stock/get-company-outlook');
    expect(outlookUrl.search).toBe('?symbol=CHRW&region=US');
    expect(result.targetPrice).toBe(100);
    expect(result.targets.targetHigh).toBe(120);
  });
});

describe('RapidAPI Yahoo Finance quotes', () => {
  it('parses summary quote values', () => {
    expect(parseRapidApiYahooQuote({
      quoteSummary: {
        result: [{
          price: {
            regularMarketPrice: { raw: 195.5 },
            regularMarketChange: { raw: 2.5 },
            regularMarketChangePercent: { raw: 1.3 },
            regularMarketDayHigh: { raw: 197 },
            regularMarketDayLow: { raw: 192 },
            preMarketPrice: { raw: 198.25 },
            preMarketChange: { raw: 5.25 },
            preMarketChangePercent: { raw: 2.69 }
          }
        }]
      }
    })).toEqual({
      price: 195.5,
      change: 2.5,
      changePercent: 1.3,
      high: 197,
      low: 192,
      preMarketPrice: 198.25,
      preMarketChange: 5.25,
      preMarketChangePercent: 2.69
    });
  });

  it('requests the company summary through RapidAPI', async () => {
    let requestedUrl = '';
    const quote = await fetchRapidApiYahooQuote('test-key', 'chrw', async input => {
      requestedUrl = String(input);
      return new Response(JSON.stringify({
        finance: {
          result: {
            price: { regularMarketPrice: { raw: 195.5 } }
          }
        }
      }));
    });
    const url = new URL(requestedUrl);
    expect(url.pathname).toBe('/stock/v2/get-summary');
    expect(url.searchParams.get('symbol')).toBe('CHRW');
    expect(url.searchParams.get('region')).toBe('US');
    expect(quote.price).toBe(195.5);
  });
});
