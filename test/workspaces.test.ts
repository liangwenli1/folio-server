import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join, setup, signup } from './helpers.js';

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
    expect(ws).toMatchObject({ name: 'EU & UK stores', role: { key: 'owner' }, subscription: { plan: 'free' }, usage: { profiles: 0, members: 1 } });
    expect(ws.settings).toEqual({
      defaultKernel: null, defaultKernelVersion: null, defaultGroupId: null, defaultProxyId: null,
      openDetailAfterLaunch: false, stopOnWindowClose: true, expiryReminder: true, trashDays: 30
    });
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
    expect(Object.keys(doc.paths)).not.toContain('/dev/run-due');
  });

  it('keeps what new profiles start with, and refuses another workspace\u2019s group', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const group = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/groups`, headers, payload: { name: 'US' } })).json();
    const set = (settings: object) => t.app.inject({ method: 'PATCH', url: `/workspaces/${workspaceId}`, headers, payload: { settings } });
    const saved = (await set({ defaultKernel: 'firefox', defaultKernelVersion: '156.0.1-beta.36', defaultGroupId: group.id, stopOnWindowClose: false })).json();
    expect(saved.settings).toMatchObject({ defaultKernel: 'firefox', defaultKernelVersion: '156.0.1-beta.36', defaultGroupId: group.id, stopOnWindowClose: false });
    // Reading the workspace gives them back, and the rest are untouched.
    const ws = (await t.app.inject({ url: `/workspaces/${workspaceId}`, headers })).json();
    expect(ws.settings).toMatchObject({ defaultKernel: 'firefox', defaultProxyId: null, expiryReminder: true });

    const elsewhere = await signup(t.app);
    const theirs = (await t.app.inject({ method: 'POST', url: `/workspaces/${elsewhere.workspaceId}/groups`, headers: elsewhere.headers, payload: { name: 'Theirs' } })).json();
    expect((await set({ defaultGroupId: theirs.id })).json().error.code).toBe('bad_reference');
    expect((await set({ defaultKernel: 'safari' })).statusCode).toBe(400);

    // A member cannot change them.
    const member = await signup(t.app);
    await join(t.db, workspaceId, member.userId, 'member');
    expect((await t.app.inject({ method: 'PATCH', url: `/workspaces/${workspaceId}`, headers: member.headers, payload: { settings: { expiryReminder: false } } })).json().error.code).toBe('forbidden');
  });
});
