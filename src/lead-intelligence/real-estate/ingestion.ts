import { Prisma, type IntelligenceRunStatus } from '@prisma/client';

import { db } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import {
  normalizeBusinessName,
  normalizeEmail,
  normalizePhone,
  normalizeProvider,
  payloadHash,
} from '../ingestion/normalization.js';
import type {
  NormalizedRealEstateAgent,
  NormalizedRealEstateListing,
  RealEstateIngestionRequest,
  RealEstateIngestionResult,
} from './types.js';

export const REAL_ESTATE_SIGNAL_KEYS = {
  ACTIVE_LISTING_COUNT: 'active_listing_count',
  LATEST_LISTING_DATE: 'latest_listing_date',
  LATEST_LISTING_PRICE: 'latest_listing_price',
  NEW_LISTING_LAST_24_HOURS: 'new_listing_last_24_hours',
  NEW_LISTING_LAST_72_HOURS: 'new_listing_last_72_hours',
  NEW_LISTING_LAST_7_DAYS: 'new_listing_last_7_days',
  HAS_AGENT_HEADSHOT: 'has_agent_headshot',
  HAS_INSTAGRAM: 'has_instagram',
  HAS_FACEBOOK: 'has_facebook',
  HAS_TIKTOK: 'has_tiktok',
  HAS_AGENT_WEBSITE: 'has_agent_website',
  LISTING_PHOTO_COUNT: 'listing_photo_count',
  BROKERAGE: 'brokerage',
} as const;

function jsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Payload is not JSON serializable');
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function normalizedUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    if (!['http:', 'https:'].includes(url.protocol)) return undefined;
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export function normalizeListingAddress(listing: NormalizedRealEstateListing): string | undefined {
  const parts = [listing.address, listing.city, listing.state, listing.postalCode]
    .map((part) =>
      part
        ?.normalize('NFKC')
        .toLocaleLowerCase('en-US')
        .replace(/[^a-z0-9#]+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  return parts.length >= 3 ? parts.join('|') : undefined;
}

function activeStatus(status: string | null): boolean {
  if (!status) return true;
  const normalized = status.toUpperCase().replace(/[^A-Z]+/g, '_');
  return ['ACTIVE', 'FOR_SALE', 'FOR_RENT', 'COMING_SOON', 'NEW'].includes(normalized);
}

async function resolveAgent(
  transaction: Prisma.TransactionClient,
  clientId: string,
  agent: NormalizedRealEstateAgent,
  observedAt: Date,
  defaultCountryCallingCode?: string,
) {
  const normalizedName = normalizeBusinessName(agent.fullName);
  const normalizedEmail = normalizeEmail(agent.email);
  const normalizedPhone = normalizePhone(agent.phone, defaultCountryCallingCode);
  const normalizedProfileUrl = normalizedUrl(agent.profileUrl);
  const normalizedBrokerage = agent.brokerage ? normalizeBusinessName(agent.brokerage) : undefined;
  const candidates = await transaction.realEstateAgent.findMany({
    where: {
      clientId,
      OR: [
        ...(normalizedEmail ? [{ normalizedEmail }] : []),
        ...(normalizedPhone ? [{ normalizedPhone }] : []),
        ...(normalizedProfileUrl ? [{ normalizedProfileUrl }] : []),
        ...(!normalizedEmail && !normalizedPhone && !normalizedProfileUrl && normalizedBrokerage
          ? [
              {
                normalizedName,
                brokerage: { equals: agent.brokerage, mode: 'insensitive' as const },
              },
            ]
          : []),
      ],
    },
  });
  const ids = new Set(candidates.map(({ id }) => id));
  if (ids.size > 1) throw new Error('Agent identifiers resolve to conflicting canonical agents');
  const data = {
    firstName: agent.firstName?.trim(),
    lastName: agent.lastName?.trim(),
    fullName: agent.fullName.trim(),
    normalizedName,
    phone: agent.phone?.trim(),
    normalizedPhone,
    email: agent.email?.trim(),
    normalizedEmail,
    profileUrl: agent.profileUrl?.trim(),
    normalizedProfileUrl,
    headshotUrl: agent.headshotUrl?.trim(),
    website: agent.website?.trim(),
    instagramUrl: agent.instagramUrl?.trim(),
    facebookUrl: agent.facebookUrl?.trim(),
    tiktokUrl: agent.tiktokUrl?.trim(),
    brokerage: agent.brokerage?.trim(),
    licenseNumber: agent.licenseNumber?.trim(),
    lastSeenAt: observedAt,
  };
  const existing = candidates[0];
  if (existing) {
    return {
      agent: await transaction.realEstateAgent.update({ where: { id: existing.id }, data }),
      created: false,
    };
  }
  const lead = await transaction.lead.create({
    data: { clientId, firstSeenAt: observedAt, lastSeenAt: observedAt },
  });
  return {
    agent: await transaction.realEstateAgent.create({
      data: { clientId, leadId: lead.id, firstSeenAt: observedAt, ...data },
    }),
    created: true,
  };
}

async function persistAgentSignals(
  transaction: Prisma.TransactionClient,
  agent: Awaited<ReturnType<typeof resolveAgent>>['agent'],
  provider: string,
  observedAt: Date,
): Promise<number> {
  const listings = await transaction.realEstateListing.findMany({
    where: { agentId: agent.id },
    orderBy: [{ listedAt: 'desc' }, { lastSeenAt: 'desc' }],
  });
  const active = listings.filter(({ status }) => activeStatus(status));
  const latest = active[0] ?? listings[0];
  const ageMs = latest?.listedAt ? observedAt.getTime() - latest.listedAt.getTime() : undefined;
  const definitions: Array<{
    key: string;
    value: Prisma.InputJsonValue;
    booleanValue?: boolean;
    numberValue?: number;
    textValue?: string;
    dateValue?: Date;
  }> = [
    {
      key: REAL_ESTATE_SIGNAL_KEYS.ACTIVE_LISTING_COUNT,
      value: active.length,
      numberValue: active.length,
    },
    ...(latest?.listedAt
      ? [
          {
            key: REAL_ESTATE_SIGNAL_KEYS.LATEST_LISTING_DATE,
            value: latest.listedAt.toISOString(),
            dateValue: latest.listedAt,
          },
        ]
      : []),
    ...(latest?.price
      ? [
          {
            key: REAL_ESTATE_SIGNAL_KEYS.LATEST_LISTING_PRICE,
            value: latest.price.toNumber(),
            numberValue: latest.price.toNumber(),
          },
        ]
      : []),
    ...(ageMs === undefined
      ? []
      : [
          {
            key: REAL_ESTATE_SIGNAL_KEYS.NEW_LISTING_LAST_24_HOURS,
            value: ageMs >= 0 && ageMs < 86_400_000,
            booleanValue: ageMs >= 0 && ageMs < 86_400_000,
          },
          {
            key: REAL_ESTATE_SIGNAL_KEYS.NEW_LISTING_LAST_72_HOURS,
            value: ageMs >= 0 && ageMs < 72 * 3_600_000,
            booleanValue: ageMs >= 0 && ageMs < 72 * 3_600_000,
          },
          {
            key: REAL_ESTATE_SIGNAL_KEYS.NEW_LISTING_LAST_7_DAYS,
            value: ageMs >= 0 && ageMs < 7 * 86_400_000,
            booleanValue: ageMs >= 0 && ageMs < 7 * 86_400_000,
          },
        ]),
    {
      key: REAL_ESTATE_SIGNAL_KEYS.HAS_AGENT_HEADSHOT,
      value: Boolean(agent.headshotUrl),
      booleanValue: Boolean(agent.headshotUrl),
    },
    {
      key: REAL_ESTATE_SIGNAL_KEYS.HAS_INSTAGRAM,
      value: Boolean(agent.instagramUrl),
      booleanValue: Boolean(agent.instagramUrl),
    },
    {
      key: REAL_ESTATE_SIGNAL_KEYS.HAS_FACEBOOK,
      value: Boolean(agent.facebookUrl),
      booleanValue: Boolean(agent.facebookUrl),
    },
    {
      key: REAL_ESTATE_SIGNAL_KEYS.HAS_TIKTOK,
      value: Boolean(agent.tiktokUrl),
      booleanValue: Boolean(agent.tiktokUrl),
    },
    {
      key: REAL_ESTATE_SIGNAL_KEYS.HAS_AGENT_WEBSITE,
      value: Boolean(agent.website),
      booleanValue: Boolean(agent.website),
    },
    {
      key: REAL_ESTATE_SIGNAL_KEYS.LISTING_PHOTO_COUNT,
      value: latest?.listingImages.length ?? 0,
      numberValue: latest?.listingImages.length ?? 0,
    },
    ...(agent.brokerage
      ? [
          {
            key: REAL_ESTATE_SIGNAL_KEYS.BROKERAGE,
            value: agent.brokerage,
            textValue: agent.brokerage,
          },
        ]
      : []),
  ];
  await Promise.all(
    definitions.map((definition) =>
      transaction.leadSignal.create({
        data: {
          clientId: agent.clientId,
          leadId: agent.leadId,
          provider,
          observedAt,
          confidence: 0.95,
          evidence: {
            origin: 'DERIVED',
            provider,
            agentId: agent.id,
            listingIds: listings.map(({ id }) => id),
          },
          ...definition,
        },
      }),
    ),
  );
  return definitions.length;
}

export async function ingestRealEstateListings<T>(
  request: RealEstateIngestionRequest<T>,
): Promise<RealEstateIngestionResult> {
  const provider = normalizeProvider(request.adapter.provider);
  const existingRun = await db.ingestionRun.findUnique({
    where: {
      clientId_provider_idempotencyKey: {
        clientId: request.clientId,
        provider,
        idempotencyKey: request.idempotencyKey,
      },
    },
  });
  if (existingRun) {
    const metadata = existingRun.metadata as Record<string, number> | null;
    return {
      runId: existingRun.id,
      status:
        existingRun.status === 'partially_completed'
          ? 'partially_completed'
          : existingRun.status === 'completed'
            ? 'completed'
            : 'failed',
      received: existingRun.recordsReceived,
      valid: existingRun.recordsValid,
      invalid: existingRun.recordsInvalid,
      newListings: metadata?.newListings ?? 0,
      updatedListings: metadata?.updatedListings ?? 0,
      duplicateListings: existingRun.duplicates,
      newAgents: metadata?.newAgents ?? 0,
      updatedAgents: metadata?.updatedAgents ?? 0,
      signalsCreated: existingRun.signalsCreated,
      failed: existingRun.recordsFailed,
    };
  }
  const observedAt = request.observedAt ?? new Date();
  const run = await db.ingestionRun.create({
    data: {
      clientId: request.clientId,
      provider,
      idempotencyKey: request.idempotencyKey,
      sourceReference: request.sourceReference,
      metadata: request.metadata,
      status: 'running',
      recordsReceived: request.records.length,
      startedAt: observedAt,
    },
  });
  const counts = {
    valid: 0,
    invalid: 0,
    newListings: 0,
    updatedListings: 0,
    duplicateListings: 0,
    newAgents: 0,
    updatedAgents: 0,
    signalsCreated: 0,
    failed: 0,
  };
  for (const [recordIndex, raw] of request.records.entries()) {
    const rawPayload = jsonValue(raw);
    const validation = request.adapter.validate(raw);
    if (!validation.valid) {
      counts.invalid += 1;
      await db.ingestionError.create({
        data: {
          ingestionRunId: run.id,
          recordIndex,
          stage: 'adapter_validation',
          message: validation.errors.join('; '),
          details: validation.errors,
          rawPayload,
        },
      });
      continue;
    }
    counts.valid += 1;
    try {
      const listing = request.adapter.normalize(validation.value);
      const outcome = await db.$transaction(async (transaction) => {
        const agentOutcome = listing.agent
          ? await resolveAgent(
              transaction,
              request.clientId,
              listing.agent,
              observedAt,
              request.defaultCountryCallingCode,
            )
          : undefined;
        const existingSource = await transaction.realEstateListingSourceRecord.findUnique({
          where: {
            clientId_provider_externalId: {
              clientId: request.clientId,
              provider,
              externalId: listing.externalId,
            },
          },
        });
        const normalizedAddress = normalizeListingAddress(listing);
        let canonical = existingSource
          ? await transaction.realEstateListing.findUniqueOrThrow({
              where: { id: existingSource.listingId },
            })
          : undefined;
        if (!canonical && normalizedAddress && listing.postalCode) {
          const matches = await transaction.realEstateListing.findMany({
            where: {
              clientId: request.clientId,
              normalizedAddress,
              postalCode: listing.postalCode,
            },
            take: 2,
          });
          if (matches.length > 1)
            throw new Error('Listing address resolves to conflicting canonical listings');
          canonical = matches[0];
        }
        const listingData = {
          leadId: agentOutcome?.agent.leadId,
          agentId: agentOutcome?.agent.id,
          listingUrl: listing.propertyUrl,
          normalizedAddress,
          status: listing.status?.toUpperCase().replace(/[^A-Z]+/g, '_'),
          address: listing.address,
          city: listing.city,
          state: listing.state,
          postalCode: listing.postalCode,
          latitude: listing.latitude,
          longitude: listing.longitude,
          price: listing.price,
          bedrooms: listing.bedrooms,
          bathrooms: listing.bathrooms,
          squareFeet: listing.squareFeet,
          listingImages: listing.images,
          brokerage: listing.brokerage,
          listedAt: listing.listedAt,
          hasAgentHeadshot: Boolean(listing.agent?.headshotUrl),
          lastSeenAt: observedAt,
        };
        const created = !canonical;
        canonical = canonical
          ? await transaction.realEstateListing.update({
              where: { id: canonical.id },
              data: listingData,
            })
          : await transaction.realEstateListing.create({
              data: {
                clientId: request.clientId,
                provider,
                externalId: listing.externalId,
                rawPayload: { storedSeparately: true, initialProvider: provider },
                firstSeenAt: observedAt,
                ...listingData,
              },
            });
        const hash = payloadHash(raw);
        const source = existingSource
          ? await transaction.realEstateListingSourceRecord.update({
              where: { id: existingSource.id },
              data: {
                ingestionRunId: run.id,
                listingId: canonical.id,
                agentId: agentOutcome?.agent.id,
                sourceUrl: listing.propertyUrl,
                rawPayload,
                payloadHash: hash,
                lastSeenAt: observedAt,
              },
            })
          : await transaction.realEstateListingSourceRecord.create({
              data: {
                clientId: request.clientId,
                ingestionRunId: run.id,
                listingId: canonical.id,
                agentId: agentOutcome?.agent.id,
                provider,
                externalId: listing.externalId,
                sourceUrl: listing.propertyUrl,
                rawPayload,
                payloadHash: hash,
                firstSeenAt: observedAt,
                lastSeenAt: observedAt,
              },
            });
        const existingVersion = await transaction.realEstateListingSourceVersion.findUnique({
          where: { sourceRecordId_payloadHash: { sourceRecordId: source.id, payloadHash: hash } },
        });
        if (!existingVersion) {
          await transaction.realEstateListingSourceVersion.create({
            data: { sourceRecordId: source.id, payloadHash: hash, rawPayload, observedAt },
          });
        }
        const signalsCreated =
          agentOutcome && !existingVersion
            ? await persistAgentSignals(transaction, agentOutcome.agent, provider, observedAt)
            : 0;
        return {
          created,
          duplicate: Boolean(existingVersion),
          agentCreated: agentOutcome?.created,
          signalsCreated,
        };
      });
      if (outcome.duplicate) counts.duplicateListings += 1;
      else if (outcome.created) counts.newListings += 1;
      else counts.updatedListings += 1;
      if (outcome.agentCreated === true) counts.newAgents += 1;
      else if (outcome.agentCreated === false && !outcome.duplicate) counts.updatedAgents += 1;
      counts.signalsCreated += outcome.signalsCreated;
    } catch (error) {
      counts.failed += 1;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        { clientId: request.clientId, provider, recordIndex, error },
        'Real-estate listing ingestion failed',
      );
      await db.ingestionError.create({
        data: { ingestionRunId: run.id, recordIndex, stage: 'ingestion', message, rawPayload },
      });
    }
  }
  const status: IntelligenceRunStatus =
    counts.invalid === 0 && counts.failed === 0
      ? 'completed'
      : counts.valid > counts.failed
        ? 'partially_completed'
        : 'failed';
  await db.ingestionRun.update({
    where: { id: run.id },
    data: {
      status,
      recordsValid: counts.valid,
      recordsInvalid: counts.invalid,
      recordsCreated: counts.newListings + counts.newAgents,
      recordsUpdated: counts.updatedListings + counts.updatedAgents,
      recordsRejected: counts.invalid,
      duplicates: counts.duplicateListings,
      recordsFailed: counts.failed,
      signalsCreated: counts.signalsCreated,
      completedAt: new Date(),
      metadata: jsonValue({
        ...(request.metadata &&
        typeof request.metadata === 'object' &&
        !Array.isArray(request.metadata)
          ? request.metadata
          : {}),
        ...counts,
      }),
    },
  });
  return { runId: run.id, status, received: request.records.length, ...counts };
}
