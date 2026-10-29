import { describe, expect, it } from 'vitest';
import { FREE, addPeriod, entitlements, quote, type SubState } from '../src/plans.js';

const now = new Date('2026-11-01T00:00:00Z');
const free: SubState = FREE;
const studioMonthly = (start: string, packs = 0): SubState => ({
  ...free, plan: 'studio', period: 'monthly', addonPacks: packs,
  currentPeriodStart: new Date(start), currentPeriodEnd: addPeriod(new Date(start), 'monthly')
});

describe('addPeriod', () => {
  it('clamps month ends instead of rolling over', () => {
    expect(addPeriod(new Date('2026-01-31T12:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T12:00:00.000Z');
    expect(addPeriod(new Date('2028-02-29T00:00:00Z'), 'yearly').toISOString()).toBe('2029-02-28T00:00:00.000Z');
  });
});

describe('quote', () => {
  it('charges a full cycle for a new subscription', () => {
    const q = quote(free, { plan: 'studio', period: 'yearly', addonPacks: 2 }, now);
    expect(q.change).toBe('new');
    expect(q.totalCents).toBe(27600 + 2 * 14400);
    expect(q.next.currentPeriodEnd?.toISOString()).toBe('2027-11-01T00:00:00.000Z');
  });

  it('prorates extra profile packs for the rest of the period', () => {
    // Halfway through a 30-day November period.
    const q = quote(studioMonthly('2026-11-01T00:00:00Z'), { plan: 'studio', period: 'monthly', addonPacks: 2 }, new Date('2026-11-16T00:00:00Z'));
    expect(q.change).toBe('addon');
    expect(q.totalCents).toBe(1500);
    expect(q.next).toEqual({ addonPacks: 2 });
  });

  it('credits the unused part of the current plan on upgrade', () => {
    const q = quote(studioMonthly('2026-11-01T00:00:00Z'), { plan: 'company', period: 'monthly', addonPacks: 0 }, new Date('2026-11-16T00:00:00Z'));
    expect(q.change).toBe('upgrade');
    expect(q.lines.at(-1)).toMatchObject({ kind: 'credit', amountCents: -1450 });
    expect(q.totalCents).toBe(9900 - 1450);
  });

  it('schedules a downgrade for the end of the period at no charge', () => {
    const s = { ...studioMonthly('2026-11-01T00:00:00Z'), plan: 'company' as const };
    const q = quote(s, { plan: 'studio', period: 'monthly', addonPacks: 0 }, now);
    expect(q).toMatchObject({ change: 'downgrade', effective: 'period_end', totalCents: 0, next: { scheduledPlan: 'studio' } });
  });

  it('removes packs right away at no charge', () => {
    const q = quote(studioMonthly('2026-11-01T00:00:00Z', 3), { plan: 'studio', period: 'monthly', addonPacks: 1 }, now);
    expect(q).toMatchObject({ change: 'reduce-addon', totalCents: 0, next: { addonPacks: 1 } });
  });

  it('rejects no-ops, mixed downgrades and anything over 2000 profiles', () => {
    expect(() => quote(studioMonthly('2026-11-01T00:00:00Z'), { plan: 'studio', period: 'monthly', addonPacks: 0 }, now)).toThrow(/already your plan/);
    const company = { ...studioMonthly('2026-11-01T00:00:00Z', 1), plan: 'company' as const };
    expect(() => quote(company, { plan: 'studio', period: 'monthly', addonPacks: 0 }, now)).toThrow(/two steps/);
    expect(() => quote(free, { plan: 'company', period: 'monthly', addonPacks: 16 }, now)).toThrow(/2000 profiles/);
  });
});

describe('entitlements', () => {
  it('counts packs only on a paid plan', () => {
    expect(entitlements(studioMonthly('2026-11-01T00:00:00Z', 2)).profiles).toBe(300);
    expect(entitlements({ ...free, plan: 'studio', status: 'trialing', addonPacks: 2 }).profiles).toBe(100);
    expect(entitlements(free)).toEqual({ profiles: 5, members: 1, logDays: 7 });
  });
});
