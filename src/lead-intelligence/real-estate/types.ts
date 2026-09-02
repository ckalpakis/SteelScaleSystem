import type { Prisma } from '@prisma/client';

export interface NormalizedRealEstateAgent {
  firstName?: string;
  lastName?: string;
  fullName: string;
  phone?: string;
  email?: string;
  profileUrl?: string;
  headshotUrl?: string;
  website?: string;
  instagramUrl?: string;
  facebookUrl?: string;
  tiktokUrl?: string;
  brokerage?: string;
  licenseNumber?: string;
}

export interface NormalizedRealEstateListing {
  externalId: string;
  propertyUrl?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  latitude?: number;
  longitude?: number;
  price?: number;
  bedrooms?: number;
  bathrooms?: number;
  squareFeet?: number;
  status?: string;
  listedAt?: Date;
  images: string[];
  brokerage?: string;
  agent?: NormalizedRealEstateAgent;
}

export type RealEstateAdapterValidation<T> =
  { valid: true; value: T } | { valid: false; errors: string[] };

export interface RealEstateListingAdapter<T> {
  readonly provider: string;
  validate(payload: unknown): RealEstateAdapterValidation<T>;
  getExternalIdentifier(payload: unknown): string | undefined;
  normalize(payload: T): NormalizedRealEstateListing;
}

export interface RealEstateIngestionRequest<T> {
  clientId: string;
  idempotencyKey: string;
  adapter: RealEstateListingAdapter<T>;
  records: unknown[];
  sourceReference?: string;
  defaultCountryCallingCode?: string;
  observedAt?: Date;
  metadata?: Prisma.InputJsonValue;
}

export interface RealEstateIngestionResult {
  runId: string;
  status: 'completed' | 'partially_completed' | 'failed';
  received: number;
  valid: number;
  invalid: number;
  newListings: number;
  updatedListings: number;
  duplicateListings: number;
  newAgents: number;
  updatedAgents: number;
  signalsCreated: number;
  failed: number;
}
