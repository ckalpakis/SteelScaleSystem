/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Queue, Worker } from 'bullmq';
import { startQueues, jobOptions } from './queues.js';
import { queueConnection } from './config.js';

const url = new URL(process.env.REDIS_URL ?? 'https://invalid');
if (
  process.env.NODE_ENV !== 'test' ||
  !['redis:', 'rediss:'].includes(url.protocol) ||
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
)
  throw new Error('Redis tests require explicit NODE_ENV=test and loopback REDIS_URL');
process.env.LOG_LEVEL = 'silent';
process.env.QUEUE_PREFIX = `deployment-test-${randomUUID()}`;

async function until(check: () => Promise<boolean> | boolean, timeout = 12000) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('Queue test timed out');
    await delay(50);
  }
}
test('persistent schedulers resume after worker restart without duplicate scheduler registration', async () => {
  let ticks = 0;
  const queue = new Queue('work-events', {
    connection: queueConnection(),
    prefix: process.env.QUEUE_PREFIX,
  });
  let runtime: Awaited<ReturnType<typeof startQueues>> | undefined;
  try {
    runtime = await startQueues(() => {
      ticks++;
      return Promise.resolve();
    }, ['events']);
    await until(() => ticks > 0);
    await runtime.ready();
    await runtime.close();
    runtime = undefined;
    const stoppedAt = ticks;
    await delay(1100);
    assert.equal(ticks, stoppedAt);
    runtime = await startQueues(() => {
      ticks++;
      return Promise.resolve();
    }, ['events']);
    await until(() => ticks > stoppedAt);
    assert.equal((await queue.getJobSchedulers()).length, 1);
    await runtime.ready();
  } finally {
    await runtime?.close();
    await queue.close();
  }
});
test('BullMQ retry/backoff is bounded, failed jobs remain visible and duplicate IDs execute once', async () => {
  const prefix = `deployment-test-${randomUUID()}`,
    connection = queueConnection();
  const queue = new Queue('retry-test', { connection, prefix });
  let calls = 0;
  const worker = new Worker(
    'retry-test',
    () => {
      calls++;
      return Promise.reject(new Error('sanitized_failure'));
    },
    { connection, prefix, concurrency: 1 },
  );
  worker.on('error', () => {});
  try {
    await worker.waitUntilReady();
    const options = {
      ...jobOptions,
      attempts: 3,
      backoff: { type: 'exponential', delay: 100 },
      jobId: 'unique-business-wakeup',
    };
    await Promise.all([
      queue.add('test', { schemaVersion: 1 }, options),
      queue.add('test', { schemaVersion: 1 }, options),
    ]);
    await until(async () => (await queue.getJobCounts('failed')).failed === 1);
    const job = await queue.getJob('unique-business-wakeup');
    assert.equal(calls, 3);
    assert.equal(job?.attemptsMade, 3);
    assert.equal(job?.failedReason, 'sanitized_failure');
    assert.equal(await job?.getState(), 'failed');
    assert.equal(
      job?.opts.backoff && typeof job.opts.backoff === 'object' ? job.opts.backoff.type : '',
      'exponential',
    );
  } finally {
    await worker.close();
    await queue.close();
  }
});
