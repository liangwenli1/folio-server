import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { taskRuns, tasks } from '../src/db/schema.js';
import { forgetOld } from '../src/activity/service.js';
import { PASSWORD, buy, chromiumProfile, join, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const STEPS = [{ type: 'open', url: 'https://shop.example/{{who}}' }];
async function desktop(email: string, deviceName: string, deviceId?: string): Promise<H> {
  const res = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, client: 'desktop', deviceName, deviceId } });
  return { authorization: `Bearer ${res.json().token}` };
}

// An owner on Studio with three profiles (one assigned to the member), a flow, an admin and a member.
async function team(){
  const o = await signup(t.app);
  await buy(t.app, o.headers, o.workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
  const add = async (role: 'admin' | 'member' | 'viewer') => {
    const u = await signup(t.app);
    await join(t.db, o.workspaceId, u.userId, role);
    return u;
  };
  const admin = await add('admin'), m = await add('member');
  const ws = o.workspaceId;
  const mk = async (name: string, extra = {}) => (await call('POST', `/workspaces/${ws}/profiles`, o.headers, chromiumProfile(name, extra))).json();
  const [p1, p2, p3] = [await mk('Shop-01'), await mk('Shop-02'), await mk('Shop-03', { ownerId: m.userId })];
  const flow = (await call('POST', `/workspaces/${ws}/flows`, o.headers, { name: 'Visit', steps: STEPS })).json();
  return { o, admin, m, ws, p1, p2, p3, flow };
}
const task = (flowId: string, profileIds: string[], extra = {}) => ({ name: 'Morning visit', flowId, profileIds, concurrency: 3, retries: 1, timeoutMin: 5, ...extra });

describe('tasks', () => {
  it('keep their variables sealed, show members only their profiles, and change only for their creator and managers', async () => {
    const { o, admin, m, ws, p1, p2, p3, flow } = await team();
    const vars = { [p1.id]: { who: 'ada', pass: 's3cret' }, [p3.id]: { who: 'bob' } };
    const created = await call('POST', `/workspaces/${ws}/tasks`, o.headers, task(flow.id, [p1.id, p2.id, p3.id], { variables: vars }));
    expect(created.statusCode).toBe(201);
    const tk = created.json();
    expect(tk).toMatchObject({ profiles: 3, hasVariables: true, canEdit: true, lastRun: null, concurrency: 3 });
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, tk.id));
    expect(row.variablesEnc).not.toContain('s3cret');

    const seen = (await call('GET', `/workspaces/${ws}/tasks`, m.headers)).json().tasks[0];
    expect(seen).toMatchObject({ profileIds: [p3.id], profiles: 3, canEdit: false });
    expect((await call('GET', `/tasks/${tk.id}/variables`, m.headers)).statusCode).toBe(403);
    expect((await call('GET', `/tasks/${tk.id}/variables`, admin.headers)).json().variables).toEqual(vars);
    expect((await call('PATCH', `/tasks/${tk.id}`, m.headers, { version: 0, name: 'Mine' })).json().error.code).toBe('forbidden');
    expect((await call('PATCH', `/tasks/${tk.id}`, admin.headers, { version: 0, concurrency: 5 })).json()).toMatchObject({ concurrency: 5, version: 1 });

    // A member's own task: only profiles they see go in; editing keeps the ones they no longer see.
    expect((await call('POST', `/workspaces/${ws}/tasks`, m.headers, task(flow.id, [p1.id]))).json().error.code).toBe('bad_reference');
    const mine = (await call('POST', `/workspaces/${ws}/tasks`, m.headers, task(flow.id, [p3.id], { name: 'Mine' }))).json();
    await call('POST', `/workspaces/${ws}/profiles/batch`, o.headers, { action: 'assign', ids: [p2.id], ownerId: m.userId });
    await call('PATCH', `/tasks/${mine.id}`, m.headers, { version: 0, profileIds: [p3.id, p2.id] });
    await call('POST', `/workspaces/${ws}/profiles/batch`, o.headers, { action: 'assign', ids: [p3.id], ownerId: o.userId });
    const edited = (await call('PATCH', `/tasks/${mine.id}`, m.headers, { version: 1, profileIds: [p2.id], name: 'Mine again' })).json();
    expect(edited).toMatchObject({ profileIds: [p2.id], profiles: 2 });
    expect((await t.db.select().from(tasks).where(eq(tasks.id, mine.id)))[0].profileIds.sort()).toEqual([p2.id, p3.id].sort());

    // The flow stays while a task uses it.
    expect((await call('DELETE', `/flows/${flow.id}`, o.headers)).json().error.code).toBe('flow_in_use');
    await call('DELETE', `/tasks/${tk.id}`, o.headers);
    await call('DELETE', `/tasks/${mine.id}`, m.headers);
    expect((await call('DELETE', `/flows/${flow.id}`, o.headers)).statusCode).toBe(204);
  });

  it('run in the app of whoever starts them, one at a time, reported profile by profile', async () => {
    const { o, m, ws, p1, p2, p3, flow } = await team();
    const tk = (await call('POST', `/workspaces/${ws}/tasks`, o.headers, task(flow.id, [p1.id, p2.id, p3.id], { variables: { [p2.id]: { who: 'ada' } } }))).json();
    const laptop = await desktop(o.email, 'Laptop A');
    const start = await call('POST', `/tasks/${tk.id}/runs`, laptop, { trigger: 'manual' });
    expect(start.statusCode).toBe(201);
    const { run, steps, items } = start.json();
    expect(run).toMatchObject({ trigger: 'manual', status: 'running', deviceName: 'Laptop A', startedBy: o.email, counts: { pending: 3 } });
    expect(steps).toEqual(STEPS);
    expect(start.json().task).toEqual({ name: 'Morning visit', concurrency: 3, retries: 1, timeoutMin: 5 });
    expect(items.map((i: { name: string; vars: object }) => [i.name, i.vars])).toEqual([['Shop-01', {}], ['Shop-02', { who: 'ada' }], ['Shop-03', {}]]);
    expect((await call('POST', `/tasks/${tk.id}/runs`, laptop, { trigger: 'manual' })).json().error.code).toBe('task_running');

    const report = (id: string, body: object, h = laptop) => call('POST', `/runs/${run.id}/items/${id}`, h, body);
    expect((await report(p1.id, { status: 'running', attempts: 1 })).statusCode).toBe(204);
    const log = [{ attempt: 1, path: '1', type: 'open', target: 'https://shop.example/', ms: 120 }];
    await report(p1.id, { status: 'ok', attempts: 1, log, data: { title: 'Shop' }, screenshots: ['1-1.png'] });
    await report(p2.id, { status: 'failed', attempts: 2, error: { code: 'timeout', message: 'x' }, log: [] });
    expect((await report(p3.id, { status: 'ok', attempts: 1 }, o.headers)).statusCode).toBe(204);
    expect((await call('POST', `/runs/${run.id}/heartbeat`, laptop)).statusCode).toBe(204);
    const other = await desktop(m.email, 'Laptop M');
    expect((await call('POST', `/runs/${run.id}/heartbeat`, other)).statusCode).toBe(403);
    const fin = await call('POST', `/runs/${run.id}/finish`, laptop, { status: 'done' });
    expect(fin.json()).toMatchObject({ status: 'done', counts: { ok: 2, failed: 1, pending: 0 } });
    expect((await report(p1.id, { status: 'ok', attempts: 1 })).json().error.code).toBe('run_finished');

    const full = (await call('GET', `/runs/${run.id}`, o.headers)).json();
    expect(full.items[0]).toMatchObject({ profileName: 'Shop-01', status: 'ok', attempts: 1, log, data: { title: 'Shop' }, screenshots: ['1-1.png'] });
    expect(full.items[1]).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    // Members see the rows of their own profiles, and counts over those.
    const theirs = (await call('GET', `/runs/${run.id}`, m.headers)).json();
    expect(theirs.items.map((i: { profileName: string }) => i.profileName)).toEqual(['Shop-03']);
    expect(theirs.run.counts).toMatchObject({ ok: 1, failed: 0 });
    expect((await call('GET', `/workspaces/${ws}/tasks`, o.headers)).json().tasks[0].lastRun).toMatchObject({ id: run.id, status: 'done' });

    // Running again what failed; a member runs only their profiles.
    const again = (await call('POST', `/tasks/${tk.id}/runs`, laptop, { trigger: 'rerun', profileIds: [p2.id] })).json();
    expect(again.items.map((i: { name: string }) => i.name)).toEqual(['Shop-02']);
    await call('POST', `/runs/${again.run.id}/finish`, laptop, { status: 'stopped' });
    expect((await call('GET', `/runs/${again.run.id}`, o.headers)).json()).toMatchObject({ run: { status: 'stopped', counts: { canceled: 1 } } });
    const byMember = (await call('POST', `/tasks/${tk.id}/runs`, other, { trigger: 'manual' })).json();
    expect(byMember.items.map((i: { name: string }) => i.name)).toEqual(['Shop-03']);

    const runs = (await call('GET', `/workspaces/${ws}/runs?taskId=${tk.id}`, o.headers)).json().runs;
    expect(runs.map((r: { trigger: string }) => r.trigger)).toEqual(['manual', 'rerun', 'manual']);
    const log2 = (await call('GET', `/workspaces/${ws}/activity?kind=automation`, o.headers)).json().entries.map((e: { action: string; detail: object }) => [e.action, e.detail]);
    expect(log2.slice(0, 4)).toEqual([
      ['run.start', { name: 'Morning visit', trigger: 'manual', profiles: 1 }], ['run.finish', { name: 'Morning visit', status: 'stopped', ok: 0, failed: 0, signedOut: 0, skipped: 1 }],
      ['run.start', { name: 'Morning visit', trigger: 'rerun', profiles: 1 }], ['run.finish', { name: 'Morning visit', status: 'done', ok: 2, failed: 1, signedOut: 0, skipped: 0 }]
    ]);
  });

  it('run on schedule on one computer, once per time, recording the times it missed', async () => {
    const { o, ws, p1, flow } = await team();
    const daily = { kind: 'daily', time: '09:00', days: [1, 2, 3, 4, 5], tz: 'Europe/Berlin' };
    expect((await call('POST', `/workspaces/${ws}/tasks`, o.headers, task(flow.id, [p1.id], { schedule: daily }))).json().error.code).toBe('no_device');
    const a = await desktop(o.email, 'Laptop A', 'a0000000-0000-4000-8000-000000000001');
    const b = await desktop(o.email, 'Laptop B', 'b0000000-0000-4000-8000-000000000002');
    const tk = (await call('POST', `/workspaces/${ws}/tasks`, a, task(flow.id, [p1.id], { schedule: daily }))).json();
    expect(tk).toMatchObject({ schedule: daily, runner: { email: o.email, deviceName: 'Laptop A', self: true } });
    expect((await call('GET', `/workspaces/${ws}/tasks`, b)).json().tasks[0].runner).toMatchObject({ deviceName: 'Laptop A', self: false });
    const mine = (await call('GET', '/me/schedules', a)).json().tasks;
    expect(mine).toEqual([{ id: tk.id, workspaceId: ws, name: 'Morning visit', schedule: daily, since: t.clock.now().toISOString() }]);
    expect((await call('GET', '/me/schedules', b)).json().tasks).toEqual([]);

    // Laptop A was off at two scheduled times: they are recorded once each, by A only.
    t.clock.advanceDays(3);
    const slots = ['2026-11-02T08:00:00.000Z', '2026-11-03T08:00:00.000Z'];
    expect((await call('POST', `/tasks/${tk.id}/missed`, b, { slots })).statusCode).toBe(403);
    expect((await call('POST', `/tasks/${tk.id}/missed`, a, { slots })).statusCode).toBe(204);
    await call('POST', `/tasks/${tk.id}/missed`, a, { slots: slots.slice(1) });
    const runs = async () => (await call('GET', `/workspaces/${ws}/runs?taskId=${tk.id}`, o.headers)).json().runs as { status: string; trigger: string; scheduledFor: string | null }[];
    expect((await runs()).map(r => [r.status, r.scheduledFor])).toEqual([['missed', slots[1]], ['missed', slots[0]]]);
    expect((await call('GET', '/me/schedules', a)).json().tasks[0].since).toBe(slots[1]);

    // On time: A starts it for that time; the same time can't start twice; a time during a run is skipped as busy.
    const at = '2026-11-04T09:58:00.000Z';
    expect((await call('POST', `/tasks/${tk.id}/runs`, b, { trigger: 'schedule', scheduledFor: at })).statusCode).toBe(403);
    const run = (await call('POST', `/tasks/${tk.id}/runs`, a, { trigger: 'schedule', scheduledFor: at })).json().run;
    expect(run).toMatchObject({ trigger: 'schedule', scheduledFor: at, status: 'running' });
    const next = '2026-11-04T09:59:00.000Z';
    expect((await call('POST', `/tasks/${tk.id}/runs`, a, { trigger: 'schedule', scheduledFor: next })).json().error.code).toBe('task_running');
    await call('POST', `/runs/${run.id}/items/${p1.id}`, a, { status: 'signed_out', attempts: 1, error: { code: 'signed_out', message: '' } });
    expect((await call('POST', `/runs/${run.id}/finish`, a, { status: 'done' })).json().counts).toMatchObject({ signed_out: 1, ok: 0 });
    expect((await call('POST', `/tasks/${tk.id}/runs`, a, { trigger: 'schedule', scheduledFor: at })).json().error.code).toBe('already_run');
    expect((await runs()).map(r => r.status)).toEqual(['done', 'busy', 'missed', 'missed']);

    // Moving the schedule to Laptop B: A no longer runs it, and nothing before the move counts as missed.
    t.clock.advanceDays(1);
    const moved = (await call('PATCH', `/tasks/${tk.id}`, b, { version: tk.version, runHere: true })).json();
    expect(moved.runner).toMatchObject({ deviceName: 'Laptop B', self: true });
    expect((await call('GET', '/me/schedules', a)).json().tasks).toEqual([]);
    expect((await call('GET', '/me/schedules', b)).json().tasks[0].since).toBe(t.clock.now().toISOString());
    const log = (await call('GET', `/workspaces/${ws}/activity?kind=automation`, o.headers)).json().entries;
    expect(log.find((e: { action: string }) => e.action === 'run.finish').detail).toMatchObject({ signedOut: 1 });
  });

  it('take a run whose app went quiet as interrupted, and forget runs after the plan’s retention', async () => {
    const o = await signup(t.app);
    const p = (await call('POST', `/workspaces/${o.workspaceId}/profiles`, o.headers, chromiumProfile('Solo'))).json();
    const flow = (await call('POST', `/workspaces/${o.workspaceId}/flows`, o.headers, { name: 'F', steps: STEPS })).json();
    const tk = (await call('POST', `/workspaces/${o.workspaceId}/tasks`, o.headers, task(flow.id, [p.id]))).json();
    const first = (await call('POST', `/tasks/${tk.id}/runs`, o.headers, { trigger: 'manual' })).json().run;
    t.clock.set(new Date(Date.parse(first.startedAt) + 16 * 60_000).toISOString());
    expect((await call('GET', `/workspaces/${o.workspaceId}/runs`, o.headers)).json().runs[0]).toMatchObject({ id: first.id, status: 'interrupted' });
    const second = await call('POST', `/tasks/${tk.id}/runs`, o.headers, { trigger: 'manual' });
    expect(second.statusCode).toBe(201);
    expect((await call('GET', `/runs/${first.id}`, o.headers)).json()).toMatchObject({ run: { status: 'interrupted', counts: { canceled: 1 } } });

    t.clock.advanceDays(8);
    await forgetOld(t.db, t.clock.now());
    expect(await t.db.select().from(taskRuns).where(eq(taskRuns.taskId, tk.id))).toHaveLength(0);
  });
});
