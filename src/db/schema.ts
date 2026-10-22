import { pgTable, pgSequence, uuid, text, timestamp, integer, boolean, jsonb, primaryKey, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';

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

export const memberships = pgTable('memberships', {
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text().notNull(),
  createdAt: createdAt()
}, t => [primaryKey({ columns: [t.workspaceId, t.userId] }), index().on(t.userId)]);

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

export const groups = pgTable('groups', {
  id: uuid().primaryKey().defaultRandom(),
  workspaceId: uuid().notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  createdAt: createdAt()
}, t => [uniqueIndex().on(t.workspaceId, t.name)]);

// Passwords are encrypted with SECRET_KEY (see crypto.ts). `backupId` is the line to fall back to.
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
  ownerId: uuid().references(() => users.id, { onDelete: 'set null' }),
  tags: text().array().notNull().default([]),
  kernel: text().notNull(),
  kernelVersion: text().notNull(),
  os: text().notNull(),
  fingerprint: jsonb().notNull(),
  proxyId: uuid().references(() => proxies.id, { onDelete: 'set null' }),
  timezoneOverride: text(),
  localeOverride: text(),
  notes: text(),
  lastOpenedAt: ts(),
  lastOpenedBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdBy: uuid().references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: ts().notNull().defaultNow(),
  deletedAt: ts(),
  version: integer().notNull().default(0)
}, t => [uniqueIndex().on(t.workspaceId, t.number), index().on(t.workspaceId, t.deletedAt)]);

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
