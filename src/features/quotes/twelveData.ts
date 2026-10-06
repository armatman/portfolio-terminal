const TWELVE_DATA_URL = 'https://api.twelvedata.com';
const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15 * 1000;
const quoteCache = new Map<string, { expiresAt: number; quote: TwelveDataQuote }>();

export interface TwelveDataQuote {
  price: number;
  change?: number;
  changePercent?: number;
  high?: number;
  low?: number;
}

export interface TwelveDataRequestOptions {
  fetcher?: typeof fetch;
  now?: number;
  force?: boolean;
}

export class TwelveDataError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'TwelveDataError';
  }
}

function numericValue(value: unknown): number | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  if (typeof value === 'string' && !value.trim()) return undefined;
  const number = Number(typeof value === 'string' ? value.trim().replace(/%$/, '') : value);
  return Number.isFinite(number) ? number : undefined;
}

function positiveValue(value: unknown): number | undefined {
  const number = numericValue(value);
  return number !== undefined && number > 0 ? number : undefined;
}

function validateRequest(apiKey: string, symbol: string): string {
  if (!apiKey.trim()) throw new TwelveDataError('Twelve Data API key is missing.');
  const normalizedSymbol = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9._:/-]{1,32}$/.test(normalizedSymbol)) throw new TwelveDataError('Invalid company ticker.');
  return normalizedSymbol;
}

export function parseTwelveDataQuote(value: unknown): TwelveDataQuote {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TwelveDataError('Twelve Data returned an invalid quote.');
  }
  const data = value as Record<string, unknown>;
  const message = data.message;
  if (data.status === 'error' || typeof message === 'string') {
    throw new TwelveDataError(typeof message === 'string' ? message : 'Twelve Data could not provide this quote.');
  }

  const price = positiveValue(data.close) ?? positiveValue(data.price);
  if (price === undefined) throw new TwelveDataError('Twelve Data returned no valid current price.');
  const change = numericValue(data.change);
  const changePercent = numericValue(data.percent_change ?? data.change_percent);
  const high = positiveValue(data.high);
  const low = positiveValue(data.low);
  return {
    price,
    ...(change === undefined ? {} : { change }),
    ...(changePercent === undefined ? {} : { changePercent }),
    ...(high === undefined ? {} : { high }),
    ...(low === undefined ? {} : { low })
  };
}

async function fetchTwelveData<T>(
  apiKey: string,
  symbol: string,
  options: TwelveDataRequestOptions,
  parse: (payload: unknown) => T
): Promise<T> {
  const normalizedSymbol = validateRequest(apiKey, symbol);

  const url = new URL(`${TWELVE_DATA_URL}/quote`);
  url.search = new URLSearchParams({ symbol: normalizedSymbol, apikey: apiKey }).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetcher ?? fetch)(url, { signal: controller.signal });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new TwelveDataError(`Twelve Data returned an unreadable response (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      const data = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload as Record<string, unknown>
        : {};
      throw new TwelveDataError(
        typeof data.message === 'string' ? data.message : `Twelve Data quote request failed (HTTP ${response.status}).`,
        response.status
      );
    }
    return parse(payload);
  } catch (error) {
    if (error instanceof TwelveDataError) throw error;
    if (controller.signal.aborted) {
      throw new TwelveDataError(`Twelve Data request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new TwelveDataError(`Twelve Data request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchTwelveDataQuote(
  apiKey: string,
  symbol: string,
  options: TwelveDataRequestOptions = {}
): Promise<TwelveDataQuote> {
  const normalizedSymbol = validateRequest(apiKey, symbol);
  const now = options.now ?? Date.now();
  const cached = quoteCache.get(`${apiKey}:${normalizedSymbol}`);
  if (!options.force && cached && cached.expiresAt > now) return cached.quote;
  const quote = await fetchTwelveData(apiKey, normalizedSymbol, options, parseTwelveDataQuote);
  quoteCache.set(`${apiKey}:${normalizedSymbol}`, { expiresAt: now + CACHE_TTL_MS, quote });
  return quote;
}

export function clearTwelveDataQuoteCache(): void {
  quoteCache.clear();
}
