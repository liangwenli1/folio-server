import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { docFeedback, salesInquiries } from '../src/db/schema.js';
import { setup } from './helpers.js';

let t: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.teardown(); });

const post = (url: string, payload: object) => t.app.inject({ method: 'POST', url, payload });

describe('the website’s forms', () => {
  it('number each inquiry in turn, keeping what it was about', async () => {
    const a = await post('/sales-inquiries', { kind: 'support', name: 'Ava', email: 'Ava@Example.com', teamSize: '6–20', message: 'Proxy checks fail', locale: 'en' });
    expect(a.statusCode).toBe(201);
    const b = await post('/sales-inquiries', { kind: 'product', name: '林晓', email: 'lin@example.com', teamSize: '1–5', message: '想了解价格', locale: 'zh' });
    expect(b.json().number).toBe(a.json().number + 1);
    const [row] = await t.db.select().from(salesInquiries).where(eq(salesInquiries.number, a.json().number));
    expect(row).toMatchObject({ kind: 'support', email: 'ava@example.com', teamSize: '6–20', message: 'Proxy checks fail' });
    // What it is about is one of three, and the description is kept short.
    expect((await post('/sales-inquiries', { kind: 'other', name: 'x', email: 'x@example.com', teamSize: '1–5', message: 'm' })).statusCode).toBe(400);
    expect((await post('/sales-inquiries', { kind: 'product', name: 'x', email: 'x@example.com', teamSize: '1–5', message: 'm'.repeat(501) })).statusCode).toBe(400);
  });

  it('keep whether a help article helped', async () => {
    expect((await post('/doc-feedback', { page: 'create-profile', helpful: true, locale: 'zh' })).statusCode).toBe(201);
    expect((await post('/doc-feedback', { page: 'create-profile', helpful: false })).statusCode).toBe(201);
    expect((await post('/doc-feedback', { page: '../etc', helpful: false })).statusCode).toBe(400);
    const rows = await t.db.select().from(docFeedback).where(eq(docFeedback.page, 'create-profile'));
    expect(rows.map(r => [r.helpful, r.locale]).sort()).toEqual([[false, 'en'], [true, 'zh']]);
  });
});
