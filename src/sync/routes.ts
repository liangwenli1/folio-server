// Opening a profile on one computer at a time, and its saved sign-in state.
// The desktop takes the lock before launching, renews it while the browser runs, uploads the state when the
// browser closes, then releases the lock. Only the session holding the lock can upload.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, gt, lte, ne, or } from 'drizzle-orm';
import { profileData, profileLocks, profiles, users, type sessions } from '../db/schema.js';
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
// Playwright's cookie shape, which the desktop converts JSON and Netscape files to.
const Cookie = z.object({
  name: z.string().max(4096), value: z.string().max(16_384), domain: z.string().min(1).max(253), path: z.string().max(1024).default('/'),
  expires: z.number().default(-1), httpOnly: z.boolean().default(false), secure: z.boolean().default(false), sameSite: z.enum(['Strict', 'Lax', 'None']).default('Lax')
});
// `extensions` holds the data folders of the profile's extensions; the server passes it through untouched.
type State = { cookies: z.infer<typeof Cookie>[]; origins: { origin: string }[]; extensions?: unknown };
type Session = typeof sessions.$inferSelect;

export function syncRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock, storage } = deps;
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_BYTES }, (_req, body, done) => done(null, body));
  const changed = (p: { workspaceId: string; id: string }) => publish(p.workspaceId, { kind: 'profiles', ids: [p.id] });
  const localOnly = () => new ApiError(409, 'local_only', 'This profile keeps its sign-ins on the computer that uses it');

  // A new version of a profile's saved state; the previous object goes.
  async function store(p: typeof profiles.$inferSelect, s: Session, body: Buffer, stats: { cookies: number; storageBytes: number; origins: number }){
    const [prev] = await db.select().from(profileData).where(eq(profileData.profileId, p.id));
    const version = (prev?.version ?? 0) + 1, objectKey = `${p.workspaceId}/${p.id}/${version}`;
    await storage.put(objectKey, body);
    const row = { version, objectKey, sha256: createHash('sha256').update(body).digest('hex'), size: body.length, ...stats, savedAt: clock.now(), savedBy: s.userId, deviceName: s.deviceName };
    const [d] = await db.insert(profileData).values({ profileId: p.id, ...row }).onConflictDoUpdate({ target: profileData.profileId, set: row }).returning();
    if (prev) await storage.delete(prev.objectKey).catch(() => {});
    changed(p);
    return d;
  }
  // Cookies come back in full shape whatever wrote them; entries that are not cookies are dropped.
  async function readState(objectKey: string): Promise<State> {
    const raw = JSON.parse(gunzipSync(await storage.get(objectKey)).toString('utf8')) as { cookies?: unknown[]; origins?: State['origins']; extensions?: unknown };
    return { cookies: (raw.cookies ?? []).flatMap(c => { const r = Cookie.safeParse(c); return r.success ? [r.data] : []; }), origins: raw.origins ?? [], ...(raw.extensions ? { extensions: raw.extensions } : {}) };
  }

  // `via: 'api'`: opened by a script through the desktop app's local API, which the activity log says.
  r.post('/profiles/:id/lock', { schema: { params, body: z.object({ via: z.enum(['api']).optional() }).nullish(), response: { 200: z.object({ expiresAt: z.string(), data: SavedData.nullable() }) } } }, async req => {
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
    if (!(before && before.sessionId === s.id && before.expiresAt > now)){
      await record(db, { workspaceId: p.workspaceId, actor: s, at: now, action: 'profile.open', profiles: [p], ...(req.body?.via ? { detail: { via: req.body.via } } : {}) });
    }
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
    if (p.syncMode === 'local') throw localOnly();
    // The lock holder saves; the first save of a profile nobody has open needs no lock (a profile brought in
    // from an export), since there is nothing to overwrite.
    const [l] = await db.select().from(profileLocks).where(and(eq(profileLocks.profileId, p.id), eq(profileLocks.sessionId, s.id)));
    if (!l){
      const [saved] = await db.select({ id: profileData.profileId }).from(profileData).where(eq(profileData.profileId, p.id));
      const [other] = await db.select({ id: profileLocks.profileId }).from(profileLocks).where(and(eq(profileLocks.profileId, p.id), gt(profileLocks.expiresAt, clock.now())));
      if (saved || other) throw new ApiError(409, 'lock_lost', 'Open the profile on this computer before saving its state');
    }
    return savedDataView(await store(p, s, body, req.query));
  });

  // The saved cookies, for exporting. Owners and admins only: members can open signed-in profiles without
  // being able to take the sign-ins away.
  r.get('/profiles/:id/cookies', { schema: { params, response: { 200: z.object({ cookies: z.array(Cookie), savedAt: z.string() }) } } }, async req => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    await requireRole(db, p.workspaceId, s.userId, ['owner', 'admin']);
    if (p.syncMode === 'local') throw localOnly();
    const [d] = await db.select().from(profileData).where(eq(profileData.profileId, p.id));
    if (!d) throw notFound('Saved state');
    const { cookies } = await readState(d.objectKey);
    await record(db, { workspaceId: p.workspaceId, actor: s, at: clock.now(), action: 'cookies.export', profiles: [p], detail: { count: cookies.length } });
    return { cookies, savedAt: d.savedAt.toISOString() };
  });

  // Merges cookies into the saved state (same name, domain and path replaces), unless another computer has the
  // profile open. The computer that has it open also adds them to the running browser.
  r.post('/profiles/:id/cookies', {
    schema: { params, body: z.object({ cookies: z.array(Cookie).min(1).max(5000) }), response: { 200: SavedData } }
  }, async req => {
    const { p, s } = await profileFor(deps, req, req.params.id);
    if (p.syncMode === 'local') throw localOnly();
    const now = clock.now();
    if ((await db.select().from(profileLocks).where(and(eq(profileLocks.profileId, p.id), ne(profileLocks.sessionId, s.id), gt(profileLocks.expiresAt, now)))).length){
      throw new ApiError(409, 'locked', 'This profile is open on another computer');
    }
    const [d] = await db.select().from(profileData).where(eq(profileData.profileId, p.id));
    const state: State = d ? await readState(d.objectKey) : { cookies: [], origins: [] };
    const key = (c: { name: string; domain: string; path: string }) => `${c.name}\u0000${c.domain}\u0000${c.path}`;
    const incoming = new Map(req.body.cookies.map(c => [key(c), c]));
    state.cookies = [...state.cookies.filter(c => !incoming.has(key(c))), ...incoming.values()];
    const body = gzipSync(JSON.stringify(state));
    const saved = await store(p, s, body, { cookies: state.cookies.length, storageBytes: Buffer.byteLength(JSON.stringify(state.origins)), origins: state.origins.length });
    await record(db, { workspaceId: p.workspaceId, actor: s, at: now, action: 'cookies.import', profiles: [p], detail: { count: incoming.size } });
    return savedDataView(saved);
  });
}
