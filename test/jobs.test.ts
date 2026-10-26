import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetOld } from '../src/activity/service.js';
import { join, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

type H = Record<string, string>;
type J = { id: string; status: string; total: number; ok: number; failed: number; canceled: number; startedBy: string | null; items?: { seq: number; status: string; error: string | null; attempts: number }[] };
const call = (method: 'GET' | 'POST', url: string, headers: H, payload?: object) => t.app.inject({ method, url, headers, payload });
const start = async (headers: H, ws: string, body: object) => (await call('POST', `/workspaces/${ws}/jobs`, headers, body)).json() as J;
const job = async (headers: H, id: string) => (await call('GET', `/jobs/${id}`, headers)).json() as J;
const targets = (n: number) => Array.from({ length: n }, (_, i) => ({ targetId: `p${i + 1}`, name: `Shop-${i + 1}` }));

describe('batch jobs', () => {
  it('collect each target’s result, settle as partial when something failed, and retry only what failed', async () => {
    const o = await signup(t.app);
    const j = await start(o.headers, o.workspaceId, { kind: 'profile.open', items: targets(3) });
    expect(j).toMatchObject({ status: 'running', total: 3, ok: 0, failed: 0, startedBy: o.email });
    expect((await call('POST', `/jobs/${j.id}/results`, o.headers, { results: [{ seq: 1, ok: true }, { seq: 2, ok: false, error: 'The proxy did not answer' }] })).statusCode).toBe(204);
    expect(await job(o.headers, j.id)).toMatchObject({ status: 'running', ok: 1, failed: 1 });
    await call('POST', `/jobs/${j.id}/results`, o.headers, { results: [{ seq: 3, ok: true }] });
    expect((await call('POST', `/jobs/${j.id}/finish`, o.headers, {})).json()).toMatchObject({ status: 'partial', ok: 2, failed: 1 });

    const again = (await call('POST', `/jobs/${j.id}/retry`, o.headers)).json() as J;
    expect(again).toMatchObject({ status: 'running', ok: 2, failed: 0 });
    expect(again.items!.map(i => i.status)).toEqual(['ok', 'pending', 'ok']);
    await call('POST', `/jobs/${j.id}/results`, o.headers, { results: [{ seq: 2, ok: true }] });
    expect((await call('POST', `/jobs/${j.id}/finish`, o.headers, {})).json()).toMatchObject({ status: 'done', ok: 3 });
    expect((await job(o.headers, j.id)).items!.find(i => i.seq === 2)).toMatchObject({ status: 'ok', error: null, attempts: 2 });
    expect((await call('POST', `/jobs/${j.id}/retry`, o.headers)).json().error.code).toBe('nothing_failed');
  });

  it('can be canceled, leaving what was not reached canceled', async () => {
    const o = await signup(t.app);
    const j = await start(o.headers, o.workspaceId, { kind: 'proxy.check', items: targets(3) });
    await call('POST', `/jobs/${j.id}/results`, o.headers, { results: [{ seq: 1, ok: true }] });
    expect((await call('POST', `/jobs/${j.id}/finish`, o.headers, { canceled: true })).json()).toMatchObject({ status: 'canceled', ok: 1, canceled: 2 });
    expect((await call('POST', `/jobs/${j.id}/results`, o.headers, { results: [{ seq: 2, ok: true }] })).json().error.code).toBe('job_over');
  });

  it('can arrive settled, like an import’s lines', async () => {
    const o = await signup(t.app);
    const j = await start(o.headers, o.workspaceId, {
      kind: 'proxy.import', finish: true,
      items: [{ name: 'Line 1', result: { ok: true } }, { name: 'Line 2', result: { ok: false, error: 'Port must be 1–65535' } }]
    });
    expect(j).toMatchObject({ status: 'partial', total: 2, ok: 1, failed: 1 });
  });

  it('are seen by whoever started them, and by whoever administers the workspace', async () => {
    const o = await signup(t.app), m = await signup(t.app);
    await join(t.db, o.workspaceId, m.userId, 'member');
    const mine = await start(m.headers, o.workspaceId, { kind: 'proxy.check', items: targets(1) });
    const owners = await start(o.headers, o.workspaceId, { kind: 'kernel.download', items: [{ name: 'Chromium 150' }] });
    const list = async (h: H) => ((await call('GET', `/workspaces/${o.workspaceId}/jobs`, h)).json().jobs as J[]).map(x => x.id).sort();
    expect(await list(o.headers)).toEqual([owners.id, mine.id].sort());
    expect(await list(m.headers)).toEqual([mine.id]);
    expect((await call('GET', `/jobs/${owners.id}`, m.headers)).statusCode).toBe(404);
    // Only whoever started a job reports on it.
    expect((await call('POST', `/jobs/${mine.id}/results`, o.headers, { results: [{ seq: 1, ok: true }] })).statusCode).toBe(404);
  });

  it('are forgotten after the plan’s retention', async () => {
    const o = await signup(t.app);
    const j = await start(o.headers, o.workspaceId, { kind: 'proxy.check', items: targets(1) });
    t.clock.advanceDays(8);
    await forgetOld(t.db, t.clock.now());
    expect((await call('GET', `/jobs/${j.id}`, o.headers)).statusCode).toBe(404);
  });
});
