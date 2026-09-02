import type { DeliveryDestination, IntelligenceOffer } from '@prisma/client';

export interface DeliveryCriteria {
  minimumScore: number;
  requirePhone?: boolean;
  requireApprovedContactChannel?: boolean;
  maximumListingAgeDays?: number;
  notContactedWithinDays?: number;
}

export interface QualifiedLeadPayload {
  payloadVersion: string;
  campaignId: string;
  campaignKey: string;
  leadId: string;
  clientId: string;
  offer: IntelligenceOffer;
  score: number;
  name: string;
  phone: string | null;
  email: string | null;
  website: string | null;
  location: { city: string | null; state: string | null };
  niche: string | null;
  listing: {
    address: string | null;
    url: string | null;
    price: number | null;
    listedAt: string | null;
  } | null;
  compliance: {
    contactableProspect: boolean;
    manualCallCandidate: boolean;
    smsConsent: string;
    smsEligible: boolean;
    doNotContact: boolean;
    suppressed: boolean;
  };
}

export interface DeliveryTargetResult {
  externalId?: string;
}

export interface DeliveryTarget {
  readonly destination: DeliveryDestination;
  deliver(payload: QualifiedLeadPayload, deliveryRecordId: string): Promise<DeliveryTargetResult>;
}

export interface CampaignDeliveryResult {
  campaignId: string;
  eligible: number;
  delivered: number;
  failed: number;
  duplicatesPrevented: number;
  csv?: string;
  errors: Array<{ leadId: string; error: string }>;
}
