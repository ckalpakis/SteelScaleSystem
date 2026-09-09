/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
/* eslint-disable @typescript-eslint/require-await -- Fake asynchronous transports. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import { provisionOrganization, authenticate } from '../workforce/tenancy/service.js';
import { WorkforceError, tenantTransaction } from '../workforce/shared.js';
import { CrmService } from '../crm/service.js';
import { CommunicationService, processInboundMessage } from './service.js';
import { processDeliveryStatus, sendOnce, type ProviderResolver } from './worker.js';
import { IntegrationService } from '../integrations/service.js';
import { RecoveryService } from '../recovery/service.js';
import { exampleConfig } from '../recovery/contracts.js';
import { recordRecoveryDispatch, recoveryStatus } from './ledger.js';
import { messageGuard, loadCase } from '../recovery/lifecycle.js';
import { persistLegacyIngress, legacySmsBlocked } from './legacy.js';

requireDemoTestDatabase();
Object.assign(process.env, {
  WORKFORCE_ENABLED: 'true',
  COMMUNICATIONS_ENABLED: 'true',
  COMMUNICATION_DELIVERY_ENABLED: 'true',
  BUSINESS_KNOWLEDGE_ENABLED: 'false',
  AGENT_RUNTIME_ENABLED: 'true',
  REVENUE_RECOVERY_ENABLED: 'true',
  REVENUE_RECOVERY_DELIVERY_ENABLED: 'false',
  WORKFORCE_WORKER_ENABLED: 'false',
  AGENT_MODEL_ENABLED: 'false',
  WEBHOOK_DELIVERY_ENABLED: 'false',
  AGENT_ALLOWED_MODELS: 'test-model',
  OPENAI_API_KEY: '',
  TWILIO_SMS_DRY_RUN: 'true',
  APP_URL: 'https://communications.example.test',
  INTEGRATION_ENCRYPTION_KEY: 'c'.repeat(64),
  LOG_LEVEL: 'silent',
});
let db: PrismaClient, server: Server, base: string;
before(async () => {
  const modules = await Promise.all([import('../db/client.js'), import('../app.js')]);
  db = modules[0].db;
  server = modules[1].app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await db.$disconnect();
});
const code = (expected: string) => (error: unknown) =>
  error instanceof WorkforceError && error.code === expected;
const sid = () => 'SM' + randomUUID().replaceAll('-', '');
async function fixture() {
  const org = await provisionOrganization(
    db,
    { name: 'Communication test', ownerSubject: `communications:${randomUUID()}` },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${org.token}`),
    service = new CommunicationService(db, principal),
    crm = new CrmService(db, principal);
  const accountSid = 'AC' + randomUUID().replaceAll('-', ''),
    authToken = 'fake-private-token';
  const account = await service.configure({
    provider: 'twilio',
    channel: 'sms',
    sender: '+12025550101',
    accountSid,
    authToken,
  });
  await service.setEnabled(account.id, { enabled: true, expectedRevision: 1 });
  const contact = await crm.create('contacts', {
    name: 'Fictional customer',
    phone: '+12025550102',
    email: 'customer@example.test',
  });
  const conversation = await crm.create('conversations', {
    contactId: contact.id,
    channel: 'sms',
    subject: 'Customer communication',
  });
  await service.consent({
    contactId: contact.id,
    channel: 'sms',
    granted: true,
    evidence: 'Fictional explicit consent',
  });
  return { org, principal, service, crm, account, accountSid, authToken, contact, conversation };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const queued = (f: Fixture, key = randomUUID()) =>
  f.service.sendSms({
    conversationId: f.conversation.id,
    body: 'An employee will contact you about your request.',
    idempotencyKey: key,
  });
const inbound = (f: Fixture, body: string, externalId = sid()) =>
  processInboundMessage(db, f.account.id, {
    externalId,
    from: '+12025550102',
    to: '+12025550101',
    body,
  });
function fake(
  status: 'accepted' | 'unknown' | 'not_sent' = 'accepted',
  calls: string[] = [],
): ProviderResolver {
  return () => ({
    id: 'twilio',
    sendSms: async (request) => {
      calls.push(request.idempotencyKey);
      return {
        status,
        externalId: status === 'accepted' ? sid() : null,
        ...(status === 'not_sent' ? { retryable: true } : {}),
      };
    },
  });
}
test('queued human SMS is recorded, idempotent and provider acceptance is not delivery', async () => {
  const f = await fixture(),
    key = randomUUID(),
    first = await queued(f, key),
    duplicate = await queued(f, key);
  assert.equal(first.id, duplicate.id);
  assert.equal(first.status, 'queued');
  assert.equal(first.actor, f.principal.actor);
  await assert.rejects(
    f.service.sendSms({
      conversationId: f.conversation.id,
      body: 'Different',
      idempotencyKey: key,
    }),
    code('communication_idempotency_conflict'),
  );
  const calls: string[] = [];
  await Promise.all([
    sendOnce(db, fake('accepted', calls), new Date(), f.org.organization.id),
    sendOnce(db, fake('accepted', calls), new Date(), f.org.organization.id),
  ]);
  assert.equal(calls.length, 1);
  const row = await db.communicationDelivery.findUniqueOrThrow({ where: { id: first.id } });
  assert.equal(row.status, 'accepted');
  assert.equal(row.deliveredAt, null);
  assert.ok(row.externalId);
  assert.equal((await f.service.getConversation(f.conversation.id)).messages.length, 1);
});
test('tenant isolation covers conversations, send targets and database links', async () => {
  const a = await fixture(),
    b = await fixture(),
    row = await queued(a);
  await assert.rejects(
    b.service.getConversation(a.conversation.id),
    code('communication_conversation_not_found'),
  );
  await assert.rejects(
    b.service.sendSms({
      conversationId: a.conversation.id,
      body: 'Cross tenant',
      idempotencyKey: 'other',
    }),
    code('communication_conversation_not_found'),
  );
  await assert.rejects(
    db.communicationDelivery.update({ where: { id: row.id }, data: { contactId: b.contact.id } }),
  );
  await assert.rejects(
    db.communicationDelivery.update({ where: { id: row.id }, data: { accountId: b.account.id } }),
  );
  assert.equal((await b.service.list()).deliveries.length, 0);
});
test('inbound retries normalize exactly once with provider IDs, tenant and source', async () => {
  const f = await fixture(),
    externalId = sid();
  const a = await inbound(f, 'I would like to schedule a conversation.', externalId),
    b = await inbound(f, 'I would like to schedule a conversation.', externalId);
  assert.equal(a.id, b.id);
  assert.equal(b.duplicate, true);
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: f.org.organization.id, type: 'customer.message_received' },
    }),
    1,
  );
  const row = await db.communicationDelivery.findUniqueOrThrow({ where: { id: a.id } });
  assert.equal(row.externalId, externalId);
  assert.equal(row.status, 'received');
  assert.equal(row.provider, 'twilio');
  await assert.rejects(
    inbound(f, 'Changed content', externalId),
    code('communication_idempotency_conflict'),
  );
});
test('STOP is effective before workers run and neither AI nor member consent can clear it', async () => {
  const f = await fixture(),
    row = await queued(f);
  await inbound(f, 'ＳＴＯＰ');
  assert.equal(
    (await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).doNotContact,
    true,
  );
  await assert.rejects(
    f.service.consent({
      contactId: f.contact.id,
      channel: 'sms',
      granted: true,
      evidence: 'Override attempted',
    }),
    code('contact_opted_out'),
  );
  await inbound(f, 'START');
  await assert.rejects(queued(f), code('contact_opted_out'));
  const calls: string[] = [];
  await sendOnce(db, fake('accepted', calls), new Date(), f.org.organization.id);
  assert.equal(calls.length, 0);
  assert.equal(
    (await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } })).status,
    'cancelled',
  );
});
test('address suppression covers duplicate contacts and every canonical CRM inbound path', async () => {
  const f = await fixture();
  await f.crm.create('messages', {
    conversationId: f.conversation.id,
    direction: 'inbound',
    body: 'Please do not email or contact me again.',
    status: 'recorded',
    occurredAt: new Date().toISOString(),
  });
  const other = await f.crm.create('contacts', { name: 'Duplicate person', phone: '+12025550102' });
  await assert.rejects(
    f.service.consent({
      contactId: other.id,
      channel: 'sms',
      granted: true,
      evidence: 'New contact cannot bypass STOP',
    }),
    code('address_suppressed'),
  );
  assert.equal(
    await db.communicationDelivery.count({
      where: { organizationId: f.org.organization.id, direction: 'inbound' },
    }),
    1,
  );
});
test('unknown sends and crashed leases never automatically resend', async () => {
  const f = await fixture(),
    row = await queued(f),
    calls: string[] = [];
  await sendOnce(db, fake('unknown', calls), new Date(), f.org.organization.id);
  await sendOnce(
    db,
    fake('accepted', calls),
    new Date(Date.now() + 3600000),
    f.org.organization.id,
  );
  assert.equal(calls.length, 1);
  assert.equal(
    (await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } })).status,
    'unknown',
  );
  const second = await queued(f);
  await db.communicationDelivery.update({
    where: { id: second.id },
    data: { status: 'sending', attempts: 1, leasedUntil: new Date(0), leaseToken: randomUUID() },
  });
  await sendOnce(db, fake('accepted', calls), new Date(), f.org.organization.id);
  assert.equal(calls.length, 1);
  assert.equal(
    (await db.communicationDelivery.findUniqueOrThrow({ where: { id: second.id } })).status,
    'unknown',
  );
});
test('confirmed non-sends retry with backoff only up to the attempt limit', async () => {
  const f = await fixture(),
    row = await queued(f),
    calls: string[] = [];
  let now = new Date();
  for (let i = 0; i < 3; i++) {
    await sendOnce(db, fake('not_sent', calls), now, f.org.organization.id);
    const current = await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } });
    if (i < 2) {
      assert.equal(current.status, 'queued');
      assert.ok(current.availableAt > now);
      now = new Date(current.availableAt.getTime() + 1);
    } else assert.equal(current.status, 'failed');
  }
  assert.equal(calls.length, 3);
});
test('delivery callbacks are idempotent, scoped and monotonic', async () => {
  const f = await fixture(),
    other = await fixture(),
    row = await queued(f);
  await sendOnce(db, fake(), new Date(), f.org.organization.id);
  const accepted = await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } });
  await processDeliveryStatus(db, f.account.id, row.id, accepted.externalId!, 'delivered');
  await processDeliveryStatus(db, f.account.id, row.id, accepted.externalId!, 'delivered');
  await processDeliveryStatus(db, f.account.id, row.id, accepted.externalId!, 'sent');
  assert.equal(
    (await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } })).status,
    'delivered',
  );
  await assert.rejects(
    processDeliveryStatus(db, other.account.id, row.id, accepted.externalId!, 'failed'),
    code('communication_receipt_mismatch'),
  );
  await assert.rejects(
    processDeliveryStatus(db, f.account.id, row.id, sid(), 'failed'),
    code('communication_receipt_mismatch'),
  );
});
test('provider DND failure suppresses future sends', async () => {
  const f = await fixture(),
    row = await queued(f);
  await sendOnce(
    db,
    () => ({
      id: 'twilio',
      sendSms: async () => ({ status: 'failed', externalId: null, errorCode: 'provider_opt_out' }),
    }),
    new Date(),
    f.org.organization.id,
  );
  assert.equal(
    (await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } })).status,
    'failed',
  );
  await assert.rejects(queued(f), code('contact_opted_out'));
});
test('missing delivery receipts become visible unknown outcomes without retransmission', async () => {
  const f = await fixture(),
    row = await queued(f),
    calls: string[] = [];
  await sendOnce(db, fake('accepted', calls), new Date(), f.org.organization.id);
  await sendOnce(
    db,
    fake('accepted', calls),
    new Date(Date.now() + 2 * 86400000),
    f.org.organization.id,
  );
  const current = await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(current.status, 'unknown');
  assert.equal(current.errorCode, 'delivery_receipt_overdue');
  assert.equal(calls.length, 1);
  await processDeliveryStatus(db, f.account.id, row.id, current.externalId!, 'delivered');
  assert.equal(
    (await db.communicationDelivery.findUniqueOrThrow({ where: { id: row.id } })).status,
    'delivered',
  );
});
test('destination changes, disabled accounts, revoked members and fabricated agent sources block execution', async () => {
  for (const change of ['destination', 'account', 'member', 'agent']) {
    const f = await fixture(),
      row = await queued(f),
      calls: string[] = [];
    if (change === 'destination')
      await db.contact.update({ where: { id: f.contact.id }, data: { phone: '+12025550103' } });
    if (change === 'account')
      await f.service.setEnabled(f.account.id, { enabled: false, expectedRevision: 2 });
    if (change === 'member')
      await db.organizationMember.update({
        where: { id: f.principal.actor.slice(7) },
        data: { active: false },
      });
    if (change === 'agent')
      await db.communicationDelivery.update({
        where: { id: row.id },
        data: { actor: `agent:${randomUUID()}` },
      });
    await sendOnce(db, fake('accepted', calls), new Date(), f.org.organization.id);
    assert.equal(calls.length, 0);
  }
});
test('HTTP endpoints enforce auth, secret redaction, account signatures and default-off gates', async () => {
  const f = await fixture();
  assert.equal((await fetch(`${base}/api/communications`)).status, 401);
  const auth = { authorization: `Bearer ${f.org.token}` };
  const list = await fetch(`${base}/api/communications`, { headers: auth });
  assert.equal(list.status, 200);
  const text = await list.text();
  assert.ok(!text.includes(f.authToken));
  assert.ok(!text.includes('encryptedCredentials'));
  const external = await new IntegrationService(db, f.principal).createConnection({
    name: 'Inbound CRM',
    provider: 'generic_webhook',
  });
  assert.equal(
    (
      await fetch(`${base}/api/communications`, {
        headers: { authorization: `Bearer ${external.token}` },
      })
    ).status,
    403,
  );
  const route = `/api/communications/providers/twilio/${f.account.id}/inbound`,
    payload = {
      AccountSid: f.accountSid,
      MessageSid: sid(),
      From: '+12025550102',
      To: '+12025550101',
      Body: 'Hello from fictional customer',
    };
  const signature = createHmac('sha1', f.authToken)
    .update(
      process.env.APP_URL +
        route +
        Object.keys(payload)
          .sort()
          .map((key) => key + payload[key as keyof typeof payload])
          .join(''),
    )
    .digest('base64');
  assert.equal(
    (
      await fetch(base + route, {
        method: 'POST',
        body: new URLSearchParams(payload),
        headers: { 'x-twilio-signature': 'forged' },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(base + route, {
        method: 'POST',
        body: new URLSearchParams(payload),
        headers: { 'x-twilio-signature': signature },
      })
    ).status,
    200,
  );
  process.env.COMMUNICATIONS_ENABLED = 'false';
  try {
    assert.equal((await fetch(`${base}/api/communications`, { headers: auth })).status, 404);
  } finally {
    process.env.COMMUNICATIONS_ENABLED = 'true';
  }
});
test('email fails explicitly until a provider is installed and permission fields cannot be supplied', async () => {
  const f = await fixture(),
    conversation = await f.crm.create('conversations', {
      contactId: f.contact.id,
      subject: 'Email',
      channel: 'email',
    });
  await f.service.consent({
    contactId: f.contact.id,
    channel: 'email',
    granted: true,
    evidence: 'Fictional email permission',
  });
  await assert.rejects(
    f.service.sendEmail({
      conversationId: conversation.id,
      body: 'Reviewed email',
      idempotencyKey: 'email',
    }),
    code('communication_provider_unavailable'),
  );
  assert.throws(() =>
    f.service.sendSms({
      conversationId: f.conversation.id,
      body: 'Bypass',
      idempotencyKey: 'bypass',
      bypassOptOut: true,
    }),
  );
});
test('queued employee messages are canonical activity so Recovery can detect a conflicting action', async () => {
  const f = await fixture(),
    row = await queued(f);
  const event = await db.businessEvent.findFirst({
    where: {
      organizationId: f.org.organization.id,
      entityId: row.messageId,
      type: 'message.created',
    },
    include: { links: true },
  });
  assert.ok(event);
  assert.equal(event.actor, f.principal.actor);
  assert.ok(event.links.some((link) => link.recordId === f.contact.id));
  assert.ok(event.links.some((link) => link.recordId === f.conversation.id));
  assert.equal(row.deliveredAt, null);
});
test('pausing an account does not discard authenticated inbound opt-outs', async () => {
  const f = await fixture();
  await f.service.setEnabled(f.account.id, { enabled: false, expectedRevision: 2 });
  await inbound(f, 'STOP');
  assert.equal(
    (await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).doNotContact,
    true,
  );
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: f.org.organization.id, type: 'customer.message_received' },
    }),
    1,
  );
});
test('Recovery uses the same ledger while preserving its separate approval and provider claim boundary', async () => {
  const f = await fixture(),
    recovery = new RecoveryService(db, f.principal),
    config = exampleConfig();
  config.model = 'test-model';
  config.knowledge = config.knowledge.map((k) => ({ ...k, approved: true }));
  config.workingHours = { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };
  await recovery.configure({ config, reviewed: true, expectedVersion: 0, connectionId: null });
  await recovery.enable(true);
  const pipeline = await f.crm.create('pipelines', { name: 'Services' }),
    stage = await f.crm.create('stages', { pipelineId: pipeline.id, name: 'Unsold', position: 0 });
  const opportunity = await f.crm.create('opportunities', {
    title: 'Service proposal',
    customerId: f.contact.id,
    pipelineId: pipeline.id,
    stageId: stage.id,
    amountMinor: 500000,
    currency: 'USD',
    lastActivityAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  });
  const c = await recovery.enroll(opportunity.id);
  const dispatch = await tenantTransaction(db, f.org.organization.id, async (tx) => {
    const snapshot = await loadCase(tx, f.org.organization.id, c.id);
    const row = await tx.recoveryDispatch.create({
      data: {
        organizationId: f.org.organization.id,
        caseId: c.id,
        requestKey: 'fixture-only',
        body: config.knowledge[0]!.text,
        channel: 'sms',
        actor: `agent:${snapshot.program.agentId}`,
        caseRevision: snapshot.revision,
        runtimeVersionId: snapshot.program.runtimeVersionId,
      },
    });
    await recordRecoveryDispatch(tx, f.org.organization.id, row.id);
    return row;
  });
  const calls: string[] = [];
  await sendOnce(db, fake('accepted', calls), new Date(), f.org.organization.id);
  assert.equal(calls.length, 0);
  await inbound(f, 'STOP');
  const blocked = await tenantTransaction(db, f.org.organization.id, async (tx) =>
    messageGuard(tx, await loadCase(tx, f.org.organization.id, c.id), 'sms', new Date()),
  );
  assert.equal(blocked, 'opt_out');
  await tenantTransaction(db, f.org.organization.id, (tx) =>
    recoveryStatus(tx, f.org.organization.id, dispatch.id, 'cancelled', null, 'opt_out'),
  );
  assert.equal(
    (
      await db.communicationDelivery.findUniqueOrThrow({
        where: {
          organizationId_recoveryDispatchId: {
            organizationId: f.org.organization.id,
            recoveryDispatchId: dispatch.id,
          },
        },
      })
    ).status,
    'cancelled',
  );
});
test('legacy opt-outs are persisted even when SMS booking is disabled', async () => {
  const client = await db.client.create({
    data: {
      businessName: 'Legacy communication test',
      timezone: 'UTC',
      phoneNumber: `+1202${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
      services: ['Maintenance'],
      smsBookingEnabled: false,
    },
  });
  const org = await provisionOrganization(
    db,
    { name: 'Linked legacy test', ownerSubject: randomUUID(), legacyClientId: client.id },
    'test',
  );
  const input = { messageSid: sid(), from: '+12025550102', to: client.phoneNumber, body: 'STOP' };
  await db.organization.update({ where: { id: org.organization.id }, data: { active: false } });
  await persistLegacyIngress(db, input);
  await persistLegacyIngress(db, input);
  await db.organization.update({ where: { id: org.organization.id }, data: { active: true } });
  assert.equal(await legacySmsBlocked(db, client.id, input.from), true);
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: org.organization.id, type: 'customer.message_received' },
    }),
    1,
  );
});
test('turning off the communication feature cannot bypass existing canonical DND in legacy sends', async () => {
  const f = await fixture();
  const client = await db.client.create({
    data: {
      businessName: 'Linked safety test',
      timezone: 'UTC',
      phoneNumber: `+1202${String(Math.floor(Math.random() * 10000000)).padStart(7, '0')}`,
      services: [],
    },
  });
  await db.organization.update({
    where: { id: f.org.organization.id },
    data: { legacyClientId: client.id },
  });
  await db.smsConversation.create({
    data: { clientId: client.id, customerNumber: '+12025550102', status: 'opted_out' },
  });
  await assert.rejects(queued(f), code('legacy_contact_opted_out'));
  await inbound(f, 'STOP');
  process.env.COMMUNICATIONS_ENABLED = 'false';
  try {
    assert.equal(await legacySmsBlocked(db, client.id, '+12025550102'), true);
  } finally {
    process.env.COMMUNICATIONS_ENABLED = 'true';
  }
});
