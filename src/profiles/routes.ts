import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { departments, groups, profileData, profiles, proxies, users } from '../db/schema.js';
import { record } from '../activity/service.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { publish } from '../events.js';
import { requireSession, type Deps } from '../http.js';
import { open } from '../crypto.js';
import { Fingerprint, Group, Profile, ProxySecret, kernel, os, profileView } from '../views.js';
import { requireRole, type Role } from '../workspaces/service.js';
import { requireCompany } from '../team/service.js';
import { access, assertOwned, loadProfiles, nextNumbers, profileFor, reserve } from './service.js';

const wsParams = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(80);
const tag = z.string().trim().min(1).max(24);
const version = z.string().regex(/^[\w.-]{1,40}$/);
const tz = z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/).max(64);
const locale = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).max(35);
const MAX_FP_BYTES = 64 * 1024;

const newProfile = z.object({
  name, groupId: z.uuid().nullable().optional(), tags: z.array(tag).max(10).default([]),
  // Defaults to the person creating it; only owners and admins assign someone else or a department.
  ownerId: z.uuid().nullable().optional(), departmentId: z.uuid().nullable().optional(),
  kernel, kernelVersion: version, os, fingerprint: Fingerprint, proxyId: z.uuid().nullable().optional(),
  timezoneOverride: tz.nullable().optional(), localeOverride: locale.nullable().optional(), notes: z.string().max(2000).nullable().optional()
});
type NewProfile = z.infer<typeof newProfile>;

function checkFingerprint(p: { kernel?: string; fingerprint?: z.infer<typeof Fingerprint> }){
  if (p.fingerprint && p.kernel && p.fingerprint.kind !== p.kernel) throw new ApiError(400, 'fingerprint_kernel', 'The fingerprint does not match the engine');
  if (p.fingerprint && JSON.stringify(p.fingerprint).length > MAX_FP_BYTES) throw new ApiError(400, 'fingerprint_size', 'The fingerprint is too large');
}

export function profileRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock, storage } = deps;

  // The session, the person's role and which profiles they see (see access()).
  async function member(req: Parameters<typeof requireSession>[0], workspaceId: string){
    const s = await requireSession(req, deps);
    return { s, ...(await access(db, workspaceId, s.userId)) };
  }
  const MANAGERS: Role[] = ['owner', 'admin'];
  async function manager(req: Parameters<typeof requireSession>[0], workspaceId: string){
    const s = await requireSession(req, deps);
    await requireRole(db, workspaceId, s.userId, MANAGERS);
    return s;
  }
  // Assigning people and departments is for owners and admins; departments need the Company plan.
  async function checkAssignment(workspaceId: string, role: Role, items: { ownerId?: string | null; departmentId?: string | null }[]){
    if (role === 'member' && items.some(i => i.ownerId !== undefined || i.departmentId !== undefined)) throw forbidden();
    if (items.some(i => i.departmentId)) await requireCompany(db, workspaceId);
    await assertOwned(db, workspaceId, { ownerIds: items.map(i => i.ownerId), departmentIds: items.map(i => i.departmentId) });
  }

  // ---------- groups ----------
  r.get('/workspaces/:id/groups', { schema: { params: wsParams, response: { 200: z.object({ groups: z.array(Group) }) } } }, async req => {
    const { scope } = await member(req, req.params.id);
    const rows = await db.select({ id: groups.id, name: groups.name, profiles: sql<number>`count(${profiles.id}) filter (where ${profiles.deletedAt} is null)::int` })
      .from(groups).leftJoin(profiles, and(eq(profiles.groupId, groups.id), scope))
      .where(eq(groups.workspaceId, req.params.id)).groupBy(groups.id).orderBy(asc(groups.name));
    return { groups: rows };
  });

  r.post('/workspaces/:id/groups', { schema: { params: wsParams, body: z.object({ name }), response: { 201: Group } } }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    const [g] = await db.insert(groups).values({ workspaceId: req.params.id, name: req.body.name, createdAt: clock.now() }).onConflictDoNothing().returning();
    if (!g) throw new ApiError(409, 'group_exists', 'A group with this name already exists');
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'group.create', detail: { name: g.name } });
    publish(req.params.id, { kind: 'groups' });
    return reply.code(201).send({ id: g.id, name: g.name, profiles: 0 });
  });

  r.patch('/groups/:id', { schema: { params: wsParams, body: z.object({ name }), response: { 200: z.object({ id: z.string(), name: z.string() }) } } }, async req => {
    const [g] = await db.select().from(groups).where(eq(groups.id, req.params.id));
    if (!g) throw notFound('Group');
    const s = await manager(req, g.workspaceId);
    const [u] = await db.update(groups).set({ name: req.body.name }).where(eq(groups.id, g.id)).returning().catch(() => {
      throw new ApiError(409, 'group_exists', 'A group with this name already exists');
    });
    await record(db, { workspaceId: g.workspaceId, actor: s, at: clock.now(), action: 'group.rename', detail: { name: u.name, from: g.name } });
    publish(g.workspaceId, { kind: 'groups' });
    return { id: u.id, name: u.name };
  });

  // Profiles in a deleted group stay, without a group.
  r.delete('/groups/:id', { schema: { params: wsParams, response: { 204: z.null() } } }, async (req, reply) => {
    const [g] = await db.select().from(groups).where(eq(groups.id, req.params.id));
    if (!g) throw notFound('Group');
    const s = await manager(req, g.workspaceId);
    await db.delete(groups).where(eq(groups.id, g.id));
    await record(db, { workspaceId: g.workspaceId, actor: s, at: clock.now(), action: 'group.delete', detail: { name: g.name } });
    publish(g.workspaceId, { kind: 'groups' }); publish(g.workspaceId, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  // ---------- profiles ----------
  r.get('/workspaces/:id/profiles', {
    schema: { params: wsParams, querystring: z.object({ trash: z.enum(['0', '1']).default('0') }), response: { 200: z.object({ profiles: z.array(Profile) }) } }
  }, async req => {
    const { s, scope } = await member(req, req.params.id);
    const where = and(eq(profiles.workspaceId, req.params.id), req.query.trash === '1' ? isNotNull(profiles.deletedAt) : isNull(profiles.deletedAt), scope);
    return { profiles: await loadProfiles(db, where, s.id, clock.now()) };
  });

  async function create(workspaceId: string, s: { userId: string; deviceName: string | null }, role: Role, items: NewProfile[]){
    const userId = s.userId;
    items.forEach(checkFingerprint);
    await checkAssignment(workspaceId, role, items);
    await assertOwned(db, workspaceId, { groupIds: items.map(i => i.groupId), proxyIds: items.map(i => i.proxyId) });
    const now = clock.now();
    const rows = await db.transaction(async tx => {
      await reserve(tx, workspaceId, items.length);
      const numbers = await nextNumbers(tx, workspaceId, items.length);
      return tx.insert(profiles).values(items.map((i, k) => ({
        ...i, ownerId: i.ownerId === undefined ? userId : i.ownerId, workspaceId, number: numbers[k], createdBy: userId, createdAt: now, updatedAt: now
      }))).returning();
    });
    await record(db, { workspaceId, actor: s, at: now, action: 'profile.create', profiles: rows });
    publish(workspaceId, { kind: 'profiles', ids: rows.map(p => p.id) });
    return rows;
  }

  r.post('/workspaces/:id/profiles', { schema: { params: wsParams, body: newProfile, response: { 201: Profile } } }, async (req, reply) => {
    const { s, role } = await member(req, req.params.id);
    const [p] = await create(req.params.id, s, role, [req.body]);
    return reply.code(201).send(profileView(p));
  });

  // Bulk create, used by the spreadsheet import. All or nothing.
  r.post('/workspaces/:id/profiles/bulk', {
    schema: { params: wsParams, body: z.object({ profiles: z.array(newProfile).min(1).max(500) }), response: { 201: z.object({ profiles: z.array(Profile) }) } }
  }, async (req, reply) => {
    const { s, role } = await member(req, req.params.id);
    return reply.code(201).send({ profiles: (await create(req.params.id, s, role, req.body.profiles)).map(p => profileView(p)) });
  });

  // Optimistic concurrency: the client sends the version it edited; a newer one on the server is a conflict.
  r.patch('/profiles/:id', {
    schema: {
      params: wsParams,
      body: z.object({
        version: z.number().int(), name: name.optional(), groupId: z.uuid().nullable().optional(), tags: z.array(tag).max(10).optional(),
        ownerId: z.uuid().nullable().optional(), departmentId: z.uuid().nullable().optional(),
        proxyId: z.uuid().nullable().optional(), kernelVersion: version.optional(), os: os.optional(), fingerprint: Fingerprint.optional(),
        timezoneOverride: tz.nullable().optional(), localeOverride: locale.nullable().optional(), notes: z.string().max(2000).nullable().optional()
      }),
      response: { 200: Profile }
    }
  }, async req => {
    const { p, s, role } = await profileFor(deps, req, req.params.id);
    const { version: v, ...patch } = req.body;
    checkFingerprint({ kernel: p.kernel, fingerprint: patch.fingerprint });
    await checkAssignment(p.workspaceId, role, [patch]);
    await assertOwned(db, p.workspaceId, { groupIds: [patch.groupId], proxyIds: [patch.proxyId] });
    const [u] = await db.update(profiles).set({ ...patch, version: sql`${profiles.version} + 1`, updatedAt: clock.now() })
      .where(and(eq(profiles.id, p.id), eq(profiles.version, v))).returning();
    if (!u) throw new ApiError(409, 'stale', 'Someone changed this profile in the meantime. Reload it and try again.');
    // Clients send whole forms; the entry names only what actually changed.
    const fields = (Object.keys(patch) as (keyof typeof patch)[]).filter(k => JSON.stringify(patch[k] ?? null) !== JSON.stringify(p[k] ?? null));
    if (fields.length) await record(db, { workspaceId: p.workspaceId, actor: s, at: u.updatedAt, action: 'profile.update', profiles: [u], detail: { fields } });
    publish(p.workspaceId, { kind: 'profiles', ids: [p.id] });
    return (await loadProfiles(db, eq(profiles.id, u.id), s.id, clock.now()))[0];
  });

  r.post('/workspaces/:id/profiles/batch', {
    schema: {
      params: wsParams,
      body: z.object({
        ids: z.array(z.uuid()).min(1).max(2000),
        action: z.enum(['move', 'tag', 'untag', 'set-proxy', 'assign', 'set-department', 'trash', 'restore', 'purge']),
        groupId: z.uuid().nullable().optional(), tag: tag.optional(), proxyId: z.uuid().nullable().optional(),
        ownerId: z.uuid().nullable().optional(), departmentId: z.uuid().nullable().optional()
      }),
      response: { 200: z.object({ updated: z.number() }) }
    }
  }, async req => {
    const { s, role, scope } = await member(req, req.params.id);
    const { ids, action } = req.body;
    // Members change their own profiles' group, tags and proxy; the rest is for owners and admins.
    if (role === 'member' && !['move', 'tag', 'untag', 'set-proxy'].includes(action)) throw forbidden();
    const now = clock.now();
    const mine = and(eq(profiles.workspaceId, req.params.id), inArray(profiles.id, ids), scope);
    const bump = { version: sql`${profiles.version} + 1`, updatedAt: now };
    const ref = { id: profiles.id, name: profiles.name, number: profiles.number };
    let updated: { id: string; name: string; number: number }[];
    switch (action){
      case 'move':
        await assertOwned(db, req.params.id, { groupIds: [req.body.groupId] });
        updated = await db.update(profiles).set({ ...bump, groupId: req.body.groupId ?? null }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      case 'set-proxy':
        await assertOwned(db, req.params.id, { proxyIds: [req.body.proxyId] });
        updated = await db.update(profiles).set({ ...bump, proxyId: req.body.proxyId ?? null }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      case 'assign':
        await assertOwned(db, req.params.id, { ownerIds: [req.body.ownerId] });
        updated = await db.update(profiles).set({ ...bump, ownerId: req.body.ownerId ?? null }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      case 'set-department':
        if (req.body.departmentId) await requireCompany(db, req.params.id);
        await assertOwned(db, req.params.id, { departmentIds: [req.body.departmentId] });
        updated = await db.update(profiles).set({ ...bump, departmentId: req.body.departmentId ?? null }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      case 'tag': case 'untag': {
        const t = req.body.tag;
        if (!t) throw new ApiError(400, 'validation', 'A tag is required');
        const tags = action === 'tag'
          ? sql`case when ${t} = any(${profiles.tags}) or cardinality(${profiles.tags}) >= 10 then ${profiles.tags} else array_append(${profiles.tags}, ${t}) end`
          : sql`array_remove(${profiles.tags}, ${t})`;
        updated = await db.update(profiles).set({ ...bump, tags }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      }
      case 'trash':
        updated = await db.update(profiles).set({ ...bump, deletedAt: now }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      case 'restore':
        updated = await db.transaction(async tx => {
          const trashed = await tx.select({ id: profiles.id }).from(profiles).where(and(mine, isNotNull(profiles.deletedAt)));
          await reserve(tx, req.params.id, trashed.length);
          return tx.update(profiles).set({ ...bump, deletedAt: null }).where(and(mine, isNotNull(profiles.deletedAt))).returning(ref);
        });
        break;
      case 'purge': {
        const saved = await db.select({ key: profileData.objectKey }).from(profileData).innerJoin(profiles, eq(profiles.id, profileData.profileId)).where(and(mine, isNotNull(profiles.deletedAt)));
        // Written before the rows go; deleting them then clears the entries' link but keeps name and number.
        await record(db, { workspaceId: req.params.id, actor: s, at: now, action: 'profile.purge', profiles: await db.select(ref).from(profiles).where(and(mine, isNotNull(profiles.deletedAt))) });
        updated = await db.delete(profiles).where(and(mine, isNotNull(profiles.deletedAt))).returning(ref);
        await Promise.all(saved.map(x => storage.delete(x.key).catch(err => req.log.error(err, 'deleting saved state failed'))));
        break;
      }
    }
    // What the entry says about the change, in names rather than ids.
    const name = async (table: typeof groups | typeof proxies | typeof departments, id: string | null | undefined) =>
      id ? (await db.select({ n: table.name }).from(table).where(eq(table.id, id)))[0]?.n ?? null : null;
    const detail: Record<string, unknown> =
      action === 'move' ? { group: await name(groups, req.body.groupId) }
      : action === 'set-proxy' ? { proxy: await name(proxies, req.body.proxyId) }
      : action === 'set-department' ? { department: await name(departments, req.body.departmentId) }
      : action === 'assign' ? { to: req.body.ownerId ? (await db.select({ e: users.email }).from(users).where(eq(users.id, req.body.ownerId)))[0]?.e ?? null : null }
      : action === 'tag' || action === 'untag' ? { tag: req.body.tag } : {};
    if (action !== 'purge') await record(db, { workspaceId: req.params.id, actor: s, at: now, action: `profile.${action}`, profiles: updated, detail });
    publish(req.params.id, { kind: 'profiles', ids: updated.map(u => u.id) });
    if (action === 'move') publish(req.params.id, { kind: 'groups' });
    return { updated: updated.length };
  });

  // Everything the desktop app needs to launch a profile, including proxy passwords.
  // The desktop refuses to pass this route through to its renderer.
  r.get('/profiles/:id/launch', {
    schema: { params: wsParams, response: { 200: z.object({ profile: Profile, proxy: ProxySecret.nullable(), backup: ProxySecret.nullable() }) } }
  }, async req => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    if (p.deletedAt) throw new ApiError(409, 'in_trash', 'Restore this profile from the trash before opening it');
    const secret = (x: typeof proxies.$inferSelect | undefined) => x
      ? { id: x.id, type: x.type as 'http' | 'https' | 'socks5', host: x.host, port: x.port, username: x.username, password: x.passwordEnc ? open(x.passwordEnc) : null }
      : null;
    const [proxy] = p.proxyId ? await db.select().from(proxies).where(eq(proxies.id, p.proxyId)) : [];
    const [backup] = proxy?.backupId ? await db.select().from(proxies).where(eq(proxies.id, proxy.backupId)) : [];
    return { profile: (await loadProfiles(db, eq(profiles.id, p.id), s.id, clock.now()))[0], proxy: secret(proxy), backup: secret(backup) };
  });
}
