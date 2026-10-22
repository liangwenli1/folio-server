// Response shapes. These zod schemas also produce the OpenAPI document the site and desktop generate types from.
import { z } from 'zod';
import type { profileData, profileLocks, profiles, proxies, users } from './db/schema.js';
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

// ---------- profiles, groups, proxies (P2) ----------
export const Geo = z.object({
  country: z.string(), countryName: z.string(), region: z.string().nullable(), city: z.string().nullable(),
  lat: z.number(), lon: z.number(), timezone: z.string(), locale: z.string()
});

// Chromium profiles store the seed that drives the engine's fingerprint; Firefox profiles store the full
// Camoufox config, because Camoufox draws a new identity on every launch unless it is given one.
export const Fingerprint = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('chromium'), seed: z.number().int().min(1).max(2147483647), hardwareConcurrency: z.number().int().min(1).max(64) }),
  z.object({ kind: z.literal('firefox'), config: z.record(z.string(), z.unknown()) })
]);
export const kernel = z.enum(['chromium', 'firefox']);
export const os = z.enum(['windows', 'macos', 'linux']);

// The latest saved sign-in state: counts for display, and which computer saved it.
export const SavedData = z.object({
  version: z.number(), size: z.number(), cookies: z.number(), storageBytes: z.number(), origins: z.number(), savedAt: z.string(), deviceName: z.string().nullable()
});
export const savedDataView = (d: typeof profileData.$inferSelect): z.infer<typeof SavedData> => ({
  version: d.version, size: d.size, cookies: d.cookies, storageBytes: d.storageBytes, origins: d.origins, savedAt: d.savedAt.toISOString(), deviceName: d.deviceName
});
// Who has the profile open right now; `self` is the session asking.
export const LockHolder = z.object({ email: z.string(), deviceName: z.string().nullable(), since: z.string(), self: z.boolean() });

export const Profile = z.object({
  id: z.string(), number: z.number(), name: z.string(), groupId: z.string().nullable(), ownerId: z.string().nullable(),
  tags: z.array(z.string()), kernel, kernelVersion: z.string(), os, fingerprint: Fingerprint, proxyId: z.string().nullable(),
  timezoneOverride: z.string().nullable(), localeOverride: z.string().nullable(), notes: z.string().nullable(),
  lastOpenedAt: iso, lastOpenedBy: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), deletedAt: iso, version: z.number(),
  data: SavedData.nullable(), lock: LockHolder.nullable()
});
type LockRow = typeof profileLocks.$inferSelect & { email: string };
export function profileView(p: typeof profiles.$inferSelect, state: { data: typeof profileData.$inferSelect | null; lock: LockRow | null; sessionId: string } | null = null): z.infer<typeof Profile> {
  const lock = state?.lock;
  return {
    id: p.id, number: p.number, name: p.name, groupId: p.groupId, ownerId: p.ownerId, tags: p.tags,
    kernel: p.kernel as 'chromium' | 'firefox', kernelVersion: p.kernelVersion, os: p.os as 'windows' | 'macos' | 'linux',
    fingerprint: p.fingerprint as z.infer<typeof Fingerprint>, proxyId: p.proxyId,
    timezoneOverride: p.timezoneOverride, localeOverride: p.localeOverride, notes: p.notes,
    lastOpenedAt: p.lastOpenedAt?.toISOString() ?? null, lastOpenedBy: p.lastOpenedBy,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), deletedAt: p.deletedAt?.toISOString() ?? null, version: p.version,
    data: state?.data ? savedDataView(state.data) : null,
    lock: lock ? { email: lock.email, deviceName: lock.deviceName, since: lock.acquiredAt.toISOString(), self: lock.sessionId === state.sessionId } : null
  };
}

export const Group = z.object({ id: z.string(), name: z.string(), profiles: z.number() });

export const proxyType = z.enum(['http', 'https', 'socks5']);
export const ProxyCheck = z.object({
  ok: z.boolean(), ms: z.number().nullable(), ip: z.string().nullable(), geo: Geo.nullable(), error: z.string().nullable(), checkedAt: z.string()
});
export const Proxy = z.object({
  id: z.string(), name: z.string(), type: proxyType, host: z.string(), port: z.number(), username: z.string().nullable(),
  hasPassword: z.boolean(), backupId: z.string().nullable(), lastCheck: ProxyCheck.nullable(), profiles: z.number(),
  createdAt: z.string(), updatedAt: z.string()
});
export function proxyView(p: typeof proxies.$inferSelect, profileCount: number): z.infer<typeof Proxy> {
  return {
    id: p.id, name: p.name, type: p.type as 'http' | 'https' | 'socks5', host: p.host, port: p.port, username: p.username,
    hasPassword: !!p.passwordEnc, backupId: p.backupId, lastCheck: (p.lastCheck as z.infer<typeof ProxyCheck> | null) ?? null,
    profiles: profileCount, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString()
  };
}
// Full connection details, including the password. Served only to the desktop app's main process.
export const ProxySecret = z.object({ id: z.string(), type: proxyType, host: z.string(), port: z.number(), username: z.string().nullable(), password: z.string().nullable() });
