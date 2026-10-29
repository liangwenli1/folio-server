import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, desc, eq } from 'drizzle-orm';
import { checkouts, memberships, payments, roles, users, workspaces } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import { requireSession, type Deps } from '../http.js';
import { ADDON, MAX_PROFILES, PLANS, REFUND_DAYS, TRIAL_DAYS, DAY, quote } from '../plans.js';
import { Payment, Quote, Subscription, paymentView, subscriptionView } from '../views.js';
import { requirePermission } from '../workspaces/service.js';
import { MANAGE } from '../permissions.js';
import { publish } from '../events.js';
import { latestPaidId, payCheckout, readSub, refundPayment, setCancel, startCheckout, startTrial, toState, trialOpen, type SubRow } from './service.js';

const wsParams = z.object({ id: z.uuid() });
const changeBody = z.object({ plan: z.enum(['studio', 'company']), period: z.enum(['monthly', 'yearly']), addonPacks: z.number().int().min(0).max(30) });

export function billingRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock, config } = deps;
  const view = async (sub: SubRow) => subscriptionView(sub, await trialOpen(db, sub.workspaceId));

  async function requireVerified(userId: string){
    const [u] = await db.select({ v: users.emailVerifiedAt }).from(users).where(eq(users.id, userId));
    if (!u.v) throw new ApiError(403, 'email_not_verified', 'Verify your email before changing the plan');
  }
  const isRefundable = (p: typeof payments.$inferSelect, latest: string | null, now: Date) =>
    p.status === 'paid' && p.id === latest && now.getTime() - p.createdAt.getTime() <= REFUND_DAYS * DAY;

  r.get('/plans', {
    schema: {
      response: {
        200: z.object({
          currency: z.literal('usd'), trialDays: z.number(), refundDays: z.number(), maxProfiles: z.number(),
          // Whether paid plans can be bought right now; trials and changes that cost nothing work either way.
          payments: z.boolean(),
          plans: z.array(z.object({ id: z.enum(['free', 'studio', 'company']), profiles: z.number(), members: z.number().nullable(), logDays: z.number(), price: z.object({ monthly: z.number(), yearly: z.number() }) })),
          addon: z.object({ profiles: z.number(), price: z.object({ monthly: z.number(), yearly: z.number() }) })
        })
      }
    }
  }, async () => ({
    currency: 'usd' as const, trialDays: TRIAL_DAYS, refundDays: REFUND_DAYS, maxProfiles: MAX_PROFILES, payments: config.mockPayments,
    plans: (Object.keys(PLANS) as (keyof typeof PLANS)[]).map(id => ({ id, profiles: PLANS[id].profiles, members: PLANS[id].members, logDays: PLANS[id].logDays, price: { ...PLANS[id].price } })),
    addon: { profiles: ADDON.profiles, price: { ...ADDON.price } }
  }));

  r.post('/workspaces/:id/billing/quote', { schema: { params: wsParams, body: changeBody, response: { 200: Quote } } }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, MANAGE);
    const { next: _next, ...q } = quote(toState(await readSub(db, req.params.id)), req.body, clock.now());
    return q;
  });

  r.post('/workspaces/:id/billing/checkout', {
    schema: { params: wsParams, body: changeBody, response: { 200: z.object({ checkoutId: z.string().nullable(), quote: Quote, subscription: Subscription }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, MANAGE);
    await requireVerified(s.userId);
    const now = clock.now();
    if (!config.mockPayments && quote(toState(await readSub(db, req.params.id)), req.body, now).totalCents > 0){
      throw new ApiError(503, 'payments_unavailable', 'Payments are not available yet');
    }
    const res = await startCheckout(db, { workspaceId: req.params.id, userId: s.userId, req: req.body, now });
    if (!res.checkoutId) publish(req.params.id, { kind: 'workspace' });
    const { next: _next, ...q } = res.quote;
    return { checkoutId: res.checkoutId, quote: q, subscription: await view(res.subscription) };
  });

  r.get('/billing/checkouts/:id', {
    schema: { params: wsParams, response: { 200: z.object({ id: z.string(), workspaceId: z.string(), workspaceName: z.string(), status: z.string(), expiresAt: z.string(), quote: Quote }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    const [c] = await db.select({ c: checkouts, name: workspaces.name }).from(checkouts)
      .innerJoin(workspaces, eq(workspaces.id, checkouts.workspaceId)).where(eq(checkouts.id, req.params.id));
    if (!c || c.c.userId !== s.userId) throw notFound('Checkout');
    const { next: _next, basedOn: _b, ...q } = c.c.quote as z.infer<typeof Quote> & { next: unknown; basedOn: number };
    return { id: c.c.id, workspaceId: c.c.workspaceId, workspaceName: c.name, status: c.c.status, expiresAt: c.c.expiresAt.toISOString(), quote: q };
  });

  r.post('/billing/checkouts/:id/pay', {
    schema: {
      params: wsParams,
      body: z.object({ card: z.object({ number: z.string().max(30), expMonth: z.number().int(), expYear: z.number().int().min(2000).max(2100), cvc: z.string().max(4) }) }),
      response: { 200: z.object({ subscription: Subscription, payment: Payment }) }
    }
  }, async req => {
    const s = await requireSession(req, deps);
    if (!config.mockPayments) throw new ApiError(503, 'payments_unavailable', 'Payments are not available yet');
    const res = await payCheckout(db, { checkoutId: req.params.id, userId: s.userId, card: req.body.card, now: clock.now() });
    publish(res.payment.workspaceId, { kind: 'workspace' });
    return { subscription: await view(res.subscription), payment: paymentView(res.payment, true) };
  });

  r.post('/workspaces/:id/billing/trial', { schema: { params: wsParams, response: { 200: z.object({ subscription: Subscription }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, MANAGE);
    await requireVerified(s.userId);
    const sub = await startTrial(db, req.params.id, clock.now());
    publish(req.params.id, { kind: 'workspace' });
    return { subscription: await view(sub) };
  });

  for (const [path, cancel] of [['cancel', true], ['resume', false]] as const){
    r.post(`/workspaces/:id/billing/${path}`, { schema: { params: wsParams, response: { 200: z.object({ subscription: Subscription }) } } }, async req => {
      const s = await requireSession(req, deps);
      await requirePermission(db, req.params.id, s.userId, MANAGE);
      const sub = await setCancel(db, req.params.id, cancel, clock.now());
      publish(req.params.id, { kind: 'workspace' });
      return { subscription: await view(sub) };
    });
  }

  r.get('/workspaces/:id/payments', { schema: { params: wsParams, response: { 200: z.object({ payments: z.array(Payment) }) } } }, async req => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, MANAGE);
    const now = clock.now();
    const latest = await latestPaidId(db, req.params.id);
    const rows = await db.select().from(payments).where(eq(payments.workspaceId, req.params.id)).orderBy(desc(payments.createdAt));
    return { payments: rows.map(p => paymentView(p, isRefundable(p, latest, now))) };
  });

  r.get('/payments/:id', {
    schema: { params: wsParams, response: { 200: z.object({ payment: Payment, workspace: z.object({ id: z.string(), name: z.string() }), billedTo: z.string() }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    const [p] = await db.select().from(payments).where(eq(payments.id, req.params.id));
    if (!p) throw notFound('Payment');
    await requirePermission(db, p.workspaceId, s.userId, MANAGE);
    const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, p.workspaceId));
    const [owner] = await db.select({ email: users.email }).from(memberships).innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .where(and(eq(memberships.workspaceId, p.workspaceId), eq(roles.key, 'owner')));
    return { payment: paymentView(p, isRefundable(p, await latestPaidId(db, p.workspaceId), clock.now())), workspace: { id: ws.id, name: ws.name }, billedTo: owner.email };
  });

  r.post('/payments/:id/refund', { schema: { params: wsParams, response: { 200: z.object({ payment: Payment, subscription: Subscription }) } } }, async req => {
    const s = await requireSession(req, deps);
    const [p] = await db.select({ workspaceId: payments.workspaceId }).from(payments).where(eq(payments.id, req.params.id));
    if (!p) throw notFound('Payment');
    await requirePermission(db, p.workspaceId, s.userId, MANAGE);
    const res = await refundPayment(db, req.params.id, clock.now());
    publish(p.workspaceId, { kind: 'workspace' });
    return { payment: paymentView(res.payment, false), subscription: await view(res.subscription) };
  });
}
