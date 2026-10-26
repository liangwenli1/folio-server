import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { docFeedback, newsSubscribers, salesInquiries } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import type { Deps } from '../http.js';
import { newsMail, type Locale } from '../mail.js';
import { locale } from '../views.js';

// The website's forms that need no account: the contact form, whether a help article helped, and news of releases.
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

  // Release news from the changelog: the emailed link confirms the address. An address already confirmed is told so;
  // otherwise the email goes out (again), at most once a minute.
  r.post('/news/subscribe', {
    config: limited,
    schema: { body: z.object({ email: z.email(), locale: locale.default('en') }), response: { 200: z.object({ status: z.enum(['pending', 'subscribed']) }) } }
  }, async req => {
    const now = deps.clock.now(), email = req.body.email.trim().toLowerCase();
    const [found] = await deps.db.select().from(newsSubscribers).where(eq(newsSubscribers.email, email));
    if (found?.confirmedAt) return { status: 'subscribed' as const };
    if (found && now.getTime() - found.sentAt.getTime() < 60_000) throw new ApiError(429, 'too_soon', 'The email went out a moment ago. Wait a minute before asking again.');
    const token = found?.token ?? randomBytes(24).toString('base64url');
    await deps.db.insert(newsSubscribers).values({ email, locale: req.body.locale, token, sentAt: now, createdAt: now })
      .onConflictDoUpdate({ target: newsSubscribers.email, set: { locale: req.body.locale, sentAt: now } });
    const page = `${deps.config.siteUrl}/${req.body.locale}/changelog/`;
    await deps.mailer.send(email, newsMail(req.body.locale as Locale, { confirm: `${page}?confirm=${token}`, unsubscribe: `${page}?unsubscribe=${token}` })).catch(err => {
      req.log.error(err, 'sending the news confirmation failed');
      throw new ApiError(503, 'mail_unavailable', 'We couldn’t send the email. Try again in a minute.');
    });
    return { status: 'pending' as const };
  });

  const token = z.object({ token: z.string().min(16).max(100) });
  // Following the link again changes nothing.
  r.post('/news/confirm', { config: limited, schema: { body: token, response: { 204: z.null() } } }, async (req, reply) => {
    const [row] = await deps.db.select({ id: newsSubscribers.id }).from(newsSubscribers).where(eq(newsSubscribers.token, req.body.token));
    if (!row) throw notFound('Subscription');
    await deps.db.update(newsSubscribers).set({ confirmedAt: deps.clock.now() }).where(and(eq(newsSubscribers.id, row.id), isNull(newsSubscribers.confirmedAt)));
    return reply.code(204).send(null);
  });

  // Unsubscribing deletes the subscription; a link already used still says it worked.
  r.post('/news/unsubscribe', { config: limited, schema: { body: token, response: { 204: z.null() } } }, async (req, reply) => {
    await deps.db.delete(newsSubscribers).where(eq(newsSubscribers.token, req.body.token));
    return reply.code(204).send(null);
  });
}
