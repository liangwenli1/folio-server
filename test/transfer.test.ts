import { gunzipSync, gzipSync } from 'node:zlib';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberships } from '../src/db/schema.js';
import { buy, chromiumProfile, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const firefox = (name: string) => ({ ...chromiumProfile(name), kernel: 'firefox', kernelVersion: '156.0.1-beta.36', os: 'linux', fingerprint: { kind: 'firefox', config: { 'screen.width': 1920, 'navigator.hardwareConcurrency': 12 } } });

// A workspace worth exporting: groups, a proxy with a password and a backup line, profiles (one in the Trash).
async function source(){
  const o = await signup(t.app);
  const ws = o.workspaceId;
  const g = (await call('POST', `/workspaces/${ws}/groups`, o.headers, { name: 'EU stores' })).json();
  const backup = (await call('POST', `/workspaces/${ws}/proxies`, o.headers, { type: 'http', host: 'backup.example.net', port: 8080 })).json();
  const proxy = (await call('POST', `/workspaces/${ws}/proxies`, o.headers, { type: 'socks5', host: 'main.example.net', port: 1080, username: 'u', password: 'p@ss', backupId: backup.id })).json();
  const a = (await call('POST', `/workspaces/${ws}/profiles`, o.headers, { ...chromiumProfile('Shop-DE', { groupId: g.id, proxyId: proxy.id, tags: ['vip'], timezoneOverride: 'Europe/Berlin', searchEngine: 'bing', restoreTabs: false }) })).json();
  await call('POST', `/workspaces/${ws}/profiles`, o.headers, firefox('Social-01'));
  const gone = (await call('POST', `/workspaces/${ws}/profiles`, o.headers, chromiumProfile('Old'))).json();
  await call('POST', `/workspaces/${ws}/profiles/batch`, o.headers, { ids: [gone.id], action: 'trash' });
  await call('POST', `/profiles/${a.id}/cookies`, o.headers, { cookies: [{ name: 'sid', value: 'x', domain: 'shop.example' }] });
  return { o, ws };
}

describe('workspace export and import', () => {
  it('exports everything but the Trash, passwords included, to owners and admins', async () => {
    const { o, ws } = await source();
    const member = await signup(t.app);
    await t.db.insert(memberships).values({ workspaceId: ws, userId: member.userId, role: 'member' });
    expect((await call('GET', `/workspaces/${ws}/export`, member.headers)).json().error.code).toBe('forbidden');
    const out = (await call('GET', `/workspaces/${ws}/export`, o.headers)).json();
    expect(out.groups).toEqual(['EU stores']);
    expect(out.profiles.map((p: { name: string; saved: boolean }) => [p.name, p.saved])).toEqual([['Shop-DE', true], ['Social-01', false]]);
    const main = out.proxies.find((p: { host: string }) => p.host === 'main.example.net');
    expect(main).toMatchObject({ username: 'u', password: 'p@ss', backupRef: out.proxies.find((p: { host: string }) => p.host === 'backup.example.net').ref });
    expect(out.profiles[0]).toMatchObject({ group: 'EU stores', proxyRef: main.ref, tags: ['vip'], timezoneOverride: 'Europe/Berlin', searchEngine: 'bing', restoreTabs: false });
    const log = (await call('GET', `/workspaces/${ws}/activity?kind=cookies`, o.headers)).json().entries;
    expect(log[0]).toMatchObject({ action: 'workspace.export', detail: { profiles: 2, proxies: 2 } });
  });

  it('imports into another workspace, reusing groups and identical proxies, with new numbers', async () => {
    const { o, ws } = await source();
    const bundle = (await call('GET', `/workspaces/${ws}/export`, o.headers)).json();
    const target = await signup(t.app);
    const tws = target.workspaceId;
    await call('POST', `/workspaces/${tws}/groups`, target.headers, { name: 'EU stores' });
    await call('POST', `/workspaces/${tws}/proxies`, target.headers, { type: 'http', host: 'backup.example.net', port: 8080 });
    await call('POST', `/workspaces/${tws}/profiles`, target.headers, chromiumProfile('Already-here'));

    const res = (await call('POST', `/workspaces/${tws}/import`, target.headers, { groups: bundle.groups, proxies: bundle.proxies, profiles: bundle.profiles })).json();
    expect(res.added).toEqual({ profiles: 2, proxies: 1, groups: 0, extensions: 0 });
    const list = (await call('GET', `/workspaces/${tws}/profiles`, target.headers)).json().profiles;
    expect(list.map((p: { name: string; number: number; ownerId: string }) => [p.name, p.number, p.ownerId === target.userId])).toEqual([['Already-here', 1, true], ['Shop-DE', 2, true], ['Social-01', 3, true]]);
    expect(list[2].fingerprint).toEqual(bundle.profiles[1].fingerprint);
    expect(list.map((p: { searchEngine: string; restoreTabs: boolean }) => [p.searchEngine, p.restoreTabs])).toEqual([['none', true], ['bing', false], ['none', true]]);
    const proxies = (await call('GET', `/workspaces/${tws}/proxies`, target.headers)).json().proxies;
    const main = proxies.find((p: { host: string }) => p.host === 'main.example.net');
    expect(main.backupId).toBe(proxies.find((p: { host: string }) => p.host === 'backup.example.net').id);
    expect(list[1].proxyId).toBe(main.id);
    expect(res.profiles.map((p: { ref: string }) => p.ref)).toEqual(bundle.profiles.map((p: { ref: string }) => p.ref));

    // The sign-in state goes up as each profile's first save, without opening it.
    const state = gzipSync(JSON.stringify({ cookies: [{ name: 'sid', value: 'x', domain: 'shop.example', path: '/' }], origins: [] }));
    const put = await t.app.inject({ method: 'PUT', url: `/profiles/${res.profiles[0].id}/data?cookies=1&storageBytes=2&origins=0`, headers: { ...target.headers, 'content-type': 'application/octet-stream' }, payload: state });
    expect(put.json()).toMatchObject({ version: 1, cookies: 1 });
  });

  it('carries the extensions profiles use, with their identity, reusing one the library already has', async () => {
    const { o, ws } = await source();
    const pkg = (m: object) => Buffer.from(zipSync({ 'manifest.json': strToU8(JSON.stringify(m)) }));
    const upload = (h: H, w: string, kernel: string, body: Buffer) => t.app.inject({ method: 'POST', url: `/workspaces/${w}/extensions?kernel=${kernel}`, headers: { ...h, 'content-type': 'application/octet-stream' }, payload: body });
    const cr = (await upload(o.headers, ws, 'chromium', pkg({ manifest_version: 3, name: 'Wallet', version: '1.0' }))).json();
    const ffPkg = pkg({ manifest_version: 2, name: 'Notes', version: '2.0', browser_specific_settings: { gecko: { id: 'notes@x' } } });
    const ff = (await upload(o.headers, ws, 'firefox', ffPkg)).json();
    await upload(o.headers, ws, 'chromium', pkg({ manifest_version: 3, name: 'Unused', version: '1.0' }));
    const list = (await call('GET', `/workspaces/${ws}/profiles`, o.headers)).json().profiles;
    const shop = list.find((p: { name: string }) => p.name === 'Shop-DE'), social = list.find((p: { name: string }) => p.name === 'Social-01');
    await call('PATCH', `/profiles/${shop.id}`, o.headers, { version: shop.version, extensionIds: [cr.id] });
    await call('PATCH', `/profiles/${social.id}`, o.headers, { version: social.version, extensionIds: [ff.id] });

    const bundle = (await call('GET', `/workspaces/${ws}/export`, o.headers)).json();
    expect(bundle.extensions.map((e: { extId: string }) => e.extId).sort()).toEqual([cr.extId, ff.extId].sort());
    expect(bundle.profiles.find((p: { name: string }) => p.name === 'Shop-DE').extensionRefs).toEqual([cr.id]);

    // The target already has the Firefox add-on, so only the Chromium one joins its library.
    const target = await signup(t.app);
    const tws = target.workspaceId;
    const theirs = (await upload(target.headers, tws, 'firefox', ffPkg)).json();
    const res = (await call('POST', `/workspaces/${tws}/import`, target.headers, bundle)).json();
    expect(res.added).toMatchObject({ profiles: 2, extensions: 1 });
    const lib = (await call('GET', `/workspaces/${tws}/extensions`, target.headers)).json().extensions;
    const wallet = lib.find((e: { name: string }) => e.name === 'Wallet');
    expect(wallet).toMatchObject({ extId: cr.extId, publicKey: cr.publicKey, sha256: cr.sha256 });
    expect(wallet.signature).not.toBe(cr.signature);
    const imported = (await call('GET', `/workspaces/${tws}/profiles`, target.headers)).json().profiles;
    expect(imported.find((p: { name: string }) => p.name === 'Shop-DE').extensionIds).toEqual([wallet.id]);
    expect(imported.find((p: { name: string }) => p.name === 'Social-01').extensionIds).toEqual([theirs.id]);

    // A Chromium extension whose key and id don't agree is refused.
    const bad = { ...bundle, profiles: [], extensions: [{ ...bundle.extensions.find((e: { kernel: string }) => e.kernel === 'chromium'), extId: 'a'.repeat(32) }] };
    const other = await signup(t.app);
    expect((await call('POST', `/workspaces/${other.workspaceId}/import`, other.headers, bad)).json().error.code).toBe('extension_mismatch');
  });

  it('keeps the extension data in a saved state when cookies are merged into it', async () => {
    const o = await signup(t.app);
    const p = (await call('POST', `/workspaces/${o.workspaceId}/profiles`, o.headers, chromiumProfile('Shop'))).json();
    const state = gzipSync(JSON.stringify({ cookies: [], origins: [], extensions: { e1: { 'Default/Local Extension Settings/x/000003.log': 'AAEC' } } }));
    await t.app.inject({ method: 'PUT', url: `/profiles/${p.id}/data?cookies=0&storageBytes=0&origins=0`, headers: { ...o.headers, 'content-type': 'application/octet-stream' }, payload: state });
    await call('POST', `/profiles/${p.id}/cookies`, o.headers, { cookies: [{ name: 'sid', value: 'v', domain: 'shop.example' }] });
    const back = JSON.parse(gunzipSync((await t.app.inject({ url: `/profiles/${p.id}/data`, headers: o.headers })).rawPayload).toString('utf8'));
    expect(back).toMatchObject({ cookies: [{ name: 'sid' }], extensions: { e1: { 'Default/Local Extension Settings/x/000003.log': 'AAEC' } } });
  });

  it('refuses a file that does not fit the plan, leaving nothing behind', async () => {
    const { o, ws } = await source();
    await buy(t.app, o.headers, ws, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const bundle = (await call('GET', `/workspaces/${ws}/export`, o.headers)).json();
    const target = await signup(t.app);
    const many = Array.from({ length: 4 }, (_, i) => ({ ...bundle.profiles[0], ref: `r${i}` }));
    const res = await call('POST', `/workspaces/${target.workspaceId}/import`, target.headers, { groups: bundle.groups, proxies: bundle.proxies, profiles: [...bundle.profiles, ...many] });
    expect(res.json().error.code).toBe('plan_limit');
    expect((await call('GET', `/workspaces/${target.workspaceId}/proxies`, target.headers)).json().proxies).toEqual([]);
    expect((await call('GET', `/workspaces/${target.workspaceId}/groups`, target.headers)).json().groups).toEqual([]);
  });
});
