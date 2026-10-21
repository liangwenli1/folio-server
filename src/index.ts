import { buildApp } from './app.js';
import { config } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { processDue } from './billing/service.js';

const { db } = createDb(config.databaseUrl);
await runMigrations(db);
const clock = { now: () => new Date() };
const app = await buildApp({ db, config, clock });
await app.listen({ port: config.port, host: config.host });

// Trial ends, cancellations and renewals.
setInterval(() => {
  processDue(db, clock.now(), { renew: config.mockPayments }).catch(err => app.log.error(err, 'processing due subscriptions failed'));
}, 60_000).unref();
