import { describe, expect, it } from 'vitest';
import { decryptProviderKeys, encryptProviderKeys } from './encryptedProviderKeys';

const testKeys = {
  finnhub: 'finnhub-test',
  alphaVantage: 'alpha-test',
  twelveData: '',
  rapidApiYahoo: 'rapidapi-test'
};

describe('encrypted provider keys', () => {
  it('encrypts and restores provider keys with the Gemini key', async () => {
    const envelope = await encryptProviderKeys(testKeys, 'gemini-test-key');
    expect(envelope).toMatchObject({
      version: 1,
      kdf: 'PBKDF2-SHA-256',
      cipher: 'AES-256-GCM'
    });
    expect(JSON.stringify(envelope)).not.toContain('finnhub-test');
    expect(await decryptProviderKeys(envelope, 'gemini-test-key')).toEqual(testKeys);
  });

  it('rejects an incorrect key and unsupported envelope format', async () => {
    const envelope = await encryptProviderKeys(testKeys, 'correct-key');
    await expect(decryptProviderKeys(envelope, 'wrong-key'))
      .rejects.toThrow('Gemini key did not unlock');
    await expect(decryptProviderKeys({ ...envelope, version: 99 }, 'correct-key'))
      .rejects.toThrow('unsupported format');
  });
});
