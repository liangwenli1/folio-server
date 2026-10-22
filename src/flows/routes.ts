// Automation flows, shared by the workspace. Everyone sees and creates them; the creator, admins and the owner
// change and delete them. They run in the desktop app.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { flows } from '../db/schema.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { publish } from '../events.js';
import { record } from '../activity/service.js';
import { requireSession, type Deps } from '../http.js';
import { Flow, flowView } from '../views.js';
import { requireRole, type Role } from '../workspaces/service.js';
import { Steps, checkSteps } from './steps.js';

const params = z.object({ id: z.uuid() });
const name = z.string().trim().min(1).max(80);

export function flowRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;
  const canEdit = (f: typeof flows.$inferSelect, role: Role, userId: string) => role !== 'member' || f.createdBy === userId;

  async function flowFor(req: Parameters<typeof requireSession>[0], id: string, edit = false){
    const [f] = await db.select().from(flows).where(eq(flows.id, id));
    if (!f) throw notFound('Flow');
    const s = await requireSession(req, deps);
    const role = await requireRole(db, f.workspaceId, s.userId);
    if (edit && !canEdit(f, role, s.userId)) throw forbidden();
    return { f, s, role };
  }

  r.get('/workspaces/:id/flows', { schema: { params, response: { 200: z.object({ flows: z.array(Flow) }) } } }, async req => {
    const s = await requireSession(req, deps);
    const role = await requireRole(db, req.params.id, s.userId);
    const rows = await db.select().from(flows).where(eq(flows.workspaceId, req.params.id)).orderBy(asc(flows.name), asc(flows.createdAt));
    return { flows: rows.map(f => flowView(f, canEdit(f, role, s.userId))) };
  });

  r.post('/workspaces/:id/flows', { schema: { params, body: z.object({ name, steps: Steps }), response: { 201: Flow } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await requireRole(db, req.params.id, s.userId);
    checkSteps(req.body.steps);
    const now = clock.now();
    const [f] = await db.insert(flows).values({ workspaceId: req.params.id, ...req.body, createdBy: s.userId, createdAt: now, updatedAt: now }).returning();
    await record(db, { workspaceId: f.workspaceId, actor: s, at: now, action: 'flow.create', detail: { name: f.name } });
    publish(f.workspaceId, { kind: 'flows', ids: [f.id] });
    return reply.code(201).send(flowView(f, true));
  });

  r.patch('/flows/:id', { schema: { params, body: z.object({ version: z.number().int(), name: name.optional(), steps: Steps.optional() }), response: { 200: Flow } } }, async req => {
    const { f, s } = await flowFor(req, req.params.id, true);
    const { version, ...patch } = req.body;
    if (patch.steps) checkSteps(patch.steps);
    const now = clock.now();
    const [u] = await db.update(flows).set({ ...patch, version: sql`${flows.version} + 1`, updatedAt: now })
      .where(and(eq(flows.id, f.id), eq(flows.version, version))).returning();
    if (!u) throw new ApiError(409, 'stale', 'Someone changed this flow in the meantime. Reload it and try again.');
    await record(db, { workspaceId: f.workspaceId, actor: s, at: now, action: 'flow.update', detail: { name: u.name, ...(u.name !== f.name ? { from: f.name } : {}) } });
    publish(f.workspaceId, { kind: 'flows', ids: [f.id] });
    return flowView(u, true);
  });

  r.delete('/flows/:id', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { f, s } = await flowFor(req, req.params.id, true);
    await db.delete(flows).where(eq(flows.id, f.id));
    await record(db, { workspaceId: f.workspaceId, actor: s, at: clock.now(), action: 'flow.delete', detail: { name: f.name } });
    publish(f.workspaceId, { kind: 'flows' });
    return reply.code(204).send(null);
  });
}
