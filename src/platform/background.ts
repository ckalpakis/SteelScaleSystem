import { randomUUID } from 'node:crypto';
import { Prisma, type BackgroundTask } from '@prisma/client';
import { hash, json, type Database } from '../workforce/shared.js';
import { logger } from '../utils/logger.js';

export type TaskKind = 'legacy_sms' | 'lead_pipeline' | 'daily_summary' | 'scheduled_pipelines';
export const durableBackground = () => process.env.DURABLE_BACKGROUND_ENABLED === 'true';

/** Internal callers only. PostgreSQL commit is the acknowledgment boundary; no Redis dual write. */
export async function enqueueBackground(
  database: Database,
  kind: TaskKind,
  key: string,
  payload: unknown,
  clientId?: string,
) {
  const organization = clientId
    ? await database.organization.findUnique({
        where: { legacyClientId: clientId },
        select: { id: true },
      })
    : null;
  const payloadHash = hash({ kind, clientId, payload });
  const data = {
    kind,
    key: `${kind}:${clientId ?? 'system'}:${key}`,
    payload: json(payload),
    payloadHash,
    clientId,
    organizationId: organization?.id,
    correlationId: randomUUID(),
  };
  try {
    return await database.backgroundTask.create({ data });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
      throw error;
    const existing = await database.backgroundTask.findUniqueOrThrow({ where: { key: data.key } });
    if (existing.payloadHash !== payloadHash)
      // eslint-disable-next-line preserve-caught-error -- Prisma cause can include private payloads.
      throw new Error('Background task idempotency conflict');
    return existing;
  }
}

export async function enqueueLegacySms(
  database: Database,
  input: { messageSid: string; from: string; to: string; body: string },
) {
  const client = await database.client.findUnique({
    where: { phoneNumber: input.to },
    select: { id: true },
  });
  if (!client) return;
  return enqueueBackground(database, 'legacy_sms', input.messageSid, input, client.id);
}

export async function executeBackground(database: Database, task: BackgroundTask): Promise<void> {
  if (task.clientId) {
    const client = await database.client.findUniqueOrThrow({ where: { id: task.clientId } });
    if (
      task.organizationId &&
      !(await database.organization.findFirst({
        where: { id: task.organizationId, legacyClientId: client.id },
      }))
    )
      throw new Error('Task tenant mismatch');
  }
  const payload = task.payload as Record<string, unknown>;
  switch (task.kind) {
    case 'legacy_sms': {
      const client = await database.client.findUniqueOrThrow({ where: { id: task.clientId! } });
      if (
        client.phoneNumber !== payload.to ||
        ['messageSid', 'from', 'to', 'body'].some((key) => typeof payload[key] !== 'string')
      )
        throw new Error('Task destination mismatch');
      const { processInboundSms } = await import('../services/sms-booking.js');
      await processInboundSms(
        payload as { messageSid: string; from: string; to: string; body: string },
      );
      break;
    }
    case 'lead_pipeline': {
      const run = await database.pipelineRun.findFirstOrThrow({
        where: { id: String(payload.runId), clientId: task.clientId! },
      });
      if (run.status === 'completed') return;
      const { runLeadIntelligencePipeline } =
        await import('../lead-intelligence/pipeline/orchestrator.js');
      const { configuredLeadDiscoveryProviders } =
        await import('../lead-intelligence/pipeline/scheduler.js');
      const campaign =
        run.configuration as unknown as import('../lead-intelligence/pipeline/types.js').PipelineCampaign;
      if (campaign.clientId !== task.clientId) throw new Error('Campaign tenant mismatch');
      const result = await runLeadIntelligencePipeline(
        campaign,
        { providers: configuredLeadDiscoveryProviders() },
        run.idempotencyKey,
      );
      if (result.status !== 'completed') throw new Error('Pipeline incomplete');
      break;
    }
    case 'daily_summary': {
      const { createDailySummary } = await import('../services/daily-summary.js');
      const result = await createDailySummary();
      if (!result.slackSent && !result.ownerSmsAttempted) throw new Error('Summary not delivered');
      break;
    }
    case 'scheduled_pipelines': {
      const { parsePipelineCampaigns } = await import('../lead-intelligence/pipeline/scheduler.js');
      const { enqueueLeadIntelligencePipeline } =
        await import('../lead-intelligence/pipeline/background.js');
      for (const campaign of parsePipelineCampaigns(
        process.env.LEAD_PIPELINE_CAMPAIGNS_JSON,
      ).filter((c) => c.enabled !== false)) {
        await enqueueLeadIntelligencePipeline(campaign, `scheduled:${task.key}:${hash(campaign)}`);
      }
      break;
    }
    default:
      throw new Error('Unregistered background task');
  }
}

export async function backgroundOnce(
  database: Database,
  execute = executeBackground,
  now = new Date(),
  kinds: TaskKind[] = ['legacy_sms', 'lead_pipeline', 'daily_summary', 'scheduled_pipelines'],
) {
  // Legacy functions do not expose provider idempotency guarantees. Never replay an interrupted
  // external side effect automatically; operators reconcile unknowns from durable evidence.
  const expired = await database.backgroundTask.updateMany({
    where: { status: 'running', leasedUntil: { lte: now } },
    data: { status: 'unknown', lastErrorCode: 'lease_expired_outcome_unknown' },
  });
  if (expired.count)
    logger.error(
      { count: expired.count, component: 'background' },
      'Background tasks require reconciliation',
    );
  const token = randomUUID();
  const rows = await database.$queryRaw<
    BackgroundTask[]
  >`UPDATE "BackgroundTask" SET status='running', attempts=attempts+1, "leaseToken"=${token}::uuid, "leasedUntil"=${new Date(now.getTime() + 3600000)}
    WHERE id=(SELECT id FROM "BackgroundTask" WHERE status='pending' AND "availableAt"<=${now} AND kind IN (${Prisma.join(kinds)}) ORDER BY "availableAt",id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`;
  const task = rows[0];
  if (!task) return false;
  const trace = {
    jobId: task.id,
    organizationId: task.organizationId,
    clientId: task.clientId,
    correlationId: task.correlationId,
    kind: task.kind,
  };
  logger.info(trace, 'Background task claimed');
  try {
    await execute(database, task);
    await database.backgroundTask.updateMany({
      where: { id: task.id, status: 'running', leaseToken: token },
      data: {
        status: 'completed',
        payload: {},
        completedAt: new Date(),
        leaseToken: null,
        leasedUntil: null,
      },
    });
    logger.info(trace, 'Background task completed');
  } catch {
    await database.backgroundTask.updateMany({
      where: { id: task.id, status: 'running', leaseToken: token },
      data: {
        status: 'unknown',
        lastErrorCode: 'execution_failed_reconcile',
        leaseToken: null,
        leasedUntil: null,
      },
    });
    logger.error(trace, 'Background task outcome unknown; automatic replay blocked');
  }
  return true;
}

export async function reconcilePendingPipelines(database: Database) {
  const runs = await database.$queryRaw<
    Array<{ id: string; clientId: string }>
  >`SELECT p.id,p.client_id AS "clientId" FROM "PipelineRun" p WHERE p.status='pending' AND p.configuration IS NOT NULL AND p.configuration <> 'null'::jsonb
    AND NOT EXISTS (SELECT 1 FROM "BackgroundTask" t WHERE t.key='lead_pipeline:' || p.client_id::text || ':' || p.id::text) ORDER BY p.created_at LIMIT 100`;
  for (const run of runs)
    await enqueueBackground(database, 'lead_pipeline', run.id, { runId: run.id }, run.clientId);
}
