import { randomUUID } from 'node:crypto';
import { audit } from '../workforce/audit/service.js';
import { hash, type Transaction, WorkforceError } from '../workforce/shared.js';
import type { EventInput, EventSource } from '../events/contracts.js';
import { isOptOut, suppress } from './safety.js';

/** Called in the same tenant transaction as canonical event publication, before any worker. */
export async function captureMessage(tx: Transaction, source: EventSource, event: EventInput) {
  const organizationId = source.organizationId;
  if (event.type !== 'customer.message_received' && event.type !== 'message.created') return;
  const message = await tx.message.findFirst({
    where: { organizationId, id: event.entity.id! },
    include: { conversation: true },
  });
  if (!message || message.direction === 'internal' || message.status === 'draft') return;
  const conversation = message.conversation;
  if (event.type === 'customer.message_received' && isOptOut(message.body))
    await suppress(tx, organizationId, conversation.contactId, 'inbound_opt_out');
  const prior = await tx.communicationDelivery.findUnique({
    where: { organizationId_messageId: { organizationId, messageId: message.id } },
  });
  if (prior) return;
  await tx.communicationDelivery.create({
    data: {
      organizationId,
      messageId: message.id,
      conversationId: conversation.id,
      contactId: conversation.contactId,
      provider: source.provider,
      connectionId: source.connectionId,
      channel: conversation.channel,
      actor: source.actor,
      direction: message.direction,
      requestKey: `record:${message.id}`,
      payloadHash: hash(message.body),
      externalId: event.externalEntity?.id,
      status: message.direction === 'inbound' ? 'received' : 'recorded',
      statusAt: message.occurredAt,
    },
  });
}

/** Internal canonical message creation; caller has already authorized and locked its tenant. */
export async function createMessage(
  tx: Transaction,
  organizationId: string,
  conversationId: string,
  body: string,
  direction: 'inbound' | 'outbound',
  occurredAt = new Date(),
) {
  const conversation = await tx.conversation.findFirst({
    where: { organizationId, id: conversationId, record: { archivedAt: null } },
  });
  if (!conversation) throw new WorkforceError(404, 'communication_conversation_not_found');
  const id = randomUUID();
  // Existing CRM identity triggers create and validate CrmRecord atomically.
  return tx.message.create({
    data: { id, organizationId, conversationId, body, direction, status: 'recorded', occurredAt },
  });
}

/** Recovery remains responsible for exact-action approval and its existing claim/receipt API. */
export async function recordRecoveryDispatch(tx: Transaction, organizationId: string, id: string) {
  const dispatch = await tx.recoveryDispatch.findFirstOrThrow({
    where: { organizationId, id },
    include: { case: { include: { program: { include: { connection: true } } } } },
  });
  const prior = await tx.communicationDelivery.findUnique({
    where: { organizationId_recoveryDispatchId: { organizationId, recoveryDispatchId: id } },
  });
  if (prior) return prior;
  const row = dispatch.case;
  if (!row.conversationId) throw new WorkforceError(409, 'recovery_conversation_required');
  const message = await createMessage(
    tx,
    organizationId,
    row.conversationId,
    dispatch.body,
    'outbound',
  );
  const delivery = await tx.communicationDelivery.create({
    data: {
      organizationId,
      messageId: message.id,
      conversationId: row.conversationId,
      contactId: row.contactId,
      recoveryDispatchId: id,
      connectionId: row.program.connectionId,
      provider: row.program.connection?.provider ?? 'unconfigured',
      channel: dispatch.channel,
      actor: dispatch.actor,
      direction: 'outbound',
      requestKey: `recovery:${id}`,
      payloadHash: hash(dispatch.body),
      status: 'awaiting_provider',
    },
  });
  await audit(tx, organizationId, dispatch.actor, 'communication.queued', delivery.id, {
    recoveryDispatchId: id,
    messageId: message.id,
  });
  return delivery;
}
export async function recoveryStatus(
  tx: Transaction,
  organizationId: string,
  id: string,
  status: string,
  externalId: string | null = null,
  errorCode: string | null = null,
  occurredAt = new Date(),
) {
  const row = await recordRecoveryDispatch(tx, organizationId, id);
  await tx.communicationDelivery.update({
    where: { organizationId_id: { organizationId, id: row.id } },
    data: {
      status,
      externalId,
      errorCode,
      statusAt: occurredAt,
      ...(status === 'delivered' ? { deliveredAt: occurredAt } : {}),
    },
  });
  await tx.communicationAttempt.upsert({
    where: {
      organizationId_deliveryId_eventKey: {
        organizationId,
        deliveryId: row.id,
        eventKey: hash({ status, externalId, errorCode, occurredAt: occurredAt.toISOString() }),
      },
    },
    create: {
      organizationId,
      deliveryId: row.id,
      eventKey: hash({ status, externalId, errorCode, occurredAt: occurredAt.toISOString() }),
      status,
      externalId,
      errorCode,
      occurredAt,
    },
    update: {},
  });
}
