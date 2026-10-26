import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { activityLog } from '../src/db/schema.js';
import { forgetOld } from '../src/activity/service.js';
import { PASSWORD, buy, chromiumProfile, join, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
type Entry = { seq: number; action: string; actor: string | null; deviceName: string | null; profile: { name: string; number: number; id: string | null } | null; detail: Record<string, unknown>; at: string };
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const log = async (headers: H, ws: string, query = '') => (await call('GET', `/workspaces/${ws}/activity${query}`, headers)).json() as { entries: Entry[]; total: number; retentionDays: number };
const actions = async (headers: H, ws: string, query = '') => (await log(headers, ws, query)).entries.map(e => e.action);
async function desktop(email: string, deviceName: string): Promise<H> {
  const res = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, client: 'desktop', deviceName } });
  return { authorization: `Bearer ${res.json().token}` };
}

describe('the activity log', () => {
  it('follows a profile from creation to deletion, in names that outlive it', async () => {
    const o = await signup(t.app);
    const ws = o.workspaceId;
    const g = (await call('POST', `/workspaces/${ws}/groups`, o.headers, { name: 'EU stores' })).json();
    const p = (await call('POST', `/workspaces/${ws}/profiles`, o.headers, chromiumProfile('Shop, Berlin'))).json();
    await call('PATCH', `/profiles/${p.id}`, o.headers, { version: p.version, name: 'Shop Berlin', notes: 'x', tags: [], groupId: null, os: 'windows' });
    await call('PATCH', `/profiles/${p.id}`, o.headers, { version: p.version + 1, name: 'Shop Berlin' });
    const batch = (body: object) => call('POST', `/workspaces/${ws}/profiles/batch`, o.headers, { ids: [p.id], ...body });
    await batch({ action: 'move', groupId: g.id });
    await batch({ action: 'tag', tag: 'vip' });
    await batch({ action: 'trash' });
    await batch({ action: 'purge' });
    const { entries } = await log(o.headers, ws);
    expect(entries.map(e => e.action)).toEqual(['profile.purge', 'profile.trash', 'profile.tag', 'profile.move', 'profile.update', 'profile.create', 'group.create']);
    expect(entries[0]).toMatchObject({ actor: o.email, profile: { id: null, name: 'Shop Berlin', number: 1 } });
    expect(entries.find(e => e.action === 'profile.update')!.detail).toEqual({ fields: ['name', 'notes'] });
    expect(entries.find(e => e.action === 'profile.move')!.detail).toEqual({ group: 'EU stores' });
    expect(entries.find(e => e.action === 'profile.create')!.profile!.name).toBe('Shop, Berlin');
  });

  it('records opening, closing and takeovers with the computer, once per opening', async () => {
    const o = await signup(t.app);
    const p = (await call('POST', `/workspaces/${o.workspaceId}/profiles`, o.headers, chromiumProfile('Shop'))).json();
    const a = await desktop(o.email, 'Laptop A'), b = await desktop(o.email, 'Laptop B');
    await call('POST', `/profiles/${p.id}/lock`, a);
    await call('POST', `/profiles/${p.id}/lock`, a);
    await call('DELETE', `/profiles/${p.id}/lock`, a);
    await call('POST', `/profiles/${p.id}/lock`, b);
    await call('POST', `/profiles/${p.id}/lock/takeover`, o.headers);
    const { entries } = await log(o.headers, o.workspaceId, `?profileId=${p.id}&kind=open`);
    expect(entries.map(e => [e.action, e.deviceName])).toEqual([['profile.takeover', null], ['profile.open', 'Laptop B'], ['profile.close', 'Laptop A'], ['profile.open', 'Laptop A']]);
    expect(entries[0].detail).toEqual({ from: o.email, device: 'Laptop B' });
    // Opened by a script through the local API.
    await call('DELETE', `/profiles/${p.id}/lock`, b);
    await call('POST', `/profiles/${p.id}/lock`, a, { via: 'api' });
    expect((await log(o.headers, o.workspaceId, `?profileId=${p.id}&kind=open`)).entries[0]).toMatchObject({ action: 'profile.open', detail: { via: 'api' } });
  });

  it('shows members what concerns their own profiles and their own actions', async () => {
    const o = await signup(t.app);
    await buy(t.app, o.headers, o.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const m = await signup(t.app);
    await join(t.db, o.workspaceId, m.userId, 'member');
    await call('POST', `/workspaces/${o.workspaceId}/profiles`, o.headers, chromiumProfile('Owner-1'));
    await call('POST', `/workspaces/${o.workspaceId}/profiles`, o.headers, chromiumProfile('For-M', { ownerId: m.userId }));
    await call('POST', `/workspaces/${o.workspaceId}/profiles`, m.headers, chromiumProfile('M-1'));
    const seen = (await log(m.headers, o.workspaceId)).entries.map(e => e.profile?.name);
    expect(seen).toEqual(['M-1', 'For-M']);
    expect((await log(o.headers, o.workspaceId)).entries).toHaveLength(3);
    expect(await actions(m.headers, o.workspaceId, `?actorId=${m.userId}`)).toEqual(['profile.create']);
  });

  it('keeps entries for the plan’s retention and forgets older ones', async () => {
    const o = await signup(t.app);
    await call('POST', `/workspaces/${o.workspaceId}/groups`, o.headers, { name: 'Old' });
    t.clock.advanceDays(8);
    const fresh = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email: o.email, password: PASSWORD } });
    const h = { cookie: `folio_session=${fresh.cookies.find(c => c.name === 'folio_session')!.value}`, origin: o.headers.origin };
    await call('POST', `/workspaces/${o.workspaceId}/groups`, h, { name: 'New' });
    expect(await log(h, o.workspaceId)).toMatchObject({ retentionDays: 7, entries: [{ detail: { name: 'New' } }] });
    await forgetOld(t.db, t.clock.now());
    expect(await t.db.select().from(activityLog).where(eq(activityLog.workspaceId, o.workspaceId))).toHaveLength(1);
  });

  it('pages back in time, saying how many there are', async () => {
    const o = await signup(t.app);
    for (const name of ['A', 'B', 'C']){
      await call('POST', `/workspaces/${o.workspaceId}/groups`, o.headers, { name });
      t.clock.advanceDays(1 / 1440);
    }
    const first = await log(o.headers, o.workspaceId, '?limit=2');
    expect(first.entries.map(e => e.detail.name)).toEqual(['C', 'B']);
    expect(first.total).toBe(3);
    const next = await log(o.headers, o.workspaceId, '?limit=2&offset=2');
    expect(next.entries.map(e => e.detail.name)).toEqual(['A']);
  });

  it('reads oldest first, and finds entries by word, number and time', async () => {
    const o = await signup(t.app);
    const start = t.clock.now();
    for (const name of ['Alpha', 'Beta', 'Gamma']){
      await call('POST', `/workspaces/${o.workspaceId}/groups`, o.headers, { name });
      t.clock.advanceDays(1);
    }
    const oldest = await log(o.headers, o.workspaceId, '?order=asc&limit=2');
    expect(oldest.entries.map(e => e.detail.name)).toEqual(['Alpha', 'Beta']);
    expect((await log(o.headers, o.workspaceId, '?order=asc&limit=2&offset=2')).entries.map(e => e.detail.name)).toEqual(['Gamma']);
    expect((await log(o.headers, o.workspaceId, '?q=gam')).entries.map(e => e.detail.name)).toEqual(['Gamma']);
    expect((await log(o.headers, o.workspaceId, `?q=${encodeURIComponent(o.email)}`)).entries).toHaveLength(3);
    expect((await log(o.headers, o.workspaceId, `?q=%23${oldest.entries[0].seq}`)).entries.map(e => e.detail.name)).toEqual(['Alpha']);
    const day2 = new Date(start.getTime() + 86_400_000), day3 = new Date(start.getTime() + 2 * 86_400_000);
    expect((await log(o.headers, o.workspaceId, `?from=${day2.toISOString()}&to=${day3.toISOString()}`)).entries.map(e => e.detail.name)).toEqual(['Beta']);
  });

  it('records the team: invitations, joining, roles and removal', async () => {
    const o = await signup(t.app);
    await buy(t.app, o.headers, o.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const m = await signup(t.app);
    const roleId = async (key: string) => ((await call('GET', `/workspaces/${o.workspaceId}/roles`, o.headers)).json().roles as { id: string; key: string }[]).find(r => r.key === key)!.id;
    const inv = (await call('POST', `/workspaces/${o.workspaceId}/invitations`, o.headers, { email: m.email, roleId: await roleId('member') })).json();
    await call('POST', `/invitations/${inv.invitation.id}/accept`, m.headers);
    await call('PATCH', `/workspaces/${o.workspaceId}/members/${m.userId}`, o.headers, { roleId: await roleId('admin') });
    await call('DELETE', `/workspaces/${o.workspaceId}/members/${m.userId}?transferTo=${o.userId}`, o.headers);
    const { entries } = await log(o.headers, o.workspaceId, '?kind=team');
    expect(entries.map(e => [e.action, e.actor, e.detail])).toEqual([
      ['member.remove', o.email, { email: m.email, to: o.email }], ['member.role', o.email, { email: m.email, role: 'Admin' }],
      ['member.join', m.email, { email: m.email, role: 'Member' }], ['member.invite', o.email, { email: m.email, role: 'Member' }]
    ]);
  });

  it('exports as CSV on Company, for owners and admins', async () => {
    const o = await signup(t.app);
    await call('POST', `/workspaces/${o.workspaceId}/profiles`, o.headers, chromiumProfile('Shop, Berlin'));
    expect((await call('GET', `/workspaces/${o.workspaceId}/activity.csv`, o.headers)).json().error.code).toBe('plan_required');
    await buy(t.app, o.headers, o.workspaceId, { plan: 'company', period: 'monthly', addonPacks: 0 });
    const csv = await call('GET', `/workspaces/${o.workspaceId}/activity.csv`, o.headers);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.body.trim().split('\n');
    expect(lines[0]).toBe('time,person,computer,action,profile number,profile,details');
    expect(lines.at(-1)).toContain(`${o.email},,profile.create,1,"Shop, Berlin",`);
  });
});
