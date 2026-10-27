import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { hash, verify } from '@node-rs/argon2';
import { asc, eq } from 'drizzle-orm';
import { memberships, roles, subscriptions, users, workspaces } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { clearSessionCookie, requireSession, setSessionCookie, type Deps } from '../http.js';
import { Notify, User, WorkspaceSummary, locale, userView } from '../views.js';
import { createWorkspace } from '../workspaces/service.js';
import { checkCode, consumeCode, issueCode, type CodePurpose } from './codes.js';
import { codeMail, type Locale } from '../mail.js';
import { createSession, revokeAllSessions, revokeSession } from './session.js';

// A new password. Logging in takes any length, for passwords chosen before the limit.
const password = z.string().min(8).max(64);
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
  // Emails a new code; the person is waiting for it, so failing to send says so.
  const sendCode = async (log: FastifyBaseLogger, email: string, locale: string, purpose: CodePurpose) => {
    const c = await issueCode(db, email, purpose, clock.now());
    await deps.mailer.send(email, codeMail(locale as Locale, purpose, c)).catch(err => {
      log.error(err, 'sending a code by email failed');
      throw new ApiError(503, 'mail_unavailable', 'We couldn’t send the email. Try again in a minute.');
    });
  };
  const taken = () => new ApiError(409, 'email_taken', 'An account with this email already exists. Log in instead.');
  const exists = async (email: string) => (await db.select({ id: users.id }).from(users).where(eq(users.email, email))).length > 0;
  // Whose password a reset is for; an unknown email reads as a wrong code, so it does not reveal who has an account.
  const resetUser = async (email: string) => {
    const [u] = await db.select().from(users).where(eq(users.email, normalize(email)));
    if (!u) throw new ApiError(400, 'code_invalid', 'That code is not valid. Request a new one.');
    return u;
  };

  // What the sign-up page needs to know: without email verification (a test server) there is no code to ask for.
  r.get('/auth/options', { schema: { response: { 200: z.object({ emailVerification: z.boolean() }) } } }, async () => ({ emailVerification: deps.config.emailVerification }));

  // Signing up starts with a code sent to the address; one that already has an account is told to log in instead.
  r.post('/auth/signup-code', {
    config: limited,
    schema: { body: z.object({ email: z.email(), locale: locale.default('en') }), response: { 204: z.null() } }
  }, async (req, reply) => {
    const email = normalize(req.body.email);
    if (await exists(email)) throw taken();
    await sendCode(req.log, email, req.body.locale, 'signup');
    return reply.code(204).send(null);
  });

  // The code from /auth/signup-code proves the address, so the account starts verified. A test server without
  // email verification asks for no code.
  r.post('/auth/register', {
    config: limited,
    schema: { body: z.object({ email: z.email(), code: code.optional(), password, locale: locale.default('en') }), response: { 201: z.object({ user: User }) } }
  }, async (req, reply) => {
    const now = clock.now();
    const email = normalize(req.body.email);
    if (await exists(email)) throw taken();
    if (deps.config.emailVerification){
      if (!req.body.code) throw new ApiError(400, 'code_invalid', 'Enter the code sent to your email.');
      await consumeCode(db, email, 'signup', req.body.code, now);
    }
    const passwordHash = await hash(req.body.password);
    const user = await db.transaction(async tx => {
      const [u] = await tx.insert(users).values({ email, passwordHash, displayName: email.split('@')[0], locale: req.body.locale, createdAt: now, emailVerifiedAt: now }).onConflictDoNothing().returning();
      if (!u) throw taken();
      await createWorkspace(tx, u.id, email.split('@')[0], now);
      return u;
    });
    setSessionCookie(reply, await createSession(db, { userId: user.id, client: 'web', deviceName: null, now }), deps.config);
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

  // Verifying an account made before sign-up codes, which started out unverified: send it a code, then take it.
  r.post('/auth/verify-email', {
    config: limited,
    schema: { body: z.object({ code }), response: { 200: z.object({ user: User }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    const now = clock.now();
    const [found] = await db.select().from(users).where(eq(users.id, s.userId));
    await consumeCode(db, found.email, 'verify', req.body.code, now);
    const [u] = await db.update(users).set({ emailVerifiedAt: now }).where(eq(users.id, s.userId)).returning();
    return { user: userView(u) };
  });

  r.post('/auth/resend-code', { config: limited, schema: { response: { 204: z.null() } } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    const [u] = await db.select().from(users).where(eq(users.id, s.userId));
    if (u.emailVerifiedAt) throw new ApiError(409, 'already_verified', 'This email is already verified');
    await sendCode(req.log, u.email, u.locale, 'verify');
    return reply.code(204).send(null);
  });

  // Always 204 and quiet about failing to send, so the answer does not reveal whether an account exists. The code is
  // made either way, so asking again too soon is refused alike; only an account gets the email.
  r.post('/auth/password/forgot', { config: limited, schema: { body: z.object({ email: z.email() }), response: { 204: z.null() } } }, async (req, reply) => {
    const email = normalize(req.body.email);
    const [u] = await db.select().from(users).where(eq(users.email, email));
    const c = await issueCode(db, email, 'reset', clock.now());
    if (u) await deps.mailer.send(email, codeMail(u.locale as Locale, 'reset', c)).catch(err => req.log.error(err, 'sending the password reset email failed'));
    return reply.code(204).send(null);
  });

  // The reset's first step: whether the emailed code is right, before a new password is chosen with it.
  r.post('/auth/password/check', {
    config: limited,
    schema: { body: z.object({ email: z.email(), code }), response: { 204: z.null() } }
  }, async (req, reply) => {
    await checkCode(db, (await resetUser(req.body.email)).email, 'reset', req.body.code, clock.now());
    return reply.code(204).send(null);
  });

  r.post('/auth/password/reset', {
    config: limited,
    schema: { body: z.object({ email: z.email(), code, password }), response: { 204: z.null() } }
  }, async (req, reply) => {
    const now = clock.now();
    const u = await resetUser(req.body.email);
    await consumeCode(db, u.email, 'reset', req.body.code, now);
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

  // The person's own settings: language, the name colleagues see, a note, which notices they get (v2 32, 38).
  r.patch('/me', {
    schema: { body: z.object({ locale: locale.optional(), displayName: z.string().trim().min(1).max(40).optional(), note: z.string().trim().max(200).nullable().optional(), notify: Notify.optional() }), response: { 200: z.object({ user: User }) } }
  }, async req => {
    const s = await requireSession(req, deps);
    const { note, ...rest } = req.body;
    const [u] = await db.update(users).set({ ...rest, ...(note === undefined ? {} : { note: note || null }) }).where(eq(users.id, s.userId)).returning();
    return { user: userView(u) };
  });

  // A new password, given the current one (v2 33). Every other sign-in ends; this one stays.
  r.post('/auth/password/change', { schema: { body: z.object({ current: z.string().max(200), password }) } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    const [u] = await db.select().from(users).where(eq(users.id, s.userId));
    if (!(await verify(u.passwordHash, req.body.current))) throw new ApiError(400, 'wrong_password', 'The current password is not right.');
    await db.update(users).set({ passwordHash: await hash(req.body.password) }).where(eq(users.id, u.id));
    await revokeAllSessions(db, u.id, clock.now(), s.id);
    return reply.code(204).send(null);
  });
}
