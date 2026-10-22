import { and, asc, eq, gt, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Db, Tx } from '../db/client.js';
import { groups, profileData, profileLocks, profiles, proxies, users, workspaces } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { requireSession, type Deps } from '../http.js';
import { profileView } from '../views.js';
import { requireRole } from '../workspaces/service.js';
import { entitlements } from '../plans.js';
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
export async function assertOwned(db: Db | Tx, workspaceId: string, refs: { groupIds?: (string | null | undefined)[]; proxyIds?: (string | null | undefined)[] }){
  const check = async (table: typeof groups | typeof proxies, ids: (string | null | undefined)[] | undefined, what: string) => {
    const wanted = [...new Set((ids ?? []).filter((x): x is string => !!x))];
    if (!wanted.length) return;
    const rows = await db.select({ id: table.id }).from(table).where(and(eq(table.workspaceId, workspaceId), inArray(table.id, wanted)));
    if (rows.length !== wanted.length) throw new ApiError(400, 'bad_reference', `Unknown ${what}`);
  };
  await check(groups, refs.groupIds, 'group');
  await check(proxies, refs.proxyIds, 'proxy');
}

// A profile by id, for a member of its workspace.
export async function profileFor(deps: Deps, req: FastifyRequest, id: string){
  const [p] = await deps.db.select().from(profiles).where(eq(profiles.id, id));
  if (!p) throw notFound('Profile');
  const s = await requireSession(req, deps);
  await requireRole(deps.db, p.workspaceId, s.userId);
  return { p, s };
}

// Profiles with their saved state and who has them open, as the asking session sees them.
export async function loadProfiles(db: Db, where: SQL | undefined, sessionId: string, now: Date){
  const rows = await db.select({ p: profiles, d: profileData, l: profileLocks, email: users.email }).from(profiles)
    .leftJoin(profileData, eq(profileData.profileId, profiles.id))
    .leftJoin(profileLocks, and(eq(profileLocks.profileId, profiles.id), gt(profileLocks.expiresAt, now)))
    .leftJoin(users, eq(users.id, profileLocks.userId))
    .where(where).orderBy(asc(profiles.number));
  return rows.map(r => profileView(r.p, { data: r.d, lock: r.l && { ...r.l, email: r.email! }, sessionId }));
}
