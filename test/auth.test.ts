import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ORIGIN, PASSWORD, lastCode, setup, signup, uniqueEmail } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

describe('register and log in', () => {
  it('creates the account, a Free workspace and a web session', async () => {
    const email = uniqueEmail();
    const res = await t.app.inject({ method: 'POST', url: '/auth/register', payload: { email: email.toUpperCase(), password: PASSWORD, locale: 'zh' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email, emailVerified: false, locale: 'zh' });
    const cookie = res.cookies.find(c => c.name === 'folio_session')!;
    expect(cookie.httpOnly).toBe(true);
    const me = await t.app.inject({ url: '/me', headers: { cookie: `folio_session=${cookie.value}` } });
    expect(me.json().workspaces).toEqual([expect.objectContaining({ role: 'owner', plan: 'free', status: 'active' })]);
  });

  it('refuses a second account with the same email', async () => {
    const { email } = await signup(t.app);
    const res = await t.app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('email_taken');
  });

  it('gives the desktop app a bearer token and no cookie', async () => {
    const { email } = await signup(t.app);
    const bad = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'wrong password!' } });
    expect(bad.json().error.code).toBe('invalid_credentials');
    const res = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, client: 'desktop', deviceName: 'Test Mac' } });
    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(0);
    const me = await t.app.inject({ url: '/me', headers: { authorization: `Bearer ${res.json().token}` } });
    expect(me.json().user.email).toBe(email);
  });

  it('ends the session on logout', async () => {
    const { headers } = await signup(t.app);
    expect((await t.app.inject({ method: 'POST', url: '/auth/logout', headers })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/me', headers })).json().error.code).toBe('unauthenticated');
  });
});

describe('cookie-authenticated writes', () => {
  it('must come from the site origin', async () => {
    const { headers } = await signup(t.app);
    const res = await t.app.inject({ method: 'PATCH', url: '/me', headers: { cookie: headers.cookie, origin: 'https://evil.example' }, payload: { locale: 'zh' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('bad_origin');
    const ok = await t.app.inject({ method: 'PATCH', url: '/me', headers, payload: { locale: 'zh' } });
    expect(ok.json().user.locale).toBe('zh');
  });
});

describe('email verification', () => {
  it('accepts the emailed code and locks out after five wrong tries', async () => {
    const { headers, email } = await signup(t.app, { verify: false });
    for (let i = 0; i < 5; i++){
      const r = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: '000000' } });
      if (r.json().error.code !== 'code_invalid') throw new Error(r.body);
    }
    const locked = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: await lastCode(t.app, email) } });
    expect(locked.json().error.code).toBe('too_many_attempts');

    expect((await t.app.inject({ method: 'POST', url: '/auth/resend-code', headers })).statusCode).toBe(204);
    const ok = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: await lastCode(t.app, email) } });
    expect(ok.json().user.emailVerified).toBe(true);
  });

  it('expires codes after 15 minutes', async () => {
    const { headers, email } = await signup(t.app, { verify: false });
    const code = await lastCode(t.app, email);
    t.clock.advanceDays(16 / 1440);
    const res = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code } });
    expect(res.json().error.code).toBe('code_expired');
  });
});

describe('password reset', () => {
  it('sets the new password and signs out every session', async () => {
    const { headers, email } = await signup(t.app);
    const forgot = await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email } });
    expect(forgot.statusCode).toBe(204);
    const unknown = await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'nobody@example.com' } });
    expect(unknown.statusCode).toBe(204);

    const reset = await t.app.inject({ method: 'POST', url: '/auth/password/reset', payload: { email, code: await lastCode(t.app, email), password: 'a brand new secret' } });
    expect(reset.statusCode).toBe(204);
    expect((await t.app.inject({ url: '/me', headers })).statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'a brand new secret' }, headers: { origin: ORIGIN } });
    expect(login.statusCode).toBe(200);
  });
});
