import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memberships } from '../src/db/schema.js';
import { buy, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const STEPS = [
  { type: 'open', url: 'https://shop.example/login' },
  { type: 'type', selector: '#email', text: '{{email}}', slow: true },
  { type: 'if', test: { kind: 'exists', selector: 'text=Welcome' }, then: [{ type: 'extract', selector: '.balance', attribute: null, variable: 'balance' }], else: [] },
  { type: 'loop', mode: 'each', times: null, selector: '.order', steps: [{ type: 'click', selector: '@item >> a' }] },
  { type: 'wait', until: 'time', seconds: 1, maxSeconds: 3, selector: null },
  { type: 'signedIn', url: 'https://shop.example/account', mode: 'absent', selector: 'text=Log in', seconds: 10 }
];

// An owner on Studio, an admin and two members.
async function team(){
  const o = await signup(t.app);
  await buy(t.app, o.headers, o.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
  const add = async (role: string) => {
    const u = await signup(t.app);
    await t.db.insert(memberships).values({ workspaceId: o.workspaceId, userId: u.userId, role });
    return u;
  };
  return { o, admin: await add('admin'), m1: await add('member'), m2: await add('member'), ws: o.workspaceId };
}

describe('flows', () => {
  it('are shared with the whole team; the creator, admins and the owner change them', async () => {
    const { o, admin, m1, m2, ws } = await team();
    const created = await call('POST', `/workspaces/${ws}/flows`, m1.headers, { name: 'Daily check', steps: STEPS });
    expect(created.statusCode).toBe(201);
    const f = created.json();
    expect(f).toMatchObject({ name: 'Daily check', steps: STEPS, version: 0, createdBy: m1.userId, canEdit: true });

    const seen = async (h: H) => (await call('GET', `/workspaces/${ws}/flows`, h)).json().flows.map((x: { name: string; canEdit: boolean }) => [x.name, x.canEdit]);
    expect(await seen(m2.headers)).toEqual([['Daily check', false]]);
    expect(await seen(admin.headers)).toEqual([['Daily check', true]]);

    expect((await call('PATCH', `/flows/${f.id}`, m2.headers, { version: 0, name: 'Mine now' })).json().error.code).toBe('forbidden');
    expect((await call('DELETE', `/flows/${f.id}`, m2.headers)).statusCode).toBe(403);
    const renamed = await call('PATCH', `/flows/${f.id}`, m1.headers, { version: 0, name: 'Morning check' });
    expect(renamed.json()).toMatchObject({ name: 'Morning check', version: 1, steps: STEPS });
    const byAdmin = await call('PATCH', `/flows/${f.id}`, admin.headers, { version: 1, steps: STEPS.slice(0, 1) });
    expect(byAdmin.json()).toMatchObject({ version: 2, steps: STEPS.slice(0, 1) });
    // An edit made on an older copy is refused.
    expect((await call('PATCH', `/flows/${f.id}`, m1.headers, { version: 1, name: 'Late' })).json().error.code).toBe('stale');

    expect((await call('DELETE', `/flows/${f.id}`, o.headers)).statusCode).toBe(204);
    expect(await seen(m1.headers)).toEqual([]);
    const log = (await call('GET', `/workspaces/${ws}/activity?kind=automation`, o.headers)).json().entries;
    expect(log.map((e: { action: string; detail: object }) => [e.action, e.detail])).toEqual([
      ['flow.delete', { name: 'Morning check' }], ['flow.update', { name: 'Morning check' }],
      ['flow.update', { name: 'Morning check', from: 'Daily check' }], ['flow.create', { name: 'Daily check' }]
    ]);
  });

  it('refuses steps missing what their mode needs, nested too deep or too many', async () => {
    const o = await signup(t.app);
    const post = (steps: object[]) => call('POST', `/workspaces/${o.workspaceId}/flows`, o.headers, { name: 'x', steps });
    expect((await post([{ type: 'click' }])).json().error.code).toBe('validation');
    expect((await post([{ type: 'wait', until: 'visible', seconds: 5, maxSeconds: null, selector: null }])).json().error.code).toBe('validation');
    expect((await post([{ type: 'scroll', to: 'pixels', selector: null, pixels: null }])).json().error.code).toBe('validation');
    expect((await post([{ type: 'loop', mode: 'each', times: null, selector: null, steps: [] }])).json().error.code).toBe('validation');
    expect((await post([{ type: 'loop', mode: 'times', times: 2, selector: null, steps: [] }])).statusCode).toBe(201);
    const nest = (depth: number): object => ({ type: 'if', test: { kind: 'equals', variable: 'a', value: '1' }, then: depth > 1 ? [nest(depth - 1)] : [], else: [] });
    expect((await post([nest(4)])).statusCode).toBe(201);
    expect((await post([nest(5)])).json().error.code).toBe('flow_too_deep');
    const click = { type: 'click', selector: 'a' };
    expect((await post([{ type: 'loop', mode: 'times', times: 2, selector: null, steps: Array(300).fill(click) }])).json().error.code).toBe('flow_too_long');
  });

  it('stay inside their workspace', async () => {
    const a = await signup(t.app), b = await signup(t.app);
    const f = (await call('POST', `/workspaces/${a.workspaceId}/flows`, a.headers, { name: 'A', steps: [] })).json();
    expect((await call('GET', `/workspaces/${a.workspaceId}/flows`, b.headers)).statusCode).toBe(404);
    expect((await call('PATCH', `/flows/${f.id}`, b.headers, { version: 0, name: 'B' })).statusCode).toBe(404);
    expect((await call('POST', `/workspaces/${a.workspaceId}/flows`, b.headers, { name: 'B', steps: [] })).statusCode).toBe(404);
  });
});
