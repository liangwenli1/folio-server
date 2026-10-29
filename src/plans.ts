import { ApiError } from './errors.js';

export type PlanId = 'free' | 'studio' | 'company';
export type PaidPlan = Exclude<PlanId, 'free'>;
export type Period = 'monthly' | 'yearly';

// Prices in US cents. Yearly is 20% off (12 months x 0.8).
export const PLANS = {
  free: { rank: 0, profiles: 5, members: 1, logDays: 7, price: { monthly: 0, yearly: 0 } },
  studio: { rank: 1, profiles: 100, members: null, logDays: 30, price: { monthly: 2900, yearly: 27600 } },
  company: { rank: 2, profiles: 500, members: null, logDays: 365, price: { monthly: 9900, yearly: 94800 } }
} as const satisfies Record<PlanId, { rank: number; profiles: number; members: number | null; logDays: number; price: Record<Period, number> }>;

export const ADDON = { profiles: 100, price: { monthly: 1500, yearly: 14400 } } as const;
export const MAX_PROFILES = 2000;
export const TRIAL_DAYS = 7;
export const REFUND_DAYS = 7;
export const DAY = 86_400_000;

export interface SubState {
  plan: PlanId;
  period: Period | null;
  status: 'active' | 'trialing';
  addonPacks: number;
  trialEndsAt: Date | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  scheduledPlan: PaidPlan | null;
  scheduledPeriod: Period | null;
}

export const FREE: SubState = {
  plan: 'free', period: null, status: 'active', addonPacks: 0, trialEndsAt: null,
  currentPeriodStart: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, scheduledPlan: null, scheduledPeriod: null
};

export const isPaid = (s: SubState) => s.status === 'active' && s.plan !== 'free';

export function entitlements(s: SubState){
  const p = PLANS[s.plan];
  return { profiles: p.profiles + (isPaid(s) ? s.addonPacks * ADDON.profiles : 0), members: p.members, logDays: p.logDays };
}

// Calendar month/year, clamped so Jan 31 + 1 month is Feb 28/29, not Mar 3.
export function addPeriod(d: Date, period: Period){
  const months = period === 'monthly' ? 1 : 12;
  const r = new Date(d);
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export const addDays = (d: Date, days: number) => new Date(d.getTime() + days * DAY);
export const cyclePrice = (plan: PaidPlan, period: Period, packs: number) => PLANS[plan].price[period] + packs * ADDON.price[period];

export type QuoteLine =
  | { kind: 'plan'; plan: PaidPlan; period: Period; amountCents: number }
  | { kind: 'addon'; period: Period; quantity: number; prorated: boolean; amountCents: number }
  | { kind: 'credit'; plan: PaidPlan; period: Period; amountCents: number };

export interface Quote {
  change: 'new' | 'upgrade' | 'addon' | 'reduce-addon' | 'downgrade';
  effective: 'now' | 'period_end';
  lines: QuoteLine[];
  totalCents: number;
  // Subscription fields to write once paid (or right away when nothing is due).
  next: Partial<SubState>;
}

export interface ChangeRequest { plan: PaidPlan; period: Period; addonPacks: number }

export function quote(s: SubState, req: ChangeRequest, now: Date): Quote {
  if (PLANS[req.plan].profiles + req.addonPacks * ADDON.profiles > MAX_PROFILES){
    throw new ApiError(400, 'profile_cap', `Plans go up to ${MAX_PROFILES} profiles; contact sales for more`);
  }
  const fullCycle = (): Pick<Quote, 'lines' | 'next'> => ({
    lines: [
      { kind: 'plan', plan: req.plan, period: req.period, amountCents: PLANS[req.plan].price[req.period] },
      ...(req.addonPacks ? [{ kind: 'addon' as const, period: req.period, quantity: req.addonPacks, prorated: false, amountCents: req.addonPacks * ADDON.price[req.period] }] : [])
    ],
    next: { ...FREE, plan: req.plan, period: req.period, addonPacks: req.addonPacks, currentPeriodStart: now, currentPeriodEnd: addPeriod(now, req.period) }
  });

  if (!isPaid(s)){
    const c = fullCycle();
    return { change: 'new', effective: 'now', ...c, totalCents: cyclePrice(req.plan, req.period, req.addonPacks) };
  }

  const plan = s.plan as PaidPlan, period = s.period as Period;
  const start = s.currentPeriodStart!.getTime(), end = s.currentPeriodEnd!.getTime();
  const remaining = Math.min(1, Math.max(0, (end - now.getTime()) / (end - start)));

  if (req.plan === plan && req.period === period){
    if (req.addonPacks === s.addonPacks) throw new ApiError(400, 'no_change', 'This is already your plan');
    if (req.addonPacks < s.addonPacks){
      return { change: 'reduce-addon', effective: 'now', lines: [], totalCents: 0, next: { addonPacks: req.addonPacks } };
    }
    const qty = req.addonPacks - s.addonPacks;
    const amount = Math.round(qty * ADDON.price[period] * remaining);
    return { change: 'addon', effective: 'now', totalCents: amount, next: { addonPacks: req.addonPacks },
      lines: [{ kind: 'addon', period, quantity: qty, prorated: true, amountCents: amount }] };
  }

  const upgrade = PLANS[req.plan].rank > PLANS[plan].rank || (req.plan === plan && req.period === 'yearly');
  if (upgrade){
    const credit = Math.round(cyclePrice(plan, period, s.addonPacks) * remaining);
    const c = fullCycle();
    const total = Math.max(0, cyclePrice(req.plan, req.period, req.addonPacks) - credit);
    return { change: 'upgrade', effective: 'now', next: c.next, totalCents: total,
      lines: [...c.lines, ...(credit ? [{ kind: 'credit' as const, plan, period, amountCents: -credit }] : [])] };
  }

  if (req.addonPacks !== s.addonPacks){
    throw new ApiError(400, 'change_packs_separately', 'Change profile packs and downgrade the plan in two steps');
  }
  return { change: 'downgrade', effective: 'period_end', lines: [], totalCents: 0,
    next: { scheduledPlan: req.plan, scheduledPeriod: req.period, cancelAtPeriodEnd: false } };
}
