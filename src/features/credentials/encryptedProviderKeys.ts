const ENVELOPE_VERSION = 1;
const PBKDF2_ITERATIONS = 310_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface ProviderKeys {
  finnhub: string;
  alphaVantage: string;
  twelveData: string;
  rapidApiYahoo: string;
}

interface EncryptedProviderKeysEnvelope {
  version: typeof ENVELOPE_VERSION;
  kdf: 'PBKDF2-SHA-256';
  iterations: typeof PBKDF2_ITERATIONS;
  cipher: 'AES-256-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: unknown, name: string): Uint8Array {
  if (typeof value !== 'string') throw new Error(`Encrypted provider keys have invalid ${name}.`);
  try {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch {
    throw new Error(`Encrypted provider keys have invalid ${name}.`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

async function deriveAesKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(encoder.encode(secret)),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: toArrayBuffer(salt),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256'
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function encryptProviderKeys(
  keys: ProviderKeys,
  unlockKey: string
): Promise<EncryptedProviderKeysEnvelope> {
  if (!unlockKey.trim()) throw new Error('Gemini key is required to encrypt provider keys.');
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveAesKey(unlockKey, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: toArrayBuffer(iv) },
    key,
    toArrayBuffer(encoder.encode(JSON.stringify(keys)))
  );
  return {
    version: ENVELOPE_VERSION,
    kdf: 'PBKDF2-SHA-256',
    iterations: PBKDF2_ITERATIONS,
    cipher: 'AES-256-GCM',
    salt: bytesToBase64(salt),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(ciphertext))
  };
}

export async function decryptProviderKeys(
  value: unknown,
  unlockKey: string
): Promise<ProviderKeys> {
  if (!unlockKey.trim()) throw new Error('Gemini key is required to unlock provider keys.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Encrypted provider-keys file has an invalid structure.');
  }
  const envelope = value as Partial<EncryptedProviderKeysEnvelope>;
  if (
    envelope.version !== ENVELOPE_VERSION ||
    envelope.kdf !== 'PBKDF2-SHA-256' ||
    envelope.iterations !== PBKDF2_ITERATIONS ||
    envelope.cipher !== 'AES-256-GCM'
  ) {
    throw new Error('Encrypted provider-keys file uses an unsupported format.');
  }
  const salt = base64ToBytes(envelope.salt, 'salt');
  const iv = base64ToBytes(envelope.iv, 'initialization vector');
  const ciphertext = base64ToBytes(envelope.ciphertext, 'ciphertext');
  if (salt.length !== SALT_LENGTH || iv.length !== IV_LENGTH || ciphertext.length < 16) {
    throw new Error('Encrypted provider-keys file is incomplete.');
  }

  let plaintext: ArrayBuffer;
  try {
    const key = await deriveAesKey(unlockKey, salt);
    plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: toArrayBuffer(iv) },
      key,
      toArrayBuffer(ciphertext)
    );
  } catch {
    throw new Error('Gemini key did not unlock the encrypted provider keys.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(plaintext));
  } catch {
    throw new Error('Decrypted provider keys contain invalid data.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Decrypted provider keys have an invalid structure.');
  }
  const keys = parsed as Record<string, unknown>;
  return {
    finnhub: typeof keys.finnhub === 'string' ? keys.finnhub : '',
    alphaVantage: typeof keys.alphaVantage === 'string' ? keys.alphaVantage : '',
    twelveData: typeof keys.twelveData === 'string' ? keys.twelveData : '',
    rapidApiYahoo: typeof keys.rapidApiYahoo === 'string' ? keys.rapidApiYahoo : ''
  };
}
