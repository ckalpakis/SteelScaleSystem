import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

import { logger } from '../utils/logger.js';
import { databaseUrl } from '../platform/config.js';

export const db = new PrismaClient({
  ...(process.env.DATABASE_URL ? { datasourceUrl: databaseUrl(process.env.DATABASE_URL) } : {}),
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

db.$on('error', (event) => {
  // Prisma validation errors can include entire JSON inputs and conversation history.
  // Demo and workforce data must not reach logs even when a query fails.
  const safe =
    /background|communication|knowledge|recovery|salesdemo|workforce|organization|crm|contact|company|opportunity|pipeline|estimate|appointment|task|note|conversation|message|tag|customfield|externalconnection|externalrecordmapping|businessevent|auditlog|webhookendpoint|outbounddelivery|outboundattempt|integrationactivity|agent|humanapproval|user/i.test(
      `${event.target} ${event.message}`,
    )
      ? {
          target: 'private-domain',
          timestamp: event.timestamp,
          message: 'Private database operation failed (details redacted)',
        }
      : event;
  logger.error({ prisma: safe }, 'Database error');
});

db.$on('warn', (event) => {
  const safe =
    /background|communication|knowledge|recovery|salesdemo|workforce|organization|crm|contact|company|opportunity|pipeline|estimate|appointment|task|note|conversation|message|tag|customfield|externalconnection|externalrecordmapping|businessevent|auditlog|webhookendpoint|outbounddelivery|outboundattempt|integrationactivity|agent|humanapproval|user/i.test(
      `${event.target} ${event.message}`,
    )
      ? {
          target: 'private-domain',
          timestamp: event.timestamp,
          message: 'Private database warning (details redacted)',
        }
      : event;
  logger.warn({ prisma: safe }, 'Database warning');
});
