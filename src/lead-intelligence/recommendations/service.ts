import { IntelligenceOffer, Prisma } from '@prisma/client';

import { db } from '../../db/client.js';
import { recommendOffers } from './policy.js';
import type { RecommendationCandidate, StoredOfferRecommendation } from './types.js';

function jsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Recommendation is not JSON serializable');
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function objectValue(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : undefined;
}

function scoreEligibility(explanation: Prisma.JsonValue | null): {
  eligible: boolean;
  disqualifications: string[];
} {
  const object = objectValue(explanation);
  const eligible = typeof object?.eligible === 'boolean' ? object.eligible : true;
  const disqualifications = Array.isArray(object?.disqualifications)
    ? object.disqualifications.filter((value): value is string => typeof value === 'string')
    : [];
  return { eligible, disqualifications };
}

export async function suppressOffer(input: {
  leadId: string;
  offer: IntelligenceOffer;
  reason: string;
  createdBy?: string;
}) {
  const reason = input.reason.trim();
  if (!reason) throw new Error('Suppression reason is required');
  const lead = await db.lead.findUniqueOrThrow({
    where: { id: input.leadId },
    select: { clientId: true },
  });
  const active = await db.offerSuppression.findFirst({
    where: { leadId: input.leadId, offer: input.offer, liftedAt: null },
  });
  if (active) return active;
  return db.offerSuppression.create({
    data: {
      clientId: lead.clientId,
      leadId: input.leadId,
      offer: input.offer,
      reason,
      createdBy: input.createdBy?.trim() || undefined,
    },
  });
}

export async function liftOfferSuppression(input: {
  leadId: string;
  offer: IntelligenceOffer;
  liftedAt?: Date;
}): Promise<number> {
  const result = await db.offerSuppression.updateMany({
    where: { leadId: input.leadId, offer: input.offer, liftedAt: null },
    data: { liftedAt: input.liftedAt ?? new Date() },
  });
  return result.count;
}

export async function generateOfferRecommendation(
  businessId: string,
  now = new Date(),
): Promise<StoredOfferRecommendation> {
  const business = await db.prospectBusiness.findUniqueOrThrow({
    where: { id: businessId },
    include: {
      leads: {
        take: 1,
        include: {
          outreachState: true,
          offerSuppressions: { where: { liftedAt: null } },
          scoreSnapshots: {
            orderBy: [{ calculatedAt: 'desc' }, { createdAt: 'desc' }],
            include: { factors: { include: { signal: true }, orderBy: { position: 'asc' } } },
          },
        },
      },
    },
  });
  const lead = business.leads[0];
  if (!lead) throw new Error(`Business ${business.id} has no canonical lead`);
  const latestByOffer = new Map<IntelligenceOffer, (typeof lead.scoreSnapshots)[number]>();
  for (const snapshot of lead.scoreSnapshots) {
    if (!latestByOffer.has(snapshot.offer)) latestByOffer.set(snapshot.offer, snapshot);
  }
  const candidates: RecommendationCandidate[] = [...latestByOffer.values()].map((snapshot) => {
    const eligibility = scoreEligibility(snapshot.explanation);
    return {
      offer: snapshot.offer,
      scoreSnapshotId: snapshot.id,
      score: snapshot.score,
      inputAsOf: snapshot.inputAsOf,
      ...eligibility,
      factors: snapshot.factors.map((factor) => ({
        rule: factor.key,
        label: factor.label,
        points: factor.points,
        observedValue: factor.observedValue ?? undefined,
        confidence: factor.signal?.confidence?.toNumber(),
        observedAt: factor.signal?.observedAt,
      })),
    };
  });
  const decision = recommendOffers(candidates, {
    businessId: business.id,
    leadId: lead.id,
    relationshipStatus: business.relationshipStatus,
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
  });

  const recent = await db.offerRecommendation.findMany({
    where: { leadId: lead.id, recommendationVersion: decision.recommendationVersion },
    orderBy: { generatedAt: 'desc' },
    take: 25,
  });
  const matchingHistory = recent.filter(
    ({ reason }) => objectValue(reason)?.decisionFingerprint === decision.fingerprint,
  );
  if (matchingHistory.length) {
    return {
      ...decision,
      recommendationIds: matchingHistory.map(({ id }) => id),
      reusedHistory: true,
    };
  }
  if (!decision.rankedOffers.length) {
    return { ...decision, recommendationIds: [], reusedHistory: false };
  }
  const generatedAt = now;
  const created = await db.$transaction(
    decision.rankedOffers.map((ranked) =>
      db.offerRecommendation.create({
        data: {
          clientId: business.clientId,
          leadId: lead.id,
          scoreSnapshotId: ranked.scoreSnapshotId,
          offer: ranked.offer,
          rank: ranked.rank,
          recommended: ranked.rank === 1,
          recommendationVersion: decision.recommendationVersion,
          reason: jsonValue({
            decisionFingerprint: decision.fingerprint,
            confidence: ranked.confidence,
            reasons: ranked.reasons,
            score: ranked.score,
            businessId: business.id,
          }),
          generatedAt,
        },
      }),
    ),
  );
  return {
    ...decision,
    recommendationIds: created.map(({ id }) => id),
    reusedHistory: false,
  };
}
