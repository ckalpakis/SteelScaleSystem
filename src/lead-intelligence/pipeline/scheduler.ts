import { createHash } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { logger } from '../../utils/logger.js';
import { runLeadIntelligencePipeline } from './orchestrator.js';
import type {
  DiscoveryProvider,
  PipelineCampaign,
  PipelineResult,
  PipelineSourceKind,
} from './types.js';

const providers: Partial<Record<PipelineSourceKind, DiscoveryProvider>> = {};

export function registerLeadDiscoveryProvider(
  source: PipelineSourceKind,
  provider: DiscoveryProvider,
): void {
  providers[source] = provider;
}

export function clearLeadDiscoveryProviders(): void {
  delete providers.outscraper_google_maps;
  delete providers.real_estate;
}

export function configuredLeadDiscoveryProviders() {
  return { ...providers };
}

export function parsePipelineCampaigns(value: string | undefined): PipelineCampaign[] {
  if (!value?.trim()) return [];
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed)) throw new Error('LEAD_PIPELINE_CAMPAIGNS_JSON must be a JSON array');
  return parsed as PipelineCampaign[];
}

function hourlyIdempotencyKey(campaign: PipelineCampaign, now: Date): string {
  const bucket = now.toISOString().slice(0, 13);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(campaign.discovery))
    .digest('hex')
    .slice(0, 12);
  return `${campaign.key}:${bucket}:${fingerprint}`;
}

export async function runScheduledLeadPipelines(
  campaigns = parsePipelineCampaigns(process.env.LEAD_PIPELINE_CAMPAIGNS_JSON),
  now = new Date(),
): Promise<{ attempted: number; results: PipelineResult[]; failures: string[] }> {
  const enabled = campaigns.filter(({ enabled }) => enabled !== false);
  const results: PipelineResult[] = [];
  const failures: string[] = [];
  for (const campaign of enabled) {
    try {
      results.push(
        await runLeadIntelligencePipeline(
          campaign,
          { providers },
          hourlyIdempotencyKey(campaign, now),
          now,
        ),
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        logger.info({ campaignKey: campaign.key }, 'Pipeline campaign already claimed');
        continue;
      }
      const errorText = error instanceof Error ? error.message : String(error);
      failures.push(`${campaign.key}: ${errorText}`);
      logger.error({ err: error, campaignKey: campaign.key }, 'Scheduled pipeline failed');
    }
  }
  return { attempted: enabled.length, results, failures };
}
