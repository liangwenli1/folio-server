import { and, desc, eq, lte, ne, or, sql } from 'drizzle-orm';
import type { Db, Tx } from '../db/client.js';
import { checkouts, payments, subscriptions } from '../db/schema.js';
import { ApiError, notFound } from '../errors.js';
import {
  DAY, FREE, REFUND_DAYS, TRIAL_DAYS, addDays, addPeriod, cyclePrice, isPaid, quote,
  ADDON, PLANS, type ChangeRequest, type PaidPlan, type Period, type Quote, type QuoteLine, type SubState
} from '../plans.js';
import { chargeCard, type Card } from './mock-gateway.js';

export type SubRow = typeof subscriptions.$inferSelect;
export type PaymentRow = typeof payments.$inferSelect;

export const toState = (r: SubRow): SubState => ({
  plan: r.plan as SubState['plan'], period: r.period as Period | null, status: r.status as SubState['status'],
  addonPacks: r.addonPacks, trialUsed: r.trialUsed, trialEndsAt: r.trialEndsAt,
  currentPeriodStart: r.currentPeriodStart, currentPeriodEnd: r.currentPeriodEnd, cancelAtPeriodEnd: r.cancelAtPeriodEnd,
  scheduledPlan: r.scheduledPlan as PaidPlan | null, scheduledPeriod: r.scheduledPeriod as Period | null
});

// quote.next and payments.previous are stored as JSON; dates come back as strings.
function revive<T extends Partial<SubState>>(o: Record<string, unknown>): T {
  const r: Record<string, unknown> = { ...o };
  for (const k of ['trialEndsAt', 'currentPeriodStart', 'currentPeriodEnd']) if (typeof r[k] === 'string') r[k] = new Date(r[k] as string);
  return r as T;
}

export async function readSub(db: Db | Tx, workspaceId: string){
  const [r] = await db.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId));
  if (!r) throw notFound('Subscription');
  return r;
}

async function lockSub(tx: Tx, workspaceId: string){
  const [r] = await tx.select().from(subscriptions).where(eq(subscriptions.workspaceId, workspaceId)).for('update');
  if (!r) throw notFound('Subscription');
  return r;
}

async function writeSub(tx: Tx, workspaceId: string, patch: Partial<SubState>, now: Date){
  const [r] = await tx.update(subscriptions).set({ ...patch, version: sql`${subscriptions.version} + 1`, updatedAt: now }).where(eq(subscriptions.workspaceId, workspaceId)).returning();
  return r;
}

async function recordPayment(tx: Tx, p: {
  workspaceId: string; kind: 'checkout' | 'renewal'; amountCents: number; lines: QuoteLine[];
  card: { brand: string; last4: string } | null; periodStart: Date | null; periodEnd: Date | null; previous: SubRow; now: Date;
}){
  const [{ n }] = await tx.execute<{ n: string }>(sql`select nextval('invoice_seq') as n`);
  const [row] = await tx.insert(payments).values({
    workspaceId: p.workspaceId, invoiceNumber: `FOLIO-${p.now.getUTCFullYear()}-${String(n).padStart(6, '0')}`,
    kind: p.kind, amountCents: p.amountCents, lines: p.lines, cardBrand: p.card?.brand ?? null, cardLast4: p.card?.last4 ?? null,
    periodStart: p.periodStart, periodEnd: p.periodEnd, previous: toState(p.previous), createdAt: p.now
  }).returning();
  return row;
}

export type PaymentEvent =
  | { type: 'checkout.paid'; checkoutId: string; card: { brand: string; last4: string } }
  | { type: 'renewal.paid'; workspaceId: string }
  | { type: 'payment.refunded'; paymentId: string };

// The single place where money is recorded and a paid subscription changes.
// A real gateway's webhooks will translate into these same events.
export async function applyPaymentEvent(tx: Tx, e: PaymentEvent, now: Date){
  switch (e.type){
    case 'checkout.paid': {
      const [c] = await tx.select().from(checkouts).where(eq(checkouts.id, e.checkoutId)).for('update');
      if (!c || c.status !== 'open') throw new ApiError(409, 'checkout_closed', 'This checkout is no longer open');
      if (c.expiresAt <= now) throw new ApiError(409, 'checkout_expired', 'This checkout has expired. Start again from the pricing page.');
      const sub = await lockSub(tx, c.workspaceId);
      const q = c.quote as Quote & { basedOn: number };
      if (sub.version !== q.basedOn) throw new ApiError(409, 'quote_stale', 'Your plan changed after this checkout started. Start again.');
      const next = revive<Partial<SubState>>(q.next as Record<string, unknown>);
      const payment = await recordPayment(tx, {
        workspaceId: c.workspaceId, kind: 'checkout', amountCents: q.totalCents, lines: q.lines, card: e.card,
        periodStart: next.currentPeriodStart ?? sub.currentPeriodStart, periodEnd: next.currentPeriodEnd ?? sub.currentPeriodEnd, previous: sub, now
      });
      await tx.update(checkouts).set({ status: 'paid' }).where(eq(checkouts.id, c.id));
      return { payment, subscription: await writeSub(tx, c.workspaceId, next, now) };
    }
    case 'renewal.paid': {
      const sub = await lockSub(tx, e.workspaceId);
      const s = toState(sub);
      const plan = s.scheduledPlan ?? (s.plan as PaidPlan);
      const period = s.scheduledPeriod ?? (s.period as Period);
      const start = s.currentPeriodEnd!, end = addPeriod(start, period);
      const lines: QuoteLine[] = [
        { kind: 'plan', plan, period, amountCents: PLANS[plan].price[period] },
        ...(s.addonPacks ? [{ kind: 'addon' as const, period, quantity: s.addonPacks, prorated: false, amountCents: s.addonPacks * ADDON.price[period] }] : [])
      ];
      const payment = await recordPayment(tx, {
        workspaceId: e.workspaceId, kind: 'renewal', amountCents: cyclePrice(plan, period, s.addonPacks), lines, card: null,
        periodStart: start, periodEnd: end, previous: sub, now
      });
      const subscription = await writeSub(tx, e.workspaceId, { plan, period, currentPeriodStart: start, currentPeriodEnd: end, scheduledPlan: null, scheduledPeriod: null }, now);
      return { payment, subscription };
    }
    case 'payment.refunded': {
      const [p] = await tx.select().from(payments).where(eq(payments.id, e.paymentId)).for('update');
      if (!p) throw notFound('Payment');
      if (p.status !== 'paid') throw new ApiError(409, 'already_refunded', 'This payment was already refunded');
      if (now.getTime() - p.createdAt.getTime() > REFUND_DAYS * DAY) throw new ApiError(409, 'refund_window_passed', `Refunds are available for ${REFUND_DAYS} days after payment`);
      if (await latestPaidId(tx, p.workspaceId) !== p.id) throw new ApiError(409, 'refund_latest_only', 'Only the most recent payment can be refunded');
      await lockSub(tx, p.workspaceId);
      const prev = revive<SubState>(p.previous as Record<string, unknown>);
      // A previous state that has already run out cannot come back; the workspace falls to Free instead.
      const ranOut = (prev.status === 'trialing' && prev.trialEndsAt! <= now) || (isPaid(prev) && prev.currentPeriodEnd! <= now);
      const { trialUsed: _keep, ...restore } = ranOut ? { ...FREE, trialUsed: true } : prev;
      const [payment] = await tx.update(payments).set({ status: 'refunded', refundedAt: now }).where(eq(payments.id, p.id)).returning();
      return { payment, subscription: await writeSub(tx, p.workspaceId, restore, now) };
    }
  }
}

export async function latestPaidId(db: Db | Tx, workspaceId: string){
  const [row] = await db.select({ id: payments.id }).from(payments)
    .where(and(eq(payments.workspaceId, workspaceId), eq(payments.status, 'paid'))).orderBy(desc(payments.createdAt)).limit(1);
  return row?.id ?? null;
}

const CHECKOUT_TTL = 30 * 60_000;

// Starts a checkout, or applies the change straight away when nothing is due (downgrades, fewer packs).
export async function startCheckout(db: Db, a: { workspaceId: string; userId: string; req: ChangeRequest; now: Date }){
  return db.transaction(async tx => {
    const sub = await lockSub(tx, a.workspaceId);
    const q = quote(toState(sub), a.req, a.now);
    if (q.totalCents === 0) return { quote: q, subscription: await writeSub(tx, a.workspaceId, q.next, a.now), checkoutId: null };
    const [c] = await tx.insert(checkouts).values({
      workspaceId: a.workspaceId, userId: a.userId, quote: { ...q, basedOn: sub.version },
      expiresAt: new Date(a.now.getTime() + CHECKOUT_TTL)
    }).returning();
    return { quote: q, subscription: sub, checkoutId: c.id };
  });
}

export async function payCheckout(db: Db, a: { checkoutId: string; userId: string; card: Card; now: Date }){
  return db.transaction(async tx => {
    const [c] = await tx.select().from(checkouts).where(eq(checkouts.id, a.checkoutId));
    if (!c || c.userId !== a.userId) throw notFound('Checkout');
    if (c.status !== 'open') throw new ApiError(409, 'checkout_closed', 'This checkout is no longer open');
    if (c.expiresAt <= a.now) throw new ApiError(409, 'checkout_expired', 'This checkout has expired. Start again from the pricing page.');
    const card = chargeCard(a.card, a.now);
    return applyPaymentEvent(tx, { type: 'checkout.paid', checkoutId: c.id, card }, a.now);
  });
}

export async function refundPayment(db: Db, paymentId: string, now: Date){
  return db.transaction(tx => applyPaymentEvent(tx, { type: 'payment.refunded', paymentId }, now));
}

export async function startTrial(db: Db, workspaceId: string, now: Date){
  return db.transaction(async tx => {
    const s = toState(await lockSub(tx, workspaceId));
    if (s.plan !== 'free') throw new ApiError(409, 'already_subscribed', 'This workspace already has a plan');
    if (s.trialUsed) throw new ApiError(409, 'trial_used', 'The free trial has already been used for this workspace');
    return writeSub(tx, workspaceId, { plan: 'studio', status: 'trialing', trialUsed: true, trialEndsAt: addDays(now, TRIAL_DAYS) }, now);
  });
}

export async function setCancel(db: Db, workspaceId: string, cancel: boolean, now: Date){
  return db.transaction(async tx => {
    if (!isPaid(toState(await lockSub(tx, workspaceId)))) throw new ApiError(409, 'not_subscribed', 'This workspace has no paid plan');
    return writeSub(tx, workspaceId, { cancelAtPeriodEnd: cancel, scheduledPlan: null, scheduledPeriod: null }, now);
  });
}

// Ends trials, applies cancellations, and renews due periods. Renewals need a payment gateway, so they only run with mock payments on.
export async function processDue(db: Db, now: Date, { renew }: { renew: boolean }){
  const due = await db.select({ id: subscriptions.workspaceId }).from(subscriptions).where(or(
    and(eq(subscriptions.status, 'trialing'), lte(subscriptions.trialEndsAt, now)),
    and(eq(subscriptions.status, 'active'), ne(subscriptions.plan, 'free'), lte(subscriptions.currentPeriodEnd, now))
  )).limit(200);
  for (const { id } of due){
    await db.transaction(async tx => {
      const s = toState(await lockSub(tx, id));
      if (s.status === 'trialing'){ if (s.trialEndsAt! <= now) await writeSub(tx, id, FREE, now); return; }
      if (!isPaid(s) || s.currentPeriodEnd! > now) return;
      if (s.cancelAtPeriodEnd) await writeSub(tx, id, FREE, now);
      else if (renew) await applyPaymentEvent(tx, { type: 'renewal.paid', workspaceId: id }, now);
    });
  }
  return due.length;
}
