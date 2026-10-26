import { and, eq, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { memberships, roles, subscriptions, workspaces } from '../db/schema.js';
import { forbidden, notFound } from '../errors.js';
import { BUILT_IN, BUILT_IN_ROLES, type BuiltInRole, type Permission } from '../permissions.js';

// What someone may do in a workspace: their role and the actions it carries.
export interface Access {
  roleId: string;
  // Set for the four roles every workspace starts with, null for a role the workspace made itself.
  key: BuiltInRole | null;
  name: string;
  permissions: Permission[];
  can(permission: Permission): boolean;
  isOwner: boolean;
}

// Every workspace starts on the Free plan, with the four built-in roles; whoever makes it is its owner.
export async function createWorkspace(tx: Tx, userId: string, name: string, now: Date){
  const [ws] = await tx.insert(workspaces).values({ name, createdAt: now }).returning();
  const made = await tx.insert(roles).values(BUILT_IN_ROLES.map(key => ({
    workspaceId: ws.id, key, name: BUILT_IN[key].name, permissions: BUILT_IN[key].permissions, createdAt: now
  }))).returning();
  await tx.insert(memberships).values({ workspaceId: ws.id, userId, roleId: made.find(r => r.key === 'owner')!.id, createdAt: now });
  await tx.insert(subscriptions).values({ workspaceId: ws.id, updatedAt: now });
  return ws;
}

export async function membership(db: Db | Tx, workspaceId: string, userId: string): Promise<Access> {
  const [m] = await db.select({ roleId: roles.id, key: roles.key, name: roles.name, permissions: roles.permissions })
    .from(memberships).innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.workspaceId, workspaceId), eq(memberships.userId, userId)));
  if (!m) throw notFound('Workspace');
  const permissions = m.permissions as Permission[];
  return {
    roleId: m.roleId, key: m.key as BuiltInRole | null, name: m.name, permissions,
    can: p => permissions.includes(p), isOwner: m.key === 'owner'
  };
}

// A member who may do all of `permissions`; anyone else is refused.
export async function requirePermission(db: Db | Tx, workspaceId: string, userId: string, ...permissions: Permission[]){
  const a = await membership(db, workspaceId, userId);
  if (!permissions.every(p => a.can(p))) throw forbidden();
  return a;
}

export async function roleByKey(db: Db | Tx, workspaceId: string, key: BuiltInRole){
  const [r] = await db.select().from(roles).where(and(eq(roles.workspaceId, workspaceId), eq(roles.key, key)));
  return r;
}

export async function memberCount(db: Db, workspaceId: string){
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(memberships).where(eq(memberships.workspaceId, workspaceId));
  return n;
}
