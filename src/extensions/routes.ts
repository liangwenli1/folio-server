// The workspace's extension library. Owners and admins add, update and delete extensions; everyone in the workspace
// sees the library and downloads packages (the desktop app installs them into the profiles that use them).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { extensions, profiles } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { signingPublicKey } from '../crypto.js';
import { publish } from '../events.js';
import { record } from '../activity/service.js';
import { requireSession, type Deps } from '../http.js';
import { Extension, extensionView, kernel } from '../views.js';
import { membership, requirePermission } from '../workspaces/service.js';
import { MANAGE } from '../permissions.js';
import { identity, readPackage, sha256, signPackage } from './package.js';

const params = z.object({ id: z.uuid() });
const from = z.object({ source: z.enum(['upload', 'store']).default('upload'), storeId: z.string().trim().max(200).optional() });
const bytes = (body: unknown) => {
  if (!Buffer.isBuffer(body) || !body.length) throw new ApiError(400, 'validation', 'Send the package as application/octet-stream');
  return body;
};

export function extensionRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock, storage } = deps;

  async function extensionFor(req: Parameters<typeof requireSession>[0], id: string, manage = false){
    const [e] = await db.select().from(extensions).where(eq(extensions.id, id));
    if (!e) throw notFound('Extension');
    const s = await requireSession(req, deps);
    await (manage ? requirePermission(db, e.workspaceId, s.userId, MANAGE) : membership(db, e.workspaceId, s.userId));
    return { e, s };
  }
  const uses = async (workspaceId: string) => new Map((await db.select({ id: sql<string>`unnest(${profiles.extensionIds})`, n: sql<number>`count(*)::int` }).from(profiles)
    .where(and(eq(profiles.workspaceId, workspaceId), isNull(profiles.deletedAt))).groupBy(sql`1`)).map(x => [x.id, x.n]));

  r.get('/workspaces/:id/extensions', { schema: { params, response: { 200: z.object({ extensions: z.array(Extension) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await membership(db, req.params.id, s.userId);
    const count = await uses(req.params.id);
    const rows = await db.select().from(extensions).where(eq(extensions.workspaceId, req.params.id)).orderBy(asc(extensions.name));
    return { extensions: rows.map(e => extensionView(e, count.get(e.id) ?? 0)) };
  });

  // A new extension. A Firefox add-on already in the library is updated instead (409 extension_exists).
  r.post('/workspaces/:id/extensions', { schema: { params, querystring: from.extend({ kernel }), response: { 201: Extension } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, MANAGE);
    const p = readPackage(bytes(req.body));
    const who = identity(req.query.kernel, p.geckoId);
    const [dup] = await db.select({ id: extensions.id }).from(extensions)
      .where(and(eq(extensions.workspaceId, req.params.id), eq(extensions.kernel, req.query.kernel), eq(extensions.extId, who.extId)));
    if (dup) throw new ApiError(409, 'extension_exists', 'This extension is already in the library; upload the new version to it');
    const id = randomUUID(), hash = sha256(p.zip), now = clock.now();
    const objectKey = `extensions/${id}/${hash}`;
    await storage.put(objectKey, p.zip);
    const [e] = await db.insert(extensions).values({
      id, workspaceId: req.params.id, name: p.name, kernel: req.query.kernel, version: p.version, ...who, sha256: hash, size: p.zip.length, objectKey,
      signature: signPackage({ id, kernel: req.query.kernel, extId: who.extId, sha256: hash }), source: req.query.source, storeId: req.query.storeId ?? null, icon: p.icon,
      createdBy: s.userId, createdAt: now, updatedAt: now
    }).returning();
    await record(db, { workspaceId: e.workspaceId, actor: s, at: now, action: 'extension.add', detail: { name: e.name, kernel: e.kernel, version: e.version } });
    publish(e.workspaceId, { kind: 'extensions', ids: [e.id] });
    return reply.code(201).send(extensionView(e, 0));
  });

  // A new version. The extension keeps its identity, so profiles keep their data in it.
  r.put('/extensions/:id/package', { schema: { params, querystring: from, response: { 200: Extension } } }, async req => {
    const { e, s } = await extensionFor(req, req.params.id, true);
    const p = readPackage(bytes(req.body));
    if (e.kernel === 'firefox' && p.geckoId && p.geckoId !== e.extId) throw new ApiError(400, 'extension_mismatch', 'This package is a different add-on');
    const hash = sha256(p.zip), now = clock.now();
    const objectKey = `extensions/${e.id}/${hash}`;
    await storage.put(objectKey, p.zip);
    const [u] = await db.update(extensions).set({
      name: p.name, version: p.version, sha256: hash, size: p.zip.length, objectKey, signature: signPackage({ ...e, sha256: hash }),
      source: req.query.source, storeId: req.query.storeId ?? e.storeId, icon: p.icon, updatedAt: now
    }).where(eq(extensions.id, e.id)).returning();
    if (objectKey !== e.objectKey) await storage.delete(e.objectKey).catch(err => req.log.error(err, 'deleting old extension package failed'));
    await record(db, { workspaceId: e.workspaceId, actor: s, at: now, action: 'extension.update', detail: { name: u.name, version: u.version, from: e.version } });
    publish(e.workspaceId, { kind: 'extensions', ids: [e.id] });
    return extensionView(u, (await uses(e.workspaceId)).get(e.id) ?? 0);
  });

  // Leaves the library and every profile it was installed in.
  r.delete('/extensions/:id', { schema: { params, response: { 204: z.null() } } }, async (req, reply) => {
    const { e, s } = await extensionFor(req, req.params.id, true);
    await db.update(profiles).set({ extensionIds: sql`array_remove(${profiles.extensionIds}, ${e.id}::uuid)` })
      .where(and(eq(profiles.workspaceId, e.workspaceId), sql`${e.id}::uuid = any(${profiles.extensionIds})`));
    await db.delete(extensions).where(eq(extensions.id, e.id));
    await storage.delete(e.objectKey).catch(err => req.log.error(err, 'deleting extension package failed'));
    await record(db, { workspaceId: e.workspaceId, actor: s, at: clock.now(), action: 'extension.delete', detail: { name: e.name, kernel: e.kernel } });
    publish(e.workspaceId, { kind: 'extensions' }); publish(e.workspaceId, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  r.get('/extensions/:id/package', { schema: { params } }, async (req, reply) => {
    const { e } = await extensionFor(req, req.params.id);
    return reply.header('content-type', 'application/octet-stream').send(await storage.get(e.objectKey));
  });

  // The key the desktop app checks package signatures with.
  r.get('/extensions/key', { schema: { response: { 200: z.object({ publicKey: z.string() }) } } }, async req => {
    await requireSession(req, deps);
    return { publicKey: signingPublicKey };
  });
}
