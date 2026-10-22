import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { memberships } from '../src/db/schema.js';
import { chromiumId } from '../src/extensions/package.js';
import { buy, chromiumProfile, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const send = (method: 'POST' | 'PUT', url: string, headers: H, body: Buffer) => t.app.inject({ method, url, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: body });
const sha = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');

const zip = (files: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, strToU8(v)]))));
const CHROMIUM = zip({
  'manifest.json': JSON.stringify({ manifest_version: 3, name: '__MSG_appName__', version: '1.4.2', default_locale: 'en' }),
  '_locales/en/messages.json': JSON.stringify({ appName: { message: 'Shop Helper' } }),
  'content.js': 'document.documentElement.dataset.helper = "on";'
});
// A crx: "Cr24", version 3, header length, header, then the zip.
const crx = (z: Buffer) => { const head = Buffer.alloc(12); head.write('Cr24', 0, 'latin1'); head.writeUInt32LE(3, 4); head.writeUInt32LE(5, 8); return Buffer.concat([head, Buffer.from('xxxxx'), z]); };
const xpi = (version: string, id = 'helper@shop.example') => zip({ 'manifest.json': JSON.stringify({ manifest_version: 2, name: 'Shop Helper FF', version, browser_specific_settings: { gecko: { id } } }) });
const FIREFOX = xpi('2.0');

async function team(){
  const o = await signup(t.app);
  await buy(t.app, o.headers, o.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
  const m = await signup(t.app);
  await t.db.insert(memberships).values({ workspaceId: o.workspaceId, userId: m.userId, role: 'member' });
  return { o, m, ws: o.workspaceId };
}

describe('the extension library', () => {
  it('reads crx, zip and xpi packages, gives each a fixed identity and signs it', async () => {
    const { o, m, ws } = await team();
    const res = await send('POST', `/workspaces/${ws}/extensions?kernel=chromium&source=store&storeId=abcdefghijklmnopabcdefghijklmnop`, o.headers, crx(CHROMIUM));
    expect(res.statusCode).toBe(201);
    const e = res.json();
    expect(e).toMatchObject({ name: 'Shop Helper', version: '1.4.2', kernel: 'chromium', source: 'store', sha256: sha(CHROMIUM), size: CHROMIUM.length, profiles: 0 });
    expect(e.extId).toBe(chromiumId(Buffer.from(e.publicKey, 'base64')));
    expect(e.extId).toMatch(/^[a-p]{32}$/);
    const { publicKey } = (await call('GET', '/extensions/key', m.headers)).json();
    const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
    expect(verify(null, Buffer.from(`folio-extension:${e.id}:chromium:${e.extId}:${e.sha256}`), key, Buffer.from(e.signature, 'base64'))).toBe(true);
    expect(verify(null, Buffer.from(`folio-extension:${e.id}:chromium:${e.extId}:${'0'.repeat(64)}`), key, Buffer.from(e.signature, 'base64'))).toBe(false);

    // Everyone downloads the zip it keeps; only owners and admins change the library.
    const pkg = await call('GET', `/extensions/${e.id}/package`, m.headers);
    expect(sha(pkg.rawPayload)).toBe(e.sha256);
    expect(Object.keys(unzipSync(new Uint8Array(pkg.rawPayload)))).toContain('content.js');
    expect((await send('POST', `/workspaces/${ws}/extensions?kernel=firefox`, m.headers, FIREFOX)).statusCode).toBe(403);
    expect((await call('GET', `/workspaces/${ws}/extensions`, m.headers)).json().extensions.map((x: { name: string }) => x.name)).toEqual(['Shop Helper']);

    // Firefox keeps its add-on id; the same add-on again is an update, which keeps the identity.
    const ff = (await send('POST', `/workspaces/${ws}/extensions?kernel=firefox`, o.headers, FIREFOX)).json();
    expect(ff).toMatchObject({ kernel: 'firefox', extId: 'helper@shop.example', publicKey: null, version: '2.0' });
    expect((await send('POST', `/workspaces/${ws}/extensions?kernel=firefox`, o.headers, xpi('2.1'))).json().error.code).toBe('extension_exists');
    const updated = (await send('PUT', `/extensions/${ff.id}/package`, o.headers, xpi('2.1'))).json();
    expect(updated).toMatchObject({ id: ff.id, extId: ff.extId, version: '2.1', sha256: sha(xpi('2.1')) });
    expect(updated.signature).not.toBe(ff.signature);
    expect((await send('PUT', `/extensions/${ff.id}/package`, o.headers, xpi('3.0', 'other@x'))).json().error.code).toBe('extension_mismatch');

    expect((await send('POST', `/workspaces/${ws}/extensions?kernel=chromium`, o.headers, Buffer.from('not a zip'))).json().error.code).toBe('extension_unreadable');
    expect((await send('POST', `/workspaces/${ws}/extensions?kernel=chromium`, o.headers, zip({ 'readme.txt': 'hi' }))).json().error.code).toBe('extension_unreadable');
    const log = (await call('GET', `/workspaces/${ws}/activity?kind=extensions`, o.headers)).json().entries.map((x: { action: string; detail: object }) => [x.action, x.detail]);
    expect(log).toEqual([
      ['extension.update', { name: 'Shop Helper FF', version: '2.1', from: '2.0' }], ['extension.add', { name: 'Shop Helper FF', kernel: 'firefox', version: '2.0' }],
      ['extension.add', { name: 'Shop Helper', kernel: 'chromium', version: '1.4.2' }]
    ]);
  });

  it('installs only into profiles of its engine, travels with the launch details, and leaves them when deleted', async () => {
    const { o, m, ws } = await team();
    const cr = (await send('POST', `/workspaces/${ws}/extensions?kernel=chromium`, o.headers, CHROMIUM)).json();
    const ff = (await send('POST', `/workspaces/${ws}/extensions?kernel=firefox`, o.headers, FIREFOX)).json();
    const created = await call('POST', `/workspaces/${ws}/profiles`, o.headers, chromiumProfile('Shop-01', { extensionIds: [cr.id] }));
    expect(created.json()).toMatchObject({ extensionIds: [cr.id] });
    expect((await call('POST', `/workspaces/${ws}/profiles`, o.headers, chromiumProfile('Bad', { extensionIds: [ff.id] }))).json().error.code).toBe('extension_kernel');
    const p1 = created.json();
    const p2 = (await call('POST', `/workspaces/${ws}/profiles`, m.headers, chromiumProfile('Mine'))).json();
    const fox = (await call('POST', `/workspaces/${ws}/profiles`, o.headers, { name: 'Fox', kernel: 'firefox', kernelVersion: '156.0.1-beta.36', os: 'linux', fingerprint: { kind: 'firefox', config: {} } })).json();

    const launch = (await call('GET', `/profiles/${p1.id}/launch`, o.headers)).json();
    expect(launch.extensions).toMatchObject([{ id: cr.id, extId: cr.extId, publicKey: cr.publicKey, sha256: cr.sha256, signature: cr.signature }]);

    // A member installs into the profiles they see; the Firefox one is left out of a Chromium extension.
    const batch = (h: H, action: string, ids: string[], extensionId: string) => call('POST', `/workspaces/${ws}/profiles/batch`, h, { action, ids, extensionId });
    expect((await batch(m.headers, 'add-extension', [p2.id], cr.id)).json()).toEqual({ updated: 1 });
    expect((await batch(o.headers, 'add-extension', [p1.id, p2.id, fox.id], cr.id)).json()).toEqual({ updated: 0 });
    expect((await batch(o.headers, 'add-extension', [fox.id], ff.id)).json()).toEqual({ updated: 1 });
    expect((await call('GET', `/workspaces/${ws}/extensions`, o.headers)).json().extensions.map((x: { name: string; profiles: number }) => [x.name, x.profiles])).toEqual([['Shop Helper', 2], ['Shop Helper FF', 1]]);
    expect((await call('GET', `/workspaces/${ws}/activity?kind=profiles`, o.headers)).json().entries[0]).toMatchObject({ action: 'profile.add-extension', detail: { extension: 'Shop Helper FF' } });
    expect((await batch(m.headers, 'remove-extension', [p2.id], cr.id)).json()).toEqual({ updated: 1 });

    expect((await call('DELETE', `/extensions/${cr.id}`, m.headers)).statusCode).toBe(403);
    expect((await call('DELETE', `/extensions/${cr.id}`, o.headers)).statusCode).toBe(204);
    const after = (await call('GET', `/workspaces/${ws}/profiles`, o.headers)).json().profiles;
    expect(after.find((p: { id: string }) => p.id === p1.id).extensionIds).toEqual([]);
    expect((await call('GET', `/extensions/${cr.id}/package`, o.headers)).statusCode).toBe(404);
  });
});
