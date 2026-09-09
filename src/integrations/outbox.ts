import { randomUUID } from 'node:crypto';
import type { BusinessEvent } from '@prisma/client';
import { json, object, type Transaction } from '../workforce/shared.js';

export const outboundEvents = [
  'agent.handoff_created',
  'agent.action_completed',
  'opportunity.recovered',
  'appointment.recovered',
  'contact.updated',
  'opportunity.updated',
  'estimate.sent',
  'estimate.accepted',
  'appointment.booked',
] as const;
export function outboundPayload(event: BusinessEvent, includeContactData: boolean) {
  const payload = object(event.payload);
  const data = object(payload.data ?? {});
  const changes = object(data.changes ?? data);
  const allowed = [
    'status',
    'previousStatus',
    'amountMinor',
    'currency',
    'stageId',
    'pipelineId',
    'actionId',
    'runId',
    'tool',
    'revenueId',
    'customerId',
    'contactId',
    'deliveryStatus',
  ];
  if (includeContactData) allowed.push('name', 'firstName', 'lastName', 'email', 'phone', 'title');
  return {
    version: 1,
    id: event.id,
    event: event.type,
    organization_id: event.organizationId,
    occurred_at: event.occurredAt.toISOString(),
    correlation_id: event.correlationId,
    entity: { type: event.entityType, id: event.entityId },
    external_entity: event.externalRecordId
      ? { type: event.externalRecordType, id: event.externalRecordId }
      : null,
    source: { provider: event.provider, connection_id: event.connectionId },
    data: Object.fromEntries(Object.entries(changes).filter(([field]) => allowed.includes(field))),
  };
}
/** Called at publication, never after a network send. Snapshot subscriptions at commit time. */
export async function enqueueEvent(tx: Transaction, event: BusinessEvent) {
  if (!(outboundEvents as readonly string[]).includes(event.type)) return;
  const endpoints = await tx.webhookEndpoint.findMany({
    where: {
      organizationId: event.organizationId,
      enabled: true,
      events: { has: event.type },
      ...(event.connectionId ? { includeExternal: true } : {}),
    },
  });
  const mappings =
    event.recordId && endpoints.length
      ? await tx.externalRecordMapping.findMany({
          where: { organizationId: event.organizationId, internalEntityId: event.recordId },
          select: {
            connectionId: true,
            provider: true,
            externalRecordType: true,
            externalId: true,
          },
          orderBy: { id: 'asc' },
          take: 50,
        })
      : [];
  for (const endpoint of endpoints)
    await tx.outboundDelivery.create({
      data: {
        organizationId: event.organizationId,
        endpointId: endpoint.id,
        eventId: event.id,
        deduplicationKey: event.id,
        payload: json({
          ...outboundPayload(event, endpoint.includeContactData),
          external_records: mappings,
        }),
      },
    });
}
export async function enqueueTest(tx: Transaction, organizationId: string, endpointId: string) {
  const id = randomUUID();
  return tx.outboundDelivery.create({
    data: {
      id,
      organizationId,
      endpointId,
      deduplicationKey: `test:${id}`,
      payload: {
        version: 1,
        id,
        event: 'integration.test',
        organization_id: organizationId,
        occurred_at: new Date().toISOString(),
        data: { test: true },
      },
    },
  });
}
