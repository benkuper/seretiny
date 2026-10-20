import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { SESSION_SECRET, GOOGLE_PHOTOS_CLIENT_ID } from '$app/env/private';
import { savedGoogleConnection, saveGoogleConnection, forgetGoogleConnection } from './db.js';

const key = () => createHash('sha256').update('seretiny/google-photos/v1\0').update(SESSION_SECRET).digest();
const recordId = (id: string) => createHash('sha256').update(id).digest('hex');
const associatedData = (id: string) => Buffer.from(`${recordId(id)}:${GOOGLE_PHOTOS_CLIENT_ID}`);

export function storeGoogleConnection(id: string, value: object, expiresAt: number) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  cipher.setAAD(associatedData(id));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  saveGoogleConnection(recordId(id), payload, expiresAt);
}

export function restoreGoogleConnection<T>(id: string): T | undefined {
  const saved = savedGoogleConnection(recordId(id));
  if (!saved) return;
  try {
    const payload = Buffer.from(saved, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key(), payload.subarray(0, 12));
    decipher.setAAD(associatedData(id));
    decipher.setAuthTag(payload.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8')) as T;
  } catch {
    // Rotating SESSION_SECRET or changing the OAuth client invalidates saved access.
    removeGoogleConnection(id);
  }
}

export function removeGoogleConnection(id: string) {
  forgetGoogleConnection(recordId(id));
}
