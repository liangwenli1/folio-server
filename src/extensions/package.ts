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

// The package's icon for the library page: the largest declared one up to 128 px (else the smallest), as a data URL;
// none over 64 KB.
const ICON_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', svg: 'image/svg+xml', webp: 'image/webp', gif: 'image/gif' };
function iconOf(zip: Buffer, m: Record<string, any>){
  const declared = { ...m.browser_action?.default_icon, ...m.action?.default_icon, ...m.icons } as Record<string, unknown>;
  const sized = Object.entries(declared).map(([k, v]) => [Number(k), v] as const).filter((x): x is readonly [number, string] => x[0] > 0 && typeof x[1] === 'string');
  const pick = sized.filter(([n]) => n <= 128).sort((a, b) => b[0] - a[0])[0] ?? sized.sort((a, b) => a[0] - b[0])[0];
  if (!pick) return null;
  const path = pick[1].replace(/^\.?\//, ''), type = ICON_TYPES[path.split('.').pop()!.toLowerCase()];
  if (!type) return null;
  let file: Uint8Array | undefined;
  try { file = unzipSync(new Uint8Array(zip), { filter: f => f.name === path })[path]; } catch { return null; }
  return file && file.length <= 64 * 1024 ? `data:${type};base64,${Buffer.from(file).toString('base64')}` : null;
}

// Name, version, (Firefox) add-on id and icon from manifest.json; a name like __MSG_appName__ comes from its locale file.
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
  return { zip, name: name.slice(0, 120), version: m.version.slice(0, 40), geckoId: typeof geckoId === 'string' ? geckoId : null, icon: iconOf(zip, m) };
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
