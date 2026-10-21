import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { mailer } from '../auth/mailer.js';
import { notFound } from '../errors.js';
import { processDue } from '../billing/service.js';
import type { Deps } from '../http.js';

// Registered only with DEV_TOOLS=1 (refused in production). Used by end-to-end tests and local trials.
export function devRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.get('/dev/mail', { schema: { hide: true, querystring: z.object({ email: z.string() }) } }, async req => {
    const m = mailer.latest(req.query.email.toLowerCase());
    if (!m) throw notFound('Email');
    return m;
  });
  r.post('/dev/run-due', { schema: { hide: true, body: z.object({ now: z.iso.datetime().optional() }) } }, async req => ({
    processed: await processDue(deps.db, req.body.now ? new Date(req.body.now) : deps.clock.now(), { renew: deps.config.mockPayments })
  }));
}
