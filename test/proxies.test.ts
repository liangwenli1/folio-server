import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseProxyLine } from '../src/proxies/service.js';
import { chromiumProfile, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

describe('parseProxyLine', () => {
  it('reads the formats proxy sellers use', () => {
    expect(parseProxyLine('socks5://user:p%40ss@us-sea.example.net:1080', 'http')).toEqual({ type: 'socks5', host: 'us-sea.example.net', port: 1080, username: 'user', password: 'p@ss' });
    expect(parseProxyLine('user:pass:word@10.0.0.5:8000', 'socks5')).toEqual({ type: 'socks5', host: '10.0.0.5', port: 8000, username: 'user', password: 'pass:word' });
    expect(parseProxyLine('gw.example.net:7777:alice:secret', 'http')).toEqual({ type: 'http', host: 'gw.example.net', port: 7777, username: 'alice', password: 'secret' });
    expect(parseProxyLine(' 1.2.3.4:8080 ', 'https')).toEqual({ type: 'https', host: '1.2.3.4', port: 8080, username: null, password: null });
    expect(() => parseProxyLine('ftp://x.example.net:21', 'http')).toThrow();
    expect(() => parseProxyLine('just-a-host', 'http')).toThrow();
  });
});

describe('proxies', () => {
  it('never list passwords; credentials are a separate request', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const p = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies`, headers, payload: { type: 'socks5', host: 'us.example.net', port: 1080, username: 'u', password: 's3cret' } })).json();
    expect(p).toMatchObject({ name: 'us.example.net:1080', hasPassword: true });
    expect(JSON.stringify(p)).not.toContain('s3cret');
    expect((await t.app.inject({ url: `/proxies/${p.id}/credentials`, headers })).json().password).toBe('s3cret');

    const cleared = await t.app.inject({ method: 'PATCH', url: `/proxies/${p.id}`, headers, payload: { password: null } });
    expect(cleared.json().hasPassword).toBe(false);
  });

  it('imports a pasted list and reports the lines it could not read', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const text = ['socks5://a:b@one.example.net:1080', '# comment', '', 'two.example.net:8080:c:d', 'not a proxy', 'three.example.net:3128'].join('\n');
    const res = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies/import`, headers, payload: { text, defaultType: 'http' } })).json();
    expect(res.proxies.map((p: { type: string; host: string }) => `${p.type}:${p.host}`)).toEqual(['socks5:one.example.net', 'http:two.example.net', 'http:three.example.net']);
    expect(res.errors).toEqual([{ line: 5, text: 'not a proxy' }]);
  });

  it('store the latest check and forget it when the address changes', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const p = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies`, headers, payload: { type: 'http', host: 'x.example.net', port: 80 } })).json();
    const geo = { country: 'US', countryName: 'United States', region: 'Washington', city: 'Seattle', lat: 47.6, lon: -122.3, timezone: 'America/Los_Angeles', locale: 'en-US' };
    const checked = await t.app.inject({ method: 'POST', url: `/proxies/${p.id}/check`, headers, payload: { ok: true, ms: 182, ip: '172.58.1.2', geo, error: null } });
    expect(checked.json().lastCheck).toMatchObject({ ok: true, ms: 182, geo: { city: 'Seattle' } });
    const moved = await t.app.inject({ method: 'PATCH', url: `/proxies/${p.id}`, headers, payload: { host: 'y.example.net' } });
    expect(moved.json().lastCheck).toBeNull();
  });

  it('cannot back themselves up, and leave profiles without a proxy when deleted', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const p = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies`, headers, payload: { type: 'http', host: 'x.example.net', port: 80 } })).json();
    expect((await t.app.inject({ method: 'PATCH', url: `/proxies/${p.id}`, headers, payload: { backupId: p.id } })).json().error.code).toBe('bad_reference');
    const prof = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/profiles`, headers, payload: chromiumProfile('A', { proxyId: p.id }) })).json();
    expect((await t.app.inject({ url: `/workspaces/${workspaceId}/proxies`, headers })).json().proxies[0].profiles).toBe(1);
    await t.app.inject({ method: 'DELETE', url: `/proxies/${p.id}`, headers });
    const after = (await t.app.inject({ url: `/workspaces/${workspaceId}/profiles`, headers })).json().profiles;
    expect(after.find((x: { id: string }) => x.id === prof.id).proxyId).toBeNull();
  });
});
