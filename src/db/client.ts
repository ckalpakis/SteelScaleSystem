import { PrismaClient } from '@prisma/client';

import { logger } from '../utils/logger.js';

export const db = new PrismaClient({
  log: [
    { emit: 'event', level: 'error' },
    { emit: 'event', level: 'warn' },
  ],
});

db.$on('error', (event) => {
  logger.error({ prisma: event }, 'Database error');
});

db.$on('warn', (event) => {
  logger.warn({ prisma: event }, 'Database warning');
});
