import { createHash } from 'node:crypto';
import type { LegacyBusinessEvent } from '../events/contracts.js';
import { WorkforceError, type Transaction } from '../shared.js';

function legacyConnectionId(organizationId: string, source: string): string {
  const hex = createHash('md5').update(`crm-source:${organizationId}:${source}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Compatibility adapter only: canonical CRUD has no required source or external identifier.
export async function projectCrm(
  tx: Transaction,
  organizationId: string,
  source: string,
  event: LegacyBusinessEvent,
) {
  if (event.type === 'recovery.scan.requested') return { applied: true };
  const uuidSource = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(source);
  const configured = uuidSource
    ? await tx.externalConnection.findFirst({ where: { organizationId, id: source } })
    : null;
  const connection =
    configured ??
    (await tx.externalConnection.upsert({
      where: {
        organizationId_id: { organizationId, id: legacyConnectionId(organizationId, source) },
      },
      create: {
        id: legacyConnectionId(organizationId, source),
        organizationId,
        name: `Legacy source: ${source}`,
        provider: 'steel_scale_legacy',
      },
      update: {},
    }));
  const occurredAt = new Date(event.occurredAt);
  const externalRecordType = event.type === 'customer.upserted' ? 'customer' : 'opportunity';
  const identity = {
    organizationId,
    connectionId: connection.id,
    externalRecordType,
    externalId: event.data.externalId,
  };
  const mapping = await tx.externalRecordMapping.findUnique({
    where: { organizationId_connectionId_externalRecordType_externalId: identity },
    include: { record: true },
  });
  const expectedType = event.type === 'customer.upserted' ? 'contact' : 'opportunity';
  if (mapping && mapping.internalEntityType !== expectedType)
    throw new WorkforceError(409, 'external_mapping_type_conflict');
  if (
    mapping &&
    (mapping.record.archivedAt ||
      (mapping.sourceUpdatedAt && mapping.sourceUpdatedAt >= occurredAt))
  ) {
    return { applied: false, entityId: mapping.internalEntityId, connectionId: connection.id };
  }
  async function saveMapping(id: string) {
    await tx.externalRecordMapping.upsert({
      where: { organizationId_connectionId_externalRecordType_externalId: identity },
      create: {
        ...identity,
        provider: connection.provider,
        internalEntityType: expectedType,
        internalEntityId: id,
        sourceUpdatedAt: occurredAt,
      },
      update: { sourceUpdatedAt: occurredAt },
    });
  }
  if (event.type === 'customer.upserted') {
    const existing = mapping
      ? await tx.contact.findUniqueOrThrow({
          where: { organizationId_id: { organizationId, id: mapping.internalEntityId } },
        })
      : null;
    if (existing?.sourceOccurredAt && existing.sourceOccurredAt >= occurredAt)
      return { applied: false, entityId: existing.id, connectionId: connection.id };
    const data = {
      name: event.data.name,
      email: event.data.email,
      phone: event.data.phone,
      doNotContact: existing?.doNotContact || event.data.doNotContact || false,
      sourceOccurredAt: occurredAt,
    };
    const contact = existing
      ? await tx.contact.update({
          where: { organizationId_id: { organizationId, id: existing.id } },
          data,
        })
      : await tx.contact.create({
          data: { organizationId, source, externalId: event.data.externalId, ...data },
        });
    await saveMapping(contact.id);
    return {
      applied: true,
      entityId: contact.id,
      before: existing,
      after: contact,
      connectionId: connection.id,
    };
  }
  const existing = mapping
    ? await tx.opportunity.findUniqueOrThrow({
        where: { organizationId_id: { organizationId, id: mapping.internalEntityId } },
      })
    : null;
  if (existing?.sourceOccurredAt && existing.sourceOccurredAt >= occurredAt)
    return { applied: false, entityId: existing.id, connectionId: connection.id };
  const customerMap = await tx.externalRecordMapping.findUnique({
    where: {
      organizationId_connectionId_externalRecordType_externalId: {
        organizationId,
        connectionId: connection.id,
        externalRecordType: 'customer',
        externalId: event.data.customerExternalId,
      },
    },
    include: { record: true },
  });
  if (!customerMap || customerMap.internalEntityType !== 'contact' || customerMap.record.archivedAt)
    throw new WorkforceError(409, 'customer_must_be_imported_first');
  const customerId = customerMap.internalEntityId;
  if (existing && (existing.customerId !== customerId || existing.currency !== event.data.currency))
    throw new WorkforceError(409, 'opportunity_identity_conflict');
  let stageId = existing?.stageId;
  if (existing?.pipelineId) {
    const outcome =
      event.data.status === 'won' || event.data.status === 'lost' ? event.data.status : 'open';
    const stages = await tx.pipelineStage.findMany({
      where: {
        organizationId,
        pipelineId: existing.pipelineId,
        outcome,
        record: { archivedAt: null },
      },
      orderBy: { position: 'asc' },
    });
    stageId = stages.find((s) => s.id === existing.stageId)?.id ?? stages[0]?.id;
    if (!stageId) throw new WorkforceError(409, 'pipeline_has_no_matching_outcome_stage');
  }
  const data = {
    customerId,
    title: event.data.title,
    status: event.data.status,
    stageId,
    amountMinor: event.data.amountMinor,
    currency: event.data.currency,
    lastActivityAt: new Date(event.data.lastActivityAt),
    sourceOccurredAt: occurredAt,
  };
  const opportunity = existing
    ? await tx.opportunity.update({
        where: { organizationId_id: { organizationId, id: existing.id } },
        data,
      })
    : await tx.opportunity.create({
        data: { organizationId, source, externalId: event.data.externalId, ...data },
      });
  await saveMapping(opportunity.id);
  return {
    applied: true,
    entityId: opportunity.id,
    before: existing,
    after: opportunity,
    connectionId: connection.id,
  };
}
