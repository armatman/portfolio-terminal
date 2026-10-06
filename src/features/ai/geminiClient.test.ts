import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearGeminiModelCache,
  generateIntentText,
  GeminiApiError,
  listGeminiModels
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
