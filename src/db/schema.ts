import { pgTable, pgSequence, uuid, text, timestamp, integer, boolean, jsonb, primaryKey, index } from 'drizzle-orm/pg-core';

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
