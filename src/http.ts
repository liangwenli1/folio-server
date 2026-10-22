import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import { ApiError } from './errors.js';
import { resolveSession } from './auth/session.js';
import type { Mailer } from './mail.js';
import type { Storage } from './storage.js';

export interface Deps { db: Db; config: Config; clock: { now(): Date }; mailer: Mailer; storage: Storage }

export const SESSION_COOKIE = 'folio_session';

// Web clients send the session cookie; the desktop app sends `Authorization: Bearer <token>`.
// Cookie-authenticated writes must come from the site's own origin.
export async function requireSession(req: FastifyRequest, deps: Deps){
  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  const token = bearer ?? req.cookies[SESSION_COOKIE];
  if (!token) throw new ApiError(401, 'unauthenticated', 'Log in to continue');
  const session = await resolveSession(deps.db, token, deps.clock.now());
  if (!session) throw new ApiError(401, 'unauthenticated', 'Your session has ended. Log in again.');
  if (!bearer && req.method !== 'GET' && req.method !== 'HEAD'){
    const origin = req.headers.origin;
    if (!origin || !deps.config.siteOrigins.includes(origin)) throw new ApiError(403, 'bad_origin', 'This request did not come from the Folio site');
  }
  return session;
}

export function setSessionCookie(reply: FastifyReply, token: string, config: Config){
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: config.cookieSecure, domain: config.cookieDomain, path: '/', maxAge: 30 * 86400
  });
}

export function clearSessionCookie(reply: FastifyReply, config: Config){
  reply.clearCookie(SESSION_COOKIE, { path: '/', domain: config.cookieDomain });
}
