import type { BusinessEvent as StoredEvent } from '@prisma/client';
import { object, uuid, WorkforceError, type Transaction } from '../workforce/shared.js';
import type { BusinessEvent, EventType, EntityType } from './contracts.js';
import { eventTypes } from './contracts.js';
import { readCanonicalEvent } from './publisher.js';

export interface EventHandler {
  enabled?(): boolean;
  /** Stable versioned identity; changing it deliberately opts into processing again. */
  id: string;
  types: readonly EventType[];
  /** DB-only: commit effects/outbox via this transaction. Never send to a provider here. */
  handle(tx: Transaction, event: BusinessEvent, now: Date): Promise<void>;
}

// Compatibility is at the router boundary, not in each agent/consumer. Old ledger rows
// remain untouched and queued v1 events continue to work during the incremental rollout.
async function normalizeLegacy(tx: Transaction, row: StoredEvent): Promise<BusinessEvent> {
  const type =
    row.type === 'customer.upserted'
      ? 'contact.updated'
      : row.type === 'opportunity.upserted'
        ? 'opportunity.updated'
        : row.type;
  if (!eventTypes.includes(type)) throw new WorkforceError(400, 'unsupported_legacy_event');
  const payload = object(row.payload);
  const links = await tx.businessEventLink.findMany({
    where: { organizationId: row.organizationId, eventId: row.id },
    include: { record: true },
  });
  const primary =
    links.find((link) => link.recordId === payload.subjectId) ??
    links.find((link) => link.record.entityType === type.split('.')[0]);
  const logicalTypes: Record<string, EntityType> = {
    custom_field: 'custom_field_definition',
    connection: 'external_connection',
    member: 'organization_member',
    organization: 'organization',
    recovery: 'organization',
  };
  const entityType = primary?.record.entityType ?? logicalTypes[type.split('.')[0]!];
  // Never invent an organization subject for an unresolvable historical CRM event.
  // Valid historical imports have scoped links from the CRM migration backfill.
  if (!entityType) throw new WorkforceError(409, 'legacy_event_subject_unresolved');
  const entityId =
    primary?.recordId ??
    (entityType === 'organization' ? row.organizationId : uuid(payload.subjectId));
  return {
    version: 2,
    id: row.id,
    organizationId: row.organizationId,
    type: type as EventType,
    entity: { type: entityType, id: entityId },
    occurredAt: row.occurredAt.toISOString(),
    receivedAt: row.receivedAt.toISOString(),
    source: { system: row.source, provider: 'legacy', eventId: row.externalId },
    actor: 'legacy',
    correlationId: row.id,
    data:
      type === 'recovery.scan.requested' ? {} : { changes: payload.changes ?? payload.data ?? {} },
    relatedRecordIds: links.map((link) => link.recordId),
    metadata: { schema: 'legacy.v1' },
  };
}

export class EventRouter {
  constructor(private readonly handlers: readonly EventHandler[]) {
    if (
      new Set(handlers.map((h) => h.id)).size !== handlers.length ||
      handlers.some(
        (h) =>
          !/^[a-z0-9_.:-]{1,100}$/.test(h.id) || h.types.some((type) => !eventTypes.includes(type)),
      )
    )
      throw new Error('Invalid event handler registry');
  }
  async dispatch(
    tx: Transaction,
    organizationId: string,
    eventId: string,
    now = new Date(),
  ): Promise<void> {
    const stored = await tx.businessEvent.findFirst({ where: { organizationId, id: eventId } });
    if (!stored) throw new WorkforceError(404, 'event_not_found');
    if (stored.version !== 1 && stored.version !== 2)
      throw new WorkforceError(400, 'unsupported_event_version');
    const event =
      stored.version === 2 ? readCanonicalEvent(stored) : await normalizeLegacy(tx, stored);
    for (const handler of this.handlers.filter(
      (h) => h.types.includes(event.type) && (h.enabled?.() ?? true),
    )) {
      const identity = { organizationId, eventId, handlerId: handler.id };
      if (
        await tx.eventDelivery.findUnique({ where: { organizationId_eventId_handlerId: identity } })
      )
        continue;
      await handler.handle(tx, event, now);
      await tx.eventDelivery.create({ data: { ...identity, processedAt: now } });
    }
  }
}
