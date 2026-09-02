import { timingSafeEqual } from 'node:crypto';

import { Router } from 'express';

import { env } from '../config/env.js';
import { runScheduledLeadPipelines } from '../lead-intelligence/pipeline/scheduler.js';
import { createDailySummary } from '../services/daily-summary.js';
import { logger } from '../utils/logger.js';

export const cronRouter = Router();

function sameSecret(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

cronRouter.use((request, response, next) => {
  if (!env.CRON_SECRET) {
    logger.error('Cron route is disabled because CRON_SECRET is not configured');
    response.status(503).json({ error: 'Cron route is not configured' });
    return;
  }

  const bearer = request.header('authorization');
  const headerSecret = request.header('x-cron-secret');
  const supplied = bearer?.startsWith('Bearer ') ? bearer.slice(7) : headerSecret;
  if (!supplied || !sameSecret(supplied, env.CRON_SECRET)) {
    logger.warn({ attempted: 'daily_summary' }, 'Rejected unauthenticated cron request');
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
});

cronRouter.post('/daily-summary', async (_request, response) => {
  try {
    const summary = await createDailySummary();
    response.status(summary.slackSent ? 200 : 502).json(summary);
  } catch (error: unknown) {
    logger.error({ err: error, attempted: 'daily_summary' }, 'Daily summary job failed');
    response.status(500).json({ error: 'Daily summary job failed' });
  }
});

cronRouter.post('/lead-intelligence', async (_request, response) => {
  try {
    const result = await runScheduledLeadPipelines();
    response.status(result.failures.length ? 207 : 200).json(result);
  } catch (error: unknown) {
    logger.error(
      { err: error, attempted: 'lead_intelligence_pipeline' },
      'Lead pipeline job failed',
    );
    response.status(500).json({ error: 'Lead pipeline job failed' });
  }
});
