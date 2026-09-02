export interface BusinessIdentityInput {
  provider?: string;
  externalId?: string;
  googlePlaceId?: string;
  googleCid?: string;
  website?: string;
  phone?: string;
  name: string;
  city?: string;
  state?: string;
  defaultCountryCallingCode?: string;
}

export type BusinessMatchReason =
  | 'provider_external_id'
  | 'google_place_id'
  | 'google_cid'
  | 'normalized_domain'
  | 'normalized_phone'
  | 'exact_normalized_identity';

export interface BusinessMatchResult {
  businessId?: string;
  matchedBy?: BusinessMatchReason;
  shouldAutoMerge: boolean;
  requiresReview: boolean;
  conflictingBusinessIds: string[];
}
