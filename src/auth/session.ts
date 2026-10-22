import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { sessions } from '../db/schema.js';
import { addDays } from '../plans.js';

const SESSION_DAYS = 30;
const TOUCH_EVERY_MS = 3_600_000;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export async function createSession(db: Db, a: { userId: string; client: 'web' | 'desktop'; deviceName: string | null; deviceId?: string | null; now: Date }){
  const token = randomBytes(32).toString('base64url');
  await db.insert(sessions).values({
    tokenHash: sha256(token), userId: a.userId, client: a.client, deviceName: a.deviceName, deviceId: a.deviceId ?? null,
    createdAt: a.now, lastUsedAt: a.now, expiresAt: addDays(a.now, SESSION_DAYS)
  });
  return token;
}

// Sliding expiry: a session used at least once an hour-window stays alive for 30 days after its last use.
export async function resolveSession(db: Db, token: string, now: Date){
  const [s] = await db.select().from(sessions).where(eq(sessions.tokenHash, sha256(token)));
  if (!s || s.revokedAt || s.expiresAt <= now) return null;
  if (now.getTime() - s.lastUsedAt.getTime() > TOUCH_EVERY_MS){
    await db.update(sessions).set({ lastUsedAt: now, expiresAt: addDays(now, SESSION_DAYS) }).where(eq(sessions.id, s.id));
  }
  return s;
}

export async function revokeSession(db: Db, id: string, now: Date){
  await db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, id));
}

export async function revokeAllSessions(db: Db, userId: string, now: Date){
  await db.update(sessions).set({ revokedAt: now }).where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
}
