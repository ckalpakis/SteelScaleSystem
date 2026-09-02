import { IntelligenceOffer, Prisma } from '@prisma/client';

import { db } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { VOICE_AI_SCORING_VERSION } from './config.js';
import { calculateRealEstateVideoScore } from './real-estate-video.js';
import type {
  BulkScoreResult,
  PersistedScoreResult,
  ScoreCalculation,
  ScoringSignal,
} from './types.js';
import { calculateVoiceAiScore } from './voice-ai.js';

interface ScoreOptions {
  calculatedAt?: Date;
}

interface BulkOptions extends ScoreOptions {
  offer?: IntelligenceOffer;
  concurrency?: number;
}

interface RescoreStaleOptions extends BulkOptions {
  clientId: string;
  limit?: number;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Score explanation is not JSON serializable');
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateConcurrency(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 20) {
    throw new Error('scoring concurrency must be an integer from 1-20');
  }
}

export async function scoreLead(
  leadId: string,
  offer: IntelligenceOffer = IntelligenceOffer.VOICE_AI,
  options: ScoreOptions = {},
): Promise<PersistedScoreResult> {
  const calculatedAt = options.calculatedAt ?? new Date();
  const lead = await db.lead.findUniqueOrThrow({
    where: { id: leadId },
    include: {
      business: true,
      realEstateAgent: {
        include: {
          listings: { orderBy: [{ listedAt: 'desc' }, { lastSeenAt: 'desc' }] },
        },
      },
    },
  });
  const signalRows = await db.leadSignal.findMany({
    where: {
      leadId: lead.id,
      observedAt: { lte: calculatedAt },
      OR: [{ expiresAt: null }, { expiresAt: { gt: calculatedAt } }],
    },
    orderBy: [{ observedAt: 'desc' }, { createdAt: 'desc' }],
  });
  const signals: ScoringSignal[] = signalRows.map((signal) => ({
    id: signal.id,
    key: signal.key,
    value: signal.value,
    booleanValue: signal.booleanValue,
    numberValue: signal.numberValue?.toNumber(),
    textValue: signal.textValue,
    provider: signal.provider,
    confidence: signal.confidence?.toNumber(),
    observedAt: signal.observedAt,
  }));
  let calculation: ScoreCalculation;
  if (offer === IntelligenceOffer.VOICE_AI) {
    if (!lead.business) throw new Error(`Lead ${lead.id} has no canonical business`);
    calculation = calculateVoiceAiScore({
      business: {
        id: lead.business.id,
        name: lead.business.name,
        niche: lead.business.niche,
        category: lead.business.category,
        normalizedPhone: lead.business.normalizedPhone,
        updatedAt: lead.business.updatedAt,
      },
      signals,
      calculatedAt,
    });
  } else if (offer === IntelligenceOffer.REAL_ESTATE_VIDEO) {
    if (!lead.realEstateAgent)
      throw new Error(`Lead ${lead.id} has no canonical real-estate agent`);
    const latestListing = lead.realEstateAgent.listings.find((listing) =>
      ['ACTIVE', 'FOR_SALE', 'FOR_RENT', 'COMING_SOON', 'NEW'].includes(listing.status ?? 'ACTIVE'),
    );
    calculation = calculateRealEstateVideoScore({
      agent: {
        id: lead.realEstateAgent.id,
        fullName: lead.realEstateAgent.fullName,
        updatedAt: lead.realEstateAgent.updatedAt,
      },
      latestListing: latestListing
        ? {
            id: latestListing.id,
            address: latestListing.address,
            propertyUrl: latestListing.listingUrl,
            listedAt: latestListing.listedAt,
            updatedAt: latestListing.updatedAt,
          }
        : undefined,
      signals,
      calculatedAt,
    });
  } else {
    throw new Error(`Scoring is not implemented for offer ${offer}`);
  }
  const snapshot = await db.scoreSnapshot.create({
    data: {
      clientId: lead.clientId,
      leadId: lead.id,
      offer,
      score: calculation.score,
      rulesetVersion: calculation.rulesetVersion,
      inputAsOf: calculation.inputAsOf,
      calculatedAt,
      explanation: jsonValue(calculation.explanation),
      factors: {
        create: calculation.components.map((component, position) => ({
          signalId: component.signalId,
          key: component.rule,
          label: component.label,
          points: component.points,
          observedValue:
            component.observedValue === undefined ? undefined : jsonValue(component.observedValue),
          ruleVersion: calculation.rulesetVersion,
          position,
        })),
      },
    },
  });
  return {
    ...calculation,
    snapshotId: snapshot.id,
    leadId: lead.id,
    ...(lead.business ? { businessId: lead.business.id } : {}),
    ...(lead.realEstateAgent ? { agentId: lead.realEstateAgent.id } : {}),
  };
}

export async function scoreRealEstateAgent(
  agentId: string,
  options: ScoreOptions = {},
): Promise<PersistedScoreResult> {
  const agent = await db.realEstateAgent.findUniqueOrThrow({
    where: { id: agentId },
    select: { leadId: true },
  });
  return scoreLead(agent.leadId, IntelligenceOffer.REAL_ESTATE_VIDEO, options);
}

export async function scoreBusinessForOffer(
  businessId: string,
  offer: IntelligenceOffer,
  options: ScoreOptions = {},
): Promise<PersistedScoreResult> {
  const lead = await db.lead.findFirstOrThrow({
    where: { businessId },
    select: { id: true },
  });
  return scoreLead(lead.id, offer, options);
}

export async function rescoreBusiness(
  businessId: string,
  offer: IntelligenceOffer = IntelligenceOffer.VOICE_AI,
  options: ScoreOptions = {},
): Promise<PersistedScoreResult> {
  return scoreBusinessForOffer(businessId, offer, options);
}

export async function getCurrentScore(
  leadId: string,
  offer: IntelligenceOffer = IntelligenceOffer.VOICE_AI,
) {
  return db.scoreSnapshot.findFirst({
    where: { leadId, offer },
    include: { factors: { orderBy: { position: 'asc' } } },
    orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function bulkScore(
  businessIds: string[],
  options: BulkOptions = {},
): Promise<BulkScoreResult> {
  const concurrency = options.concurrency ?? 5;
  validateConcurrency(concurrency);
  const offer = options.offer ?? IntelligenceOffer.VOICE_AI;
  const uniqueBusinessIds = [...new Set(businessIds)];
  const results: PersistedScoreResult[] = [];
  const errors: Array<{ businessId: string; error: string }> = [];
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < uniqueBusinessIds.length) {
      const index = nextIndex;
      nextIndex += 1;
      const businessId = uniqueBusinessIds[index];
      if (!businessId) continue;
      try {
        results.push(
          await scoreBusinessForOffer(businessId, offer, {
            calculatedAt: options.calculatedAt,
          }),
        );
      } catch (error) {
        const errorText = message(error);
        errors.push({ businessId, error: errorText });
        logger.error({ businessId, offer, error }, 'Lead Intelligence scoring failed');
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, uniqueBusinessIds.length) }, () => worker()),
  );
  return {
    considered: uniqueBusinessIds.length,
    scored: results.length,
    failed: errors.length,
    results,
    errors,
  };
}

export async function rescoreStaleBusinesses(
  options: RescoreStaleOptions,
): Promise<BulkScoreResult> {
  const offer = options.offer ?? IntelligenceOffer.VOICE_AI;
  if (offer !== IntelligenceOffer.VOICE_AI) {
    throw new Error(`Stale scoring is not implemented for offer ${offer}`);
  }
  const candidates = await db.prospectBusiness.findMany({
    where: { clientId: options.clientId, leads: { some: {} } },
    select: {
      id: true,
      updatedAt: true,
      leads: {
        take: 1,
        select: {
          signals: {
            where: {
              OR: [{ expiresAt: null }, { expiresAt: { gt: options.calculatedAt ?? new Date() } }],
            },
            orderBy: { observedAt: 'desc' },
            take: 1,
            select: { observedAt: true },
          },
          scoreSnapshots: {
            where: { offer },
            orderBy: { calculatedAt: 'desc' },
            take: 1,
            select: { inputAsOf: true, rulesetVersion: true },
          },
        },
      },
    },
    orderBy: { updatedAt: 'asc' },
  });
  const stale = candidates
    .filter((business) => {
      const lead = business.leads[0];
      const latest = lead?.scoreSnapshots[0];
      if (!latest || latest.rulesetVersion !== VOICE_AI_SCORING_VERSION) return true;
      const signalObservedAt = lead.signals[0]?.observedAt;
      const sourceAsOf = Math.max(business.updatedAt.getTime(), signalObservedAt?.getTime() ?? 0);
      return latest.inputAsOf.getTime() < sourceAsOf;
    })
    .slice(0, options.limit ?? 100)
    .map(({ id }) => id);
  return bulkScore(stale, { ...options, offer });
}
