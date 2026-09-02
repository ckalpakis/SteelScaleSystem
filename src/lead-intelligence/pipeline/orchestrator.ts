import { IntelligenceOffer, Prisma, ProspectRelationshipStatus } from '@prisma/client';

import { db } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { auditBusinessWebsite } from '../enrichment/website-audit.js';
import { importOutscraperGoogleMaps } from '../integrations/outscraper-import.js';
import { recommendOffers } from '../recommendations/policy.js';
import { importApifyRealEstateListings } from '../real-estate/import.js';
import { scoreLead } from '../scoring/service.js';
import { alertImportantPipelineFailure } from './alerts.js';
import { DEFAULT_RETRY_POLICY, mapConcurrent, withRetry } from './retry.js';
import type {
  PipelineCampaign,
  PipelineDependencies,
  PipelineResult,
  RetryPolicy,
} from './types.js';

type PipelineError = { stage: string; message: string; itemId?: string };

function message(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function validateCampaign(campaign: PipelineCampaign): void {
  if (!campaign.key.trim()) throw new Error('pipeline campaign key is required');
  if (campaign.discovery.kind !== campaign.source) {
    throw new Error(`campaign source ${campaign.source} does not match discovery configuration`);
  }
  if (
    !Number.isInteger(campaign.discovery.maximumResults) ||
    campaign.discovery.maximumResults < 1 ||
    campaign.discovery.maximumResults > 10_000
  ) {
    throw new Error('maximumResults must be an integer from 1-10000');
  }
  if (!campaign.discovery.locations.length) throw new Error('at least one location is required');
  if (campaign.discovery.kind === 'outscraper_google_maps' && !campaign.discovery.keywords.length) {
    throw new Error('at least one Outscraper keyword is required');
  }
}

async function persistRecommendation(leadId: string, now: Date): Promise<number | null> {
  const lead = await db.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: {
      business: true,
      outreachState: true,
      offerSuppressions: { where: { liftedAt: null } },
      scoreSnapshots: {
        orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }],
        include: { factors: { include: { signal: true }, orderBy: { position: 'asc' } } },
      },
    },
  });
  const latest = new Map<IntelligenceOffer, (typeof lead.scoreSnapshots)[number]>();
  for (const snapshot of lead.scoreSnapshots) {
    if (!latest.has(snapshot.offer)) latest.set(snapshot.offer, snapshot);
  }
  const decision = recommendOffers(
    [...latest.values()].map((snapshot) => {
      const explanation =
        snapshot.explanation &&
        typeof snapshot.explanation === 'object' &&
        !Array.isArray(snapshot.explanation)
          ? (snapshot.explanation as Record<string, Prisma.JsonValue>)
          : undefined;
      return {
        offer: snapshot.offer,
        scoreSnapshotId: snapshot.id,
        score: snapshot.score,
        eligible: typeof explanation?.eligible === 'boolean' ? explanation.eligible : true,
        disqualifications: Array.isArray(explanation?.disqualifications)
          ? explanation.disqualifications.filter((item): item is string => typeof item === 'string')
          : [],
        inputAsOf: snapshot.inputAsOf,
        factors: snapshot.factors.map((factor) => ({
          rule: factor.key,
          label: factor.label,
          points: factor.points,
          observedValue: factor.observedValue ?? undefined,
          confidence: factor.signal?.confidence?.toNumber(),
          observedAt: factor.signal?.observedAt,
        })),
      };
    }),
    {
      businessId: lead.businessId ?? leadId,
      leadId,
      relationshipStatus: lead.business?.relationshipStatus ?? ProspectRelationshipStatus.prospect,
      outreach: lead.outreachState
        ? {
            disposition: lead.outreachState.disposition,
            contactable: lead.outreachState.contactable,
            lastContactedAt: lead.outreachState.lastContactedAt,
            contactAttemptCount: lead.outreachState.contactAttemptCount,
          }
        : undefined,
      suppressedOffers: lead.offerSuppressions.map(({ offer, reason }) => ({ offer, reason })),
      now,
    },
  );
  if (!decision.rankedOffers.length) return decision.score;
  const previous = await db.offerRecommendation.findFirst({
    where: {
      leadId,
      recommendationVersion: decision.recommendationVersion,
      reason: { path: ['decisionFingerprint'], equals: decision.fingerprint },
    },
  });
  if (!previous) {
    await db.$transaction(
      decision.rankedOffers.map((ranked) =>
        db.offerRecommendation.create({
          data: {
            clientId: lead.clientId,
            leadId,
            scoreSnapshotId: ranked.scoreSnapshotId,
            offer: ranked.offer,
            rank: ranked.rank,
            recommended: ranked.rank === 1,
            recommendationVersion: decision.recommendationVersion,
            reason: json({
              decisionFingerprint: decision.fingerprint,
              confidence: ranked.confidence,
              reasons: ranked.reasons,
              score: ranked.score,
            }),
            generatedAt: now,
          },
        }),
      ),
    );
  }
  return decision.score;
}

export async function runLeadIntelligencePipeline(
  campaign: PipelineCampaign,
  dependencies: PipelineDependencies,
  idempotencyKey: string,
  now = new Date(),
): Promise<PipelineResult> {
  validateCampaign(campaign);
  const provider = dependencies.providers[campaign.source];
  const existing = await db.pipelineRun.findUnique({
    where: {
      clientId_source_idempotencyKey: {
        clientId: campaign.clientId,
        source: campaign.source,
        idempotencyKey,
      },
    },
  });
  if (existing?.status === 'completed') {
    const state = existing.stageState as { queuedForReview?: number } | null;
    return {
      runId: existing.id,
      status: 'completed',
      recordsDiscovered: existing.recordsDiscovered,
      recordsImported: existing.recordsImported,
      recordsUpdated: existing.recordsUpdated,
      duplicates: existing.duplicates,
      enriched: existing.enriched,
      scored: existing.scored,
      hotLeads: existing.hotLeads,
      failures: existing.failures,
      queuedForReview: state?.queuedForReview ?? 0,
      offer:
        campaign.source === 'real_estate'
          ? IntelligenceOffer.REAL_ESTATE_VIDEO
          : IntelligenceOffer.VOICE_AI,
      errors: (existing.errorSummaries as PipelineError[]) ?? [],
    };
  }
  const run = existing
    ? await db.pipelineRun.update({
        where: { id: existing.id },
        data: {
          status: 'running',
          currentStage: 'DISCOVER',
          startedAt: now,
          completedAt: null,
          heartbeatAt: now,
        },
      })
    : await db.pipelineRun.create({
        data: {
          clientId: campaign.clientId,
          source: campaign.source,
          campaignKey: campaign.key,
          idempotencyKey,
          status: 'running',
          currentStage: 'DISCOVER',
          startedAt: now,
          heartbeatAt: now,
          configuration: json(campaign),
        },
      });
  const errors: PipelineError[] = [];
  const retry: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...campaign.retry };
  let discovered = 0;
  let imported = 0;
  let updated = 0;
  let duplicates = 0;
  let enriched = 0;
  let enrichmentFailures = 0;
  let scored = 0;
  let hotLeads = 0;
  let queuedForReview = 0;
  const offer =
    campaign.source === 'real_estate'
      ? IntelligenceOffer.REAL_ESTATE_VIDEO
      : IntelligenceOffer.VOICE_AI;
  try {
    if (!provider) throw new Error(`No discovery provider registered for ${campaign.source}`);
    const discovery = await withRetry(() => provider.discover(campaign.discovery), retry);
    const records = discovery.records.slice(0, campaign.discovery.maximumResults);
    discovered = records.length;
    await db.pipelineRun.update({
      where: { id: run.id },
      data: { recordsDiscovered: discovered, currentStage: 'INGEST', heartbeatAt: new Date() },
    });
    const ingestionKey = `pipeline:${run.id}:ingest`;
    if (campaign.source === 'outscraper_google_maps') {
      const result = await importOutscraperGoogleMaps({
        clientId: campaign.clientId,
        idempotencyKey: ingestionKey,
        records,
        sourceReference: discovery.sourceReference,
        metadata: json({ pipelineRunId: run.id, campaignKey: campaign.key }),
      });
      imported = result.newBusinesses;
      updated = result.updatedBusinesses;
      duplicates = result.duplicates;
      if (result.failed || result.invalid)
        errors.push({
          stage: 'INGEST',
          message: `${result.failed + result.invalid} Outscraper records rejected`,
        });
    } else {
      const result = await importApifyRealEstateListings({
        clientId: campaign.clientId,
        idempotencyKey: ingestionKey,
        source:
          campaign.discovery.kind === 'real_estate' ? campaign.discovery.provider : 'real_estate',
        records,
        sourceReference: discovery.sourceReference,
        observedAt: now,
        metadata: json({ pipelineRunId: run.id, campaignKey: campaign.key }),
      });
      imported = result.newListings;
      updated = result.updatedListings;
      duplicates = result.duplicateListings;
      if (result.failed || result.invalid)
        errors.push({
          stage: 'INGEST',
          message: `${result.failed + result.invalid} real-estate records rejected`,
        });
    }
    await db.pipelineRun.update({
      where: { id: run.id },
      data: {
        recordsImported: imported,
        recordsUpdated: updated,
        duplicates,
        currentStage: 'DEDUPLICATE',
        heartbeatAt: new Date(),
      },
    });
    const affectedLeads =
      campaign.source === 'outscraper_google_maps'
        ? await db.lead.findMany({
            where: {
              clientId: campaign.clientId,
              sourceRecords: { some: { ingestionRun: { idempotencyKey: ingestionKey } } },
            },
            select: { id: true, businessId: true },
          })
        : await db.lead.findMany({
            where: {
              clientId: campaign.clientId,
              realEstateAgent: {
                listings: {
                  some: {
                    providerSources: { some: { ingestionRun: { idempotencyKey: ingestionKey } } },
                  },
                },
              },
            },
            select: { id: true, businessId: true },
          });
    await db.pipelineRun.update({
      where: { id: run.id },
      data: { currentStage: 'ENRICH', heartbeatAt: new Date() },
    });
    if (campaign.source === 'outscraper_google_maps') {
      const auditable = affectedLeads.filter((lead): lead is typeof lead & { businessId: string } =>
        Boolean(lead.businessId),
      );
      const audits = await mapConcurrent(
        auditable,
        campaign.enrichmentConcurrency ?? 3,
        async ({ businessId }) =>
          auditBusinessWebsite({
            businessId,
            idempotencyKey: `pipeline:${run.id}:website:${businessId}`,
          }),
      );
      for (const result of audits) {
        if (result.status === 'fulfilled' && result.value.status === 'completed') enriched += 1;
        else {
          enrichmentFailures += 1;
          errors.push({
            stage: 'ENRICH',
            message:
              result.status === 'rejected'
                ? message(result.reason)
                : (result.value.error ?? 'Website audit failed'),
          });
        }
      }
    }
    await db.pipelineRun.update({
      where: { id: run.id },
      data: { enriched, currentStage: 'SCORE', heartbeatAt: new Date() },
    });
    const scoreResults = await mapConcurrent(
      affectedLeads,
      campaign.scoringConcurrency ?? 5,
      ({ id }) => scoreLead(id, offer, { calculatedAt: now }),
    );
    const scoredLeadIds: string[] = [];
    for (let index = 0; index < scoreResults.length; index += 1) {
      const result = scoreResults[index];
      if (result?.status === 'fulfilled') {
        scored += 1;
        scoredLeadIds.push(result.value.leadId);
      } else if (result)
        errors.push({
          stage: 'SCORE',
          itemId: affectedLeads[index]?.id,
          message: message(result.reason),
        });
    }
    await db.pipelineRun.update({
      where: { id: run.id },
      data: { scored, currentStage: 'RECOMMEND', heartbeatAt: new Date() },
    });
    const recommendations = await mapConcurrent(
      scoredLeadIds,
      campaign.scoringConcurrency ?? 5,
      (leadId) => persistRecommendation(leadId, now),
    );
    const threshold = campaign.reviewScoreThreshold ?? 75;
    const reviewLeadIds: string[] = [];
    recommendations.forEach((result, index) => {
      if (result.status === 'fulfilled' && (result.value ?? 0) >= threshold)
        reviewLeadIds.push(scoredLeadIds[index]!);
      else if (result.status === 'rejected')
        errors.push({
          stage: 'RECOMMEND',
          itemId: scoredLeadIds[index],
          message: message(result.reason),
        });
    });
    hotLeads = recommendations.filter(
      (result) => result.status === 'fulfilled' && (result.value ?? 0) >= 90,
    ).length;
    await db.pipelineRun.update({
      where: { id: run.id },
      data: { currentStage: 'QUEUE_FOR_REVIEW', heartbeatAt: new Date() },
    });
    for (const leadId of reviewLeadIds) {
      const state = await db.leadOutreachState.findUnique({ where: { leadId } });
      if (!state || state.disposition === 'not_contacted' || state.disposition === 'ready') {
        await db.leadOutreachState.upsert({
          where: { leadId },
          create: { leadId, disposition: 'ready' },
          update: { disposition: 'ready' },
        });
        queuedForReview += 1;
      }
    }
  } catch (error) {
    errors.push({
      stage:
        (await db.pipelineRun.findUnique({ where: { id: run.id }, select: { currentStage: true } }))
          ?.currentStage ?? 'PIPELINE',
      message: message(error),
    });
  }
  const status =
    discovered === 0 && errors.length
      ? 'failed'
      : errors.length
        ? 'partially_completed'
        : 'completed';
  const failures = errors.length;
  await db.pipelineRun.update({
    where: { id: run.id },
    data: {
      status,
      currentStage: null,
      completedAt: new Date(),
      heartbeatAt: new Date(),
      recordsDiscovered: discovered,
      recordsImported: imported,
      recordsUpdated: updated,
      duplicates,
      enriched,
      scored,
      hotLeads,
      failures,
      errorSummaries: json(errors),
      stageState: json({ queuedForReview, enrichmentFailures }),
    },
  });
  let sourceStale = false;
  if (
    campaign.discovery.kind === 'real_estate' &&
    campaign.discovery.expectedResultsIntervalHours &&
    discovered === 0
  ) {
    const lastProductiveRun = await db.pipelineRun.findFirst({
      where: {
        clientId: campaign.clientId,
        campaignKey: campaign.key,
        recordsDiscovered: { gt: 0 },
        completedAt: { not: null },
        id: { not: run.id },
      },
      orderBy: { completedAt: 'desc' },
      select: { completedAt: true },
    });
    sourceStale =
      !lastProductiveRun?.completedAt ||
      now.getTime() - lastProductiveRun.completedAt.getTime() >
        campaign.discovery.expectedResultsIntervalHours * 3_600_000;
  }
  await alertImportantPipelineFailure({
    runId: run.id,
    clientId: campaign.clientId,
    campaignKey: campaign.key,
    source: campaign.source,
    status,
    discovered,
    enriched,
    enrichmentFailures,
    scored,
    qualified: queuedForReview,
    errors,
    sourceStale,
  });
  logger.info(
    { pipelineRunId: run.id, campaignKey: campaign.key, status },
    'Lead Intelligence pipeline completed',
  );
  return {
    runId: run.id,
    status,
    recordsDiscovered: discovered,
    recordsImported: imported,
    recordsUpdated: updated,
    duplicates,
    enriched,
    scored,
    hotLeads,
    failures,
    queuedForReview,
    offer,
    errors,
  };
}
