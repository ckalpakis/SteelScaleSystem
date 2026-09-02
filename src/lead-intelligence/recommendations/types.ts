import type {
  IntelligenceOffer,
  OutreachDisposition,
  Prisma,
  ProspectRelationshipStatus,
} from '@prisma/client';

export interface RecommendationFactor {
  rule: string;
  label: string;
  points: number;
  observedValue?: Prisma.JsonValue;
  confidence?: number | null;
  observedAt?: Date | null;
}

export interface RecommendationCandidate {
  offer: IntelligenceOffer;
  scoreSnapshotId: string;
  score: number;
  eligible: boolean;
  disqualifications: string[];
  inputAsOf: Date;
  factors: RecommendationFactor[];
}

export interface RecommendationContext {
  businessId: string;
  leadId: string;
  relationshipStatus: ProspectRelationshipStatus;
  outreach?: {
    disposition: OutreachDisposition;
    contactable: boolean;
    lastContactedAt?: Date | null;
    contactAttemptCount: number;
  };
  suppressedOffers: Array<{ offer: IntelligenceOffer; reason: string }>;
  now: Date;
}

export interface RankedOffer {
  offer: IntelligenceOffer;
  scoreSnapshotId: string;
  score: number;
  confidence: number;
  reasons: string[];
  rank: number;
}

export interface OfferRecommendationDecision {
  businessId: string;
  leadId: string;
  primaryOffer: IntelligenceOffer | null;
  score: number | null;
  confidence: number;
  reasons: string[];
  rankedOffers: RankedOffer[];
  excludedOffers: Array<{ offer: IntelligenceOffer; reasons: string[] }>;
  recommendationVersion: string;
  fingerprint: string;
}

export interface StoredOfferRecommendation extends OfferRecommendationDecision {
  recommendationIds: string[];
  reusedHistory: boolean;
}
