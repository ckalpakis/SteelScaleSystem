import pino from 'pino';

import { env } from '../config/env.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'steel-scale-system' },
  redact: {
    paths: ['req.headers.authorization', '*.apiKey', '*.authToken'],
    censor: '[REDACTED]',
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});
