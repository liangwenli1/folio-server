import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { workspaces } from '../db/schema.js';
import { requireSession, type Deps } from '../http.js';
import { readSub } from '../billing/service.js';
import { Workspace, WorkspaceSummary, subscriptionView } from '../views.js';
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
    return { id: ws.id, name: ws.name, role: { id: a.roleId, key: a.key, name: a.name, permissions: a.permissions }, subscription: subscriptionView(await readSub(db, ws.id)), usage: { profiles: await activeCount(db, ws.id), members: await memberCount(db, ws.id) } };
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

  r.patch('/workspaces/:id', { schema: { params, body: z.object({ name }), response: { 200: z.object({ id: z.string(), name: z.string() }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, MANAGE);
    const [ws] = await db.update(workspaces).set({ name: req.body.name }).where(eq(workspaces.id, req.params.id)).returning();
    publish(ws.id, { kind: 'workspace' });
    return { id: ws.id, name: ws.name };
  });
}
