import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { asc, eq } from 'drizzle-orm';
import { memberships, subscriptions, users, workspaces } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { clearSessionCookie, requireSession, setSessionCookie, type Deps } from '../http.js';
import { User, WorkspaceSummary, locale, userView } from '../views.js';
import { createWorkspace } from '../workspaces/service.js';
import { consumeCode, issueCode } from './codes.js';
import { codeMail, type Locale } from '../mail.js';
import { createSession, revokeAllSessions, revokeSession } from './session.js';

const password = z.string().min(8).max(200);
const normalize = (email: string) => email.trim().toLowerCase();
// Verifying against a fixed hash when the email is unknown keeps response times alike.
const DUMMY_HASH = await hash('folio-dummy-password');

export function authRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limited = { rateLimit: { max: deps.config.authRateLimit, timeWindow: '1 minute' } };
  const { db, clock } = deps;
  const sendCode = async (u: { id: string; email: string; locale: string }, purpose: 'verify' | 'reset') =>
    deps.mailer.send(u.email, codeMail(u.locale as Locale, purpose, await issueCode(db, u.id, purpose, clock.now())));

  r.post('/auth/register', {
    config: limited,
    schema: { body: z.object({ email: z.email(), password, locale: locale.default('en') }), response: { 201: z.object({ user: User }) } }
  }, async (req, reply) => {
    const now = clock.now();
    const email = normalize(req.body.email);
    const passwordHash = await hash(req.body.password);
    const user = await db.transaction(async tx => {
      const [u] = await tx.insert(users).values({ email, passwordHash, locale: req.body.locale, createdAt: now }).onConflictDoNothing().returning();
      if (!u) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
      await createWorkspace(tx, u.id, email.split('@')[0], now);
      return u;
    });
    setSessionCookie(reply, await createSession(db, { userId: user.id, client: 'web', deviceName: null, now }), deps.config);
    // The account exists either way; if the email does not go out, the verify page can send it again.
    await sendCode(user, 'verify').catch(err => req.log.error(err, 'sending the verification email failed'));
    return reply.code(201).send({ user: userView(user) });
  });

  r.post('/auth/login', {
    config: limited,
    schema: {
      body: z.object({ email: z.email(), password: z.string().max(200), client: z.enum(['web', 'desktop']).default('web'), deviceName: z.string().max(100).optional(), deviceId: z.uuid().optional() }),
      response: { 200: z.object({ user: User, token: z.string().optional() }) }
    }
  }, async (req, reply) => {
    const [u] = await db.select().from(users).where(eq(users.email, normalize(req.body.email)));
    const ok = await verify(u?.passwordHash ?? DUMMY_HASH, req.body.password);
    if (!u || !ok) throw new ApiError(401, 'invalid_credentials', 'The email or password is not right');
    const token = await createSession(db, { userId: u.id, client: req.body.client, deviceName: req.body.deviceName ?? null, deviceId: req.body.deviceId ?? null, now: clock.now() });
    if (req.body.client === 'desktop') return { user: userView(u), token };
    setSessionCookie(reply, token, deps.config);
    return { user: userView(u) };
  });

  r.post('/auth/logout', { schema: { response: { 204: z.null() } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await revokeSession(db, s.id, clock.now());
    clearSessionCookie(reply, deps.config);
    return reply.code(204).send(null);
  });

  r.post('/auth/verify-email', {
    config: limited,
    schema: { body: z.object({ code: z.string().regex(/^\s*\d{6}\s*$/) }), response: { 200: z.object({ user: User }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    const now = clock.now();
    await consumeCode(db, s.userId, 'verify', req.body.code, now);
    const [u] = await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, s.userId)).returning();
    return { user: userView(u) };
  });

  r.post('/auth/resend-code', { config: limited, schema: { response: { 204: z.null() } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    const [u] = await db.select().from(users).where(eq(users.id, s.userId));
    if (u.emailVerifiedAt) throw new ApiError(409, 'already_verified', 'This email is already verified');
    await sendCode(u, 'verify').catch(err => {
      req.log.error(err, 'sending the verification email failed');
      throw new ApiError(503, 'mail_unavailable', 'We couldn’t send the email. Try again in a minute.');
    });
    return reply.code(204).send(null);
  });

  // Always 204, so the response does not reveal whether an account exists.
  r.post('/auth/password/forgot', { config: limited, schema: { body: z.object({ email: z.email() }), response: { 204: z.null() } } }, async (req, reply) => {
    const [u] = await db.select().from(users).where(eq(users.email, normalize(req.body.email)));
    if (u) await sendCode(u, 'reset').catch(err => req.log.error(err, 'sending the password reset email failed'));
    return reply.code(204).send(null);
  });

  r.post('/auth/password/reset', {
    config: limited,
    schema: { body: z.object({ email: z.email(), code: z.string().regex(/^\s*\d{6}\s*$/), password }), response: { 204: z.null() } }
  }, async (req, reply) => {
    const now = clock.now();
    const [u] = await db.select().from(users).where(eq(users.email, normalize(req.body.email)));
    if (!u) throw new ApiError(400, 'code_invalid', 'That code is not valid. Request a new one.');
    await consumeCode(db, u.id, 'reset', req.body.code, now);
    await db.update(users).set({ passwordHash: await hash(req.body.password) }).where(eq(users.id, u.id));
    await revokeAllSessions(db, u.id, now);
    return reply.code(204).send(null);
  });

  r.get('/me', { schema: { response: { 200: z.object({ user: User, workspaces: z.array(WorkspaceSummary) }) } } }, async req => {
    const s = await requireSession(req, deps);
    const [u] = await db.select().from(users).where(eq(users.id, s.userId));
    const rows = await db.select({ id: workspaces.id, name: workspaces.name, role: memberships.role, plan: subscriptions.plan, status: subscriptions.status })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .innerJoin(subscriptions, eq(subscriptions.workspaceId, memberships.workspaceId))
      .where(eq(memberships.userId, s.userId))
      .orderBy(asc(workspaces.createdAt));
    return { user: userView(u), workspaces: rows as z.infer<typeof WorkspaceSummary>[] };
  });

  r.patch('/me', { schema: { body: z.object({ locale }), response: { 200: z.object({ user: User }) } } }, async req => {
    const s = await requireSession(req, deps);
    const [u] = await db.update(users).set({ locale: req.body.locale }).where(eq(users.id, s.userId)).returning();
    return { user: userView(u) };
  });
}
