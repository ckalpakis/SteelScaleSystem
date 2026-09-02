import type { Prisma } from '@prisma/client';

import { ingestLeadSource } from '../ingestion/service.js';
import type { IngestionResult } from '../ingestion/types.js';
import { OutscraperGoogleMapsAdapter } from './outscraper-google-maps.js';

export interface OutscraperImportOptions {
  clientId: string;
  idempotencyKey: string;
  records: unknown[];
  sourceReference?: string;
  defaultCountryCallingCode?: string;
  metadata?: Prisma.InputJsonValue;
}

export interface OutscraperResultsSource {
  fetchResults(): Promise<unknown[]>;
  sourceReference?: string;
}

export async function importOutscraperGoogleMaps(
  options: OutscraperImportOptions,
): Promise<IngestionResult> {
  return ingestLeadSource({
    clientId: options.clientId,
    idempotencyKey: options.idempotencyKey,
    adapter: new OutscraperGoogleMapsAdapter(),
    records: options.records,
    sourceReference: options.sourceReference,
    defaultCountryCallingCode: options.defaultCountryCallingCode,
    metadata: options.metadata,
  });
}

export async function importFromOutscraperSource(
  source: OutscraperResultsSource,
  options: Omit<OutscraperImportOptions, 'records' | 'sourceReference'>,
): Promise<IngestionResult> {
  return importOutscraperGoogleMaps({
    ...options,
    records: await source.fetchResults(),
    sourceReference: source.sourceReference,
  });
}
