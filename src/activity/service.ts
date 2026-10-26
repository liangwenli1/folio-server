// The activity log: one place that writes entries, reads them as a person may see them, and forgets them (and task
// runs) after the plan's retention.
import { and, desc, eq, gte, inArray, lt, or, type SQL } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { activityLog, profiles, taskRuns, users } from '../db/schema.js';
import { entitlements } from '../plans.js';
import { readSub, toState } from '../billing/service.js';

export const ACTIONS = [
  'profile.create', 'profile.update', 'profile.move', 'profile.tag', 'profile.untag', 'profile.set-proxy', 'profile.assign',
  'profile.trash', 'profile.restore', 'profile.purge', 'profile.open', 'profile.close', 'profile.takeover',
  'proxy.create', 'proxy.import', 'proxy.update', 'proxy.delete', 'group.create', 'group.rename', 'group.delete', 'group.members',
  'member.invite', 'member.join', 'member.role', 'member.groups', 'member.remove', 'member.leave', 'invitation.withdraw',
  'role.create', 'role.update', 'role.delete',
  'cookies.export', 'cookies.import', 'cookies.delete', 'workspace.export', 'workspace.import',
  'flow.create', 'flow.update', 'flow.delete', 'task.create', 'task.update', 'task.delete', 'run.start', 'run.finish',
  'extension.add', 'extension.update', 'extension.delete', 'profile.add-extension', 'profile.remove-extension', 'profile.set-kernel', 'profile.set-browser'
] as const;
export type Action = typeof ACTIONS[number];
// Filters in the log page.
export const KINDS = {
  open: ['profile.open', 'profile.close', 'profile.takeover'],
  profiles: ['profile.create', 'profile.update', 'profile.move', 'profile.tag', 'profile.untag', 'profile.set-proxy', 'profile.assign', 'profile.add-extension', 'profile.remove-extension', 'profile.set-kernel', 'profile.set-browser'],
  trash: ['profile.trash', 'profile.restore', 'profile.purge'],
  proxies: ['proxy.create', 'proxy.import', 'proxy.update', 'proxy.delete', 'group.create', 'group.rename', 'group.delete', 'group.members'],
  cookies: ['cookies.export', 'cookies.import', 'cookies.delete', 'workspace.export', 'workspace.import'],
  team: ['member.invite', 'member.join', 'member.role', 'member.groups', 'member.remove', 'member.leave', 'invitation.withdraw', 'role.create', 'role.update', 'role.delete'],
  extensions: ['extension.add', 'extension.update', 'extension.delete'],
  automation: ['flow.create', 'flow.update', 'flow.delete', 'task.create', 'task.update', 'task.delete', 'run.start', 'run.finish']
} satisfies Record<string, Action[]>;

export interface Actor { userId: string; deviceName: string | null }
type ProfileRef = { id: string; name: string; number: number };

// One entry, or one per profile when profiles are given.
export async function record(db: Db | Tx, e: { workspaceId: string; actor: Actor; at: Date; action: Action; profiles?: ProfileRef[]; detail?: Record<string, unknown> }){
  const base = { workspaceId: e.workspaceId, at: e.at, actorId: e.actor.userId, deviceName: e.actor.deviceName, action: e.action, detail: e.detail ?? {} };
  const rows = e.profiles
    ? e.profiles.map(p => ({ ...base, profileId: p.id, profileName: p.name, profileNumber: p.number }))
    : [{ ...base, profileId: null, profileName: null, profileNumber: null }];
  if (rows.length) await db.insert(activityLog).values(rows);
}

export async function retentionDays(db: Db | Tx, workspaceId: string){
  return entitlements(toState(await readSub(db, workspaceId))).logDays;
}

// Newest first, within the retention. `scope` (members) keeps entries about profiles they see and their own actions.
export async function readLog(db: Db, workspaceId: string, now: Date, q: { scope?: SQL; userId: string; before?: number; limit: number; profileId?: string; actorId?: string; kind?: keyof typeof KINDS }){
  const days = await retentionDays(db, workspaceId);
  const visible = q.scope
    ? or(eq(activityLog.actorId, q.userId), inArray(activityLog.profileId, db.select({ id: profiles.id }).from(profiles).where(and(eq(profiles.workspaceId, workspaceId), q.scope))))
    : undefined;
  const rows = await db.select({ e: activityLog, actor: users.email }).from(activityLog).leftJoin(users, eq(users.id, activityLog.actorId))
    .where(and(
      eq(activityLog.workspaceId, workspaceId), gte(activityLog.at, new Date(now.getTime() - days * 86_400_000)), visible,
      q.before ? lt(activityLog.seq, q.before) : undefined, q.profileId ? eq(activityLog.profileId, q.profileId) : undefined,
      q.actorId ? eq(activityLog.actorId, q.actorId) : undefined, q.kind ? inArray(activityLog.action, KINDS[q.kind]) : undefined
    ))
    .orderBy(desc(activityLog.seq)).limit(q.limit);
  return { days, entries: rows.map(({ e, actor }) => ({
    seq: e.seq, at: e.at.toISOString(), actor, deviceName: e.deviceName, action: e.action as Action,
    profile: e.profileName === null ? null : { id: e.profileId, name: e.profileName, number: e.profileNumber! }, detail: e.detail as Record<string, unknown>
  })) };
}

// Daily: entries and task runs older than each workspace's retention go.
export async function forgetOld(db: Db, now: Date){
  const shortest = new Date(now.getTime() - 7 * 86_400_000);
  const stale = new Set([
    ...(await db.selectDistinct({ id: activityLog.workspaceId }).from(activityLog).where(lt(activityLog.at, shortest))),
    ...(await db.selectDistinct({ id: taskRuns.workspaceId }).from(taskRuns).where(lt(taskRuns.startedAt, shortest)))
  ].map(x => x.id));
  for (const id of stale){
    const cutoff = new Date(now.getTime() - (await retentionDays(db, id)) * 86_400_000);
    await db.delete(activityLog).where(and(eq(activityLog.workspaceId, id), lt(activityLog.at, cutoff)));
    await db.delete(taskRuns).where(and(eq(taskRuns.workspaceId, id), lt(taskRuns.startedAt, cutoff)));
  }
}

export const csvField = (v: unknown) => {
  const s = v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

