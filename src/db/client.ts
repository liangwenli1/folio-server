import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema.js';

export function createDb(url: string){
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle({ client, schema, casing: 'snake_case' });
  return { db, close: () => client.end() };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
