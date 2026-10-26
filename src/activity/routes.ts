import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { requireSession, type Deps } from '../http.js';
import { access } from '../profiles/service.js';
import { requireCompany } from '../team/service.js';
import { requirePermission } from '../workspaces/service.js';
import { ACTIONS, KINDS, csvField, readLog } from './service.js';

const params = z.object({ id: z.uuid() });
const Entry = z.object({
  seq: z.number(), at: z.string(), actor: z.string().nullable(), deviceName: z.string().nullable(), action: z.enum(ACTIONS),
  profile: z.object({ id: z.string().nullable(), name: z.string(), number: z.number() }).nullable(), detail: z.record(z.string(), z.unknown())
});
const filters = {
  profileId: z.uuid().optional(), actorId: z.uuid().optional(),
  kind: z.enum(Object.keys(KINDS) as [keyof typeof KINDS, ...(keyof typeof KINDS)[]]).optional()
};

export function activityRoutes(app: FastifyInstance, deps: Deps){
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, clock } = deps;

  // Newest first; pass the last entry's `seq` as `before` for the next page.
  r.get('/workspaces/:id/activity', {
    schema: {
      params, querystring: z.object({ ...filters, before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }),
      response: { 200: z.object({ entries: z.array(Entry), retentionDays: z.number() }) }
    }
  }, async req => {
    const s = await requireSession(req, deps);
    const { scope } = await access(db, req.params.id, s.userId);
    const { days, entries } = await readLog(db, req.params.id, clock.now(), { ...req.query, scope, userId: s.userId });
    return { entries, retentionDays: days };
  });

  // Company: the whole retained log as CSV, for owners and admins.
  r.get('/workspaces/:id/activity.csv', { schema: { params, querystring: z.object(filters) } }, async (req, reply) => {
    const s = await requireSession(req, deps);
    await requirePermission(db, req.params.id, s.userId, 'activity.view');
    await requireCompany(db, req.params.id);
    const { entries } = await readLog(db, req.params.id, clock.now(), { ...req.query, userId: s.userId, limit: 100_000 });
    const lines = [['time', 'person', 'computer', 'action', 'profile number', 'profile', 'details'].join(',')]
      .concat(entries.map(e => [e.at, e.actor, e.deviceName, e.action, e.profile?.number, e.profile?.name, Object.keys(e.detail).length ? e.detail : ''].map(csvField).join(',')));
    return reply.header('content-type', 'text/csv; charset=utf-8').send(lines.join('\n') + '\n');
  });
}
