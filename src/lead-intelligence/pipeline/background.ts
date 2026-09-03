import { Prisma } from '@prisma/client';

import { db } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { runLeadIntelligencePipeline } from './orchestrator.js';
import { configuredLeadDiscoveryProviders } from './scheduler.js';
import type { PipelineCampaign } from './types.js';

const activeRuns = new Set<string>();

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function launch(runId: string, campaign: PipelineCampaign, idempotencyKey: string): void {
  if (activeRuns.has(runId)) return;
  activeRuns.add(runId);
  setImmediate(() => {
    void runLeadIntelligencePipeline(
      campaign,
      { providers: configuredLeadDiscoveryProviders() },
      idempotencyKey,
    )
      .catch(async (error: unknown) => {
        logger.error({ err: error, pipelineRunId: runId }, 'Background lead pipeline crashed');
        try {
          await db.pipelineRun.update({
            where: { id: runId },
            data: {
              status: 'failed',
              currentStage: null,
              completedAt: new Date(),
              heartbeatAt: new Date(),
              failures: { increment: 1 },
              errorSummaries: asJson([
                {
                  stage: 'PIPELINE',
                  message: error instanceof Error ? error.message : String(error),
                },
              ]),
            },
          });
        } catch (persistenceError) {
          logger.error(
            { err: persistenceError, pipelineRunId: runId },
            'Could not persist background pipeline failure',
          );
        }
      })
      .finally(() => activeRuns.delete(runId));
  });
}

export async function enqueueLeadIntelligencePipeline(
  campaign: PipelineCampaign,
  idempotencyKey: string,
): Promise<string> {
  const run = await db.pipelineRun.create({
    data: {
      clientId: campaign.clientId,
      source: campaign.source,
      campaignKey: campaign.key,
      idempotencyKey,
      status: 'pending',
      currentStage: 'QUEUED',
      heartbeatAt: new Date(),
      configuration: asJson(campaign),
    },
  });
  launch(run.id, campaign, idempotencyKey);
  return run.id;
}

export async function resumeInterruptedLeadPipelines(): Promise<number> {
  const runs = await db.pipelineRun.findMany({
    where: { status: { in: ['pending', 'running'] }, configuration: { not: Prisma.JsonNull } },
    orderBy: { createdAt: 'asc' },
  });
  for (const run of runs) {
    launch(run.id, run.configuration as unknown as PipelineCampaign, run.idempotencyKey);
  }
  if (runs.length) logger.info({ count: runs.length }, 'Resuming interrupted lead pipelines');
  return runs.length;
}
