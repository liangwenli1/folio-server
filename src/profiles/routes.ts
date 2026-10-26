import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { extensions, groupMembers, groups, profileData, profileStars, profiles, proxies, users } from '../db/schema.js';
import { record } from '../activity/service.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { publish } from '../events.js';
import { requireSession, type Deps } from '../http.js';
import { open } from '../crypto.js';
import { Extension, Fingerprint, Geo, Group, HealthReport, groupColor, Profile, ProxySecret, extensionView, kernel, os, profileView, searchEngine } from '../views.js';
import { requirePermission } from '../workspaces/service.js';
import { MANAGE } from '../permissions.js';
import { requireCompany } from '../team/service.js';
import { access, assertOwned, checkAssignment, checkExtensions, checkFingerprint, createProfiles, loadProfiles, profileFor, reserve } from './service.js';

const wsParams = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(80);
const tag = z.string().trim().min(1).max(24);
const version = z.string().regex(/^[\w.-]{1,40}$/);
const tz = z.string().regex(/^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/).max(64);
const locale = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/).max(35);

export const newProfile = z.object({
  name, groupId: z.uuid().nullable().optional(), tags: z.array(tag).max(10).default([]),
  // Defaults to the person creating it; assigning it to someone else goes with administering the workspace.
  ownerId: z.uuid().nullable().optional(),
  kernel, kernelVersion: version, os, fingerprint: Fingerprint, proxyId: z.uuid().nullable().optional(),
  timezoneOverride: tz.nullable().optional(), localeOverride: locale.nullable().optional(), notes: z.string().max(2000).nullable().optional(),
  syncMode: z.enum(['cloud', 'local']).optional(), extensionIds: z.array(z.uuid()).max(50).optional(),
  searchEngine: searchEngine.optional(), restoreTabs: z.boolean().optional()
});
// Firefox fingerprints run to tens of kilobytes each.
export const BULK_BODY = 64 * 1024 * 1024;

export function profileRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock, storage } = deps;

  // The session, what the person may do and which profiles they see (see access()).
  async function member(req: Parameters<typeof requireSession>[0], workspaceId: string){
    const s = await requireSession(req, deps);
    return { s, ...(await access(db, workspaceId, s.userId)) };
  }
  async function manager(req: Parameters<typeof requireSession>[0], workspaceId: string){
    const s = await requireSession(req, deps);
    await requirePermission(db, workspaceId, s.userId, MANAGE);
    return s;
  }

  // ---------- groups ----------
  // Groups nest and carry who is authorised for them. A profile's group decides both where it sits and who
  // may reach it; being authorised for a group is part of the Company plan.
  const groupView = (g: typeof groups.$inferSelect, memberIds: string[], count: number) => ({
    id: g.id, name: g.name, color: g.color, parentId: g.parentId, inheritMembers: g.inheritMembers, memberIds, profiles: count
  });
  const membersOf = async (ids: string[]) => (ids.length
    ? await db.select().from(groupMembers).where(inArray(groupMembers.groupId, ids)) : []);

  r.get('/workspaces/:id/groups', { schema: { params: wsParams, response: { 200: z.object({ groups: z.array(Group) }) } } }, async req => {
    const { a, scope } = await member(req, req.params.id);
    if (!a.can('profiles.view')) throw forbidden();
    const rows = await db.select({ g: groups, profiles: sql<number>`count(${profiles.id}) filter (where ${profiles.deletedAt} is null)::int` })
      .from(groups).leftJoin(profiles, and(eq(profiles.groupId, groups.id), scope))
      .where(eq(groups.workspaceId, req.params.id)).groupBy(groups.id).orderBy(asc(groups.name));
    const people = await membersOf(rows.map(r => r.g.id));
    return { groups: rows.map(r => groupView(r.g, people.filter(m => m.groupId === r.g.id).map(m => m.userId), r.profiles)) };
  });

  // A group of the same workspace, for `parentId`.
  async function parentIn(workspaceId: string, parentId: string | null | undefined){
    if (!parentId) return;
    const [p] = await db.select({ id: groups.id }).from(groups).where(and(eq(groups.id, parentId), eq(groups.workspaceId, workspaceId)));
    if (!p) throw new ApiError(400, 'bad_reference', 'Unknown group');
  }
  // Every group under this one, so a group cannot be moved inside itself.
  async function descendants(id: string){
    const rows = await db.execute<{ id: string }>(sql`
      WITH RECURSIVE below AS (
        SELECT g.id FROM ${groups} g WHERE g.parent_id = ${id}
        UNION SELECT c.id FROM ${groups} c JOIN below b ON c.parent_id = b.id
      ) SELECT id FROM below`);
    return [...rows].map(r => r.id);
  }

  r.post('/workspaces/:id/groups', {
    schema: {
      params: wsParams,
      body: z.object({ name, color: groupColor.optional(), parentId: z.uuid().nullable().optional(), inheritMembers: z.boolean().optional() }),
      response: { 201: Group }
    }
  }, async (req, reply) => {
    const s = await manager(req, req.params.id);
    await parentIn(req.params.id, req.body.parentId);
    const [g] = await db.insert(groups).values({ workspaceId: req.params.id, ...req.body, createdAt: clock.now() }).onConflictDoNothing().returning();
    if (!g) throw new ApiError(409, 'group_exists', 'A group with this name already exists');
    await record(db, { workspaceId: req.params.id, actor: s, at: clock.now(), action: 'group.create', detail: { name: g.name } });
    publish(req.params.id, { kind: 'groups' });
    return reply.code(201).send(groupView(g, [], 0));
  });

  // A new name, colour, place in the tree, or member list; renames and member changes go in the activity log.
  const groupEdit = z.object({
    name: name.optional(), color: groupColor.optional(), parentId: z.uuid().nullable().optional(),
    inheritMembers: z.boolean().optional(), memberIds: z.array(z.uuid()).max(1000).optional()
  }).refine(b => Object.keys(b).length > 0, 'Nothing to change');
  r.patch('/groups/:id', { schema: { params: wsParams, body: groupEdit, response: { 200: Group } } }, async req => {
    const [g] = await db.select().from(groups).where(eq(groups.id, req.params.id));
    if (!g) throw notFound('Group');
    const s = await manager(req, g.workspaceId);
    const { memberIds: wanted, ...fields } = req.body;
    const memberIds = wanted ? [...new Set(wanted)] : undefined;
    if (fields.parentId !== undefined){
      await parentIn(g.workspaceId, fields.parentId);
      if (fields.parentId === g.id || (fields.parentId && (await descendants(g.id)).includes(fields.parentId))){
        throw new ApiError(400, 'group_cycle', 'A group cannot sit inside itself');
      }
    }
    if (memberIds){
      await requireCompany(db, g.workspaceId);
      await assertOwned(db, g.workspaceId, { ownerIds: memberIds });
    }
    const u = await db.transaction(async tx => {
      const [row] = Object.keys(fields).length
        ? await tx.update(groups).set(fields).where(eq(groups.id, g.id)).returning().catch(() => {
          throw new ApiError(409, 'group_exists', 'A group with this name already exists');
        })
        : [g];
      if (memberIds){
        await tx.delete(groupMembers).where(eq(groupMembers.groupId, g.id));
        if (memberIds.length) await tx.insert(groupMembers).values(memberIds.map(userId => ({ groupId: g.id, userId })));
      }
      return row;
    });
    if (u.name !== g.name) await record(db, { workspaceId: g.workspaceId, actor: s, at: clock.now(), action: 'group.rename', detail: { name: u.name, from: g.name } });
    if (memberIds) await record(db, { workspaceId: g.workspaceId, actor: s, at: clock.now(), action: 'group.members', detail: { name: u.name, members: memberIds.length } });
    publish(g.workspaceId, { kind: 'groups' }); publish(g.workspaceId, { kind: 'profiles' });
    const [{ n }] = await db.select({ n: sql<number>`count(*) filter (where ${profiles.deletedAt} is null)::int` }).from(profiles).where(eq(profiles.groupId, g.id));
    return groupView(u, memberIds ?? (await membersOf([g.id])).map(m => m.userId), n);
  });

  // Its profiles go to `moveTo` (or out of any group), and the groups under it move up to its own parent.
  r.delete('/groups/:id', {
    schema: { params: wsParams, querystring: z.object({ moveTo: z.uuid().nullish() }), response: { 204: z.null() } }
  }, async (req, reply) => {
    const [g] = await db.select().from(groups).where(eq(groups.id, req.params.id));
    if (!g) throw notFound('Group');
    const s = await manager(req, g.workspaceId);
    const moveTo = req.query.moveTo ?? null;
    if (moveTo === g.id) throw new ApiError(400, 'bad_reference', 'Choose another group for its profiles');
    await parentIn(g.workspaceId, moveTo);
    await db.transaction(async tx => {
      await tx.update(profiles).set({ groupId: moveTo }).where(eq(profiles.groupId, g.id));
      await tx.update(groups).set({ parentId: g.parentId }).where(eq(groups.parentId, g.id));
      await tx.delete(groups).where(eq(groups.id, g.id));
    });
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
    return { profiles: await loadProfiles(db, where, s, clock.now()) };
  });


  r.post('/workspaces/:id/profiles', { schema: { params: wsParams, body: newProfile, response: { 201: Profile } } }, async (req, reply) => {
    const { s, a } = await member(req, req.params.id);
    await requirePermission(db, req.params.id, s.userId, 'profiles.create');
    const [p] = await createProfiles(deps, req.params.id, s, a, [req.body]);
    return reply.code(201).send(profileView(p));
  });

  // Bulk create, used by the spreadsheet import. All or nothing.
  r.post('/workspaces/:id/profiles/bulk', {
    bodyLimit: BULK_BODY,
    schema: { params: wsParams, body: z.object({ profiles: z.array(newProfile).min(1).max(500) }), response: { 201: z.object({ profiles: z.array(Profile) }) } }
  }, async (req, reply) => {
    const { s, a } = await member(req, req.params.id);
    await requirePermission(db, req.params.id, s.userId, 'profiles.create');
    return reply.code(201).send({ profiles: (await createProfiles(deps, req.params.id, s, a, req.body.profiles)).map(p => profileView(p)) });
  });

  // Optimistic concurrency: the client sends the version it edited; a newer one on the server is a conflict.
  r.patch('/profiles/:id', {
    schema: {
      params: wsParams,
      body: z.object({
        version: z.number().int(), name: name.optional(), groupId: z.uuid().nullable().optional(), tags: z.array(tag).max(10).optional(),
        ownerId: z.uuid().nullable().optional(),
        proxyId: z.uuid().nullable().optional(), kernelVersion: version.optional(), os: os.optional(), fingerprint: Fingerprint.optional(),
        timezoneOverride: tz.nullable().optional(), localeOverride: locale.nullable().optional(), notes: z.string().max(2000).nullable().optional(),
        syncMode: z.enum(['cloud', 'local']).optional(), extensionIds: z.array(z.uuid()).max(50).optional(),
        searchEngine: searchEngine.optional(), restoreTabs: z.boolean().optional()
      }),
      response: { 200: Profile }
    }
  }, async req => {
    const { p, s, a } = await profileFor(deps, req, req.params.id, 'profiles.edit');
    const { version: v, ...patch } = req.body;
    checkFingerprint({ kernel: p.kernel, fingerprint: patch.fingerprint });
    await checkAssignment(db, p.workspaceId, a, [patch]);
    await assertOwned(db, p.workspaceId, { groupIds: [patch.groupId], proxyIds: [patch.proxyId] });
    await checkExtensions(db, p.workspaceId, [{ kernel: p.kernel, extensionIds: patch.extensionIds }]);
    const [u] = await db.update(profiles).set({ ...patch, version: sql`${profiles.version} + 1`, updatedAt: clock.now() })
      .where(and(eq(profiles.id, p.id), eq(profiles.version, v))).returning();
    if (!u) throw new ApiError(409, 'stale', 'Someone changed this profile in the meantime. Reload it and try again.');
    // Keeping sign-ins on the computer means Folio no longer holds a copy.
    if (u.syncMode === 'local' && p.syncMode !== 'local'){
      const [gone] = await db.delete(profileData).where(eq(profileData.profileId, p.id)).returning();
      if (gone) await storage.delete(gone.objectKey).catch(err => req.log.error(err, 'deleting saved state failed'));
    }
    // Clients send whole forms; the entry names only what actually changed.
    const fields = (Object.keys(patch) as (keyof typeof patch)[]).filter(k => JSON.stringify(patch[k] ?? null) !== JSON.stringify(p[k] ?? null));
    if (fields.length) await record(db, { workspaceId: p.workspaceId, actor: s, at: u.updatedAt, action: 'profile.update', profiles: [u], detail: { fields } });
    publish(p.workspaceId, { kind: 'profiles', ids: [p.id] });
    return (await loadProfiles(db, eq(profiles.id, u.id), s, clock.now()))[0];
  });

  r.post('/workspaces/:id/profiles/batch', {
    schema: {
      params: wsParams,
      body: z.object({
        ids: z.array(z.uuid()).min(1).max(2000),
        action: z.enum(['move', 'tag', 'untag', 'set-proxy', 'assign', 'add-extension', 'remove-extension', 'set-kernel', 'set-browser', 'trash', 'restore', 'purge']),
        groupId: z.uuid().nullable().optional(), tag: tag.optional(), proxyId: z.uuid().nullable().optional(),
        ownerId: z.uuid().nullable().optional(), extensionId: z.uuid().optional(),
        kernel: kernel.optional(), kernelVersion: z.string().trim().min(1).max(40).optional(),
        searchEngine: searchEngine.optional(), restoreTabs: z.boolean().optional()
      }),
      response: { 200: z.object({ updated: z.number() }) }
    }
  }, async req => {
    const { s, a, scope } = await member(req, req.params.id);
    const { ids, action } = req.body;
    // Changing a profile's group, tags, proxy, extensions, engine version and browser settings comes with editing
    // it; the Trash is its own action, and assigning one to someone else goes with administering the workspace.
    const needed = ['trash', 'restore', 'purge'].includes(action) ? 'profiles.delete' : 'profiles.edit';
    if (!a.can('profiles.view') || !a.can(needed)) throw forbidden();
    if (!a.can(MANAGE) && action === 'assign') throw forbidden();
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
      case 'tag': case 'untag': {
        const t = req.body.tag;
        if (!t) throw new ApiError(400, 'validation', 'A tag is required');
        const tags = action === 'tag'
          ? sql`case when ${t} = any(${profiles.tags}) or cardinality(${profiles.tags}) >= 10 then ${profiles.tags} else array_append(${profiles.tags}, ${t}) end`
          : sql`array_remove(${profiles.tags}, ${t})`;
        updated = await db.update(profiles).set({ ...bump, tags }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      }
      // Only profiles of the extension's engine take it; the others are left as they are.
      case 'add-extension': case 'remove-extension': {
        const [ext] = req.body.extensionId ? await db.select().from(extensions).where(and(eq(extensions.id, req.body.extensionId), eq(extensions.workspaceId, req.params.id))) : [];
        if (!ext) throw new ApiError(400, 'bad_reference', 'Unknown extension');
        updated = action === 'add-extension'
          ? await db.update(profiles).set({ ...bump, extensionIds: sql`array_append(${profiles.extensionIds}, ${ext.id}::uuid)` })
            .where(and(mine, isNull(profiles.deletedAt), eq(profiles.kernel, ext.kernel), sql`not (${ext.id}::uuid = any(${profiles.extensionIds}))`)).returning(ref)
          : await db.update(profiles).set({ ...bump, extensionIds: sql`array_remove(${profiles.extensionIds}, ${ext.id}::uuid)` })
            .where(and(mine, sql`${ext.id}::uuid = any(${profiles.extensionIds})`)).returning(ref);
        break;
      }
      // Another version of the same engine; the fingerprint stays. Profiles of the other engine are left as they are.
      case 'set-kernel': {
        const { kernel: k, kernelVersion } = req.body;
        if (!k || !kernelVersion) throw new ApiError(400, 'validation', 'The engine and its version are required');
        updated = await db.update(profiles).set({ ...bump, kernelVersion })
          .where(and(mine, isNull(profiles.deletedAt), eq(profiles.kernel, k), ne(profiles.kernelVersion, kernelVersion))).returning(ref);
        break;
      }
      // The search engine, restoring tabs, or both; whichever is given.
      case 'set-browser': {
        const { searchEngine: se, restoreTabs } = req.body;
        if (se === undefined && restoreTabs === undefined) throw new ApiError(400, 'validation', 'A search engine or the tab setting is required');
        updated = await db.update(profiles).set({ ...bump, ...(se !== undefined ? { searchEngine: se } : {}), ...(restoreTabs !== undefined ? { restoreTabs } : {}) })
          .where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      }
      case 'trash':
        updated = await db.update(profiles).set({ ...bump, deletedAt: now, deletedBy: s.userId }).where(and(mine, isNull(profiles.deletedAt))).returning(ref);
        break;
      case 'restore':
        updated = await db.transaction(async tx => {
          const trashed = await tx.select({ id: profiles.id }).from(profiles).where(and(mine, isNotNull(profiles.deletedAt)));
          await reserve(tx, req.params.id, trashed.length);
          return tx.update(profiles).set({ ...bump, deletedAt: null, deletedBy: null }).where(and(mine, isNotNull(profiles.deletedAt))).returning(ref);
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
    const name = async (table: typeof groups | typeof proxies, id: string | null | undefined) =>
      id ? (await db.select({ n: table.name }).from(table).where(eq(table.id, id)))[0]?.n ?? null : null;
    const detail: Record<string, unknown> =
      action === 'move' ? { group: await name(groups, req.body.groupId) }
      : action === 'set-proxy' ? { proxy: await name(proxies, req.body.proxyId) }
      : action === 'assign' ? { to: req.body.ownerId ? (await db.select({ e: users.email }).from(users).where(eq(users.id, req.body.ownerId)))[0]?.e ?? null : null }
      : action === 'tag' || action === 'untag' ? { tag: req.body.tag }
      : action === 'add-extension' || action === 'remove-extension' ? { extension: (await db.select({ n: extensions.name }).from(extensions).where(eq(extensions.id, req.body.extensionId!)))[0]?.n ?? null }
      : action === 'set-kernel' ? { kernel: req.body.kernel, version: req.body.kernelVersion }
      : action === 'set-browser' ? { searchEngine: req.body.searchEngine ?? null, restoreTabs: req.body.restoreTabs ?? null } : {};
    if (action !== 'purge') await record(db, { workspaceId: req.params.id, actor: s, at: now, action: `profile.${action}`, profiles: updated, detail });
    publish(req.params.id, { kind: 'profiles', ids: updated.map(u => u.id) });
    if (action === 'move') publish(req.params.id, { kind: 'groups' });
    return { updated: updated.length };
  });

  // Where the profile went out from when it opened on a computer. A different IP than last time keeps the last one as
  // the previous exit, for the warning about a profile that moved.
  r.post('/profiles/:id/exit', { schema: { params: wsParams, body: z.object({ ip: z.string().min(1).max(45), geo: Geo.nullable() }), response: { 204: z.null() } } }, async (req, reply) => {
    const { p } = await profileFor(deps, req, req.params.id);
    const last = p.lastExit as { ip: string } | null, exit = { ...req.body, at: clock.now().toISOString() };
    await db.update(profiles).set(last && last.ip !== exit.ip ? { lastExit: exit, prevExit: last } : { lastExit: exit }).where(eq(profiles.id, p.id));
    publish(p.workspaceId, { kind: 'profiles', ids: [p.id] });
    return reply.code(204).send(null);
  });

  // The latest health report from the profile's self-check page, seen by the whole team.
  r.put('/profiles/:id/report', { schema: { params: wsParams, body: HealthReport.omit({ at: true }), response: { 204: z.null() } } }, async (req, reply) => {
    const { p } = await profileFor(deps, req, req.params.id);
    await db.update(profiles).set({ report: { ...req.body, at: clock.now().toISOString() } }).where(eq(profiles.id, p.id));
    publish(p.workspaceId, { kind: 'profiles', ids: [p.id] });
    return reply.code(204).send(null);
  });

  // Favourites, each person's own.
  r.put('/profiles/:id/star', { schema: { params: wsParams, response: { 204: z.null() } } }, async (req, reply) => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    await db.insert(profileStars).values({ userId: s.userId, profileId: p.id }).onConflictDoNothing();
    return reply.code(204).send(null);
  });
  r.delete('/profiles/:id/star', { schema: { params: wsParams, response: { 204: z.null() } } }, async (req, reply) => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    await db.delete(profileStars).where(and(eq(profileStars.userId, s.userId), eq(profileStars.profileId, p.id)));
    return reply.code(204).send(null);
  });

  // Everything the desktop app needs to launch a profile, including proxy passwords.
  // The desktop refuses to pass this route through to its renderer.
  r.get('/profiles/:id/launch', {
    schema: { params: wsParams, response: { 200: z.object({ profile: Profile, proxy: ProxySecret.nullable(), backup: ProxySecret.nullable(), extensions: z.array(Extension) }) } }
  }, async req => {
    const { p, s } = await profileFor(deps, req, req.params.id, 'profiles.open');
    if (p.deletedAt) throw new ApiError(409, 'in_trash', 'Restore this profile from the trash before opening it');
    const secret = (x: typeof proxies.$inferSelect | undefined) => x
      ? { id: x.id, type: x.type as 'http' | 'https' | 'socks5', host: x.host, port: x.port, username: x.username, password: x.passwordEnc ? open(x.passwordEnc) : null }
      : null;
    const [proxy] = p.proxyId ? await db.select().from(proxies).where(eq(proxies.id, p.proxyId)) : [];
    const [backup] = proxy?.backupId ? await db.select().from(proxies).where(eq(proxies.id, proxy.backupId)) : [];
    // The extensions it opens with, to fetch and check against their signatures.
    const exts = p.extensionIds.length ? await db.select().from(extensions).where(inArray(extensions.id, p.extensionIds)) : [];
    return { profile: (await loadProfiles(db, eq(profiles.id, p.id), s, clock.now()))[0], proxy: secret(proxy), backup: secret(backup), extensions: exts.map(e => extensionView(e, 0)) };
  });
}
