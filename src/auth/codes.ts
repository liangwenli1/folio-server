import { randomInt } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailCodes } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { sha256 } from './session.js';

export type CodePurpose = 'verify' | 'reset';
const TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

const hashCode = (userId: string, code: string) => sha256(`${userId}:${code}`);

// Issuing a new code retires any earlier unused one for the same purpose.
export async function issueCode(db: Db, userId: string, purpose: CodePurpose, now: Date){
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.update(emailCodes).set({ usedAt: now })
    .where(and(eq(emailCodes.userId, userId), eq(emailCodes.purpose, purpose), isNull(emailCodes.usedAt)));
  await db.insert(emailCodes).values({ userId, purpose, codeHash: hashCode(userId, code), expiresAt: new Date(now.getTime() + TTL_MS), createdAt: now });
  return code;
}

export async function consumeCode(db: Db, userId: string, purpose: CodePurpose, code: string, now: Date){
  const [c] = await db.select().from(emailCodes)
    .where(and(eq(emailCodes.userId, userId), eq(emailCodes.purpose, purpose), isNull(emailCodes.usedAt)))
    .orderBy(desc(emailCodes.createdAt)).limit(1);
  if (!c) throw new ApiError(400, 'code_invalid', 'That code is not valid. Request a new one.');
  if (c.expiresAt <= now) throw new ApiError(400, 'code_expired', 'That code has expired. Request a new one.');
  if (c.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes. Request a new one.');
  if (c.codeHash !== hashCode(userId, code.trim())){
    await db.update(emailCodes).set({ attempts: sql`${emailCodes.attempts} + 1` }).where(eq(emailCodes.id, c.id));
    throw new ApiError(400, 'code_invalid', 'That code is not right. Check the email and try again.');
  }
  await db.update(emailCodes).set({ usedAt: now }).where(eq(emailCodes.id, c.id));
}
