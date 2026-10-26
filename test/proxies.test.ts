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
    // A port outside 1-65535 says so.
    for (const line of ['1.2.3.4:abc', '1.2.3.4:0', 'u:p@1.2.3.4:70000', 'socks5://1.2.3.4:0']) expect(() => parseProxyLine(line, 'http')).toThrow(expect.objectContaining({ code: 'proxy_port' }));
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
    expect(res.added).toBe(3);
    expect(res.errors).toEqual([{ line: 5, text: 'not a proxy' }]);
  });

  it('preview a list line by line before importing it, then name what comes in after a pattern', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const call = (url: string, payload: object) => t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies/${url}`, headers, payload });
    await call('import', { text: 'one.example.net:1080:a:b', defaultType: 'socks5' });
    const text = ['one.example.net:1080:a:b', '# a comment', 'two.example.net:8080', '203.0.113.30:abc', 'two.example.net:8080', 'nonsense'].join('\n');
    const { lines } = (await call('import/preview', { text, defaultType: 'socks5' })).json();
    expect(lines).toEqual([
      { ok: true, line: 1, type: 'socks5', host: 'one.example.net', port: 1080, username: 'a', saved: true, repeat: false },
      { ok: true, line: 3, type: 'socks5', host: 'two.example.net', port: 8080, username: null, saved: false, repeat: false },
      { ok: false, line: 4, text: '203.0.113.30:abc', why: 'port' },
      { ok: true, line: 5, type: 'socks5', host: 'two.example.net', port: 8080, username: null, saved: false, repeat: true },
      { ok: false, line: 6, text: 'nonsense', why: 'format' }
    ]);
    expect(JSON.stringify(lines)).not.toContain('"b"');
    // Nothing was saved by looking.
    expect((await t.app.inject({ url: `/workspaces/${workspaceId}/proxies`, headers })).json().proxies).toHaveLength(1);

    const res = (await call('import', { text, defaultType: 'socks5', namePattern: 'Ops-{n}' })).json();
    expect(res.added).toBe(1);
    expect(res.proxies.map((p: { name: string }) => p.name)).toEqual(['one.example.net:1080', 'Ops-1', 'Ops-1']);
    // Duplicates added on purpose.
    const again = (await call('import', { text: 'two.example.net:8080\ntwo.example.net:8080', defaultType: 'socks5', skipDuplicates: false })).json();
    expect(again.added).toBe(2);
    expect(new Set(again.proxies.map((p: { id: string }) => p.id)).size).toBe(2);
  });

  it('keep notes', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const p = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies`, headers, payload: { type: 'http', host: 'n.example.net', port: 3128, notes: 'US storefronts' } })).json();
    expect(p.notes).toBe('US storefronts');
    expect((await t.app.inject({ method: 'PATCH', url: `/proxies/${p.id}`, headers, payload: { notes: null } })).json().notes).toBeNull();
  });

  it('reuse saved proxies when the same line comes in again', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const send = async (text: string) => (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies/import`, headers, payload: { text, defaultType: 'http' } })).json();
    const first = await send('one.example.net:8080:a:b\nONE.example.net:8080:a:b');
    expect(first.added).toBe(1);
    expect(first.proxies[0].id).toBe(first.proxies[1].id);
    const again = await send('socks5://x:y@two.example.net:1080\none.example.net:8080:a:b\none.example.net:8080:a:other');
    expect(again.added).toBe(2);
    expect(again.proxies[1].id).toBe(first.proxies[0].id);
    expect(again.proxies[2].id).not.toBe(first.proxies[0].id);
    expect((await t.app.inject({ url: `/workspaces/${workspaceId}/proxies`, headers })).json().proxies).toHaveLength(3);
  });

  it('store the latest check, the last 20, and where they last got through, and forget them when the address changes', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const p = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/proxies`, headers, payload: { type: 'http', host: 'x.example.net', port: 80 } })).json();
    expect(p).toMatchObject({ history: [], lastExit: null });
    const geo = { country: 'US', countryName: 'United States', region: 'Washington', city: 'Seattle', lat: 47.6, lon: -122.3, timezone: 'America/Los_Angeles', locale: 'en-US' };
    const report = (body: object) => t.app.inject({ method: 'POST', url: `/proxies/${p.id}/check`, headers, payload: body });
    const checked = await report({ ok: true, ms: 182, ip: '172.58.1.2', geo, error: null });
    expect(checked.json().lastCheck).toMatchObject({ ok: true, ms: 182, geo: { city: 'Seattle' } });
    for (let i = 0; i < 21; i++) await report({ ok: true, ms: 100 + i, ip: '172.58.1.2', geo, error: null });
    const down = (await report({ ok: false, ms: null, ip: null, geo: null, error: 'timeout' })).json();
    expect(down.history).toHaveLength(20);
    expect(down.history.at(-1)).toMatchObject({ ok: false, ms: null });
    expect(down.history[0].ms).toBe(102);
    expect(down.lastExit).toMatchObject({ ip: '172.58.1.2', geo: { city: 'Seattle' } });
    const moved = await t.app.inject({ method: 'PATCH', url: `/proxies/${p.id}`, headers, payload: { host: 'y.example.net' } });
    expect(moved.json()).toMatchObject({ lastCheck: null, history: [], lastExit: null });
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
