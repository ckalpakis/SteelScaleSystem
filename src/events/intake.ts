import type { ExternalConnection } from '@prisma/client';
import { CrmService } from '../crm/service.js';
import type { ChangeContext } from '../crm/events.js';
import type { Resource } from '../crm/validation.js';
import { authorize, type Principal } from '../workforce/tenancy/service.js';
import { audit } from '../workforce/audit/service.js';
import {
  hash,
  json,
  keys,
  object,
  string,
  uuid,
  tenantTransaction,
  WorkforceError,
  type Database,
  type Transaction,
} from '../workforce/shared.js';
import { EventPublisher } from './publisher.js';
import { eventTime, eventTypes, type EventSource } from './contracts.js';

export interface ExternalChange {
  version: 2;
  id: string;
  type: string;
  occurredAt: string;
  entity: { type: string; externalRecordType: string; externalId: string };
  data: Record<string, unknown>;
  correlationId?: string;
  /** Adapter-supplied provenance; never accepted from the generic relay body. */
  originEventType?: string;
  relatedEntity?: { externalRecordType: string; externalId: string };
}
export function parseExternalChange(value: unknown): ExternalChange {
  const b = object(value);
  keys(b, [
    'version',
    'id',
    'type',
    'occurredAt',
    'entity',
    'data',
    'correlationId',
    'relatedEntity',
  ]);
  if (b.version !== 2) throw new WorkforceError(400, 'unsupported_event_version');
  const entity = object(b.entity);
  keys(entity, ['type', 'externalRecordType', 'externalId']);
  const type = string(b.type, 100);
  const kind = string(entity.type, 100);
  if (
    !eventTypes.includes(type) ||
    (type === 'customer.message_received' ? kind !== 'message' : !type.startsWith(`${kind}.`)) ||
    ![
      'contact',
      'opportunity',
      'estimate',
      'appointment',
      'task',
      'message',
      'invoice',
      'job',
      'pipeline',
      'pipeline_stage',
      'conversation',
    ].includes(kind) ||
    type.endsWith('.archived') ||
    (kind === 'message' && type !== 'customer.message_received')
  )
    throw new WorkforceError(400, 'unsupported_external_event');
  let relatedEntity: ExternalChange['relatedEntity'];
  if (b.relatedEntity !== undefined) {
    const r = object(b.relatedEntity);
    keys(r, ['externalRecordType', 'externalId']);
    relatedEntity = {
      externalRecordType: string(r.externalRecordType, 100),
      externalId: string(r.externalId, 250),
    };
  }
  return {
    version: 2,
    id: string(b.id, 180),
    type,
    occurredAt: eventTime(b.occurredAt),
    entity: {
      type: kind,
      externalRecordType: string(entity.externalRecordType, 100),
      externalId: string(entity.externalId, 250),
    },
    data: object(b.data),
    ...(b.correlationId === undefined ? {} : { correlationId: uuid(b.correlationId) }),
    ...(relatedEntity ? { relatedEntity } : {}),
  };
}

export async function mappedRecord(
  tx: Transaction,
  organizationId: string,
  connectionId: string,
  externalRecordType: string,
  externalId: string,
) {
  return tx.externalRecordMapping.findUnique({
    where: {
      organizationId_connectionId_externalRecordType_externalId: {
        organizationId,
        connectionId,
        externalRecordType,
        externalId,
      },
    },
    include: { record: true },
  });
}
export type ExternalNormalizer = (
  tx: Transaction,
  connection: ExternalConnection,
  payload: unknown,
) => Promise<ExternalChange>;

/** Receipt, projection, canonical facts and jobs form a single serialized transaction. */
export async function ingestExternal(
  database: Database,
  principal: Principal,
  connectionId: string,
  value: unknown,
  normalize?: ExternalNormalizer,
  transaction?: Transaction,
) {
  authorize(principal, 'events:write');
  uuid(connectionId);
  if (principal.integrationId !== connectionId)
    throw new WorkforceError(403, 'integration_scope_mismatch');
  const raw = object(value);
  const externalId = string(raw.id, 180);
  // Hash the stable input before resolving mutable mappings or current CRM state.
  const fingerprint = hash(raw);
  const apply = async (tx: Transaction) => {
    const organizationId = principal.organizationId;
    const credential = await tx.workforceCredential.findFirst({
      where: {
        organizationId,
        id: principal.credentialId,
        integrationId: connectionId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    const connection = await tx.externalConnection.findFirst({
      where: { organizationId, id: connectionId, enabled: true },
    });
    if (!credential?.scopes.includes('events:write') || !connection)
      throw new WorkforceError(401, 'credential_changed');
    const source = `connection:${connectionId}`;
    const identity = { organizationId, source, externalId };
    const prior = await tx.eventIntake.findUnique({
      where: { organizationId_source_externalId: identity },
    });
    if (prior) {
      if (prior.payloadHash !== fingerprint)
        throw new WorkforceError(409, 'event_id_reused_with_different_payload');
      return { ...object(prior.result), duplicate: true };
    }
    const event = normalize ? await normalize(tx, connection, raw) : parseExternalChange(raw);
    if (event.id !== externalId)
      throw new WorkforceError(400, 'normalizer_changed_delivery_identity');
    const eventSource: EventSource = {
      organizationId,
      system: source,
      provider: connection.provider,
      actor: principal.actor,
      connectionId,
    };
    const context: ChangeContext = {
      source: eventSource,
      idempotencyKey: event.id,
      occurredAt: event.occurredAt,
      externalEntity: { type: event.entity.externalRecordType, id: event.entity.externalId },
      metadata: {
        originEventType: event.originEventType ?? event.type,
        schema: 'external-change.v2',
      },
      correlationId: event.correlationId,
    };
    async function finish(result: {
      eventId?: string;
      entityId?: string;
      ignored?: boolean;
      reason?: string;
    }) {
      await tx.eventIntake.create({
        data: {
          ...identity,
          connectionId,
          payloadHash: fingerprint,
          eventId: result.eventId,
          result: json({
            ...result,
            occurredAt: event.occurredAt,
            type: event.type,
            externalEntity: event.entity,
          }),
        },
      });
      await audit(
        tx,
        organizationId,
        principal.actor,
        result.ignored ? 'event.ignored' : 'event.accepted',
        result.eventId ?? externalId,
        { reason: result.reason, source, occurredAt: event.occurredAt },
      );
      return { ...result, duplicate: false };
    }
    if (event.entity.type === 'invoice' || event.entity.type === 'job') {
      if (!event.relatedEntity) throw new WorkforceError(400, 'related_internal_record_required');
      const related = await mappedRecord(
        tx,
        organizationId,
        connectionId,
        event.relatedEntity.externalRecordType,
        event.relatedEntity.externalId,
      );
      if (!related || related.record.archivedAt)
        throw new WorkforceError(404, 'related_record_not_found');
      const published = await new EventPublisher().publishInTransaction(tx, eventSource, {
        version: 2,
        type: event.type,
        idempotencyKey: event.id,
        occurredAt: event.occurredAt,
        entity: { type: event.entity.type, id: null },
        externalEntity: context.externalEntity,
        data: event.data,
        relatedRecordIds: [related.internalEntityId],
        ...(event.correlationId ? { correlationId: event.correlationId } : {}),
      });
      return finish({ eventId: published.event.id });
    }
    const mapping = await mappedRecord(
      tx,
      organizationId,
      connectionId,
      event.entity.externalRecordType,
      event.entity.externalId,
    );
    if (mapping && mapping.internalEntityType !== event.entity.type)
      throw new WorkforceError(409, 'external_mapping_type_conflict');
    if (mapping?.record.archivedAt)
      return finish({ entityId: mapping.internalEntityId, ignored: true, reason: 'archived' });
    const crm = new CrmService(database, principal);
    const kinds: Record<string, Resource> = {
      pipeline: 'pipelines',
      pipeline_stage: 'stages',
      conversation: 'conversations',
      contact: 'contacts',
      opportunity: 'opportunities',
      estimate: 'estimates',
      appointment: 'appointments',
      task: 'tasks',
      message: 'messages',
    };
    let changes: Record<string, unknown>;
    if (event.type === 'customer.message_received') {
      keys(event.data, ['conversationExternalId', 'body']);
      const conversationMapping = await mappedRecord(
        tx,
        organizationId,
        connectionId,
        'conversation',
        string(event.data.conversationExternalId, 250),
      );
      if (
        !conversationMapping ||
        conversationMapping.internalEntityType !== 'conversation' ||
        conversationMapping.record.archivedAt
      )
        throw new WorkforceError(404, 'conversation_mapping_required');
      const body = string(event.data.body, 10000);
      if (mapping) {
        const message = await tx.message.findFirst({
          where: { organizationId, id: mapping.internalEntityId },
        });
        if (
          !message ||
          message.direction !== 'inbound' ||
          message.body !== body ||
          message.conversationId !== conversationMapping.internalEntityId
        )
          throw new WorkforceError(409, 'external_message_identity_conflict');
        return finish({ entityId: message.id, ignored: true, reason: 'message_already_recorded' });
      }
      changes = {
        conversationId: conversationMapping.internalEntityId,
        direction: 'inbound',
        status: 'recorded',
        body,
        occurredAt: event.occurredAt,
      };
    } else {
      if (!mapping && !event.type.endsWith('.created'))
        throw new WorkforceError(409, 'external_mapping_required');
      if (mapping && event.type.endsWith('.created'))
        return finish({
          entityId: mapping.internalEntityId,
          ignored: true,
          reason: 'record_already_exists',
        });
      if (mapping) {
        const observedAt = new Date(event.occurredAt);
        // Receipt time is not source time: a delayed but newer source update must
        // still apply. Only bypass the local-edit barrier when this connection
        // published the exact current record version in the same transaction.
        const currentVersionFromSource =
          mapping.record.updatedAt > observedAt &&
          (await tx.businessEvent.findFirst({
            where: {
              organizationId,
              recordId: mapping.internalEntityId,
              connectionId,
              version: 2,
              payload: { path: ['data', 'recordVersion'], equals: mapping.record.version },
            },
            select: { id: true },
          }));
        if (
          (mapping.sourceUpdatedAt && mapping.sourceUpdatedAt >= observedAt) ||
          (mapping.record.updatedAt > observedAt && !currentVersionFromSource)
        )
          return finish({
            entityId: mapping.internalEntityId,
            ignored: true,
            reason: 'stale_observation',
          });
      }
      if (
        ['opportunity.stage_changed', 'opportunity.won', 'opportunity.lost'].includes(event.type)
      ) {
        keys(event.data, ['stageExternalId', 'pipelineExternalId']);
        const stageMap = await mappedRecord(
          tx,
          organizationId,
          connectionId,
          'pipeline_stage',
          string(event.data.stageExternalId, 250),
        );
        const pipelineMap = await mappedRecord(
          tx,
          organizationId,
          connectionId,
          'pipeline',
          string(event.data.pipelineExternalId, 250),
        );
        if (
          !stageMap ||
          stageMap.internalEntityType !== 'pipeline_stage' ||
          !pipelineMap ||
          pipelineMap.internalEntityType !== 'pipeline'
        )
          throw new WorkforceError(409, 'pipeline_mapping_required');
        const stage = await tx.pipelineStage.findFirst({
          where: {
            organizationId,
            id: stageMap.internalEntityId,
            pipelineId: pipelineMap.internalEntityId,
            record: { archivedAt: null },
          },
        });
        if (
          !stage ||
          (event.type !== 'opportunity.stage_changed' && stage.outcome !== event.type.split('.')[1])
        )
          throw new WorkforceError(409, 'stage_outcome_mismatch');
        changes = { stageId: stage.id, pipelineId: stage.pipelineId };
      } else if (
        [
          'estimate.sent',
          'estimate.accepted',
          'estimate.declined',
          'appointment.booked',
          'appointment.cancelled',
          'task.completed',
        ].includes(event.type)
      ) {
        keys(event.data, []);
        changes = {
          status: event.type === 'appointment.booked' ? 'scheduled' : event.type.split('.')[1],
        };
      } else {
        keys(event.data, ['changes']);
        changes = object(event.data.changes);
      }
    }
    const row = await crm.projectExternal(
      tx,
      kinds[event.entity.type]!,
      mapping?.internalEntityId,
      changes,
      context,
    );
    if (mapping)
      await tx.externalRecordMapping.update({
        where: { id: mapping.id, organizationId },
        data: { sourceUpdatedAt: new Date(event.occurredAt) },
      });
    else
      await tx.externalRecordMapping.create({
        data: {
          organizationId,
          connectionId,
          provider: connection.provider,
          externalRecordType: event.entity.externalRecordType,
          externalId: event.entity.externalId,
          internalEntityId: row.id,
          internalEntityType: row.record.entityType,
          sourceUpdatedAt: new Date(event.occurredAt),
        },
      });
    const published = await tx.businessEvent.findUniqueOrThrow({
      where: { organizationId_source_externalId: { organizationId, source, externalId } },
    });
    return finish({ entityId: row.id, eventId: published.id });
  };
  return transaction
    ? apply(transaction)
    : tenantTransaction(database, principal.organizationId, apply);
}
