import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearGeminiModelCache,
  generateIntentText,
  GeminiApiError,
  listGeminiModels,
  prioritizeGeminiModels,
  shouldTryAnotherGeminiModel
} from './geminiClient';

describe('Gemini client', () => {
  beforeEach(() => clearGeminiModelCache());

  it('discovers supported models, prefers Flash, and caches results for five minutes', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response(JSON.stringify({
        models: [
          { name: 'models/gemini-pro', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-image', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/gemini-2.5-flash-native-audio-preview', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] }
        ]
      }), { status: 200 });
    };

    expect(await listGeminiModels('test-key', fetcher, 1000)).toEqual(['gemini-flash', 'gemini-pro']);
    expect(await listGeminiModels('test-key', fetcher, 2000)).toEqual(['gemini-flash', 'gemini-pro']);
    expect(calls).toBe(1);
    expect(await listGeminiModels('test-key', fetcher, 302_000)).toEqual(['gemini-flash', 'gemini-pro']);
    expect(calls).toBe(2);
  });

  it('prioritizes the newest generation, then stable Flash, Pro, and Lite models', () => {
    expect(prioritizeGeminiModels([
      'gemini-2.5-pro',
      'gemini-2.5-flash',
      'gemini-3.1-flash',
      'gemini-3.1-pro'
    ])).toEqual([
      'gemini-3.1-flash',
      'gemini-3.1-pro',
      'gemini-2.5-flash',
      'gemini-2.5-pro'
    ]);
  });

  it('bypasses a cached model catalog when a refresh is requested', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      const model = calls === 1 ? 'gemini-old' : 'gemini-current';
      return new Response(JSON.stringify({
        models: [{ name: `models/${model}`, supportedGenerationMethods: ['generateContent'] }]
      }), { status: 200 });
    };

    expect(await listGeminiModels('test-key', fetcher, 1000)).toEqual(['gemini-old']);
    expect(await listGeminiModels('test-key', fetcher, 2000, true)).toEqual(['gemini-current']);
    expect(await listGeminiModels('test-key', fetcher, 3000)).toEqual(['gemini-current']);
    expect(calls).toBe(2);
  });

  it('surfaces HTTP status and rejects malformed generation responses', async () => {
    const unavailable: typeof fetch = async () =>
      new Response(JSON.stringify({ error: { message: 'Try another model' } }), { status: 503 });
    await expect(generateIntentText('test-key', 'gemini-flash', 'prompt', unavailable))
      .rejects.toMatchObject({ name: 'GeminiApiError', status: 503 });

    const malformed: typeof fetch = async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [] } }] }), { status: 200 });
    await expect(generateIntentText('test-key', 'gemini-flash', 'prompt', malformed))
      .rejects.toThrow('empty response');
  });

  it('retries other models for quota errors but not permanent request failures', () => {
    expect(shouldTryAnotherGeminiModel(new GeminiApiError('Quota exceeded', 429))).toBe(true);
    expect(shouldTryAnotherGeminiModel(new GeminiApiError('Model unavailable', 404))).toBe(true);
    expect(shouldTryAnotherGeminiModel(new GeminiApiError(
      'Gemini generateContent failed (HTTP 400): The requested combination of response modalities (TEXT) is not supported by the model.',
      400
    ))).toBe(true);
    expect(shouldTryAnotherGeminiModel(new GeminiApiError('Bad request', 400))).toBe(false);
    expect(shouldTryAnotherGeminiModel(new Error('Quota exceeded'))).toBe(false);
  });

  it('times out requests and aborts the underlying fetch', async () => {
    let wasAborted = false;
    const stalled: typeof fetch = (_input, init) => new Promise((_, reject) => {
      init?.signal?.addEventListener('abort', () => {
        wasAborted = true;
        reject(new Error('aborted'));
      }, { once: true });
    });

    await expect(generateIntentText('test-key', 'gemini-flash', 'prompt', stalled, undefined, 5))
      .rejects.toThrow('timed out');
    expect(wasAborted).toBe(true);
  });
});
