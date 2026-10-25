import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buy, chromiumProfile, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type Headers = Record<string, string>;
const post = (url: string, headers: Headers, payload: object) => t.app.inject({ method: 'POST', url, headers, payload });
const list = async (headers: Headers, ws: string, trash = false) =>
  (await t.app.inject({ url: `/workspaces/${ws}/profiles${trash ? '?trash=1' : ''}`, headers })).json().profiles as { id: string; number: number; name: string; tags: string[]; groupId: string | null; proxyId: string | null; version: number }[];
const batch = (headers: Headers, ws: string, body: object) => post(`/workspaces/${ws}/profiles/batch`, headers, body);

describe('creating profiles', () => {
  it('numbers them per workspace and counts them as usage', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const a = await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('US-Store-01', { tags: ['flagship'] }));
    expect(a.statusCode).toBe(201);
    expect(a.json()).toMatchObject({ number: 1, name: 'US-Store-01', kernel: 'chromium', tags: ['flagship'], version: 0 });
    expect((await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('US-Store-02'))).json().number).toBe(2);
    const ws = (await t.app.inject({ url: `/workspaces/${workspaceId}`, headers })).json();
    expect(ws.usage.profiles).toBe(2);
  });

  it('stops at the plan limit; the trash does not count', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const bulk = await post(`/workspaces/${workspaceId}/profiles/bulk`, headers, { profiles: [1, 2, 3, 4, 5].map(i => chromiumProfile(`P${i}`)) });
    expect(bulk.statusCode).toBe(201);
    const over = await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('P6'));
    expect(over.statusCode).toBe(403);
    expect(over.json().error.code).toBe('plan_limit');

    const [first] = await list(headers, workspaceId);
    await batch(headers, workspaceId, { ids: [first.id], action: 'trash' });
    expect((await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('P6'))).statusCode).toBe(201);
    const restore = await batch(headers, workspaceId, { ids: [first.id], action: 'restore' });
    expect(restore.json().error.code).toBe('plan_limit');
    expect(await list(headers, workspaceId, true)).toHaveLength(1);
  });

  it('imports all or nothing', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const res = await post(`/workspaces/${workspaceId}/profiles/bulk`, headers, { profiles: [1, 2, 3, 4, 5, 6].map(i => chromiumProfile(`P${i}`)) });
    expect(res.json().error.code).toBe('plan_limit');
    expect(await list(headers, workspaceId)).toHaveLength(0);
  });

  it('allows the larger limit of a paid plan', async () => {
    const { headers, workspaceId } = await signup(t.app);
    await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const res = await post(`/workspaces/${workspaceId}/profiles/bulk`, headers, { profiles: Array.from({ length: 20 }, (_, i) => chromiumProfile(`S${i}`)) });
    expect(res.json().profiles.map((p: { number: number }) => p.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('rejects a fingerprint for the other engine', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const res = await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('X', { kernel: 'firefox', kernelVersion: '156.0.1-beta.36' }));
    expect(res.json().error.code).toBe('fingerprint_kernel');
  });

  it('keeps other workspaces out', async () => {
    const a = await signup(t.app), b = await signup(t.app);
    const proxy = (await post(`/workspaces/${b.workspaceId}/proxies`, b.headers, { type: 'http', host: 'p.example.net', port: 8080 })).json();
    const res = await post(`/workspaces/${a.workspaceId}/profiles`, a.headers, chromiumProfile('X', { proxyId: proxy.id }));
    expect(res.json().error.code).toBe('bad_reference');
    expect((await t.app.inject({ url: `/workspaces/${a.workspaceId}/profiles`, headers: b.headers })).statusCode).toBe(404);
  });
});

describe('editing profiles', () => {
  it('detects edits based on an old version', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const p = (await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('Old name'))).json();
    const ok = await t.app.inject({ method: 'PATCH', url: `/profiles/${p.id}`, headers, payload: { version: 0, name: 'New name', timezoneOverride: 'Asia/Shanghai' } });
    expect(ok.json()).toMatchObject({ name: 'New name', timezoneOverride: 'Asia/Shanghai', version: 1 });
    const stale = await t.app.inject({ method: 'PATCH', url: `/profiles/${p.id}`, headers, payload: { version: 0, name: 'Lost update' } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('stale');
  });

  it('moves, tags, re-proxies, trashes, restores and purges in bulk', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const ids = (await post(`/workspaces/${workspaceId}/profiles/bulk`, headers, { profiles: [chromiumProfile('A'), chromiumProfile('B')] })).json().profiles.map((p: { id: string }) => p.id);
    const group = (await post(`/workspaces/${workspaceId}/groups`, headers, { name: 'US stores' })).json();
    const proxy = (await post(`/workspaces/${workspaceId}/proxies`, headers, { type: 'socks5', host: 'us.example.net', port: 1080 })).json();

    expect((await batch(headers, workspaceId, { ids, action: 'move', groupId: group.id })).json().updated).toBe(2);
    await batch(headers, workspaceId, { ids, action: 'tag', tag: 'q4' });
    await batch(headers, workspaceId, { ids, action: 'tag', tag: 'q4' });
    await batch(headers, workspaceId, { ids: [ids[0]], action: 'untag', tag: 'q4' });
    await batch(headers, workspaceId, { ids, action: 'set-proxy', proxyId: proxy.id });
    const now = await list(headers, workspaceId);
    expect(now.map(p => [p.name, p.groupId === group.id, p.tags, p.proxyId === proxy.id])).toEqual([['A', true, [], true], ['B', true, ['q4'], true]]);

    const groups = (await t.app.inject({ url: `/workspaces/${workspaceId}/groups`, headers })).json().groups;
    expect(groups).toEqual([{ id: group.id, name: 'US stores', color: 'gray', profiles: 2 }]);

    await batch(headers, workspaceId, { ids, action: 'trash' });
    expect(await list(headers, workspaceId)).toHaveLength(0);
    // The Trash says who moved them there; restoring forgets it.
    const me = (await t.app.inject({ url: '/me', headers })).json().user.id;
    expect((await list(headers, workspaceId, true)).map(p => (p as { deletedBy?: string }).deletedBy)).toEqual([me, me]);
    await batch(headers, workspaceId, { ids: [ids[0]], action: 'restore' });
    expect((await list(headers, workspaceId)).map(p => (p as { deletedBy?: string | null }).deletedBy)).toEqual([null]);
    expect((await batch(headers, workspaceId, { ids, action: 'purge' })).json().updated).toBe(1);
    expect((await list(headers, workspaceId)).map(p => p.name)).toEqual(['A']);
  });

  it('keeps the fingerprint choices made in the app, and refuses others', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const p = (await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('A', { fingerprint: { kind: 'chromium', seed: 7, hardwareConcurrency: 8, canvas: 'real', webgl: 'real' } }))).json();
    expect(p.fingerprint).toMatchObject({ canvas: 'real', webgl: 'real' });
    expect((await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('B', { fingerprint: { kind: 'chromium', seed: 7, hardwareConcurrency: 8, canvas: 'off' } }))).statusCode).toBe(400);
    const edited = await t.app.inject({ method: 'PATCH', url: `/profiles/${p.id}`, headers, payload: { version: 0, fingerprint: { kind: 'chromium', seed: 7, hardwareConcurrency: 8 } } });
    expect(edited.json().fingerprint).toEqual({ kind: 'chromium', seed: 7, hardwareConcurrency: 8 });
  });

  it('keeps each profile’s search engine and tab setting, one at a time or in bulk', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const [a, b] = (await post(`/workspaces/${workspaceId}/profiles/bulk`, headers, { profiles: [chromiumProfile('A'), chromiumProfile('B', { searchEngine: 'baidu', restoreTabs: false })] })).json().profiles;
    expect([a, b].map(p => [p.searchEngine, p.restoreTabs])).toEqual([['none', true], ['baidu', false]]);
    expect((await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('C', { searchEngine: 'altavista' }))).statusCode).toBe(400);

    const edited = await t.app.inject({ method: 'PATCH', url: `/profiles/${a.id}`, headers, payload: { version: 0, searchEngine: 'duckduckgo' } });
    expect(edited.json()).toMatchObject({ searchEngine: 'duckduckgo', restoreTabs: true });
    // Only what is given changes.
    expect((await batch(headers, workspaceId, { ids: [a.id, b.id], action: 'set-browser', restoreTabs: true })).json().updated).toBe(2);
    await batch(headers, workspaceId, { ids: [b.id], action: 'set-browser', searchEngine: 'google' });
    expect((await list(headers, workspaceId)).map(p => [p.name, (p as { searchEngine?: string }).searchEngine, (p as { restoreTabs?: boolean }).restoreTabs]))
      .toEqual([['A', 'duckduckgo', true], ['B', 'google', true]]);
    expect((await batch(headers, workspaceId, { ids: [a.id], action: 'set-browser' })).statusCode).toBe(400);
  });

  it('gives a group a colour when it is made or later, without logging it as a rename', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const group = (await post(`/workspaces/${workspaceId}/groups`, headers, { name: 'EU', color: 'blue' })).json();
    expect(group).toMatchObject({ name: 'EU', color: 'blue' });
    expect((await post(`/workspaces/${workspaceId}/groups`, headers, { name: 'Bad', color: 'neon' })).statusCode).toBe(400);
    const patch = (payload: object) => t.app.inject({ method: 'PATCH', url: `/groups/${group.id}`, headers, payload });
    expect((await patch({ color: 'teal' })).json()).toEqual({ id: group.id, name: 'EU', color: 'teal' });
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ name: 'Europe' })).json()).toEqual({ id: group.id, name: 'Europe', color: 'teal' });
    const log = (await t.app.inject({ url: `/workspaces/${workspaceId}/activity`, headers })).json().entries.filter((e: { action: string }) => e.action === 'group.rename');
    expect(log).toHaveLength(1);
  });

  it('leaves profiles in place when their group is deleted', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const group = (await post(`/workspaces/${workspaceId}/groups`, headers, { name: 'Temp' })).json();
    await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('A', { groupId: group.id }));
    expect((await t.app.inject({ method: 'DELETE', url: `/groups/${group.id}`, headers })).statusCode).toBe(204);
    expect((await list(headers, workspaceId))[0].groupId).toBeNull();
  });
});

describe('what the app learns about a profile', () => {
  it('remembers where it last went out and the time before, its health report, and each person\'s favourites', async () => {
    const o = await signup(t.app);
    await buy(t.app, o.headers, o.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const p = (await post(`/workspaces/${o.workspaceId}/profiles`, o.headers, chromiumProfile('Shop-1'))).json();
    expect(p).toMatchObject({ lastExit: null, prevExit: null, report: null, starred: false });
    const seattle = { country: 'US', countryName: 'United States', region: 'Washington', city: 'Seattle', lat: 47.6, lon: -122.3, timezone: 'America/Los_Angeles', locale: 'en-US' };
    const exit = (ip: string, geo: object | null) => post(`/profiles/${p.id}/exit`, o.headers, { ip, geo });
    const one = async () => (await t.app.inject({ url: `/workspaces/${o.workspaceId}/profiles`, headers: o.headers })).json().profiles[0];
    expect((await exit('172.58.1.2', seattle)).statusCode).toBe(204);
    await exit('172.58.1.2', seattle);
    expect(await one()).toMatchObject({ lastExit: { ip: '172.58.1.2', geo: { city: 'Seattle' } }, prevExit: null });
    await exit('81.2.69.160', null);
    expect(await one()).toMatchObject({ lastExit: { ip: '81.2.69.160', geo: null }, prevExit: { ip: '172.58.1.2' } });

    const report = { checks: [{ id: 'webrtc', ok: true, seen: 'none', want: null }, { id: 'timezone', ok: false, seen: 'Asia/Shanghai', want: 'America/Los_Angeles' }], canvas: 'a1b2', webgl: null };
    expect((await t.app.inject({ method: 'PUT', url: `/profiles/${p.id}/report`, headers: o.headers, payload: report })).statusCode).toBe(204);
    expect((await one()).report).toMatchObject({ ...report, at: expect.any(String) });
    expect((await t.app.inject({ method: 'PUT', url: `/profiles/${p.id}/report`, headers: o.headers, payload: { ...report, checks: [{ id: 'nope', ok: true, seen: '', want: null }] } })).statusCode).toBe(400);

    // Stars are per person: someone else in the team doesn't see them.
    expect((await t.app.inject({ method: 'PUT', url: `/profiles/${p.id}/star`, headers: o.headers })).statusCode).toBe(204);
    await t.app.inject({ method: 'PUT', url: `/profiles/${p.id}/star`, headers: o.headers });
    expect((await one()).starred).toBe(true);
    const other = await signup(t.app);
    expect((await t.app.inject({ method: 'PUT', url: `/profiles/${p.id}/star`, headers: other.headers })).statusCode).toBe(404);
    await t.app.inject({ method: 'DELETE', url: `/profiles/${p.id}/star`, headers: o.headers });
    expect((await one()).starred).toBe(false);
  });
});

describe('launch details', () => {
  it('include the proxy password and its backup line, but not for profiles in the trash', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const backup = (await post(`/workspaces/${workspaceId}/proxies`, headers, { type: 'http', host: 'b.example.net', port: 3128 })).json();
    const proxy = (await post(`/workspaces/${workspaceId}/proxies`, headers, { type: 'socks5', host: 'a.example.net', port: 1080, username: 'u1', password: 'p@ss:word', backupId: backup.id })).json();
    const p = (await post(`/workspaces/${workspaceId}/profiles`, headers, chromiumProfile('A', { proxyId: proxy.id }))).json();
    const launch = (await t.app.inject({ url: `/profiles/${p.id}/launch`, headers })).json();
    expect(launch.proxy).toMatchObject({ type: 'socks5', host: 'a.example.net', username: 'u1', password: 'p@ss:word' });
    expect(launch.backup).toMatchObject({ host: 'b.example.net', password: null });

    await batch(headers, workspaceId, { ids: [p.id], action: 'trash' });
    expect((await t.app.inject({ url: `/profiles/${p.id}/launch`, headers })).json().error.code).toBe('in_trash');
  });
});
