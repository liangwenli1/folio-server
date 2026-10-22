// A whole workspace in one file (owners and admins): its profiles with their fingerprints, groups, and proxies
// with passwords. The desktop adds each profile's saved sign-in state, encrypts the file with a passphrase the
// server never sees, and on import sends the list back here to recreate it in another workspace.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { groups, profileData, profiles, proxies, workspaces } from '../db/schema.js';
import { open } from '../crypto.js';
import { publish } from '../events.js';
import { record } from '../activity/service.js';
import { requireSession, type Deps } from '../http.js';
import { BULK_BODY, newProfile } from '../profiles/routes.js';
import { activeCount, createProfiles } from '../profiles/service.js';
import { ApiError } from '../errors.js';
import { entitlements } from '../plans.js';
import { readSub, toState } from '../billing/service.js';
import { saveProxies } from '../proxies/service.js';
import { proxyType } from '../views.js';
import { requireRole } from '../workspaces/service.js';

const params = z.object({ id: z.uuid() });
const ref = z.string().min(1).max(64);
const ExportedProxy = z.object({
  ref, name: z.string().trim().min(1).max(80), type: proxyType, host: z.string().min(1).max(253), port: z.number().int().min(1).max(65535),
  username: z.string().max(256).nullable(), password: z.string().max(256).nullable(), backupRef: ref.nullable()
});
// `saved`: the profile has a sign-in state, which travels next to this list.
const ExportedProfile = newProfile.omit({ groupId: true, ownerId: true, departmentId: true, proxyId: true })
  .extend({ ref, group: z.string().max(80).nullable(), proxyRef: ref.nullable(), saved: z.boolean() });
const Bundle = z.object({
  groups: z.array(z.string().trim().min(1).max(80)).max(1000), proxies: z.array(ExportedProxy).max(2000), profiles: z.array(ExportedProfile).max(2000)
});

export function transferRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;
  const manager = async (req: Parameters<typeof requireSession>[0], workspaceId: string) => {
    const s = await requireSession(req, deps);
    const role = await requireRole(db, workspaceId, s.userId, ['owner', 'admin']);
    return { s, role };
  };

  // Profiles in the Trash stay behind.
  r.get('/workspaces/:id/export', { schema: { params, response: { 200: Bundle.extend({ workspace: z.string(), exportedAt: z.string() }) } } }, async req => {
    const { s } = await manager(req, req.params.id);
    const ws = req.params.id;
    const [w] = await db.select({ name: workspaces.name }).from(workspaces).where(eq(workspaces.id, ws));
    const groupRows = await db.select().from(groups).where(eq(groups.workspaceId, ws)).orderBy(asc(groups.name));
    const proxyRows = await db.select().from(proxies).where(eq(proxies.workspaceId, ws)).orderBy(asc(proxies.createdAt));
    const profileRows = await db.select({ p: profiles, saved: profileData.profileId }).from(profiles).leftJoin(profileData, eq(profileData.profileId, profiles.id))
      .where(and(eq(profiles.workspaceId, ws), isNull(profiles.deletedAt))).orderBy(asc(profiles.number));
    const groupName = new Map(groupRows.map(g => [g.id, g.name]));
    const now = clock.now();
    await record(db, { workspaceId: ws, actor: s, at: now, action: 'workspace.export', detail: { profiles: profileRows.length, proxies: proxyRows.length } });
    return {
      workspace: w.name, exportedAt: now.toISOString(), groups: groupRows.map(g => g.name),
      proxies: proxyRows.map(p => ({
        ref: p.id, name: p.name, type: p.type as 'http' | 'https' | 'socks5', host: p.host, port: p.port, username: p.username,
        password: p.passwordEnc ? open(p.passwordEnc) : null, backupRef: p.backupId
      })),
      profiles: profileRows.map(({ p, saved }) => ({
        ref: p.id, name: p.name, group: p.groupId ? groupName.get(p.groupId) ?? null : null, tags: p.tags, kernel: p.kernel as 'chromium' | 'firefox',
        kernelVersion: p.kernelVersion, os: p.os as 'windows' | 'macos' | 'linux', fingerprint: p.fingerprint as z.infer<typeof newProfile>['fingerprint'],
        proxyRef: p.proxyId, timezoneOverride: p.timezoneOverride, localeOverride: p.localeOverride, notes: p.notes,
        syncMode: p.syncMode as 'cloud' | 'local', saved: !!saved
      }))
    };
  });

  // Recreates the list in this workspace: groups by name, proxies reused when identical, profiles new and
  // numbered here within the plan's limit, assigned to whoever imports them. Returns each profile's new id,
  // for the desktop to upload the sign-in states (a profile's first save needs no lock).
  r.post('/workspaces/:id/import', {
    bodyLimit: BULK_BODY,
    schema: {
      params, body: Bundle,
      response: { 200: z.object({ profiles: z.array(z.object({ ref, id: z.string() })), added: z.object({ profiles: z.number(), proxies: z.number(), groups: z.number() }) }) }
    }
  }, async req => {
    const { s, role } = await manager(req, req.params.id);
    const ws = req.params.id, now = clock.now(), bundle = req.body;
    // Checked before anything is written, so a file that does not fit leaves no half-import behind.
    const limit = entitlements(toState(await readSub(db, ws))).profiles;
    if (await activeCount(db, ws) + bundle.profiles.length > limit){
      throw new ApiError(403, 'plan_limit', `This plan allows ${limit} profiles. Move some to the trash or add more to the plan.`);
    }

    const names = [...new Set([...bundle.groups, ...bundle.profiles.flatMap(p => (p.group ? [p.group] : []))])];
    const newGroups = names.length ? await db.insert(groups).values(names.map(name => ({ workspaceId: ws, name, createdAt: now }))).onConflictDoNothing().returning() : [];
    const groupId = new Map((await db.select().from(groups).where(eq(groups.workspaceId, ws))).map(g => [g.name, g.id]));

    const { saved, added } = await saveProxies(db, ws, bundle.proxies, now);
    const proxyId = new Map(bundle.proxies.map((p, i) => [p.ref, saved[i].id]));
    for (const [i, p] of bundle.proxies.entries()){
      const backup = p.backupRef ? proxyId.get(p.backupRef) : undefined;
      if (backup && backup !== saved[i].id) await db.update(proxies).set({ backupId: backup }).where(eq(proxies.id, saved[i].id));
    }

    const created = bundle.profiles.length ? await createProfiles(deps, ws, s, role, bundle.profiles.map(({ ref: _ref, group, proxyRef, saved: _saved, ...p }) => ({
      ...p, groupId: group ? groupId.get(group) ?? null : null, proxyId: proxyRef ? proxyId.get(proxyRef) ?? null : null
    }))) : [];
    await record(db, { workspaceId: ws, actor: s, at: now, action: 'workspace.import', detail: { profiles: created.length, proxies: added, groups: newGroups.length } });
    publish(ws, { kind: 'proxies' }); publish(ws, { kind: 'groups' });
    return { profiles: bundle.profiles.map((p, i) => ({ ref: p.ref, id: created[i].id })), added: { profiles: created.length, proxies: added, groups: newGroups.length } };
  });
}
