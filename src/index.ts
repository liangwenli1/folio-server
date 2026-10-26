import { buildApp } from './app.js';
import { config } from './config.js';
import { createDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { processDue } from './billing/service.js';
import { createMailer } from './mail.js';
import { createStorage } from './storage.js';
import { forgetOld } from './activity/service.js';
import { purgeExpired } from './profiles/service.js';

const { db } = createDb(config.databaseUrl);
await runMigrations(db);
const clock = { now: () => new Date() };
const storage = await createStorage(config);
const app = await buildApp({ db, config, clock, mailer: createMailer(config), storage });
await app.listen({ port: config.port, host: config.host });

// Trial ends, cancellations and renewals.
setInterval(() => {
  processDue(db, clock.now(), { renew: config.mockPayments }).catch(err => app.log.error(err, 'processing due subscriptions failed'));
}, 60_000).unref();

// Daily: activity older than each plan's retention, and profiles kept in the Trash longer than their workspace says.
setInterval(() => {
  forgetOld(db, clock.now()).catch(err => app.log.error(err, 'clearing old activity failed'));
  purgeExpired(db, storage, clock.now()).catch(err => app.log.error(err, 'emptying old Trash failed'));
}, 86_400_000).unref();
