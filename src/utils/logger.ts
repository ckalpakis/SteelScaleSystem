import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: {
    service: 'steel-scale-system',
    role: process.env.SERVICE_ROLE ?? 'web',
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID,
  },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'req.headers["x-api-key"]',
      'req.headers["x-cron-secret"]',
      '*.apiKey',
      '*.authToken',
      '*.password',
      '*.secret',
      '*.encryptedCredentials',
      'body',
      'payload',
    ],
    censor: '[REDACTED]',
  },
  ...(process.env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }
    : {}),
});
