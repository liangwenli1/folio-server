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
| `DEV_TOOLS` | off | `/dev/mail` (latest email code) and `/dev/run-due`. Refused when `NODE_ENV=production` |
| `SECRET_KEY` | development key | 32 bytes, base64, for encrypting proxy passwords. Required in production |
| `TRUST_PROXY` | off | Address or CIDR of the reverse proxy allowed to set `X-Forwarded-For`. Leave unset when clients connect directly, or the header can be forged |
| `GEOIP_DB` | unset | Path to the DB-IP City Lite `.mmdb` file (https://db-ip.com/db/download/ip-to-city-lite, CC BY 4.0; show "IP Geolocation by DB-IP" wherever locations appear). Without it, exit locations are unknown |
| `DEV_PRIVATE_GEO` | unset | Dev only: `seattle`, `london`, `tokyo` or `frankfurt`, used as the location of private and loopback addresses so proxy checks work on a local network |

Email: no provider is connected yet. Codes are written to the server log; production refuses to start with the development mailer.

## Mock payments

| Card number | Result |
|---|---|
| `4000 0000 0000 0002` | Declined |
| `4000 0000 0000 9995` | Insufficient funds |
| Any other number passing the Luhn check, e.g. `4242 4242 4242 4242` | Succeeds |

## Scripts

| Script | What it does |
|---|---|
| `npm test` | Integration tests against a real PostgreSQL (`folio_test` database, recreated each run) |
| `npm run typecheck` | TypeScript check |
| `npm run db:generate` | New migration from `src/db/schema.ts` |
| `npm run openapi` | Regenerates `openapi.json` |

## Profiles and proxies

- Profiles are numbered per workspace (`#0001`). Profiles in the trash do not count toward the plan; creating, importing and restoring check the limit inside a transaction that locks the workspace.
- Edits carry the version the client last saw; a newer version on the server returns `409 stale`.
- Proxy passwords are encrypted at rest. They are returned only by `GET /profiles/:id/launch` and `GET /proxies/:id/credentials`, which the desktop app keeps out of its renderer.
- `GET /net/echo` returns the caller's address and location. The desktop calls it through a profile's proxy to learn the exit IP, time zone and language, then reports the result with `POST /proxies/:id/check`.
- `GET /workspaces/:id/events` is a server-sent event stream: `change` events say which kind of data changed (`profiles`, `proxies`, `groups`, `workspace`). Events are in-process; more than one server instance needs PostgreSQL LISTEN/NOTIFY.

## Billing rules

- Plans: Free (5 profiles, 1 member), Studio ($29/mo, 100 profiles), Company ($99/mo, 500 profiles). Yearly is 20% off. Extra profiles come in packs of 100 ($15/mo), up to 2,000 profiles.
- New subscriptions and upgrades start a new period right away; an upgrade credits the unused part of the current plan.
- Extra packs bought mid-period are prorated. Removing packs takes effect immediately with no refund.
- Downgrades and cancellations take effect at the end of the period.
- Studio has a 7-day trial, once per workspace.
- The most recent payment can be refunded within 7 days; the subscription returns to what it was before that payment.
- Every money movement goes through `applyPaymentEvent` in `src/billing/service.ts`. A real gateway's webhooks should map onto the same events.
