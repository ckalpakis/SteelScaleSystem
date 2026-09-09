import { randomUUID } from 'node:crypto';
import { ingestExternal, mappedRecord } from '../events/intake.js';
import { eventTime } from '../events/contracts.js';
import { authorize, type Principal } from '../workforce/tenancy/service.js';
import {
  hash,
  json,
  object,
  string,
  tenantTransaction,
  WorkforceError,
  type Database,
} from '../workforce/shared.js';
import { mapPayload, nativeFields, safeSummary, validateRaw } from './mapping.js';

export async function receive(
  database: Database,
  principal: Principal,
  raw: unknown,
  headerKey?: string,
) {
  authorize(principal, 'events:write');
  if (!principal.integrationId) throw new WorkforceError(403, 'integration_credential_required');
  const organizationId = principal.organizationId;
  const connectionId = principal.integrationId;
  validateRaw(raw);
  const fingerprint = hash({ body: raw, idempotencyKey: headerKey ?? null });
  try {
    return await tenantTransaction(database, organizationId, async (tx) => {
      const connection = await tx.externalConnection.findFirst({
        where: {
          organizationId,
          id: connectionId,
          enabled: true,
          provider: { in: ['zapier', 'generic_webhook'] },
        },
      });
      const credential = await tx.workforceCredential.findFirst({
        where: {
          organizationId,
          id: principal.credentialId,
          integrationId: connectionId,
          revokedAt: null,
          expiresAt: { gt: new Date() },
        },
      });
      if (!connection || !credential?.scopes.includes('events:write'))
        throw new WorkforceError(401, 'credential_changed');
      const body = mapPayload(raw, connection.webhookMapping);
      const eventType = string(body.event, 100);
      const occurredAt = eventTime(body.occurred_at);
      const rootId = string(body.external_id ?? headerKey ?? `sha256:${hash(raw)}`, 180);
      if (body.external_id && headerKey && body.external_id !== headerKey)
        throw new WorkforceError(400, 'idempotency_key_mismatch');
      const identity = { organizationId, source: `zapier:${connectionId}`, externalId: rootId };
      const prior = await tx.eventIntake.findUnique({
        where: { organizationId_source_externalId: identity },
      });
      if (prior) {
        if (prior.payloadHash !== fingerprint)
          throw new WorkforceError(409, 'event_id_reused_with_different_payload');
        await tx.integrationActivity.create({
          data: {
            organizationId,
            connectionId,
            payloadHash: fingerprint,
            summary: json(safeSummary(raw)),
            statusCode: 200,
            code: 'duplicate',
          },
        });
        return { ...object(prior.result), duplicate: true };
      }
      const supported = [
        'contact.created',
        'contact.updated',
        'opportunity.created',
        'opportunity.updated',
        'opportunity.stage_changed',
        'opportunity.won',
        'opportunity.lost',
        'estimate.created',
        'estimate.updated',
        'estimate.sent',
        'estimate.accepted',
        'estimate.declined',
        'appointment.created',
        'appointment.booked',
        'appointment.cancelled',
        'customer.message_received',
        'invoice.created',
        'invoice.overdue',
        'invoice.paid',
        'job.created',
        'job.completed',
      ];
      if (!supported.includes(eventType))
        throw new WorkforceError(400, 'unsupported_external_event');
      const primary =
        eventType === 'customer.message_received' ? 'message' : eventType.split('.')[0]!;
      if (!body[primary]) throw new WorkforceError(400, 'primary_entity_required');
      const correlationId = randomUUID();
      const ids: Record<string, string> = {};
      const results: Record<string, unknown>[] = [];
      const externalIds: Record<string, string> = {};
      async function upsert(
        section: string,
        relation: Record<string, unknown> = {},
        status?: string,
      ) {
        if (body[section] === undefined) return;
        const entity = object(body[section]);
        const externalId = string(entity.external_id, 250);
        externalIds[section] = externalId;
        const type = section === 'stage' ? 'pipeline_stage' : section;
        const mapping = await mappedRecord(tx, organizationId, connectionId, type, externalId);
        if (mapping && (mapping.internalEntityType !== type || mapping.record.archivedAt))
          throw new WorkforceError(409, 'mapped_record_unavailable');
        let changes: Record<string, unknown> = {
          ...nativeFields(entity),
          ...relation,
          ...(status ? { status } : {}),
        };
        if (section === 'contact' && !mapping && !changes.name)
          changes.name = [changes.firstName, changes.lastName].filter(Boolean).join(' ');
        if (section === 'stage' && !mapping)
          changes.position ??=
            ((
              await tx.pipelineStage.aggregate({
                where: { organizationId, pipelineId: string(relation.pipelineId) },
                _max: { position: true },
              })
            )._max.position ?? -1) + 1;
        // References-only related records do not update their version or activity watermark.
        if (mapping && section !== primary && Object.keys(entity).length === 1) {
          ids[section] = mapping.internalEntityId;
          return;
        }
        if (mapping && ['estimate', 'conversation', 'stage'].includes(section)) {
          // Relationship identity is verified below; do not pass immutable fields to PATCH.
          if (section === 'estimate') {
            const existing = await tx.estimate.findFirstOrThrow({
              where: { organizationId, id: mapping.internalEntityId },
            });
            if (
              (changes.opportunityId && changes.opportunityId !== existing.opportunityId) ||
              (changes.currency && changes.currency !== existing.currency)
            )
              throw new WorkforceError(409, 'estimate_identity_conflict');
            delete changes.opportunityId;
            delete changes.currency;
          }
          if (section === 'conversation') {
            const existing = await tx.conversation.findFirstOrThrow({
              where: { organizationId, id: mapping.internalEntityId },
            });
            if (
              (changes.contactId && changes.contactId !== existing.contactId) ||
              (changes.channel && changes.channel !== existing.channel)
            )
              throw new WorkforceError(409, 'conversation_identity_conflict');
            delete changes.contactId;
            delete changes.channel;
          }
          if (section === 'stage') {
            const existing = await tx.pipelineStage.findFirstOrThrow({
              where: { organizationId, id: mapping.internalEntityId },
            });
            if (changes.pipelineId && changes.pipelineId !== existing.pipelineId)
              throw new WorkforceError(409, 'stage_identity_conflict');
            delete changes.pipelineId;
          }
        }
        changes = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
        const result = await ingestExternal(
          database,
          principal,
          connectionId,
          {
            version: 2,
            id: `z:${hash(rootId)}:${section}`,
            type: `${type}.${mapping ? 'updated' : 'created'}`,
            occurredAt,
            entity: { type, externalRecordType: type, externalId },
            data: { changes },
            correlationId,
          },
          undefined,
          tx,
        );
        results.push(result);
        if (typeof result.entityId === 'string') ids[section] = result.entityId;
      }
      await upsert('contact');
      await upsert('pipeline');
      await upsert('stage', ids.pipeline ? { pipelineId: ids.pipeline } : {});
      if (body.opportunity && ['opportunity.won', 'opportunity.lost'].includes(eventType)) {
        if (!ids.stage) throw new WorkforceError(400, 'stage_required');
        const stage = await tx.pipelineStage.findFirstOrThrow({
          where: { organizationId, id: ids.stage },
        });
        if (stage.outcome !== eventType.split('.')[1])
          throw new WorkforceError(409, 'stage_outcome_mismatch');
      }
      if (eventType === 'opportunity.stage_changed' && (!ids.stage || !ids.pipeline))
        throw new WorkforceError(400, 'pipeline_stage_required');
      await upsert('opportunity', {
        ...(ids.contact ? { customerId: ids.contact } : {}),
        ...(ids.pipeline ? { pipelineId: ids.pipeline } : {}),
        ...(ids.stage ? { stageId: ids.stage } : {}),
      });
      await upsert(
        'estimate',
        ids.opportunity ? { opportunityId: ids.opportunity } : {},
        ['estimate.sent', 'estimate.accepted', 'estimate.declined'].includes(eventType)
          ? eventType.split('.')[1]
          : undefined,
      );
      await upsert(
        'appointment',
        {
          ...(ids.contact ? { contactId: ids.contact } : {}),
          ...(ids.opportunity ? { opportunityId: ids.opportunity } : {}),
        },
        eventType === 'appointment.booked'
          ? 'scheduled'
          : eventType === 'appointment.cancelled'
            ? 'cancelled'
            : undefined,
      );
      await upsert('conversation', ids.contact ? { contactId: ids.contact } : {});
      if (primary === 'message') {
        const message = object(body.message);
        if (!externalIds.conversation) throw new WorkforceError(400, 'conversation_required');
        results.push(
          await ingestExternal(
            database,
            principal,
            connectionId,
            {
              version: 2,
              id: `z:${hash(rootId)}:message`,
              type: eventType,
              occurredAt,
              entity: {
                type: 'message',
                externalRecordType: 'message',
                externalId: string(message.external_id, 250),
              },
              data: { conversationExternalId: externalIds.conversation, body: message.body },
              correlationId,
            },
            undefined,
            tx,
          ),
        );
      }
      if (primary === 'invoice' || primary === 'job') {
        const entity = object(body[primary]);
        const related = externalIds.opportunity ? 'opportunity' : 'contact';
        if (!externalIds[related]) throw new WorkforceError(400, 'related_record_required');
        results.push(
          await ingestExternal(
            database,
            principal,
            connectionId,
            {
              version: 2,
              id: `z:${hash(rootId)}:${primary}`,
              type: eventType,
              occurredAt,
              entity: {
                type: primary,
                externalRecordType: primary,
                externalId: string(entity.external_id, 250),
              },
              data: nativeFields(entity),
              relatedEntity: { externalRecordType: related, externalId: externalIds[related] },
              correlationId,
            },
            undefined,
            tx,
          ),
        );
      }
      const result = { records: ids, results, correlationId };
      await tx.eventIntake.create({
        data: { ...identity, connectionId, payloadHash: fingerprint, result: json(result) },
      });
      await tx.integrationActivity.create({
        data: {
          organizationId,
          connectionId,
          payloadHash: fingerprint,
          summary: json(safeSummary(raw)),
          statusCode: 202,
          code: 'accepted',
        },
      });
      return { ...result, duplicate: false };
    });
  } catch (err) {
    const status = err instanceof WorkforceError ? err.status : 500;
    // Deliberately outside the failed projection transaction: failures remain inspectable.
    await database.integrationActivity.create({
      data: {
        organizationId,
        connectionId,
        payloadHash: fingerprint,
        summary: json(safeSummary(raw)),
        statusCode: status,
        code: err instanceof WorkforceError ? err.code : 'ingestion_failed',
      },
    });
    throw err;
  }
}
