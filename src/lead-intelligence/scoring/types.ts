import type { IntelligenceOffer, Prisma } from '@prisma/client';

export type ScoreBand = 'HOT' | 'HIGH' | 'MEDIUM' | 'LOW' | 'POOR';

export interface ScoringSignal {
  id?: string;
  key: string;
  value: Prisma.JsonValue;
  booleanValue?: boolean | null;
  numberValue?: number | null;
  textValue?: string | null;
  provider: string;
  confidence?: number | null;
  observedAt: Date;
}

export interface VoiceAiScoringInput {
  business: {
    id?: string;
    name: string;
    niche?: string | null;
    category?: string | null;
    normalizedPhone?: string | null;
    updatedAt?: Date;
  };
  signals: ScoringSignal[];
  calculatedAt?: Date;
}

export interface ScoreComponent {
  rule: string;
  label: string;
  points: number;
  evidence: Prisma.InputJsonValue;
  signalId?: string;
  observedValue?: Prisma.InputJsonValue;
}

export interface ScoreExplanation {
  score: number;
  rawScore: number;
  band: ScoreBand;
  version: string;
  eligible: boolean;
  manualReview: boolean;
  disqualifications: string[];
  flags: string[];
  components: ScoreComponent[];
  inputState: {
    asOf: string;
    fingerprint: string;
    signalIds: string[];
  };
}

export interface ScoreCalculation {
  offer: IntelligenceOffer;
  score: number;
  band: ScoreBand;
  rulesetVersion: string;
  inputAsOf: Date;
  explanation: ScoreExplanation;
  components: ScoreComponent[];
}

export interface PersistedScoreResult extends ScoreCalculation {
  snapshotId: string;
  leadId: string;
  businessId?: string;
  agentId?: string;
}

export interface BulkScoreResult {
  considered: number;
  scored: number;
  failed: number;
  results: PersistedScoreResult[];
  errors: Array<{ businessId: string; error: string }>;
}
