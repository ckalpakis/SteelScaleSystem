import type { IntelligenceOffer } from '@prisma/client';

export interface LeadAnalystInput {
  leadId: string;
  name: string;
  location: string;
  niche: string | null;
  primaryOffer: IntelligenceOffer | null;
  score: number | null;
  scoreBand: string | null;
  confidence: number;
  reasons: string[];
  reviewCount: number | null;
  rating: number | null;
  activeListings: number | null;
  phoneAvailable: boolean;
  websiteAvailable: boolean;
  lastSeenAt: string;
  lastEnrichedAt: string | null;
  outreachStatus: string;
  scoreComponents: Array<{ rule: string; label: string; points: number }>;
}

export interface LeadAnalystEntry {
  leadId: string;
  rank: number;
  fitSummary: string;
  salesAngle: string;
  notes: string[];
  risks: string[];
}

export interface LeadAnalystReport {
  generatedAt: Date;
  model: string;
  analyzedCount: number;
  rankings: LeadAnalystEntry[];
}
