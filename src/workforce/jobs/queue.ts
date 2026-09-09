import { randomUUID } from 'node:crypto';
import type { WorkforceJob } from '@prisma/client';
import { eventRouter } from '../../events/handlers.js';
import { audit } from '../audit/service.js';
import { tenantTransaction, type Database } from '../shared.js';
import { logger } from '../../utils/logger.js';

const MAX_ATTEMPTS = 5;
const LEASE_MS = 60_000;

export async function claimJob(database: Database, now = new Date()): Promise<WorkforceJob | null> {
  const token = randomUUID();
  const jobs = await database.$queryRaw<WorkforceJob[]>`
    UPDATE "WorkforceJob" SET status = 'running', attempts = attempts + 1,
      "leaseToken" = ${token}::uuid, "leasedUntil" = ${new Date(now.getTime() + LEASE_MS)}
    WHERE id = (
      SELECT id FROM "WorkforceJob"
      WHERE (status = 'pending' AND "availableAt" <= ${now})
         OR (status = 'running' AND "leasedUntil" <= ${now})
      ORDER BY "availableAt", id FOR UPDATE SKIP LOCKED LIMIT 1
    ) RETURNING *`;
  return jobs[0] ?? null;
}

export async function processJob(
  database: Database,
  claimed: WorkforceJob,
  now = new Date(),
): Promise<void> {
  try {
    await tenantTransaction(database, claimed.organizationId, async (tx) => {
      const locked = await tx.$queryRaw<WorkforceJob[]>`
        SELECT * FROM "WorkforceJob" WHERE id = ${claimed.id}::uuid
          AND "organizationId" = ${claimed.organizationId}::uuid FOR UPDATE`;
      const job = locked[0];
      if (
        !job ||
        job.status !== 'running' ||
        job.leaseToken !== claimed.leaseToken ||
        !job.leasedUntil ||
        job.leasedUntil <= now
      )
        return;
      if (job.attempts > MAX_ATTEMPTS) {
        await tx.workforceJob.update({
          where: { id: job.id },
          data: {
            status: 'dead',
            lastErrorCode: 'lease_attempts_exhausted',
            leaseToken: null,
            leasedUntil: null,
          },
        });
        await audit(tx, job.organizationId, 'worker', 'job.dead', job.id, {
          code: 'lease_attempts_exhausted',
        });
        return;
      }
      const event = await tx.businessEvent.findUniqueOrThrow({
        where: {
          organizationId_id: { organizationId: job.organizationId, id: job.eventId },
        },
      });
      logger.info(
        {
          organizationId: job.organizationId,
          jobId: job.id,
          eventId: event.id,
          correlationId: event.correlationId,
          attempt: job.attempts,
        },
        'Event job processing',
      );
      await eventRouter.dispatch(tx, job.organizationId, event.id, now);
      await tx.workforceJob.update({
        where: { id: job.id },
        data: {
          status: 'completed',
          completedAt: now,
          leaseToken: null,
          leasedUntil: null,
          lastErrorCode: null,
        },
      });
      await audit(tx, job.organizationId, 'worker', 'job.completed', job.id);
    });
  } catch {
    logger.warn(
      {
        organizationId: claimed.organizationId,
        eventId: claimed.eventId,
        jobId: claimed.id,
        attempt: claimed.attempts,
        status: claimed.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending',
      },
      'Event job failed',
    );
    // Never persist provider errors, SQL text, credentials or CRM payloads as error messages.
    await tenantTransaction(database, claimed.organizationId, async (tx) => {
      const failed = await tx.workforceJob.updateMany({
        where: {
          id: claimed.id,
          organizationId: claimed.organizationId,
          status: 'running',
          leaseToken: claimed.leaseToken,
        },
        data: {
          status: claimed.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending',
          availableAt: new Date(now.getTime() + Math.min(300_000, 1000 * 2 ** claimed.attempts)),
          leaseToken: null,
          leasedUntil: null,
          lastErrorCode: 'evaluation_failed',
        },
      });
      if (failed.count)
        await audit(
          tx,
          claimed.organizationId,
          'worker',
          claimed.attempts >= MAX_ATTEMPTS ? 'job.dead' : 'job.retry_scheduled',
          claimed.id,
          { attempt: claimed.attempts },
        );
    });
  }
}

export async function workOnce(database: Database): Promise<boolean> {
  const job = await claimJob(database);
  if (!job) return false;
  await processJob(database, job);
  return true;
}
