import type { IntelligenceOffer } from '@prisma/client';

export type PipelineSourceKind = 'outscraper_google_maps' | 'real_estate';

export interface RetryPolicy {
  attempts: number;
  initialDelayMs: number;
  maximumDelayMs: number;
}

export interface OutscraperSearchConfig {
  kind: 'outscraper_google_maps';
  keywords: string[];
  locations: string[];
  maximumResults: number;
  minimumReviews?: number;
  states?: string[];
  cities?: string[];
}

export interface RealEstateSearchConfig {
  kind: 'real_estate';
  provider: string;
  locations: string[];
  maximumResults: number;
  listedWithinHours?: number;
  expectedResultsIntervalHours?: number;
}

export type DiscoveryConfig = OutscraperSearchConfig | RealEstateSearchConfig;

export interface PipelineCampaign {
  key: string;
  clientId: string;
  source: PipelineSourceKind;
  discovery: DiscoveryConfig;
  enabled?: boolean;
  enrichmentConcurrency?: number;
  scoringConcurrency?: number;
  reviewScoreThreshold?: number;
  retry?: Partial<RetryPolicy>;
}

export interface DiscoveryResult {
  records: unknown[];
  sourceReference?: string;
}

export interface DiscoveryProvider {
  discover(config: DiscoveryConfig): Promise<DiscoveryResult>;
}

export interface PipelineDependencies {
  providers: Partial<Record<PipelineSourceKind, DiscoveryProvider>>;
}

export interface PipelineResult {
  runId: string;
  status: 'completed' | 'partially_completed' | 'failed';
  recordsDiscovered: number;
  recordsImported: number;
  recordsUpdated: number;
  duplicates: number;
  enriched: number;
  scored: number;
  hotLeads: number;
  failures: number;
  queuedForReview: number;
  offer: IntelligenceOffer;
  errors: Array<{ stage: string; message: string; itemId?: string }>;
}
