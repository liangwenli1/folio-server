// Reading an uploaded extension package: Chromium sends crx or zip, Firefox xpi (a zip). The library keeps the zip.
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { strFromU8, unzipSync } from 'fflate';
import { ApiError } from '../errors.js';
import { signText } from '../crypto.js';

export type Kernel = 'chromium' | 'firefox';

// A crx is a header ("Cr24", version, lengths, keys and proof) in front of the zip.
export function zipOf(bytes: Buffer){
  if (bytes.subarray(0, 4).toString('latin1') !== 'Cr24') return bytes;
  const version = bytes.readUInt32LE(4);
  return bytes.subarray(version === 2 ? 16 + bytes.readUInt32LE(8) + bytes.readUInt32LE(12) : 12 + bytes.readUInt32LE(8));
}

const unreadable = (why: string) => new ApiError(400, 'extension_unreadable', why);

// Name, version and (Firefox) add-on id from manifest.json; a name like __MSG_appName__ comes from its locale file.
export function readPackage(bytes: Buffer){
  const zip = zipOf(bytes);
  let files: Record<string, Uint8Array>;
  try { files = unzipSync(new Uint8Array(zip), { filter: f => f.name === 'manifest.json' || /^_locales\/[^/]+\/messages\.json$/.test(f.name) }); }
  catch { throw unreadable('Not a zip, crx or xpi file'); }
  if (!files['manifest.json']) throw unreadable('There is no manifest.json at the top of the package');
  let m: Record<string, any>;
  try { m = JSON.parse(strFromU8(files['manifest.json']).replace(/^﻿/, '')); } catch { throw unreadable('manifest.json is not valid JSON'); }
  if (![2, 3].includes(m.manifest_version) || typeof m.name !== 'string' || typeof m.version !== 'string') throw unreadable('manifest.json lacks a name, a version or a manifest_version');
  let name: string = m.name;
  const msg = name.match(/^__MSG_(\w+)__$/);
  if (msg){
    const locale = files[`_locales/${m.default_locale ?? 'en'}/messages.json`] ?? Object.entries(files).find(([k]) => k.startsWith('_locales/'))?.[1];
    const messages = locale ? JSON.parse(strFromU8(locale).replace(/^﻿/, '')) as Record<string, { message: string }> : {};
    name = Object.entries(messages).find(([k]) => k.toLowerCase() === msg[1].toLowerCase())?.[1].message ?? name;
  }
  const geckoId = m.browser_specific_settings?.gecko?.id ?? m.applications?.gecko?.id ?? null;
  return { zip, name: name.slice(0, 120), version: m.version.slice(0, 40), geckoId: typeof geckoId === 'string' ? geckoId : null };
}

// A Chromium extension's id is the first 128 bits of the sha256 of its public key, written with the letters a–p.
export const chromiumId = (spki: Buffer) => [...createHash('sha256').update(spki).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');

// A new library entry's identity: a key of its own for Chromium, the add-on id (or a new one) for Firefox.
export function identity(kernel: Kernel, geckoId: string | null){
  if (kernel === 'firefox') return { extId: geckoId ?? `${randomUUID()}@folio.extension`, publicKey: null };
  const spki = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' });
  return { extId: chromiumId(spki), publicKey: spki.toString('base64') };
}

export const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
// What the signature covers; the desktop app builds the same text to check it.
export const signedText = (e: { id: string; kernel: string; extId: string; sha256: string }) => `folio-extension:${e.id}:${e.kernel}:${e.extId}:${e.sha256}`;
export const signPackage = (e: { id: string; kernel: string; extId: string; sha256: string }) => signText(signedText(e));
