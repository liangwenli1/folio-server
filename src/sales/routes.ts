import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { salesInquiries } from '../db/schema.js';
import type { Deps } from '../http.js';
import { locale } from '../views.js';

export function salesRoutes(app: FastifyInstance, deps: Deps){
  app.withTypeProvider<ZodTypeProvider>().post('/sales-inquiries', {
    config: { rateLimit: { max: deps.config.authRateLimit, timeWindow: '1 minute' } },
    schema: {
      body: z.object({
        name: z.string().trim().min(1).max(100), email: z.email(), company: z.string().trim().max(120).optional(),
        teamSize: z.string().max(40).optional(), message: z.string().trim().min(1).max(4000), locale: locale.default('en')
      }),
      response: { 201: z.object({ ok: z.literal(true) }) }
    }
  }, async (req, reply) => {
    await deps.db.insert(salesInquiries).values({ ...req.body, email: req.body.email.toLowerCase(), createdAt: deps.clock.now() });
    return reply.code(201).send({ ok: true as const });
  });
}
