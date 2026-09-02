import type { Prisma } from '@prisma/client';

export interface AdapterValidationSuccess<T> {
  valid: true;
  value: T;
}

export interface AdapterValidationFailure {
  valid: false;
  errors: string[];
}

export type AdapterValidationResult<T> = AdapterValidationSuccess<T> | AdapterValidationFailure;

export interface NormalizedBusiness {
  name: string;
  website?: string;
  phone?: string;
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  googlePlaceId?: string;
  googleCid?: string;
  category?: string;
  niche?: string;
  sourceCreatedAt?: Date;
}

export interface NormalizedContact {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
  relationship?: string;
  phone?: string;
  phoneType?: string;
  email?: string;
  linkedinUrl?: string;
  instagramUrl?: string;
  facebookUrl?: string;
  tiktokUrl?: string;
  sourceCreatedAt?: Date;
}

export type NormalizedSignalKind = 'boolean' | 'number' | 'text' | 'date' | 'json';

export interface NormalizedSignal {
  key: string;
  value: Prisma.InputJsonValue;
  kind?: NormalizedSignalKind;
  confidence?: number;
  observedAt?: Date;
  expiresAt?: Date;
  evidence?: Prisma.InputJsonValue;
}

export interface NormalizedProspect {
  externalId?: string;
  sourceUrl?: string;
  sourceCreatedAt?: Date;
  business: NormalizedBusiness;
  contacts?: NormalizedContact[];
  signals?: NormalizedSignal[];
}

export interface AdapterContext {
  observedAt: Date;
  defaultCountryCallingCode?: string;
}

export interface LeadSourceAdapter<T> {
  readonly provider: string;
  validate(payload: unknown): AdapterValidationResult<T>;
  getExternalIdentifier(payload: unknown): string | undefined;
  normalize(payload: T, context: AdapterContext): NormalizedProspect;
}

export interface IngestionRequest<T> {
  clientId: string;
  idempotencyKey: string;
  adapter: LeadSourceAdapter<T>;
  records: unknown[];
  sourceReference?: string;
  defaultCountryCallingCode?: string;
  observedAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface IngestionResult {
  runId: string;
  status: 'completed' | 'partially_completed' | 'failed';
  received: number;
  valid: number;
  invalid: number;
  newBusinesses: number;
  updatedBusinesses: number;
  newContacts: number;
  updatedContacts: number;
  duplicates: number;
  failed: number;
  signalsCreated: number;
  signalsUpdated: number;
  startedAt: Date;
  completedAt: Date;
}
