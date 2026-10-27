// Members, invitations and roles of a workspace.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { groupMembers, groups, invitations, memberships, profiles, roles, sessions, users, workspaces } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { publish } from '../events.js';
import { record } from '../activity/service.js';
import { requireSession, type Deps } from '../http.js';
import { inviteMail, type Locale } from '../mail.js';
import { entitlements } from '../plans.js';
import { readSub, toState } from '../billing/service.js';
import { sha256 } from '../auth/session.js';
import { assertOwned } from '../profiles/service.js';
import { Invitation, InvitationPreview, Member, MyInvitation, Role, WorkspaceSummary } from '../views.js';
import { membership, requirePermission } from '../workspaces/service.js';
import { BUILT_IN, MANAGE, PERMISSIONS, type BuiltInRole, type Permission } from '../permissions.js';
import { assertSeat, removeMember, requireCompany } from './service.js';

const params = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const name = z.string().trim().min(1).max(80);
const DAY = 86_400_000;

export function teamRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;
  const open = (now: Date) => and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now));
  const manager = async (req: Parameters<typeof requireSession>[0], workspaceId: string) => {
    const s = await requireSession(req, deps);
    await requirePermission(db, workspaceId, s.userId, MANAGE);
    return s;
  };
  const roleRef = (r: { id: string; key: string | null; name: string }) => ({ id: r.id, key: r.key as z.infer<typeof Role>['key'], name: r.name });
  // A role of this workspace, which is never the owner's: nobody is given or invited to that one.
  async function assignableRole(workspaceId: string, roleId: string){
    const [r] = await db.select().from(roles).where(and(eq(roles.id, roleId), eq(roles.workspaceId, workspaceId)));
    if (!r) throw new ApiError(400, 'bad_reference', 'Unknown role');
    if (r.key === 'owner') throw new ApiError(403, 'owner', 'The owner\u2019s role is not given out');
    return r;
  }
  const emailOf = async (userId: string) => (await db.select({ e: users.email }).from(users).where(eq(users.id, userId)))[0]?.e ?? null;

  // Nobody changes or removes the owner; whoever manages members changes everyone else.
  async function target(workspaceId: string, userId: string){
    const [m] = await db.select({ m: memberships, key: roles.key }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    if (!m) throw notFound('Member');
    if (m.key === 'owner') throw new ApiError(403, 'owner', 'The owner stays in the workspace');
    return m.m;
  }

  // ---------- members ----------
  r.get('/workspaces/:id/members', { schema: { params, response: { 200: z.object({ members: z.array(Member) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await membership(db, req.params.id, s.userId);
    const rows = await db.select({ userId: memberships.userId, email: users.email, displayName: users.displayName, roleId: roles.id, key: roles.key, roleName: roles.name, joinedAt: memberships.createdAt })
      .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(eq(memberships.workspaceId, req.params.id)).orderBy(asc(memberships.createdAt));
    const grants = await db.select({ userId: groupMembers.userId, id: groupMembers.groupId }).from(groupMembers)
      .innerJoin(groups, eq(groups.id, groupMembers.groupId)).where(eq(groups.workspaceId, req.params.id));
    const counts = await db.select({ ownerId: profiles.ownerId, n: sql<number>`count(*)::int` }).from(profiles)
      .where(and(eq(profiles.workspaceId, req.params.id), isNull(profiles.deletedAt))).groupBy(profiles.ownerId);
    const seen = rows.length ? await db.select({ userId: sessions.userId, at: sql<Date>`max(${sessions.lastUsedAt})` }).from(sessions)
      .where(inArray(sessions.userId, rows.map(m => m.userId))).groupBy(sessions.userId) : [];
    return {
      members: rows.map(m => {
        const at = seen.find(x => x.userId === m.userId)?.at;
        return {
          userId: m.userId, email: m.email, displayName: m.displayName, role: roleRef({ id: m.roleId, key: m.key, name: m.roleName }), joinedAt: m.joinedAt.toISOString(),
          groupIds: grants.filter(g => g.userId === m.userId).map(g => g.id), profiles: counts.find(c => c.ownerId === m.userId)?.n ?? 0,
          lastActiveAt: at ? new Date(at).toISOString() : null
        };
      })
    };
  });

  // Someone's role, and (Company) the groups they are authorised for, which replace the ones they had.
  r.patch('/workspaces/:id/members/:userId', {
    schema: {
      params: memberParams,
      body: z.object({ roleId: z.uuid().optional(), groupIds: z.array(z.uuid()).max(500).optional() }).refine(b => b.roleId || b.groupIds, 'Nothing to change'),
      response: { 204: z.null() }
    }
  }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    await target(req.params.id, req.params.userId);
    const email = await emailOf(req.params.userId), now = clock.now();
    if (req.body.roleId){
      const role = await assignableRole(req.params.id, req.body.roleId);
      await db.update(memberships).set({ roleId: role.id }).where(and(eq(memberships.workspaceId, req.params.id), eq(memberships.userId, req.params.userId)));
      await record(db, { workspaceId: req.params.id, actor: s, at: now, action: 'member.role', detail: { email, role: role.name } });
    }
    if (req.body.groupIds){
      const wanted = [...new Set(req.body.groupIds)];
      await requireCompany(db, req.params.id);
      await assertOwned(db, req.params.id, { groupIds: wanted });
      await db.transaction(async tx => {
        const mine = tx.select({ id: groups.id }).from(groups).where(eq(groups.workspaceId, req.params.id));
        await tx.delete(groupMembers).where(and(eq(groupMembers.userId, req.params.userId), inArray(groupMembers.groupId, mine)));
        if (wanted.length) await tx.insert(groupMembers).values(wanted.map(groupId => ({ groupId, userId: req.params.userId })));
      });
      await record(db, { workspaceId: req.params.id, actor: s, at: now, action: 'member.groups', detail: { email, groups: wanted.length } });
      publish(req.params.id, { kind: 'groups' });
    }
    publish(req.params.id, { kind: 'members' }); publish(req.params.id, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  // Their profiles go to `transferTo`; their open profiles and live connection to the workspace end.
  r.delete('/workspaces/:id/members/:userId', {
    schema: { params: memberParams, querystring: z.object({ transferTo: z.uuid() }), response: { 204: z.null() } }
  }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    await target(req.params.id, req.params.userId);
    if (req.query.transferTo === req.params.userId) throw new ApiError(400, 'bad_reference', 'Choose someone else to take over the profiles');
    await assertOwned(db, req.params.id, { ownerIds: [req.query.transferTo] });
    await db.transaction(tx => removeMember(tx, req.params.id, req.params.userId, req.query.transferTo));
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'member.remove', detail: { email: await emailOf(req.params.userId), to: await emailOf(req.query.transferTo) } });
    publish(req.params.id, { kind: 'removed', userId: req.params.userId }); publish(req.params.id, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  // Leaving hands your profiles to the owner.
  r.post('/workspaces/:id/leave', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await membership(db, req.params.id, s.userId);
    await target(req.params.id, s.userId);
    const [owner] = await db.select({ id: memberships.userId }).from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.workspaceId, req.params.id), eq(roles.key, 'owner')));
    await db.transaction(tx => removeMember(tx, req.params.id, s.userId, owner.id));
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'member.leave', detail: { email: await emailOf(s.userId) } });
    publish(req.params.id, { kind: 'removed', userId: s.userId }); publish(req.params.id, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  // ---------- invitations ----------
  const invitationView = (i: typeof invitations.$inferSelect, role: { id: string; key: string | null; name: string }, inviter: string | null) => ({
    id: i.id, email: i.email, role: roleRef(role), groupIds: i.groupIds, invitedBy: inviter,
    createdAt: i.createdAt.toISOString(), expiresAt: i.expiresAt.toISOString()
  });

  r.get('/workspaces/:id/invitations', { schema: { params, response: { 200: z.object({ invitations: z.array(Invitation) }) } } }, async req => {
    await manager(req, req.params.id);
    const rows = await db.select({ i: invitations, role: roles, inviter: users.email }).from(invitations)
      .innerJoin(roles, eq(roles.id, invitations.roleId)).leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.workspaceId, req.params.id), open(clock.now()))).orderBy(asc(invitations.createdAt));
    return { invitations: rows.map(x => invitationView(x.i, x.role, x.inviter)) };
  });

  // Emails the invitation (unless `notify` is false: the workbench's "copy link"); the link also comes back so it can be
  // passed on another way. A new invitation to the same address replaces the earlier one and its link.
  r.post('/workspaces/:id/invitations', {
    schema: {
      params, body: z.object({
        email: z.email(), roleId: z.uuid(), groupIds: z.array(z.uuid()).max(50).default([]), notify: z.boolean().default(true),
        // How long the link works.
        days: z.union([z.literal(1), z.literal(3), z.literal(7), z.literal(30)]).default(7)
      }),
      response: { 201: z.object({ invitation: Invitation, link: z.string(), emailed: z.boolean() }) }
    }
  }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    const now = clock.now(), email = req.body.email.trim().toLowerCase();
    const role = await assignableRole(req.params.id, req.body.roleId);
    if (req.body.groupIds.length){
      await requireCompany(db, req.params.id);
      await assertOwned(db, req.params.id, { groupIds: req.body.groupIds });
    }
    const [existing] = await db.select({ id: users.id, locale: users.locale }).from(users).where(eq(users.email, email));
    if (existing && (await db.select().from(memberships).where(and(eq(memberships.workspaceId, req.params.id), eq(memberships.userId, existing.id)))).length){
      throw new ApiError(409, 'already_member', 'This person is already in the workspace');
    }
    const token = randomBytes(24).toString('base64url');
    // Inviting the same address again replaces the earlier invitation.
    const inv = await db.transaction(async tx => {
      await tx.update(invitations).set({ revokedAt: now }).where(and(eq(invitations.workspaceId, req.params.id), eq(invitations.email, email), open(now)));
      await assertSeat(tx, req.params.id, now);
      const [i] = await tx.insert(invitations).values({
        workspaceId: req.params.id, email, roleId: role.id, groupIds: req.body.groupIds, tokenHash: sha256(token),
        invitedBy: s.userId, createdAt: now, expiresAt: new Date(now.getTime() + req.body.days * DAY)
      }).returning();
      return i;
    });
    const [me] = await db.select({ email: users.email, locale: users.locale }).from(users).where(eq(users.id, s.userId));
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, req.params.id));
    const locale = (existing?.locale ?? me.locale) as Locale;
    const link = `${deps.config.siteUrl}/${locale}/invite/?token=${token}`;
    const emailed = req.body.notify && await deps.mailer.send(email, inviteMail(locale, { workspace: ws.name, inviter: me.email, role: { key: role.key, name: role.name }, url: link, days: req.body.days }))
      .then(() => true, err => { req.log.error(err, 'sending the invitation failed'); return false; });
    await record(db, { workspaceId: req.params.id, actor: s, at: now, action: 'member.invite', detail: { email, role: role.name } });
    publish(req.params.id, { kind: 'members' });
    return reply.code(201).send({ invitation: invitationView(inv, role, me.email), link, emailed });
  });

  r.delete('/invitations/:id', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const [i] = await db.select().from(invitations).where(eq(invitations.id, req.params.id));
    if (!i) throw notFound('Invitation');
    const s = await manager(req, i.workspaceId);
    await db.update(invitations).set({ revokedAt: clock.now() }).where(eq(invitations.id, i.id));
    await record(db, { workspaceId: i.workspaceId, actor: s, at: clock.now(), action: 'invitation.withdraw', detail: { email: i.email } });
    publish(i.workspaceId, { kind: 'members' });
    return reply.code(204).send(null);
  });

  // The invitation page, before anyone logs in.
  r.get('/invitations/by-token/:token', { schema: { params: z.object({ token: z.string().max(100) }), response: { 200: InvitationPreview } } }, async req => {
    const [x] = await db.select({ i: invitations, role: roles, workspaceName: workspaces.name, inviter: users.email }).from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId)).innerJoin(roles, eq(roles.id, invitations.roleId))
      .leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.tokenHash, sha256(req.params.token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    if (!x) throw notFound('Invitation');
    return { id: x.i.id, workspaceName: x.workspaceName, inviter: x.inviter, email: x.i.email, role: roleRef(x.role), expired: x.i.expiresAt <= clock.now(), expiresAt: x.i.expiresAt.toISOString() };
  });

  r.get('/me/invitations', { schema: { response: { 200: z.object({ invitations: z.array(MyInvitation) }) } } }, async req => {
    const s = await requireSession(req, deps);
    const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, s.userId));
    const rows = await db.select({ i: invitations, role: roles, workspaceName: workspaces.name, inviter: users.email }).from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId)).innerJoin(roles, eq(roles.id, invitations.roleId))
      .leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.email, me.email), open(clock.now()))).orderBy(asc(invitations.createdAt));
    return {
      invitations: rows.map(x => ({ id: x.i.id, workspaceId: x.i.workspaceId, workspaceName: x.workspaceName, inviter: x.inviter, role: roleRef(x.role), expiresAt: x.i.expiresAt.toISOString() }))
    };
  });

  // Only the invited address, verified, can accept or decline.
  async function mine(req: Parameters<typeof requireSession>[0], id: string){
    const s = await requireSession(req, deps);
    const now = clock.now();
    const [i] = await db.select().from(invitations).where(and(eq(invitations.id, id), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    if (!i) throw notFound('Invitation');
    const [u] = await db.select().from(users).where(eq(users.id, s.userId));
    if (u.email !== i.email) throw new ApiError(403, 'wrong_account', `This invitation is for ${i.email}`);
    if (i.expiresAt <= now) throw new ApiError(410, 'invitation_expired', 'This invitation has expired. Ask for a new one.');
    return { i, u, s, now };
  }

  r.post('/invitations/:id/accept', { schema: { params, response: { 200: WorkspaceSummary } } }, async req => {
    const { i, u, s, now } = await mine(req, req.params.id);
    const [role] = await db.select().from(roles).where(eq(roles.id, i.roleId));
    if (!u.emailVerifiedAt) throw new ApiError(403, 'email_unverified', 'Verify your email address first');
    await db.transaction(async tx => {
      // The invitation already held a seat; it still has to fit if the plan shrank since.
      const limit = entitlements(toState(await readSub(tx, i.workspaceId))).members;
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, i.workspaceId));
      if (limit !== null && n >= limit) throw new ApiError(403, 'seat_limit', 'This workspace has no free seat. Ask its owner to upgrade.');
      await tx.insert(memberships).values({ workspaceId: i.workspaceId, userId: u.id, roleId: i.roleId, createdAt: now }).onConflictDoNothing();
      const theirs = i.groupIds.length
        ? await tx.select({ id: groups.id }).from(groups).where(and(eq(groups.workspaceId, i.workspaceId), inArray(groups.id, i.groupIds))) : [];
      if (theirs.length) await tx.insert(groupMembers).values(theirs.map(g => ({ groupId: g.id, userId: u.id }))).onConflictDoNothing();
      await tx.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, i.id));
      await record(tx, { workspaceId: i.workspaceId, actor: s, at: now, action: 'member.join', detail: { email: u.email, role: role.name } });
    });
    publish(i.workspaceId, { kind: 'members' });
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, i.workspaceId));
    const sub = toState(await readSub(db, i.workspaceId));
    return { id: i.workspaceId, name: ws.name, role: { ...roleRef(role), permissions: role.permissions as Permission[] }, plan: sub.plan, status: sub.status };
  });

  r.post('/invitations/:id/decline', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { i, now } = await mine(req, req.params.id);
    await db.update(invitations).set({ revokedAt: now }).where(eq(invitations.id, i.id));
    publish(i.workspaceId, { kind: 'members' });
    return reply.code(204).send(null);
  });

  // ---------- roles ----------
  // Everyone sees what the roles mean; changing them goes with managing members.
  r.get('/workspaces/:id/roles', { schema: { params, response: { 200: z.object({ roles: z.array(Role) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await membership(db, req.params.id, s.userId);
    const rows = await db.select({ r: roles, members: sql<number>`count(${memberships.userId})::int` }).from(roles)
      .leftJoin(memberships, eq(memberships.roleId, roles.id))
      .where(eq(roles.workspaceId, req.params.id)).groupBy(roles.id)
      // The four built-in roles first, in their own order, then the workspace's own by name.
      .orderBy(asc(sql`array_position(ARRAY['owner','admin','member','viewer'], ${roles.key})`), asc(roles.name));
    return { roles: rows.map(x => ({ ...roleRef(x.r), permissions: x.r.permissions as Permission[], members: x.members, defaults: defaultsOf(x.r.key) })) };
  });

  const permissions = z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length);
  const defaultsOf = (key: string | null) => (key ? BUILT_IN[key as BuiltInRole].permissions : null);
  const taken = () => new ApiError(409, 'role_exists', 'A role with this name already exists');

  r.post('/workspaces/:id/roles', { schema: { params, body: z.object({ name, permissions }), response: { 201: Role } } }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    const [r0] = await db.insert(roles).values({
      workspaceId: req.params.id, key: null, name: req.body.name, permissions: [...new Set(req.body.permissions)], createdAt: clock.now()
    }).onConflictDoNothing().returning();
    if (!r0) throw taken();
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'role.create', detail: { name: r0.name } });
    publish(req.params.id, { kind: 'members' });
    return reply.code(201).send({ ...roleRef(r0), permissions: r0.permissions as Permission[], members: 0, defaults: null });
  });

  // A role of the workspace's own can be renamed; any role but the owner's can have its actions changed.
  r.patch('/roles/:id', {
    schema: { params, body: z.object({ name: name.optional(), permissions: permissions.optional() }), response: { 200: Role } }
  }, async req => {
    const [r0] = await db.select().from(roles).where(eq(roles.id, req.params.id));
    if (!r0) throw notFound('Role');
    const s = await manager(req, r0.workspaceId);
    if (r0.key === 'owner') throw new ApiError(403, 'owner', 'The owner’s role always has every action');
    if (req.body.name && r0.key) throw new ApiError(403, 'built_in_role', 'A role that comes with every workspace keeps its name');
    const [u] = await db.update(roles).set({
      ...(req.body.name ? { name: req.body.name } : {}),
      ...(req.body.permissions ? { permissions: [...new Set(req.body.permissions)] } : {})
    }).where(eq(roles.id, r0.id)).returning().catch(() => { throw taken(); });
    const [{ members }] = await db.select({ members: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.roleId, u.id));
    await record(db, { workspaceId: r0.workspaceId, actor: s, at: clock.now(), action: 'role.update', detail: { name: u.name } });
    publish(r0.workspaceId, { kind: 'members' }); publish(r0.workspaceId, { kind: 'profiles' });
    return { ...roleRef(u), permissions: u.permissions as Permission[], members, defaults: defaultsOf(u.key) };
  });

  // Only a role the workspace made itself, and only while nobody holds it.
  r.delete('/roles/:id', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const [r0] = await db.select().from(roles).where(eq(roles.id, req.params.id));
    if (!r0) throw notFound('Role');
    const s = await manager(req, r0.workspaceId);
    if (r0.key) throw new ApiError(403, 'built_in_role', 'A role that comes with every workspace stays');
    const [{ held }] = await db.select({ held: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.roleId, r0.id));
    const [{ invited }] = await db.select({ invited: sql<number>`count(*)::int` }).from(invitations)
      .where(and(eq(invitations.roleId, r0.id), open(clock.now())));
    if (held + invited > 0) throw new ApiError(409, 'role_in_use', 'Give the people with this role another one first');
    await db.delete(roles).where(eq(roles.id, r0.id));
    await record(db, { workspaceId: r0.workspaceId, actor: s, at: clock.now(), action: 'role.delete', detail: { name: r0.name } });
    publish(r0.workspaceId, { kind: 'members' });
    return reply.code(204).send(null);
  });

}
