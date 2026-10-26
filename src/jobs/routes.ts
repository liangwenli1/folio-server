// Batch operations, for the task center. The workbench registers one when it starts checking proxies, opening
// profiles, importing proxies, editing profiles in bulk or downloading an engine, reports each target as it finishes,
// and says when it is done (or was canceled). Retrying puts only the failed targets back. Whoever administers the
// workspace sees every job; everyone else sees their own.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { jobItems, jobs, users } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { publish } from '../events.js';
import { requireSession, type Deps } from '../http.js';
import { MANAGE } from '../permissions.js';
import { Job, JobItem, jobKind } from '../views.js';
import { membership } from '../workspaces/service.js';

const params = z.object({ id: z.uuid() });
const MAX_ITEMS = 5000;

export function jobRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;

  // A job with how many of its targets went which way.
  async function view(ids: string[]){
    if (!ids.length) return [];
    const rows = await db.select({ j: jobs, by: users.email }).from(jobs).leftJoin(users, eq(users.id, jobs.startedBy)).where(inArray(jobs.id, ids));
    const counts = await db.select({ id: jobItems.jobId, status: jobItems.status, n: sql<number>`count(*)::int` }).from(jobItems)
      .where(inArray(jobItems.jobId, ids)).groupBy(jobItems.jobId, jobItems.status);
    const n = (id: string, status: string) => counts.find(c => c.id === id && c.status === status)?.n ?? 0;
    return ids.map(id => rows.find(x => x.j.id === id)!).map(({ j, by }) => ({
      id: j.id, kind: j.kind as z.infer<typeof jobKind>, detail: j.detail as Record<string, unknown>, status: j.status as z.infer<typeof Job>['status'],
      startedBy: by, startedById: j.startedBy, deviceId: j.deviceId, deviceName: j.deviceName,
      total: ['pending', 'ok', 'failed', 'canceled'].reduce((sum, s) => sum + n(j.id, s), 0), ok: n(j.id, 'ok'), failed: n(j.id, 'failed'), canceled: n(j.id, 'canceled'),
      createdAt: j.createdAt.toISOString(), finishedAt: j.finishedAt?.toISOString() ?? null
    }));
  }
  const items = async (id: string) => (await db.select().from(jobItems).where(eq(jobItems.jobId, id)).orderBy(asc(jobItems.seq)))
    .map(i => ({ seq: i.seq, targetId: i.targetId, name: i.name, status: i.status as z.infer<typeof JobItem>['status'], error: i.error, attempts: i.attempts, at: i.at?.toISOString() ?? null }));

  // A job someone may see; reporting on it, finishing and retrying it are for whoever started it.
  async function jobFor(req: Parameters<typeof requireSession>[0], id: string, own = false){
    const s = await requireSession(req, deps);
    const [j] = await db.select().from(jobs).where(eq(jobs.id, id));
    if (!j) throw notFound('Job');
    const a = await membership(db, j.workspaceId, s.userId);
    if (j.startedBy !== s.userId && (own || !a.can(MANAGE))) throw notFound('Job');
    return { s, j };
  }
  // Running, or settled by how its targets went.
  async function settle(id: string, canceled: boolean){
    const now = clock.now();
    if (canceled) await db.update(jobItems).set({ status: 'canceled', at: now }).where(and(eq(jobItems.jobId, id), eq(jobItems.status, 'pending')));
    const [{ failed, pending }] = await db.select({
      failed: sql<number>`count(*) filter (where ${jobItems.status} = 'failed')::int`, pending: sql<number>`count(*) filter (where ${jobItems.status} = 'pending')::int`
    }).from(jobItems).where(eq(jobItems.jobId, id));
    const status = canceled ? 'canceled' : pending ? 'running' : failed ? 'partial' : 'done';
    await db.update(jobs).set({ status, updatedAt: now, finishedAt: status === 'running' ? null : now }).where(eq(jobs.id, id));
  }

  r.get('/workspaces/:id/jobs', {
    schema: {
      params, querystring: z.object({ since: z.coerce.date().optional(), kind: jobKind.optional() }),
      response: { 200: z.object({ jobs: z.array(Job) }) }
    }
  }, async req => {
    const s = await requireSession(req, deps);
    const a = await membership(db, req.params.id, s.userId);
    const rows = await db.select({ id: jobs.id }).from(jobs).where(and(
      eq(jobs.workspaceId, req.params.id), a.can(MANAGE) ? undefined : eq(jobs.startedBy, s.userId),
      req.query.since ? gte(jobs.createdAt, req.query.since) : undefined, req.query.kind ? eq(jobs.kind, req.query.kind) : undefined
    )).orderBy(desc(jobs.createdAt)).limit(200);
    return { jobs: await view(rows.map(x => x.id)) };
  });

  r.get('/jobs/:id', { schema: { params, response: { 200: Job.extend({ items: z.array(JobItem) }) } } }, async req => {
    const { j } = await jobFor(req, req.params.id);
    return { ...(await view([j.id]))[0], items: await items(j.id) };
  });

  // A new job and its targets. Targets already settled (an import's lines) can come with their result, and a job that
  // is over at once with `finish`.
  const Target = z.object({
    targetId: z.string().max(200).nullable().optional(), name: z.string().trim().min(1).max(200),
    result: z.object({ ok: z.boolean(), error: z.string().max(500).nullable().optional() }).optional()
  });
  r.post('/workspaces/:id/jobs', {
    schema: {
      params, body: z.object({ kind: jobKind, detail: z.record(z.string(), z.unknown()).default({}), items: z.array(Target).min(1).max(MAX_ITEMS), finish: z.boolean().default(false) }),
      response: { 201: Job.extend({ items: z.array(JobItem) }) }
    }
  }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await membership(db, req.params.id, s.userId);
    const now = clock.now();
    const [j] = await db.insert(jobs).values({
      workspaceId: req.params.id, kind: req.body.kind, detail: req.body.detail, status: 'running', startedBy: s.userId,
      deviceId: s.deviceId, deviceName: s.deviceName, createdAt: now, updatedAt: now
    }).returning();
    await db.insert(jobItems).values(req.body.items.map((t, i) => ({
      jobId: j.id, seq: i + 1, targetId: t.targetId ?? null, name: t.name,
      ...(t.result ? { status: t.result.ok ? 'ok' : 'failed', error: t.result.ok ? null : t.result.error ?? null, attempts: 1, at: now } : {})
    })));
    if (req.body.finish) await settle(j.id, false);
    publish(req.params.id, { kind: 'jobs' });
    return reply.code(201).send({ ...(await view([j.id]))[0], items: await items(j.id) });
  });

  // How targets went, as they finish.
  r.post('/jobs/:id/results', {
    schema: {
      params, body: z.object({ results: z.array(z.object({ seq: z.number().int().min(1), ok: z.boolean(), error: z.string().max(500).nullable().optional() })).min(1).max(MAX_ITEMS) }),
      response: { 204: z.null() }
    }
  }, async (req, reply) => {
    const { j } = await jobFor(req, req.params.id, true);
    if (j.status !== 'running') throw new ApiError(409, 'job_over', 'This job is over');
    const now = clock.now();
    await db.transaction(async tx => {
      for (const x of req.body.results){
        await tx.update(jobItems).set({ status: x.ok ? 'ok' : 'failed', error: x.ok ? null : x.error ?? null, attempts: sql`${jobItems.attempts} + 1`, at: now })
          .where(and(eq(jobItems.jobId, j.id), eq(jobItems.seq, x.seq)));
      }
      await tx.update(jobs).set({ updatedAt: now }).where(eq(jobs.id, j.id));
    });
    publish(j.workspaceId, { kind: 'jobs' });
    return reply.code(204).send(null);
  });

  // Done: settled by how its targets went, or canceled, which leaves the targets not reached canceled.
  r.post('/jobs/:id/finish', { schema: { params, body: z.object({ canceled: z.boolean().default(false) }), response: { 200: Job } } }, async req => {
    const { j } = await jobFor(req, req.params.id, true);
    await settle(j.id, req.body.canceled);
    publish(j.workspaceId, { kind: 'jobs' });
    return (await view([j.id]))[0];
  });

  // The failed targets go back to waiting, and only they: the app runs them again and reports as before.
  r.post('/jobs/:id/retry', { schema: { params, response: { 200: Job.extend({ items: z.array(JobItem) }) } } }, async req => {
    const { j } = await jobFor(req, req.params.id, true);
    if (j.status === 'running') throw new ApiError(409, 'job_running', 'This job is still running');
    const now = clock.now();
    const back = await db.update(jobItems).set({ status: 'pending', error: null }).where(and(eq(jobItems.jobId, j.id), eq(jobItems.status, 'failed'))).returning();
    if (!back.length) throw new ApiError(409, 'nothing_failed', 'Nothing in this job failed');
    await db.update(jobs).set({ status: 'running', updatedAt: now, finishedAt: null }).where(eq(jobs.id, j.id));
    publish(j.workspaceId, { kind: 'jobs' });
    return { ...(await view([j.id]))[0], items: await items(j.id) };
  });
}
