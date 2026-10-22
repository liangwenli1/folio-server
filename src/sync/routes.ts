// Opening a profile on one computer at a time, and its saved sign-in state.
// The desktop takes the lock before launching, renews it while the browser runs, uploads the state when the
// browser closes, then releases the lock. Only the session holding the lock can upload.
import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, lte, or } from 'drizzle-orm';
import { profileData, profileLocks, profiles, users } from '../db/schema.js';
import { record } from '../activity/service.js';
import { ApiError, notFound } from '../errors.js';
import { publish } from '../events.js';
import type { Deps } from '../http.js';
import { profileFor } from '../profiles/service.js';
import { SavedData, savedDataView } from '../views.js';
import { requireRole } from '../workspaces/service.js';

export const LOCK_MS = 90_000;
const MAX_BYTES = 50 * 1024 * 1024;
const params = z.object({ id: z.uuid() });
const count = z.coerce.number().int().min(0).max(2 ** 31 - 1);

export function syncRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock, storage } = deps;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));
  const changed = (p: { workspaceId: string; id: string }) => publish(p.workspaceId, { kind: 'profiles', ids: [p.id] });

  r.post('/profiles/:id/lock', { schema: { params, response: { 200: z.object({ expiresAt: z.string(), data: SavedData.nullable() }) } } }, async req => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    if (p.deletedAt) throw new ApiError(409, 'in_trash', 'Restore this profile from the trash before opening it');
    const now = clock.now(), expiresAt = new Date(now.getTime() + LOCK_MS);
    const holder = { sessionId: s.id, userId: s.userId, deviceName: s.deviceName, acquiredAt: now, expiresAt };
    const [before] = await db.select().from(profileLocks).where(eq(profileLocks.profileId, p.id));
    // Taken when free, expired, or already this session's.
    const [l] = await db.insert(profileLocks).values({ profileId: p.id, ...holder })
      .onConflictDoUpdate({ target: profileLocks.profileId, set: holder, setWhere: or(eq(profileLocks.sessionId, s.id), lte(profileLocks.expiresAt, now)) })
      .returning();
    if (!l) throw new ApiError(409, 'locked', 'This profile is open on another computer');
    await db.update(profiles).set({ lastOpenedAt: now, lastOpenedBy: s.userId }).where(eq(profiles.id, p.id));
    // Taking the lock again from the same open browser is not a new opening.
    if (!(before && before.sessionId === s.id && before.expiresAt > now)) await record(db, { workspaceId: p.workspaceId, actor: s, at: now, action: 'profile.open', profiles: [p] });
    changed(p);
    const [d] = await db.select().from(profileData).where(eq(profileData.profileId, p.id));
    return { expiresAt: expiresAt.toISOString(), data: d ? savedDataView(d) : null };
  });

  // Renewing works for as long as this session still holds the row, even past expiry; a takeover removes it.
  r.post('/profiles/:id/lock/renew', { schema: { params, response: { 200: z.object({ expiresAt: z.string() }) } } }, async req => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    const expiresAt = new Date(clock.now().getTime() + LOCK_MS);
    const [l] = await db.update(profileLocks).set({ expiresAt }).where(and(eq(profileLocks.profileId, p.id), eq(profileLocks.sessionId, s.id))).returning();
    if (!l) throw new ApiError(409, 'lock_lost', 'This profile was opened elsewhere');
    return { expiresAt: expiresAt.toISOString() };
  });

  r.delete('/profiles/:id/lock', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    const gone = await db.delete(profileLocks).where(and(eq(profileLocks.profileId, p.id), eq(profileLocks.sessionId, s.id))).returning();
    if (gone.length){
      await record(db, { workspaceId: p.workspaceId, actor: s, at: clock.now(), action: 'profile.close', profiles: [p] });
      changed(p);
    }
    return reply.code(204).send(null);
  });

  // Owners and admins can free a profile someone else has open; that computer closes it on its next renewal.
  r.post('/profiles/:id/lock/takeover', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    await requireRole(db, p.workspaceId, s.userId, ['owner', 'admin']);
    const gone = await db.delete(profileLocks).where(eq(profileLocks.profileId, p.id)).returning();
    if (gone.length){
      const [from] = await db.select({ email: users.email }).from(users).where(eq(users.id, gone[0].userId));
      await record(db, { workspaceId: p.workspaceId, actor: s, at: clock.now(), action: 'profile.takeover', profiles: [p], detail: { from: from?.email ?? null, device: gone[0].deviceName } });
      changed(p);
    }
    return reply.code(204).send(null);
  });

  // The saved state as uploaded: gzip-compressed JSON (Playwright's storage state).
  r.get('/profiles/:id/data', { schema: { params } }, async (req, reply) => {
    const { p } = await profileFor(deps, req, req.params.id);
    const [d] = await db.select().from(profileData).where(eq(profileData.profileId, p.id));
    if (!d) throw notFound('Saved state');
    return reply.header('content-type', 'application/octet-stream').header('x-folio-sha256', d.sha256).header('x-folio-version', String(d.version))
      .send(await storage.get(d.objectKey));
  });

  r.put('/profiles/:id/data', {
    schema: { params, querystring: z.object({ cookies: count, storageBytes: count, origins: count }), response: { 200: SavedData } }
  }, async req => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || !body.length) throw new ApiError(400, 'validation', 'Send the state as application/octet-stream');
    const [l] = await db.select().from(profileLocks).where(and(eq(profileLocks.profileId, p.id), eq(profileLocks.sessionId, s.id)));
    if (!l) throw new ApiError(409, 'lock_lost', 'Open the profile on this computer before saving its state');
    const [prev] = await db.select().from(profileData).where(eq(profileData.profileId, p.id));
    const version = (prev?.version ?? 0) + 1, objectKey = `${p.workspaceId}/${p.id}/${version}`;
    await storage.put(objectKey, body);
    const row = {
      version, objectKey, sha256: createHash('sha256').update(body).digest('hex'), size: body.length, ...req.query,
      savedAt: clock.now(), savedBy: s.userId, deviceName: s.deviceName
    };
    const [d] = await db.insert(profileData).values({ profileId: p.id, ...row }).onConflictDoUpdate({ target: profileData.profileId, set: row }).returning();
    if (prev) await storage.delete(prev.objectKey).catch(err => req.log.error(err, 'deleting the previous saved state failed'));
    changed(p);
    return savedDataView(d);
  });
}
