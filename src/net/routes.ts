import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { locate } from '../geo.js';
import { subscribe } from '../events.js';
import { requireSession, type Deps } from '../http.js';
import { Geo } from '../views.js';
import { requireRole } from '../workspaces/service.js';

export function netRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Called through a proxy: the address we see is the proxy's exit IP.
  r.get('/net/echo', { schema: { response: { 200: z.object({ ip: z.string(), geo: Geo.nullable() }) } } }, async req => {
    await requireSession(req, deps);
    return { ip: req.ip, geo: await locate(req.ip, deps.config) };
  });

  // Server-sent events: "something of this kind changed in the workspace". Desktop apps re-fetch on each event.
  r.get('/workspaces/:id/events', { schema: { hide: true, params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await requireRole(deps.db, req.params.id, s.userId);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    const off = subscribe(req.params.id, change => res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`));
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.raw.on('close', () => { off(); clearInterval(beat); });
  });
}
