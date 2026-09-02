import { Prisma, type IntelligenceRunStatus } from '@prisma/client';

import { db } from '../../db/client.js';
import { logger } from '../../utils/logger.js';
import { findBusinessMatch } from '../repositories/businesses.js';
import { upsertSourceRecordWithVersion } from '../repositories/source-records.js';
import {
  normalizeBusinessName,
  normalizeDomain,
  normalizeEmail,
  normalizeLocationPart,
  normalizePhone,
  normalizeProvider,
} from './normalization.js';
import type {
  IngestionRequest,
  IngestionResult,
  NormalizedBusiness,
  NormalizedContact,
  NormalizedSignal,
} from './types.js';
import { validateNormalizedProspect } from './validation.js';

interface Counters {
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
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error('Payload is not JSON serializable');
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultFromRun(run: {
  id: string;
  status: IntelligenceRunStatus;
  recordsReceived: number;
  recordsValid: number;
  recordsInvalid: number;
  newBusinesses: number;
  updatedBusinesses: number;
  newContacts: number;
  updatedContacts: number;
  duplicates: number;
  recordsFailed: number;
  signalsCreated: number;
  signalsUpdated: number;
  startedAt: Date | null;
  completedAt: Date | null;
}): IngestionResult {
  if (!run.startedAt || !run.completedAt || run.status === 'pending' || run.status === 'running') {
    throw new Error(`Ingestion run ${run.id} is not complete`);
  }
  return {
    runId: run.id,
    status: run.status,
    received: run.recordsReceived,
    valid: run.recordsValid,
    invalid: run.recordsInvalid,
    newBusinesses: run.newBusinesses,
    updatedBusinesses: run.updatedBusinesses,
    newContacts: run.newContacts,
    updatedContacts: run.updatedContacts,
    duplicates: run.duplicates,
    failed: run.recordsFailed,
    signalsCreated: run.signalsCreated,
    signalsUpdated: run.signalsUpdated,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
  };
}

async function lockIdentities(
  transaction: Prisma.TransactionClient,
  clientId: string,
  provider: string,
  externalId: string | undefined,
  business: NormalizedBusiness,
  defaultCountryCallingCode: string | undefined,
): Promise<void> {
  const identities = [
    externalId && `external:${provider}:${externalId.trim()}`,
    business.googlePlaceId && `place:${business.googlePlaceId.trim()}`,
    business.googleCid && `cid:${business.googleCid.trim()}`,
    normalizeDomain(business.website) && `domain:${normalizeDomain(business.website)}`,
    normalizePhone(business.phone, defaultCountryCallingCode) &&
      `phone:${normalizePhone(business.phone, defaultCountryCallingCode)}`,
  ]
    .filter((identity): identity is string => Boolean(identity))
    .map((identity) => `${clientId}:${identity}`)
    .sort();

  for (const identity of identities) {
    await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 0))::text AS locked`;
  }
}

function businessData(
  clientId: string,
  business: NormalizedBusiness,
  observedAt: Date,
  defaultCountryCallingCode?: string,
): Prisma.ProspectBusinessUncheckedCreateInput {
  return {
    clientId,
    name: business.name.trim(),
    normalizedName: normalizeBusinessName(business.name),
    website: business.website?.trim(),
    normalizedDomain: normalizeDomain(business.website),
    phone: business.phone?.trim(),
    normalizedPhone: normalizePhone(business.phone, defaultCountryCallingCode),
    addressLine1: business.addressLine1?.trim(),
    addressLine2: business.addressLine2?.trim(),
    city: business.city?.trim(),
    state: business.state?.trim(),
    normalizedCity: normalizeLocationPart(business.city),
    normalizedState: normalizeLocationPart(business.state),
    postalCode: business.postalCode?.trim(),
    countryCode: business.countryCode?.trim().toUpperCase(),
    latitude: business.latitude,
    longitude: business.longitude,
    googlePlaceId: business.googlePlaceId?.trim(),
    googleCid: business.googleCid?.trim(),
    category: business.category?.trim(),
    niche: business.niche?.trim(),
    sourceCreatedAt: business.sourceCreatedAt,
    firstSeenAt: observedAt,
    lastSeenAt: observedAt,
  };
}

async function upsertContact(
  transaction: Prisma.TransactionClient,
  clientId: string,
  businessId: string,
  contact: NormalizedContact,
  observedAt: Date,
  defaultCountryCallingCode?: string,
): Promise<'new' | 'updated'> {
  const normalizedPhone = normalizePhone(contact.phone, defaultCountryCallingCode);
  const normalizedEmail = normalizeEmail(contact.email);
  const fullName =
    contact.fullName?.trim() ||
    [contact.firstName?.trim(), contact.lastName?.trim()].filter(Boolean).join(' ') ||
    undefined;
  const normalizedName = fullName ? normalizeBusinessName(fullName) : undefined;
  const candidates = await transaction.prospectContact.findMany({
    where: {
      clientId,
      businessId,
      OR: [
        ...(normalizedPhone ? [{ normalizedPhone }] : []),
        ...(normalizedEmail ? [{ normalizedEmail }] : []),
        ...(!normalizedPhone && !normalizedEmail && normalizedName ? [{ normalizedName }] : []),
      ],
    },
    take: 3,
  });
  const ids = new Set(candidates.map(({ id }) => id));
  if (ids.size > 1) throw new Error('Contact identifiers resolve to conflicting contacts');

  const data = {
    firstName: contact.firstName?.trim(),
    lastName: contact.lastName?.trim(),
    fullName,
    normalizedName,
    title: contact.title?.trim(),
    relationship: contact.relationship?.trim(),
    phone: contact.phone?.trim(),
    phoneType: contact.phoneType?.trim(),
    normalizedPhone,
    email: contact.email?.trim(),
    normalizedEmail,
    linkedinUrl: contact.linkedinUrl?.trim(),
    instagramUrl: contact.instagramUrl?.trim(),
    facebookUrl: contact.facebookUrl?.trim(),
    tiktokUrl: contact.tiktokUrl?.trim(),
    sourceCreatedAt: contact.sourceCreatedAt,
    lastSeenAt: observedAt,
  };
  const existing = candidates[0];
  if (existing) {
    await transaction.prospectContact.update({ where: { id: existing.id }, data });
    return 'updated';
  }
  await transaction.prospectContact.create({
    data: { clientId, businessId, ...data, firstSeenAt: observedAt },
  });
  return 'new';
}

function signalProjection(signal: NormalizedSignal): {
  booleanValue?: boolean;
  numberValue?: number;
  textValue?: string;
  dateValue?: Date;
} {
  const kind =
    signal.kind ??
    (typeof signal.value === 'boolean'
      ? 'boolean'
      : typeof signal.value === 'number'
        ? 'number'
        : typeof signal.value === 'string'
          ? 'text'
          : 'json');
  if (kind === 'boolean' && typeof signal.value === 'boolean') {
    return { booleanValue: signal.value };
  }
  if (kind === 'number' && typeof signal.value === 'number') {
    return { numberValue: signal.value };
  }
  if (kind === 'text' && typeof signal.value === 'string') return { textValue: signal.value };
  if (kind === 'date' && typeof signal.value === 'string') {
    const date = new Date(signal.value);
    if (!Number.isNaN(date.valueOf())) return { dateValue: date };
  }
  return {};
}

async function recordError(input: {
  runId: string;
  sourceRecordId?: string;
  index: number;
  stage: string;
  message: string;
  details?: Prisma.InputJsonValue;
  rawPayload?: Prisma.InputJsonValue;
}): Promise<void> {
  await db.ingestionError.create({
    data: {
      ingestionRunId: input.runId,
      sourceRecordId: input.sourceRecordId,
      recordIndex: input.index,
      stage: input.stage,
      message: input.message.slice(0, 4000),
      details: input.details,
      rawPayload: input.rawPayload,
    },
  });
}

export async function ingestLeadSource<T>(request: IngestionRequest<T>): Promise<IngestionResult> {
  const provider = normalizeProvider(request.adapter.provider);
  if (!provider) throw new Error('Adapter provider is required');
  if (!request.idempotencyKey.trim()) throw new Error('idempotencyKey is required');
  const runIdentity = {
    clientId: request.clientId,
    provider,
    idempotencyKey: request.idempotencyKey.trim(),
  };
  const priorRun = await db.ingestionRun.findUnique({
    where: { clientId_provider_idempotencyKey: runIdentity },
  });
  if (priorRun) return resultFromRun(priorRun);
  const startedAt = new Date();
  let run;
  try {
    run = await db.ingestionRun.create({
      data: {
        clientId: request.clientId,
        provider,
        idempotencyKey: runIdentity.idempotencyKey,
        status: 'running',
        sourceReference: request.sourceReference,
        recordsReceived: request.records.length,
        metadata: request.metadata,
        startedAt,
      },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002')
      throw error;
    const existing = await db.ingestionRun.findUniqueOrThrow({
      where: {
        clientId_provider_idempotencyKey: runIdentity,
      },
    });
    return resultFromRun(existing);
  }

  const counters: Counters = {
    valid: 0,
    invalid: 0,
    newBusinesses: 0,
    updatedBusinesses: 0,
    newContacts: 0,
    updatedContacts: 0,
    duplicates: 0,
    failed: 0,
    signalsCreated: 0,
    signalsUpdated: 0,
  };
  const observedAt = request.observedAt ?? new Date();

  for (const [index, rawRecord] of request.records.entries()) {
    let rawPayload: Prisma.InputJsonValue;
    try {
      rawPayload = jsonValue(rawRecord);
    } catch (error) {
      counters.invalid += 1;
      await recordError({
        runId: run.id,
        index,
        stage: 'raw_payload',
        message: errorMessage(error),
      });
      continue;
    }
    let externalId: string | undefined;
    let adapterValidation;
    try {
      externalId = request.adapter.getExternalIdentifier(rawRecord)?.trim() || undefined;
      adapterValidation = request.adapter.validate(rawRecord);
    } catch (error) {
      counters.failed += 1;
      await recordError({
        runId: run.id,
        index,
        stage: 'adapter',
        message: errorMessage(error),
        rawPayload,
      });
      logger.error(
        { clientId: request.clientId, provider, ingestionRunId: run.id, index, error },
        'Lead source adapter failed',
      );
      continue;
    }
    if (!adapterValidation.valid) {
      counters.invalid += 1;
      let sourceRecordId: string | undefined;
      try {
        sourceRecordId = await db.$transaction(async (transaction) => {
          const stored = await upsertSourceRecordWithVersion(
            {
              clientId: request.clientId,
              ingestionRunId: run.id,
              provider,
              externalId,
              rawPayload,
              observedAt,
            },
            transaction,
          );
          return stored.sourceRecord.id;
        });
      } catch (error) {
        logger.error(
          { clientId: request.clientId, provider, index, error },
          'Failed to retain invalid ingestion payload',
        );
      }
      await recordError({
        runId: run.id,
        sourceRecordId,
        index,
        stage: 'adapter_validation',
        message: adapterValidation.errors.join('; '),
        details: adapterValidation.errors,
        rawPayload,
      });
      continue;
    }

    try {
      const prospect = request.adapter.normalize(adapterValidation.value, {
        observedAt,
        defaultCountryCallingCode: request.defaultCountryCallingCode,
      });
      prospect.externalId ??= externalId;
      const errors = validateNormalizedProspect(prospect, request.defaultCountryCallingCode);
      if (errors.length) {
        counters.invalid += 1;
        const stored = await db.$transaction((transaction) =>
          upsertSourceRecordWithVersion(
            {
              clientId: request.clientId,
              ingestionRunId: run.id,
              provider,
              externalId: prospect.externalId,
              sourceUrl: prospect.sourceUrl,
              rawPayload,
              sourceCreatedAt: prospect.sourceCreatedAt,
              observedAt,
            },
            transaction,
          ),
        );
        await recordError({
          runId: run.id,
          sourceRecordId: stored.sourceRecord.id,
          index,
          stage: 'normalized_validation',
          message: errors.join('; '),
          details: errors,
          rawPayload,
        });
        continue;
      }
      counters.valid += 1;

      const outcome = await db.$transaction(async (transaction) => {
        await lockIdentities(
          transaction,
          request.clientId,
          provider,
          prospect.externalId,
          prospect.business,
          request.defaultCountryCallingCode,
        );
        const match = await findBusinessMatch(
          request.clientId,
          {
            provider,
            externalId: prospect.externalId,
            name: prospect.business.name,
            website: prospect.business.website,
            phone: prospect.business.phone,
            city: prospect.business.city,
            state: prospect.business.state,
            googlePlaceId: prospect.business.googlePlaceId,
            googleCid: prospect.business.googleCid,
            defaultCountryCallingCode: request.defaultCountryCallingCode,
          },
          transaction,
        );
        if (match.requiresReview && match.matchedBy !== 'exact_normalized_identity') {
          throw new Error(
            `Conflicting business identifiers: ${match.conflictingBusinessIds.join(', ')}`,
          );
        }
        const data = businessData(
          request.clientId,
          prospect.business,
          observedAt,
          request.defaultCountryCallingCode,
        );
        const existingBusinessId = match.shouldAutoMerge ? match.businessId : undefined;
        const business = existingBusinessId
          ? await transaction.prospectBusiness.findUniqueOrThrow({
              where: { id: existingBusinessId },
            })
          : await transaction.prospectBusiness.create({ data });
        const lead = await transaction.lead.upsert({
          where: { clientId_businessId: { clientId: request.clientId, businessId: business.id } },
          create: {
            clientId: request.clientId,
            businessId: business.id,
            sourceCreatedAt: prospect.sourceCreatedAt,
            firstSeenAt: observedAt,
            lastSeenAt: observedAt,
          },
          update: { lastSeenAt: observedAt },
        });
        const stored = await upsertSourceRecordWithVersion(
          {
            clientId: request.clientId,
            ingestionRunId: run.id,
            provider,
            externalId: prospect.externalId,
            sourceUrl: prospect.sourceUrl,
            rawPayload,
            sourceCreatedAt: prospect.sourceCreatedAt,
            observedAt,
            leadId: lead.id,
            businessId: business.id,
          },
          transaction,
        );
        if (!stored.payloadChanged) {
          return {
            duplicate: true,
            newBusiness: false,
            contacts: [] as string[],
            signalsCreated: 0,
          };
        }

        if (existingBusinessId) {
          await transaction.prospectBusiness.update({
            where: { id: existingBusinessId },
            data: { ...data, clientId: undefined, firstSeenAt: undefined },
          });
        }
        const contactOutcomes: string[] = [];
        for (const contact of prospect.contacts ?? []) {
          contactOutcomes.push(
            await upsertContact(
              transaction,
              request.clientId,
              business.id,
              contact,
              observedAt,
              request.defaultCountryCallingCode,
            ),
          );
        }
        for (const signal of prospect.signals ?? []) {
          await transaction.leadSignal.create({
            data: {
              clientId: request.clientId,
              leadId: lead.id,
              sourceRecordId: stored.sourceRecord.id,
              sourceRecordVersionId: stored.version.id,
              key: signal.key,
              value: signal.value,
              ...signalProjection(signal),
              provider,
              confidence: signal.confidence,
              observedAt: signal.observedAt ?? observedAt,
              expiresAt: signal.expiresAt,
              evidence: signal.evidence,
            },
          });
        }
        return {
          duplicate: false,
          newBusiness: !existingBusinessId,
          contacts: contactOutcomes,
          signalsCreated: prospect.signals?.length ?? 0,
        };
      });

      if (outcome.duplicate) counters.duplicates += 1;
      else if (outcome.newBusiness) counters.newBusinesses += 1;
      else counters.updatedBusinesses += 1;
      counters.newContacts += outcome.contacts.filter((value) => value === 'new').length;
      counters.updatedContacts += outcome.contacts.filter((value) => value === 'updated').length;
      counters.signalsCreated += outcome.signalsCreated;
    } catch (error) {
      counters.failed += 1;
      logger.error(
        { clientId: request.clientId, provider, ingestionRunId: run.id, index, error },
        'Lead Intelligence ingestion record failed',
      );
      await recordError({
        runId: run.id,
        index,
        stage: 'ingestion',
        message: errorMessage(error),
        rawPayload,
      });
    }
  }

  const completedAt = new Date();
  const status: IntelligenceRunStatus =
    counters.invalid === 0 && counters.failed === 0
      ? 'completed'
      : counters.valid > counters.failed
        ? 'partially_completed'
        : 'failed';
  const completed = await db.ingestionRun.update({
    where: { id: run.id },
    data: {
      status,
      recordsValid: counters.valid,
      recordsInvalid: counters.invalid,
      recordsCreated: counters.newBusinesses + counters.newContacts,
      recordsUpdated: counters.updatedBusinesses + counters.updatedContacts,
      recordsRejected: counters.invalid,
      newBusinesses: counters.newBusinesses,
      updatedBusinesses: counters.updatedBusinesses,
      newContacts: counters.newContacts,
      updatedContacts: counters.updatedContacts,
      duplicates: counters.duplicates,
      recordsFailed: counters.failed,
      signalsCreated: counters.signalsCreated,
      signalsUpdated: counters.signalsUpdated,
      errorMessage:
        counters.invalid || counters.failed
          ? `${counters.invalid} invalid; ${counters.failed} failed`
          : null,
      completedAt,
    },
  });
  return resultFromRun(completed);
}
