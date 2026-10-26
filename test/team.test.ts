import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PASSWORD, buy, chromiumProfile, lastMail, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const code = async (p: ReturnType<typeof call>) => (await p).json().error?.code;
const ids = (list: { id: string }[]) => list.map(x => x.id);
// The id of one of a workspace's built-in roles, which invitations and role changes are given by id.
const roleId = async (headers: H, ws: string, key: 'admin' | 'member' | 'viewer') =>
  ((await call('GET', `/workspaces/${ws}/roles`, headers)).json().roles as { id: string; key: string }[]).find(r => r.key === key)!.id;

// An owner on a paid plan, and someone they invited who accepted.
async function team(plan: 'studio' | 'company' = 'studio', role: 'admin' | 'member' = 'member'){
  const owner = await signup(t.app);
  await buy(t.app, owner.headers, owner.workspaceId, { plan, period: 'monthly', addonPacks: 0 });
  const other = await signup(t.app);
  const inv = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: other.email, roleId: await roleId(owner.headers, owner.workspaceId, role) })).json();
  expect((await call('POST', `/invitations/${inv.invitation.id}/accept`, other.headers)).statusCode).toBe(200);
  return { owner, other, ws: owner.workspaceId };
}
const profile = async (headers: H, ws: string, name: string, extra: object = {}) => (await call('POST', `/workspaces/${ws}/profiles`, headers, chromiumProfile(name, extra))).json();
const visible = async (headers: H, ws: string) => (await call('GET', `/workspaces/${ws}/profiles`, headers)).json().profiles as { id: string; name: string; ownerId: string; groupId: string | null }[];

describe('invitations', () => {
  it('need a seat on the plan', async () => {
    const owner = await signup(t.app);
    expect(await code(call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: 'x@example.com', roleId: await roleId(owner.headers, owner.workspaceId, 'member') }))).toBe('seat_limit');
  });

  it('are emailed with a link, previewed from it, and accepted by the invited address only', async () => {
    const owner = await signup(t.app);
    await buy(t.app, owner.headers, owner.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const invitee = await signup(t.app, { verify: false });
    const stranger = await signup(t.app);
    const asMember = await roleId(owner.headers, owner.workspaceId, 'member');
    const first = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: invitee.email.toUpperCase(), roleId: await roleId(owner.headers, owner.workspaceId, 'admin') })).json();
    const sent = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: invitee.email, roleId: asMember })).json();
    expect(sent).toMatchObject({ emailed: true, invitation: { email: invitee.email, role: { key: 'member' }, invitedBy: owner.email } });
    expect(ids((await call('GET', `/workspaces/${owner.workspaceId}/invitations`, owner.headers)).json().invitations)).toEqual([sent.invitation.id]);

    const mail = await lastMail(invitee.email);
    expect(mail.Subject).toContain(owner.email);
    const token = new URL(sent.link).searchParams.get('token')!;
    expect(mail.Text).toContain(sent.link);
    expect((await call('GET', `/invitations/by-token/${token}`, {})).json()).toMatchObject({ id: sent.invitation.id, inviter: owner.email, role: { key: 'member' }, expired: false, expiresAt: sent.invitation.expiresAt });
    expect((await call('GET', `/invitations/by-token/${new URL(first.link).searchParams.get('token')}`, {})).statusCode).toBe(404);

    // A link to copy: a new invitation that isn't emailed; the one before stops working.
    const copied = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: invitee.email, roleId: asMember, notify: false })).json();
    expect(copied.emailed).toBe(false);
    expect((await lastMail(invitee.email)).Text).toContain(sent.link);
    expect((await call('GET', `/invitations/by-token/${token}`, {})).statusCode).toBe(404);
    const again = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email: invitee.email, roleId: asMember })).json();
    Object.assign(sent, again);

    expect(ids((await call('GET', '/me/invitations', invitee.headers)).json().invitations)).toEqual([sent.invitation.id]);
    expect(await code(call('POST', `/invitations/${sent.invitation.id}/accept`, stranger.headers))).toBe('wrong_account');
    expect(await code(call('POST', `/invitations/${sent.invitation.id}/accept`, invitee.headers))).toBe('email_unverified');
  });

  it('can be accepted once verified, and then the workspace is theirs to see', async () => {
    const { owner, other, ws } = await team();
    expect((await call('GET', '/me', other.headers)).json().workspaces.map((w: { id: string; role: { key: string } }) => [w.id === ws, w.role.key])).toContainEqual([true, 'member']);
    const members = (await call('GET', `/workspaces/${ws}/members`, owner.headers)).json().members;
    expect(members.map((m: { email: string; role: { key: string } }) => [m.email, m.role.key])).toEqual([[owner.email, 'owner'], [other.email, 'member']]);
    expect((await call('GET', `/workspaces/${ws}/invitations`, owner.headers)).json().invitations).toEqual([]);
  });

  it('expire after seven days, and can be declined or revoked', async () => {
    const owner = await signup(t.app);
    await buy(t.app, owner.headers, owner.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const a = await signup(t.app), b = await signup(t.app), c = await signup(t.app);
    const asMember = await roleId(owner.headers, owner.workspaceId, 'member');
    const invite = async (email: string) => (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email, roleId: asMember })).json();
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

  it('last as long as the inviter chose, and the email says so', async () => {
    const owner = await signup(t.app);
    await buy(t.app, owner.headers, owner.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const email = `short-${Date.now()}@example.com`;
    const res = (await call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email, roleId: await roleId(owner.headers, owner.workspaceId, 'member'), days: 1 })).json();
    expect(Date.parse(res.invitation.expiresAt) - Date.parse(res.invitation.createdAt)).toBe(86_400_000);
    expect((await lastMail(email)).Text).toContain('expires in 1 day');
    expect(await code(call('POST', `/workspaces/${owner.workspaceId}/invitations`, owner.headers, { email, roleId: await roleId(owner.headers, owner.workspaceId, 'member'), days: 2 }))).toBe('validation');
  });

  it('are for owners and admins, and not for people already in the workspace', async () => {
    const { owner, other, ws } = await team();
    const asMember = await roleId(owner.headers, ws, 'member');
    expect(await code(call('POST', `/workspaces/${ws}/invitations`, other.headers, { email: 'x@example.com', roleId: asMember }))).toBe('forbidden');
    expect(await code(call('POST', `/workspaces/${ws}/invitations`, owner.headers, { email: other.email, roleId: asMember }))).toBe('already_member');
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
    expect((await call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { roleId: await roleId(owner.headers, ws, 'admin') })).statusCode).toBe(204);
    expect((await visible(other.headers, ws)).map(p => p.name)).toEqual(['Owner-1']);
    expect(await code(call('PATCH', `/workspaces/${ws}/members/${owner.userId}`, other.headers, { roleId: await roleId(other.headers, ws, 'member') }))).toBe('owner');
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

describe('roles', () => {
  it('come four to a workspace, and say how many people hold them', async () => {
    const { owner, ws } = await team();
    const list = (await call('GET', `/workspaces/${ws}/roles`, owner.headers)).json().roles as { key: string; name: string; permissions: string[]; members: number }[];
    expect(list.map(r => [r.key, r.members])).toEqual([['owner', 1], ['admin', 0], ['member', 1], ['viewer', 0]]);
    expect(list.find(r => r.key === 'owner')!.permissions).toContain('team.manage');
    expect(list.find(r => r.key === 'viewer')!.permissions).toEqual(['profiles.view', 'proxies.view']);
    // What a built-in role starts with stays known after it is changed, so it can be put back.
    const viewer = list.find(r => r.key === 'viewer') as unknown as { id: string };
    const changed = (await call('PATCH', `/roles/${viewer.id}`, owner.headers, { permissions: ['profiles.view'] })).json();
    expect(changed).toMatchObject({ permissions: ['profiles.view'], defaults: ['profiles.view', 'proxies.view'] });
    expect((await call('POST', `/workspaces/${ws}/roles`, owner.headers, { name: 'Ops', permissions: [] })).json().defaults).toBeNull();
  });

  it('say when each person last used Folio', async () => {
    const { owner, other, ws } = await team();
    const members = (await call('GET', `/workspaces/${ws}/members`, owner.headers)).json().members as { userId: string; lastActiveAt: string | null }[];
    expect(members.every(m => m.lastActiveAt && !Number.isNaN(Date.parse(m.lastActiveAt)))).toBe(true);
    expect(members.map(m => m.userId)).toContain(other.userId);
  });

  it('decide what someone may do: taking an action away stops it, giving it back allows it', async () => {
    const { owner, other, ws } = await team();
    const member = await roleId(owner.headers, ws, 'member');
    const p = await profile(other.headers, ws, 'Member-1');

    expect((await call('PATCH', `/roles/${member}`, owner.headers, { permissions: ['profiles.view', 'proxies.view'] })).statusCode).toBe(200);
    expect(await code(call('POST', `/workspaces/${ws}/profiles`, other.headers, chromiumProfile('Another')))).toBe('forbidden');
    expect(await code(call('PATCH', `/profiles/${p.id}`, other.headers, { version: p.version, name: 'Renamed' }))).toBe('forbidden');
    // Reading still works: the list is still theirs to see.
    expect((await visible(other.headers, ws)).map(x => x.name)).toEqual(['Member-1']);

    await call('PATCH', `/roles/${member}`, owner.headers, { permissions: ['profiles.view', 'profiles.create', 'profiles.edit'] });
    expect((await call('POST', `/workspaces/${ws}/profiles`, other.headers, chromiumProfile('Another'))).statusCode).toBe(201);
    // Without proxies.view the library is out of reach, even though profiles are not.
    expect(await code(call('GET', `/workspaces/${ws}/proxies`, other.headers))).toBe('forbidden');
    // Opening and the Trash are each their own action.
    expect(await code(call('GET', `/profiles/${p.id}/launch`, other.headers))).toBe('forbidden');
    expect(await code(call('POST', `/workspaces/${ws}/profiles/batch`, other.headers, { ids: [p.id], action: 'trash' }))).toBe('forbidden');
    await call('PATCH', `/roles/${member}`, owner.headers, { permissions: ['profiles.view', 'profiles.open', 'profiles.delete'] });
    expect((await call('GET', `/profiles/${p.id}/launch`, other.headers)).statusCode).toBe(200);
    expect((await call('POST', `/workspaces/${ws}/profiles/batch`, other.headers, { ids: [p.id], action: 'trash' })).json().updated).toBe(1);
    // Without profiles.view there is no list of them to read, nor of the Trash.
    await call('PATCH', `/roles/${member}`, owner.headers, { permissions: ['proxies.view'] });
    expect(await code(call('GET', `/workspaces/${ws}/profiles`, other.headers))).toBe('forbidden');
    expect(await code(call('GET', `/workspaces/${ws}/profiles?trash=1`, other.headers))).toBe('forbidden');
  });

  it('need proxies.bind to put a profile on a proxy, or take it off one', async () => {
    const { owner, other, ws } = await team();
    const proxy = (await call('POST', `/workspaces/${ws}/proxies`, owner.headers, { type: 'http', host: 'p.example.net', port: 3128 })).json();
    const role = (await call('POST', `/workspaces/${ws}/roles`, owner.headers, { name: 'Editor', permissions: ['profiles.view', 'profiles.create', 'profiles.edit', 'proxies.view'] })).json();
    await call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { roleId: role.id });
    const p = await profile(other.headers, ws, 'Mine');
    expect(await code(call('POST', `/workspaces/${ws}/profiles`, other.headers, chromiumProfile('On-a-proxy', { proxyId: proxy.id })))).toBe('forbidden');
    expect(await code(call('PATCH', `/profiles/${p.id}`, other.headers, { version: p.version, proxyId: proxy.id }))).toBe('forbidden');
    expect(await code(call('POST', `/workspaces/${ws}/profiles/batch`, other.headers, { ids: [p.id], action: 'set-proxy', proxyId: proxy.id }))).toBe('forbidden');
    // Whole forms send the proxy unchanged: that needs nothing more.
    expect((await call('PATCH', `/profiles/${p.id}`, other.headers, { version: p.version, name: 'Mine 2', proxyId: null })).statusCode).toBe(200);

    await call('PATCH', `/roles/${role.id}`, owner.headers, { permissions: ['profiles.view', 'profiles.edit', 'proxies.view', 'proxies.bind'] });
    expect((await call('POST', `/workspaces/${ws}/profiles/batch`, other.headers, { ids: [p.id], action: 'set-proxy', proxyId: proxy.id })).json().updated).toBe(1);
  });

  it('can be made, given out and removed; the built-in four stay and the owner’s never changes', async () => {
    const { owner, other, ws } = await team();
    const made = (await call('POST', `/workspaces/${ws}/roles`, owner.headers, { name: 'Operator', permissions: ['profiles.view', 'profiles.open'] })).json();
    expect(made).toMatchObject({ key: null, name: 'Operator', members: 0 });
    expect(await code(call('POST', `/workspaces/${ws}/roles`, owner.headers, { name: 'Operator', permissions: [] }))).toBe('role_exists');

    expect((await call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { roleId: made.id })).statusCode).toBe(204);
    expect(await code(call('DELETE', `/roles/${made.id}`, owner.headers))).toBe('role_in_use');
    expect(await code(call('POST', `/workspaces/${ws}/profiles`, other.headers, chromiumProfile('Nope')))).toBe('forbidden');

    const owners = await roleId(owner.headers, ws, 'admin');
    expect(await code(call('DELETE', `/roles/${owners}`, owner.headers))).toBe('built_in_role');
    expect(await code(call('PATCH', `/roles/${owners}`, owner.headers, { name: 'Boss' }))).toBe('built_in_role');
    const theOwner = ((await call('GET', `/workspaces/${ws}/roles`, owner.headers)).json().roles as { id: string; key: string }[]).find(r => r.key === 'owner')!.id;
    expect(await code(call('PATCH', `/roles/${theOwner}`, owner.headers, { permissions: [] }))).toBe('owner');
    expect(await code(call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { roleId: theOwner }))).toBe('owner');

    await call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { roleId: await roleId(owner.headers, ws, 'member') });
    expect((await call('DELETE', `/roles/${made.id}`, owner.headers)).statusCode).toBe(204);
  });

  it('are the workspace’s own: one workspace’s role cannot be given in another', async () => {
    const { owner, other, ws } = await team();
    const elsewhere = await signup(t.app);
    const theirs = await roleId(elsewhere.headers, elsewhere.workspaceId, 'admin');
    expect(await code(call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { roleId: theirs }))).toBe('bad_reference');
    expect(await code(call('POST', `/workspaces/${ws}/invitations`, owner.headers, { email: 'x@example.com', roleId: theirs }))).toBe('bad_reference');
    // Not even that it exists: the asker is not in that workspace.
    expect(await code(call('PATCH', `/roles/${theirs}`, owner.headers, { permissions: [] }))).toBe('not_found');
  });
});

describe('group authorisation', () => {
  it('is a Company feature', async () => {
    const { owner, ws } = await team('studio');
    const g = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Sales', description: 'Storefronts' })).json();
    expect(g).toMatchObject({ name: 'Sales', description: 'Storefronts', memberIds: [] });
    expect(await code(call('PATCH', `/groups/${g.id}`, owner.headers, { memberIds: [] }))).toBe('plan_required');
    expect(await code(call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Ops', memberIds: [] }))).toBe('plan_required');
  });

  it('can be set from the person’s side: their groups are replaced, on the Company plan', async () => {
    const { owner, other, ws } = await team('company');
    const a = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'A', memberIds: [other.userId] })).json();
    const b = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'B' })).json();
    expect((await call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, { groupIds: [b.id], roleId: await roleId(owner.headers, ws, 'viewer') })).statusCode).toBe(204);
    const groups = (await call('GET', `/workspaces/${ws}/groups`, owner.headers)).json().groups as { name: string; memberIds: string[] }[];
    expect(groups.map(g => [g.name, g.memberIds])).toEqual([['A', []], ['B', [other.userId]]]);
    const me = ((await call('GET', `/workspaces/${ws}/members`, owner.headers)).json().members as { userId: string; groupIds: string[]; role: { key: string } }[]).find(m => m.userId === other.userId)!;
    expect(me).toMatchObject({ groupIds: [b.id], role: { key: 'viewer' } });
    expect(await code(call('PATCH', `/workspaces/${ws}/members/${other.userId}`, owner.headers, {}))).toBe('validation');
    const studio = await team('studio');
    expect(await code(call('PATCH', `/workspaces/${studio.ws}/members/${studio.other.userId}`, studio.owner.headers, { groupIds: [] }))).toBe('plan_required');
  });

  it('can be given with a new group, which says what it holds', async () => {
    const { owner, other, ws } = await team('company');
    const g = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Sales', description: 'Storefronts', memberIds: [other.userId] })).json();
    expect(g).toMatchObject({ description: 'Storefronts', memberIds: [other.userId] });
    expect((await call('PATCH', `/groups/${g.id}`, owner.headers, { description: null })).json().description).toBeNull();
  });

  it('lets someone see the profiles of the groups they are in, and of those groups’ children', async () => {
    const { owner, other, ws } = await team('company');
    const sales = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Sales' })).json();
    const east = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Sales East', parentId: sales.id })).json();
    const west = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Sales West', parentId: sales.id, inheritMembers: false })).json();
    const shared = await profile(owner.headers, ws, 'Sales-1', { groupId: sales.id });
    const below = await profile(owner.headers, ws, 'East-1', { groupId: east.id });
    await profile(owner.headers, ws, 'West-1', { groupId: west.id });
    expect((await visible(other.headers, ws)).map(p => p.name)).toEqual([]);

    await call('PATCH', `/groups/${sales.id}`, owner.headers, { memberIds: [other.userId] });
    // Sales East takes in whoever Sales lets in; Sales West does not.
    expect((await visible(other.headers, ws)).map(p => p.id).sort()).toEqual([shared.id, below.id].sort());
    expect((await call('GET', `/workspaces/${ws}/members`, owner.headers)).json().members[1].groupIds).toEqual([sales.id]);
    expect((await call('GET', `/workspaces/${ws}/groups`, other.headers)).json().groups.find((g: { id: string }) => g.id === sales.id))
      .toMatchObject({ name: 'Sales', parentId: null, inheritMembers: true, memberIds: [other.userId], profiles: 1 });

    // Deleting a group says where its profiles go; the groups under it move up.
    await call('DELETE', `/groups/${sales.id}`, owner.headers);
    expect((await visible(other.headers, ws))).toEqual([]);
    const left = (await call('GET', `/workspaces/${ws}/groups`, owner.headers)).json().groups as { id: string; name: string; parentId: string | null }[];
    expect(left.map(g => [g.name, g.parentId])).toEqual([['Sales East', null], ['Sales West', null]]);
  });

  it('cannot put a group inside itself, and a deleted group’s profiles go where it is told', async () => {
    const { owner, ws } = await team('company');
    const top = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Top' })).json();
    const mid = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Mid', parentId: top.id })).json();
    const keep = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Keep' })).json();
    expect(await code(call('PATCH', `/groups/${top.id}`, owner.headers, { parentId: mid.id }))).toBe('group_cycle');
    expect(await code(call('PATCH', `/groups/${top.id}`, owner.headers, { parentId: top.id }))).toBe('group_cycle');

    const p = await profile(owner.headers, ws, 'Moves', { groupId: mid.id });
    await call('DELETE', `/groups/${mid.id}?moveTo=${keep.id}`, owner.headers);
    expect((await visible(owner.headers, ws)).find(x => x.id === p.id)).toMatchObject({ groupId: keep.id });
  });

  it('can be part of an invitation', async () => {
    const owner = await signup(t.app);
    await buy(t.app, owner.headers, owner.workspaceId, { plan: 'company', period: 'monthly', addonPacks: 0 });
    const ws = owner.workspaceId;
    const sales = (await call('POST', `/workspaces/${ws}/groups`, owner.headers, { name: 'Sales' })).json();
    await profile(owner.headers, ws, 'Sales-1', { groupId: sales.id });
    const joiner = await signup(t.app);
    const inv = (await call('POST', `/workspaces/${ws}/invitations`, owner.headers, { email: joiner.email, roleId: await roleId(owner.headers, ws, 'member'), groupIds: [sales.id] })).json();
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
