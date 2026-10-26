// Tasks run a flow on a set of profiles, in the desktop app of whoever starts them; the app reports each profile's
// result as it goes, so the whole team sees runs as they happen. Everyone creates tasks; the creator, admins and
// the owner change and delete them. Members run them on the profiles they see. A scheduled task runs by itself on
// one computer, whose app asks for its schedules and records the times it missed.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq, inArray, isNotNull, isNull, lt, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { flows, memberships, profiles, taskRunItems, taskRuns, tasks, users } from '../db/schema.js';
import { ApiError, forbidden, notFound } from '../errors.js';
import { open, seal } from '../crypto.js';
import { publish } from '../events.js';
import { record } from '../activity/service.js';
import { requireSession, type Deps } from '../http.js';
import { access } from '../profiles/service.js';
import { itemStatus, LogLine, Run, RunError, RunItem, Schedule, Task } from '../views.js';
import { Step } from '../flows/steps.js';
import type { Access } from '../workspaces/service.js';
import { MANAGE } from '../permissions.js';

const params = z.object({ id: z.uuid() });
const varName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,39}$/);
const Variables = z.record(z.uuid(), z.record(varName, z.string().max(2000)));
const fields = {
  name: z.string().trim().min(1).max(80), flowId: z.uuid(), profileIds: z.array(z.uuid()).max(2000),
  variables: Variables.nullable().optional(),
  concurrency: z.number().int().min(1).max(10), retries: z.number().int().min(0).max(3), timeoutMin: z.number().int().min(1).max(60),
  schedule: Schedule.nullable().optional()
};
type Session = { userId: string; deviceId: string | null; deviceName: string | null };
// A run nobody has reported on for this long is taken as interrupted (its app closed or lost the connection).
const STALE_MS = 15 * 60_000;
type Counts = z.infer<typeof Run>['counts'];

export function taskRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;
  // Whoever made a task may change it; so may anyone who administers the workspace.
  const canEdit = (t: typeof tasks.$inferSelect, a: Access, userId: string) => a.can(MANAGE) || t.createdBy === userId;

  // The workspace's profiles a person sees, as ids (members' scope; everything else in the workspace otherwise).
  async function visibleIds(workspaceId: string, scope: SQL | undefined, ids: string[]){
    if (!ids.length) return new Set<string>();
    const rows = await db.select({ id: profiles.id }).from(profiles)
      .where(and(eq(profiles.workspaceId, workspaceId), inArray(profiles.id, ids), isNull(profiles.deletedAt), scope));
    return new Set(rows.map(x => x.id));
  }

  async function taskFor(req: FastifyRequest, id: string, edit = false){
    const [t] = await db.select().from(tasks).where(eq(tasks.id, id));
    if (!t) throw notFound('Task');
    const s = await requireSession(req, deps);
    const { a, scope } = await access(db, t.workspaceId, s.userId);
    if (edit && !canEdit(t, a, s.userId)) throw forbidden();
    return { t, s, a, scope };
  }

  async function runFor(req: FastifyRequest, id: string){
    const [run] = await db.select().from(taskRuns).where(eq(taskRuns.id, id));
    if (!run) throw notFound('Run');
    const s = await requireSession(req, deps);
    const { scope } = await access(db, run.workspaceId, s.userId);
    return { run, s, scope };
  }

  // Runs as the asker sees them: counts over the profiles they see.
  async function runViews(where: SQL, scope: SQL | undefined, limit: number){
    const now = clock.now().getTime();
    const rows = await db.select({ run: taskRuns, email: users.email }).from(taskRuns).leftJoin(users, eq(users.id, taskRuns.startedBy))
      .where(where).orderBy(desc(taskRuns.startedAt)).limit(limit);
    if (!rows.length) return [];
    const tally = await db.select({ runId: taskRunItems.runId, status: taskRunItems.status, n: sql<number>`count(*)::int` }).from(taskRunItems)
      .where(and(inArray(taskRunItems.runId, rows.map(x => x.run.id)), scope ? inArray(taskRunItems.profileId, db.select({ id: profiles.id }).from(profiles).where(scope)) : undefined))
      .groupBy(taskRunItems.runId, taskRunItems.status);
    return rows.map(({ run, email }) => {
      const counts = Object.fromEntries(itemStatus.options.map(st => [st, 0])) as Counts;
      for (const c of tally) if (c.runId === run.id) counts[c.status as keyof Counts] = c.n;
      const stale = run.status === 'running' && now - run.updatedAt.getTime() > STALE_MS;
      return {
        id: run.id, taskId: run.taskId, trigger: run.trigger as z.infer<typeof Run>['trigger'], status: (stale ? 'interrupted' : run.status) as z.infer<typeof Run>['status'],
        flowVersion: run.flowVersion, startedBy: email, deviceName: run.deviceName, scheduledFor: run.scheduledFor?.toISOString() ?? null, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null, counts
      };
    });
  }

  async function taskViews(list: (typeof tasks.$inferSelect)[], a: Access, scope: SQL | undefined, s: Session): Promise<z.infer<typeof Task>[]> {
    const all = [...new Set(list.flatMap(t => t.profileIds))];
    const seen = list.length ? await visibleIds(list[0].workspaceId, scope, all) : new Set<string>();
    const runners = [...new Set(list.map(t => t.runnerUserId).filter((x): x is string => !!x))];
    const email = new Map(runners.length ? (await db.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, runners))).map(u => [u.id, u.email]) : []);
    const last = new Map<string, z.infer<typeof Run>>();
    for (const t of list){
      const [run] = await runViews(eq(taskRuns.taskId, t.id), scope, 1);
      if (run) last.set(t.id, run);
    }
    return list.map(t => ({
      id: t.id, name: t.name, flowId: t.flowId, profileIds: t.profileIds.filter(id => seen.has(id)), profiles: t.profileIds.length,
      concurrency: t.concurrency, retries: t.retries, timeoutMin: t.timeoutMin, hasVariables: !!t.variablesEnc, createdBy: t.createdBy,
      schedule: t.schedule as z.infer<typeof Schedule> | null,
      runner: t.runnerDeviceId ? { email: t.runnerUserId ? email.get(t.runnerUserId) ?? null : null, deviceName: t.runnerDeviceName, self: t.runnerUserId === s.userId && t.runnerDeviceId === s.deviceId } : null,
      canEdit: canEdit(t, a, s.userId), version: t.version, createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), lastRun: last.get(t.id) ?? null
    }));
  }

  // The flow must be the workspace's; members may only add profiles they see.
  async function checkRefs(workspaceId: string, flowId: string, ids: string[], scope: SQL | undefined){
    const [f] = await db.select({ id: flows.id }).from(flows).where(and(eq(flows.id, flowId), eq(flows.workspaceId, workspaceId)));
    if (!f) throw new ApiError(400, 'bad_reference', 'Unknown flow');
    if ((await visibleIds(workspaceId, scope, ids)).size !== new Set(ids).size) throw new ApiError(400, 'bad_reference', 'Unknown profile');
  }
  const sealVars = (v: z.infer<typeof Variables> | null | undefined, ids: string[]) => {
    const kept = Object.fromEntries(Object.entries(v ?? {}).filter(([id, vars]) => ids.includes(id) && Object.keys(vars).length));
    return Object.keys(kept).length ? seal(JSON.stringify(kept)) : null;
  };
  const readVars = (t: typeof tasks.$inferSelect): z.infer<typeof Variables> => (t.variablesEnc ? JSON.parse(open(t.variablesEnc)) : {});
  // A schedule needs a computer to run on: the desktop app saving it, unless the task already has one (or the
  // person asks to move it here). Times before a change of schedule or computer never count as missed.
  function scheduling(t: typeof tasks.$inferSelect | null, schedule: z.infer<typeof Schedule> | null | undefined, runHere: boolean | undefined, s: Session, now: Date){
    const next = schedule === undefined ? (t?.schedule as z.infer<typeof Schedule> | null) ?? null : schedule;
    const moveHere = !!runHere || (!!next && !t?.runnerDeviceId);
    if (moveHere && !s.deviceId) throw new ApiError(400, 'no_device', 'Scheduled tasks are set up in the desktop app');
    const changed = moveHere || JSON.stringify(next) !== JSON.stringify(t?.schedule ?? null);
    return {
      schedule: next, ...(moveHere ? { runnerUserId: s.userId, runnerDeviceId: s.deviceId, runnerDeviceName: s.deviceName } : {}), ...(changed ? { scheduleSince: now } : {})
    };
  }
  const isRunner = (t: typeof tasks.$inferSelect, s: Session) => !!s.deviceId && t.runnerUserId === s.userId && t.runnerDeviceId === s.deviceId;

  r.get('/workspaces/:id/tasks', { schema: { params, response: { 200: z.object({ tasks: z.array(Task) }) } } }, async req => {
    const s = await requireSession(req, deps);
    const { a, scope } = await access(db, req.params.id, s.userId);
    const list = await db.select().from(tasks).where(eq(tasks.workspaceId, req.params.id)).orderBy(tasks.name, tasks.createdAt);
    return { tasks: await taskViews(list, a, scope, s) };
  });

  r.post('/workspaces/:id/tasks', { schema: { params, body: z.object(fields), response: { 201: Task } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    const { a, scope } = await access(db, req.params.id, s.userId);
    const { variables, schedule, ...body } = req.body;
    const ids = [...new Set(body.profileIds)];
    await checkRefs(req.params.id, body.flowId, ids, scope);
    const now = clock.now();
    const [t] = await db.insert(tasks).values({
      ...body, ...scheduling(null, schedule, false, s, now), workspaceId: req.params.id, profileIds: ids, variablesEnc: sealVars(variables, ids), createdBy: s.userId, createdAt: now, updatedAt: now
    }).returning();
    await record(db, { workspaceId: t.workspaceId, actor: s, at: now, action: 'task.create', detail: { name: t.name } });
    publish(t.workspaceId, { kind: 'tasks', ids: [t.id] });
    return reply.code(201).send((await taskViews([t], a, scope, s))[0]);
  });

  // `variables` replaces the stored ones when given (null clears them). A member's edit keeps the task's profiles
  // they do not see. `runHere` makes the computer saving it the one the schedule runs on.
  r.patch('/tasks/:id', { schema: { params, body: z.object({ version: z.number().int(), runHere: z.boolean().optional(), ...z.object(fields).partial().shape }), response: { 200: Task } } }, async req => {
    const { t, s, a, scope } = await taskFor(req, req.params.id, true);
    const { version, variables, schedule, runHere, ...body } = req.body;
    let ids = t.profileIds;
    if (body.profileIds){
      const seen = await visibleIds(t.workspaceId, scope, t.profileIds);
      ids = [...new Set([...t.profileIds.filter(id => !seen.has(id)), ...body.profileIds])];
    }
    await checkRefs(t.workspaceId, body.flowId ?? t.flowId, body.profileIds ?? [], scope);
    const now = clock.now();
    const vars = variables === undefined ? (body.profileIds ? sealVars(readVars(t), ids) : t.variablesEnc) : sealVars(variables, ids);
    const [u] = await db.update(tasks).set({ ...body, ...scheduling(t, schedule, runHere, s, now), profileIds: ids, variablesEnc: vars, version: sql`${tasks.version} + 1`, updatedAt: now })
      .where(and(eq(tasks.id, t.id), eq(tasks.version, version))).returning();
    if (!u) throw new ApiError(409, 'stale', 'Someone changed this task in the meantime. Reload it and try again.');
    await record(db, { workspaceId: t.workspaceId, actor: s, at: now, action: 'task.update', detail: { name: u.name, ...(u.name !== t.name ? { from: t.name } : {}) } });
    publish(t.workspaceId, { kind: 'tasks', ids: [t.id] });
    return (await taskViews([u], a, scope, s))[0];
  });

  // The per-profile values, for the people who may edit the task (the run payload carries them to whoever runs it).
  r.get('/tasks/:id/variables', { schema: { params, response: { 200: z.object({ variables: Variables }) } } }, async req => {
    const { t, scope } = await taskFor(req, req.params.id, true);
    const seen = await visibleIds(t.workspaceId, scope, t.profileIds);
    return { variables: Object.fromEntries(Object.entries(readVars(t)).filter(([id]) => seen.has(id))) };
  });

  r.delete('/tasks/:id', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { t, s } = await taskFor(req, req.params.id, true);
    await db.delete(tasks).where(eq(tasks.id, t.id));
    await record(db, { workspaceId: t.workspaceId, actor: s, at: clock.now(), action: 'task.delete', detail: { name: t.name } });
    publish(t.workspaceId, { kind: 'tasks' }); publish(t.workspaceId, { kind: 'runs' });
    return reply.code(204).send(null);
  });

  // Starts a run on the profiles of the task the caller sees (or some of them, to run again what failed). The
  // answer is what the desktop app needs to run it: the task's settings, the flow's steps and each profile's
  // variables. One run of a task at a time.
  r.post('/tasks/:id/runs', {
    schema: {
      params, body: z.object({ trigger: z.enum(['manual', 'rerun', 'schedule']), profileIds: z.array(z.uuid()).max(2000).optional(), scheduledFor: z.iso.datetime().optional() }),
      response: { 201: z.object({ run: Run, task: z.object({ name: z.string(), concurrency: z.number(), retries: z.number(), timeoutMin: z.number() }), steps: z.array(Step), items: z.array(z.object({ profileId: z.string(), name: z.string(), number: z.number(), vars: z.record(z.string(), z.string()) })) }) }
    }
  }, async (req, reply) => {
    const { t, s, scope } = await taskFor(req, req.params.id);
    const now = clock.now();
    // Only the task's computer starts it on schedule, once per scheduled time.
    const scheduledFor = req.body.trigger === 'schedule' ? new Date(req.body.scheduledFor ?? NaN) : null;
    if (scheduledFor && (!isRunner(t, s) || isNaN(scheduledFor.getTime()))) throw forbidden();
    await settle(db, t.id, now);
    const [busy] = await db.select({ id: taskRuns.id }).from(taskRuns).where(and(eq(taskRuns.taskId, t.id), eq(taskRuns.status, 'running')));
    if (busy){
      // A scheduled time that comes while the last run still goes is recorded as skipped for that reason.
      if (scheduledFor) await db.insert(taskRuns).values({
        workspaceId: t.workspaceId, taskId: t.id, flowVersion: 0, trigger: 'schedule', status: 'busy', startedBy: s.userId, deviceName: s.deviceName,
        scheduledFor, startedAt: scheduledFor, updatedAt: now, finishedAt: now
      }).onConflictDoNothing({ target: [taskRuns.taskId, taskRuns.scheduledFor] });
      if (scheduledFor) publish(t.workspaceId, { kind: 'runs' });
      throw new ApiError(409, 'task_running', 'This task is still running');
    }
    const wanted = req.body.profileIds ? t.profileIds.filter(id => req.body.profileIds!.includes(id)) : t.profileIds;
    const rows = wanted.length ? await db.select({ id: profiles.id, name: profiles.name, number: profiles.number }).from(profiles)
      .where(and(eq(profiles.workspaceId, t.workspaceId), inArray(profiles.id, wanted), isNull(profiles.deletedAt), scope)).orderBy(profiles.number) : [];
    if (!rows.length) throw new ApiError(400, 'no_profiles', 'None of this task’s profiles can run');
    const [f] = await db.select().from(flows).where(eq(flows.id, t.flowId));
    const run = await db.transaction(async tx => {
      const [run] = await tx.insert(taskRuns).values({
        workspaceId: t.workspaceId, taskId: t.id, flowVersion: f.version, trigger: req.body.trigger, status: 'running',
        startedBy: s.userId, deviceName: s.deviceName, scheduledFor, startedAt: now, updatedAt: now
      }).onConflictDoNothing({ target: [taskRuns.taskId, taskRuns.scheduledFor] }).returning();
      if (!run) throw new ApiError(409, 'already_run', 'This scheduled time has already run');
      await tx.insert(taskRunItems).values(rows.map(p => ({ runId: run.id, profileId: p.id, profileName: p.name, profileNumber: p.number })));
      return run;
    });
    await record(db, { workspaceId: t.workspaceId, actor: s, at: now, action: 'run.start', detail: { name: t.name, trigger: run.trigger, profiles: rows.length } });
    publish(t.workspaceId, { kind: 'runs', ids: [run.id] });
    const vars = readVars(t);
    const [view] = await runViews(eq(taskRuns.id, run.id), scope, 1);
    return reply.code(201).send({ run: view, task: { name: t.name, concurrency: t.concurrency, retries: t.retries, timeoutMin: t.timeoutMin }, steps: f.steps as Step[], items: rows.map(p => ({ profileId: p.id, name: p.name, number: p.number, vars: vars[p.id] ?? {} })) });
  });

  // Reports from the app running it: one profile's result, a sign of life, and the end.
  async function ownRun(req: FastifyRequest, id: string){
    const { run, s } = await runFor(req, id);
    if (run.startedBy !== s.userId) throw forbidden();
    if (run.status !== 'running') throw new ApiError(409, 'run_finished', 'This run has finished');
    return { run, s };
  }
  r.post('/runs/:id/items/:profileId', {
    schema: {
      params: z.object({ id: z.uuid(), profileId: z.uuid() }),
      body: z.object({
        status: itemStatus.exclude(['pending']), attempts: z.number().int().min(0).max(4), error: RunError.nullable().optional(),
        log: z.array(LogLine).max(800).optional(), data: z.record(varName, z.string().max(10_000)).optional(), screenshots: z.array(z.string().max(300)).max(100).optional()
      }),
      response: { 204: z.null() }
    }
  }, async (req, reply) => {
    const { run } = await ownRun(req, req.params.id);
    const now = clock.now();
    const done = req.body.status !== 'running';
    const [u] = await db.update(taskRunItems).set({
      ...req.body, ...(req.body.status === 'running' ? { startedAt: now } : {}), ...(done ? { finishedAt: now } : {})
    }).where(and(eq(taskRunItems.runId, run.id), eq(taskRunItems.profileId, req.params.profileId))).returning({ id: taskRunItems.id });
    if (!u) throw notFound('Run item');
    await db.update(taskRuns).set({ updatedAt: now }).where(eq(taskRuns.id, run.id));
    if (done) publish(run.workspaceId, { kind: 'runs', ids: [run.id] });
    return reply.code(204).send(null);
  });

  r.post('/runs/:id/heartbeat', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { run } = await ownRun(req, req.params.id);
    await db.update(taskRuns).set({ updatedAt: clock.now() }).where(eq(taskRuns.id, run.id));
    return reply.code(204).send(null);
  });

  r.post('/runs/:id/finish', { schema: { params, body: z.object({ status: z.enum(['done', 'stopped']) }), response: { 200: Run } } }, async req => {
    const { run, s } = await ownRun(req, req.params.id);
    const now = clock.now();
    await db.update(taskRunItems).set({ status: 'canceled' }).where(and(eq(taskRunItems.runId, run.id), inArray(taskRunItems.status, ['pending', 'running'])));
    await db.update(taskRuns).set({ status: req.body.status, finishedAt: now, updatedAt: now }).where(eq(taskRuns.id, run.id));
    const [view] = await runViews(eq(taskRuns.id, run.id), undefined, 1);
    const [t] = await db.select({ name: tasks.name }).from(tasks).where(eq(tasks.id, run.taskId));
    const c = view.counts;
    await record(db, { workspaceId: run.workspaceId, actor: s, at: now, action: 'run.finish', detail: { name: t.name, status: view.status, ok: c.ok, failed: c.failed, signedOut: c.signed_out, skipped: c.skipped + c.canceled } });
    publish(run.workspaceId, { kind: 'runs', ids: [run.id] });
    return view;
  });

  // Scheduled times that passed while the task's computer was off, asleep or logged out. Nothing ran then; the
  // records show it, and the team can run the task now instead.
  r.post('/tasks/:id/missed', { schema: { params, body: z.object({ slots: z.array(z.iso.datetime()).min(1).max(7) }), response: { 204: z.null() } } }, async (req, reply) => {
    const { t, s } = await taskFor(req, req.params.id);
    if (!isRunner(t, s)) throw forbidden();
    const now = clock.now();
    await db.insert(taskRuns).values(req.body.slots.map(at => ({
      workspaceId: t.workspaceId, taskId: t.id, flowVersion: 0, trigger: 'schedule', status: 'missed', startedBy: s.userId, deviceName: s.deviceName,
      scheduledFor: new Date(at), startedAt: new Date(at), updatedAt: now, finishedAt: new Date(at)
    }))).onConflictDoNothing({ target: [taskRuns.taskId, taskRuns.scheduledFor] });
    publish(t.workspaceId, { kind: 'runs' });
    return reply.code(204).send(null);
  });

  // The scheduled tasks this computer runs, in every workspace the person is in. `since` is the time after which
  // scheduled times are still to be handled: the later of the last change to the schedule and the last time it
  // ran or was missed.
  r.get('/me/schedules', {
    schema: { response: { 200: z.object({ tasks: z.array(z.object({ id: z.string(), workspaceId: z.string(), name: z.string(), schedule: Schedule, since: z.string() })) }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    if (!s.deviceId) return { tasks: [] };
    const last = db.select({ taskId: taskRuns.taskId, at: sql<Date>`max(${taskRuns.scheduledFor})`.as('at') }).from(taskRuns).groupBy(taskRuns.taskId).as('last');
    const rows = await db.select({ t: tasks, at: last.at }).from(tasks)
      .innerJoin(memberships, and(eq(memberships.workspaceId, tasks.workspaceId), eq(memberships.userId, s.userId)))
      .leftJoin(last, eq(last.taskId, tasks.id))
      .where(and(eq(tasks.runnerUserId, s.userId), eq(tasks.runnerDeviceId, s.deviceId), isNotNull(tasks.schedule)));
    return { tasks: rows.map(({ t, at }) => {
      const since = Math.max(t.scheduleSince?.getTime() ?? 0, at ? new Date(at).getTime() : 0);
      return { id: t.id, workspaceId: t.workspaceId, name: t.name, schedule: t.schedule as z.infer<typeof Schedule>, since: new Date(since).toISOString() };
    }) };
  });

  r.get('/workspaces/:id/runs', {
    schema: {
      params, querystring: z.object({ taskId: z.uuid().optional(), before: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }),
      response: { 200: z.object({ runs: z.array(Run) }) }
    }
  }, async req => {
    const s = await requireSession(req, deps);
    const { scope } = await access(db, req.params.id, s.userId);
    const where = and(eq(taskRuns.workspaceId, req.params.id), req.query.taskId ? eq(taskRuns.taskId, req.query.taskId) : undefined,
      req.query.before ? lt(taskRuns.startedAt, new Date(req.query.before)) : undefined)!;
    return { runs: await runViews(where, scope, req.query.limit) };
  });

  r.get('/runs/:id', { schema: { params, response: { 200: z.object({ run: Run, items: z.array(RunItem) }) } } }, async req => {
    const { run, scope } = await runFor(req, req.params.id);
    const [view] = await runViews(eq(taskRuns.id, run.id), scope, 1);
    const items = await db.select().from(taskRunItems)
      .where(and(eq(taskRunItems.runId, run.id), scope ? inArray(taskRunItems.profileId, db.select({ id: profiles.id }).from(profiles).where(scope)) : undefined))
      .orderBy(taskRunItems.profileNumber);
    return { run: view, items: items.map(i => ({
      profileId: i.profileId, profileName: i.profileName, profileNumber: i.profileNumber, status: i.status as z.infer<typeof itemStatus>, attempts: i.attempts,
      startedAt: i.startedAt?.toISOString() ?? null, finishedAt: i.finishedAt?.toISOString() ?? null, error: i.error as z.infer<typeof RunError> | null,
      log: i.log as z.infer<typeof LogLine>[], data: i.data as Record<string, string>, screenshots: i.screenshots
    })) };
  });
}

// Runs of a task whose app stopped reporting are closed as interrupted, so the task can run again.
async function settle(db: Db, taskId: string, now: Date){
  const stale = await db.update(taskRuns).set({ status: 'interrupted', finishedAt: now })
    .where(and(eq(taskRuns.taskId, taskId), eq(taskRuns.status, 'running'), lt(taskRuns.updatedAt, new Date(now.getTime() - STALE_MS)))).returning({ id: taskRuns.id });
  if (stale.length) await db.update(taskRunItems).set({ status: 'canceled' })
    .where(and(inArray(taskRunItems.runId, stale.map(x => x.id)), inArray(taskRunItems.status, ['pending', 'running'])));
}
