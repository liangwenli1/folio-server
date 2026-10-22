import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, jsonSchemaTransformObject, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { ApiError } from './errors.js';
import type { Deps } from './http.js';
import { authRoutes } from './auth/routes.js';
import { workspaceRoutes } from './workspaces/routes.js';
import { billingRoutes } from './billing/routes.js';
import { salesRoutes } from './sales/routes.js';
import { devRoutes } from './dev/routes.js';
import { profileRoutes } from './profiles/routes.js';
import { proxyRoutes } from './proxies/routes.js';
import { netRoutes } from './net/routes.js';
import { syncRoutes } from './sync/routes.js';
import { teamRoutes } from './team/routes.js';
import { activityRoutes } from './activity/routes.js';
import { transferRoutes } from './transfer/routes.js';
import { flowRoutes } from './flows/routes.js';

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}){
  const app = Fastify({ logger: opts.logger ?? true, trustProxy: deps.config.trustProxy });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(cors, { origin: deps.config.siteOrigins, credentials: true });
  await app.register(rateLimit, { global: false });
  await app.register(swagger, { openapi: { info: { title: 'Folio API', version: '1.0.0' } }, transform: jsonSchemaTransform, transformObject: jsonSchemaTransformObject });

  // Every error leaves as { error: { code, message } }.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return reply.code(err.status).send({ error: { code: err.code, message: err.message } });
    if (hasZodFastifySchemaValidationErrors(err)){
      return reply.code(400).send({ error: { code: 'validation', message: 'Some fields are missing or not valid', issues: err.validation } });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many attempts. Wait a minute and try again.' } });
    if (status && status < 500) return reply.code(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    req.log.error(err);
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on our side' } });
  });

  authRoutes(app, deps);
  workspaceRoutes(app, deps);
  billingRoutes(app, deps);
  salesRoutes(app, deps);
  profileRoutes(app, deps);
  proxyRoutes(app, deps);
  netRoutes(app, deps);
  syncRoutes(app, deps);
  teamRoutes(app, deps);
  activityRoutes(app, deps);
  transferRoutes(app, deps);
  flowRoutes(app, deps);
  if (deps.config.devTools) devRoutes(app, deps);

  app.get('/health', { schema: { hide: true } }, async () => ({ ok: true }));
  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  return app;
}
