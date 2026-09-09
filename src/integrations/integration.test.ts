/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import {
  provisionOrganization,
  authenticate,
  issueCredential,
} from '../workforce/tenancy/service.js';
import { IntegrationService } from './service.js';
import { receive } from './inbound.js';
import { deliverOnce } from './worker.js';
import { organizationLimit } from './rate-limit.js';
import { CrmService } from '../crm/service.js';
import { WorkforceError, tenantTransaction } from '../workforce/shared.js';
import { publishAgentFact } from '../workforce/events/facts.js';
requireDemoTestDatabase();
Object.assign(process.env, {
  WORKFORCE_ENABLED: 'true',
  CRM_ENABLED: 'true',
  WORKFORCE_WORKER_ENABLED: 'false',
  WEBHOOK_DELIVERY_ENABLED: 'true',
  INTEGRATION_ENCRYPTION_KEY: 'b'.repeat(64),
  ADMIN_USERNAME: 'zapier-test',
  ADMIN_PASSWORD: 'zapier-test-only',
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
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await db?.$disconnect();
});
async function fixture(mapping: Record<string, string> = {}) {
  const org = await provisionOrganization(
    db,
    { name: 'Zapier fixture', ownerSubject: `zapier:${randomUUID()}` },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${org.token}`);
  const service = new IntegrationService(db, principal);
  const credential = await service.createConnection({ name: 'External CRM', mapping });
  const integration = await authenticate(db, `Bearer ${credential.token}`);
  const api = (body: unknown, token = credential.token, path = '/webhooks/events') =>
    fetch(`${base}/api/integrations${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  return {
    org,
    principal,
    service,
    credential,
    integration,
    api,
    organizationId: org.organization.id,
    crm: new CrmService(db, principal),
  };
}
function bundle() {
  return {
    version: 1,
    event: 'estimate.sent',
    external_id: 'estimate-change-1',
    occurred_at: new Date().toISOString(),
    contact: { external_id: 'c1', name: 'Alex Example' },
    pipeline: { external_id: 'p1', name: 'Services' },
    stage: { external_id: 's1', name: 'Quote sent', outcome: 'open' },
    opportunity: {
      external_id: 'o1',
      title: 'Service agreement',
      amount_minor: '10000',
      currency: 'USD',
    },
    estimate: {
      external_id: 'e1',
      number: 'E-1',
      title: 'Annual service',
      amount_minor: 10000,
      currency: 'USD',
    },
  };
}
test('bundle imports canonical contact/opportunity/estimate and deduplicates concurrent deliveries', async () => {
  const t = await fixture();
  const body = bundle();
  const responses = await Promise.all([t.api(body), t.api(body)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 202]);
  assert.equal(await db.contact.count({ where: { organizationId: t.organizationId } }), 1);
  assert.equal(await db.opportunity.count({ where: { organizationId: t.organizationId } }), 1);
  assert.equal(
    await db.estimate.count({ where: { organizationId: t.organizationId, status: 'sent' } }),
    1,
  );
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: t.organizationId, type: 'estimate.sent' },
    }),
    1,
  );
  assert.equal(
    (await t.api({ ...body, contact: { ...body.contact, name: 'Changed retry' } })).status,
    409,
  );
  const invalid = bundle();
  invalid.external_id = 'invalid-bundle';
  invalid.contact.external_id = 'c2';
  invalid.opportunity.external_id = 'o2';
  invalid.estimate.external_id = 'e2';
  invalid.estimate.number = 'E-2';
  invalid.estimate.currency = 'wrong';
  assert.equal((await t.api(invalid)).status, 400);
  assert.equal(await db.contact.count({ where: { organizationId: t.organizationId } }), 1);
  const overview = await t.service.overview();
  assert.ok(overview.inbound.some((a) => a.statusCode === 400));
  assert.ok(!JSON.stringify(overview.inbound).includes('Alex Example'));
});
test('mapped custom payloads and fallback body deduplication need no native CRM integration', async () => {
  const t = await fixture({
    event: 'kind',
    occurred_at: 'time',
    'contact.external_id': 'client.identifier',
    'contact.name': 'client.display',
  });
  const body = {
    version: 1,
    kind: 'contact.created',
    time: new Date().toISOString(),
    client: {
      identifier: 'customer-77',
      display: 'Mapped Customer',
      medical_notes: 'not retained',
    },
  };
  assert.equal((await t.api(body)).status, 202);
  assert.equal((await t.api(body)).status, 200);
  const c = await db.contact.findFirstOrThrow({ where: { organizationId: t.organizationId } });
  assert.equal(c.name, 'Mapped Customer');
  assert.ok(!JSON.stringify(await t.service.overview()).includes('not retained'));
});
test('credentials isolate tenants, revoke immediately and never appear in subsequent reads', async () => {
  const a = await fixture();
  const b = await fixture();
  const body = {
    version: 1,
    event: 'contact.created',
    occurred_at: new Date().toISOString(),
    external_id: 'same',
    contact: { external_id: 'same', name: 'Scoped' },
  };
  assert.equal((await a.api(body)).status, 202);
  assert.equal((await b.api(body)).status, 202);
  assert.equal(
    (await a.api(body, a.credential.token, `/webhooks/${b.credential.connectionId}/events`)).status,
    403,
  );
  await assert.rejects(b.service.revoke(a.credential.credentialId));
  assert.ok(!JSON.stringify(await a.service.overview()).includes(a.credential.token));
  await a.service.revoke(a.credential.credentialId);
  assert.equal((await a.api(body)).status, 401);
  assert.equal((await a.api(body, a.org.token)).status, 403);
});
test('pipeline moves, appointments, customer messages, invoices and jobs normalize together', async () => {
  const t = await fixture();
  assert.equal((await t.api(bundle())).status, 202);
  const at = () => new Date(Date.now() + 1000).toISOString();
  const move = {
    version: 1,
    event: 'opportunity.won',
    external_id: 'won',
    occurred_at: at(),
    pipeline: { external_id: 'p1' },
    stage: { external_id: 's2', name: 'Signed', outcome: 'won' },
    opportunity: { external_id: 'o1' },
  };
  const moved = await t.api(move);
  assert.equal(moved.status, 202, await moved.text());
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: t.organizationId, type: 'opportunity.stage_changed' },
    }),
    1,
  );
  const appt = await t.api({
    version: 1,
    event: 'appointment.booked',
    external_id: 'appt-event',
    occurred_at: at(),
    contact: { external_id: 'c1' },
    appointment: {
      external_id: 'a1',
      title: 'Consultation',
      starts_at: '2026-12-01T12:00:00Z',
      ends_at: '2026-12-01T13:00:00Z',
      timezone: 'UTC',
    },
  });
  assert.equal(appt.status, 202, await appt.text());
  const message = {
    version: 1,
    event: 'customer.message_received',
    external_id: 'msg-event',
    occurred_at: new Date().toISOString(),
    contact: { external_id: 'c1' },
    conversation: { external_id: 'thread-1', subject: 'Question', channel: 'sms' },
    message: { external_id: 'sms-1', body: 'Please call.' },
  };
  assert.equal((await t.api(message)).status, 202);
  assert.equal((await t.api({ ...message, external_id: 'different-delivery' })).status, 202);
  assert.equal(await db.message.count({ where: { organizationId: t.organizationId } }), 1);
  for (const [event, section, data] of [
    ['invoice.paid', 'invoice', { amount_minor: 10000, currency: 'USD' }],
    ['job.completed', 'job', { title: 'Annual service' }],
  ] as const) {
    const response = await t.api({
      version: 1,
      event,
      external_id: event,
      occurred_at: at(),
      opportunity: { external_id: 'o1' },
      [section]: { external_id: section, ...data },
    });
    assert.equal(response.status, 202, await response.text());
  }
  assert.equal(await db.workforceRevenue.count({ where: { organizationId: t.organizationId } }), 0);
});
test('outbound events snapshot safely, suppress inbound loops and retry stable deliveries', async () => {
  const t = await fixture();
  const configured = await t.service.createEndpoint({
    name: 'Zapier',
    url: 'https://hooks.zapier.com/hooks/catch/1/secret/',
    events: ['contact.updated'],
  });
  const stored = await db.webhookEndpoint.findUniqueOrThrow({ where: { id: configured.id } });
  assert.ok(!stored.encryptedUrl.includes('secret/'));
  assert.ok(!stored.encryptedSecret.includes(configured.signingSecret));
  const contact = await t.crm.create('contacts', { name: 'Private' });
  await t.crm.update('contacts', contact.id, {
    expectedVersion: contact.record.version,
    name: 'Updated Private',
    email: 'private@example.test',
  });
  const row = await db.outboundDelivery.findFirstOrThrow({
    where: { organizationId: t.organizationId },
  });
  assert.ok(!JSON.stringify(row.payload).includes('Updated Private'));
  const seen: string[] = [];
  const fail = (input: { deliveryId: string }) => {
    seen.push(input.deliveryId);
    return Promise.resolve(503);
  };
  await deliverOnce(db, fail, new Date(Date.now() + 1000), t.organizationId);
  let updated = await db.outboundDelivery.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(updated.status, 'pending');
  assert.equal(updated.lastErrorCode, 'http_503');
  await deliverOnce(
    db,
    (input) => {
      seen.push(input.deliveryId);
      return Promise.resolve(204);
    },
    new Date(updated.availableAt.getTime() + 1),
    t.organizationId,
  );
  updated = await db.outboundDelivery.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(updated.status, 'succeeded');
  assert.deepEqual(seen, [row.id, row.id]);
  assert.equal(
    await db.outboundAttempt.count({
      where: { organizationId: t.organizationId, deliveryId: row.id },
    }),
    2,
  );
  assert.equal(
    await deliverOnce(db, fail, new Date(Date.now() + 9999999), t.organizationId),
    false,
  );
  const inbound = {
    version: 1,
    event: 'contact.updated',
    external_id: 'ext-create',
    occurred_at: new Date().toISOString(),
    contact: { external_id: 'external-c', name: 'Imported' },
  };
  await receive(db, t.integration, inbound);
  await receive(db, t.integration, {
    ...inbound,
    external_id: 'ext-update',
    occurred_at: new Date(Date.now() + 1000).toISOString(),
    contact: { ...inbound.contact, name: 'Imported updated' },
  });
  assert.equal(await db.outboundDelivery.count({ where: { organizationId: t.organizationId } }), 1);
});
test('failed outbound deliveries remain dead and audited; manual retry keeps attempt history', async () => {
  const t = await fixture();
  const endpoint = await t.service.createEndpoint({
    name: 'Test',
    url: 'https://hooks.zapier.com/hooks/catch/2/secret/',
    events: ['agent.handoff_created'],
  });
  const testEvent = await t.service.endpoint(endpoint.id, 'test');
  let now = new Date(Date.now() + 1000);
  for (let i = 0; i < 8; i++) {
    await deliverOnce(db, () => Promise.resolve(500), now, t.organizationId);
    const row = await db.outboundDelivery.findUniqueOrThrow({ where: { id: testEvent.id } });
    now = new Date(row.availableAt.getTime() + 1);
  }
  assert.equal(
    (await db.outboundDelivery.findUniqueOrThrow({ where: { id: testEvent.id } })).status,
    'dead',
  );
  await t.service.retry(testEvent.id);
  await deliverOnce(db, () => Promise.resolve(200), new Date(Date.now() + 1000), t.organizationId);
  assert.equal(
    await db.outboundAttempt.count({
      where: { organizationId: t.organizationId, deliveryId: testEvent.id },
    }),
    9,
  );
  const b = await fixture();
  await assert.rejects(b.service.retry(testEvent.id));
  await assert.rejects(
    db.outboundDelivery.create({
      data: {
        organizationId: b.organizationId,
        endpointId: endpoint.id,
        deduplicationKey: 'cross',
        payload: {},
      },
    }),
  );
});
test('canonical agent facts enqueue once and never fabricate a send or recovery result', async () => {
  const t = await fixture();
  await t.api(bundle());
  const opportunity = await db.opportunity.findFirstOrThrow({
    where: { organizationId: t.organizationId },
  });
  await t.service.createEndpoint({
    name: 'Agent events',
    url: 'https://hooks.zapier.com/hooks/catch/3/secret/',
    events: ['agent.handoff_created', 'agent.action_completed'],
  });
  await tenantTransaction(db, t.organizationId, (tx) =>
    publishAgentFact(
      tx,
      t.organizationId,
      'test',
      'agent.handoff_created',
      opportunity.id,
      'action-1',
      { actionId: 'action-1', deliveryStatus: 'not_sent' },
    ),
  );
  const queued = await db.outboundDelivery.findMany({
    where: { organizationId: t.organizationId },
  });
  assert.equal(queued.length, 1);
  assert.ok(JSON.stringify(queued[0]!.payload).includes('not_sent'));
});
test('organization admin UI is scoped, CSRF protected, and exposes generated keys only once', async () => {
  const t = await fixture();
  const auth = `Basic ${Buffer.from(`organization:${t.org.token}`).toString('base64')}`;
  const page = await fetch(`${base}/integrations`, { headers: { authorization: auth } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('Integrations'));
  assert.ok(!html.includes(t.credential.token));
  assert.ok(!html.includes(t.org.token));
  const rejected = await fetch(`${base}/integrations/connections`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'name=Unsafe&provider=zapier',
  });
  assert.equal(rejected.status, 403);
  const csrf = html.match(
    /action="\/integrations\/connections"[^>]*>\s*<input type="hidden" name="csrf" value="([^"]+)"/,
  )?.[1];
  assert.ok(csrf);
  const response = await fetch(`${base}/integrations/connections`, {
    method: 'POST',
    headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ name: 'UI connection', provider: 'zapier', csrf }),
  });
  assert.equal(response.status, 200);
  const generated = (await response.text()).match(/ssw_[a-f0-9]{64}/)?.[0];
  assert.ok(generated);
  assert.ok(
    !(
      await (await fetch(`${base}/integrations`, { headers: { authorization: auth } })).text()
    ).includes(generated),
  );
  const member = await db.organizationMember.create({
    data: { organizationId: t.organizationId, subject: randomUUID(), role: 'member' },
  });
  const key = await db.$transaction((tx) =>
    issueCredential(tx, t.organizationId, { membershipId: member.id }, ['integrations:write']),
  );
  assert.equal(
    (await fetch(`${base}/integrations`, { headers: { authorization: `Bearer ${key.token}` } }))
      .status,
    403,
  );
});
test('distributed organization rate limit persists across callers and resets next window', async () => {
  const t = await fixture();
  const now = new Date('2026-09-08T00:00:00Z');
  await Promise.all(
    Array.from({ length: 120 }, () => organizationLimit(db, t.organizationId, now)),
  );
  await assert.rejects(
    organizationLimit(db, t.organizationId, now),
    (err: unknown) => err instanceof WorkforceError && err.status === 429,
  );
  await organizationLimit(db, t.organizationId, new Date(now.getTime() + 60000));
});

test('worker pause, concurrent claims, lease recovery and endpoint disable retain delivery evidence', async () => {
  const t = await fixture();
  const endpoint = await t.service.createEndpoint({
    name: 'Lease test',
    url: 'https://hooks.zapier.com/hooks/catch/4/fixture/',
    events: ['contact.updated'],
  });
  const queued = await t.service.endpoint(endpoint.id, 'test');
  let sends = 0;
  const transport = () => {
    sends++;
    return Promise.resolve(200);
  };
  process.env.WEBHOOK_DELIVERY_ENABLED = 'false';
  try {
    assert.equal(await deliverOnce(db, transport, new Date(), t.organizationId), false);
  } finally {
    process.env.WEBHOOK_DELIVERY_ENABLED = 'true';
  }
  assert.equal(sends, 0);
  const claimed = await Promise.all([
    deliverOnce(db, transport, new Date(Date.now() + 1000), t.organizationId),
    deliverOnce(db, transport, new Date(Date.now() + 1000), t.organizationId),
  ]);
  assert.deepEqual(claimed.sort(), [false, true]);
  assert.equal(sends, 1);
  assert.equal(
    (await db.outboundDelivery.findUniqueOrThrow({ where: { id: queued.id } })).status,
    'succeeded',
  );
  const crashed = await t.service.endpoint(endpoint.id, 'test');
  await db.outboundDelivery.update({
    where: { id: crashed.id },
    data: {
      status: 'running',
      attempts: 1,
      leaseToken: randomUUID(),
      leasedUntil: new Date(Date.now() - 1000),
    },
  });
  await deliverOnce(db, transport, new Date(), t.organizationId);
  const history = await db.outboundAttempt.findMany({
    where: { organizationId: t.organizationId, deliveryId: crashed.id },
    orderBy: { attempt: 'asc' },
  });
  assert.equal(history[0]?.errorCode, 'lease_expired_outcome_unknown');
  assert.equal(history[1]?.statusCode, 200);
  const disabled = await t.service.endpoint(endpoint.id, 'test');
  await t.service.endpoint(endpoint.id, 'disable');
  await deliverOnce(db, transport, new Date(Date.now() + 1000), t.organizationId);
  assert.equal(sends, 2);
  assert.equal(
    (await db.outboundDelivery.findUniqueOrThrow({ where: { id: disabled.id } })).lastErrorCode,
    'endpoint_disabled',
  );
});

test('historical opportunity imports preserve source activity time for recovery eligibility', async () => {
  const t = await fixture();
  const body = bundle();
  body.occurred_at = new Date(Date.now() - 30 * 86400000).toISOString();
  assert.equal((await t.api(body)).status, 202);
  const opportunity = await db.opportunity.findFirstOrThrow({
    where: { organizationId: t.organizationId },
  });
  assert.equal(opportunity.lastActivityAt.toISOString(), body.occurred_at);
});
