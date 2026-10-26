import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { groups, proxies, workspaces } from '../db/schema.js';
import { requireSession, type Deps } from '../http.js';
import { ApiError } from '../errors.js';
import { readSub } from '../billing/service.js';
import { Workspace, WorkspaceSettings, WorkspaceSummary, kernel, subscriptionView, workspaceSettingsView } from '../views.js';
import { createWorkspace, memberCount, membership, requirePermission, roleByKey } from './service.js';
import { MANAGE } from '../permissions.js';
import { activeCount } from '../profiles/service.js';
import { publish } from '../events.js';

const name = z.string().trim().min(1).max(80);
const params = z.object({ id: z.uuid() });

export function workspaceRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;

  r.get('/workspaces/:id', { schema: { params, response: { 200: Workspace } } }, async req => {
    const s = await requireSession(req, deps);
    const a = await membership(db, req.params.id, s.userId);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, req.params.id));
    return {
      id: ws.id, name: ws.name, role: { id: a.roleId, key: a.key, name: a.name, permissions: a.permissions },
      subscription: subscriptionView(await readSub(db, ws.id)), settings: workspaceSettingsView(ws),
      usage: { profiles: await activeCount(db, ws.id), members: await memberCount(db, ws.id) }
    };
  });

  r.post('/workspaces', { schema: { body: z.object({ name }), response: { 201: WorkspaceSummary } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    const ws = await db.transaction(tx => createWorkspace(tx, s.userId, req.body.name, clock.now()));
    const owner = await roleByKey(db, ws.id, 'owner');
    return reply.code(201).send({
      id: ws.id, name: ws.name, role: { id: owner.id, key: 'owner' as const, name: owner.name, permissions: owner.permissions as never },
      plan: 'free' as const, status: 'active' as const
    });
  });

  // The name, what new profiles start with, and how opening one behaves. Settings arrive one at a time or
  // together; the group and the proxy must be the workspace's own.
  const settings = WorkspaceSettings.extend({ defaultKernel: kernel.nullable(), defaultKernelVersion: z.string().regex(/^[\w.-]{1,40}$/).nullable() }).partial();
  r.patch('/workspaces/:id', {
    schema: { params, body: z.object({ name: name.optional(), settings: settings.optional() }), response: { 200: z.object({ id: z.string(), name: z.string(), settings: WorkspaceSettings }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, MANAGE);
    const set = req.body.settings ?? {};
    for (const [table, id] of [[groups, set.defaultGroupId], [proxies, set.defaultProxyId]] as const){
      if (!id) continue;
      const [row] = await db.select({ id: table.id }).from(table).where(and(eq(table.id, id), eq(table.workspaceId, req.params.id)));
      if (!row) throw new ApiError(400, 'bad_reference', 'Unknown group or proxy');
    }
    const [ws] = await db.update(workspaces).set({ ...(req.body.name ? { name: req.body.name } : {}), ...set })
      .where(eq(workspaces.id, req.params.id)).returning();
    publish(ws.id, { kind: 'workspace' });
    return { id: ws.id, name: ws.name, settings: workspaceSettingsView(ws) };
  });
}
