import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { workspaces } from '../db/schema.js';
import { requireSession, type Deps } from '../http.js';
import { readSub } from '../billing/service.js';
import { Workspace, WorkspaceSummary, subscriptionView } from '../views.js';
import { createWorkspace, memberCount, requireRole } from './service.js';

const name = z.string().trim().min(1).max(80);
const params = z.object({ id: z.uuid() });

export function workspaceRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;

  r.get('/workspaces/:id', { schema: { params, response: { 200: Workspace } } }, async req => {
    const s = await requireSession(req, deps);
    const role = await requireRole(db, req.params.id, s.userId);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, req.params.id));
    // Profiles arrive in P2; until then the count is always zero.
    return { id: ws.id, name: ws.name, role, subscription: subscriptionView(await readSub(db, ws.id)), usage: { profiles: 0, members: await memberCount(db, ws.id) } };
  });

  r.post('/workspaces', { schema: { body: z.object({ name }), response: { 201: WorkspaceSummary } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    const ws = await db.transaction(tx => createWorkspace(tx, s.userId, req.body.name, clock.now()));
    return reply.code(201).send({ id: ws.id, name: ws.name, role: 'owner' as const, plan: 'free' as const, status: 'active' as const });
  });

  r.patch('/workspaces/:id', { schema: { params, body: z.object({ name }), response: { 200: z.object({ id: z.string(), name: z.string() }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requireRole(db, req.params.id, s.userId, ['owner', 'admin']);
    const [ws] = await db.update(workspaces).set({ name: req.body.name }).where(eq(workspaces.id, req.params.id)).returning();
    return { id: ws.id, name: ws.name };
  });
}
