import { and, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { groupMembers, groups, invitations, memberships, profileLocks, profiles } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { entitlements } from '../plans.js';
import { readSub, toState } from '../billing/service.js';

export async function requireCompany(db: Db | Tx, workspaceId: string){
  if (toState(await readSub(db, workspaceId)).plan !== 'company') throw new ApiError(403, 'plan_required', 'Authorising people for a group is part of the Company plan');
}

// Members plus invitations still open count against the plan's seats.
export async function assertSeat(db: Db | Tx, workspaceId: string, now: Date){
  const limit = entitlements(toState(await readSub(db, workspaceId))).members;
  if (limit === null) return;
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId));
  const [{ open }] = await db.select({ open: sql<number>`count(*)::int` }).from(invitations)
    .where(and(eq(invitations.workspaceId, workspaceId), isNull(invitations.acceptedAt), isNull(invitations.revokedAt), gt(invitations.expiresAt, now)));
  if (n + open >= limit) throw new ApiError(403, 'seat_limit', `This plan allows ${limit} ${limit === 1 ? 'member' : 'members'}. Upgrade to add more.`);
}

// Takes someone out of a workspace: their profiles go to `heir`, their group authorisations and open locks there go.
export async function removeMember(tx: Tx, workspaceId: string, userId: string, heir: string){
  await tx.update(profiles).set({ ownerId: heir }).where(and(eq(profiles.workspaceId, workspaceId), eq(profiles.ownerId, userId)));
  const theirs = tx.select({ id: groups.id }).from(groups).where(eq(groups.workspaceId, workspaceId));
  await tx.delete(groupMembers).where(and(eq(groupMembers.userId, userId), inArray(groupMembers.groupId, theirs)));
  const ws = tx.select({ id: profiles.id }).from(profiles).where(eq(profiles.workspaceId, workspaceId));
  await tx.delete(profileLocks).where(and(eq(profileLocks.userId, userId), inArray(profileLocks.profileId, ws)));
  await tx.delete(memberships).where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
}
