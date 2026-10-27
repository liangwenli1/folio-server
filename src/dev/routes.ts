import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { processDue } from '../billing/service.js';
import { extensions } from '../db/schema.js';
import type { Deps } from '../http.js';

// Registered only with DEV_TOOLS=1 (refused in production). Used by end-to-end tests and local trials.
export function devRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post('/dev/run-due', { schema: { hide: true, body: z.object({ now: z.iso.datetime().optional() }) } }, async req => ({
    processed: await processDue(deps.db, req.body.now ? new Date(req.body.now) : deps.clock.now(), { renew: deps.config.mockPayments })
  }));
  // Changes one byte of an extension's stored package, as tampered storage would, leaving its hash and signature.
  r.post('/dev/extensions/:id/tamper', { schema: { hide: true, params: z.object({ id: z.uuid() }) } }, async (req, reply) => {
    const [e] = await deps.db.select().from(extensions).where(eq(extensions.id, req.params.id));
    if (!e) return reply.code(404).send(null);
    const bytes = await deps.storage.get(e.objectKey);
    bytes[bytes.length - 1] ^= 0xff;
    await deps.storage.put(e.objectKey, bytes);
    return reply.code(204).send(null);
  });
  // The public echo's stand-in for proxy checks in tests (the desktop's FOLIO_ECHO_URLS): the caller's address, in the
  // format of Cloudflare's trace.
  r.get('/dev/echo', { schema: { hide: true } }, async (req, reply) => reply.type('text/plain').send(`ip=${req.ip.replace(/^::ffff:/, '')}\n`));
}
