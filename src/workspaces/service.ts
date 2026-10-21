import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { memberships, subscriptions, workspaces } from '../db/schema.js';
import { forbidden, notFound } from '../errors.js';

export type Role = 'owner' | 'admin' | 'member';

// Every workspace starts on the Free plan.
export async function createWorkspace(tx: Tx, userId: string, name: string, now: Date){
  const [ws] = await tx.insert(workspaces).values({ name, createdAt: now }).returning();
  await tx.insert(memberships).values({ workspaceId: ws.id, userId, role: 'owner', createdAt: now });
  await tx.insert(subscriptions).values({ workspaceId: ws.id, updatedAt: now });
  return ws;
}

export async function requireRole(db: Db | Tx, workspaceId: string, userId: string, roles: Role[] = ['owner', 'admin', 'member']){
  const [m] = await db.select({ role: memberships.role }).from(memberships)
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  if (!m) throw notFound('Workspace');
  if (!roles.includes(m.role as Role)) throw forbidden();
  return m.role as Role;
}

export async function memberCount(db: Db, workspaceId: string){
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId));
  return n;
}
