import { PrismaClient } from '@prisma/client';

import { logger } from '../utils/logger.js';

export const db = new PrismaClient({
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

db.$on('error', (event) => {
  // Prisma validation errors can include entire JSON inputs and conversation history.
  // Demo data must not reach logs even when a query fails.
  const safe = /salesdemo/i.test(`${event.target} ${event.message}`)
    ? {
        target: 'sales-demo',
        timestamp: event.timestamp,
        message: 'Demo database operation failed (details redacted)',
      }
    : event;
  logger.error({ prisma: safe }, 'Database error');
});

db.$on('warn', (event) => {
  const safe = /salesdemo/i.test(`${event.target} ${event.message}`)
    ? {
        target: 'sales-demo',
        timestamp: event.timestamp,
        message: 'Demo database warning (details redacted)',
      }
    : event;
  logger.warn({ prisma: safe }, 'Database warning');
});
