// Members, invitations and departments of a workspace.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { departmentMembers, departments, invitations, memberships, profiles, users, workspaces } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { publish } from '../events.js';
import { record } from '../activity/service.js';
import { requireSession, type Deps } from '../http.js';
import { inviteMail, type Locale } from '../mail.js';
import { entitlements } from '../plans.js';
import { readSub, toState } from '../billing/service.js';
import { sha256 } from '../auth/session.js';
import { assertOwned } from '../profiles/service.js';
import { Department, Invitation, InvitationPreview, Member, MyInvitation, WorkspaceSummary, assignableRole } from '../views.js';
import { requireRole, type Role } from '../workspaces/service.js';
import { assertSeat, removeMember, requireCompany } from './service.js';

const params = z.object({ id: z.uuid() });
const memberParams = z.object({ id: z.uuid(), userId: z.uuid() });
const name = z.string().trim().min(1).max(80);
const MANAGERS: Role[] = ['owner', 'admin'];
const INVITE_DAYS = 7;
const DAY = 86_400_000;

export function teamRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;
  const open = (now: Date) => and(isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now));
  const manager = async (req: Parameters<typeof requireSession>[0], workspaceId: string) => {
    const s = await requireSession(req, deps);
    await requireRole(db, workspaceId, s.userId, MANAGERS);
    return s;
  };
  const emailOf = async (userId: string) => (await db.select({ e: users.email }).from(users).where(eq(users.id, userId)))[0]?.e ?? null;

  // Nobody changes or removes the owner; owners and admins change everyone else.
  async function target(workspaceId: string, userId: string){
    const [m] = await db.select().from(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
    if (!m) throw notFound('Member');
    if (m.role === 'owner') throw new ApiError(403, 'owner', 'The owner stays in the workspace');
    return m;
  }

  // ---------- members ----------
  r.get('/workspaces/:id/members', { schema: { params, response: { 200: z.object({ members: z.array(Member) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requireRole(db, req.params.id, s.userId);
    const rows = await db.select({ userId: memberships.userId, email: users.email, role: memberships.role, joinedAt: memberships.createdAt })
      .from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.workspaceId, req.params.id)).orderBy(asc(memberships.createdAt));
    const depts = await db.select({ userId: departmentMembers.userId, id: departmentMembers.departmentId }).from(departmentMembers)
      .innerJoin(departments, eq(departments.id, departmentMembers.departmentId)).where(eq(departments.workspaceId, req.params.id));
    const counts = await db.select({ ownerId: profiles.ownerId, n: sql<number>`count(*)::int` }).from(profiles)
      .where(and(eq(profiles.workspaceId, req.params.id), isNull(profiles.deletedAt))).groupBy(profiles.ownerId);
    return {
      members: rows.map(m => ({
        ...m, role: m.role as Role, joinedAt: m.joinedAt.toISOString(),
        departmentIds: depts.filter(d => d.userId === m.userId).map(d => d.id), profiles: counts.find(c => c.ownerId === m.userId)?.n ?? 0
      }))
    };
  });

  r.patch('/workspaces/:id/members/:userId', { schema: { params: memberParams, body: z.object({ role: assignableRole }), response: { 204: z.null() } } }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    await target(req.params.id, req.params.userId);
    await db.update(memberships).set({ role: req.body.role }).where(and(eq(memberships.workspaceId, req.params.id), eq(memberships.userId, req.params.userId)));
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'member.role', detail: { email: await emailOf(req.params.userId), role: req.body.role } });
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
    await requireRole(db, req.params.id, s.userId);
    await target(req.params.id, s.userId);
    const [owner] = await db.select({ id: memberships.userId }).from(memberships).where(and(eq(memberships.workspaceId, req.params.id), eq(memberships.role, 'owner')));
    await db.transaction(tx => removeMember(tx, req.params.id, s.userId, owner.id));
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'member.leave', detail: { email: await emailOf(s.userId) } });
    publish(req.params.id, { kind: 'removed', userId: s.userId }); publish(req.params.id, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  // ---------- invitations ----------
  const invitationView = (i: typeof invitations.$inferSelect, inviter: string | null) => ({
    id: i.id, email: i.email, role: i.role as 'admin' | 'member', departmentIds: i.departmentIds, invitedBy: inviter,
    createdAt: i.createdAt.toISOString(), expiresAt: i.expiresAt.toISOString()
  });

  r.get('/workspaces/:id/invitations', { schema: { params, response: { 200: z.object({ invitations: z.array(Invitation) }) } } }, async req => {
    await manager(req, req.params.id);
    const rows = await db.select({ i: invitations, inviter: users.email }).from(invitations).leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.workspaceId, req.params.id), open(clock.now()))).orderBy(asc(invitations.createdAt));
    return { invitations: rows.map(x => invitationView(x.i, x.inviter)) };
  });

  // Emails the invitation (unless `notify` is false: the workbench's "copy link"); the link also comes back so it can be
  // passed on another way. A new invitation to the same address replaces the earlier one and its link.
  r.post('/workspaces/:id/invitations', {
    schema: {
      params, body: z.object({ email: z.email(), role: assignableRole, departmentIds: z.array(z.uuid()).max(50).default([]), notify: z.boolean().default(true) }),
      response: { 201: z.object({ invitation: Invitation, link: z.string(), emailed: z.boolean() }) }
    }
  }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    const now = clock.now(), email = req.body.email.trim().toLowerCase();
    if (req.body.departmentIds.length){
      await requireCompany(db, req.params.id);
      await assertOwned(db, req.params.id, { departmentIds: req.body.departmentIds });
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
        workspaceId: req.params.id, email, role: req.body.role, departmentIds: req.body.departmentIds, tokenHash: sha256(token),
        invitedBy: s.userId, createdAt: now, expiresAt: new Date(now.getTime() + INVITE_DAYS * DAY)
      }).returning();
      return i;
    });
    const [me] = await db.select({ email: users.email, locale: users.locale }).from(users).where(eq(users.id, s.userId));
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, req.params.id));
    const locale = (existing?.locale ?? me.locale) as Locale;
    const link = `${deps.config.siteUrl}/${locale}/invite/?token=${token}`;
    const emailed = req.body.notify && await deps.mailer.send(email, inviteMail(locale, { workspace: ws.name, inviter: me.email, role: req.body.role, url: link }))
      .then(() => true, err => { req.log.error(err, 'sending the invitation failed'); return false; });
    await record(db, { workspaceId: req.params.id, actor: s, at: now, action: 'member.invite', detail: { email, role: req.body.role } });
    publish(req.params.id, { kind: 'members' });
    return reply.code(201).send({ invitation: invitationView(inv, me.email), link, emailed });
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
    const [x] = await db.select({ i: invitations, workspaceName: workspaces.name, inviter: users.email }).from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId)).leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.tokenHash, sha256(req.params.token)), isNull(invitations.acceptedAt), isNull(invitations.revokedAt)));
    if (!x) throw notFound('Invitation');
    return { id: x.i.id, workspaceName: x.workspaceName, inviter: x.inviter, email: x.i.email, role: x.i.role as 'admin' | 'member', expired: x.i.expiresAt <= clock.now(), expiresAt: x.i.expiresAt.toISOString() };
  });

  r.get('/me/invitations', { schema: { response: { 200: z.object({ invitations: z.array(MyInvitation) }) } } }, async req => {
    const s = await requireSession(req, deps);
    const [me] = await db.select({ email: users.email }).from(users).where(eq(users.id, s.userId));
    const rows = await db.select({ i: invitations, workspaceName: workspaces.name, inviter: users.email }).from(invitations)
      .innerJoin(workspaces, eq(workspaces.id, invitations.workspaceId)).leftJoin(users, eq(users.id, invitations.invitedBy))
      .where(and(eq(invitations.email, me.email), open(clock.now()))).orderBy(asc(invitations.createdAt));
    return {
      invitations: rows.map(x => ({ id: x.i.id, workspaceId: x.i.workspaceId, workspaceName: x.workspaceName, inviter: x.inviter, role: x.i.role as 'admin' | 'member', expiresAt: x.i.expiresAt.toISOString() }))
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
    if (!u.emailVerifiedAt) throw new ApiError(403, 'email_unverified', 'Verify your email address first');
    await db.transaction(async tx => {
      // The invitation already held a seat; it still has to fit if the plan shrank since.
      const limit = entitlements(toState(await readSub(tx, i.workspaceId))).members;
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, i.workspaceId));
      if (limit !== null && n >= limit) throw new ApiError(403, 'seat_limit', 'This workspace has no free seat. Ask its owner to upgrade.');
      await tx.insert(memberships).values({ workspaceId: i.workspaceId, userId: u.id, role: i.role, createdAt: now }).onConflictDoNothing();
      const depts = i.departmentIds.length
        ? await tx.select({ id: departments.id }).from(departments).where(and(eq(departments.workspaceId, i.workspaceId), inArray(departments.id, i.departmentIds))) : [];
      if (depts.length) await tx.insert(departmentMembers).values(depts.map(d => ({ departmentId: d.id, userId: u.id }))).onConflictDoNothing();
      await tx.update(invitations).set({ acceptedAt: now }).where(eq(invitations.id, i.id));
      await record(tx, { workspaceId: i.workspaceId, actor: s, at: now, action: 'member.join', detail: { email: u.email, role: i.role } });
    });
    publish(i.workspaceId, { kind: 'members' });
    const [ws] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, i.workspaceId));
    const sub = toState(await readSub(db, i.workspaceId));
    return { id: i.workspaceId, name: ws.name, role: i.role as Role, plan: sub.plan, status: sub.status };
  });

  r.post('/invitations/:id/decline', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { i, now } = await mine(req, req.params.id);
    await db.update(invitations).set({ revokedAt: now }).where(eq(invitations.id, i.id));
    publish(i.workspaceId, { kind: 'members' });
    return reply.code(204).send(null);
  });

  // ---------- departments (Company) ----------
  r.get('/workspaces/:id/departments', { schema: { params, response: { 200: z.object({ departments: z.array(Department) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requireRole(db, req.params.id, s.userId);
    const rows = await db.select().from(departments).where(eq(departments.workspaceId, req.params.id)).orderBy(asc(departments.name));
    const ids = rows.map(d => d.id);
    const members = ids.length ? await db.select().from(departmentMembers).where(inArray(departmentMembers.departmentId, ids)) : [];
    const counts = ids.length ? await db.select({ id: profiles.departmentId, n: sql<number>`count(*)::int` }).from(profiles)
      .where(and(inArray(profiles.departmentId, ids), isNull(profiles.deletedAt))).groupBy(profiles.departmentId) : [];
    return {
      departments: rows.map(d => ({
        id: d.id, name: d.name, memberIds: members.filter(m => m.departmentId === d.id).map(m => m.userId), profiles: counts.find(c => c.id === d.id)?.n ?? 0
      }))
    };
  });

  r.post('/workspaces/:id/departments', { schema: { params, body: z.object({ name }), response: { 201: Department } } }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    await requireCompany(db, req.params.id);
    const [d] = await db.insert(departments).values({ workspaceId: req.params.id, name: req.body.name, createdAt: clock.now() }).onConflictDoNothing().returning();
    if (!d) throw new ApiError(409, 'department_exists', 'A department with this name already exists');
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'department.create', detail: { name: d.name } });
    publish(req.params.id, { kind: 'members' });
    return reply.code(201).send({ id: d.id, name: d.name, memberIds: [], profiles: 0 });
  });

  // Renames, and replaces the member list when `memberIds` is given.
  r.patch('/departments/:id', {
    schema: { params, body: z.object({ name: name.optional(), memberIds: z.array(z.uuid()).max(1000).optional() }), response: { 204: z.null() } }
  }, async (req, reply) => {
    const [d] = await db.select().from(departments).where(eq(departments.id, req.params.id));
    if (!d) throw notFound('Department');
    const s = await manager(req, d.workspaceId);
    await requireCompany(db, d.workspaceId);
    const memberIds = req.body.memberIds ? [...new Set(req.body.memberIds)] : undefined;
    if (memberIds) await assertOwned(db, d.workspaceId, { ownerIds: memberIds });
    await db.transaction(async tx => {
      if (req.body.name) await tx.update(departments).set({ name: req.body.name }).where(eq(departments.id, d.id)).catch(() => {
        throw new ApiError(409, 'department_exists', 'A department with this name already exists');
      });
      if (memberIds){
        await tx.delete(departmentMembers).where(eq(departmentMembers.departmentId, d.id));
        if (memberIds.length) await tx.insert(departmentMembers).values(memberIds.map(userId => ({ departmentId: d.id, userId })));
      }
      await record(tx, { workspaceId: d.workspaceId, actor: s, at: clock.now(), action: 'department.update', detail: { name: req.body.name ?? d.name, ...(req.body.name ? { from: d.name } : {}), ...(memberIds ? { members: memberIds.length } : {}) } });
    });
    publish(d.workspaceId, { kind: 'members' }); publish(d.workspaceId, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  // Its profiles stay, without a department.
  r.delete('/departments/:id', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const [d] = await db.select().from(departments).where(eq(departments.id, req.params.id));
    if (!d) throw notFound('Department');
    const s = await manager(req, d.workspaceId);
    await db.delete(departments).where(eq(departments.id, d.id));
    await record(db, { workspaceId: d.workspaceId, actor: s, at: clock.now(), action: 'department.delete', detail: { name: d.name } });
    publish(d.workspaceId, { kind: 'members' }); publish(d.workspaceId, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

}
