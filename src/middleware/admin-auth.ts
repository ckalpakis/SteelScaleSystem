import { timingSafeEqual } from 'node:crypto';

import type { RequestHandler } from 'express';

import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';

function safeEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export const requireAdminAuth: RequestHandler = (request, response, next) => {
  if (!env.ADMIN_USERNAME || !env.ADMIN_PASSWORD) {
    logger.error('Admin credentials are not configured');
    response.status(503).send('Admin panel is not configured.');
    return;
  }

  const authorization = request.header('authorization');
  if (authorization?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(authorization.slice(6), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (
        separator >= 0 &&
        safeEqual(decoded.slice(0, separator), env.ADMIN_USERNAME) &&
        safeEqual(decoded.slice(separator + 1), env.ADMIN_PASSWORD)
      ) {
        next();
        return;
      }
    } catch {
      // Invalid Basic auth is handled by the challenge below.
    }
  }

  response.setHeader('WWW-Authenticate', 'Basic realm="Steel Scale Admin", charset="UTF-8"');
  response.status(401).send('Authentication required.');
};
