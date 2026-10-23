// The server's settings, read once at startup from config.yaml in the working directory (/app/config.yaml in the
// image; deploy/config.example.yaml lists every key). Anything left out takes the development default below. Unknown
// keys and wrong values stop the server with the key named, so a typo can't be silently ignored.
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

const FILE = 'config.yaml';
const production = process.env.NODE_ENV === 'production';

const Settings = z.strictObject({
  port: z.number().int().positive().optional(),
  host: z.string().optional(),
  // Folio's public address (the site; the API is under /api behind nginx), and the origins allowed to call the API
  // with the session cookie (by default only that address's).
  site_url: z.url().optional(),
  site_origins: z.array(z.url()).optional(),
  cookie_secure: z.boolean().optional(),
  cookie_domain: z.string().optional(),
  database_url: z.string().optional(),
  // 32 random bytes, base64, for proxy passwords, saved sign-ins and extension signatures. Required in production.
  secret_key: z.string().optional(),
  // S3-compatible object storage for saved sign-in state. Development uses the local MinIO container.
  s3: z.strictObject({
    endpoint: z.url().optional(), region: z.string().optional(), bucket: z.string().optional(),
    access_key_id: z.string().optional(), secret_access_key: z.string().optional(), force_path_style: z.boolean().optional()
  }).optional(),
  // Outgoing mail. Development sends to the local Mailpit inbox; production must set both.
  smtp: z.strictObject({ url: z.string().optional(), from: z.string().optional() }).optional(),
  // Mock card payments. Off unless explicitly enabled; there is no real gateway yet.
  mock_payments: z.boolean().optional(),
  // false on a test server: new accounts count as verified, with no code sent, so made-up addresses work.
  email_verification: z.boolean().optional(),
  // Which reverse proxies may set X-Forwarded-For (e.g. "10.0.0.5", "10.0.0.0/8" or "uniquelocal"). Off by default,
  // so the header cannot be forged.
  trust_proxy: z.string().optional(),
  geoip_db: z.string().optional(),
  auth_rate_limit: z.number().int().positive().optional(),
  // Dev only: advancing subscriptions by hand, and treating private and loopback addresses as this city so proxy
  // checks work on a local network.
  dev_tools: z.boolean().optional(),
  dev_private_geo: z.enum(['seattle', 'london', 'tokyo', 'frankfurt']).optional()
});

function read(): z.infer<typeof Settings> {
  if (!existsSync(FILE)){
    if (production) throw new Error(`${FILE} not found in ${process.cwd()} (deploy/config.example.yaml lists the settings)`);
    return {};
  }
  let raw: unknown;
  try { raw = parse(readFileSync(FILE, 'utf8')) ?? {}; } catch (e){ throw new Error(`${FILE}: ${(e as Error).message}`); }
  const parsed = Settings.safeParse(raw);
  if (!parsed.success) throw new Error(`${FILE}:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const file = read();
const siteUrl = file.site_url?.replace(/\/+$/, '') ?? 'http://localhost:47120';

export const config = {
  port: file.port ?? 47110,
  host: file.host ?? '0.0.0.0',
  databaseUrl: file.database_url ?? 'postgres://folio:folio@folio-postgres:5432/folio',
  siteOrigins: file.site_origins ?? [new URL(siteUrl).origin],
  siteUrl,
  cookieSecure: file.cookie_secure ?? false,
  cookieDomain: file.cookie_domain,
  mockPayments: file.mock_payments ?? false,
  emailVerification: file.email_verification ?? true,
  devTools: file.dev_tools ?? false,
  smtpUrl: file.smtp?.url ?? 'smtp://folio-mailpit:1025',
  mailFrom: file.smtp?.from ?? 'Folio <no-reply@folio.test>',
  s3: {
    endpoint: file.s3?.endpoint ?? 'http://folio-minio:9000',
    region: file.s3?.region ?? 'us-east-1',
    bucket: file.s3?.bucket ?? 'folio-dev',
    accessKeyId: file.s3?.access_key_id ?? 'folio',
    secretAccessKey: file.s3?.secret_access_key ?? 'folio-dev-secret',
    forcePathStyle: file.s3?.force_path_style ?? true
  },
  authRateLimit: file.auth_rate_limit ?? 20,
  trustProxy: file.trust_proxy ?? (false as const),
  secretKey: file.secret_key ?? '',
  geoipDb: file.geoip_db ?? '',
  devPrivateGeo: file.dev_private_geo ?? ''
};

export type Config = typeof config;

if (production){
  const missing = [
    !file.secret_key && 'secret_key',
    !file.s3?.bucket && 's3.bucket', !file.s3?.access_key_id && 's3.access_key_id', !file.s3?.secret_access_key && 's3.secret_access_key',
    !file.smtp?.url && 'smtp.url', !file.smtp?.from && 'smtp.from'
  ].filter(Boolean);
  if (missing.length) throw new Error(`${FILE}: required in production: ${missing.join(', ')}`);
  if (config.devTools) throw new Error(`${FILE}: dev_tools must not be enabled in production`);
}
