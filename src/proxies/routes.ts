import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { profiles, proxies } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { open, seal } from '../crypto.js';
import { publish } from '../events.js';
import { requireSession, type Deps } from '../http.js';
import { Geo, Proxy, ProxySecret, proxyType, proxyView } from '../views.js';
import { requireRole } from '../workspaces/service.js';
import { parseProxyLine, type ProxyInput } from './service.js';

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

  async function proxyFor(req: Parameters<typeof requireSession>[0], id: string){
    const [p] = await db.select().from(proxies).where(eq(proxies.id, id));
    if (!p) throw notFound('Proxy');
    const s = await requireSession(req, deps);
    await requireRole(db, p.workspaceId, s.userId);
    return p;
  }
  async function assertBackup(workspaceId: string, backupId: string | null | undefined, self?: string){
    if (!backupId) return;
    if (backupId === self) throw new ApiError(400, 'bad_reference', 'A proxy cannot be its own backup');
    const [b] = await db.select({ id: proxies.id }).from(proxies).where(and(eq(proxies.id, backupId), eq(proxies.workspaceId, workspaceId)));
    if (!b) throw new ApiError(400, 'bad_reference', 'Unknown backup proxy');
  }
  const count = async (id: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(profiles)
    .where(and(eq(profiles.proxyId, id), isNull(profiles.deletedAt))))[0].n;
  const row = (workspaceId: string, i: ProxyInput & { backupId?: string | null }, now: Date) => ({
    workspaceId, name: i.name || `${i.host}:${i.port}`, type: i.type, host: i.host, port: i.port,
    username: i.username || null, passwordEnc: i.password ? seal(i.password) : null, backupId: i.backupId ?? null, createdAt: now, updatedAt: now
  });

  r.get('/workspaces/:id/proxies', { schema: { params: wsParams, response: { 200: z.object({ proxies: z.array(Proxy) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requireRole(db, req.params.id, s.userId);
    const rows = await db.select({ p: proxies, n: sql<number>`count(${profiles.id}) filter (where ${profiles.deletedAt} is null)::int` })
      .from(proxies).leftJoin(profiles, eq(profiles.proxyId, proxies.id))
      .where(eq(proxies.workspaceId, req.params.id)).groupBy(proxies.id).orderBy(asc(proxies.createdAt));
    return { proxies: rows.map(x => proxyView(x.p, x.n)) };
  });

  r.post('/workspaces/:id/proxies', { schema: { params: wsParams, body: z.object(fields), response: { 201: Proxy } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await requireRole(db, req.params.id, s.userId);
    await assertBackup(req.params.id, req.body.backupId);
    const [p] = await db.insert(proxies).values(row(req.params.id, req.body, clock.now())).returning();
    publish(req.params.id, { kind: 'proxies', ids: [p.id] });
    return reply.code(201).send(proxyView(p, 0));
  });

  // One proxy per line; lines that don't parse are reported back and the rest are added.
  r.post('/workspaces/:id/proxies/import', {
    schema: {
      params: wsParams,
      body: z.object({ text: z.string().max(200_000), defaultType: proxyType.default('http') }),
      response: { 200: z.object({ proxies: z.array(Proxy), errors: z.array(z.object({ line: z.number(), text: z.string() })) }) }
    }
  }, async req => {
    const s = await requireSession(req, deps);
    await requireRole(db, req.params.id, s.userId);
    const parsed: ProxyInput[] = [], errors: { line: number; text: string }[] = [];
    req.body.text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim() || line.trim().startsWith('#')) return;
      try { parsed.push(parseProxyLine(line, req.body.defaultType)); } catch { errors.push({ line: i + 1, text: line.slice(0, 120) }); }
    });
    if (parsed.length > 2000) throw new ApiError(400, 'too_many', 'Import up to 2000 proxies at a time');
    const now = clock.now();
    const rows = parsed.length ? await db.insert(proxies).values(parsed.map(p => row(req.params.id, p, now))).returning() : [];
    if (rows.length) publish(req.params.id, { kind: 'proxies' });
    return { proxies: rows.map(p => proxyView(p, 0)), errors };
  });

  // `password: null` removes it; leaving it out keeps the current one.
  r.patch('/proxies/:id', {
    schema: { params: wsParams, body: z.object({ ...fields, type: proxyType.optional(), host: host.optional(), port: port.optional() }), response: { 200: Proxy } }
  }, async req => {
    const p = await proxyFor(req, req.params.id);
    await assertBackup(p.workspaceId, req.body.backupId, p.id);
    const { password, ...rest } = req.body;
    const [u] = await db.update(proxies).set({
      ...rest, ...(password === undefined ? {} : { passwordEnc: password ? seal(password) : null }), updatedAt: clock.now(),
      // A changed address invalidates the last check.
      ...(rest.host || rest.port || rest.type ? { lastCheck: null } : {})
    }).where(eq(proxies.id, p.id)).returning();
    publish(p.workspaceId, { kind: 'proxies', ids: [p.id] });
    return proxyView(u, await count(p.id));
  });

  // Profiles using a deleted proxy keep working without one (they show "no proxy").
  r.delete('/proxies/:id', { schema: { params: wsParams, response: { 204: z.null() } } }, async (req, reply) => {
    const p = await proxyFor(req, req.params.id);
    await db.delete(proxies).where(eq(proxies.id, p.id));
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
    const p = await proxyFor(req, req.params.id);
    const [u] = await db.update(proxies).set({ lastCheck: { ...req.body, checkedAt: clock.now().toISOString() } }).where(eq(proxies.id, p.id)).returning();
    publish(p.workspaceId, { kind: 'proxies', ids: [p.id] });
    return proxyView(u, await count(p.id));
  });

  // Connection details with the password. The desktop refuses to pass this route through to its renderer.
  r.get('/proxies/:id/credentials', { schema: { params: wsParams, response: { 200: ProxySecret } } }, async req => {
    const p = await proxyFor(req, req.params.id);
    return { id: p.id, type: p.type as 'http' | 'https' | 'socks5', host: p.host, port: p.port, username: p.username, password: p.passwordEnc ? open(p.passwordEnc) : null };
  });
}
