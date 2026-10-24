import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { newestFirst } from '../src/kernels/routes.js';
import { chromiumProfile, setup, signup, uniqueEmail } from './helpers.js';

const ADMIN = uniqueEmail();
let t: Awaited<ReturnType<typeof setup>>;
let admin: Awaited<ReturnType<typeof signup>>;
beforeAll(async () => { t = await setup({ admins: [ADMIN] }); admin = await signup(t.app, { email: ADMIN }); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
type K = { id: string; kind: string; version: string; platform: string; recommended: boolean; ready: boolean; source: string; profiles: number | null; size: number; createdAt: string; recommendedAt: string | null; note: string | null };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const list = async (headers: H) => (await call('GET', '/kernels', headers)).json().kernels as K[];
// Different bytes on every run: the bucket outlives the test database.
const PKG = Buffer.from(`not really an engine, but the bytes are what count ${randomUUID()}`);
const sha = createHash('sha256').update(PKG).digest('hex');
const upload = { kind: 'chromium', version: '151.0.7900.10', platform: 'win32-x64', archive: 'zip', size: PKG.length, sha256: sha, note: 'Chrome 151 security fixes' };

describe('the engine catalog', () => {
  it('starts with the upstream releases, recommended, and points downloads at them', async () => {
    const u = await signup(t.app);
    const all = await list(u.headers);
    expect(all.map(k => `${k.kind} ${k.version} ${k.platform}`)).toEqual([
      'chromium 150.0.7871.186 linux-x64', 'chromium 150.0.7871.186 win32-x64', 'chromium 148.0.7778.215 darwin-arm64', 'chromium 148.0.7778.215 darwin-x64',
      'firefox 156.0.1-beta.36 darwin-arm64', 'firefox 156.0.1-beta.36 darwin-x64', 'firefox 156.0.1-beta.36 linux-x64', 'firefox 156.0.1-beta.36 win32-x64'
    ]);
    expect(all.every(k => k.recommended && k.ready && k.source === 'upstream' && k.profiles === null && k.note === null)).toBe(true);
    // Recommended since they were added, for the history on the engines page.
    expect(all.every(k => k.recommendedAt === k.createdAt)).toBe(true);
    const win = all.find(k => k.kind === 'firefox' && k.platform === 'win32-x64')!;
    expect(win.size).toBe(1311638126);
    expect((await call('GET', `/kernels/${win.id}/download`, u.headers)).json().url).toBe('https://github.com/daijro/camoufox/releases/download/v156.0.1-beta.36/camoufox-156.0.1-beta.36-win.x86_64.zip');
    expect((await call('GET', '/me', u.headers)).json().admin).toBe(false);
  });

  it('takes new versions from platform admins only, uploaded straight to storage and checked before they appear', async () => {
    const u = await signup(t.app), a = admin;
    expect((await call('GET', '/me', a.headers)).json().admin).toBe(true);
    expect((await call('POST', '/kernels', u.headers, upload)).json().error.code).toBe('forbidden');

    const res = await call('POST', '/kernels', a.headers, upload);
    expect(res.statusCode).toBe(201);
    const { kernel, uploadUrl } = res.json() as { kernel: K; uploadUrl: string };
    expect(kernel).toMatchObject({ source: 'folio', ready: false, recommended: false });
    // Not finished: nothing stored yet, so it stays out of the catalog.
    expect((await call('POST', `/kernels/${kernel.id}/complete`, a.headers)).json().error.code).toBe('upload_incomplete');
    expect((await list(u.headers)).some(k => k.id === kernel.id)).toBe(false);
    expect((await list(a.headers)).find(k => k.id === kernel.id)?.ready).toBe(false);

    expect((await fetch(uploadUrl, { method: 'PUT', body: PKG })).status).toBe(200);
    expect((await call('POST', `/kernels/${kernel.id}/complete`, a.headers)).json()).toMatchObject({ ready: true });
    const seen = (await list(u.headers)).find(k => k.id === kernel.id)!;
    expect(seen).toMatchObject({ version: '151.0.7900.10', recommended: false, profiles: null, note: 'Chrome 151 security fixes', recommendedAt: null });
    // Newest first within the engine.
    expect((await list(u.headers)).filter(k => k.kind === 'chromium').map(k => k.version)[0]).toBe('151.0.7900.10');
    const { url } = (await call('GET', `/kernels/${kernel.id}/download`, u.headers)).json();
    expect(Buffer.from(await (await fetch(url)).arrayBuffer())).toEqual(PKG);
    expect((await call('POST', '/kernels', a.headers, upload)).json().error.code).toBe('kernel_exists');
  });

  it('recommends a version on the systems it is built for and removes versions with their package', async () => {
    const u = await signup(t.app), a = admin;
    await call('POST', `/workspaces/${u.workspaceId}/profiles`, u.headers, chromiumProfile('On 151', { kernelVersion: '151.0.7900.10' }));
    const mine = (await list(a.headers)).find(k => k.version === '151.0.7900.10')!;
    expect(mine.profiles).toBeGreaterThanOrEqual(1);

    expect((await call('PATCH', `/kernels/${mine.id}`, u.headers, { recommended: true })).json().error.code).toBe('forbidden');
    await call('PATCH', `/kernels/${mine.id}`, a.headers, { recommended: true, note: 'Now the default for Windows' });
    const after = await list(u.headers);
    const made = after.find(k => k.id === mine.id)!;
    expect(made.note).toBe('Now the default for Windows');
    expect(Date.now() - Date.parse(made.recommendedAt!)).toBeLessThan(60_000);
    const rec = (platform: string) => after.filter(k => k.kind === 'chromium' && k.platform === platform && k.recommended).map(k => k.version);
    expect(rec('win32-x64')).toEqual(['151.0.7900.10']);
    expect(rec('linux-x64')).toEqual(['150.0.7871.186']);
    expect(rec('darwin-arm64')).toEqual(['148.0.7778.215']);

    const { url } = (await call('GET', `/kernels/${mine.id}/download`, u.headers)).json();
    expect((await call('DELETE', `/kernels/${mine.id}`, u.headers)).statusCode).toBe(403);
    expect((await call('DELETE', `/kernels/${mine.id}`, a.headers)).statusCode).toBe(204);
    expect((await list(u.headers)).some(k => k.id === mine.id)).toBe(false);
    expect((await fetch(url)).status).toBe(404);
    expect((await call('GET', `/kernels/${mine.id}/download`, u.headers)).statusCode).toBe(404);
  });

  it('moves profiles to another version of their engine in one go, keeping their fingerprint', async () => {
    const u = await signup(t.app);
    const make = async (body: object) => (await call('POST', `/workspaces/${u.workspaceId}/profiles`, u.headers, body)).json();
    const a = await make(chromiumProfile('A', { kernelVersion: '148.0.7778.215' }));
    const b = await make(chromiumProfile('B', { kernelVersion: '148.0.7778.215' }));
    const f = await make({ name: 'F', kernel: 'firefox', kernelVersion: '156.0.1-beta.36', os: 'windows', fingerprint: { kind: 'firefox', config: { 'navigator.hardwareConcurrency': 8 } } });
    const res = await call('POST', `/workspaces/${u.workspaceId}/profiles/batch`, u.headers, { action: 'set-kernel', ids: [a.id, b.id, f.id], kernel: 'chromium', kernelVersion: '150.0.7871.186' });
    expect(res.json()).toEqual({ updated: 2 });
    const now = (await call('GET', `/workspaces/${u.workspaceId}/profiles`, u.headers)).json().profiles as { name: string; kernelVersion: string; fingerprint: unknown }[];
    expect(Object.fromEntries(now.map(p => [p.name, p.kernelVersion]))).toEqual({ A: '150.0.7871.186', B: '150.0.7871.186', F: '156.0.1-beta.36' });
    expect(now.find(p => p.name === 'A')!.fingerprint).toEqual(a.fingerprint);
    const log = (await call('GET', `/workspaces/${u.workspaceId}/activity`, u.headers)).json().entries as { action: string; detail: object }[];
    expect(log.filter(e => e.action === 'profile.set-kernel')).toHaveLength(2);
    expect(log.find(e => e.action === 'profile.set-kernel')!.detail).toEqual({ kernel: 'chromium', version: '150.0.7871.186' });
  });

  it('orders versions newest first', () => {
    expect(['148.0.7778.215', '150.0.7871.186', '99.1'].sort(newestFirst)).toEqual(['150.0.7871.186', '148.0.7778.215', '99.1']);
    expect(['156.0.1-beta.9', '156.0.1-beta.36'].sort(newestFirst)).toEqual(['156.0.1-beta.36', '156.0.1-beta.9']);
  });
});
