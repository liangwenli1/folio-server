import { randomInt } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { emailCodes } from '../db/schema.js';
import { ApiError } from '../errors.js';
import { sha256 } from './session.js';

export type CodePurpose = 'signup' | 'verify' | 'reset';
const TTL_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
// The website counts down the same minute before it offers to send another code.
const COOLDOWN_MS = 60_000;

const hashCode = (email: string, code: string) => sha256(`${email}:${code}`);

// A new code for this address, which retires any earlier unused one for the same purpose. Another within a minute is
// refused, whether or not the address has an account, so the answer never says which addresses do.
export async function issueCode(db: Db, email: string, purpose: CodePurpose, now: Date){
  const [last] = await db.select({ at: emailCodes.createdAt }).from(emailCodes)
    .where(and(eq(emailCodes.email, email), eq(emailCodes.purpose, purpose))).orderBy(desc(emailCodes.createdAt)).limit(1);
  if (last && now.getTime() - last.at.getTime() < COOLDOWN_MS) throw new ApiError(429, 'too_soon', 'A code was sent a moment ago. Wait a minute before asking for another.');
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await db.update(emailCodes).set({ usedAt: now })
    .where(and(eq(emailCodes.email, email), eq(emailCodes.purpose, purpose), isNull(emailCodes.usedAt)));
  await db.insert(emailCodes).values({ email, purpose, codeHash: hashCode(email, code), expiresAt: new Date(now.getTime() + TTL_MS), createdAt: now });
  return code;
}

// Whether `code` is the one to use now, without using it up: a wrong one counts toward the limit.
export async function checkCode(db: Db, email: string, purpose: CodePurpose, code: string, now: Date){
  const [c] = await db.select().from(emailCodes)
    .where(and(eq(emailCodes.email, email), eq(emailCodes.purpose, purpose), isNull(emailCodes.usedAt)))
    .orderBy(desc(emailCodes.createdAt)).limit(1);
  if (!c) throw new ApiError(400, 'code_invalid', 'That code is not valid. Request a new one.');
  if (c.expiresAt <= now) throw new ApiError(400, 'code_expired', 'That code has expired. Request a new one.');
  if (c.attempts >= MAX_ATTEMPTS) throw new ApiError(429, 'too_many_attempts', 'Too many wrong codes. Request a new one.');
  if (c.codeHash !== hashCode(email, code.trim())){
    await db.update(emailCodes).set({ attempts: sql`${emailCodes.attempts} + 1` }).where(eq(emailCodes.id, c.id));
    throw new ApiError(400, 'code_invalid', 'That code is not right. Check the email and try again.');
  }
  return c.id;
}

export async function consumeCode(db: Db, email: string, purpose: CodePurpose, code: string, now: Date){
  const id = await checkCode(db, email, purpose, code, now);
  await db.update(emailCodes).set({ usedAt: now }).where(eq(emailCodes.id, id));
}
