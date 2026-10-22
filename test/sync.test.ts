import { gzipSync } from 'node:zlib';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberships } from '../src/db/schema.js';
import { PASSWORD, chromiumProfile, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
// A desktop session: bearer token and a computer name.
async function desktop(email: string, deviceName: string): Promise<H> {
  const res = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, client: 'desktop', deviceName } });
  return { authorization: `Bearer ${res.json().token}` };
}
const state = (marker: string) => gzipSync(JSON.stringify({ cookies: [{ name: 'sid', value: marker, domain: 'shop.example', path: '/' }], origins: [] }));
const upload = (id: string, headers: H, body: Buffer, stats = 'cookies=1&storageBytes=0&origins=0') =>
  t.app.inject({ method: 'PUT', url: `/profiles/${id}/data?${stats}`, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: body });

async function profileWithTwoComputers(){
  const owner = await signup(t.app);
  const p = (await req('POST', `/workspaces/${owner.workspaceId}/profiles`, owner.headers, chromiumProfile('Shop'))).json();
  return { owner, p, a: await desktop(owner.email, 'Laptop A'), b: await desktop(owner.email, 'Laptop B') };
}
const listed = async (headers: H, ws: string, id: string) =>
  (await req('GET', `/workspaces/${ws}/profiles`, headers)).json().profiles.find((x: { id: string }) => x.id === id);

describe('profile locks', () => {
  it('let one computer open a profile at a time, and show the others who has it', async () => {
    const { owner, p, a, b } = await profileWithTwoComputers();
    const first = await req('POST', `/profiles/${p.id}/lock`, a);
    expect(first.json()).toMatchObject({ data: null });
    expect((await req('POST', `/profiles/${p.id}/lock`, a)).statusCode).toBe(200);
    expect((await req('POST', `/profiles/${p.id}/lock`, b)).json().error.code).toBe('locked');

    expect((await listed(b, owner.workspaceId, p.id)).lock).toMatchObject({ email: owner.email, deviceName: 'Laptop A', self: false });
    expect((await listed(a, owner.workspaceId, p.id))).toMatchObject({ lock: { self: true }, lastOpenedAt: expect.any(String) });

    expect((await req('DELETE', `/profiles/${p.id}/lock`, b)).statusCode).toBe(204);
    expect((await listed(a, owner.workspaceId, p.id)).lock).not.toBeNull();
    await req('DELETE', `/profiles/${p.id}/lock`, a);
    expect((await listed(a, owner.workspaceId, p.id)).lock).toBeNull();
    expect((await req('POST', `/profiles/${p.id}/lock`, b)).statusCode).toBe(200);
  });

  it('expire when not renewed, after which the first computer has lost it', async () => {
    const { p, a, b } = await profileWithTwoComputers();
    await req('POST', `/profiles/${p.id}/lock`, a);
    t.clock.advanceDays(60 / 86400);
    expect((await req('POST', `/profiles/${p.id}/lock/renew`, a)).statusCode).toBe(200);
    t.clock.advanceDays(91 / 86400);
    expect((await req('POST', `/profiles/${p.id}/lock`, b)).statusCode).toBe(200);
    expect((await req('POST', `/profiles/${p.id}/lock/renew`, a)).json().error.code).toBe('lock_lost');
  });

  it('can be taken over by owners and admins, not members', async () => {
    const { owner, p, a } = await profileWithTwoComputers();
    const member = await signup(t.app);
    await t.db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: member.userId, role: 'member' });
    await req('POST', `/workspaces/${owner.workspaceId}/profiles/batch`, owner.headers, { ids: [p.id], action: 'assign', ownerId: member.userId });
    await req('POST', `/profiles/${p.id}/lock`, a);
    expect((await req('POST', `/profiles/${p.id}/lock/takeover`, member.headers)).json().error.code).toBe('forbidden');
    expect((await req('POST', `/profiles/${p.id}/lock/takeover`, owner.headers)).statusCode).toBe(204);
    expect((await req('POST', `/profiles/${p.id}/lock/renew`, a)).json().error.code).toBe('lock_lost');
  });

  it('refuse profiles in the trash', async () => {
    const { owner, p, a } = await profileWithTwoComputers();
    await req('POST', `/workspaces/${owner.workspaceId}/profiles/batch`, owner.headers, { ids: [p.id], action: 'trash' });
    expect((await req('POST', `/profiles/${p.id}/lock`, a)).json().error.code).toBe('in_trash');
  });
});

describe('saved sign-in state', () => {
  it('is written only by the computer holding the lock, and read back by the next one', async () => {
    const { owner, p, a, b } = await profileWithTwoComputers();
    await req('POST', `/profiles/${p.id}/lock`, b);
    expect((await upload(p.id, a, state('one'))).json().error.code).toBe('lock_lost');
    await req('DELETE', `/profiles/${p.id}/lock`, b);
    await req('POST', `/profiles/${p.id}/lock`, a);
    const saved = await upload(p.id, a, state('one'), 'cookies=1&storageBytes=420&origins=2');
    expect(saved.json()).toMatchObject({ version: 1, cookies: 1, storageBytes: 420, origins: 2, deviceName: 'Laptop A' });
    await req('DELETE', `/profiles/${p.id}/lock`, a);

    const lock = (await req('POST', `/profiles/${p.id}/lock`, b)).json();
    expect(lock.data).toMatchObject({ version: 1, deviceName: 'Laptop A' });
    const got = await req('GET', `/profiles/${p.id}/data`, b);
    expect(got.rawPayload.equals(state('one'))).toBe(true);
    expect(got.headers['x-folio-version']).toBe('1');
    expect((await listed(owner.headers, owner.workspaceId, p.id)).data).toMatchObject({ version: 1, cookies: 1 });

    expect((await upload(p.id, b, state('two'))).json().version).toBe(2);
    expect((await req('GET', `/profiles/${p.id}/data`, a)).rawPayload.equals(state('two'))).toBe(true);
  });

  it('is sealed in object storage, and removed with the profile and with older versions', async () => {
    const { owner, p, a } = await profileWithTwoComputers();
    await req('POST', `/profiles/${p.id}/lock`, a);
    await upload(p.id, a, state('secret-marker'));
    const s3 = new S3Client({ endpoint: t.config.s3.endpoint, region: t.config.s3.region, forcePathStyle: true, credentials: { accessKeyId: t.config.s3.accessKeyId, secretAccessKey: t.config.s3.secretAccessKey } });
    const raw = async (key: string) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket: 'folio-test', Key: key }))).Body!.transformToByteArray());
    const first = `${owner.workspaceId}/${p.id}/1`;
    expect((await raw(first)).equals(state('secret-marker'))).toBe(false);
    expect((await t.storage.get(first)).equals(state('secret-marker'))).toBe(true);

    await upload(p.id, a, state('newer'));
    await expect(raw(first)).rejects.toThrow();
    await req('DELETE', `/profiles/${p.id}/lock`, a);
    await req('POST', `/workspaces/${owner.workspaceId}/profiles/batch`, owner.headers, { ids: [p.id], action: 'trash' });
    await req('POST', `/workspaces/${owner.workspaceId}/profiles/batch`, owner.headers, { ids: [p.id], action: 'purge' });
    await expect(raw(`${owner.workspaceId}/${p.id}/2`)).rejects.toThrow();
  });

  it('can be saved the first time without the lock, when nobody has the profile open', async () => {
    const { p, a, b } = await profileWithTwoComputers();
    expect((await upload(p.id, a, state('first'))).json()).toMatchObject({ version: 1 });
    expect((await upload(p.id, a, state('second'))).json().error.code).toBe('lock_lost');
    await req('POST', `/profiles/${p.id}/lock`, b);
    expect((await upload(p.id, b, state('second'))).json()).toMatchObject({ version: 2 });
  });

  it('rejects an empty upload and answers 404 before anything is saved', async () => {
    const { p, a } = await profileWithTwoComputers();
    await req('POST', `/profiles/${p.id}/lock`, a);
    expect((await req('GET', `/profiles/${p.id}/data`, a)).statusCode).toBe(404);
    expect((await upload(p.id, a, Buffer.alloc(0))).statusCode).toBe(400);
  });
});

describe('cookies', () => {
  const cookie = (name: string, value: string, extra: object = {}) => ({ name, value, domain: '.shop.example', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax', ...extra });
  const importing = (id: string, headers: H, cookies: object[]) => t.app.inject({ method: 'POST', url: `/profiles/${id}/cookies`, headers, payload: { cookies } });

  it('are exported by owners and admins only, from the saved state', async () => {
    const { owner, p, a } = await profileWithTwoComputers();
    expect((await req('GET', `/profiles/${p.id}/cookies`, owner.headers)).statusCode).toBe(404);
    await req('POST', `/profiles/${p.id}/lock`, a);
    await upload(p.id, a, state('one'));
    const got = (await req('GET', `/profiles/${p.id}/cookies`, owner.headers)).json();
    expect(got.cookies).toMatchObject([{ name: 'sid', value: 'one', domain: 'shop.example' }]);
    const member = await signup(t.app);
    await t.db.insert(memberships).values({ workspaceId: owner.workspaceId, userId: member.userId, role: 'member' });
    await req('POST', `/workspaces/${owner.workspaceId}/profiles/batch`, owner.headers, { ids: [p.id], action: 'assign', ownerId: member.userId });
    expect((await req('GET', `/profiles/${p.id}/cookies`, member.headers)).json().error.code).toBe('forbidden');
    const log = (await req('GET', `/workspaces/${owner.workspaceId}/activity?kind=cookies`, owner.headers)).json().entries;
    expect(log.map((e: { action: string; detail: object }) => [e.action, e.detail])).toEqual([['cookies.export', { count: 1 }]]);
  });

  it('are merged into the saved state on import, unless another computer has the profile open', async () => {
    const { owner, p, a, b } = await profileWithTwoComputers();
    const first = await importing(p.id, owner.headers, [cookie('sid', 'one'), cookie('pref', 'dark')]);
    expect(first.json()).toMatchObject({ version: 1, cookies: 2 });
    const second = await importing(p.id, owner.headers, [cookie('sid', 'two'), cookie('sid', 'other-path', { path: '/x' })]);
    expect(second.json()).toMatchObject({ version: 2, cookies: 3 });
    const values = (await req('GET', `/profiles/${p.id}/cookies`, owner.headers)).json().cookies.map((c: { name: string; path: string; value: string }) => `${c.name}${c.path}=${c.value}`);
    expect(values.sort()).toEqual(['pref/=dark', 'sid/=two', 'sid/x=other-path']);

    await req('POST', `/profiles/${p.id}/lock`, a);
    expect((await importing(p.id, b, [cookie('sid', 'three')])).json().error.code).toBe('locked');
    expect((await importing(p.id, a, [cookie('sid', 'three')])).statusCode).toBe(200);
  });
});

describe('profiles kept on one computer', () => {
  it('drop the saved state, refuse uploads and cookie transfers, and sync again when switched back', async () => {
    const { owner, p, a } = await profileWithTwoComputers();
    await req('POST', `/profiles/${p.id}/lock`, a);
    await upload(p.id, a, state('one'));
    const local = (await t.app.inject({ method: 'PATCH', url: `/profiles/${p.id}`, headers: owner.headers, payload: { version: p.version, syncMode: 'local' } })).json();
    expect(local).toMatchObject({ syncMode: 'local', data: null });
    expect((await upload(p.id, a, state('two'))).json().error.code).toBe('local_only');
    expect((await req('GET', `/profiles/${p.id}/cookies`, owner.headers)).json().error.code).toBe('local_only');
    expect((await t.app.inject({ method: 'POST', url: `/profiles/${p.id}/cookies`, headers: owner.headers, payload: { cookies: [{ name: 'a', value: 'b', domain: 'x.example' }] } })).json().error.code).toBe('local_only');
    await expect(t.storage.get(`${owner.workspaceId}/${p.id}/1`)).rejects.toThrow();

    await t.app.inject({ method: 'PATCH', url: `/profiles/${p.id}`, headers: owner.headers, payload: { version: local.version, syncMode: 'cloud' } });
    expect((await upload(p.id, a, state('three'))).json()).toMatchObject({ version: 1 });
  });
});
