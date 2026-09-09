import { keys, object, string, WorkforceError } from '../../workforce/shared.js';
import { eventTime } from '../contracts.js';
import { mappedRecord, type ExternalNormalizer } from '../intake.js';

/** Authenticated relay envelope; NOT an unauthenticated native marketplace webhook. */
export const normalizeGhlOpportunity: ExternalNormalizer = async (tx, connection, value) => {
  if (connection.provider !== 'ghl') throw new WorkforceError(403, 'ghl_connection_required');
  const envelope = object(value);
  keys(envelope, ['id', 'occurredAt', 'payload', 'correlationId']);
  const payload = object(envelope.payload);
  if (
    ![
      'OpportunityUpdate',
      'OpportunityStageUpdate',
      'OpportunityStatusUpdate',
      'OpportunityMonetaryValueUpdate',
    ].includes(String(payload.type))
  )
    throw new WorkforceError(400, 'unsupported_ghl_event');
  if (!connection.externalAccountId || payload.locationId !== connection.externalAccountId)
    throw new WorkforceError(403, 'ghl_location_mismatch');
  const externalId = string(payload.id, 250);
  const existing = await mappedRecord(
    tx,
    connection.organizationId,
    connection.id,
    'opportunity',
    externalId,
  );
  if (!existing || existing.internalEntityType !== 'opportunity')
    throw new WorkforceError(409, 'opportunity_mapping_required');
  const opportunity = await tx.opportunity.findFirstOrThrow({
    where: { organizationId: connection.organizationId, id: existing.internalEntityId },
  });
  const contact = await mappedRecord(
    tx,
    connection.organizationId,
    connection.id,
    'customer',
    string(payload.contactId, 250),
  );
  if (
    !contact ||
    contact.internalEntityType !== 'contact' ||
    contact.internalEntityId !== opportunity.customerId
  )
    throw new WorkforceError(409, 'ghl_contact_mismatch');
  const pipeline = await mappedRecord(
    tx,
    connection.organizationId,
    connection.id,
    'pipeline',
    string(payload.pipelineId, 250),
  );
  const stage = await mappedRecord(
    tx,
    connection.organizationId,
    connection.id,
    'pipeline_stage',
    string(payload.pipelineStageId, 250),
  );
  if (
    !pipeline ||
    pipeline.internalEntityType !== 'pipeline' ||
    !stage ||
    stage.internalEntityType !== 'pipeline_stage'
  )
    throw new WorkforceError(409, 'pipeline_mapping_required');
  const internalStage = await tx.pipelineStage.findFirst({
    where: {
      organizationId: connection.organizationId,
      id: stage.internalEntityId,
      pipelineId: pipeline.internalEntityId,
      record: { archivedAt: null },
    },
  });
  if (!internalStage || payload.status !== internalStage.outcome)
    throw new WorkforceError(409, 'stage_outcome_mismatch');
  // GHL's payload lacks currency: use the explicitly mapped opportunity's currency.
  const digits =
    new Intl.NumberFormat('en', {
      style: 'currency',
      currency: opportunity.currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  const amount = payload.monetaryValue;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0)
    throw new WorkforceError(400, 'invalid_ghl_amount');
  const minor = amount * 10 ** digits;
  if (Math.abs(minor - Math.round(minor)) > 0.000001 || minor > 2_147_483_647)
    throw new WorkforceError(400, 'invalid_ghl_amount');
  return {
    version: 2,
    id: string(envelope.id, 180),
    type: 'opportunity.updated',
    occurredAt: eventTime(envelope.occurredAt),
    originEventType: string(payload.type, 100),
    entity: { type: 'opportunity', externalRecordType: 'opportunity', externalId },
    data: {
      changes: {
        title: string(payload.name, 250),
        stageId: internalStage.id,
        pipelineId: internalStage.pipelineId,
        amountMinor: Math.round(minor),
      },
    },
    ...(envelope.correlationId === undefined
      ? {}
      : { correlationId: string(envelope.correlationId, 36) }),
  };
};
