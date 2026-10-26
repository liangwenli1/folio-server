import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { docFeedback, salesInquiries } from '../db/schema.js';
import type { Deps } from '../http.js';
import { locale } from '../views.js';

// The website's forms that need no account: the contact form, and whether a help article helped.
export function salesRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limited = { rateLimit: { max: deps.config.authRateLimit, timeWindow: '1 minute' } };

  // Answers with the inquiry's number, which the person keeps to refer to it.
  r.post('/sales-inquiries', {
    config: limited,
    schema: {
      body: z.object({
        kind: z.enum(['product', 'support', 'partner']), name: z.string().trim().min(1).max(100), email: z.email(),
        teamSize: z.string().max(40), message: z.string().trim().min(1).max(500), locale: locale.default('en')
      }),
      response: { 201: z.object({ number: z.number() }) }
    }
  }, async (req, reply) => {
    const [row] = await deps.db.insert(salesInquiries).values({ ...req.body, email: req.body.email.toLowerCase(), createdAt: deps.clock.now() })
      .returning({ number: salesInquiries.number });
    return reply.code(201).send(row);
  });

  r.post('/doc-feedback', {
    config: limited,
    schema: {
      body: z.object({ page: z.string().regex(/^[a-z0-9-]+$/).max(60), helpful: z.boolean(), locale: locale.default('en') }),
      response: { 201: z.object({ ok: z.literal(true) }) }
    }
  }, async (req, reply) => {
    await deps.db.insert(docFeedback).values({ ...req.body, createdAt: deps.clock.now() });
    return reply.code(201).send({ ok: true as const });
  });
}
