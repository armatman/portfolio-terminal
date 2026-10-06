const YAHOO_RAPIDAPI_HOST = 'apidojo-yahoo-finance-v1.p.rapidapi.com';
const YAHOO_API_BASE_URL = `https://${YAHOO_RAPIDAPI_HOST}`;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const REPORT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

export interface RapidApiYahooAnalystSnapshot {
  source: string;
  targetPrice: number;
  basis?: string;
  targets: {
    targetMean?: number;
    targetHigh?: number;
    targetLow?: number;
    targetMedian?: number;
  };
  analystCount?: number;
}

export interface RapidApiYahooQuote {
  price: number;
  change?: number;
  changePercent?: number;
  high?: number;
  low?: number;
}

export class RapidApiYahooError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RapidApiYahooError';
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function rawNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = record(value)?.raw;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
}

export function parseRapidApiYahooQuote(value: unknown): RapidApiYahooQuote {
  const root = record(value);
  if (!root) throw new RapidApiYahooError('RapidAPI Yahoo Finance returned an invalid quote response.');
  const finance = record(root.finance);
  const financeResult = record(finance?.result);
  const quoteSummary = record(root.quoteSummary);
  const quoteSummaryResults = quoteSummary?.result;
  const firstQuoteSummary = Array.isArray(quoteSummaryResults) ? record(quoteSummaryResults[0]) : undefined;
  const price = record(root.price) ??
    record(financeResult?.price) ??
    record(firstQuoteSummary?.price);
  if (!price) throw new RapidApiYahooError('RapidAPI Yahoo Finance returned no quote data.');

  const currentPrice = rawNumber(price.regularMarketPrice) ?? rawNumber(price.currentPrice);
  if (currentPrice === undefined || currentPrice <= 0) {
    throw new RapidApiYahooError('RapidAPI Yahoo Finance returned no valid current price.');
  }
  return {
    price: currentPrice,
    ...(rawNumber(price.regularMarketChange) === undefined
      ? {}
      : { change: rawNumber(price.regularMarketChange) }),
    ...(rawNumber(price.regularMarketChangePercent) === undefined
      ? {}
      : { changePercent: rawNumber(price.regularMarketChangePercent) }),
    ...(rawNumber(price.regularMarketDayHigh) === undefined
      ? {}
      : { high: rawNumber(price.regularMarketDayHigh) }),
    ...(rawNumber(price.regularMarketDayLow) === undefined
      ? {}
      : { low: rawNumber(price.regularMarketDayLow) })
  };
}

export function parseRapidApiYahooAnalystTarget(
  value: unknown,
  now = Date.now()
): RapidApiYahooAnalystSnapshot {
  const root = record(value);
  if (!root) throw new RapidApiYahooError('RapidAPI Yahoo Finance returned an invalid response.');
  const finance = record(root.finance);
  const financeResult = record(finance?.result);
  const apiError = root.message ?? root.error ?? finance?.error;
  if (typeof apiError === 'string' && apiError.trim()) {
    throw new RapidApiYahooError(`RapidAPI Yahoo Finance: ${apiError}`);
  }

  const quoteSummary = record(root.quoteSummary);
  const quoteSummaryResults = quoteSummary?.result;
  const firstQuoteSummary = Array.isArray(quoteSummaryResults) ? record(quoteSummaryResults[0]) : undefined;
  const nestedData = record(root.data);
  const companyOutlook = record(root.companyOutlook);
  const financialData = record(root.financialData) ??
    record(firstQuoteSummary?.financialData) ??
    record(nestedData?.financialData) ??
    record(companyOutlook?.financialData) ??
    record(financeResult?.financialData);
  const recommendation = record(financeResult?.recommendation) ?? record(root.recommendation);
  const reports = Array.isArray(financeResult?.reports)
    ? financeResult.reports
      .map(record)
      .filter((report): report is Record<string, unknown> => Boolean(report))
      .map(report => ({
        target: rawNumber(report.targetPrice),
        reportDate: report.reportDate
      }))
      .filter((report): report is { target: number; reportDate: string } =>
        report.target !== undefined &&
        Number.isFinite(report.target) &&
        report.target > 0 &&
        typeof report.reportDate === 'string' &&
        Number.isFinite(Date.parse(report.reportDate)) &&
        Date.parse(report.reportDate) >= now - REPORT_MAX_AGE_MS)
      .map(({ target }) => target)
    : [];
  const reportAverage = reports.length
    ? reports.reduce((total, target) => total + target, 0) / reports.length
    : undefined;
  const targets = {
    targetMean: rawNumber(financialData?.targetMeanPrice),
    targetHigh: rawNumber(financialData?.targetHighPrice),
    targetLow: rawNumber(financialData?.targetLowPrice),
    targetMedian: rawNumber(financialData?.targetMedianPrice)
  };
  const recommendationTarget = rawNumber(recommendation?.targetPrice);
  const targetPrice = targets.targetMean ?? targets.targetMedian ?? reportAverage ?? recommendationTarget;
  if (targetPrice === undefined || targetPrice <= 0) {
    throw new RapidApiYahooError('RapidAPI Yahoo Finance returned no analyst price target.');
  }

  const analystCount = rawNumber(financialData?.numberOfAnalystOpinions);
  const provider = reportAverage === undefined ? recommendation?.provider : undefined;
  const isReportAverage = targets.targetMean === undefined &&
    targets.targetMedian === undefined &&
    reportAverage !== undefined;
  return {
    source: typeof provider === 'string' && provider.trim()
      ? `Yahoo Finance via RapidAPI · ${provider}`
      : 'Yahoo Finance via RapidAPI',
    targetPrice,
    ...(isReportAverage ? { basis: `average of ${reports.length} analyst reports` } : {}),
    targets,
    ...(analystCount === undefined || analystCount < 0 ? {} : { analystCount })
  };
}

async function requestRapidApiYahooEndpoint(
  apiKey: string,
  symbol: string,
  path: string,
  includeRegion: boolean,
  signal: AbortSignal,
  fetcher: typeof fetch
): Promise<unknown> {
  const url = new URL(`${YAHOO_API_BASE_URL}${path}`);
  url.searchParams.set('symbol', symbol);
  if (includeRegion) url.searchParams.set('region', 'US');

  const response = await fetcher(url, {
    method: 'GET',
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': YAHOO_RAPIDAPI_HOST
    },
    signal
  });
  const requestId = response.headers.get('x-rapidapi-request-id');
  const requestReference = requestId ? ` RapidAPI request ID: ${requestId}.` : '';
  if (response.status === 204) {
    throw new RapidApiYahooError(
      `HTTP 204 No Content from ${path} for ${symbol}; the endpoint provided no data.${requestReference}`
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new RapidApiYahooError(
      `Invalid JSON from ${path} (HTTP ${response.status}).${requestReference}`,
      response.status
    );
  }
  if (!response.ok) {
    const errorPayload = record(payload);
    const message = errorPayload?.message ?? errorPayload?.error;
    throw new RapidApiYahooError(
      typeof message === 'string'
        ? `${path} failed (HTTP ${response.status}): ${message}.${requestReference}`
        : `${path} failed (HTTP ${response.status}).${requestReference}`,
      response.status
    );
  }
  return payload;
}

export async function fetchRapidApiYahooAnalystTarget(
  apiKey: string,
  symbol: string,
  fetcher: typeof fetch = fetch
): Promise<RapidApiYahooAnalystSnapshot> {
  if (!apiKey.trim()) throw new RapidApiYahooError('RapidAPI key is missing.');
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^_-]{1,32}$/.test(normalizedSymbol)) {
    throw new RapidApiYahooError('Invalid company ticker.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const endpoints = [
    { path: '/stock/v3/get-insights', includeRegion: false },
    { path: '/stock/get-company-outlook', includeRegion: true }
  ];
  const failures: string[] = [];
  try {
    for (const endpoint of endpoints) {
      try {
        const payload = await requestRapidApiYahooEndpoint(
          apiKey,
          normalizedSymbol,
          endpoint.path,
          endpoint.includeRegion,
          controller.signal,
          fetcher
        );
        return parseRapidApiYahooAnalystTarget(payload);
      } catch (error) {
        if (controller.signal.aborted) {
          throw new RapidApiYahooError(`RapidAPI Yahoo Finance request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
        }
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new RapidApiYahooError(failures.join(' '));
  } catch (error) {
    if (error instanceof RapidApiYahooError) throw error;
    if (controller.signal.aborted) {
      throw new RapidApiYahooError(`RapidAPI Yahoo Finance request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new RapidApiYahooError(
      `RapidAPI Yahoo Finance request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchRapidApiYahooQuote(
  apiKey: string,
  symbol: string,
  fetcher: typeof fetch = fetch
): Promise<RapidApiYahooQuote> {
  if (!apiKey.trim()) throw new RapidApiYahooError('RapidAPI key is missing.');
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.^_-]{1,32}$/.test(normalizedSymbol)) {
    throw new RapidApiYahooError('Invalid company ticker.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const payload = await requestRapidApiYahooEndpoint(
      apiKey,
      normalizedSymbol,
      '/stock/v2/get-summary',
      true,
      controller.signal,
      fetcher
    );
    return parseRapidApiYahooQuote(payload);
  } catch (error) {
    if (error instanceof RapidApiYahooError) throw error;
    if (controller.signal.aborted) {
      throw new RapidApiYahooError(`RapidAPI Yahoo Finance quote timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new RapidApiYahooError(
      `RapidAPI Yahoo Finance quote request failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    clearTimeout(timeout);
  }
}
