import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locate } from '../src/geo.js';
import { PASSWORD, chromiumProfile, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

describe('echo', () => {
  it('reports the address the request came from, with its location', async () => {
    const { headers } = await signup(t.app);
    const res = (await t.app.inject({ url: '/net/echo', headers })).json();
    // Loopback in tests; DEV_PRIVATE_GEO places private addresses in Seattle.
    expect(res).toMatchObject({ ip: '127.0.0.1', geo: { city: 'Seattle', timezone: 'America/Los_Angeles', locale: 'en-US' } });
  });

  it('does not trust a forged X-Forwarded-For', async () => {
    const { headers } = await signup(t.app);
    const res = (await t.app.inject({ url: '/net/echo', headers: { ...headers, 'x-forwarded-for': '8.8.8.8' } })).json();
    expect(res.ip).toBe('127.0.0.1');
  });
});

describe.runIf(!!process.env.GEOIP_DB)('locate with the DB-IP database', () => {
  it('finds city, time zone and language for public addresses', async () => {
    const cfg = { devTools: false, devPrivateGeo: '', geoipDb: process.env.GEOIP_DB! };
    const g = await locate('8.8.8.8', cfg);
    expect(g).toMatchObject({ country: 'US', locale: 'en-US' });
    expect(g!.timezone).toMatch(/^America\//);
    expect(await locate('10.1.2.3', cfg)).toBeNull();
  });
});

describe('events', () => {
  it('tell a connected app that profiles changed', async () => {
    const { headers, workspaceId, email } = await signup(t.app);
    const { token } = (await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, client: 'desktop' } })).json();
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = t.app.server.address() as { port: number };
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/workspaces/${workspaceId}/events`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    const reader = res.body!.getReader();
    const created = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/profiles`, headers, payload: chromiumProfile('A') })).json();
    let text = '';
    while (!text.includes('event: change')) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain(JSON.stringify({ kind: 'profiles', ids: [created.id] }));
    ctrl.abort();
  });
});
