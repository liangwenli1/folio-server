import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { groups, profiles, proxies, workspaces } from '../db/schema.js';
import { ApiError } from '../errors.js';
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
