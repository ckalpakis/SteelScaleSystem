import { audit } from '../audit/service.js';
import { projectCrm } from '../crm/projector.js';
import { hash, tenantTransaction, WorkforceError, type Database } from '../shared.js';
import type { LegacyBusinessEvent } from './contracts.js';
import { EventPublisher } from '../../events/publisher.js';
import { recordChange } from '../../crm/events.js';

export interface IntakeResult {
  eventId: string;
  duplicate: boolean;
  applied?: boolean;
  entityId?: string;
}

// V1 transport compatibility only. All newly published events use the v2 domain contract.
export async function ingestEvent(
  database: Database,
  organizationId: string,
  source: string,
  actor: string,
  event: LegacyBusinessEvent,
): Promise<IntakeResult> {
  return tenantTransaction(database, organizationId, async (tx) => {
    const payloadHash = hash(event);
    const existing = await tx.businessEvent.findUnique({
      where: { organizationId_source_externalId: { organizationId, source, externalId: event.id } },
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash)
        throw new WorkforceError(409, 'event_id_reused_with_different_payload');
      return { eventId: existing.id, duplicate: true };
    }
    const projection = await projectCrm(tx, organizationId, source, event);
    let eventId: string;
    if (event.type === 'recovery.scan.requested') {
      eventId = (
        await new EventPublisher().publishInTransaction(
          tx,
          { organizationId, system: source, provider: 'steel_scale', actor },
          {
            version: 2,
            type: event.type,
            idempotencyKey: event.id,
            occurredAt: event.occurredAt,
            entity: { type: 'organization', id: organizationId },
            data: {},
          },
          { fingerprint: payloadHash },
        )
      ).event.id;
    } else {
      const entityId = projection.entityId!;
      const connection = await tx.externalConnection.findFirst({
        where: {
          organizationId,
          ...(projection.connectionId
            ? { id: projection.connectionId }
            : {
                mappings: {
                  some: {
                    organizationId,
                    internalEntityId: entityId,
                    externalId: event.data.externalId,
                  },
                },
              }),
        },
      });
      const kind = event.type === 'customer.upserted' ? 'contact' : 'opportunity';
      const opportunity =
        kind === 'opportunity'
          ? await tx.opportunity.findFirst({ where: { organizationId, id: entityId } })
          : null;
      eventId = (
        await recordChange(
          tx,
          organizationId,
          actor,
          `${kind}.${projection.applied && !projection.before ? 'created' : 'updated'}`,
          entityId,
          event.data,
          opportunity ? [opportunity.customerId] : [],
          {
            source: {
              organizationId,
              system: source,
              provider: connection?.provider ?? 'steel_scale',
              actor,
              ...(connection ? { connectionId: connection.id } : {}),
            },
            idempotencyKey: event.id,
            occurredAt: event.occurredAt,
            fingerprint: payloadHash,
            before: projection.before,
            enqueue: projection.applied,
            ...(connection
              ? {
                  externalEntity: {
                    type: event.type === 'customer.upserted' ? 'customer' : 'opportunity',
                    id: event.data.externalId,
                  },
                }
              : {}),
            metadata: {
              schema: projection.applied ? 'legacy-intake.v1' : 'legacy-intake.v1.ignored',
              originEventType: event.type,
            },
          },
        )
      ).id;
    }
    await audit(tx, organizationId, actor, 'event.accepted', eventId, {
      applied: projection.applied,
      entityId: projection.entityId,
    });
    return {
      eventId,
      duplicate: false,
      applied: projection.applied,
      ...(projection.entityId ? { entityId: projection.entityId } : {}),
    };
  });
}
