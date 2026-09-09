import { randomUUID } from 'node:crypto';
import { EventPublisher } from '../events/publisher.js';
import type { EntityType, EventInput, EventSource } from '../events/contracts.js';
import { json, type Transaction } from '../workforce/shared.js';

export interface ChangeContext {
  source?: EventSource;
  idempotencyKey?: string;
  occurredAt?: string;
  externalEntity?: EventInput['externalEntity'];
  before?: Record<string, unknown> | null;
  fingerprint?: string;
  enqueue?: boolean;
  metadata?: EventInput['metadata'];
  correlationId?: string;
}
const publisher = new EventPublisher();

// Native mutations and imports share lifecycle detection. Children share correlation.
export async function recordChange(
  tx: Transaction,
  organizationId: string,
  actor: string,
  type: string,
  subjectId: string,
  changes: unknown,
  relatedIds: string[] = [],
  context: ChangeContext = {},
) {
  const record = await tx.crmRecord.findFirst({ where: { organizationId, id: subjectId } });
  const logicalTypes: Record<string, EntityType> = {
    custom_field: 'custom_field_definition',
    connection: 'external_connection',
    member: 'organization_member',
    organization: 'organization',
    recovery: 'organization',
  };
  const entityType = record?.entityType ?? logicalTypes[type.split('.')[0]!] ?? 'organization';
  const source = context.source ?? {
    organizationId,
    system: 'steel_scale_crm',
    provider: 'steel_scale',
    actor,
  };
  const ids = [...new Set([subjectId, ...relatedIds])];
  const [opportunities, conversations] = await Promise.all([
    tx.opportunity.findMany({
      where: { organizationId, id: { in: ids } },
      select: { customerId: true },
    }),
    tx.conversation.findMany({
      where: { organizationId, id: { in: ids } },
      select: { contactId: true },
    }),
  ]);
  const records = await tx.crmRecord.findMany({
    where: {
      organizationId,
      id: {
        in: [
          ...new Set([
            ...ids,
            ...opportunities.map((o) => o.customerId),
            ...conversations.map((c) => c.contactId),
          ]),
        ],
      },
    },
    select: { id: true },
  });
  const key = context.idempotencyKey ?? randomUUID();
  const occurredAt = context.occurredAt ?? new Date().toISOString();
  const data =
    type === 'pipeline.reordered'
      ? changes
      : { changes: json(changes), ...(record ? { recordVersion: record.version } : {}) };
  const common = {
    version: 2,
    occurredAt,
    entity: { type: entityType, id: subjectId },
    relatedRecordIds: records.map((r) => r.id),
    ...(context.externalEntity ? { externalEntity: context.externalEntity } : {}),
    ...(context.metadata ? { metadata: context.metadata } : {}),
  };
  const result = await publisher.publishInTransaction(
    tx,
    source,
    {
      ...common,
      type,
      data,
      idempotencyKey: key,
      ...(context.correlationId ? { correlationId: context.correlationId } : {}),
    },
    { fingerprint: context.fingerprint, enqueue: context.enqueue },
  );
  if (
    result.duplicate ||
    context.enqueue === false ||
    !['created', 'updated'].includes(type.split('.')[1]!)
  )
    return result.event;
  const before = context.before;
  const identity = { organizationId, id: subjectId };
  let after: Record<string, unknown> | null = null;
  if (entityType === 'opportunity') after = await tx.opportunity.findFirst({ where: identity });
  if (entityType === 'estimate') after = await tx.estimate.findFirst({ where: identity });
  if (entityType === 'appointment') after = await tx.appointment.findFirst({ where: identity });
  if (entityType === 'task') after = await tx.task.findFirst({ where: identity });
  async function fact(eventType: string, data: unknown, additionalIds: string[] = []) {
    return publisher.publishInTransaction(tx, source, {
      ...common,
      type: eventType,
      data,
      idempotencyKey: `${key}:${eventType}`,
      correlationId: result.event.correlationId!,
      causationId: result.event.id,
      relatedRecordIds: [...records.map((r) => r.id), ...additionalIds],
    });
  }
  if (
    after &&
    entityType === 'opportunity' &&
    before &&
    after.stageId &&
    (before.stageId !== after.stageId || before.pipelineId !== after.pipelineId)
  ) {
    await fact('opportunity.stage_changed', {
      fromStageId: before.stageId ?? null,
      toStageId: after.stageId,
      fromPipelineId: before.pipelineId ?? null,
      toPipelineId: after.pipelineId,
    });
  }
  if (after && before?.status !== after.status) {
    const statuses: Record<string, Record<string, string>> = {
      opportunity: { won: 'opportunity.won', lost: 'opportunity.lost' },
      estimate: {
        sent: 'estimate.sent',
        accepted: 'estimate.accepted',
        declined: 'estimate.declined',
      },
      appointment: { scheduled: 'appointment.booked', cancelled: 'appointment.cancelled' },
      task: { completed: 'task.completed' },
    };
    const next =
      typeof after.status === 'string' ? statuses[entityType]?.[after.status] : undefined;
    if (next) await fact(next, { previousStatus: before?.status ?? null, status: after.status });
  }
  if (entityType === 'message') {
    const message = await tx.message.findFirst({
      where: identity,
      include: { conversation: true },
    });
    if (
      message?.direction === 'inbound' &&
      message.status === 'recorded' &&
      before?.status !== 'recorded'
    ) {
      await fact(
        'customer.message_received',
        {
          messageId: message.id,
          conversationId: message.conversationId,
          contactId: message.conversation.contactId,
          body: message.body,
          channel: message.conversation.channel,
        },
        [message.conversationId, message.conversation.contactId],
      );
    }
  }
  return result.event;
}
