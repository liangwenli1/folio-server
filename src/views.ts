// Response shapes. These zod schemas also produce the OpenAPI document the site and desktop generate types from.
import { z } from 'zod';
import { GROUP_COLORS, type extensions, type flows, type kernels, type profileData, type profileLocks, type profiles, type proxies, type users } from './db/schema.js';
import { entitlements } from './plans.js';
import { Step } from './flows/steps.js';
import { BUILT_IN_ROLES, PERMISSIONS } from './permissions.js';
import { toState, type PaymentRow, type SubRow } from './billing/service.js';

const iso = z.string().nullable();
const plan = z.enum(['free', 'studio', 'company']);
const paidPlan = z.enum(['studio', 'company']);
const period = z.enum(['monthly', 'yearly']);
// A role names a set of actions. The four a workspace starts with carry a `key`; its own roles have none and the
// apps show their stored name.
export const permission = z.enum(PERMISSIONS);
export const roleKey = z.enum(BUILT_IN_ROLES);
export const RoleRef = z.object({ id: z.string(), key: roleKey.nullable(), name: z.string() });
export const MyRole = RoleRef.extend({ permissions: z.array(permission) });
export const Role = MyRole.extend({ members: z.number() });
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

export const WorkspaceSummary = z.object({ id: z.string(), name: z.string(), role: MyRole, plan, status: z.enum(['active', 'trialing']) });
export const Workspace = z.object({
  id: z.string(), name: z.string(), role: MyRole, subscription: Subscription,
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
// Chromium's `canvas`/`webgl` 'real' and Firefox's `webrtc` 'block' are choices made in the app; left out, the defaults.
export const Fingerprint = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('chromium'), seed: z.number().int().min(1).max(2147483647), hardwareConcurrency: z.number().int().min(1).max(64),
    canvas: z.enum(['noise', 'real']).optional(), webgl: z.enum(['spoof', 'real']).optional()
  }),
  z.object({ kind: z.literal('firefox'), config: z.record(z.string(), z.unknown()), webrtc: z.enum(['replace', 'block']).optional() })
]);
export const kernel = z.enum(['chromium', 'firefox']);
export const os = z.enum(['windows', 'macos', 'linux']);
export const searchEngine = z.enum(['none', 'google', 'bing', 'baidu', 'duckduckgo', 'yahoo', 'yandex']);

// The latest saved sign-in state: counts for display, and which computer saved it.
export const SavedData = z.object({
  version: z.number(), size: z.number(), cookies: z.number(), storageBytes: z.number(), origins: z.number(), savedAt: z.string(), deviceName: z.string().nullable()
});
export const savedDataView = (d: typeof profileData.$inferSelect): z.infer<typeof SavedData> => ({
  version: d.version, size: d.size, cookies: d.cookies, storageBytes: d.storageBytes, origins: d.origins, savedAt: d.savedAt.toISOString(), deviceName: d.deviceName
});
// Who has the profile open right now; `self` is the session asking.
export const LockHolder = z.object({ email: z.string(), deviceName: z.string().nullable(), since: z.string(), self: z.boolean() });
// Where a profile went out from when it opened.
export const ProfileExit = z.object({ ip: z.string(), geo: Geo.nullable(), at: z.string() });
// What the self-check page found inside the profile's browser: each check with what it saw and what it should be,
// and fingerprints of its canvas and WebGL drawing (to find profiles that draw the same).
export const reportCheck = z.enum(['webrtc', 'timezone', 'language', 'ua', 'canvas', 'webgl']);
export const HealthReport = z.object({
  at: z.string(),
  checks: z.array(z.object({ id: reportCheck, ok: z.boolean(), seen: z.string().max(300), want: z.string().max(300).nullable() })).max(12),
  canvas: z.string().max(64).nullable(), webgl: z.string().max(64).nullable()
});

export const Profile = z.object({
  id: z.string(), workspaceId: z.string(), number: z.number(), name: z.string(), groupId: z.string().nullable(),
  ownerId: z.string().nullable(), departmentId: z.string().nullable(), tags: z.array(z.string()), kernel, kernelVersion: z.string(), os, fingerprint: Fingerprint, proxyId: z.string().nullable(),
  timezoneOverride: z.string().nullable(), localeOverride: z.string().nullable(), notes: z.string().nullable(), searchEngine, restoreTabs: z.boolean(),
  lastOpenedAt: iso, lastOpenedBy: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), deletedAt: iso, deletedBy: z.string().nullable(), version: z.number(),
  syncMode: z.enum(['cloud', 'local']), extensionIds: z.array(z.string()), data: SavedData.nullable(), lock: LockHolder.nullable(),
  lastExit: ProfileExit.nullable(), prevExit: ProfileExit.nullable(), report: HealthReport.nullable(), starred: z.boolean()
});
type LockRow = typeof profileLocks.$inferSelect & { email: string };
// `starred`: the asker marked it as a favourite.
export function profileView(p: typeof profiles.$inferSelect, state: { data: typeof profileData.$inferSelect | null; lock: LockRow | null; sessionId: string; starred: boolean } | null = null): z.infer<typeof Profile> {
  const lock = state?.lock;
  return {
    id: p.id, workspaceId: p.workspaceId, number: p.number, name: p.name, groupId: p.groupId, ownerId: p.ownerId, departmentId: p.departmentId, tags: p.tags,
    kernel: p.kernel as 'chromium' | 'firefox', kernelVersion: p.kernelVersion, os: p.os as 'windows' | 'macos' | 'linux',
    fingerprint: p.fingerprint as z.infer<typeof Fingerprint>, proxyId: p.proxyId,
    timezoneOverride: p.timezoneOverride, localeOverride: p.localeOverride, notes: p.notes,
    searchEngine: p.searchEngine as z.infer<typeof searchEngine>, restoreTabs: p.restoreTabs,
    lastOpenedAt: p.lastOpenedAt?.toISOString() ?? null, lastOpenedBy: p.lastOpenedBy,
    createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(), deletedAt: p.deletedAt?.toISOString() ?? null, deletedBy: p.deletedBy, version: p.version,
    syncMode: p.syncMode as 'cloud' | 'local', extensionIds: p.extensionIds, data: state?.data ? savedDataView(state.data) : null,
    lock: lock ? { email: lock.email, deviceName: lock.deviceName, since: lock.acquiredAt.toISOString(), self: lock.sessionId === state.sessionId } : null,
    lastExit: p.lastExit as z.infer<typeof ProfileExit> | null, prevExit: p.prevExit as z.infer<typeof ProfileExit> | null,
    report: p.report as z.infer<typeof HealthReport> | null, starred: !!state?.starred
  };
}

export const groupColor = z.enum(GROUP_COLORS);
export const Group = z.object({ id: z.string(), name: z.string(), color: groupColor, profiles: z.number() });

export const proxyType = z.enum(['http', 'https', 'socks5']);
export const ProxyCheck = z.object({
  ok: z.boolean(), ms: z.number().nullable(), ip: z.string().nullable(), geo: Geo.nullable(), error: z.string().nullable(), checkedAt: z.string()
});
// `history`: the last 20 checks, oldest first; `lastExit`: where the last check that got through came out (so a line that
// is down now still has a place).
export const ProxyHistory = z.object({ at: z.string(), ok: z.boolean(), ms: z.number().nullable() });
export const ProxyExit = z.object({ ip: z.string().nullable(), geo: Geo.nullable(), at: z.string() });
export const Proxy = z.object({
  id: z.string(), name: z.string(), type: proxyType, host: z.string(), port: z.number(), username: z.string().nullable(),
  hasPassword: z.boolean(), backupId: z.string().nullable(), lastCheck: ProxyCheck.nullable(), history: z.array(ProxyHistory), lastExit: ProxyExit.nullable(),
  profiles: z.number(), createdAt: z.string(), updatedAt: z.string()
});
export function proxyView(p: typeof proxies.$inferSelect, profileCount: number): z.infer<typeof Proxy> {
  return {
    id: p.id, name: p.name, type: p.type as 'http' | 'https' | 'socks5', host: p.host, port: p.port, username: p.username,
    hasPassword: !!p.passwordEnc, backupId: p.backupId, lastCheck: (p.lastCheck as z.infer<typeof ProxyCheck> | null) ?? null,
    history: p.history as z.infer<typeof ProxyHistory>[], lastExit: (p.lastExit as z.infer<typeof ProxyExit> | null) ?? null, profiles: profileCount, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString()
  };
}
// Full connection details, including the password. Served only to the desktop app's main process.
export const ProxySecret = z.object({ id: z.string(), type: proxyType, host: z.string(), port: z.number(), username: z.string().nullable(), password: z.string().nullable() });

// ---------- team (P3) ----------
export const Member = z.object({
  userId: z.string(), email: z.string(), role: RoleRef, joinedAt: z.string(), departmentIds: z.array(z.string()), profiles: z.number()
});
export const Invitation = z.object({
  id: z.string(), email: z.string(), role: RoleRef, departmentIds: z.array(z.string()), invitedBy: z.string().nullable(), createdAt: z.string(), expiresAt: z.string()
});
// What the invitation link shows before anyone logs in, and what a person sees of invitations to their email.
export const InvitationPreview = z.object({
  id: z.string(), workspaceName: z.string(), inviter: z.string().nullable(), email: z.string(), role: RoleRef, expired: z.boolean(), expiresAt: z.string()
});
export const MyInvitation = z.object({
  id: z.string(), workspaceId: z.string(), workspaceName: z.string(), inviter: z.string().nullable(), role: RoleRef, expiresAt: z.string()
});
export const Department = z.object({ id: z.string(), name: z.string(), memberIds: z.array(z.string()), profiles: z.number() });

// ---------- automation (P4) ----------
// `canEdit`: the asker created it, or is an owner or admin.
export const Flow = z.object({
  id: z.string(), name: z.string(), steps: z.array(Step), version: z.number(), createdBy: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(), canEdit: z.boolean()
});
export const flowView = (f: typeof flows.$inferSelect, canEdit: boolean): z.infer<typeof Flow> => ({
  id: f.id, name: f.name, steps: f.steps as Step[], version: f.version, createdBy: f.createdBy,
  createdAt: f.createdAt.toISOString(), updatedAt: f.updatedAt.toISOString(), canEdit
});

// `missed`: a scheduled time that passed while its computer was off, asleep or logged out; `busy`: a scheduled time
// that came while the last run was still going. Nothing ran for either.
export const runStatus = z.enum(['running', 'done', 'stopped', 'interrupted', 'missed', 'busy']);
export const itemStatus = z.enum(['pending', 'running', 'ok', 'failed', 'signed_out', 'skipped', 'canceled']);
export const RunError = z.object({ code: z.string().max(40), message: z.string().max(500) });
// A line of a run's log, as the desktop's flow runner writes it, with the attempt it belongs to.
export const LogLine = z.object({
  attempt: z.number().int().min(1).max(4), path: z.string().max(40), type: z.string().max(20), target: z.string().max(300),
  ms: z.number().int().nullable(), value: z.string().max(200).optional(), error: RunError.optional()
});
const counts = z.object(Object.fromEntries(itemStatus.options.map(s => [s, z.number()])) as Record<z.infer<typeof itemStatus>, z.ZodNumber>);
export const Run = z.object({
  id: z.string(), taskId: z.string(), trigger: z.enum(['manual', 'rerun', 'schedule']), status: runStatus, flowVersion: z.number(),
  startedBy: z.string().nullable(), deviceName: z.string().nullable(), scheduledFor: iso, startedAt: z.string(), finishedAt: iso, counts
});
// When a task runs by itself, in the local time of the computer it runs on (`tz` is that computer's time zone,
// for showing the time to others). `days` are ISO weekdays, Monday = 1.
export const Schedule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }), tz: z.string().max(64) }),
  z.object({ kind: z.literal('daily'), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), days: z.array(z.number().int().min(1).max(7)).min(1).max(7), tz: z.string().max(64) })
]).meta({ id: 'Schedule' });
export const RunItem = z.object({
  profileId: z.string().nullable(), profileName: z.string(), profileNumber: z.number(), status: itemStatus, attempts: z.number(),
  startedAt: iso, finishedAt: iso, error: RunError.nullable(), log: z.array(LogLine), data: z.record(z.string(), z.string()), screenshots: z.array(z.string())
});
// `profileIds` lists the ones the asker sees; `profiles` counts them all. `runner` is the computer a scheduled task
// runs on (`self` when it is the asker's).
export const Task = z.object({
  id: z.string(), name: z.string(), flowId: z.string(), profileIds: z.array(z.string()), profiles: z.number(),
  concurrency: z.number(), retries: z.number(), timeoutMin: z.number(), hasVariables: z.boolean(),
  schedule: Schedule.nullable(), runner: z.object({ email: z.string().nullable(), deviceName: z.string().nullable(), self: z.boolean() }).nullable(),
  createdBy: z.string().nullable(), canEdit: z.boolean(), version: z.number(), createdAt: z.string(), updatedAt: z.string(), lastRun: Run.nullable()
});

// ---------- extensions (P5) ----------
// `publicKey` (Chromium) goes into the unpacked manifest so the extension id is the same everywhere; `signature` is
// checked by the desktop app before installing; `profiles` counts the profiles it is installed in.
export const Extension = z.object({
  id: z.string(), name: z.string(), kernel, version: z.string(), extId: z.string(), publicKey: z.string().nullable(), sha256: z.string(), size: z.number(),
  signature: z.string(), source: z.enum(['upload', 'store']), storeId: z.string().nullable(), icon: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(), profiles: z.number()
});
export const extensionView = (e: typeof extensions.$inferSelect, profiles: number): z.infer<typeof Extension> => ({
  id: e.id, name: e.name, kernel: e.kernel as 'chromium' | 'firefox', version: e.version, extId: e.extId, publicKey: e.publicKey, sha256: e.sha256, size: e.size,
  signature: e.signature, source: e.source as 'upload' | 'store', storeId: e.storeId, icon: e.icon, createdAt: e.createdAt.toISOString(), updatedAt: e.updatedAt.toISOString(), profiles
});

// ---------- browser engines (P6) ----------
export const platform = z.enum(['win32-x64', 'darwin-arm64', 'darwin-x64', 'linux-x64']);
export const archive = z.enum(['zip', 'tar.xz', 'dmg']);
// `source`: an upstream release or a package uploaded to Folio. `ready` is false while an upload is unfinished (only
// admins see those); `profiles` counts the profiles on that version across every workspace, for admins only.
// `recommendedAt` and `note` make the engines page's history: when it was added, when it became the recommended one.
export const Kernel = z.object({
  id: z.string(), kind: kernel, version: z.string(), platform, archive, size: z.number(), sha256: z.string(), recommended: z.boolean(),
  source: z.enum(['upstream', 'folio']), ready: z.boolean(), createdAt: z.string(), recommendedAt: z.string().nullable(), note: z.string().nullable(),
  profiles: z.number().nullable()
});
export const kernelView = (k: typeof kernels.$inferSelect, profiles: number | null): z.infer<typeof Kernel> => ({
  id: k.id, kind: k.kind as 'chromium' | 'firefox', version: k.version, platform: k.platform as z.infer<typeof platform>, archive: k.archive as z.infer<typeof archive>,
  size: k.size, sha256: k.sha256, recommended: k.recommended, source: k.objectKey ? 'folio' : 'upstream', ready: k.ready, createdAt: k.createdAt.toISOString(),
  recommendedAt: k.recommendedAt?.toISOString() ?? null, note: k.note, profiles
});
