export interface GeminiModel {
  name: string;
  supportedGenerationMethods?: string[];
}

interface GeminiModelsResponse {
  models?: GeminiModel[];
  error?: { message?: string };
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
  }>;
  error?: { message?: string };
}

export class GeminiApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'GeminiApiError';
  }
}

export function shouldTryAnotherGeminiModel(error: unknown): boolean {
  return error instanceof GeminiApiError &&
    (error.status === 404 || error.status === 429 || error.status === 503);
}

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 30 * 1000;
const modelCache = new Map<string, { expiresAt: number; models: string[] }>();

async function keyFingerprint(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

async function fetchWithTimeout<T>(
  input: RequestInfo | URL,
  init: RequestInit,
  operation: string,
  fetcher: typeof fetch,
  parseResponse: (response: Response) => Promise<T>,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  const controller = new AbortController();
  const externalSignal = init.signal;
  const abortFromExternal = () => controller.abort(externalSignal?.reason);
  externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);

  try {
    const response = await fetcher(input, { ...init, signal: controller.signal });
    return await parseResponse(response);
  } catch (error) {
    if (controller.signal.aborted && !externalSignal?.aborted) {
      throw new GeminiApiError(`Gemini ${operation} timed out after ${timeoutMs / 1000} seconds.`);
    }
    if (error instanceof GeminiApiError) throw error;
    throw new GeminiApiError(`Gemini ${operation} request failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortFromExternal);
  }
}

async function readJson<T extends { error?: { message?: string } }>(response: Response, operation: string): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new GeminiApiError(`Gemini ${operation} returned an unreadable response (HTTP ${response.status}).`, response.status);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new GeminiApiError(`Gemini ${operation} returned an invalid response (HTTP ${response.status}).`, response.status);
  }
  const payload = data as T;
  if (!response.ok || payload.error) {
    throw new GeminiApiError(
      `Gemini ${operation} failed (HTTP ${response.status}): ${payload.error?.message || response.statusText || 'Request failed'}`,
      response.status
    );
  }
  return payload;
}

export async function listGeminiModels(
  apiKey: string,
  fetcher: typeof fetch = fetch,
  now = Date.now()
): Promise<string[]> {
  if (!apiKey.trim()) throw new GeminiApiError('Gemini API key is missing.');

  const fingerprint = await keyFingerprint(apiKey);
  const cached = modelCache.get(fingerprint);
  if (cached && cached.expiresAt > now) return [...cached.models];

  return fetchWithTimeout(`${API_BASE}/models`, {
    headers: { 'x-goog-api-key': apiKey }
  }, 'model discovery', fetcher, async response => {
    const data = await readJson<GeminiModelsResponse>(response, 'model discovery');
    const models = (Array.isArray(data.models) ? data.models : [])
      .filter((model): model is GeminiModel =>
        typeof model === 'object' &&
        model !== null &&
        typeof model.name === 'string' &&
        !/image/i.test(model.name) &&
        Array.isArray(model.supportedGenerationMethods) &&
        model.supportedGenerationMethods.includes('generateContent')
      )
      .map(model => model.name.replace(/^models\//, ''))
      .sort((a, b) => Number(b.includes('flash')) - Number(a.includes('flash')) || a.localeCompare(b));

    if (models.length === 0) throw new GeminiApiError('Gemini returned no models available for generateContent.');
    modelCache.set(fingerprint, { expiresAt: now + MODEL_CACHE_TTL_MS, models });
    return [...models];
  });
}

export async function generateIntentText(
  apiKey: string,
  model: string,
  prompt: string,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<string> {
  if (!apiKey.trim()) throw new GeminiApiError('Gemini API key is missing.');
  return fetchWithTimeout(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json' }
    }),
    signal
  }, `generateContent with ${model}`, fetcher, async response => {
    const data = await readJson<GeminiGenerateResponse>(response, `generateContent with ${model}`);
    const candidate = data.candidates?.[0];
    if (!candidate?.content?.parts) {
      const reason = candidate?.finishReason === 'SAFETY' ? 'blocked the response for safety reasons' : 'returned no usable candidate';
      throw new GeminiApiError(`Gemini ${reason} (${model}).`);
    }
    const text = candidate.content.parts
      .map(part => part.text)
      .filter((part): part is string => typeof part === 'string')
      .join('')
      .trim();
    if (!text) throw new GeminiApiError(`Gemini returned an empty response (${model}).`);
    return text;
  }, timeoutMs);
}

export function clearGeminiModelCache(): void {
  modelCache.clear();
}
