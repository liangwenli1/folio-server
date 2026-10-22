import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, buy, chromiumProfile, lastMail, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const code = async (p: ReturnType<typeof call>) => (await p).json().error?.code;
const ids = (list: { id: string }[]) => list.map(x => x.id);

// An owner on a paid plan, and someone they invited who accepted.
async function team(plan: 'studio' | 'company' = 'studio', role: 'admin' | 'member' = 'member'){
  const owner = await signup(t.app);
  await buy(t.app, owner.headers, owner.workspaceId, { plan, period: 'monthly', addonPacks: 0 });
  const other = await signup(t.app);
  const inv = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: other.email, role })).json();
  expect((await call('POST', `/invitations/${inv.invitation.id}/accept`, other.headers)).statusCode).toBe(200);
  return { owner, other, ws: owner.workspaceId };
}
const profile = async (headers: H, ws: string, name: string, extra: object = {}) => (await call('POST', `/workspaces/${ws}/profiles`, headers, chromiumProfile(name, extra))).json();
const visible = async (headers: H, ws: string) => (await call('GET', `/workspaces/${ws}/profiles`, headers)).json().profiles as { id: string; name: string; ownerId: string }[];

describe('invitations', () => {
  it('need a seat on the plan', async () => {
    const owner = await signup(t.app);
    expect(await code(call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: 'x@example.com', role: 'member' }))).toBe('seat_limit');
  });

  it('are emailed with a link, previewed from it, and accepted by the invited address only', async () => {
    const owner = await signup(t.app);
    await buy(t.app, owner.headers, owner.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const invitee = await signup(t.app, { verify: false });
    const stranger = await signup(t.app);
    const first = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: invitee.email.toUpperCase(), role: 'admin' })).json();
    const sent = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: invitee.email, role: 'member' })).json();
    expect(sent).toMatchObject({ emailed: true, invitation: { email: invitee.email, role: 'member', invitedBy: owner.email } });
    expect(ids((await call('GET', `/workspaces/${owner.workspaceId}/invitations`, owner.headers)).json().invitations)).toEqual([sent.invitation.id]);

    const mail = await lastMail(invitee.email);
    expect(mail.Subject).toContain(owner.email);
    const token = new URL(sent.link).searchParams.get('token')!;
    expect(mail.Text).toContain(sent.link);
    expect((await call('GET', `/invitations/by-token/${token}`, {})).json()).toMatchObject({ id: sent.invitation.id, inviter: owner.email, role: 'member', expired: false });
    expect((await call('GET', `/invitations/by-token/${new URL(first.link).searchParams.get('token')}`, {})).statusCode).toBe(404);

    expect(ids((await call('GET', '/me/invitations', invitee.headers)).json().invitations)).toEqual([sent.invitation.id]);
    expect(await code(call('POST', `/invitations/${sent.invitation.id}/accept`, stranger.headers))).toBe('wrong_account');
    expect(await code(call('POST', `/invitations/${sent.invitation.id}/accept`, invitee.headers))).toBe('email_unverified');
  });

  it('can be accepted once verified, and then the workspace is theirs to see', async () => {
    const { owner, other, ws } = await team();
    expect((await call('GET', '/me', other.headers)).json().workspaces.map((w: { id: string; role: string }) => [w.id === ws, w.role])).toContainEqual([true, 'member']);
    const members = (await call('GET', `/workspaces/${ws}/members`, owner.headers)).json().members;
    expect(members.map((m: { email: string; role: string }) => [m.email, m.role])).toEqual([[owner.email, 'owner'], [other.email, 'member']]);
    expect((await call('GET', `/workspaces/${ws}/invitations`, owner.headers)).json().invitations).toEqual([]);
  });

  it('expire after seven days, and can be declined or revoked', async () => {
    const owner = await signup(t.app);
    await buy(t.app, owner.headers, owner.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const a = await signup(t.app), b = await signup(t.app), c = await signup(t.app);
    const invite = async (email: string) => (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email, role: 'member' })).json();
    const ia = await invite(a.email), ib = await invite(b.email), ic = await invite(c.email);
    expect((await call('POST', `/invitations/${ib.invitation.id}/decline`, b.headers)).statusCode).toBe(204);
    expect((await call('DELETE', `/invitations/${ic.invitation.id}`, owner.headers)).statusCode).toBe(204);
    expect(await code(call('POST', `/invitations/${ic.invitation.id}/accept`, c.headers))).toBe('not_found');
    t.clock.advanceDays(8);
    expect((await call('GET', `/invitations/by-token/${new URL(ia.link).searchParams.get('token')}`, {})).json().expired).toBe(true);
    const fresh = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email: a.email, password: PASSWORD } });
    const aNow = { cookie: `folio_session=${fresh.cookies.find(x => x.name === 'folio_session')!.value}`, origin: a.headers.origin };
    expect(await code(call('POST', `/invitations/${ia.invitation.id}/accept`, aNow))).toBe('invitation_expired');
  });

  it('are for owners and admins, and not for people already in the workspace', async () => {
    const { owner, other, ws } = await team();
    expect(await code(call('POST', `/workspaces/${ws}/invitations`, other.headers, { email: 'x@example.com', role: 'member' }))).toBe('forbidden');
    expect(await code(call('POST', `/workspaces/${ws}/invitations`, owner.headers, { email: other.email, role: 'member' }))).toBe('already_member');
  });
});

describe('members', () => {
  it('see and open only the profiles assigned to them, and create profiles for themselves', async () => {
    const { owner, other, ws } = await team();
    const ownerProfile = await profile(owner.headers, ws, 'Owner-1');
    const mine = await profile(other.headers, ws, 'Member-1');
    expect(mine.ownerId).toBe(other.userId);
    expect(ownerProfile.ownerId).toBe(owner.userId);
    expect((await visible(other.headers, ws)).map(p => p.name)).toEqual(['Member-1']);
    expect((await visible(owner.headers, ws)).map(p => p.name)).toEqual(['Owner-1', 'Member-1']);
    for (const [method, url] of [['GET', `/profiles/${ownerProfile.id}/launch`], ['POST', `/profiles/${ownerProfile.id}/lock`], ['GET', `/profiles/${ownerProfile.id}/data`]] as const){
      expect((await call(method, url, other.headers)).statusCode).toBe(404);
    }
    expect(await code(call('PATCH', `/profiles/${ownerProfile.id}`, other.headers, { version: ownerProfile.version, name: 'X' }))).toBe('not_found');

    await call('POST', `/workspaces/${ws}/profiles/batch`, owner.headers, { ids: [ownerProfile.id], action: 'assign', ownerId: other.userId });
    expect((await visible(other.headers, ws)).map(p => p.name)).toEqual(['Owner-1', 'Member-1']);
  });

  it('cannot delete, assign, or manage groups and proxies', async () => {
    const { owner, other, ws } = await team();
    const p = await profile(other.headers, ws, 'Member-1');
    for (const action of ['trash', 'restore', 'purge']){
      expect(await code(call('POST', `/workspaces/${ws}/profiles/batch`, other.headers, { ids: [p.id], action }))).toBe('forbidden');
    }
    expect(await code(call('POST', `/workspaces/${ws}/profiles/batch`, other.headers, { ids: [p.id], action: 'assign', ownerId: owner.userId }))).toBe('forbidden');
    expect(await code(call('PATCH', `/profiles/${p.id}`, other.headers, { version: p.version, ownerId: owner.userId }))).toBe('forbidden');
    expect(await code(call('POST', `/workspaces/${ws}/profiles`, other.headers, chromiumProfile('X', { ownerId: owner.userId })))).toBe('forbidden');
    expect((await call('POST', `/workspaces/${ws}/profiles/batch`, other.headers, { ids: [p.id], action: 'tag', tag: 'mine' })).json().updated).toBe(1);

    expect(await code(call('POST', `/workspaces/${ws}/groups`, other.headers, { name: 'G' }))).toBe('forbidden');
    const proxy = (await call('POST', `/workspaces/${ws}/proxies`, owner.headers, { type: 'http', host: 'a.example.net', port: 80, password: 'pw' })).json();
    expect(await code(call('POST', `/workspaces/${ws}/proxies`, other.headers, { type: 'http', host: 'b.example.net', port: 80 }))).toBe('forbidden');
    expect(await code(call('PATCH', `/proxies/${proxy.id}`, other.headers, { port: 81 }))).toBe('forbidden');
    expect(await code(call('GET', `/proxies/${proxy.id}/credentials`, other.headers))).toBe('forbidden');
    expect(ids((await call('GET', `/workspaces/${ws}/proxies`, other.headers)).json().proxies)).toEqual([proxy.id]);
    const withProxy = (await call('PATCH', `/profiles/${p.id}`, other.headers, { version: p.version + 1, proxyId: proxy.id })).json();
    expect(withProxy.proxyId).toBe(proxy.id);
    expect((await call('GET', `/profiles/${p.id}/launch`, other.headers)).json().proxy.password).toBe('pw');
  });

  it('who become admins see everything; the owner cannot be changed', async () => {
    const { owner, other, ws } = await team();
    await profile(owner.headers, ws, 'Owner-1');
    expect((await call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { role: 'admin' })).statusCode).toBe(204);
    expect((await visible(other.headers, ws)).map(p => p.name)).toEqual(['Owner-1']);
    expect(await code(call('PATCH', `/workspaces/${ws}/members/${owner.userId}`, other.headers, { role: 'member' }))).toBe('owner');
    expect(await code(call('DELETE', `/workspaces/${ws}/members/${owner.userId}?transferTo=${other.userId}`, other.headers))).toBe('owner');
  });

  it('removed hand their profiles over, lose access and the profiles they had open', async () => {
    const { owner, other, ws } = await team();
    const p = await profile(other.headers, ws, 'Member-1');
    const desktop = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email: other.email, password: PASSWORD, client: 'desktop', deviceName: 'Laptop' } });
    const bearer = { authorization: `Bearer ${desktop.json().token}` };
    expect((await call('POST', `/profiles/${p.id}/lock`, bearer)).statusCode).toBe(200);

    expect((await call('DELETE', `/workspaces/${ws}/members/${other.userId}?transferTo=${owner.userId}`, owner.headers)).statusCode).toBe(204);
    expect((await call('GET', `/workspaces/${ws}`, other.headers)).statusCode).toBe(404);
    expect((await call('POST', `/profiles/${p.id}/lock/renew`, bearer)).statusCode).toBe(404);
    const after = (await visible(owner.headers, ws)).find(x => x.id === p.id)!;
    expect(after).toMatchObject({ ownerId: owner.userId, lock: null });
  });

  it('can leave, handing their profiles to the owner', async () => {
    const { owner, other, ws } = await team();
    const p = await profile(other.headers, ws, 'Member-1');
    expect((await call('POST', `/workspaces/${ws}/leave`, other.headers)).statusCode).toBe(204);
    expect((await visible(owner.headers, ws)).find(x => x.id === p.id)!.ownerId).toBe(owner.userId);
    expect(await code(call('POST', `/workspaces/${ws}/leave`, owner.headers))).toBe('owner');
  });
});

describe('departments', () => {
  it('are a Company feature', async () => {
    const { owner, ws } = await team('studio');
    expect(await code(call('POST', `/workspaces/${ws}/departments`, owner.headers, { name: 'Sales' }))).toBe('plan_required');
  });

  it('let members see their department’s profiles', async () => {
    const { owner, other, ws } = await team('company');
    const sales = (await call('POST', `/workspaces/${ws}/departments`, owner.headers, { name: 'Sales' })).json();
    const shared = await profile(owner.headers, ws, 'Sales-1', { departmentId: sales.id });
    expect((await visible(other.headers, ws)).map(p => p.name)).toEqual([]);
    await call('PATCH', `/departments/${sales.id}`, owner.headers, { memberIds: [other.userId] });
    expect((await visible(other.headers, ws)).map(p => p.id)).toEqual([shared.id]);
    expect((await call('GET', `/workspaces/${ws}/departments`, other.headers)).json().departments).toEqual([{ id: sales.id, name: 'Sales', memberIds: [other.userId], profiles: 1 }]);
    expect((await call('GET', `/workspaces/${ws}/members`, owner.headers)).json().members[1].departmentIds).toEqual([sales.id]);

    await call('DELETE', `/departments/${sales.id}`, owner.headers);
    expect((await visible(other.headers, ws))).toEqual([]);
  });

  it('can be part of an invitation', async () => {
    const owner = await signup(t.app);
    await buy(t.app, owner.headers, owner.workspaceId, { plan: 'company', period: 'monthly', addonPacks: 0 });
    const ws = owner.workspaceId;
    const sales = (await call('POST', `/workspaces/${ws}/departments`, owner.headers, { name: 'Sales' })).json();
    await profile(owner.headers, ws, 'Sales-1', { departmentId: sales.id });
    const joiner = await signup(t.app);
    const inv = (await call('POST', `/workspaces/${ws}/invitations`, owner.headers, { email: joiner.email, role: 'member', departmentIds: [sales.id] })).json();
    await call('POST', `/invitations/${inv.invitation.id}/accept`, joiner.headers);
    expect((await visible(joiner.headers, ws)).map(p => p.name)).toEqual(['Sales-1']);
  });
});

describe('the change stream', () => {
  it('tells a removed member and closes their stream, while the rest of the team keeps theirs', async () => {
    const { owner, other, ws } = await team();
    const address = await t.app.listen({ port: 0, host: '127.0.0.1' });
    const login = async (email: string) => (await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, client: 'desktop' } })).json().token as string;
    // Reads events until the stream ends or `until` matches.
    async function listen(token: string, until: (events: string[]) => boolean){
      const res = await fetch(`${address}/workspaces/${ws}/events`, { headers: { authorization: `Bearer ${token}` } });
      const reader = res.body!.getReader(), decoder = new TextDecoder(), events: string[] = [];
      let buf = '';
      for (;;){
        const { value, done } = await reader.read();
        if (done) return { events, ended: true };
        buf += decoder.decode(value);
        events.splice(0, events.length, ...[...buf.matchAll(/data: (.+)/g)].map(m => JSON.parse(m[1]).kind));
        if (until(events)){ await reader.cancel(); return { events, ended: false }; }
      }
    }
    const memberStream = listen(await login(other.email), () => false);
    const ownerStream = listen(await login(owner.email), e => e.includes('profiles') && e.indexOf('profiles') > e.indexOf('members'));
    await new Promise(r => setTimeout(r, 200));
    await call('DELETE', `/workspaces/${ws}/members/${other.userId}?transferTo=${owner.userId}`, owner.headers);
    expect(await memberStream).toEqual({ events: ['removed'], ended: true });
    // The server keeps publishing to the workspace without tripping over the closed stream.
    await profile(owner.headers, ws, 'After');
    expect((await ownerStream).events).toEqual(expect.arrayContaining(['members', 'profiles']));
    expect((await call('GET', '/health', {})).statusCode).toBe(200);
  });
});
