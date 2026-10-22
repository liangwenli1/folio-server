# folio-server

Accounts, workspaces, subscriptions and sync for Folio. The site (folio-site) and the desktop workbench (folio-desktop) both talk to this API.

## Stack

Node 24, TypeScript, Fastify, Drizzle ORM, PostgreSQL 16. Request and response shapes are zod schemas; `openapi.json` is generated from them and is the contract the other two repos generate their API types from.

## Run locally

```sh
npm install
export DATABASE_URL=postgres://folio:folio@localhost:5432/folio
DEV_TOOLS=1 MOCK_PAYMENTS=1 npm run dev     # http://localhost:47110, applies migrations on start
```

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | `postgres://folio:folio@folio-postgres:5432/folio` | PostgreSQL connection |
| `PORT` | `47110` | HTTP port |
| `SITE_ORIGINS` | `http://localhost:47120,http://127.0.0.1:47120` | Site origins allowed to call the API with the session cookie |
| `SITE_URL` | `http://localhost:47120` | Public site URL |
| `COOKIE_SECURE` / `COOKIE_DOMAIN` | off / unset | Set both in production (e.g. `COOKIE_DOMAIN=.example.com`) |
| `MOCK_PAYMENTS` | off | Enables the mock card gateway and renewals. There is no real gateway yet |
| `DEV_TOOLS` | off | `/dev/run-due` (process trial ends and renewals now). Refused when `NODE_ENV=production` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET` | `http://folio-minio:9000`, `us-east-1`, `folio-dev` | Object storage for saved sign-in state: AWS S3, Cloudflare R2, Aliyun OSS or any S3-compatible service. Development creates the bucket; in production it must exist and `S3_BUCKET` is required |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | development keys | Required in production |
| `S3_FORCE_PATH_STYLE` | `1` | `0` for services that want bucket-named hosts |
| `SMTP_URL` | `smtp://folio-mailpit:1025` | Outgoing mail, any SMTP provider (e.g. `smtps://user:pass@smtp.example.com:465`). Required in production |
| `MAIL_FROM` | `Folio <no-reply@folio.test>` | Sender address; its domain needs SPF and DKIM set up with the provider. Required in production |
| `SECRET_KEY` | development key | 32 bytes, base64, for encrypting proxy passwords. Required in production |
| `TRUST_PROXY` | off | Address or CIDR of the reverse proxy allowed to set `X-Forwarded-For`. Leave unset when clients connect directly, or the header can be forged |
| `GEOIP_DB` | unset | Path to the DB-IP City Lite `.mmdb` file (https://db-ip.com/db/download/ip-to-city-lite, CC BY 4.0; show "IP Geolocation by DB-IP" wherever locations appear). Without it, exit locations are unknown |
| `DEV_PRIVATE_GEO` | unset | Dev only: `seattle`, `london`, `tokyo` or `frankfurt`, used as the location of private and loopback addresses so proxy checks work on a local network |

Email: verification codes and password resets go out over SMTP (`src/mail.ts`), in the recipient's language. If a verification email cannot be sent, sign-up still succeeds and the verify page can send it again; password resets always answer 204 so they do not reveal whether an account exists. In development, mail goes to a local [Mailpit](https://mailpit.axllent.org) inbox:

```sh
docker run -d --name folio-mailpit --network folio-dev -p 127.0.0.1:47125:8025 axllent/mailpit:v1.27   # inbox at http://127.0.0.1:47125
```

Object storage in development is a local MinIO container (MinIO no longer publishes images on Docker Hub; this machine uses `quay.io/minio/minio` RELEASE.2025-09-07, and any S3-compatible service works):

```sh
docker run -d --name folio-minio --network folio-dev -e MINIO_ROOT_USER=folio -e MINIO_ROOT_PASSWORD=folio-dev-secret -v folio-minio-data:/data quay.io/minio/minio server /data
```

## Mock payments

| Card number | Result |
|---|---|
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Insufficient funds |
| Any other number passing the Luhn check, e.g. `4242 4242 4242 4242` | Succeeds |

## Scripts

| Script | What it does |
|---|---|
| `npm test` | Integration tests against a real PostgreSQL (`folio_test` database, recreated each run). Emails go to Mailpit, read back through its API (`MAILPIT_URL`, default `http://folio-mailpit:8025`) |
| `npm run typecheck` | TypeScript check |
| `npm run db:generate` | New migration from `src/db/schema.ts` |
| `npm run openapi` | Regenerates `openapi.json` |

## Profiles and proxies

- Profiles are numbered per workspace (`#0001`). Profiles in the trash do not count toward the plan; creating, importing and restoring check the limit inside a transaction that locks the workspace.
- Edits carry the version the client last saw; a newer version on the server returns `409 stale`.
- Proxy passwords are encrypted at rest. They are returned only by `GET /profiles/:id/launch` and `GET /proxies/:id/credentials`, which the desktop app keeps out of its renderer.
- `GET /net/echo` returns the caller's address and location. The desktop calls it through a profile's proxy to learn the exit IP, time zone and language, then reports the result with `POST /proxies/:id/check`.
- Opening a profile takes its lock (`POST /profiles/:id/lock`, with `via: 'api'` when a script opened it through the desktop app's local API, which the activity log notes), so one computer has it open at a time. The desktop renews it every 30 seconds; a lock not renewed for 90 seconds is free again. Owners and admins can take a profile over (`POST /profiles/:id/lock/takeover`); the computer that had it finds out at its next renewal and closes it. Profile listings show who has each one open (`lock`, with `self` for the asking session).
- Saved sign-in state (`GET`/`PUT /profiles/:id/data`) is gzip-compressed JSON in Playwright's storage-state format: cookies, local storage and IndexedDB. Only the session holding the lock can upload. It is sealed with `SECRET_KEY` (AES-256-GCM) before it goes to object storage; only the latest version is kept, up to 50 MB.
- Cookies: `GET /profiles/:id/cookies` returns the saved cookies for export, to owners and admins only (members open signed-in profiles without being able to take the sign-ins away). `POST /profiles/:id/cookies` merges cookies into the saved state (same name, domain and path replaces) for anyone who sees the profile, unless another computer has it open. Both are logged.
- A profile with `syncMode: 'local'` keeps its sign-ins on the computer that uses it: switching to it deletes the saved state, and uploads and cookie transfers answer `409 local_only`.
- `GET /workspaces/:id/events` is a server-sent event stream: `change` events say which kind of data changed (`profiles`, `proxies`, `groups`, `workspace`, `members`, `flows`, `tasks`, `runs`). Events are in-process; more than one server instance needs PostgreSQL LISTEN/NOTIFY.

## Teams

- Roles: the owner (one per workspace), admins and members. Owners and admins see and manage everything. Members see the profiles assigned to them (`ownerId`, set to whoever creates a profile) and, on Company, those of their departments; anyone else's profile answers 404. Members can create and edit profiles and use the proxy library, but cannot delete, assign, manage groups or proxies, or take over a lock.
- Seats: Free has one (the owner); Studio and Company have no limit. Open invitations hold a seat.
- Invitations (`POST /workspaces/:id/invitations`) are emailed with a link to the site's `/invite/` page and also returned, so they can be passed on another way. Only the invited address, verified, can accept. Inviting the same address again replaces the earlier invitation; they expire after 7 days.
- Removing someone (`DELETE /workspaces/:id/members/:userId?transferTo=…`) hands their profiles to `transferTo`, drops their department memberships and open locks, and ends their change stream with a `removed` event. Leaving (`POST /workspaces/:id/leave`) hands them to the owner.
- Departments are a Company feature; deleting one leaves its profiles without a department.

## Activity log

- `src/activity/service.ts` writes every entry: profile changes (only the fields that actually changed), moving to and from the Trash, opening, closing and takeovers, proxies, groups, invitations, members and departments. Each entry keeps who, on which computer, when, and the profile's name and number at the time, so entries still read right after renames and deletions.
- `GET /workspaces/:id/activity` pages back by `seq` (`before=`), filtered by profile, person or kind. Members see entries about the profiles they see and their own actions. Entries older than the plan's retention (Free 7 days, Studio 30, Company 365) are not returned and are deleted once a day.
- `GET /workspaces/:id/activity.csv` exports the retained log on Company, for owners and admins.

## Workspace export and import

- `GET /workspaces/:id/export` (owners and admins) lists every profile outside the Trash with its fingerprint and settings, the groups, and the proxies with their passwords. The desktop adds each profile's saved state and encrypts the file with a passphrase the server never sees.
- `POST /workspaces/:id/import` (owners and admins) recreates such a list in a workspace: groups by name, identical proxies reused, profiles numbered anew and assigned to the importer, after checking the plan has room for all of them. It returns each profile's new id; the saved states go up as each profile's first save, which needs no lock when nobody has the profile open.

## Automation flows

- A flow is a list of steps (`src/flows/steps.ts`): open, click, type, press, wait, scroll, extract, set, if, loop, screenshot and script. `if` and `loop` hold steps of their own, up to four levels deep and 300 steps in all. The desktop app runs them.
- Flows belong to the workspace: everyone in it sees them and can create one. The creator, admins and the owner change and delete it (`canEdit` in the listing). Edits carry the version, like profiles. Changes are logged and pushed as `flows` change events.
- A task runs a flow on a set of profiles, a few at a time (`concurrency`), with `retries` and a time limit per profile. Everyone creates tasks; members only with profiles they see, and edits keep the task's profiles they no longer see. Per-profile variables are sealed with `SECRET_KEY` and returned only to people who may edit the task (`GET /tasks/:id/variables`) or, for the profiles they see, to whoever starts a run. A flow used by a task cannot be deleted (`409 flow_in_use`).
- A task can run on a schedule (`schedule`: once at a time, or daily at a local time on chosen weekdays) on one computer: the desktop app that set it, identified by the install id it sends when logging in (`sessions.deviceId`), or another one moved there with `runHere`. That app asks for its schedules (`GET /me/schedules`, with `since`: times after it are still to handle), starts each run with `trigger: 'schedule'` and its `scheduledFor` time, and records times it missed (`POST /tasks/:id/missed`). Each scheduled time is used once (a unique index on the task and the time); one that comes while a run still goes is recorded as `busy`.
- `POST /tasks/:id/runs` starts a run in the caller's desktop app: it returns the task's settings, the flow's steps and each profile with its variables. One run of a task at a time (`409 task_running`). The app reports each profile (`POST /runs/:id/items/:profileId`), sends a heartbeat every minute and finishes the run; a run with no report for 15 minutes counts as interrupted and no longer blocks the task. Runs and their results are listed for everyone, rows limited to the profiles each person sees, kept for the plan's log retention, and pushed as `tasks` and `runs` change events.

## Billing rules

- Plans: Free (5 profiles, 1 member), Studio ($29/mo, 100 profiles), Company ($99/mo, 500 profiles). Yearly is 20% off. Extra profiles come in packs of 100 ($15/mo), up to 2,000 profiles.
- New subscriptions and upgrades start a new period right away; an upgrade credits the unused part of the current plan.
- Extra packs bought mid-period are prorated. Removing packs takes effect immediately with no refund.
- Downgrades and cancellations take effect at the end of the period.
- Studio has a 7-day trial, once per workspace.
- The most recent payment can be refunded within 7 days; the subscription returns to what it was before that payment.
- Every money movement goes through `applyPaymentEvent` in `src/billing/service.ts`. A real gateway's webhooks should map onto the same events.
