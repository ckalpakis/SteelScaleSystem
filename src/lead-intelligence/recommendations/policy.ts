import { createHash } from 'node:crypto';

import { OutreachDisposition, ProspectRelationshipStatus } from '@prisma/client';

import type {
  OfferRecommendationDecision,
  RecommendationCandidate,
  RecommendationContext,
  RecommendationFactor,
} from './types.js';

export const OFFER_RECOMMENDATION_VERSION = 'offer-recommendation-v1';

const NON_PROSPECT_RELATIONSHIPS = new Set<ProspectRelationshipStatus>([
  ProspectRelationshipStatus.current_customer,
  ProspectRelationshipStatus.partner,
  ProspectRelationshipStatus.do_not_target,
]);

const BLOCKED_OUTREACH = new Set<OutreachDisposition>([
  OutreachDisposition.paused,
  OutreachDisposition.converted,
  OutreachDisposition.do_not_contact,
  OutreachDisposition.invalid,
]);

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function freshness(observedAt: Date, now: Date): number {
  const ageDays = Math.max(0, (now.getTime() - observedAt.getTime()) / 86_400_000);
  if (ageDays <= 30) return 1;
  if (ageDays <= 90) return 0.85;
  if (ageDays <= 180) return 0.7;
  return 0.5;
}

function candidateConfidence(
  candidate: RecommendationCandidate,
  context: RecommendationContext,
): number {
  const evidenceFactors = candidate.factors.filter(({ points }) => points !== 0);
  const confidences = evidenceFactors.flatMap(({ confidence }) =>
    typeof confidence === 'number' ? [confidence] : [],
  );
  const averageConfidence = confidences.length
    ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
    : 0.7;
  const observedDates = evidenceFactors.flatMap(({ observedAt }) =>
    observedAt ? [observedAt] : [],
  );
  const evidenceFreshness = observedDates.length
    ? observedDates.reduce((sum, date) => sum + freshness(date, context.now), 0) /
      observedDates.length
    : freshness(candidate.inputAsOf, context.now);
  const evidenceCoverage = Math.min(1, 0.55 + evidenceFactors.length * 0.05);
  const priorContactPenalty = context.outreach?.lastContactedAt ? 0.08 : 0;
  return Number(
    clamp(
      averageConfidence * 0.55 +
        evidenceFreshness * 0.3 +
        evidenceCoverage * 0.15 -
        priorContactPenalty,
    ).toFixed(2),
  );
}

function valueText(value: RecommendationFactor['observedValue']): string | undefined {
  if (typeof value === 'number' || typeof value === 'string') return String(value);
  return undefined;
}

function reasonFor(factor: RecommendationFactor): string {
  const value = valueText(factor.observedValue);
  if (factor.rule === 'GOOGLE_REVIEWS' && value) return `${value} Google reviews`;
  if (factor.rule === 'GOOGLE_RATING' && value) return `${value} Google rating`;
  if (factor.rule === 'EMERGENCY_SERVICE') return 'Emergency service offered';
  if (factor.rule === 'ADVERTISES_24_7') return 'Open 24 hours';
  if (factor.rule === 'NO_CHATBOT') return 'No chatbot detected';
  if (factor.rule === 'NO_ONLINE_BOOKING') return 'No online booking detected';
  return factor.label;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function recommendOffers(
  candidates: RecommendationCandidate[],
  context: RecommendationContext,
): OfferRecommendationDecision {
  const excludedOffers: OfferRecommendationDecision['excludedOffers'] = [];
  const suppressed = new Map(context.suppressedOffers.map(({ offer, reason }) => [offer, reason]));
  const globallyBlocked: string[] = [];
  if (NON_PROSPECT_RELATIONSHIPS.has(context.relationshipStatus)) {
    globallyBlocked.push(`Relationship status is ${context.relationshipStatus}`);
  }
  if (
    context.outreach &&
    (!context.outreach.contactable || BLOCKED_OUTREACH.has(context.outreach.disposition))
  ) {
    globallyBlocked.push(
      !context.outreach.contactable
        ? 'Lead is marked not contactable'
        : `Outreach status is ${context.outreach.disposition}`,
    );
  }

  const ranked = candidates.flatMap((candidate) => {
    const exclusionReasons = [...globallyBlocked];
    if (!candidate.eligible) exclusionReasons.push(...candidate.disqualifications);
    const suppressionReason = suppressed.get(candidate.offer);
    if (suppressionReason) exclusionReasons.push(`Manually suppressed: ${suppressionReason}`);
    if (exclusionReasons.length) {
      excludedOffers.push({ offer: candidate.offer, reasons: exclusionReasons });
      return [];
    }
    const reasons = candidate.factors
      .filter(({ points }) => points > 0)
      .sort((left, right) => right.points - left.points)
      .slice(0, 5)
      .map(reasonFor);
    if (context.outreach?.lastContactedAt) {
      reasons.push(`Previously contacted ${context.outreach.lastContactedAt.toISOString()}`);
    }
    return [
      {
        offer: candidate.offer,
        scoreSnapshotId: candidate.scoreSnapshotId,
        score: candidate.score,
        confidence: candidateConfidence(candidate, context),
        reasons,
        rank: 0,
      },
    ];
  });
  ranked.sort(
    (left, right) =>
      right.score - left.score ||
      right.confidence - left.confidence ||
      left.offer.localeCompare(right.offer),
  );
  ranked.forEach((offer, index) => {
    offer.rank = index + 1;
  });
  const primary = ranked[0];
  const fingerprintPayload = {
    version: OFFER_RECOMMENDATION_VERSION,
    relationshipStatus: context.relationshipStatus,
    outreach: context.outreach ?? null,
    suppressedOffers: [...context.suppressedOffers].sort((left, right) =>
      left.offer.localeCompare(right.offer),
    ),
    candidates: candidates
      .map((candidate) => ({
        offer: candidate.offer,
        scoreSnapshotId: candidate.scoreSnapshotId,
        score: candidate.score,
        eligible: candidate.eligible,
      }))
      .sort((left, right) => left.offer.localeCompare(right.offer)),
    ranked,
    excludedOffers,
  };
  return {
    businessId: context.businessId,
    leadId: context.leadId,
    primaryOffer: primary?.offer ?? null,
    score: primary?.score ?? null,
    confidence: primary?.confidence ?? 0,
    reasons: primary?.reasons ?? globallyBlocked,
    rankedOffers: ranked,
    excludedOffers,
    recommendationVersion: OFFER_RECOMMENDATION_VERSION,
    fingerprint: fingerprint(fingerprintPayload),
  };
}
