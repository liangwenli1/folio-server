import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ORIGIN, PASSWORD, lastCode, lastMail, setup, signup, uniqueEmail } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

describe('register and log in', () => {
  const askCode = (email: string, locale?: string) => t.app.inject({ method: 'POST', url: '/auth/signup-code', payload: { email, locale } });

  it('signs up with a code sent to the address: a verified account, a Free workspace and a web session', async () => {
    const email = uniqueEmail();
    expect((await askCode(email.toUpperCase(), 'zh')).statusCode).toBe(204);
    const m = await lastMail(email);
    expect(m.Subject).toMatch(/^Folio 注册验证码：\d{6}$/);
    expect(m.HTML).toContain('注册 Folio');
    const res = await t.app.inject({ method: 'POST', url: '/auth/register', payload: { email: email.toUpperCase(), code: m.Text.match(/\b\d{6}\b/)![0], password: PASSWORD, locale: 'zh' } });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email, emailVerified: true, locale: 'zh' });
    const cookie = res.cookies.find(c => c.name === 'folio_session')!;
    expect(cookie.httpOnly).toBe(true);
    const me = await t.app.inject({ url: '/me', headers: { cookie: `folio_session=${cookie.value}` } });
    expect(me.json().workspaces).toEqual([expect.objectContaining({ role: expect.objectContaining({ key: 'owner' }), plan: 'free', status: 'active' })]);
  });

  it('needs the code that was sent, and a password of 8 to 64 characters', async () => {
    const email = uniqueEmail();
    await askCode(email);
    const code = await lastCode(email), wrong = code === '000000' ? '111111' : '000000';
    const register = (payload: object) => t.app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD, ...payload } });
    expect((await register({})).json().error.code).toBe('code_invalid');
    expect((await register({ code: wrong })).json().error.code).toBe('code_invalid');
    expect((await register({ code, password: 'seven77' })).statusCode).toBe(400);
    expect((await register({ code, password: 'x'.repeat(65) })).statusCode).toBe(400);
    expect((await register({ code })).statusCode).toBe(201);
  });

  it('tells an address that already has an account to log in, and sends codes at most once a minute', async () => {
    const { email } = await signup(t.app);
    expect((await askCode(email)).json().error.code).toBe('email_taken');
    expect((await t.app.inject({ method: 'POST', url: '/auth/register', payload: { email, code: '123456', password: PASSWORD } })).json().error.code).toBe('email_taken');
    const fresh = uniqueEmail();
    expect((await askCode(fresh)).statusCode).toBe(204);
    expect((await askCode(fresh)).json().error.code).toBe('too_soon');
    t.clock.advanceDays(61 / 86400);
    expect((await askCode(fresh)).statusCode).toBe(204);
  });

  it('with email verification off (a test server), takes no code and counts new accounts as verified', async () => {
    t.config.emailVerification = false;
    try {
      expect((await t.app.inject({ url: '/auth/options' })).json()).toEqual({ emailVerification: false });
      const email = uniqueEmail();
      const res = await t.app.inject({ method: 'POST', url: '/auth/register', payload: { email, password: PASSWORD } });
      expect(res.json().user).toMatchObject({ email, emailVerified: true });
      await expect(lastMail(email)).rejects.toThrow('No email');
    } finally { t.config.emailVerification = true; }
    expect((await t.app.inject({ url: '/auth/options' })).json()).toEqual({ emailVerification: true });
  });

  it('turning email verification off also lets in accounts made before, from their next page load', async () => {
    const { headers } = await signup(t.app, { unverifiedIn: t.db });
    expect((await t.app.inject({ url: '/me', headers })).json().user.emailVerified).toBe(false);
    t.config.emailVerification = false;
    try {
      expect((await t.app.inject({ url: '/me', headers })).json().user.emailVerified).toBe(true);
    } finally { t.config.emailVerification = true; }
    expect((await t.app.inject({ url: '/me', headers })).json().user.emailVerified).toBe(true);
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

  it('keeps a web sign-in for 30 days, or only until the browser closes when asked not to remember it', async () => {
    const { email } = await signup(t.app);
    const kept = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
    expect(kept.cookies.find(c => c.name === 'folio_session')!.maxAge).toBe(30 * 86400);
    const brief = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, remember: false } });
    const cookie = brief.cookies.find(c => c.name === 'folio_session')!;
    expect(cookie.maxAge).toBeUndefined();
    expect(cookie.expires).toBeUndefined();
    expect((await t.app.inject({ url: '/me', headers: { cookie: `folio_session=${cookie.value}` } })).json().user.email).toBe(email);
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

describe('verifying an account made before sign-up codes', () => {
  it('sends a code when asked, accepts it, and locks out after five wrong tries', async () => {
    const { headers, email } = await signup(t.app, { unverifiedIn: t.db });
    expect((await t.app.inject({ method: 'POST', url: '/auth/resend-code', headers })).statusCode).toBe(204);
    expect((await lastMail(email)).Subject).toMatch(/is your Folio verification code$/);
    for (let i = 0; i < 5; i++){
      const r = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: '000000' } });
      if (r.json().error.code !== 'code_invalid') throw new Error(r.body);
    }
    const locked = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: await lastCode(email) } });
    expect(locked.json().error.code).toBe('too_many_attempts');

    expect((await t.app.inject({ method: 'POST', url: '/auth/resend-code', headers })).json().error.code).toBe('too_soon');
    t.clock.advanceDays(61 / 86400);
    expect((await t.app.inject({ method: 'POST', url: '/auth/resend-code', headers })).statusCode).toBe(204);
    const ok = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code: await lastCode(email) } });
    expect(ok.json().user.emailVerified).toBe(true);
  });

  it('expires codes after 15 minutes', async () => {
    const { headers, email } = await signup(t.app, { unverifiedIn: t.db });
    await t.app.inject({ method: 'POST', url: '/auth/resend-code', headers });
    const code = await lastCode(email);
    t.clock.advanceDays(16 / 1440);
    const res = await t.app.inject({ method: 'POST', url: '/auth/verify-email', headers, payload: { code } });
    expect(res.json().error.code).toBe('code_expired');
  });
});

describe('emails', () => {
  it('go out over SMTP in the recipient’s language', async () => {
    const email = uniqueEmail();
    await t.app.inject({ method: 'POST', url: '/auth/signup-code', payload: { email, locale: 'zh' } });
    await t.app.inject({ method: 'POST', url: '/auth/register', payload: { email, code: await lastCode(email), password: PASSWORD, locale: 'zh' } });
    await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email } });
    const m = await lastMail(email);
    expect(m.Subject).toMatch(/^Folio 重设密码验证码/);
    expect(m.HTML).toContain('重设密码');
  });

  it('that fail to send say so where someone waits for the code, while a password reset stays quiet', async () => {
    const down = await buildApp({ db: t.db, clock: t.clock, config: t.config, storage: t.storage, mailer: { send: async () => { throw new Error('SMTP down'); } } }, { logger: false });
    expect((await down.inject({ method: 'POST', url: '/auth/signup-code', payload: { email: uniqueEmail() } })).json().error.code).toBe('mail_unavailable');
    const { email, headers } = await signup(t.app, { unverifiedIn: t.db });
    expect((await down.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email } })).statusCode).toBe(204);
    expect((await down.inject({ method: 'POST', url: '/auth/resend-code', headers })).json().error.code).toBe('mail_unavailable');
    await down.close();
  });
});

describe('password reset', () => {
  it('sets the new password and signs out every session', async () => {
    const { headers, email } = await signup(t.app);
    const forgot = await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email } });
    expect(forgot.statusCode).toBe(204);
    const unknown = await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: 'nobody@example.com' } });
    expect(unknown.statusCode).toBe(204);

    const reset = await t.app.inject({ method: 'POST', url: '/auth/password/reset', payload: { email, code: await lastCode(email), password: 'a brand new secret' } });
    expect(reset.statusCode).toBe(204);
    expect((await t.app.inject({ url: '/me', headers })).statusCode).toBe(401);
    const login = await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'a brand new secret' }, headers: { origin: ORIGIN } });
    expect(login.statusCode).toBe(200);
  });

  it('sends reset codes at most once a minute, alike for addresses with and without an account', async () => {
    const { email } = await signup(t.app);
    for (const address of [email, uniqueEmail()]){
      expect((await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: address } })).statusCode).toBe(204);
      expect((await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email: address } })).json().error.code).toBe('too_soon');
    }
  });

  it('checks the code first without using it up; wrong ones count, and an unknown email reads as a wrong code', async () => {
    const { email } = await signup(t.app);
    const check = (payload: object) => t.app.inject({ method: 'POST', url: '/auth/password/check', payload });
    await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email } });
    const code = await lastCode(email), wrong = code === '000000' ? '111111' : '000000';
    expect((await check({ email, code: wrong })).json().error.code).toBe('code_invalid');
    expect((await check({ email: 'nobody@example.com', code })).json().error.code).toBe('code_invalid');
    expect((await check({ email, code })).statusCode).toBe(204);
    expect((await check({ email, code })).statusCode).toBe(204);
    const reset = await t.app.inject({ method: 'POST', url: '/auth/password/reset', payload: { email, code, password: 'a brand new secret' } });
    expect(reset.statusCode).toBe(204);
    expect((await check({ email, code })).json().error.code).toBe('code_invalid');

    t.clock.advanceDays(61 / 86400);
    await t.app.inject({ method: 'POST', url: '/auth/password/forgot', payload: { email } });
    const next = await lastCode(email), miss = next === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) await check({ email, code: miss });
    expect((await check({ email, code: next })).json().error.code).toBe('too_many_attempts');
  });
});

describe('the person’s own profile', () => {
  it('starts with the name before the @, and keeps a name, a note and which notices to give', async () => {
    const { headers, email } = await signup(t.app);
    const me = async () => (await t.app.inject({ url: '/me', headers })).json().user;
    expect(await me()).toMatchObject({ displayName: email.split('@')[0], note: null, notify: { taskDone: true, taskFailed: true, proxyDown: true, productUpdate: false } });
    const patch = (payload: object) => t.app.inject({ method: 'PATCH', url: '/me', headers, payload });
    expect((await patch({ displayName: ' 林晓 ', note: '工作空间所有者', notify: { taskDone: false, taskFailed: true, proxyDown: true, productUpdate: true } })).statusCode).toBe(200);
    expect(await me()).toMatchObject({ displayName: '林晓', note: '工作空间所有者', notify: { taskDone: false, productUpdate: true }, locale: 'en' });
    // A blank name is refused; a blank note clears it; the language changes on its own.
    expect((await patch({ displayName: '  ' })).json().error.code).toBe('validation');
    expect((await (await patch({ note: '', locale: 'zh' })).json()).user).toMatchObject({ displayName: '林晓', note: null, locale: 'zh' });
  });

  it('changes the password given the current one, and ends every other sign-in', async () => {
    const { headers, email } = await signup(t.app);
    const desktop = (await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD, client: 'desktop' } })).json().token;
    const change = (payload: object) => t.app.inject({ method: 'POST', url: '/auth/password/change', headers, payload });
    expect((await change({ current: 'not it at all', password: 'a new long password' })).json().error.code).toBe('wrong_password');
    expect((await change({ current: PASSWORD, password: 'short' })).json().error.code).toBe('validation');
    expect((await change({ current: PASSWORD, password: 'a new long password' })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/me', headers })).statusCode).toBe(200);
    expect((await t.app.inject({ url: '/me', headers: { authorization: `Bearer ${desktop}` } })).statusCode).toBe(401);
    expect((await t.app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: 'a new long password', client: 'desktop' } })).statusCode).toBe(200);
  });
});
