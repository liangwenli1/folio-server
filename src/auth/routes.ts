import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { asc, eq } from 'drizzle-orm';
import { memberships, roles, subscriptions, users, workspaces } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { clearSessionCookie, requireSession, setSessionCookie, type Deps } from '../http.js';
import { User, WorkspaceSummary, locale, userView } from '../views.js';
import { createWorkspace } from '../workspaces/service.js';
import { checkCode, consumeCode, issueCode } from './codes.js';
import { codeMail, type Locale } from '../mail.js';
import { createSession, revokeAllSessions, revokeSession } from './session.js';

const password = z.string().min(8).max(200);
const code = z.string().regex(/^\s*\d{6}\s*$/);
const normalize = (email: string) => email.trim().toLowerCase();
// Verifying against a fixed hash when the email is unknown keeps response times alike.
const DUMMY_HASH = await hash('folio-dummy-password');

export function authRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const limited = { rateLimit: { max: deps.config.authRateLimit, timeWindow: '1 minute' } };
  const { db, clock } = deps;
  // With email verification off (a test server), accounts made before it was turned off count as verified too, from
  // their next login or page load.
  const verifiedWhenOff = async (u: typeof users.$inferSelect) => {
    if (deps.config.emailVerification || u.emailVerifiedAt) return u;
    const [v] = await db.update(users).set({ emailVerifiedAt: clock.now() }).where(eq(users.id, u.id)).returning();
    return v;
  };
  const sendCode = async (u: { id: string; email: string; locale: string }, purpose: 'verify' | 'reset') =>
    deps.mailer.send(u.email, codeMail(u.locale as Locale, purpose, await issueCode(db, u.id, purpose, clock.now())));
  // Whose password a reset is for; an unknown email reads as a wrong code, so it does not reveal who has an account.
  const resetUser = async (email: string) => {
    const [u] = await db.select().from(users).where(eq(users.email, normalize(email)));
    if (!u) throw new ApiError(400, 'code_invalid', 'That code is not valid. Request a new one.');
    return u;
  };

  r.post('/auth/register', {
    config: limited,
    schema: { body: z.object({ email: z.email(), password, locale: locale.default('en') }), response: { 201: z.object({ user: User }) } }
  }, async (req, reply) => {
    const now = clock.now();
    const email = normalize(req.body.email);
    const passwordHash = await hash(req.body.password);
    const user = await db.transaction(async tx => {
      const [u] = await tx.insert(users).values({ email, passwordHash, locale: req.body.locale, createdAt: now, emailVerifiedAt: deps.config.emailVerification ? null : now })
        .onConflictDoNothing().returning();
      if (!u) throw new ApiError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
      await createWorkspace(tx, u.id, email.split('@')[0], now);
      return u;
    });
    setSessionCookie(reply, await createSession(db, { userId: user.id, client: 'web', deviceName: null, now }), deps.config);
    // The account exists either way; if the email does not go out, the verify page can send it again.
    if (deps.config.emailVerification) await sendCode(user, 'verify').catch(err => req.log.error(err, 'sending the verification email failed'));
    return reply.code(201).send({ user: userView(user) });
  });

  r.post('/auth/login', {
    config: limited,
    schema: {
      body: z.object({
        email: z.email(), password: z.string().max(200), client: z.enum(['web', 'desktop']).default('web'), deviceName: z.string().max(100).optional(), deviceId: z.uuid().optional(),
        // The site's "keep me signed in": off, the session ends with the browser.
        remember: z.boolean().default(true)
      }),
      response: { 200: z.object({ user: User, token: z.string().optional() }) }
    }
  }, async (req, reply) => {
    const [found] = await db.select().from(users).where(eq(users.email, normalize(req.body.email)));
    const ok = await verify(found?.passwordHash ?? DUMMY_HASH, req.body.password);
    if (!found || !ok) throw new ApiError(401, 'invalid_credentials', 'The email or password is not right');
    const u = await verifiedWhenOff(found);
    const token = await createSession(db, { userId: u.id, client: req.body.client, deviceName: req.body.deviceName ?? null, deviceId: req.body.deviceId ?? null, now: clock.now() });
    if (req.body.client === 'desktop') return { user: userView(u), token };
    setSessionCookie(reply, token, deps.config, req.body.remember);
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
    schema: { body: z.object({ code }), response: { 200: z.object({ user: User }) } }
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

  // The reset's first step: whether the emailed code is right, before a new password is chosen with it.
  r.post('/auth/password/check', {
    config: limited,
    schema: { body: z.object({ email: z.email(), code }), response: { 204: z.null() } }
  }, async (req, reply) => {
    await checkCode(db, (await resetUser(req.body.email)).id, 'reset', req.body.code, clock.now());
    return reply.code(204).send(null);
  });

  r.post('/auth/password/reset', {
    config: limited,
    schema: { body: z.object({ email: z.email(), code, password }), response: { 204: z.null() } }
  }, async (req, reply) => {
    const now = clock.now();
    const u = await resetUser(req.body.email);
    await consumeCode(db, u.id, 'reset', req.body.code, now);
    await db.update(users).set({ passwordHash: await hash(req.body.password) }).where(eq(users.id, u.id));
    await revokeAllSessions(db, u.id, now);
    return reply.code(204).send(null);
  });

  // `admin`: one of the platform admins (config.yaml), who manage browser engine versions.
  r.get('/me', { schema: { response: { 200: z.object({ user: User, workspaces: z.array(WorkspaceSummary), admin: z.boolean() }) } } }, async req => {
    const s = await requireSession(req, deps);
    const u = await verifiedWhenOff((await db.select().from(users).where(eq(users.id, s.userId)))[0]);
    const rows = await db.select({
      id: workspaces.id, name: workspaces.name, plan: subscriptions.plan, status: subscriptions.status,
      roleId: roles.id, roleKey: roles.key, roleName: roles.name, permissions: roles.permissions
    })
      .from(memberships)
      .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
      .innerJoin(roles, eq(roles.id, memberships.roleId))
      .innerJoin(subscriptions, eq(subscriptions.workspaceId, memberships.workspaceId))
      .where(eq(memberships.userId, s.userId))
      .orderBy(asc(workspaces.createdAt));
    const list = rows.map(w => ({
      id: w.id, name: w.name, plan: w.plan, status: w.status,
      role: { id: w.roleId, key: w.roleKey, name: w.roleName, permissions: w.permissions }
    }));
    return { user: userView(u), workspaces: list as z.infer<typeof WorkspaceSummary>[], admin: deps.config.admins.includes(u.email) };
  });

  r.patch('/me', { schema: { body: z.object({ locale }), response: { 200: z.object({ user: User }) } } }, async req => {
    const s = await requireSession(req, deps);
    const [u] = await db.update(users).set({ locale: req.body.locale }).where(eq(users.id, s.userId)).returning();
    return { user: userView(u) };
  });
}
