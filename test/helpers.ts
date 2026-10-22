import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';
import { createMailer } from '../src/mail.js';

const MAIN_URL = process.env.DATABASE_URL ?? 'postgres://folio:folio@folio-postgres:5432/folio';
const TEST_URL = MAIN_URL.replace(/\/[^/]+$/, '/folio_test');
export const ORIGIN = 'http://localhost:47120';
const DAY = 86_400_000;

// A clock the tests move by hand.
export function makeClock(start = '2026-11-01T10:00:00Z'){
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advanceDays: (d: number) => { t += d * DAY; }, set: (iso: string) => { t = new Date(iso).getTime(); } };
}

export async function setup(overrides: Partial<typeof config> = {}){
  const admin = postgres(MAIN_URL, { max: 1, onnotice: () => {} });
  if (!(await admin`select 1 from pg_database where datname = 'folio_test'`).length) await admin`create database folio_test`;
  await admin.end();
  const { db, close } = createDb(TEST_URL);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const clock = makeClock();
  const cfg = { ...config, devTools: true, mockPayments: true, authRateLimit: 10_000, siteOrigins: [ORIGIN], devPrivateGeo: 'seattle', geoipDb: process.env.GEOIP_DB ?? '', ...overrides };
  const app = await buildApp({ db, clock, config: cfg, mailer: createMailer(cfg) }, { logger: false });
  return { app, db, clock, config: cfg, teardown: async () => { await app.close(); await close(); } };
}

let seq = 0;
export const uniqueEmail = () => `user${Date.now().toString(36)}${seq++}@example.com`;
export const PASSWORD = 'correct horse battery';
export const GOOD_CARD = { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2030, cvc: '123' };

// The newest message Mailpit received for an address (the server sends real mail to it in tests).
const MAILPIT = process.env.MAILPIT_URL ?? 'http://folio-mailpit:8025';
export async function lastMail(email: string){
  for (let i = 0; i < 50; i++){
    const { messages } = await (await fetch(`${MAILPIT}/api/v1/search?limit=1&query=${encodeURIComponent(`to:${email}`)}`)).json() as { messages: { ID: string }[] };
    if (messages.length) return await (await fetch(`${MAILPIT}/api/v1/message/${messages[0].ID}`)).json() as { Subject: string; Text: string; HTML: string };
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`No email for ${email}`);
}
export const lastCode = async (email: string) => (await lastMail(email)).Text.match(/\b\d{6}\b/)![0];

// Registers through the site flow; verifies the email unless asked not to.
export async function signup(app: FastifyInstance, { verify = true, email = uniqueEmail() } = {}){
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const token = res.cookies.find(c => c.name === 'folio_session')!.value;
  const headers = { cookie: `folio_session=${token}`, origin: ORIGIN };
  if (verify) await app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: await lastCode(email) } });
  const me = (await app.inject({ url: '/me', headers })).json();
  return { email, headers, userId: me.user.id as string, workspaceId: me.workspaces[0].id as string };
}

// A fresh web session, for tests that move the clock past the 30-day session lifetime.
export async function login(app: FastifyInstance, email: string){
  const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  return { cookie: `folio_session=${res.cookies.find(c => c.name === 'folio_session')!.value}`, origin: ORIGIN };
}

export async function buy(app: FastifyInstance, headers: Record<string, string>, workspaceId: string, body: object, card = GOOD_CARD){
  const co = await app.inject({ method: 'POST', url: `/workspaces/${workspaceId}/billing/checkout`, headers, payload: body });
  if (co.statusCode !== 200) throw new Error(`checkout failed: ${co.body}`);
  const { checkoutId } = co.json();
  if (!checkoutId) return co;
  return app.inject({ method: 'POST', url: `/billing/checkouts/${checkoutId}/pay`, headers, payload: { card } });
}

export const chromiumProfile = (name: string, extra: object = {}) => ({
  name, kernel: 'chromium', kernelVersion: '150.0.7871.186', os: 'windows',
  fingerprint: { kind: 'chromium', seed: 1001, hardwareConcurrency: 8 }, ...extra
});
