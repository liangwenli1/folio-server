import type { FastifyBaseLogger } from 'fastify';
import type { CodePurpose } from './codes.js';

// Development mailer: logs the code and keeps the latest one per address for the dev-tools endpoint.
// No email provider is chosen yet (PLAN.md risk 4); production refuses to start with this mailer.
const latest = new Map<string, { purpose: CodePurpose; code: string }>();

export const mailer = {
  async sendCode(log: FastifyBaseLogger, to: string, purpose: CodePurpose, code: string){
    if (process.env.NODE_ENV === 'production') throw new Error('No email provider configured');
    latest.set(to, { purpose, code });
    log.info({ to, purpose, code }, 'email code (dev mailer, not sent)');
  },
  latest: (email: string) => latest.get(email) ?? null
};
