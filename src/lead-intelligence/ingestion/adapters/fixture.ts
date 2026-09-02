import type {
  AdapterValidationResult,
  LeadSourceAdapter,
  NormalizedBusiness,
  NormalizedContact,
  NormalizedSignal,
} from '../types.js';

export interface FixtureLeadPayload {
  externalId?: string;
  sourceUrl?: string;
  sourceCreatedAt?: string;
  business: Omit<NormalizedBusiness, 'sourceCreatedAt'> & { sourceCreatedAt?: string };
  contacts?: Array<Omit<NormalizedContact, 'sourceCreatedAt'> & { sourceCreatedAt?: string }>;
  signals?: Array<
    Omit<NormalizedSignal, 'observedAt' | 'expiresAt'> & {
      observedAt?: string;
      expiresAt?: string;
    }
  >;
}

function optionalDate(value: string | undefined): Date | undefined {
  return value ? new Date(value) : undefined;
}

export class FixtureLeadSourceAdapter implements LeadSourceAdapter<FixtureLeadPayload> {
  readonly provider: string;

  constructor(provider = 'development_fixture') {
    this.provider = provider;
  }

  getExternalIdentifier(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') return undefined;
    const value = (payload as Record<string, unknown>).externalId;
    return typeof value === 'string' ? value : undefined;
  }

  validate(payload: unknown): AdapterValidationResult<FixtureLeadPayload> {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { valid: false, errors: ['payload must be an object'] };
    }
    const candidate = payload as Record<string, unknown>;
    if (!candidate.business || typeof candidate.business !== 'object') {
      return { valid: false, errors: ['business must be an object'] };
    }
    const business = candidate.business as Record<string, unknown>;
    if (typeof business.name !== 'string' || !business.name.trim()) {
      return { valid: false, errors: ['business.name is required'] };
    }
    if (candidate.contacts !== undefined && !Array.isArray(candidate.contacts)) {
      return { valid: false, errors: ['contacts must be an array'] };
    }
    if (candidate.signals !== undefined && !Array.isArray(candidate.signals)) {
      return { valid: false, errors: ['signals must be an array'] };
    }
    return { valid: true, value: payload as FixtureLeadPayload };
  }

  normalize(payload: FixtureLeadPayload) {
    return {
      externalId: payload.externalId,
      sourceUrl: payload.sourceUrl,
      sourceCreatedAt: optionalDate(payload.sourceCreatedAt),
      business: {
        ...payload.business,
        sourceCreatedAt: optionalDate(payload.business.sourceCreatedAt),
      },
      contacts: payload.contacts?.map((contact) => ({
        ...contact,
        sourceCreatedAt: optionalDate(contact.sourceCreatedAt),
      })),
      signals: payload.signals?.map((signal) => ({
        ...signal,
        observedAt: optionalDate(signal.observedAt),
        expiresAt: optionalDate(signal.expiresAt),
      })),
    };
  }
}
