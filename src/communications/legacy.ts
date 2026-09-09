import { randomUUID } from 'node:crypto';
import { type Database, hash, tenantTransaction, WorkforceError } from '../workforce/shared.js';
import { EventPublisher } from '../events/publisher.js';
import { createMessage } from './ledger.js';
import { assertContactAllowed, isOptOut } from './safety.js';

export async function persistLegacyIngress(
  database: Database,
  input: { messageSid: string; from: string; to: string; body: string },
) {
  const client = await database.client.findUnique({ where: { phoneNumber: input.to } });
  if (!client) return;
  if (isOptOut(input.body))
    await database.smsConversation.upsert({
      where: { clientId_customerNumber: { clientId: client.id, customerNumber: input.from } },
      create: { clientId: client.id, customerNumber: input.from, status: 'opted_out' },
      update: { status: 'opted_out' },
    });
  await bridgeLegacyInbound(database, client.id, input);
}

/** An explicit legacyClientId link is required; never invent an organization for production data. */
export async function bridgeLegacyInbound(
  database: Database,
  clientId: string,
  input: { messageSid: string; from: string; to: string; body: string },
) {
  if (process.env.COMMUNICATIONS_ENABLED !== 'true') return;
  const org = await database.organization.findUnique({ where: { legacyClientId: clientId } });
  // Paused organizations must retain inbound opt-outs before any future reactivation.
  if (!org) return;
  await tenantTransaction(database, org.id, async (tx) => {
    const requestKey = `legacy-sms:${clientId}:${input.messageSid}`;
    const previous = await tx.communicationDelivery.findUnique({
      where: { organizationId_requestKey: { organizationId: org.id, requestKey } },
    });
    if (previous) {
      if (previous.payloadHash !== hash(input))
        throw new WorkforceError(409, 'communication_idempotency_conflict');
      return;
    }
    const contacts = await tx.contact.findMany({
      where: { organizationId: org.id, phone: input.from, record: { archivedAt: null } },
      take: 2,
    });
    // For ambiguous identities, record against an unresolved sender instead of attributing a reply to an arbitrary customer.
    let contactId = contacts.length === 1 ? contacts[0]!.id : undefined;
    if (!contactId) {
      contactId = randomUUID();
      await tx.contact.create({
        data: {
          id: contactId,
          organizationId: org.id,
          name: 'Inbound SMS sender',
          phone: input.from,
        },
      });
    }
    let conversation = await tx.conversation.findFirst({
      where: {
        organizationId: org.id,
        contactId,
        channel: 'sms',
        status: 'open',
        record: { archivedAt: null },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!conversation) {
      const id = randomUUID();
      conversation = await tx.conversation.create({
        data: {
          id,
          organizationId: org.id,
          contactId,
          channel: 'sms',
          subject: 'Legacy SMS conversation',
        },
      });
    }
    const message = await createMessage(tx, org.id, conversation.id, input.body, 'inbound');
    let connection = await tx.externalConnection.findFirst({
      where: { organizationId: org.id, provider: 'twilio', name: 'Legacy Twilio SMS bridge' },
    });
    if (!connection)
      connection = await tx.externalConnection.create({
        data: { organizationId: org.id, provider: 'twilio', name: 'Legacy Twilio SMS bridge' },
      });
    await new EventPublisher().publishInTransaction(
      tx,
      {
        organizationId: org.id,
        system: 'legacy_twilio_sms',
        provider: 'twilio',
        connectionId: connection.id,
        actor: `integration:${connection.id}`,
      },
      {
        version: 2,
        type: 'customer.message_received',
        idempotencyKey: requestKey,
        occurredAt: message.occurredAt.toISOString(),
        entity: { type: 'message', id: message.id },
        externalEntity: { type: 'message', id: input.messageSid },
        data: {
          messageId: message.id,
          conversationId: conversation.id,
          contactId,
          body: message.body,
          channel: 'sms',
        },
        relatedRecordIds: [conversation.id, contactId],
      },
    );
    await tx.communicationDelivery.update({
      where: { organizationId_messageId: { organizationId: org.id, messageId: message.id } },
      data: { requestKey, payloadHash: hash(input), sender: input.from, recipient: input.to },
    });
  });
}
export async function legacySmsBlocked(database: Database, clientId: string, destination: string) {
  if (
    await database.smsConversation.findFirst({
      where: { clientId, customerNumber: destination, status: 'opted_out' },
    })
  )
    return true;
  const org = await database.organization.findUnique({ where: { legacyClientId: clientId } });
  if (!org) return false;
  if (!org.active) return true;
  return tenantTransaction(database, org.id, async (tx) => {
    const contacts = await tx.contact.findMany({
      where: { organizationId: org.id, phone: destination },
      select: { id: true },
    });
    for (const contact of contacts) {
      try {
        await assertContactAllowed(tx, org.id, contact.id, 'sms', false);
      } catch {
        return true;
      }
    }
    return !!(await tx.communicationSuppression.findUnique({
      where: {
        organizationId_channel_addressHash: {
          organizationId: org.id,
          channel: 'sms',
          addressHash: hash(destination),
        },
      },
    }));
  });
}
export { isOptOut };

export async function recordLegacyOutbound(
  database: Database,
  input: { clientId: string; from: string; to: string; body: string },
) {
  if (process.env.COMMUNICATIONS_ENABLED !== 'true') return null;
  const org = await database.organization.findUnique({ where: { legacyClientId: input.clientId } });
  if (!org?.active) return null;
  return tenantTransaction(database, org.id, async (tx) => {
    let contact = await tx.contact.findFirst({
      where: { organizationId: org.id, phone: input.to, record: { archivedAt: null } },
      orderBy: { id: 'asc' },
    });
    if (!contact) {
      const id = randomUUID();
      contact = await tx.contact.create({
        data: { id, organizationId: org.id, name: 'Legacy SMS recipient', phone: input.to },
      });
    }
    await assertContactAllowed(tx, org.id, contact.id, 'sms', false);
    let conversation = await tx.conversation.findFirst({
      where: {
        organizationId: org.id,
        contactId: contact.id,
        channel: 'sms',
        status: 'open',
        record: { archivedAt: null },
      },
    });
    if (!conversation) {
      const id = randomUUID();
      conversation = await tx.conversation.create({
        data: {
          id,
          organizationId: org.id,
          contactId: contact.id,
          channel: 'sms',
          subject: 'Legacy SMS conversation',
        },
      });
    }
    const message = await createMessage(tx, org.id, conversation.id, input.body, 'outbound');
    const delivery = await tx.communicationDelivery.create({
      data: {
        organizationId: org.id,
        messageId: message.id,
        conversationId: conversation.id,
        contactId: contact.id,
        direction: 'outbound',
        channel: 'sms',
        actor: 'system:legacy_sms',
        provider: 'twilio',
        requestKey: `legacy-out:${message.id}`,
        payloadHash: hash(input),
        sender: input.from,
        recipient: input.to,
        status: 'sending',
        attempts: 1,
        leasedUntil: new Date(Date.now() + 60000),
      },
    });
    await new EventPublisher().publishInTransaction(
      tx,
      {
        organizationId: org.id,
        system: 'legacy_twilio_sms',
        provider: 'twilio',
        actor: 'system:legacy_sms',
      },
      {
        version: 2,
        type: 'message.created',
        idempotencyKey: `queued:${delivery.id}`,
        occurredAt: message.occurredAt.toISOString(),
        entity: { type: 'message', id: message.id },
        data: { changes: { direction: 'outbound', status: 'recorded', deliveryStatus: 'sending' } },
        relatedRecordIds: [conversation.id, contact.id],
      },
    );
    return delivery;
  });
}
export async function recordLegacyResult(
  database: Database,
  id: string,
  status: string,
  externalId: string | null,
  errorCode: string | null = null,
) {
  const row = await database.communicationDelivery.findUnique({ where: { id } });
  if (!row || row.actor !== 'system:legacy_sms' || row.accountId)
    throw new WorkforceError(404, 'legacy_delivery_not_found');
  const { recordStatus } = await import('./worker.js');
  return tenantTransaction(database, row.organizationId, (tx) =>
    recordStatus(
      tx,
      row.organizationId,
      id,
      status,
      hash({ status, externalId, errorCode }),
      externalId,
      errorCode,
      new Date(),
    ),
  );
}
