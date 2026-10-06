const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
const INSIGHT_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20 * 1000;
const cache = new Map<string, { expiresAt: number; value: unknown }>();

export class FinnhubInsightError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'FinnhubInsightError';
  }
}

export interface FinnhubRequestOptions {
  fetcher?: typeof fetch;
  now?: number;
  force?: boolean;
}

export async function fetchFinnhubInsight(
  apiKey: string,
  endpoint: string,
  params: Record<string, string>,
  options: FinnhubRequestOptions = {}
): Promise<unknown> {
  if (!apiKey.trim()) throw new FinnhubInsightError('Finnhub API key is missing.');
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)?$/.test(endpoint)) throw new FinnhubInsightError('Invalid Finnhub endpoint.');

  const query = new URLSearchParams({ ...params, token: apiKey });
  const cacheKey = `${endpoint}?${query.toString()}`;
  const now = options.now ?? Date.now();
  const cached = cache.get(cacheKey);
  if (!options.force && cached && cached.expiresAt > now) return cached.value;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await (options.fetcher ?? fetch)(`${FINNHUB_BASE_URL}/${endpoint}?${query}`, {
      signal: controller.signal
    });
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new FinnhubInsightError(`Finnhub returned an unreadable response (HTTP ${response.status}).`, response.status);
    }
    if (!response.ok) {
      const reason = response.status === 403
        ? 'This endpoint is not available to the current Finnhub key or plan.'
        : 'Check the API key, plan access, and rate limit.';
      throw new FinnhubInsightError(
        `Finnhub request failed (HTTP ${response.status}). ${reason}`,
        response.status
      );
    }
    if (typeof data === 'object' && data !== null && !Array.isArray(data) && 'error' in data) {
      const message = 'error' in data && typeof data.error === 'string' ? data.error : 'Finnhub could not provide this data.';
      throw new FinnhubInsightError(message);
    }
    cache.set(cacheKey, { expiresAt: now + INSIGHT_CACHE_TTL_MS, value: data });
    return data;
  } catch (error) {
    if (error instanceof FinnhubInsightError) throw error;
    if (controller.signal.aborted) {
      throw new FinnhubInsightError(`Finnhub request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`);
    }
    throw new FinnhubInsightError(`Finnhub request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

export function clearFinnhubInsightCache(): void {
  cache.clear();
}
