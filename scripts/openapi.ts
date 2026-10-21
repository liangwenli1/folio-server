// Writes openapi.json, the contract folio-site and folio-desktop generate their API types from.
import { writeFile } from 'node:fs/promises';
import { buildApp } from '../src/app.js';
import { config } from '../src/config.js';
import { createDb } from '../src/db/client.js';

const { db, close } = createDb(config.databaseUrl);
const app = await buildApp({ db, config: { ...config, devTools: false }, clock: { now: () => new Date() } }, { logger: false });
await app.ready();
await writeFile('openapi.json', JSON.stringify(app.swagger(), null, 2) + '\n');
await app.close();
await close();
console.log('openapi.json written');
