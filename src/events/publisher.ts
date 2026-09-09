import { randomUUID } from 'node:crypto';
import { captureMessage } from '../communications/ledger.js';
import { enqueueEvent } from '../integrations/outbox.js';
import { CrmEntityType, type BusinessEvent as StoredEvent } from '@prisma/client';
import { audit } from '../workforce/audit/service.js';
import {
  hash,
  json,
  object,
  string,
  uuid,
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import {
  parseEventInput,
  type BusinessEvent,
  type EventInput,
  type EventSource,
} from './contracts.js';

export function isCrmType(type: string): type is CrmEntityType {
  return Object.values(CrmEntityType).includes(type as CrmEntityType);
}

export async function validateReferences(tx: Transaction, source: EventSource, input: EventInput) {
  const organizationId = uuid(source.organizationId);
  string(source.system, 200);
  string(source.provider, 100);
  string(source.actor, 200);
  if (source.connectionId) {
    const connection = await tx.externalConnection.findFirst({
      where: { organizationId, id: uuid(source.connectionId), enabled: true },
    });
    if (!connection || connection.provider !== source.provider)
      throw new WorkforceError(403, 'event_connection_mismatch');
  } else if (input.externalEntity) throw new WorkforceError(400, 'event_connection_required');
  const { type, id } = input.entity;
  if (isCrmType(type)) {
    if (!(await tx.crmRecord.findFirst({ where: { organizationId, id: id!, entityType: type } })))
      throw new WorkforceError(404, 'event_entity_not_found');
  } else if (type === 'organization') {
    if (id !== organizationId) throw new WorkforceError(404, 'event_entity_not_found');
  } else if (type === 'organization_member') {
    if (!(await tx.organizationMember.findFirst({ where: { organizationId, id: id! } })))
      throw new WorkforceError(404, 'event_entity_not_found');
  } else if (type === 'custom_field_definition') {
    if (!(await tx.customFieldDefinition.findFirst({ where: { organizationId, id: id! } })))
      throw new WorkforceError(404, 'event_entity_not_found');
  } else if (type === 'external_connection') {
    if (!(await tx.externalConnection.findFirst({ where: { organizationId, id: id! } })))
      throw new WorkforceError(404, 'event_entity_not_found');
  }
  for (const recordId of input.relatedRecordIds ?? []) {
    if (!(await tx.crmRecord.findFirst({ where: { organizationId, id: recordId } })))
      throw new WorkforceError(404, 'event_related_record_not_found');
  }
  if (
    input.causationId &&
    !(await tx.businessEvent.findFirst({ where: { organizationId, id: input.causationId } }))
  )
    throw new WorkforceError(404, 'event_cause_not_found');
  if (input.type === 'opportunity.stage_changed') {
    for (const prefix of ['from', 'to']) {
      if (input.data[`${prefix}StageId`] === null) continue;
      if (
        !(await tx.pipelineStage.findFirst({
          where: {
            organizationId,
            id: input.data[`${prefix}StageId`] as string,
            pipelineId: input.data[`${prefix}PipelineId`] as string,
          },
        }))
      )
        throw new WorkforceError(409, 'event_stage_pipeline_mismatch');
    }
  }
  if (input.type === 'pipeline.reordered') {
    const ids = input.data.stageIds as string[];
    if (
      (await tx.pipelineStage.count({
        where: { organizationId, pipelineId: id!, id: { in: ids } },
      })) !== ids.length
    )
      throw new WorkforceError(409, 'event_stage_pipeline_mismatch');
  }
  if (input.type === 'customer.message_received') {
    const message = await tx.message.findFirst({
      where: {
        organizationId,
        id: input.data.messageId as string,
        conversationId: input.data.conversationId as string,
        direction: 'inbound',
        status: 'recorded',
      },
      include: { conversation: true },
    });
    if (
      !message ||
      message.body !== input.data.body ||
      message.conversation.contactId !== input.data.contactId ||
      message.conversation.channel !== input.data.channel
    )
      throw new WorkforceError(409, 'event_message_mismatch');
  }
}

export class EventPublisher {
  constructor(private readonly database?: Database) {}
  async publish(source: EventSource, value: unknown) {
    if (!this.database) throw new Error('Database required for standalone publication');
    const input = parseEventInput(value);
    return tenantTransaction(this.database, uuid(source.organizationId), (tx) =>
      this.publishInTransaction(tx, source, input),
    );
  }
  // Caller must hold the organization lock; domain change and event/outbox commit together.
  async publishInTransaction(
    tx: Transaction,
    source: EventSource,
    value: unknown,
    options: { fingerprint?: string; enqueue?: boolean } = {},
  ) {
    const input = parseEventInput(value);
    const payloadHash = options.fingerprint ?? hash({ source, input });
    const existing = await tx.businessEvent.findUnique({
      where: {
        organizationId_source_externalId: {
          organizationId: source.organizationId,
          source: source.system,
          externalId: input.idempotencyKey,
        },
      },
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new WorkforceError(409, 'event_id_reused_with_different_payload');
      return { event: existing, duplicate: true };
    }
    await validateReferences(tx, source, input);
    if (process.env.COMMUNICATIONS_ENABLED === 'true') await captureMessage(tx, source, input);
    const id = randomUUID();
    const event = await tx.businessEvent.create({
      data: {
        id,
        organizationId: source.organizationId,
        source: source.system,
        provider: source.provider,
        connectionId: source.connectionId,
        externalId: input.idempotencyKey,
        type: input.type,
        version: 2,
        entityType: input.entity.type,
        entityId: input.entity.id,
        recordId: isCrmType(input.entity.type) ? input.entity.id : null,
        recordType: isCrmType(input.entity.type) ? input.entity.type : null,
        externalRecordId: input.externalEntity?.id,
        externalRecordType: input.externalEntity?.type,
        correlationId: input.correlationId ?? id,
        causationId: input.causationId,
        actor: source.actor,
        metadata: json(input.metadata ?? {}),
        occurredAt: new Date(input.occurredAt),
        payload: json({ data: input.data, relatedRecordIds: input.relatedRecordIds ?? [] }),
        payloadHash,
      },
    });
    const recordIds = [
      ...new Set([...(event.recordId ? [event.recordId] : []), ...(input.relatedRecordIds ?? [])]),
    ];
    if (recordIds.length)
      await tx.businessEventLink.createMany({
        data: recordIds.map((recordId) => ({
          organizationId: source.organizationId,
          eventId: id,
          recordId,
        })),
      });
    if (options.enqueue !== false) await enqueueEvent(tx, event);
    if (options.enqueue !== false)
      await tx.workforceJob.create({
        data: { organizationId: source.organizationId, eventId: id },
      });
    await audit(tx, source.organizationId, source.actor, input.type, input.entity.id ?? id, {
      eventId: id,
      correlationId: event.correlationId,
    });
    return { event, duplicate: false };
  }
}

export function readCanonicalEvent(event: StoredEvent): BusinessEvent {
  if (
    event.version !== 2 ||
    !event.entityType ||
    !event.correlationId ||
    !event.provider ||
    !event.actor
  )
    throw new WorkforceError(400, 'invalid_persisted_event');
  const payload = object(event.payload);
  const input = parseEventInput({
    version: 2,
    type: event.type,
    idempotencyKey: event.externalId,
    occurredAt: event.occurredAt.toISOString(),
    entity: { type: event.entityType, id: event.entityId },
    data: payload.data,
    relatedRecordIds: payload.relatedRecordIds,
    correlationId: event.correlationId,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    ...(event.externalRecordId
      ? { externalEntity: { id: event.externalRecordId, type: event.externalRecordType } }
      : {}),
    metadata: event.metadata ?? {},
  });
  const { idempotencyKey, ...fields } = input;
  return {
    ...fields,
    id: event.id,
    organizationId: event.organizationId,
    actor: event.actor,
    correlationId: event.correlationId,
    receivedAt: event.receivedAt.toISOString(),
    source: {
      system: event.source,
      provider: event.provider,
      eventId: idempotencyKey,
      ...(event.connectionId ? { connectionId: event.connectionId } : {}),
    },
  };
}
