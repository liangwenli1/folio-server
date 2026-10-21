import postgres from 'postgres';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createDb } from '../src/db/client.js';
import { runMigrations } from '../src/db/migrate.js';

const MAIN_URL = process.env.DATABASE_URL ?? 'postgres://folio:folio@folio-postgres:5432/folio';
const TEST_URL = MAIN_URL.replace(/\/[^/]+$/, '/folio_test');
export const ORIGIN = 'http://localhost:47120';
const DAY = 86_400_000;

// A clock the tests move by hand.
export function makeClock(start = '2026-11-01T10:00:00Z'){
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advanceDays: (d: number) => { t += d * DAY; }, set: (iso: string) => { t = new Date(iso).getTime(); } };
}

export async function setup(){
  const admin = postgres(MAIN_URL, { max: 1, onnotice: () => {} });
  if (!(await admin`select 1 from pg_database where datname = 'folio_test'`).length) await admin`create database folio_test`;
  await admin.end();
  const { db, close } = createDb(TEST_URL);
  await db.execute(sql`drop schema if exists public cascade`);
  await db.execute(sql`drop schema if exists drizzle cascade`);
  await db.execute(sql`create schema public`);
  await runMigrations(db);
  const clock = makeClock();
  const app = await buildApp({
    db, clock, config: { ...config, devTools: true, mockPayments: true, authRateLimit: 10_000, siteOrigins: [ORIGIN] }
  }, { logger: false });
  return { app, db, clock, teardown: async () => { await app.close(); await close(); } };
}

let seq = 0;
export const uniqueEmail = () => `user${Date.now().toString(36)}${seq++}@example.com`;
export const PASSWORD = 'correct horse battery';
export const GOOD_CARD = { number: '4242 4242 4242 4242', expMonth: 12, expYear: 2030, cvc: '123' };

export async function lastCode(app: FastifyInstance, email: string){
  return (await app.inject({ url: `/dev/mail?email=${encodeURIComponent(email)}` })).json().code as string;
}

// Registers through the site flow; verifies the email unless asked not to.
export async function signup(app: FastifyInstance, { verify = true, email = uniqueEmail() } = {}){
  const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD } });
  if (res.statusCode !== 201) throw new Error(`register failed: ${res.body}`);
  const token = res.cookies.find(c => c.name === 'folio_session')!.value;
  const headers = { cookie: `folio_session=${token}`, origin: ORIGIN };
  if (verify) await app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: await lastCode(app, email) } });
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
