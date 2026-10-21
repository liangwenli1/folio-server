import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Db } from './client.js';

const folder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(db: Db){
  await migrate(db, { migrationsFolder: folder });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])){
  const { createDb } = await import('./client.js');
  const { config } = await import('../config.js');
  const { db, close } = createDb(config.databaseUrl);
  await runMigrations(db);
  await close();
  console.log('migrations applied');
}
