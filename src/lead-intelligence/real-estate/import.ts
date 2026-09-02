import type { Prisma } from '@prisma/client';

import { ApifyRealEstateAdapter } from './apify-adapter.js';
import { ingestRealEstateListings } from './ingestion.js';
import type { RealEstateIngestionResult } from './types.js';

export interface ApifyRealEstateImportOptions {
  clientId: string;
  idempotencyKey: string;
  source: string;
  records: unknown[];
  sourceReference?: string;
  defaultCountryCallingCode?: string;
  observedAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface RealEstateResultsSource {
  fetchResults(): Promise<unknown[]>;
  sourceReference?: string;
}

export function importApifyRealEstateListings(
  options: ApifyRealEstateImportOptions,
): Promise<RealEstateIngestionResult> {
  return ingestRealEstateListings({
    clientId: options.clientId,
    idempotencyKey: options.idempotencyKey,
    adapter: new ApifyRealEstateAdapter(options.source),
    records: options.records,
    sourceReference: options.sourceReference,
    defaultCountryCallingCode: options.defaultCountryCallingCode,
    observedAt: options.observedAt,
    metadata: options.metadata,
  });
}

export async function importFromRealEstateSource(
  source: RealEstateResultsSource,
  options: Omit<ApifyRealEstateImportOptions, 'records' | 'sourceReference'>,
): Promise<RealEstateIngestionResult> {
  return importApifyRealEstateListings({
    ...options,
    records: await source.fetchResults(),
    sourceReference: source.sourceReference,
  });
}
