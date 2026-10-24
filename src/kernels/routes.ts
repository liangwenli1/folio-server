// Browser engine versions. Everyone logged in reads the catalog and gets download addresses; the platform admins
// (config.yaml `admins`) add versions by uploading packages straight to object storage, pick the recommended one,
// and remove versions.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { kernels, profiles, users } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { requireSession, type Deps } from '../http.js';
import { Kernel, archive, kernel, kernelView, platform } from '../views.js';

const params = z.object({ id: z.uuid() });
const MAX = 5 * 1024 ** 3;
// What changed in a version, in a line, for the history on the engines page.
const note = z.string().trim().max(200).transform(s => s || null).optional();

// Newest version first: "150.0.7871.186" before "148.0.7778.215", "156.0.1-beta.36" before "156.0.1-beta.9".
const parts = (v: string) => v.split(/[^0-9]+/).filter(Boolean).map(Number);
export function newestFirst(a: string, b: string){
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? -1) !== (y[i] ?? -1)) return (y[i] ?? -1) - (x[i] ?? -1);
  return 0;
}

export function kernelRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, storage, config } = deps;

  const isAdmin = async (userId: string) => {
    const [u] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    return !!u && config.admins.includes(u.email);
  };
  async function admin(req: FastifyRequest){
    const s = await requireSession(req, deps);
    if (!(await isAdmin(s.userId))) throw new ApiError(403, 'forbidden', 'Only platform admins manage engine versions');
    return s;
  }
  async function kernelOf(id: string){
    const [k] = await db.select().from(kernels).where(eq(kernels.id, id));
    if (!k) throw notFound('Engine version');
    return k;
  }

  r.get('/kernels', { schema: { response: { 200: z.object({ kernels: z.array(Kernel) }) } } }, async req => {
    const s = await requireSession(req, deps);
    const manage = await isAdmin(s.userId);
    const rows = await db.select().from(kernels).where(manage ? undefined : eq(kernels.ready, true));
    const used = manage
      ? new Map((await db.select({ kind: profiles.kernel, version: profiles.kernelVersion, n: sql<number>`count(*)::int` }).from(profiles)
        .where(isNull(profiles.deletedAt)).groupBy(profiles.kernel, profiles.kernelVersion)).map(x => [`${x.kind} ${x.version}`, x.n]))
      : null;
    rows.sort((a, b) => a.kind.localeCompare(b.kind) || newestFirst(a.version, b.version) || a.platform.localeCompare(b.platform));
    return { kernels: rows.map(k => kernelView(k, used ? used.get(`${k.kind} ${k.version}`) ?? 0 : null)) };
  });

  // Where to download a version from: its upstream release, or a signed address in Folio's storage.
  r.get('/kernels/:id/download', { schema: { params, response: { 200: z.object({ url: z.string() }) } } }, async req => {
    await requireSession(req, deps);
    const k = await kernelOf(req.params.id);
    if (!k.ready) throw notFound('Engine version');
    return { url: k.url ?? await storage.signedUrl('GET', k.objectKey!) };
  });

  // A new version for one platform: the app has worked out its size and sha256, and uploads it to the address returned.
  // An unfinished upload of the same version is replaced.
  r.post('/kernels', {
    schema: {
      body: z.object({
        kind: kernel, platform, archive, version: z.string().trim().regex(/^[0-9][0-9A-Za-z.+-]{0,39}$/),
        size: z.number().int().min(1).max(MAX), sha256: z.string().regex(/^[0-9a-f]{64}$/), note
      }),
      response: { 201: z.object({ kernel: Kernel, uploadUrl: z.string() }) }
    }
  }, async (req, reply) => {
    const s = await admin(req);
    const { kind, version, platform: p, archive: a, size, sha256, note: n } = req.body;
    const [old] = await db.select().from(kernels).where(and(eq(kernels.kind, kind), eq(kernels.version, version), eq(kernels.platform, p)));
    if (old?.ready) throw new ApiError(409, 'kernel_exists', 'This version is already in the catalog for that system');
    const objectKey = `kernels/${kind}/${version}/${p}/${sha256}.${a}`;
    const values = { kind, version, platform: p, archive: a, size, sha256, objectKey, url: null, ready: false, note: n ?? null, createdBy: s.userId };
    const [k] = old
      ? await db.update(kernels).set(values).where(eq(kernels.id, old.id)).returning()
      : await db.insert(kernels).values(values).returning();
    return reply.code(201).send({ kernel: kernelView(k, 0), uploadUrl: await storage.signedUrl('PUT', objectKey) });
  });

  // The upload finished: it goes into the catalog once the stored size matches.
  r.post('/kernels/:id/complete', { schema: { params, response: { 200: Kernel } } }, async req => {
    await admin(req);
    const k = await kernelOf(req.params.id);
    if (!k.objectKey) throw new ApiError(400, 'validation', 'This version is not an upload');
    if (await storage.size(k.objectKey) !== k.size) throw new ApiError(400, 'upload_incomplete', 'The upload did not finish. Upload the file again.');
    const [done] = await db.update(kernels).set({ ready: true }).where(eq(kernels.id, k.id)).returning();
    return kernelView(done, 0);
  });

  // The version new profiles get, on every system it is built for. Systems it isn't built for keep theirs. A note, when
  // given, replaces the version's.
  r.patch('/kernels/:id', { schema: { params, body: z.object({ recommended: z.literal(true), note }), response: { 200: z.object({ kernels: z.array(Kernel) }) } } }, async req => {
    await admin(req);
    const k = await kernelOf(req.params.id);
    if (!k.ready) throw new ApiError(409, 'upload_incomplete', 'Finish the upload first');
    const same = and(eq(kernels.kind, k.kind), eq(kernels.version, k.version), eq(kernels.ready, true));
    const rows = await db.transaction(async tx => {
      const ours = await tx.select({ platform: kernels.platform }).from(kernels).where(same);
      await tx.update(kernels).set({ recommended: false }).where(and(eq(kernels.kind, k.kind), ne(kernels.version, k.version), inArray(kernels.platform, ours.map(x => x.platform))));
      return tx.update(kernels).set({ recommended: true, recommendedAt: new Date(), ...(req.body.note !== undefined ? { note: req.body.note } : {}) }).where(same).returning();
    });
    return { kernels: rows.map(x => kernelView(x, null)) };
  });

  // Takes a version off the catalog for one system, with its package when Folio stores it. Profiles on it keep working
  // where it is already downloaded; elsewhere they are offered another version.
  r.delete('/kernels/:id', { schema: { params } }, async (req, reply) => {
    await admin(req);
    const k = await kernelOf(req.params.id);
    await db.delete(kernels).where(eq(kernels.id, k.id));
    if (k.objectKey) await storage.delete(k.objectKey).catch(err => req.log.error(err, 'deleting an engine package failed'));
    return reply.code(204).send(null);
  });
}
