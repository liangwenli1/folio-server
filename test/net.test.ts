import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { locate } from '../src/geo.js';
import { PASSWORD, chromiumProfile, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

describe('locate', () => {
  it('places an exit IP for a signed-in app', async () => {
    const { headers } = await signup(t.app);
    const at = async (ip: string) => (await t.app.inject({ url: `/net/locate?ip=${encodeURIComponent(ip)}`, headers })).json();
    // DEV_PRIVATE_GEO places private addresses in Seattle; in dev the demo's documentation addresses have their own places.
    expect(await at('127.0.0.1')).toMatchObject({ geo: { city: 'Seattle', timezone: 'America/Los_Angeles', locale: 'en-US' } });
    expect(await at('203.0.113.71')).toMatchObject({ geo: { city: 'New York', timezone: 'America/New_York' } });
    expect(await at('192.0.2.200')).toEqual({ geo: null });
    expect((await t.app.inject({ url: '/net/locate?ip=not-an-ip', headers })).statusCode).toBe(400);
    expect((await t.app.inject({ url: '/net/locate?ip=127.0.0.1' })).statusCode).toBe(401);
  });

  it('has a stand-in for the public echo in dev, which does not trust a forged X-Forwarded-For', async () => {
    const res = await t.app.inject({ url: '/dev/echo', headers: { 'x-forwarded-for': '8.8.8.8' } });
    expect(res.body).toBe('ip=127.0.0.1\n');
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
