import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// AES-256-GCM with a key derived from BETTER_AUTH_SECRET. The HKDF salt is
// specific to the SSO client secret so this key never matches another feature's.
const SALT = Buffer.from('bunnyfile-sso-settings-v1', 'utf8');
const INFO = Buffer.from('AES-256-GCM-key', 'utf8');

function deriveKey(): Buffer {
  const secret = Bun.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is required to encrypt SSO settings');
  return Buffer.from(hkdfSync('sha256', secret, SALT, INFO, 32));
}

/** Returns `<iv hex>:<ciphertext+tag hex>`. A fresh random IV is used per call. */
export function encryptSsoSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${Buffer.concat([encrypted, cipher.getAuthTag()]).toString('hex')}`;
}

/** Throws if the value is malformed, tampered with, or the secret has changed. */
export function decryptSsoSecret(stored: string): string {
  const colon = stored.indexOf(':');
  if (colon < 0) throw new Error('invalid encrypted secret format');
  const iv = Buffer.from(stored.slice(0, colon), 'hex');
  const data = Buffer.from(stored.slice(colon + 1), 'hex');
  if (iv.length !== 12 || data.length < 16) throw new Error('invalid encrypted secret format');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(), iv);
  decipher.setAuthTag(data.subarray(data.length - 16));
  return (
    decipher.update(data.subarray(0, data.length - 16)).toString('utf8') + decipher.final('utf8')
  );
}
