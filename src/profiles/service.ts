import { and, asc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db, Tx } from '../db/client.js';
import { departmentMembers, departments, extensions, groups, memberships, profileData, profileLocks, profileStars, profiles, proxies, users, workspaces } from '../db/schema.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { requireSession, type Deps } from '../http.js';
import { profileView, type Fingerprint, type searchEngine } from '../views.js';
import { record } from '../activity/service.js';
import { publish } from '../events.js';
import { requireCompany } from '../team/service.js';
import type { z } from 'zod';
import { membership, type Access } from '../workspaces/service.js';
import { entitlements } from '../plans.js';
import { MANAGE, type Permission } from '../permissions.js';
import { readSub, toState } from '../billing/service.js';

export async function activeCount(db: Db | Tx, workspaceId: string){
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(profiles)
    .where(and(eq(profiles.workspaceId, workspaceId), isNull(profiles.deletedAt)));
  return n;
}

// Locks the workspace row so concurrent creates cannot both squeeze under the limit.
export async function reserve(tx: Tx, workspaceId: string, adding: number){
  await tx.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId)).for('update');
  const limit = entitlements(toState(await readSub(tx, workspaceId))).profiles;
  if (await activeCount(tx, workspaceId) + adding > limit){
    throw new ApiError(403, 'plan_limit', `This plan allows ${limit} profiles. Move some to the trash or add more to the plan.`);
  }
}

// Hands out the next `count` profile numbers of the workspace.
export async function nextNumbers(tx: Tx, workspaceId: string, count: number){
  const [w] = await tx.update(workspaces).set({ profileSeq: sql`${workspaces.profileSeq} + ${count}` })
    .where(eq(workspaces.id, workspaceId)).returning({ seq: workspaces.profileSeq });
  return Array.from({ length: count }, (_, i) => w.seq - count + 1 + i);
}

// Group and proxy ids sent by a client must belong to the same workspace.
// Group, proxy and department ids sent by a client must belong to the same workspace, and owners must be its members.
type Ids = (string | null | undefined)[] | undefined;
export async function assertOwned(db: Db | Tx, workspaceId: string, refs: { groupIds?: Ids; proxyIds?: Ids; departmentIds?: Ids; ownerIds?: Ids }){
  const wanted = (ids: Ids) => [...new Set((ids ?? []).filter((x): x is string => !!x))];
  const check = async (table: typeof groups | typeof proxies | typeof departments, ids: Ids, what: string) => {
    const w = wanted(ids);
    if (!w.length) return;
    const rows = await db.select({ id: table.id }).from(table).where(and(eq(table.workspaceId, workspaceId), inArray(table.id, w)));
    if (rows.length !== w.length) throw new ApiError(400, 'bad_reference', `Unknown ${what}`);
  };
  await check(groups, refs.groupIds, 'group');
  await check(proxies, refs.proxyIds, 'proxy');
  await check(departments, refs.departmentIds, 'department');
  const owners = wanted(refs.ownerIds);
  if (owners.length && (await db.select({ id: memberships.userId }).from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), inArray(memberships.userId, owners)))).length !== owners.length){
    throw new ApiError(400, 'bad_reference', 'Unknown member');
  }
}

// Which of a workspace's profiles a person may see and use: all of them for whoever administers the workspace;
// for everyone else, the ones assigned to them and, on Company, their departments' (`scope` narrows queries on
// profiles).
export async function access(db: Db, workspaceId: string, userId: string){
  const a = await membership(db, workspaceId, userId);
  if (a.can(MANAGE)) return { a, scope: undefined };
  const mine = (await db.select({ id: departmentMembers.departmentId }).from(departmentMembers)
    .innerJoin(departments, eq(departments.id, departmentMembers.departmentId))
    .where(and(eq(departmentMembers.userId, userId), eq(departments.workspaceId, workspaceId)))).map(d => d.id);
  return { a, scope: mine.length ? or(eq(profiles.ownerId, userId), inArray(profiles.departmentId, mine)) : eq(profiles.ownerId, userId) };
}

// A profile by id, for someone who may see it and do `perms` to it; anyone else gets 404 (or 403 when they can
// see it but not do this).
export async function profileFor(deps: Deps, req: FastifyRequest, id: string, ...perms: Permission[]){
  const [p] = await deps.db.select().from(profiles).where(eq(profiles.id, id));
  if (!p) throw notFound('Profile');
  const s = await requireSession(req, deps);
  const { a, scope } = await access(deps.db, p.workspaceId, s.userId);
  if (!a.can('profiles.view') || !perms.every(x => a.can(x))) throw forbidden();
  if (scope && !(await deps.db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.id, id), scope))).length) throw notFound('Profile');
  return { p, s, a };
}

// Profiles with their saved state, who has them open and whether the asker starred them, as the asking session sees them.
export async function loadProfiles(db: Db, where: SQL | undefined, s: { id: string; userId: string }, now: Date){
  const rows = await db.select({ p: profiles, d: profileData, l: profileLocks, email: users.email, star: profileStars.userId }).from(profiles)
    .leftJoin(profileData, eq(profileData.profileId, profiles.id))
    .leftJoin(profileLocks, and(eq(profileLocks.profileId, profiles.id), gt(profileLocks.expiresAt, now)))
    .leftJoin(users, eq(users.id, profileLocks.userId))
    .leftJoin(profileStars, and(eq(profileStars.profileId, profiles.id), eq(profileStars.userId, s.userId)))
    .where(where).orderBy(asc(profiles.number));
  return rows.map(r => profileView(r.p, { data: r.d, lock: r.l && { ...r.l, email: r.email! }, sessionId: s.id, starred: !!r.star }));
}

const MAX_FP_BYTES = 64 * 1024;
export function checkFingerprint(p: { kernel?: string; fingerprint?: z.infer<typeof Fingerprint> }){
  if (p.fingerprint && p.kernel && p.fingerprint.kind !== p.kernel) throw new ApiError(400, 'fingerprint_kernel', 'The fingerprint does not match the engine');
  if (p.fingerprint && JSON.stringify(p.fingerprint).length > MAX_FP_BYTES) throw new ApiError(400, 'fingerprint_size', 'The fingerprint is too large');
}

// Extensions must be in the workspace's library and made for the profile's engine.
export async function checkExtensions(db: Db | Tx, workspaceId: string, items: { kernel: string; extensionIds?: string[] }[]){
  const wanted = [...new Set(items.flatMap(i => i.extensionIds ?? []))];
  if (!wanted.length) return;
  const found = new Map((await db.select({ id: extensions.id, kernel: extensions.kernel }).from(extensions)
    .where(and(eq(extensions.workspaceId, workspaceId), inArray(extensions.id, wanted)))).map(e => [e.id, e.kernel]));
  for (const i of items) for (const id of i.extensionIds ?? []){
    if (!found.has(id)) throw new ApiError(400, 'bad_reference', 'Unknown extension');
    if (found.get(id) !== i.kernel) throw new ApiError(400, 'extension_kernel', 'This extension is made for the other engine');
  }
}

// Assigning people and departments goes with administering the workspace; departments need the Company plan.
export async function checkAssignment(db: Db, workspaceId: string, a: Access, items: { ownerId?: string | null; departmentId?: string | null }[]){
  if (!a.can(MANAGE) && items.some(i => i.ownerId !== undefined || i.departmentId !== undefined)) throw forbidden();
  if (items.some(i => i.departmentId)) await requireCompany(db, workspaceId);
  await assertOwned(db, workspaceId, { ownerIds: items.map(i => i.ownerId), departmentIds: items.map(i => i.departmentId) });
}

export interface NewProfile {
  name: string; groupId?: string | null; tags: string[]; ownerId?: string | null; departmentId?: string | null;
  kernel: 'chromium' | 'firefox'; kernelVersion: string; os: 'windows' | 'macos' | 'linux'; fingerprint: z.infer<typeof Fingerprint>;
  proxyId?: string | null; timezoneOverride?: string | null; localeOverride?: string | null; notes?: string | null; syncMode?: 'cloud' | 'local';
  extensionIds?: string[]; searchEngine?: z.infer<typeof searchEngine>; restoreTabs?: boolean;
}

// Creates profiles within the plan's limit, numbered in order, assigned to whoever creates them unless said otherwise.
export async function createProfiles(deps: Deps, workspaceId: string, s: { userId: string; deviceName: string | null }, a: Access, items: NewProfile[]){
  const { db, clock } = deps;
  items.forEach(checkFingerprint);
  await checkAssignment(db, workspaceId, a, items);
  await assertOwned(db, workspaceId, { groupIds: items.map(i => i.groupId), proxyIds: items.map(i => i.proxyId) });
  await checkExtensions(db, workspaceId, items);
  const now = clock.now();
  const rows = await db.transaction(async tx => {
    await reserve(tx, workspaceId, items.length);
    const numbers = await nextNumbers(tx, workspaceId, items.length);
    return tx.insert(profiles).values(items.map((i, k) => ({
      ...i, ownerId: i.ownerId === undefined ? s.userId : i.ownerId, workspaceId, number: numbers[k], createdBy: s.userId, createdAt: now, updatedAt: now
    }))).returning();
  });
  await record(db, { workspaceId, actor: s, at: now, action: 'profile.create', profiles: rows });
  publish(workspaceId, { kind: 'profiles', ids: rows.map(p => p.id) });
  return rows;
}
