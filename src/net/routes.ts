import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { locate } from '../geo.js';
import { subscribe } from '../events.js';
import { requireSession, type Deps } from '../http.js';
import { Geo } from '../views.js';
import { membership } from '../workspaces/service.js';

export function netRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();

  // Where a proxy's exit IP is. The desktop app learns the IP through the proxy from a public echo, then asks here.
  r.get('/net/locate', { schema: { querystring: z.object({ ip: z.union([z.ipv4(), z.ipv6()]) }), response: { 200: z.object({ geo: Geo.nullable() }) } } }, async req => {
    await requireSession(req, deps);
    return { geo: await locate(req.query.ip, deps.config) };
  });

  // Server-sent events: "something of this kind changed in the workspace". Desktop apps re-fetch on each event.
  r.get('/workspaces/:id/events', { schema: { hide: true, params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await membership(deps.db, req.params.id, s.userId);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    // Someone taken out of the workspace gets one last event, then their stream ends.
    const stop = () => { off(); clearInterval(beat); };
    const off = subscribe(req.params.id, change => {
      if (change.kind === 'removed' && change.userId !== s.userId) change = { kind: 'members' };
      res.write(`event: change\ndata: ${JSON.stringify(change)}\n\n`);
      if (change.kind === 'removed'){ stop(); res.end(); }
    });
    const beat = setInterval(() => res.write(': keep-alive\n\n'), 25_000);
    req.raw.on('close', stop);
  });
}
