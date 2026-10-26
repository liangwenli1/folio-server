import { pgTable, pgSequence, uuid, text, timestamp, integer, bigint, bigserial, boolean, jsonb, primaryKey, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';

const ts = () => timestamp({ withTimezone: true });
const createdAt = () => ts().notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  email: text().notNull().unique(),
  passwordHash: text().notNull(),
  emailVerifiedAt: ts(),
  locale: text().notNull().default('en'),
  createdAt: createdAt()
});

// One-time codes sent by email: verify the address, or reset the password.
export const emailCodes = pgTable('email_codes', {
  id: uuid().primaryKey().defaultRandom(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  purpose: text().notNull(),
  codeHash: text().notNull(),
  attempts: integer().notNull().default(0),
  expiresAt: ts().notNull(),
  usedAt: ts(),
  createdAt: createdAt()
}, t => [index().on(t.userId, t.purpose)]);

// Opaque session tokens; only the sha256 is stored. Web uses a cookie, desktop a bearer header.
export const sessions = pgTable('sessions', {
  id: uuid().primaryKey().defaultRandom(),
  tokenHash: text().notNull().unique(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  client: text().notNull(),
  deviceName: text(),
  // The desktop app's install id, so scheduled tasks know which computer is theirs.
  deviceId: text(),
  createdAt: createdAt(),
  lastUsedAt: ts().notNull().defaultNow(),
  expiresAt: ts().notNull(),
  revokedAt: ts()
});

export const workspaces = pgTable('workspaces', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  // Last profile number handed out; profiles show as #0001, #0002, ... within a workspace.
  profileSeq: integer().notNull().default(0),
  createdAt: createdAt()
});

// A set of actions (see permissions.ts). Every workspace gets the four built-in roles, which carry a `key`; roles a
// workspace makes for itself have none. The owner's role always holds every permission and cannot be changed.
export const roles = pgTable('roles', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  key: text(),
  name: text().notNull(),
  permissions: text().array().notNull().default([]),
  createdAt: createdAt()
}, t => [index().on(t.workspaceId), uniqueIndex().on(t.workspaceId, t.name)]);

export const memberships = pgTable('memberships', {
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid().notNull().references(() => roles.id, { onDelete: 'restrict' }),
  createdAt: createdAt()
}, t => [primaryKey({ columns: [t.workspaceId, t.userId] }), index().on(t.userId), index().on(t.roleId)]);

// The subscription belongs to the workspace. Every change goes through billing/service.ts.
export const subscriptions = pgTable('subscriptions', {
  workspaceId: uuid().primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  plan: text().notNull().default('free'),
  period: text(),
  status: text().notNull().default('active'),
  addonPacks: integer().notNull().default(0),
  trialUsed: boolean().notNull().default(false),
  trialEndsAt: ts(),
  currentPeriodStart: ts(),
  currentPeriodEnd: ts(),
  cancelAtPeriodEnd: boolean().notNull().default(false),
  scheduledPlan: text(),
  scheduledPeriod: text(),
  // Bumped on every change; a checkout records the version its quote was based on.
  version: integer().notNull().default(0),
  updatedAt: ts().notNull().defaultNow()
});

export const checkouts = pgTable('checkouts', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  quote: jsonb().notNull(),
  status: text().notNull().default('open'),
  createdAt: createdAt(),
  expiresAt: ts().notNull()
});

export const invoiceSeq = pgSequence('invoice_seq');

// A payment doubles as its invoice. `previous` is the subscription before this payment, used to undo it on refund.
export const payments = pgTable('payments', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  invoiceNumber: text().notNull().unique(),
  kind: text().notNull(),
  amountCents: integer().notNull(),
  currency: text().notNull().default('usd'),
  lines: jsonb().notNull(),
  cardBrand: text(),
  cardLast4: text(),
  status: text().notNull().default('paid'),
  periodStart: ts(),
  periodEnd: ts(),
  previous: jsonb().notNull(),
  createdAt: createdAt(),
  refundedAt: ts()
}, t => [index().on(t.workspaceId, t.createdAt)]);

export const salesInquiries = pgTable('sales_inquiries', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  email: text().notNull(),
  company: text(),
  teamSize: text(),
  message: text().notNull(),
  locale: text().notNull(),
  createdAt: createdAt()
});

// The colours a group can have in the app.
export const GROUP_COLORS = ['red', 'blue', 'green', 'amber', 'purple', 'teal', 'gray'] as const;
export const groups = pgTable('groups', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  color: text({ enum: GROUP_COLORS }).notNull().default('gray'),
  createdAt: createdAt()
}, t => [uniqueIndex().on(t.workspaceId, t.name)]);

// Passwords are encrypted with SECRET_KEY (see crypto.ts). `backupId` is the line to fall back to. `history` keeps the
// last 20 checks ({ at, ok, ms }); `lastExit` is where the last check that got through came out ({ ip, geo, at }).
export const proxies = pgTable('proxies', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  type: text().notNull(),
  host: text().notNull(),
  port: integer().notNull(),
  username: text(),
  passwordEnc: text(),
  backupId: uuid().references((): AnyPgColumn => proxies.id, { onDelete: 'set null' }),
  lastCheck: jsonb(),
  history: jsonb().notNull().default([]),
  lastExit: jsonb(),
  createdAt: createdAt(),
  updatedAt: ts().notNull().defaultNow()
}, t => [index().on(t.workspaceId)]);

// Profiles in the trash have `deletedAt` set and do not count toward the plan.
export const profiles = pgTable('profiles', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  number: integer().notNull(),
  name: text().notNull(),
  groupId: uuid().references(() => groups.id, { onDelete: 'set null' }),
  // The person it is assigned to. Members see only their own profiles (and, on Company, their departments').
  ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
  departmentId: uuid().references((): AnyPgColumn => departments.id, { onDelete: 'set null' }),
  tags: text().array().notNull().default([]),
  kernel: text().notNull(),
  kernelVersion: text().notNull(),
  os: text().notNull(),
  fingerprint: jsonb().notNull(),
  proxyId: uuid().references(() => proxies.id, { onDelete: 'set null' }),
  timezoneOverride: text(),
  localeOverride: text(),
  notes: text(),
  // The address bar's search engine ('none' keeps the engine's own: none), and whether opening it brings back the tabs
  // it was closed with.
  searchEngine: text().notNull().default('none'),
  restoreTabs: boolean().notNull().default(true),
  // 'cloud': sign-in state is saved to Folio and follows the profile; 'local': it stays on the computer that uses it.
  syncMode: text().notNull().default('cloud'),
  // Extensions from the workspace's library installed in this profile.
  extensionIds: uuid().array().notNull().default([]),
  lastOpenedAt: ts(),
  lastOpenedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  // Where it went out from the last two times it was opened with a different exit IP ({ ip, geo, at }), for the warnings
  // about profiles that look related or moved; and its latest health report from the self-check page.
  lastExit: jsonb(),
  prevExit: jsonb(),
  report: jsonb(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: ts().notNull().defaultNow(),
  deletedAt: ts(),
  // Who moved it to the trash.
  deletedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  version: integer().notNull().default(0)
}, t => [uniqueIndex().on(t.workspaceId, t.number), index().on(t.workspaceId, t.deletedAt)]);

// The profiles each person marked as favourites; they come first in that person's lists.
export const profileStars = pgTable('profile_stars', {
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  profileId: uuid().notNull().references(() => profiles.id, { onDelete: 'cascade' }),
  createdAt: createdAt()
}, t => [primaryKey({ columns: [t.userId, t.profileId] })]);

// The latest saved sign-in state of a profile (cookies, local storage, IndexedDB): a sealed object in object
// storage, written only by the session that holds the profile's lock.
export const profileData = pgTable('profile_data', {
  profileId: uuid().primaryKey().references(() => profiles.id, { onDelete: 'cascade' }),
  version: integer().notNull(),
  objectKey: text().notNull(),
  sha256: text().notNull(),
  size: integer().notNull(),
  cookies: integer().notNull(),
  storageBytes: integer().notNull(),
  origins: integer().notNull(),
  savedAt: ts().notNull(),
  savedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  deviceName: text()
});

// The session that has a profile open. Renewed while the browser runs; a row past expiresAt counts as free.
export const profileLocks = pgTable('profile_locks', {
  profileId: uuid().primaryKey().references(() => profiles.id, { onDelete: 'cascade' }),
  sessionId: uuid().notNull().references(() => sessions.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceName: text(),
  acquiredAt: ts().notNull(),
  expiresAt: ts().notNull()
});

// An invitation to a workspace, sent by email. Only the token's sha256 is stored; accepting needs a session
// whose verified email matches.
export const invitations = pgTable('invitations', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  email: text().notNull(),
  roleId: uuid().notNull().references(() => roles.id, { onDelete: 'cascade' }),
  departmentIds: uuid().array().notNull().default([]),
  tokenHash: text().notNull().unique(),
  invitedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  expiresAt: ts().notNull(),
  acceptedAt: ts(),
  revokedAt: ts()
}, t => [index().on(t.workspaceId), index().on(t.email)]);

// Company plan: departments scope which profiles their members see.
export const departments = pgTable('departments', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  createdAt: createdAt()
}, t => [uniqueIndex().on(t.workspaceId, t.name)]);

export const departmentMembers = pgTable('department_members', {
  departmentId: uuid().notNull().references(() => departments.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' })
}, t => [primaryKey({ columns: [t.departmentId, t.userId] }), index().on(t.userId)]);

// A browser extension in the workspace's library. Its package (the zip, without a crx header) is sealed in object
// storage; `signature` is the server's Ed25519 signature over its identity and sha256, which the desktop app checks
// before installing it. Chromium extensions get a key of the library's own (`publicKey`), so their id (`extId`) is the
// same on every computer and their data can follow the profile; Firefox ones keep their add-on id. `icon` is the
// package's own icon as a data URL, when it has a small enough one.
export const extensions = pgTable('extensions', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  kernel: text().notNull(),
  version: text().notNull(),
  extId: text().notNull(),
  publicKey: text(),
  sha256: text().notNull(),
  size: integer().notNull(),
  objectKey: text().notNull(),
  signature: text().notNull(),
  source: text().notNull(),
  storeId: text(),
  icon: text(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: ts().notNull().defaultNow()
}, t => [index().on(t.workspaceId), uniqueIndex().on(t.workspaceId, t.kernel, t.extId)]);

// An automation flow: a list of steps (see flows/steps.ts), shared by the workspace. Anyone may create one; its
// creator, admins and the owner may change it.
export const flows = pgTable('flows', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  steps: jsonb().notNull(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: ts().notNull().defaultNow(),
  version: integer().notNull().default(0)
}, t => [index().on(t.workspaceId)]);

// A flow to run on a set of profiles. `variablesEnc` is per-profile values ({ profileId: { name: value } }) sealed
// with SECRET_KEY, since they may hold passwords. A flow used by a task cannot be deleted. A scheduled task runs on
// one computer (`runner*`); `scheduleSince` is when its schedule or computer last changed, so times before it are
// never counted as missed.
export const tasks = pgTable('tasks', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  flowId: uuid().notNull().references(() => flows.id, { onDelete: 'restrict' }),
  profileIds: uuid().array().notNull().default([]),
  variablesEnc: text(),
  concurrency: integer().notNull().default(3),
  retries: integer().notNull().default(1),
  timeoutMin: integer().notNull().default(5),
  schedule: jsonb(),
  scheduleSince: ts(),
  runnerUserId: uuid().references(() => users.id, { onDelete: 'set null' }),
  runnerDeviceId: text(),
  runnerDeviceName: text(),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: ts().notNull().defaultNow(),
  version: integer().notNull().default(0)
}, t => [index().on(t.workspaceId), index().on(t.flowId)]);

// One run of a task, made by the desktop app that runs it. `updatedAt` moves with every report, so a run whose
// app went away can be told apart from one still under way.
export const taskRuns = pgTable('task_runs', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  flowVersion: integer().notNull(),
  trigger: text().notNull(),
  status: text().notNull(),
  startedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  deviceName: text(),
  // The scheduled time a run (or a missed one) belongs to; each time is run once.
  scheduledFor: ts(),
  startedAt: ts().notNull(),
  updatedAt: ts().notNull(),
  finishedAt: ts()
}, t => [index().on(t.taskId, t.startedAt), index().on(t.workspaceId, t.startedAt), uniqueIndex().on(t.taskId, t.scheduledFor)]);

// How a run went on one profile. The profile's name and number are copied in, like the activity log.
export const taskRunItems = pgTable('task_run_items', {
  id: uuid().primaryKey().defaultRandom(),
  runId: uuid().notNull().references(() => taskRuns.id, { onDelete: 'cascade' }),
  profileId: uuid().references(() => profiles.id, { onDelete: 'set null' }),
  profileName: text().notNull(),
  profileNumber: integer().notNull(),
  status: text().notNull().default('pending'),
  attempts: integer().notNull().default(0),
  startedAt: ts(),
  finishedAt: ts(),
  error: jsonb(),
  log: jsonb().notNull().default([]),
  data: jsonb().notNull().default({}),
  screenshots: text().array().notNull().default([])
}, t => [uniqueIndex().on(t.runId, t.profileId)]);

// What people did in a workspace. The profile's name and number are copied in, so entries still read right
// after renames and deletions. Kept for as long as the plan says (see activity.ts).
export const activityLog = pgTable('activity_log', {
  // Insertion order: entries written in the same instant (a bulk change) still read in the order they happened.
  seq: bigserial({ mode: 'number' }).primaryKey(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  at: ts().notNull(),
  actorId: uuid().references(() => users.id, { onDelete: 'set null' }),
  deviceName: text(),
  action: text().notNull(),
  profileId: uuid().references(() => profiles.id, { onDelete: 'set null' }),
  profileName: text(),
  profileNumber: integer(),
  detail: jsonb().notNull().default({})
}, t => [index().on(t.workspaceId, t.seq), index().on(t.profileId, t.seq)]);

// Browser engine packages the desktop app downloads, one row per version and platform ("win32-x64", "darwin-arm64"…).
// The first ones point at their upstream releases (`url`); versions the platform admins upload are kept in object
// storage under kernels/ (`objectKey`), as they are rather than sealed, since the app downloads them straight from
// there. An upload is not `ready` until its size checks out. `recommended` is the version new profiles get;
// `recommendedAt` when it became so and `note` what the admin said about it, for the engines page's history.
export const kernels = pgTable('kernels', {
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),
  version: text().notNull(),
  platform: text().notNull(),
  archive: text().notNull(),
  size: bigint({ mode: 'number' }).notNull(),
  sha256: text().notNull(),
  url: text(),
  objectKey: text(),
  recommended: boolean().notNull().default(false),
  recommendedAt: ts(),
  note: text(),
  ready: boolean().notNull().default(true),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt()
}, t => [uniqueIndex().on(t.kind, t.version, t.platform)]);
