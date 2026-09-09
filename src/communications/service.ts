import { randomUUID } from 'node:crypto';
import { authorizeCurrent } from '../agents/service.js';
import { seal } from '../integrations/security.js';
import { audit } from '../workforce/audit/service.js';
import { type Principal } from '../workforce/tenancy/service.js';
import {
  boolean,
  date,
  hash,
  integer,
  keys,
  object,
  string,
  tenantTransaction,
  uuid,
  WorkforceError,
  type Database,
} from '../workforce/shared.js';
import { address, assertContactAllowed } from './safety.js';
import { createMessage } from './ledger.js';
import { EventPublisher } from '../events/publisher.js';

export class CommunicationService {
  constructor(
    readonly database: Database,
    readonly principal: Principal,
  ) {}
  configure(raw: unknown) {
    const v = object(raw);
    keys(v, ['provider', 'channel', 'sender', 'accountSid', 'authToken']);
    if (v.provider !== 'twilio' || v.channel !== 'sms')
      throw new WorkforceError(400, 'communication_provider_not_installed');
    const sender = address('sms', string(v.sender)),
      accountSid = string(v.accountSid, 34),
      authToken = string(v.authToken, 100);
    if (!/^AC[a-f0-9]{32}$/i.test(accountSid))
      throw new WorkforceError(400, 'invalid_provider_account');
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'integrations:write');
      const organizationId = this.principal.organizationId;
      if (await tx.communicationAccount.findFirst({ where: { organizationId, channel: 'sms' } }))
        throw new WorkforceError(409, 'communication_account_already_configured');
      const id = randomUUID(),
        connection = await tx.externalConnection.create({
          data: {
            organizationId,
            name: 'Twilio communication',
            provider: 'twilio',
            externalAccountId: accountSid,
          },
        });
      await tx.communicationAccount.create({
        data: {
          id,
          organizationId,
          connectionId: connection.id,
          provider: 'twilio',
          channel: 'sms',
          sender,
          externalAccountId: accountSid,
          encryptedCredentials: seal(authToken, `communication:${organizationId}:${id}`),
        },
      });
      await audit(tx, organizationId, this.principal.actor, 'communication.account_created', id, {
        provider: 'twilio',
        enabled: false,
      });
      return { id, provider: 'twilio', channel: 'sms', enabled: false, revision: 1 };
    });
  }
  setEnabled(id: string, raw: unknown) {
    uuid(id);
    const v = object(raw);
    keys(v, ['enabled', 'expectedRevision']);
    const enabled = boolean(v.enabled),
      revision = integer(v.expectedRevision, 1, 2147483646);
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'integrations:write');
      const organizationId = this.principal.organizationId;
      const changed = await tx.communicationAccount.updateMany({
        where: { organizationId, id, revision },
        data: { enabled, revision: { increment: 1 } },
      });
      if (!changed.count) throw new WorkforceError(409, 'communication_account_revision_conflict');
      await audit(tx, organizationId, this.principal.actor, 'communication.account_changed', id, {
        enabled,
      });
      return { id, enabled, revision: revision + 1 };
    });
  }
  list() {
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'crm:read');
      const organizationId = this.principal.organizationId;
      return {
        accounts: await tx.communicationAccount.findMany({
          where: { organizationId },
          select: {
            id: true,
            provider: true,
            channel: true,
            sender: true,
            enabled: true,
            revision: true,
          },
        }),
        deliveries: await tx.communicationDelivery.findMany({
          where: { organizationId },
          orderBy: { createdAt: 'desc' },
          take: 100,
        }),
      };
    });
  }
  getConversation(id: string) {
    uuid(id);
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'crm:read');
      const organizationId = this.principal.organizationId;
      const conversation = await tx.conversation.findFirst({
        where: { organizationId, id, record: { archivedAt: null } },
        include: {
          messages: {
            orderBy: { occurredAt: 'desc' },
            take: 100,
            include: {
              communicationDelivery: {
                include: { history: { orderBy: { occurredAt: 'desc' }, take: 20 } },
              },
            },
          },
        },
      });
      if (!conversation) throw new WorkforceError(404, 'communication_conversation_not_found');
      return conversation;
    });
  }
  sendSms(raw: unknown) {
    return this.enqueue('sms', raw);
  }
  sendEmail(raw: unknown) {
    return this.enqueue('email', raw);
  }
  private enqueue(channel: 'sms' | 'email', raw: unknown) {
    const v = object(raw);
    keys(v, ['conversationId', 'body', 'idempotencyKey']);
    const conversationId = uuid(v.conversationId),
      body = string(v.body, channel === 'sms' ? 1600 : 10000),
      requestKey = `member:${string(v.idempotencyKey, 160)}`;
    const payloadHash = hash({ conversationId, body, channel, actor: this.principal.actor });
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'crm:write');
      const organizationId = this.principal.organizationId;
      const prior = await tx.communicationDelivery.findUnique({
        where: { organizationId_requestKey: { organizationId, requestKey } },
      });
      if (prior) {
        if (prior.payloadHash !== payloadHash)
          throw new WorkforceError(409, 'communication_idempotency_conflict');
        return prior;
      }
      const conversation = await tx.conversation.findFirst({
        where: {
          organizationId,
          id: conversationId,
          channel,
          status: 'open',
          record: { archivedAt: null },
        },
      });
      if (!conversation) throw new WorkforceError(404, 'communication_conversation_not_found');
      const { destination } = await assertContactAllowed(
        tx,
        organizationId,
        conversation.contactId,
        channel,
      );
      const account = await tx.communicationAccount.findFirst({
        where: { organizationId, channel, enabled: true, connection: { enabled: true } },
      });
      if (!account) throw new WorkforceError(409, 'communication_provider_unavailable');
      if (
        (await tx.communicationDelivery.count({ where: { organizationId, status: 'queued' } })) >=
        1000
      )
        throw new WorkforceError(429, 'communication_queue_limit');
      const message = await createMessage(tx, organizationId, conversationId, body, 'outbound');
      const row = await tx.communicationDelivery.create({
        data: {
          organizationId,
          messageId: message.id,
          conversationId,
          contactId: conversation.contactId,
          accountId: account.id,
          connectionId: account.connectionId,
          provider: account.provider,
          channel,
          direction: 'outbound',
          actor: this.principal.actor,
          requestKey,
          payloadHash,
          sender: account.sender,
          recipient: destination,
          status: 'queued',
        },
      });
      await new EventPublisher().publishInTransaction(
        tx,
        {
          organizationId,
          system: 'steel_scale_communication',
          provider: account.provider,
          connectionId: account.connectionId,
          actor: this.principal.actor,
        },
        {
          version: 2,
          type: 'message.created',
          idempotencyKey: `queued:${row.id}`,
          occurredAt: message.occurredAt.toISOString(),
          entity: { type: 'message', id: message.id },
          data: {
            changes: {
              direction: 'outbound',
              conversationId,
              status: 'recorded',
              deliveryStatus: 'queued',
            },
          },
          relatedRecordIds: [conversationId, conversation.contactId],
        },
      );
      await audit(tx, organizationId, this.principal.actor, 'communication.queued', row.id, {
        messageId: message.id,
        channel,
      });
      return row;
    });
  }
  consent(raw: unknown) {
    const v = object(raw);
    keys(v, ['contactId', 'channel', 'granted', 'evidence']);
    const contactId = uuid(v.contactId),
      channel = string(v.channel, 5),
      granted = boolean(v.granted),
      evidence = string(v.evidence, 1000);
    if (!['sms', 'email'].includes(channel)) throw new WorkforceError(400, 'invalid_channel');
    return tenantTransaction(this.database, this.principal.organizationId, async (tx) => {
      await authorizeCurrent(tx, this.principal, 'crm:write');
      const organizationId = this.principal.organizationId;
      if (granted) await assertContactAllowed(tx, organizationId, contactId, channel, false);
      else if (!(await tx.contact.findFirst({ where: { organizationId, id: contactId } })))
        throw new WorkforceError(404, 'communication_contact_unavailable');
      const row = await tx.recoveryConsent.upsert({
        where: { organizationId_contactId_channel: { organizationId, contactId, channel } },
        create: {
          organizationId,
          contactId,
          channel,
          granted,
          evidence,
          recordedBy: this.principal.actor,
        },
        update: { granted, evidence, recordedBy: this.principal.actor },
      });
      await audit(
        tx,
        organizationId,
        this.principal.actor,
        'communication.consent_recorded',
        row.id,
        { channel, granted },
      );
      return { id: row.id, granted };
    });
  }
}

/** Transport-authenticated adapters only; there is no anonymous JSON ingestion route. */
export async function processInboundMessage(database: Database, accountId: string, raw: unknown) {
  if (process.env.COMMUNICATIONS_ENABLED !== 'true')
    throw new WorkforceError(503, 'communications_disabled');
  const v = object(raw);
  keys(v, ['externalId', 'from', 'to', 'body', 'occurredAt']);
  const externalId = string(v.externalId, 150),
    body = string(v.body, 10000),
    occurredAt = v.occurredAt ? date(v.occurredAt) : new Date();
  const initial = await database.communicationAccount.findUnique({
    where: { id: uuid(accountId) },
  });
  if (!initial) throw new WorkforceError(404, 'communication_account_not_found');
  const from = address(initial.channel, string(v.from)),
    to = address(initial.channel, string(v.to));
  return tenantTransaction(database, initial.organizationId, async (tx) => {
    const account = await tx.communicationAccount.findFirst({
      where: {
        id: accountId,
        organizationId: initial.organizationId,
        connection: { enabled: true },
      },
    });
    if (!account || account.sender !== to)
      throw new WorkforceError(403, 'communication_account_unavailable');
    const organizationId = account.organizationId,
      requestKey = `inbound:${account.id}:${externalId}`,
      payloadHash = hash({ from, to, body, occurredAt: v.occurredAt ?? null });
    const prior = await tx.communicationDelivery.findUnique({
      where: { organizationId_requestKey: { organizationId, requestKey } },
    });
    if (prior) {
      if (prior.payloadHash !== payloadHash)
        throw new WorkforceError(409, 'communication_idempotency_conflict');
      return { id: prior.id, duplicate: true };
    }
    const contacts = await tx.contact.findMany({
      where: {
        organizationId,
        ...(account.channel === 'sms'
          ? { phone: from }
          : { email: { equals: from, mode: 'insensitive' } }),
        record: { archivedAt: null },
      },
      take: 2,
    });
    // Preserve ambiguous inbound messages against an unresolved sender, never an arbitrary customer.
    let contactId = contacts.length === 1 ? contacts[0]?.id : undefined;
    if (!contactId) {
      contactId = randomUUID();
      await tx.contact.create({
        data: {
          id: contactId,
          organizationId,
          name: from,
          ...(account.channel === 'sms' ? { phone: from } : { email: from }),
        },
      });
    }
    let conversation = await tx.conversation.findFirst({
      where: {
        organizationId,
        contactId,
        channel: account.channel as 'sms' | 'email',
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
          organizationId,
          contactId,
          channel: account.channel as 'sms' | 'email',
          subject: 'Customer communication',
        },
      });
    }
    const message = await createMessage(
      tx,
      organizationId,
      conversation.id,
      body,
      'inbound',
      occurredAt,
    );
    const result = await new EventPublisher().publishInTransaction(
      tx,
      {
        organizationId,
        system: 'steel_scale_communication',
        provider: account.provider,
        connectionId: account.connectionId,
        actor: `integration:${account.connectionId}`,
      },
      {
        version: 2,
        type: 'customer.message_received',
        idempotencyKey: requestKey,
        occurredAt: occurredAt.toISOString(),
        entity: { type: 'message', id: message.id },
        externalEntity: { type: 'message', id: externalId },
        data: {
          messageId: message.id,
          conversationId: conversation.id,
          contactId,
          body,
          channel: account.channel,
        },
        relatedRecordIds: [conversation.id, contactId],
      },
    );
    const delivery = await tx.communicationDelivery.update({
      where: { organizationId_messageId: { organizationId, messageId: message.id } },
      data: { accountId, requestKey, payloadHash, sender: from, recipient: to },
    });
    return { id: delivery.id, eventId: result.event.id, duplicate: false };
  });
}
