import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GOOD_CARD, buy, login, setup, signup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

const sub = async (headers: Record<string, string>, id: string) => (await t.app.inject({ url: `/workspaces/${id}`, headers })).json().subscription;
const runDue = () => t.app.inject({ method: 'POST', url: '/dev/run-due', payload: {} });

describe('plans', () => {
  it('lists prices publicly', async () => {
    const res = await t.app.inject({ url: '/plans' });
    expect(res.json().plans.map((p: { id: string; price: { monthly: number } }) => [p.id, p.price.monthly])).toEqual([['free', 0], ['studio', 2900], ['company', 9900]]);
    expect(res.json().payments).toBe(true);
  });

  it('says when payments are off: paid changes are refused, the trial still starts', async () => {
    t.config.mockPayments = false;
    try {
      expect((await t.app.inject({ url: '/plans' })).json().payments).toBe(false);
      const { headers, workspaceId } = await signup(t.app);
      const paid = await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/checkout`, headers, payload: { plan: 'studio', period: 'monthly', addonPacks: 0 } });
      expect(paid.json().error.code).toBe('payments_unavailable');
      const trial = await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/trial`, headers });
      expect(trial.json().subscription).toMatchObject({ plan: 'studio', status: 'trialing' });
    } finally { t.config.mockPayments = true; }
  });
});

describe('checkout', () => {
  it('needs a verified email', async () => {
    const { headers, workspaceId } = await signup(t.app, { verify: false });
    const res = await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/checkout`, headers, payload: { plan: 'studio', period: 'monthly', addonPacks: 0 } });
    expect(res.json().error.code).toBe('email_not_verified');
  });

  it('activates Studio after a successful card payment', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const res = await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    expect(res.statusCode).toBe(200);
    expect(res.json().payment).toMatchObject({ amountCents: 2900, cardBrand: 'visa', cardLast4: '4242', status: 'paid', refundable: true });
    expect(res.json().payment.invoiceNumber).toMatch(/^FOLIO-2026-\d{6}$/);
    expect(await sub(headers, workspaceId)).toMatchObject({ plan: 'studio', period: 'monthly', status: 'active', entitlements: { profiles: 100, members: null } });
  });

  it('keeps the checkout open after a declined card', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const co = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/checkout`, headers, payload: { plan: 'company', period: 'yearly', addonPacks: 1 } })).json();
    expect(co.quote.totalCents).toBe(94800 + 14400);
    const declined = await t.app.inject({ method: 'POST', url: `/billing/checkouts/${co.checkoutId}/pay`, headers, payload: { card: { ...GOOD_CARD, number: '4000 0000 0000 0002' } } });
    expect(declined.statusCode).toBe(402);
    expect(declined.json().error.code).toBe('card_declined');
    expect((await sub(headers, workspaceId)).plan).toBe('free');
    const ok = await t.app.inject({ method: 'POST', url: `/billing/checkouts/${co.checkoutId}/pay`, headers, payload: { card: GOOD_CARD } });
    expect(ok.json().subscription.entitlements.profiles).toBe(600);
  });

  it('refuses to pay a checkout whose quote is out of date', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const first = (await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/checkout`, headers, payload: { plan: 'studio', period: 'monthly', addonPacks: 0 } })).json();
    await buy(t.app, headers, workspaceId, { plan: 'company', period: 'monthly', addonPacks: 0 });
    const stale = await t.app.inject({ method: 'POST', url: `/billing/checkouts/${first.checkoutId}/pay`, headers, payload: { card: GOOD_CARD } });
    expect(stale.json().error.code).toBe('quote_stale');
  });

  it('is only for owners and admins of that workspace', async () => {
    const a = await signup(t.app);
    const b = await signup(t.app);
    const res = await t.app.inject({ method: 'POST', url: `/workspaces/${a.workspaceId}/billing/checkout`, headers: b.headers, payload: { plan: 'studio', period: 'monthly', addonPacks: 0 } });
    expect(res.statusCode).toBe(404);
  });
});

describe('changing a paid plan', () => {
  it('charges prorated packs, credits an upgrade, and applies a downgrade at renewal', async () => {
    const { headers, workspaceId, email } = await signup(t.app);
    await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });

    t.clock.advanceDays(15);
    const packs = await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 1 });
    expect(packs.json().payment.amountCents).toBe(750);
    expect(packs.json().subscription.entitlements.profiles).toBe(200);

    const up = await buy(t.app, headers, workspaceId, { plan: 'company', period: 'monthly', addonPacks: 1 });
    expect(up.json().payment.lines.at(-1)).toMatchObject({ kind: 'credit', amountCents: -2200 });
    expect(up.json().payment.amountCents).toBe(9900 + 1500 - 2200);

    const down = await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/checkout`, headers, payload: { plan: 'studio', period: 'monthly', addonPacks: 1 } });
    expect(down.json()).toMatchObject({ checkoutId: null, quote: { change: 'downgrade' }, subscription: { plan: 'company', scheduledPlan: 'studio' } });

    t.clock.advanceDays(31);
    await runDue();
    const again = await login(t.app, email);
    expect(await sub(again, workspaceId)).toMatchObject({ plan: 'studio', scheduledPlan: null, entitlements: { profiles: 200 } });
    const payments = (await t.app.inject({ url: `/workspaces/${workspaceId}/payments`, headers: again })).json().payments;
    expect(payments[0]).toMatchObject({ kind: 'renewal', amountCents: 2900 + 1500 });
  });

  it('falls back to Free when a cancelled period ends', async () => {
    const { headers, workspaceId, email } = await signup(t.app);
    await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'yearly', addonPacks: 0 });
    const cancel = await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/cancel`, headers });
    expect(cancel.json().subscription.cancelAtPeriodEnd).toBe(true);
    t.clock.advanceDays(366);
    await runDue();
    expect(await sub(await login(t.app, email), workspaceId)).toMatchObject({ plan: 'free', period: null, entitlements: { profiles: 5 } });
  });
});

describe('trial', () => {
  it('gives Studio for seven days, once', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const res = await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/trial`, headers });
    expect(res.json().subscription).toMatchObject({ plan: 'studio', status: 'trialing', trialAvailable: false, entitlements: { profiles: 100 } });
    t.clock.advanceDays(8);
    await runDue();
    expect(await sub(headers, workspaceId)).toMatchObject({ plan: 'free', status: 'active', trialAvailable: false });
    const again = await t.app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/trial`, headers });
    expect(again.json().error.code).toBe('trial_used');
  });
});

describe('refunds', () => {
  it('undo the latest payment within seven days', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const paid = (await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 })).json().payment;
    t.clock.advanceDays(3);
    const res = await t.app.inject({ method: 'POST', url: `/payments/${paid.id}/refund`, headers });
    expect(res.json()).toMatchObject({ payment: { status: 'refunded', refundable: false }, subscription: { plan: 'free' } });
    const twice = await t.app.inject({ method: 'POST', url: `/payments/${paid.id}/refund`, headers });
    expect(twice.json().error.code).toBe('already_refunded');
  });

  it('restore the plan that was in place before an add-on', async () => {
    const { headers, workspaceId } = await signup(t.app);
    await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 0 });
    const addon = (await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'monthly', addonPacks: 2 })).json().payment;
    await t.app.inject({ method: 'POST', url: `/payments/${addon.id}/refund`, headers });
    expect(await sub(headers, workspaceId)).toMatchObject({ plan: 'studio', addonPacks: 0 });
  });

  it('close after seven days', async () => {
    const { headers, workspaceId } = await signup(t.app);
    const paid = (await buy(t.app, headers, workspaceId, { plan: 'studio', period: 'yearly', addonPacks: 0 })).json().payment;
    t.clock.advanceDays(8);
    const res = await t.app.inject({ method: 'POST', url: `/payments/${paid.id}/refund`, headers });
    expect(res.json().error.code).toBe('refund_window_passed');
    const invoice = (await t.app.inject({ url: `/payments/${paid.id}`, headers })).json();
    expect(invoice).toMatchObject({ payment: { refundable: false }, workspace: { id: workspaceId } });
  });
});
