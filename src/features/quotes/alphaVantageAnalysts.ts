const ALPHA_VANTAGE_URL = 'https://www.alphavantage.co/query';
const CACHE_TTLS_MS: Record<string, number> = {
  GLOBAL_QUOTE: 5 * 60 * 1000,
  NEWS_SENTIMENT: 5 * 60 * 1000,
  EARNINGS: 6 * 60 * 60 * 1000,
  OVERVIEW: 12 * 60 * 60 * 1000
};
const REQUEST_TIMEOUT_MS = 20 * 1000;
const cache = new Map<string, { expiresAt: number; value: unknown }>();

export interface AlphaVantageAnalystSnapshot {
  source: 'Alpha Vantage';
  ratingCounts: {
    strongBuy?: number;
    buy?: number;
    hold?: number;
    sell?: number;
    strongSell?: number;
  };
  targetPrice?: number;
}

export interface AlphaVantageRequestOptions {
  fetcher?: typeof fetch;
  now?: number;
  force?: boolean;
}

export interface AlphaVantageQuote {
  price: number;
  change?: number;
  changePercent?: number;
  high?: number;
  low?: number;
}

export interface AlphaVantageNewsItem {
  headline: string;
  summary: string;
  url: string;
  source: string;
  datetime: number;
}

export class AlphaVantageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlphaVantageError';
  }
}

function parsePositiveNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function parseRatingCount(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const number = Number(value);
  return Number.isFinite(number) && Number.isInteger(number) && number >= 0 ? number : undefined;
}

export function parseAlphaVantageOverview(value: unknown): AlphaVantageAnalystSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AlphaVantageError('Alpha Vantage returned an invalid company overview.');
  }
  const data = value as Record<string, unknown>;
  const apiMessage = data['Error Message'] ?? data.Information ?? data.Note;
  if (typeof apiMessage === 'string') throw new AlphaVantageError(apiMessage);

  const ratingCounts = {
    strongBuy: parseRatingCount(data.AnalystRatingStrongBuy),
    buy: parseRatingCount(data.AnalystRatingBuy),
    hold: parseRatingCount(data.AnalystRatingHold),
    sell: parseRatingCount(data.AnalystRatingSell),
    strongSell: parseRatingCount(data.AnalystRatingStrongSell)
  };
  const targetPrice = parsePositiveNumber(data.AnalystTargetPrice);
  const hasRatings = Object.values(ratingCounts).some(count => count !== undefined);
  if (!hasRatings && targetPrice === undefined) {
    throw new AlphaVantageError('Alpha Vantage returned no analyst target price or rating counts for this symbol.');
  }

  return {
    source: 'Alpha Vantage',
    ratingCounts,
    ...(targetPrice === undefined ? {} : { targetPrice })
  };
}

export function parseAlphaVantageQuote(value: unknown): AlphaVantageQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AlphaVantageError('Alpha Vantage returned an invalid quote.');
  }
  const data = value as Record<string, unknown>;
  const quote = data['Global Quote'];
  if (!quote || typeof quote !== 'object' || Array.isArray(quote)) {
    const message = data.Information ?? data.Note ?? data['Error Message'];
    throw new AlphaVantageError(typeof message === 'string' ? message : 'Alpha Vantage returned no quote for this symbol.');
  }
  const fields = quote as Record<string, unknown>;
  const price = parsePositiveNumber(fields['05. price']);
  if (price === undefined) throw new AlphaVantageError('Alpha Vantage returned no valid current price.');
  const percentage = fields['10. change percent'];
  const changePercent = typeof percentage === 'string'
    ? parseOptionalNumber(percentage.replace(/%$/, ''))
    : parseOptionalNumber(percentage);
  return {
    price,
    ...(parseOptionalNumber(fields['09. change']) === undefined ? {} : { change: parseOptionalNumber(fields['09. change']) }),
    ...(changePercent === undefined ? {} : { changePercent }),
    ...(parseOptionalNumber(fields['03. high']) === undefined ? {} : { high: parseOptionalNumber(fields['03. high']) }),
    ...(parseOptionalNumber(fields['04. low']) === undefined ? {} : { low: parseOptionalNumber(fields['04. low']) })
  };
}

export function parseAlphaVantageNews(value: unknown): AlphaVantageNewsItem[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AlphaVantageError('Alpha Vantage returned invalid news data.');
  }
  const data = value as Record<string, unknown>;
  const message = data.Information ?? data.Note ?? data['Error Message'];
  if (typeof message === 'string') throw new AlphaVantageError(message);
  if (!Array.isArray(data.feed)) return [];
  return data.feed.flatMap(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const article = item as Record<string, unknown>;
    if (typeof article.title !== 'string' || typeof article.url !== 'string') return [];
    const timestamp = typeof article.time_published === 'string'
      ? Date.parse(article.time_published.replace(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/,
        '$1-$2-$3T$4:$5:$6Z'
      ))
      : NaN;
    return [{
      headline: article.title,
      summary: typeof article.summary === 'string' ? article.summary : '',
      url: article.url,
      source: typeof article.source === 'string' ? article.source : 'Alpha Vantage News',
      datetime: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : 0
    }];
  });
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

async function fetchAlphaVantageFunction<T>(
  apiKey: string,
  symbol: string,
  functionName: keyof typeof CACHE_TTLS_MS,
  options: AlphaVantageRequestOptions,
  parse: (value: unknown) => T,
  extraParams: Record<string, string> = {}
): Promise<T> {
  if (!apiKey.trim()) throw new AlphaVantageError('Alpha Vantage API key is missing.');
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9._:-]{1,32}$/.test(normalizedSymbol)) throw new AlphaVantageError('Invalid company ticker.');

  const requestParams = functionName === 'NEWS_SENTIMENT'
    ? { ...extraParams, tickers: normalizedSymbol }
    : { symbol: normalizedSymbol, ...extraParams };
  const cacheKey = `${apiKey}:${functionName}:${new URLSearchParams(requestParams)}`;
  const now = options.now ?? Date.now();
  const cached = cache.get(cacheKey);
  if (!options.force && cached && cached.expiresAt > now) return cached.value as T;

  const url = new URL(ALPHA_VANTAGE_URL);
  url.search = new URLSearchParams({
    function: functionName,
    ...requestParams,
    apikey: apiKey
  }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetcher ?? fetch)(url, { signal: controller.signal });
    if (!response.ok) throw new AlphaVantageError(`Alpha Vantage request failed (HTTP ${response.status}).`);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AlphaVantageError('Alpha Vantage returned an unreadable response.');
    }
    const result = parse(payload);
    cache.set(cacheKey, { expiresAt: now + CACHE_TTLS_MS[functionName], value: result });
    return result;
  } catch (error) {
    if (error instanceof AlphaVantageError) throw error;
    if (controller.signal.aborted) throw new AlphaVantageError(`Alpha Vantage request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    throw new AlphaVantageError(`Alpha Vantage request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchAlphaVantageAnalysts(
  apiKey: string,
  symbol: string,
  options: AlphaVantageRequestOptions = {}
): Promise<AlphaVantageAnalystSnapshot> {
  return fetchAlphaVantageFunction(apiKey, symbol, 'OVERVIEW', options, parseAlphaVantageOverview);
}

export function fetchAlphaVantageQuote(
  apiKey: string,
  symbol: string,
  options: AlphaVantageRequestOptions = {}
): Promise<AlphaVantageQuote> {
  return fetchAlphaVantageFunction(apiKey, symbol, 'GLOBAL_QUOTE', options, parseAlphaVantageQuote);
}

export function fetchAlphaVantageOverview(
  apiKey: string,
  symbol: string,
  options: AlphaVantageRequestOptions = {}
): Promise<Record<string, unknown>> {
  return fetchAlphaVantageFunction(apiKey, symbol, 'OVERVIEW', options, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AlphaVantageError('Alpha Vantage returned an invalid company overview.');
    const data = value as Record<string, unknown>;
    const message = data['Error Message'] ?? data.Information ?? data.Note;
    if (typeof message === 'string') throw new AlphaVantageError(message);
    return data;
  });
}

export function fetchAlphaVantageNews(
  apiKey: string,
  symbol: string,
  options: AlphaVantageRequestOptions = {}
): Promise<AlphaVantageNewsItem[]> {
  return fetchAlphaVantageFunction(apiKey, symbol, 'NEWS_SENTIMENT', options, parseAlphaVantageNews, {
    sort: 'LATEST',
    limit: '50'
  });
}

export function fetchAlphaVantageEarnings(
  apiKey: string,
  symbol: string,
  options: AlphaVantageRequestOptions = {}
): Promise<Record<string, unknown>> {
  return fetchAlphaVantageFunction(apiKey, symbol, 'EARNINGS', options, value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AlphaVantageError('Alpha Vantage returned invalid earnings data.');
    const data = value as Record<string, unknown>;
    const message = data['Error Message'] ?? data.Information ?? data.Note;
    if (typeof message === 'string') throw new AlphaVantageError(message);
    return data;
  });
}

export function clearAlphaVantageCache(): void {
  cache.clear();
}
