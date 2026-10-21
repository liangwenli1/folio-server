// Response shapes. These zod schemas also produce the OpenAPI document the site and desktop generate types from.
import { z } from 'zod';
import type { users } from './db/schema.js';
import { entitlements } from './plans.js';
import { toState, type PaymentRow, type SubRow } from './billing/service.js';

const iso = z.string().nullable();
const plan = z.enum(['free', 'studio', 'company']);
const paidPlan = z.enum(['studio', 'company']);
const period = z.enum(['monthly', 'yearly']);
export const role = z.enum(['owner', 'admin', 'member']);
export const locale = z.enum(['en', 'zh']);

export const ErrorBody = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

export const User = z.object({ id: z.string(), email: z.string(), emailVerified: z.boolean(), locale });
export const userView = (u: typeof users.$inferSelect): z.infer<typeof User> =>
  ({ id: u.id, email: u.email, emailVerified: !!u.emailVerifiedAt, locale: u.locale as 'en' | 'zh' });

export const Subscription = z.object({
  plan, period: period.nullable(), status: z.enum(['active', 'trialing']), addonPacks: z.number(),
  trialEndsAt: iso, currentPeriodStart: iso, currentPeriodEnd: iso, cancelAtPeriodEnd: z.boolean(),
  scheduledPlan: paidPlan.nullable(), scheduledPeriod: period.nullable(), trialAvailable: z.boolean(),
  entitlements: z.object({ profiles: z.number(), members: z.number().nullable(), logDays: z.number() })
});
export function subscriptionView(r: SubRow): z.infer<typeof Subscription> {
  const s = toState(r);
  return {
    plan: s.plan, period: s.period, status: s.status, addonPacks: s.addonPacks,
    trialEndsAt: s.trialEndsAt?.toISOString() ?? null, currentPeriodStart: s.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: s.currentPeriodEnd?.toISOString() ?? null, cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    scheduledPlan: s.scheduledPlan, scheduledPeriod: s.scheduledPeriod, trialAvailable: s.plan === 'free' && !s.trialUsed,
    entitlements: entitlements(s)
  };
}

export const WorkspaceSummary = z.object({ id: z.string(), name: z.string(), role, plan, status: z.enum(['active', 'trialing']) });
export const Workspace = z.object({
  id: z.string(), name: z.string(), role, subscription: Subscription,
  usage: z.object({ profiles: z.number(), members: z.number() })
});

export const QuoteLine = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan'), plan: paidPlan, period, amountCents: z.number() }),
  z.object({ kind: z.literal('addon'), period, quantity: z.number(), prorated: z.boolean(), amountCents: z.number() }),
  z.object({ kind: z.literal('credit'), plan: paidPlan, period, amountCents: z.number() })
]);
export const Quote = z.object({
  change: z.enum(['new', 'upgrade', 'addon', 'reduce-addon', 'downgrade']), effective: z.enum(['now', 'period_end']),
  lines: z.array(QuoteLine), totalCents: z.number()
});

export const Payment = z.object({
  id: z.string(), invoiceNumber: z.string(), kind: z.enum(['checkout', 'renewal']), amountCents: z.number(), currency: z.string(),
  lines: z.array(QuoteLine), cardBrand: z.string().nullable(), cardLast4: z.string().nullable(), status: z.enum(['paid', 'refunded']),
  periodStart: iso, periodEnd: iso, createdAt: z.string(), refundedAt: iso, refundable: z.boolean()
});
export function paymentView(p: PaymentRow, refundable: boolean): z.infer<typeof Payment> {
  return {
    id: p.id, invoiceNumber: p.invoiceNumber, kind: p.kind as 'checkout' | 'renewal', amountCents: p.amountCents, currency: p.currency,
    lines: p.lines as z.infer<typeof QuoteLine>[], cardBrand: p.cardBrand, cardLast4: p.cardLast4, status: p.status as 'paid' | 'refunded',
    periodStart: p.periodStart?.toISOString() ?? null, periodEnd: p.periodEnd?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(), refundedAt: p.refundedAt?.toISOString() ?? null, refundable
  };
}
