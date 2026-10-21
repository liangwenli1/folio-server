// AES-256-GCM for secrets at rest (proxy passwords). Output: base64(iv | tag | ciphertext).
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';

// Outside production a fixed development key is used when SECRET_KEY is unset (config.ts refuses that in production).
const key = config.secretKey ? Buffer.from(config.secretKey, 'base64') : createHash('sha256').update('folio-development-key').digest();
if (key.length !== 32) throw new Error('SECRET_KEY must be 32 bytes, base64-encoded');

export function seal(plain: string){
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function open(sealed: string){
  const buf = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}
