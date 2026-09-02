import { Prisma } from '@prisma/client';

import { db } from '../../db/client.js';
import {
  normalizeBusinessName,
  normalizeDomain,
  normalizeLocationPart,
  normalizePhone,
  normalizeProvider,
  sourceRecordKey,
} from '../ingestion/normalization.js';
import type { BusinessIdentityInput, BusinessMatchResult } from '../types/business.js';

function noMatch(): BusinessMatchResult {
  return {
    shouldAutoMerge: false,
    requiresReview: false,
    conflictingBusinessIds: [],
  };
}

export async function findBusinessMatch(
  clientId: string,
  input: BusinessIdentityInput,
  transaction?: Prisma.TransactionClient,
): Promise<BusinessMatchResult> {
  const database = transaction ?? db;
  if (input.provider && input.externalId) {
    const sourceRecord = await database.leadSourceRecord.findUnique({
      where: {
        clientId_provider_recordKey: {
          clientId,
          provider: normalizeProvider(input.provider),
          recordKey: sourceRecordKey({ externalId: input.externalId, rawPayload: {} }),
        },
      },
      select: { businessId: true },
    });
    if (sourceRecord?.businessId) {
      return {
        businessId: sourceRecord.businessId,
        matchedBy: 'provider_external_id',
        shouldAutoMerge: true,
        requiresReview: false,
        conflictingBusinessIds: [],
      };
    }
  }

  const normalizedDomain = normalizeDomain(input.website);
  const normalizedPhone = normalizePhone(input.phone, input.defaultCountryCallingCode);
  const normalizedName = normalizeBusinessName(input.name);
  const normalizedCity = normalizeLocationPart(input.city);
  const normalizedState = normalizeLocationPart(input.state);

  const candidates = await Promise.all([
    input.googlePlaceId
      ? database.prospectBusiness.findMany({
          where: { clientId, googlePlaceId: input.googlePlaceId },
          take: 2,
        })
      : Promise.resolve([]),
    input.googleCid
      ? database.prospectBusiness.findMany({
          where: { clientId, googleCid: input.googleCid },
          take: 2,
        })
      : Promise.resolve([]),
    normalizedDomain
      ? database.prospectBusiness.findMany({ where: { clientId, normalizedDomain }, take: 3 })
      : Promise.resolve([]),
    normalizedPhone
      ? database.prospectBusiness.findMany({ where: { clientId, normalizedPhone }, take: 3 })
      : Promise.resolve([]),
  ]);
  const [placeMatches, cidMatches, domainMatches, phoneMatches] = candidates;
  const identifierMatches = new Map<string, (typeof placeMatches)[number]>();
  for (const business of [...placeMatches, ...cidMatches, ...domainMatches, ...phoneMatches]) {
    identifierMatches.set(business.id, business);
  }

  if (identifierMatches.size > 1) {
    return {
      shouldAutoMerge: false,
      requiresReview: true,
      conflictingBusinessIds: [...identifierMatches.keys()],
    };
  }

  const match = identifierMatches.values().next().value;
  if (match) {
    const matchedBy = placeMatches.length
      ? 'google_place_id'
      : cidMatches.length
        ? 'google_cid'
        : domainMatches.length
          ? 'normalized_domain'
          : 'normalized_phone';
    return {
      businessId: match.id,
      matchedBy,
      shouldAutoMerge: true,
      requiresReview: false,
      conflictingBusinessIds: [],
    };
  }

  if (!normalizedName || !normalizedCity || !normalizedState) return noMatch();
  const identityMatches = await database.prospectBusiness.findMany({
    where: { clientId, normalizedName, normalizedCity, normalizedState },
    select: { id: true },
    take: 3,
  });
  if (!identityMatches.length) return noMatch();

  return {
    businessId: identityMatches.length === 1 ? identityMatches[0]?.id : undefined,
    matchedBy: identityMatches.length === 1 ? 'exact_normalized_identity' : undefined,
    shouldAutoMerge: false,
    requiresReview: true,
    conflictingBusinessIds: identityMatches.map((candidate) => candidate.id),
  };
}
