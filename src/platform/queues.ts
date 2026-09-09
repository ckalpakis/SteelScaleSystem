import { Queue, Worker } from 'bullmq';
import { queueConnection, queuePrefix } from './config.js';
import { logger } from '../utils/logger.js';

export const lanes = [
  'events',
  'agents',
  'integrations',
  'communications',
  'schedules',
  'legacy_sms',
  'pipelines',
  'maintenance',
] as const;
export type Lane = (typeof lanes)[number];
export const jobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 1000 },
  removeOnComplete: { count: 100 },
  removeOnFail: false,
} as const;

/** Redis contains wake-ups only; durable tenant payloads, due times and idempotency stay in PG. */
export async function startQueues(
  processLane: (lane: Lane) => Promise<void>,
  enabled: readonly Lane[] = lanes,
) {
  const connection = queueConnection(),
    prefix = queuePrefix();
  const queues: Queue[] = [],
    workers: Worker[] = [];
  const completedAt = new Map<Lane, number>();
  try {
    for (const lane of enabled) {
      const queue = new Queue(`work-${lane}`, { connection, prefix });
      queues.push(queue);
      queue.on('error', () => logger.error({ lane }, 'Queue connection error'));
      await queue.waitUntilReady();
      await queue.setGlobalConcurrency(1);
      await queue.upsertJobScheduler(
        `poll-${lane}`,
        { every: lane === 'schedules' ? 30000 : 1000 },
        { name: lane, data: { schemaVersion: 1 }, opts: jobOptions },
      );
      const worker = new Worker(
        `work-${lane}`,
        async (job) => {
          if (job.name !== lane) throw new Error('Unregistered queue job');
          try {
            await processLane(lane);
            completedAt.set(lane, Date.now());
          } catch {
            throw new Error('lane_processing_failed');
          }
        },
        { connection, prefix, concurrency: 1, lockDuration: 60000, maxStalledCount: 1 },
      );
      workers.push(worker);
      worker.on('error', () => logger.error({ lane }, 'Worker connection error'));
      worker.on('failed', (job) =>
        logger.error(
          { lane, queueJobId: job?.id, attempt: job?.attemptsMade },
          'Queue tick failed; retained after retry exhaustion',
        ),
      );
      worker.on('stalled', (jobId) =>
        logger.warn(
          { lane, queueJobId: jobId },
          'Queue tick stalled; domain leases protect replay',
        ),
      );
      await worker.waitUntilReady();
    }
  } catch (error) {
    await Promise.allSettled(workers.map((w) => w.close(true)));
    await Promise.allSettled(queues.map((q) => q.close()));
    throw error;
  }
  return {
    async ready() {
      await Promise.all(queues.map((queue) => queue.getJobCounts('active')));
      for (const lane of enabled.filter(
        (l) => !['pipelines', 'maintenance', 'legacy_sms'].includes(l),
      )) {
        if (!completedAt.has(lane) || Date.now() - completedAt.get(lane)! > 180000)
          throw new Error('Worker lane stale');
      }
    },
    async close() {
      await Promise.all(workers.map((worker) => worker.close()));
      await Promise.all(queues.map((queue) => queue.close()));
    },
  };
}
