import { CrmEntityType } from '@prisma/client';
import {
  date,
  integer,
  keys,
  object,
  string,
  uuid,
  currency,
  WorkforceError,
} from '../workforce/shared.js';

export type EventType =
  | `${CrmEntityType}.${'created' | 'updated' | 'archived'}`
  | 'opportunity.stage_changed'
  | 'opportunity.won'
  | 'opportunity.lost'
  | 'estimate.sent'
  | 'estimate.accepted'
  | 'estimate.declined'
  | 'customer.message_received'
  | 'appointment.booked'
  | 'appointment.cancelled'
  | 'task.completed'
  | 'invoice.created'
  | 'invoice.overdue'
  | 'invoice.paid'
  | 'job.created'
  | 'job.completed'
  | 'recovery.scan.requested'
  | 'pipeline.reordered'
  | 'custom_field.defined'
  | 'custom_field.updated'
  | 'connection.created'
  | 'connection.updated'
  | 'external_record.mapped'
  | 'external_record.unmapped'
  | 'member.created'
  | 'member.updated'
  | 'organization.updated'
  | 'agent.handoff_created'
  | 'agent.action_completed'
  | 'opportunity.recovered'
  | 'appointment.recovered';
export type EntityType =
  | `${CrmEntityType}`
  | 'organization'
  | 'organization_member'
  | 'custom_field_definition'
  | 'external_connection'
  | 'invoice'
  | 'job';
export interface EventInput {
  version: 2;
  type: EventType;
  idempotencyKey: string;
  occurredAt: string;
  entity: { type: EntityType; id: string | null };
  data: Record<string, unknown>;
  externalEntity?: { type: string; id: string };
  relatedRecordIds?: string[];
  correlationId?: string;
  causationId?: string;
  metadata?: { originEventType?: string; schema?: string };
}
export interface EventSource {
  organizationId: string;
  system: string;
  provider: string;
  actor: string;
  connectionId?: string;
}
export interface BusinessEvent extends Omit<EventInput, 'idempotencyKey' | 'correlationId'> {
  id: string;
  organizationId: string;
  source: { system: string; provider: string; connectionId?: string; eventId: string };
  actor: string;
  receivedAt: string;
  correlationId: string;
}

const changes = new Map<string, EntityType[]>();
for (const entity of Object.values(CrmEntityType))
  for (const action of ['created', 'updated', 'archived'])
    changes.set(`${entity}.${action}`, [entity]);
for (const [type, entity] of [
  ['custom_field.defined', 'custom_field_definition'],
  ['custom_field.updated', 'custom_field_definition'],
  ['connection.created', 'external_connection'],
  ['connection.updated', 'external_connection'],
  ['member.created', 'organization_member'],
  ['member.updated', 'organization_member'],
  ['organization.updated', 'organization'],
  ['agent.handoff_created', 'opportunity'],
  ['agent.action_completed', 'opportunity'],
  ['opportunity.recovered', 'opportunity'],
  ['appointment.recovered', 'appointment'],
] as const)
  changes.set(type, [entity]);
changes.set('external_record.mapped', Object.values(CrmEntityType));
changes.set('external_record.unmapped', Object.values(CrmEntityType));
changes.set('agent.action_completed', Object.values(CrmEntityType));

export const eventTypes: readonly string[] = [
  ...changes.keys(),
  'opportunity.stage_changed',
  'opportunity.won',
  'opportunity.lost',
  'estimate.sent',
  'estimate.accepted',
  'estimate.declined',
  'customer.message_received',
  'appointment.booked',
  'appointment.cancelled',
  'task.completed',
  'invoice.created',
  'invoice.overdue',
  'invoice.paid',
  'job.created',
  'job.completed',
  'recovery.scan.requested',
  'pipeline.reordered',
];
const transitionTypes = [
  'opportunity.won',
  'opportunity.lost',
  'estimate.sent',
  'estimate.accepted',
  'estimate.declined',
  'appointment.booked',
  'appointment.cancelled',
  'task.completed',
];

function boundedJson(value: unknown, depth = 0): void {
  if (depth > 6) throw new WorkforceError(400, 'event_data_too_deep');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string' && value.length <= 10000) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (Array.isArray(value) && value.length <= 100) {
    value.forEach((v: unknown) => boundedJson(v, depth + 1));
    return;
  }
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (
      entries.length > 100 ||
      entries.some(([k]) => ['__proto__', 'constructor', 'prototype'].includes(k))
    )
      throw new WorkforceError(400, 'invalid_event_data');
    entries.forEach(([, v]) => boundedJson(v, depth + 1));
    return;
  }
  throw new WorkforceError(400, 'invalid_event_data');
}
export function eventTime(value: unknown, now = new Date()): string {
  const normalized = date(value, now).toISOString();
  const day = String(value).slice(0, 10);
  if (new Date(day).toISOString().slice(0, 10) !== day)
    throw new WorkforceError(400, 'invalid_timestamp');
  return normalized;
}
export function parseEventInput(value: unknown, now = new Date()): EventInput {
  const body = object(value);
  keys(body, [
    'version',
    'type',
    'idempotencyKey',
    'occurredAt',
    'entity',
    'data',
    'externalEntity',
    'relatedRecordIds',
    'correlationId',
    'causationId',
    'metadata',
  ]);
  if (body.version !== 2) throw new WorkforceError(400, 'unsupported_event_version');
  const type = string(body.type, 100);
  if (!eventTypes.includes(type)) throw new WorkforceError(400, 'unsupported_event_type');
  const entity = object(body.entity);
  keys(entity, ['type', 'id']);
  const entityType = string(entity.type, 100) as EntityType;
  const expected = changes.get(type) ?? [
    type === 'customer.message_received'
      ? 'message'
      : type === 'recovery.scan.requested'
        ? 'organization'
        : type.split('.')[0],
  ];
  if (!expected.includes(entityType)) throw new WorkforceError(400, 'event_entity_type_mismatch');
  const entityId = entity.id === null ? null : uuid(entity.id);
  if (entityType === 'invoice' || entityType === 'job' ? entityId !== null : entityId === null)
    throw new WorkforceError(400, 'event_entity_identity_required');
  const data = object(body.data);
  boundedJson(data);
  if (Buffer.byteLength(JSON.stringify(data)) > 24 * 1024)
    throw new WorkforceError(400, 'event_data_too_large');
  if (changes.has(type)) {
    keys(data, ['changes', 'recordVersion']);
    object(data.changes);
    if (data.recordVersion !== undefined) integer(data.recordVersion, 1, 2_147_483_647);
  } else if (type === 'opportunity.stage_changed') {
    keys(data, ['fromStageId', 'toStageId', 'fromPipelineId', 'toPipelineId']);
    for (const key of ['fromStageId', 'fromPipelineId']) if (data[key] !== null) uuid(data[key]);
    uuid(data.toStageId);
    uuid(data.toPipelineId);
    if (
      (data.fromStageId === null) !== (data.fromPipelineId === null) ||
      (data.fromStageId === data.toStageId && data.fromPipelineId === data.toPipelineId)
    )
      throw new WorkforceError(400, 'invalid_stage_transition');
  } else if (transitionTypes.includes(type)) {
    keys(data, ['previousStatus', 'status']);
    const expectedStatus = type === 'appointment.booked' ? 'scheduled' : type.split('.')[1];
    if (data.status !== expectedStatus || data.previousStatus === data.status)
      throw new WorkforceError(400, 'invalid_status_transition');
    if (data.previousStatus !== null) string(data.previousStatus, 100);
  } else if (type === 'customer.message_received') {
    keys(data, ['contactId', 'conversationId', 'messageId', 'body', 'channel']);
    uuid(data.contactId);
    uuid(data.conversationId);
    uuid(data.messageId);
    string(data.body, 10000);
    if (
      data.messageId !== entityId ||
      !['email', 'sms', 'phone', 'web', 'other'].includes(String(data.channel))
    )
      throw new WorkforceError(400, 'invalid_message_event');
  } else if (type.startsWith('invoice.')) {
    keys(data, ['amountMinor', 'currency', 'dueAt']);
    integer(data.amountMinor, 0, 2_147_483_647);
    data.currency = currency(data.currency);
    if (data.dueAt !== undefined) {
      const rawDue = string(data.dueAt, 40);
      const due = new Date(rawDue);
      if (!Number.isFinite(due.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(rawDue))
        throw new WorkforceError(400, 'invalid_timestamp');
      // Due dates may be in the future, but still require a real ISO calendar date.
      data.dueAt = eventTime(rawDue, new Date(Math.max(Date.now(), due.getTime())));
    }
    if (
      type === 'invoice.overdue' &&
      (!data.dueAt || new Date(string(data.dueAt)) > new Date(string(body.occurredAt)))
    )
      throw new WorkforceError(400, 'invoice_not_overdue');
  } else if (type.startsWith('job.')) {
    keys(data, ['title']);
    string(data.title, 250);
  } else if (type === 'pipeline.reordered') {
    keys(data, ['stageIds']);
    if (!Array.isArray(data.stageIds) || data.stageIds.length > 100)
      throw new WorkforceError(400, 'invalid_stage_order');
    data.stageIds.forEach(uuid);
    if (new Set(data.stageIds).size !== data.stageIds.length)
      throw new WorkforceError(400, 'invalid_stage_order');
  } else keys(data, []);
  let externalEntity: EventInput['externalEntity'];
  if (body.externalEntity !== undefined) {
    const ref = object(body.externalEntity);
    keys(ref, ['type', 'id']);
    externalEntity = { type: string(ref.type, 100), id: string(ref.id, 250) };
  }
  if ((entityType === 'invoice' || entityType === 'job') && !externalEntity)
    throw new WorkforceError(400, 'external_entity_required');
  const related = body.relatedRecordIds ?? [];
  if (!Array.isArray(related) || related.length > 100)
    throw new WorkforceError(400, 'invalid_related_records');
  const relatedRecordIds = [...new Set(related.map(uuid))].sort();
  if (entityId === null && !relatedRecordIds.length)
    throw new WorkforceError(400, 'related_internal_record_required');
  let metadata: EventInput['metadata'];
  if (body.metadata !== undefined) {
    const meta = object(body.metadata);
    keys(meta, ['originEventType', 'schema']);
    metadata = {
      ...(meta.originEventType === undefined
        ? {}
        : { originEventType: string(meta.originEventType, 100) }),
      ...(meta.schema === undefined ? {} : { schema: string(meta.schema, 100) }),
    };
  }
  return {
    version: 2,
    type: type as EventType,
    idempotencyKey: string(body.idempotencyKey, 250),
    occurredAt: eventTime(body.occurredAt, now),
    entity: { type: entityType, id: entityId },
    data,
    relatedRecordIds,
    ...(externalEntity ? { externalEntity } : {}),
    ...(metadata ? { metadata } : {}),
    ...(body.correlationId === undefined ? {} : { correlationId: uuid(body.correlationId) }),
    ...(body.causationId === undefined ? {} : { causationId: uuid(body.causationId) }),
  };
}
