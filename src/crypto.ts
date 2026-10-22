// AES-256-GCM for data at rest (proxy passwords, saved sign-in state). Sealed form: iv | tag | ciphertext.
// Ed25519 signatures for extension packages, with a key derived from the same secret.
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { config } from './config.js';

// Outside production a fixed development key is used when SECRET_KEY is unset (config.ts refuses that in production).
const key = config.secretKey ? Buffer.from(config.secretKey, 'base64') : createHash('sha256').update('folio-development-key').digest();
if (key.length !== 32) throw new Error('SECRET_KEY must be 32 bytes, base64-encoded');

export function sealBytes(plain: Buffer){
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}

export function openBytes(sealed: Buffer){
  const d = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, 12));
  d.setAuthTag(sealed.subarray(12, 28));
  return Buffer.concat([d.update(sealed.subarray(28)), d.final()]);
}

// Strings (proxy passwords) are stored as base64 text.
export const seal = (plain: string) => sealBytes(Buffer.from(plain, 'utf8')).toString('base64');
export const open = (sealed: string) => openBytes(Buffer.from(sealed, 'base64')).toString('utf8');

// The signing key is derived from SECRET_KEY, so there is no second secret to keep. The desktop app checks
// extension packages against the public half before installing them.
const signer = createPrivateKey({
  key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(hkdfSync('sha256', key, 'folio', 'extension signing', 32))]),
  format: 'der', type: 'pkcs8'
});
export const signingPublicKey = createPublicKey(signer).export({ type: 'spki', format: 'der' }).toString('base64');
export const signText = (text: string) => sign(null, Buffer.from(text, 'utf8'), signer).toString('base64');
