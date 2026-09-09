import express from 'express';
import { env } from '../../config/env.js';
import { db } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { workOnce } from './queue.js';
import { scheduleRecoveryScans } from './scheduler.js';
import { deliverOnce } from '../../integrations/worker.js';
import { runOnce } from '../../agents/runtime.js';
import { scheduleAgents } from '../../agents/scheduler.js';
import { scanRecovery } from '../../recovery/orchestrator.js';
import { sendOnce } from '../../communications/worker.js';

import { startQueues, type Lane } from '../../platform/queues.js';
import {
  backgroundOnce,
  durableBackground,
  reconcilePendingPipelines,
} from '../../platform/background.js';
import { databaseReady, healthRoutes, lifecycle } from '../../platform/health.js';
import { boundedInteger } from '../../platform/config.js';
import { registerConfiguredLeadDiscoveryProviders } from '../../lead-intelligence/providers/register.js';

async function processLane(lane: Lane) {
  if (lifecycle.stopping) return;
  if (lane === 'legacy_sms' || lane === 'pipelines' || lane === 'maintenance') {
    if (durableBackground()) {
      if (lane === 'pipelines') await reconcilePendingPipelines(db);
      await backgroundOnce(
        db,
        undefined,
        new Date(),
        lane === 'pipelines'
          ? ['lead_pipeline']
          : lane === 'legacy_sms'
            ? ['legacy_sms']
            : ['daily_summary', 'scheduled_pipelines'],
      );
    }
    return;
  }
  if (process.env.WORKFORCE_ENABLED !== 'true') return;
  if (lane === 'schedules') {
    await scheduleRecoveryScans(db);
    await scheduleAgents(db);
    await scanRecovery(db);
    return;
  }
  const operation = {
    events: workOnce,
    agents: runOnce,
    integrations: deliverOnce,
    communications: sendOnce,
  }[lane];
  const limit = boundedInteger(process.env.WORKER_BATCH_SIZE, 10, 1, 50);
  const started = Date.now();
  for (let count = 0; count < limit && !lifecycle.stopping; count++) {
    if (!(await operation(db)) || Date.now() - started > 30000) break;
  }
}

async function main() {
  if (process.env.WORKFORCE_WORKER_ENABLED !== 'true') throw new Error('Worker flag required');
  await databaseReady(db);
  registerConfiguredLeadDiscoveryProviders();
  const state: { queues?: Awaited<ReturnType<typeof startQueues>> } = {};
  const app = express();
  app.disable('x-powered-by');
  app.use(
    healthRoutes(async () => {
      await databaseReady(db);
      if (!state.queues) throw new Error('Worker starting');
      await state.queues.ready();
    }),
  );
  const server = app.listen(env.PORT, '0.0.0.0');
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => {
    if (shutdownPromise) return;
    lifecycle.stopping = true;
    logger.info({ component: 'worker' }, 'Draining worker');
    const deadline = setTimeout(
      () => {
        logger.error('Worker shutdown deadline exceeded; durable leases retained');
        process.exit(1);
      },
      boundedInteger(process.env.SHUTDOWN_TIMEOUT_MS, 25000, 1000, 120000),
    );
    deadline.unref();
    shutdownPromise = (async () => {
      await state.queues?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.$disconnect();
      // A Redis connection may still be initializing; keep the hard deadline in that case.
      if (state.queues) clearTimeout(deadline);
    })().catch(() => {
      logger.error('Worker drain failed');
      process.exitCode = 1;
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
  state.queues = await startQueues(processLane);
  if (lifecycle.stopping) await state.queues.close();
  logger.info({ component: 'worker' }, 'Durable worker started');
}

void main().catch(() => {
  logger.error({ component: 'worker' }, 'Worker failed to start');
  process.exit(1);
});
