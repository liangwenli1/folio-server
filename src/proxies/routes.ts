import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { profiles, proxies } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { open, seal } from '../crypto.js';
import { publish } from '../events.js';
import { record } from '../activity/service.js';
import { requireSession, type Deps } from '../http.js';
import { Geo, Proxy, ProxySecret, proxyType, proxyView } from '../views.js';
import { requirePermission } from '../workspaces/service.js';
import type { Permission } from '../permissions.js';
import { parseProxyLine, proxyRow, saveProxies, type ProxyInput } from './service.js';

const wsParams = z.object({ id: z.uuid() });
const host = z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9.:_-]+$/);
const port = z.number().int().min(1).max(65535);
const cred = z.string().max(256);
const fields = {
  name: z.string().trim().min(1).max(80).optional(), type: proxyType, host, port,
  username: cred.nullable().optional(), password: cred.nullable().optional(), backupId: z.uuid().nullable().optional()
};

export function proxyRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;

  // Seeing the library and binding its lines to a profile are separate from changing the library itself.
  async function proxyFor(req: Parameters<typeof requireSession>[0], id: string, ...perms: Permission[]){
    const [p] = await db.select().from(proxies).where(eq(proxies.id, id));
    if (!p) throw notFound('Proxy');
    const s = await requireSession(req, deps);
    await requirePermission(db, p.workspaceId, s.userId, ...perms);
    return { p, s };
  }
  async function assertBackup(workspaceId: string, backupId: string | null | undefined, self?: string){
    if (!backupId) return;
    if (backupId === self) throw new ApiError(400, 'bad_reference', 'A proxy cannot be its own backup');
    const [b] = await db.select({ id: proxies.id }).from(proxies).where(and(eq(proxies.id, backupId), eq(proxies.workspaceId, workspaceId)));
    if (!b) throw new ApiError(400, 'bad_reference', 'Unknown backup proxy');
  }
  const count = async (id: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(profiles)
    .where(and(eq(profiles.proxyId, id), isNull(profiles.deletedAt))))[0].n;

  r.get('/workspaces/:id/proxies', { schema: { params: wsParams, response: { 200: z.object({ proxies: z.array(Proxy) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, 'proxies.view');
    const rows = await db.select({ p: proxies, n: sql<number>`count(${profiles.id}) filter (where ${profiles.deletedAt} is null)::int` })
      .from(proxies).leftJoin(profiles, eq(profiles.proxyId, proxies.id))
      .where(eq(proxies.workspaceId, req.params.id)).groupBy(proxies.id).orderBy(asc(proxies.createdAt));
    return { proxies: rows.map(x => proxyView(x.p, x.n)) };
  });

  r.post('/workspaces/:id/proxies', { schema: { params: wsParams, body: z.object(fields), response: { 201: Proxy } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, 'proxies.edit');
    await assertBackup(req.params.id, req.body.backupId);
    const [p] = await db.insert(proxies).values(proxyRow(req.params.id, req.body, clock.now())).returning();
    await record(db, { workspaceId: req.params.id, actor: s, at: p.createdAt, action: 'proxy.create', detail: { name: p.name } });
    publish(req.params.id, { kind: 'proxies', ids: [p.id] });
    return reply.code(201).send(proxyView(p, 0));
  });

  // One proxy per line; lines that don't parse are reported back. A line identical to a saved proxy (type,
  // address, username and password) reuses it, so pasting a list twice adds nothing. `proxies` has one entry
  // per readable line, in order; `added` counts the new ones.
  r.post('/workspaces/:id/proxies/import', {
    schema: {
      params: wsParams,
      body: z.object({ text: z.string().max(200_000), defaultType: proxyType.default('http') }),
      response: { 200: z.object({ proxies: z.array(Proxy), added: z.number(), errors: z.array(z.object({ line: z.number(), text: z.string() })) }) }
    }
  }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, 'proxies.edit');
    const parsed: ProxyInput[] = [], errors: { line: number; text: string }[] = [];
    req.body.text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim() || line.trim().startsWith('#')) return;
      try { parsed.push(parseProxyLine(line, req.body.defaultType)); } catch { errors.push({ line: i + 1, text: line.slice(0, 120) }); }
    });
    if (parsed.length > 2000) throw new ApiError(400, 'too_many', 'Import up to 2000 proxies at a time');

    const now = clock.now();
    const { saved, added } = await saveProxies(db, req.params.id, parsed, now);
    if (added){
      await record(db, { workspaceId: req.params.id, actor: s, at: now, action: 'proxy.import', detail: { added } });
      publish(req.params.id, { kind: 'proxies' });
    }

    const counts = new Map((await db.select({ id: profiles.proxyId, n: sql<number>`count(*)::int` }).from(profiles)
      .where(and(eq(profiles.workspaceId, req.params.id), isNull(profiles.deletedAt))).groupBy(profiles.proxyId)).map(c => [c.id, c.n]));
    return { proxies: saved.map(x => proxyView(x, counts.get(x.id) ?? 0)), added, errors };
  });

  // `password: null` removes it; leaving it out keeps the current one.
  r.patch('/proxies/:id', {
    schema: { params: wsParams, body: z.object({ ...fields, type: proxyType.optional(), host: host.optional(), port: port.optional() }), response: { 200: Proxy } }
  }, async req => {
    const { p, s } = await proxyFor(req, req.params.id, 'proxies.edit');
    await assertBackup(p.workspaceId, req.body.backupId, p.id);
    const { password, ...rest } = req.body;
    const [u] = await db.update(proxies).set({
      ...rest, ...(password === undefined ? {} : { passwordEnc: password ? seal(password) : null }), updatedAt: clock.now(),
      // A changed address is a different line: its checks start over.
      ...(rest.host || rest.port || rest.type ? { lastCheck: null, history: [], lastExit: null } : {})
    }).where(eq(proxies.id, p.id)).returning();
    await record(db, { workspaceId: p.workspaceId, actor: s, at: u.updatedAt, action: 'proxy.update', detail: { name: u.name, fields: Object.keys(req.body) } });
    publish(p.workspaceId, { kind: 'proxies', ids: [p.id] });
    return proxyView(u, await count(p.id));
  });

  // Profiles using a deleted proxy keep working without one (they show "no proxy").
  r.delete('/proxies/:id', { schema: { params: wsParams, response: { 204: z.null() } } }, async (req, reply) => {
    const { p, s } = await proxyFor(req, req.params.id, 'proxies.edit');
    await db.delete(proxies).where(eq(proxies.id, p.id));
    await record(db, { workspaceId: p.workspaceId, actor: s, at: clock.now(), action: 'proxy.delete', detail: { name: p.name } });
    publish(p.workspaceId, { kind: 'proxies' }); publish(p.workspaceId, { kind: 'profiles' });
    return reply.code(204).send(null);
  });

  // The desktop app checks proxies through its local forwarder and reports what it saw.
  r.post('/proxies/:id/check', {
    schema: {
      params: wsParams,
      body: z.object({ ok: z.boolean(), ms: z.number().int().min(0).max(120_000).nullable(), ip: z.string().max(45).nullable(), geo: Geo.nullable(), error: z.string().max(200).nullable() }),
      response: { 200: Proxy }
    }
  }, async req => {
    const { p } = await proxyFor(req, req.params.id, 'proxies.view');
    const at = clock.now().toISOString(), c = req.body;
    const history = [...(p.history as unknown[]), { at, ok: c.ok, ms: c.ms }].slice(-20);
    const [u] = await db.update(proxies).set({ lastCheck: { ...c, checkedAt: at }, history, ...(c.ok ? { lastExit: { ip: c.ip, geo: c.geo, at } } : {}) }).where(eq(proxies.id, p.id)).returning();
    publish(p.workspaceId, { kind: 'proxies', ids: [p.id] });
    return proxyView(u, await count(p.id));
  });

  // Connection details with the password. The desktop refuses to pass this route through to its renderer.
  r.get('/proxies/:id/credentials', { schema: { params: wsParams, response: { 200: ProxySecret } } }, async req => {
    const { p } = await proxyFor(req, req.params.id, 'proxies.edit');
    return { id: p.id, type: p.type as 'http' | 'https' | 'socks5', host: p.host, port: p.port, username: p.username, password: p.passwordEnc ? open(p.passwordEnc) : null };
  });
}
