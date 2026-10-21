import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

describe('workspaces', () => {
  it('can be created, renamed and listed, each with its own Free plan', async () => {
    const { headers } = await signup(t.app);
    const created = await t.app.inject({ method: 'POST', url: '/workspaces', headers, payload: { name: 'EU stores' } });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    await t.app.inject({ method: 'PATCH', url: `/workspaces/${id}`, headers, payload: { name: 'EU & UK stores' } });
    const ws = (await t.app.inject({ url: `/workspaces/${id}`, headers })).json();
    expect(ws).toMatchObject({ name: 'EU & UK stores', role: 'owner', subscription: { plan: 'free' }, usage: { profiles: 0, members: 1 } });
    expect((await t.app.inject({ url: '/me', headers })).json().workspaces).toHaveLength(2);
  });

  it('are invisible to people outside them', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    expect((await t.app.inject({ url: `/workspaces/${a.workspaceId}`, headers: b.headers })).statusCode).toBe(404);
  });
});

describe('openapi', () => {
  it('describes the public routes', async () => {
    const doc = (await t.app.inject({ url: '/openapi.json' })).json();
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(['/auth/login', '/me', '/plans', '/workspaces/{id}/billing/checkout']));
    expect(Object.keys(doc.paths)).not.toContain('/dev/mail');
  });
});
