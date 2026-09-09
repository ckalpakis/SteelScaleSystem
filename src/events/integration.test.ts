/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test, { before, after } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import {
  provisionOrganization,
  authenticate,
  issueCredential,
} from '../workforce/tenancy/service.js';
import { tenantTransaction, json, WorkforceError } from '../workforce/shared.js';
import { ingestEvent } from '../workforce/events/service.js';
import { CrmService } from '../crm/service.js';
import { EventPublisher, readCanonicalEvent } from './publisher.js';
import { EventRouter } from './router.js';
import { eventRouter } from './handlers.js';
import { defaultRecoveryConfig } from '../workforce/agents/config.js';

requireDemoTestDatabase();
Object.assign(process.env, {
  WORKFORCE_ENABLED: 'true',
  CRM_ENABLED: 'true',
  WORKFORCE_WORKER_ENABLED: 'false',
  ADMIN_USERNAME: 'event-test',
  ADMIN_PASSWORD: 'event-test-only',
  LOG_LEVEL: 'silent',
});
let db: PrismaClient;
let server: Server;
let base: string;
before(async () => {
  const modules = await Promise.all([import('../app.js'), import('../db/client.js')]);
  db = modules[1].db;
  server = modules[0].app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}/api/workforce`;
});
after(async () => {
  if (server?.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  if (db) await db.$disconnect();
});
async function fixture(provider = 'zapier') {
  const owner = await provisionOrganization(
    db,
    { name: `Event test ${randomUUID()}`, ownerSubject: `events:${randomUUID()}` },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${owner.token}`);
  const organizationId = owner.organization.id;
  const crm = new CrmService(db, principal);
  const connection = await db.externalConnection.create({
    data: {
      organizationId,
      name: 'Test connection',
      provider,
      externalAccountId: provider === 'ghl' ? 'location-test' : null,
    },
  });
  const token = await db.$transaction((tx) =>
    issueCredential(tx, organizationId, { integrationId: connection.id }, ['events:write']),
  );
  const api = (body: unknown, path = 'canonical') =>
    fetch(`${base}/webhooks/${connection.id}/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    ...owner,
    organizationId,
    principal,
    crm,
    connection,
    api,
    integrationToken: token.token,
  };
}
async function deal(crm: CrmService) {
  const contact = await crm.create('contacts', { name: 'Alex Example' });
  const pipeline = await crm.create('pipelines', { name: 'Service agreements' });
  const open = await crm.create('stages', {
    name: 'Consultation',
    pipelineId: pipeline.id,
    position: 0,
  });
  const won = await crm.create('stages', {
    name: 'Agreement signed',
    pipelineId: pipeline.id,
    position: 1,
    outcome: 'won',
  });
  const opportunity = await crm.create('opportunities', {
    title: 'Annual service',
    customerId: contact.id,
    pipelineId: pipeline.id,
    stageId: open.id,
    amountMinor: 10000,
    currency: 'USD',
    lastActivityAt: new Date(Date.now() - 30 * 86400000).toISOString(),
  });
  return { contact, pipeline, open, won, opportunity };
}
async function mapping(
  t: Awaited<ReturnType<typeof fixture>>,
  type: string,
  id: string,
  externalRecordType = type,
  externalId = id,
) {
  return t.crm.mapExternal({
    connectionId: t.connection.id,
    externalRecordType,
    externalId,
    internalEntityType: type,
    internalEntityId: id,
  });
}
const observed = (offset = 1000) => new Date(Date.now() + offset).toISOString();
const code = (expected: string) => (err: unknown) =>
  err instanceof WorkforceError && err.code === expected;

test('delayed newer source updates apply, older updates and intervening local edits are protected', async () => {
  const t = await fixture();
  const observation = {
    version: 2,
    id: 'delayed-create',
    type: 'contact.created',
    occurredAt: new Date(Date.now() - 3 * 86400000).toISOString(),
    entity: { type: 'contact', externalRecordType: 'contact', externalId: 'delayed-contact' },
    data: { changes: { name: 'Original' } },
  };
  const created = await t.api(observation);
  assert.equal(created.status, 202);
  const result = (await created.json()) as { entityId: string };
  const update = {
    ...observation,
    id: 'delayed-update',
    type: 'contact.updated',
    occurredAt: new Date(Date.now() - 2 * 86400000).toISOString(),
    data: { changes: { name: 'Newer source' } },
  };
  assert.equal((await t.api(update)).status, 202);
  let contact = (await t.crm.detail('contacts', result.entityId)).entity;
  assert.equal(contact.name, 'Newer source');
  const old = await t.api({ ...update, id: 'older-update', occurredAt: observation.occurredAt });
  assert.equal(((await old.json()) as { reason: string }).reason, 'stale_observation');
  await t.crm.update('contacts', contact.id, {
    expectedVersion: contact.record.version,
    name: 'Local edit',
  });
  const afterLocal = await t.api({
    ...update,
    id: 'after-local',
    occurredAt: new Date(Date.now() - 86400000).toISOString(),
  });
  assert.equal(((await afterLocal.json()) as { reason: string }).reason, 'stale_observation');
  contact = (await t.crm.detail('contacts', result.entityId)).entity;
  assert.equal(contact.name, 'Local edit');
});

test('publisher persists a stable canonical envelope and one outbox job for concurrent retries', async () => {
  const t = await fixture();
  const contact = await t.crm.create('contacts', { name: 'Alex' });
  const source = {
    organizationId: t.organizationId,
    system: 'test',
    provider: 'steel_scale',
    actor: 'test',
  };
  const input = {
    version: 2,
    type: 'contact.updated',
    idempotencyKey: 'same-id',
    occurredAt: observed(),
    entity: { type: 'contact', id: contact.id },
    data: { changes: { name: 'Alex' } },
  };
  const publisher = new EventPublisher(db);
  const results = await Promise.all([
    publisher.publish(source, input),
    publisher.publish(source, input),
  ]);
  assert.equal(results.filter((r) => r.duplicate).length, 1);
  assert.equal(results[0].event.id, results[1].event.id);
  const envelope = readCanonicalEvent(results[0].event);
  assert.equal(envelope.organizationId, t.organizationId);
  assert.equal(envelope.entity.id, contact.id);
  assert.equal(envelope.source.provider, 'steel_scale');
  assert.ok(envelope.correlationId);
  assert.equal(
    await db.workforceJob.count({
      where: { organizationId: t.organizationId, eventId: envelope.id },
    }),
    1,
  );
  await assert.rejects(
    publisher.publish(source, { ...input, data: { changes: { name: 'Changed replay' } } }),
    code('event_id_reused_with_different_payload'),
  );
});
test('publisher, handler receipts and reference FKs reject foreign tenant entities/events', async () => {
  const a = await fixture();
  const b = await fixture();
  const contact = await a.crm.create('contacts', { name: 'Private' });
  const event = (await a.crm.detail('contacts', contact.id)).activity[0]!;
  await assert.rejects(
    new EventPublisher(db).publish(
      { organizationId: b.organizationId, system: 'test', provider: 'steel_scale', actor: 'test' },
      {
        version: 2,
        type: 'contact.updated',
        idempotencyKey: 'foreign',
        occurredAt: observed(),
        entity: { type: 'contact', id: contact.id },
        data: { changes: {} },
      },
    ),
    code('event_entity_not_found'),
  );
  await assert.rejects(
    tenantTransaction(db, b.organizationId, (tx) =>
      eventRouter.dispatch(tx, b.organizationId, event.id),
    ),
    code('event_not_found'),
  );
  await assert.rejects(
    db.eventDelivery.create({
      data: { organizationId: b.organizationId, eventId: event.id, handlerId: 'test.v1' },
    }),
  );
  await assert.rejects(
    db.businessEvent.update({ where: { id: event.id }, data: { connectionId: b.connection.id } }),
  );
});
test('native stage moves publish updated/stage_changed/won with correlated causation once', async () => {
  const t = await fixture();
  const d = await deal(t.crm);
  await t.crm.update('opportunities', d.opportunity.id, { expectedVersion: 1, stageId: d.won.id });
  const events = await db.businessEvent.findMany({
    where: { organizationId: t.organizationId, entityId: d.opportunity.id },
  });
  const moved = events.find((e) => e.type === 'opportunity.stage_changed')!;
  const won = events.find((e) => e.type === 'opportunity.won')!;
  assert.ok(moved && won);
  assert.equal(moved.causationId, won.causationId);
  assert.equal(moved.correlationId, won.correlationId);
  assert.deepEqual(readCanonicalEvent(moved).data, {
    fromStageId: d.open.id,
    toStageId: d.won.id,
    fromPipelineId: d.pipeline.id,
    toPipelineId: d.pipeline.id,
  });
  const current = await t.crm.detail('opportunities', d.opportunity.id);
  await t.crm.update('opportunities', d.opportunity.id, {
    expectedVersion: current.entity.record.version,
    title: 'Revised title',
  });
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: t.organizationId, type: 'opportunity.won' },
    }),
    1,
  );
});
test('estimate notifications reuse native rules and duplicate intake does not republish', async () => {
  const t = await fixture('jobber');
  const d = await deal(t.crm);
  const estimate = await t.crm.create('estimates', {
    title: 'Annual service',
    number: 'EST-1',
    opportunityId: d.opportunity.id,
    amountMinor: 10000,
    currency: 'USD',
  });
  await mapping(t, 'estimate', estimate.id, 'estimate', 'jobber-est-1');
  const event = {
    version: 2,
    id: 'sent-1',
    type: 'estimate.sent',
    occurredAt: observed(),
    entity: { type: 'estimate', externalRecordType: 'estimate', externalId: 'jobber-est-1' },
    data: {},
  };
  const responses = await Promise.all([t.api(event), t.api(event)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 202]);
  assert.equal((await t.crm.detail('estimates', estimate.id)).entity.status, 'sent');
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: t.organizationId, type: 'estimate.sent' },
    }),
    1,
  );
  assert.equal(
    (
      await t.api({
        ...event,
        id: 'accepted-1',
        type: 'estimate.accepted',
        occurredAt: observed(2000),
      })
    ).status,
    202,
  );
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: t.organizationId, type: 'estimate.accepted' },
    }),
    1,
  );
  assert.equal((await t.api({ ...event, data: { changed: true } })).status, 409);
  const stale = await t.api({
    ...event,
    id: 'old-sent',
    occurredAt: new Date(Date.now() - 86400000).toISOString(),
  });
  assert.equal(stale.status, 202);
  assert.equal((await t.crm.detail('estimates', estimate.id)).entity.status, 'accepted');
});
test('inbound duplicate deliveries and duplicate external message IDs create one message and one received fact', async () => {
  const t = await fixture();
  const c = await t.crm.create('contacts', { name: 'Alex' });
  const conversation = await t.crm.create('conversations', {
    contactId: c.id,
    subject: 'Service inquiry',
    channel: 'sms',
  });
  await mapping(t, 'conversation', conversation.id, 'conversation', 'thread-1');
  const event = {
    version: 2,
    id: 'delivery-1',
    type: 'customer.message_received',
    occurredAt: new Date().toISOString(),
    entity: { type: 'message', externalRecordType: 'message', externalId: 'sms-1' },
    data: { conversationExternalId: 'thread-1', body: 'Please call me tomorrow.' },
  };
  const responses = await Promise.all([t.api(event), t.api(event)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 202]);
  assert.equal((await t.api({ ...event, id: 'delivery-2' })).status, 202);
  assert.equal(await db.message.count({ where: { organizationId: t.organizationId } }), 1);
  const received = await db.businessEvent.findMany({
    where: { organizationId: t.organizationId, type: 'customer.message_received' },
  });
  assert.equal(received.length, 1);
  assert.equal(readCanonicalEvent(received[0]!).data.contactId, c.id);
  assert.equal(readCanonicalEvent(received[0]!).source.provider, 'zapier');
  assert.equal(
    (await t.api({ ...event, id: 'tampered', data: { ...event.data, body: 'Different body' } }))
      .status,
    409,
  );
  const b = await fixture();
  assert.equal((await b.api(event)).status, 404);
  // At-least-once dispatch produces a single persisted unsent draft effect.
  const router = new EventRouter([
    {
      id: 'reply-draft.v1',
      types: ['customer.message_received'],
      handle: async (tx, e) => {
        await tx.message.create({
          data: {
            organizationId: e.organizationId,
            conversationId: e.data.conversationId as string,
            direction: 'outbound',
            status: 'draft',
            body: 'Human review required.',
            occurredAt: new Date(),
          },
        });
      },
    },
  ]);
  const dispatch = () =>
    tenantTransaction(db, t.organizationId, (tx) =>
      router.dispatch(tx, t.organizationId, received[0]!.id),
    );
  await Promise.all([dispatch(), dispatch()]);
  assert.equal(
    await db.message.count({ where: { organizationId: t.organizationId, direction: 'outbound' } }),
    1,
  );
});
test('handler failure rolls back effects and receipts; successful retry is applied once', async () => {
  const t = await fixture();
  const c = await t.crm.create('contacts', { name: 'Alex' });
  const event = (await t.crm.detail('contacts', c.id)).activity[0]!;
  let fail = true;
  const router = new EventRouter([
    {
      id: 'note.v1',
      types: ['contact.created'],
      handle: async (tx, e) => {
        await tx.note.create({
          data: { organizationId: e.organizationId, relatedRecordId: c.id, body: 'Handler effect' },
        });
      },
    },
    {
      id: 'second.v1',
      types: ['contact.created'],
      handle: () => (fail ? Promise.reject(new Error('test failure')) : Promise.resolve()),
    },
  ]);
  const run = () =>
    tenantTransaction(db, t.organizationId, (tx) =>
      router.dispatch(tx, t.organizationId, event.id),
    );
  await assert.rejects(run());
  assert.equal(await db.note.count({ where: { organizationId: t.organizationId } }), 0);
  assert.equal(await db.eventDelivery.count({ where: { organizationId: t.organizationId } }), 0);
  fail = false;
  await run();
  await run();
  assert.equal(await db.note.count({ where: { organizationId: t.organizationId } }), 1);
  assert.equal(await db.eventDelivery.count({ where: { organizationId: t.organizationId } }), 2);
});
test('duplicate canonical delivery cannot create another agent run', async () => {
  const t = await fixture();
  const d = await deal(t.crm);
  await db.workforceAgent.create({
    data: {
      organizationId: t.organizationId,
      name: 'Recovery',
      description: 'Review stale opportunities',
      enabled: true,
      config: json(defaultRecoveryConfig),
    },
  });
  const event = await db.businessEvent.findFirstOrThrow({
    where: {
      organizationId: t.organizationId,
      entityId: d.opportunity.id,
      type: 'opportunity.created',
    },
  });
  const run = () =>
    tenantTransaction(db, t.organizationId, (tx) =>
      eventRouter.dispatch(tx, t.organizationId, event.id),
    );
  await Promise.all([run(), run()]);
  assert.equal(
    await db.workforceRun.count({ where: { organizationId: t.organizationId, eventId: event.id } }),
    1,
  );
  assert.equal(await db.workforceAction.count({ where: { organizationId: t.organizationId } }), 1);
});
test('legacy intake publishes canonical types and old pending ledger events normalize without mutation', async () => {
  const t = await fixture();
  const input = {
    id: 'legacy-contact',
    version: 1 as const,
    type: 'customer.upserted' as const,
    occurredAt: new Date().toISOString(),
    data: { externalId: 'c1', name: 'Legacy name' },
  };
  const accepted = await ingestEvent(db, t.organizationId, 'internal', 'test', input);
  const event = await db.businessEvent.findUniqueOrThrow({ where: { id: accepted.eventId } });
  assert.equal(event.type, 'contact.created');
  assert.equal(event.version, 2);
  assert.equal(
    (await ingestEvent(db, t.organizationId, 'internal', 'test', input)).duplicate,
    true,
  );
  const old = await db.businessEvent.create({
    data: {
      organizationId: t.organizationId,
      source: 'historical',
      externalId: 'old',
      type: 'opportunity.upserted',
      version: 1,
      payload: { data: {} },
      payloadHash: 'legacy',
      occurredAt: new Date(),
    },
  });
  const historicalDeal = await deal(t.crm);
  await db.businessEventLink.create({
    data: {
      organizationId: t.organizationId,
      eventId: old.id,
      recordId: historicalDeal.opportunity.id,
    },
  });
  let observedType = '';
  const router = new EventRouter([
    {
      id: 'compat.v1',
      types: ['opportunity.updated'],
      handle: (_tx, e) => {
        observedType = e.type;
        assert.equal(e.entity.type, 'opportunity');
        assert.equal(e.entity.id, historicalDeal.opportunity.id);
        return Promise.resolve();
      },
    },
  ]);
  await tenantTransaction(db, t.organizationId, (tx) =>
    router.dispatch(tx, t.organizationId, old.id),
  );
  assert.equal(observedType, 'opportunity.updated');
  assert.equal((await db.businessEvent.findUniqueOrThrow({ where: { id: old.id } })).version, 1);
  await db.businessEvent.update({ where: { id: old.id }, data: { version: 99 } });
  await assert.rejects(
    tenantTransaction(db, t.organizationId, (tx) => router.dispatch(tx, t.organizationId, old.id)),
    code('unsupported_event_version'),
  );
});
test('GHL relay translates mapped opportunity stages and preserves source/location identity', async () => {
  const t = await fixture('ghl');
  const d = await deal(t.crm);
  await mapping(t, 'contact', d.contact.id, 'customer', 'ghl-contact');
  await mapping(t, 'opportunity', d.opportunity.id, 'opportunity', 'ghl-opportunity');
  await mapping(t, 'pipeline', d.pipeline.id, 'pipeline', 'ghl-pipeline');
  await mapping(t, 'pipeline_stage', d.won.id, 'pipeline_stage', 'ghl-won');
  const input = {
    id: 'ghl-delivery',
    occurredAt: observed(),
    payload: {
      type: 'OpportunityStageUpdate',
      locationId: 'location-test',
      id: 'ghl-opportunity',
      contactId: 'ghl-contact',
      name: 'Annual service',
      pipelineId: 'ghl-pipeline',
      pipelineStageId: 'ghl-won',
      status: 'won',
      monetaryValue: 123.45,
    },
  };
  assert.equal((await t.api(input, 'ghl')).status, 202);
  assert.equal((await t.api(input, 'ghl')).status, 200);
  const current = (await t.crm.detail('opportunities', d.opportunity.id)).entity;
  assert.equal(current.status, 'won');
  assert.equal(current.amountMinor, 12345);
  const events = await db.businessEvent.findMany({
    where: { organizationId: t.organizationId, provider: 'ghl' },
  });
  assert.deepEqual(events.map((e) => e.type).sort(), [
    'opportunity.stage_changed',
    'opportunity.updated',
    'opportunity.won',
  ]);
  assert.ok(
    events.every(
      (e) => e.connectionId === t.connection.id && e.externalRecordId === 'ghl-opportunity',
    ),
  );
  assert.equal(
    (
      await t.api(
        { ...input, id: 'wrong-location', payload: { ...input.payload, locationId: 'other' } },
        'ghl',
      )
    ).status,
    403,
  );
});
test('invoice/job observations use related canonical records without creating payments or invented models', async () => {
  const t = await fixture('housecall_pro');
  const d = await deal(t.crm);
  await mapping(t, 'opportunity', d.opportunity.id, 'opportunity', 'project-1');
  const event = {
    version: 2,
    id: 'invoice-paid',
    type: 'invoice.paid',
    occurredAt: observed(),
    entity: { type: 'invoice', externalRecordType: 'invoice', externalId: 'inv-1' },
    relatedEntity: { externalRecordType: 'opportunity', externalId: 'project-1' },
    data: { amountMinor: 10000, currency: 'USD' },
  };
  assert.equal((await t.api(event)).status, 202);
  assert.equal((await t.api(event)).status, 200);
  assert.equal(await db.workforceRevenue.count({ where: { organizationId: t.organizationId } }), 0);
  const stored = await db.businessEvent.findFirstOrThrow({
    where: { organizationId: t.organizationId, type: 'invoice.paid' },
  });
  assert.equal(stored.entityId, null);
  assert.equal(stored.externalRecordId, 'inv-1');
  assert.ok(readCanonicalEvent(stored).relatedRecordIds?.includes(d.opportunity.id));
  assert.equal(
    (
      await t.api({
        ...event,
        id: 'job-complete',
        type: 'job.completed',
        entity: { type: 'job', externalRecordType: 'job', externalId: 'job-1' },
        data: { title: 'Annual maintenance' },
      })
    ).status,
    202,
  );
});
