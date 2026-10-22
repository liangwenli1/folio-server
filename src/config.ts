const env = process.env;

export const config = {
  port: Number(env.PORT ?? 47110),
  host: env.HOST ?? '0.0.0.0',
  databaseUrl: env.DATABASE_URL ?? 'postgres://folio:folio@folio-postgres:5432/folio',
  // Origins of the marketing site allowed to call the API with the session cookie.
  siteOrigins: (env.SITE_ORIGINS ?? 'http://localhost:47120,http://127.0.0.1:47120').split(',').map(s => s.trim()),
  siteUrl: env.SITE_URL ?? 'http://localhost:47120',
  cookieSecure: env.COOKIE_SECURE === '1',
  cookieDomain: env.COOKIE_DOMAIN || undefined,
  // Mock card payments. Off unless explicitly enabled; there is no real gateway yet.
  mockPayments: env.MOCK_PAYMENTS === '1',
  // Dev-only helpers (advancing subscriptions by hand). Never enable in production.
  devTools: env.DEV_TOOLS === '1',
  // Outgoing mail. Development sends to the local Mailpit inbox; production must set both.
  smtpUrl: env.SMTP_URL ?? 'smtp://folio-mailpit:1025',
  mailFrom: env.MAIL_FROM ?? 'Folio <no-reply@folio.test>',
  // S3-compatible object storage for saved sign-in state. Development uses the local MinIO container.
  s3: {
    endpoint: env.S3_ENDPOINT ?? 'http://folio-minio:9000',
    region: env.S3_REGION ?? 'us-east-1',
    bucket: env.S3_BUCKET ?? 'folio-dev',
    accessKeyId: env.S3_ACCESS_KEY_ID ?? 'folio',
    secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? 'folio-dev-secret',
    forcePathStyle: (env.S3_FORCE_PATH_STYLE ?? '1') === '1'
  },
  authRateLimit: Number(env.AUTH_RATE_LIMIT ?? 20),
  // Which reverse proxies may set X-Forwarded-For (e.g. "10.0.0.5" or "10.0.0.0/8"). Off by default, so the header cannot be forged.
  trustProxy: env.TRUST_PROXY || false,
  // 32-byte key, base64, for proxy passwords. Required in production.
  secretKey: env.SECRET_KEY ?? '',
  geoipDb: env.GEOIP_DB ?? '',
  // Dev only: treat private and loopback addresses as this city, so proxy checks work on a local network.
  devPrivateGeo: env.DEV_PRIVATE_GEO ?? ''
};

export type Config = typeof config;

if (env.NODE_ENV === 'production' && config.devTools){
  throw new Error('DEV_TOOLS must not be enabled in production');
}
if (env.NODE_ENV === 'production' && !config.secretKey){
  throw new Error('SECRET_KEY is required in production');
}
if (env.NODE_ENV === 'production' && (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY)){
  throw new Error('S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required in production');
}
if (env.NODE_ENV === 'production' && (!env.SMTP_URL || !env.MAIL_FROM)){
  throw new Error('SMTP_URL and MAIL_FROM are required in production');
}
