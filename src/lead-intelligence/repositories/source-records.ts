import { Prisma } from '@prisma/client';

import { db } from '../../db/client.js';
import { normalizeProvider, payloadHash, sourceRecordKey } from '../ingestion/normalization.js';

export interface UpsertSourceRecordInput {
  clientId: string;
  ingestionRunId?: string;
  provider: string;
  externalId?: string;
  sourceUrl?: string;
  rawPayload: Prisma.InputJsonValue;
  sourceCreatedAt?: Date;
  leadId?: string;
  businessId?: string;
  contactId?: string;
}

export async function upsertSourceRecord(
  input: UpsertSourceRecordInput,
  transaction?: Prisma.TransactionClient,
) {
  const database = transaction ?? db;
  const provider = normalizeProvider(input.provider);
  const recordKey = sourceRecordKey(input);
  const hash = payloadHash(input.rawPayload);
  const now = new Date();

  return database.leadSourceRecord.upsert({
    where: {
      clientId_provider_recordKey: { clientId: input.clientId, provider, recordKey },
    },
    create: {
      clientId: input.clientId,
      ingestionRunId: input.ingestionRunId,
      provider,
      recordKey,
      externalId: input.externalId?.trim() || null,
      sourceUrl: input.sourceUrl?.trim() || null,
      rawPayload: input.rawPayload,
      payloadHash: hash,
      sourceCreatedAt: input.sourceCreatedAt,
      leadId: input.leadId,
      businessId: input.businessId,
      contactId: input.contactId,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      ingestionRunId: input.ingestionRunId,
      sourceUrl: input.sourceUrl?.trim() || null,
      rawPayload: input.rawPayload,
      payloadHash: hash,
      sourceCreatedAt: input.sourceCreatedAt,
      leadId: input.leadId,
      businessId: input.businessId,
      contactId: input.contactId,
      lastSeenAt: now,
    },
  });
}

export async function upsertSourceRecordWithVersion(
  input: UpsertSourceRecordInput & { ingestionRunId: string; observedAt: Date },
  transaction: Prisma.TransactionClient,
) {
  const provider = normalizeProvider(input.provider);
  const recordKey = sourceRecordKey(input);
  const hash = payloadHash(input.rawPayload);
  const previous = await transaction.leadSourceRecord.findUnique({
    where: {
      clientId_provider_recordKey: { clientId: input.clientId, provider, recordKey },
    },
    select: { id: true, payloadHash: true },
  });
  const sourceRecord = await upsertSourceRecord(input, transaction);
  const version = await transaction.leadSourceRecordVersion.upsert({
    where: {
      sourceRecordId_ingestionRunId_payloadHash: {
        sourceRecordId: sourceRecord.id,
        ingestionRunId: input.ingestionRunId,
        payloadHash: hash,
      },
    },
    create: {
      sourceRecordId: sourceRecord.id,
      ingestionRunId: input.ingestionRunId,
      payloadHash: hash,
      rawPayload: input.rawPayload,
      observedAt: input.observedAt,
    },
    update: {},
  });

  return {
    sourceRecord,
    version,
    isNew: !previous,
    payloadChanged: previous?.payloadHash !== hash,
  };
}
