/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import test, { before, after } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import { authenticate, provisionOrganization } from '../workforce/tenancy/service.js';
import { ingestEvent } from '../workforce/events/service.js';
import { WorkforceError } from '../workforce/shared.js';
import { CrmService } from './service.js';

requireDemoTestDatabase();
process.env.WORKFORCE_ENABLED = 'true';
process.env.CRM_ENABLED = 'true';
process.env.ADMIN_USERNAME = 'crm-test';
process.env.ADMIN_PASSWORD = 'crm-test-password';
process.env.WORKFORCE_WORKER_ENABLED = 'false';
process.env.LOG_LEVEL = 'silent';
let db: PrismaClient;
let server: Server;
let base: string;
const basic = `Basic ${Buffer.from('crm-test:crm-test-password').toString('base64')}`;
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
  if (server?.listening)
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  if (db) await db.$disconnect();
});
async function fixture() {
  const tenant = await provisionOrganization(
    db,
    { name: `CRM test ${randomUUID()}`, ownerSubject: `crm-test:${randomUUID()}` },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${tenant.token}`);
  return {
    ...tenant,
    principal,
    crm: new CrmService(db, principal),
    organizationId: tenant.organization.id,
  };
}
async function pipeline(crm: CrmService) {
  const p = await crm.create('pipelines', { name: 'Service projects' });
  const open = await crm.create('stages', {
    name: 'Consultation pending',
    pipelineId: p.id,
    position: 0,
  });
  const won = await crm.create('stages', {
    name: 'Engagement secured',
    pipelineId: p.id,
    position: 1,
    outcome: 'won',
  });
  return { p, open, won };
}
async function deal(crm: CrmService) {
  const stages = await pipeline(crm);
  const contact = await crm.create('contacts', { name: 'Taylor' });
  const opportunity = await crm.create('opportunities', {
    title: 'Service agreement',
    customerId: contact.id,
    pipelineId: stages.p.id,
    stageId: stages.open.id,
    amountMinor: 125000,
    currency: 'USD',
  });
  return { ...stages, contact, opportunity };
}
function code(expected: string) {
  return (err: unknown) => err instanceof WorkforceError && err.code === expected;
}
async function api(token: string, path: string, method = 'GET', body?: unknown) {
  return fetch(`${base}/api/workforce/crm${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('contact CRUD uses canonical identity, versions, audit, timeline and outbox atomically', async () => {
  const t = await fixture();
  const contact = await t.crm.create('contacts', { name: 'Taylor', email: 'TAYLOR@example.test' });
  assert.equal(contact.source, null);
  assert.equal(contact.externalId, null);
  assert.equal(contact.record.entityType, 'contact');
  assert.equal(contact.record.version, 1);
  assert.equal(contact.email, 'taylor@example.test');
  const updated = await t.crm.update('contacts', contact.id, {
    name: 'Taylor Smith',
    expectedVersion: 1,
  });
  assert.equal(updated.record.version, 2);
  await assert.rejects(
    t.crm.update('contacts', contact.id, { name: 'Stale', expectedVersion: 1 }),
    code('record_version_conflict'),
  );
  const detail = await t.crm.detail('contacts', contact.id);
  assert.equal(detail.activity.length, 2);
  assert.equal(await db.workforceJob.count({ where: { organizationId: t.organizationId } }), 2);
  assert.equal(
    await db.auditLog.count({ where: { organizationId: t.organizationId, subjectId: contact.id } }),
    2,
  );
  await t.crm.archive('contacts', contact.id, 2);
  assert.deepEqual(await t.crm.list('contacts'), []);
  assert.ok(
    await db.contact.findUnique({
      where: { organizationId_id: { organizationId: t.organizationId, id: contact.id } },
    }),
  );
});
test('tenant isolation rejects reads, updates, archives, references and assignment in services and SQL', async () => {
  const a = await fixture();
  const b = await fixture();
  const contact = await a.crm.create('contacts', { name: 'Private A' });
  const company = await a.crm.create('companies', { name: 'Company A' });
  const member = (await a.crm.members())[0]!;
  assert.deepEqual(await b.crm.list('contacts'), []);
  await assert.rejects(b.crm.detail('contacts', contact.id), code('record_not_found'));
  await assert.rejects(
    b.crm.update('contacts', contact.id, { name: 'No', expectedVersion: 1 }),
    code('record_not_found'),
  );
  await assert.rejects(b.crm.archive('contacts', contact.id, 1), code('record_not_found'));
  await assert.rejects(
    b.crm.create('contacts', { name: 'No', companyId: company.id }),
    code('related_record_not_found'),
  );
  await assert.rejects(
    b.crm.create('contacts', { name: 'No', assignedMemberId: member.id }),
    code('assignee_not_found'),
  );
  assert.equal(await db.contact.count({ where: { organizationId: b.organizationId } }), 0);
  await assert.rejects(
    db.contact.create({
      data: { organizationId: b.organizationId, name: 'SQL bypass', companyId: company.id },
    }),
  );
  await assert.rejects(
    db.crmRecord.update({
      where: { id: contact.id },
      data: { assignedMemberId: (await b.crm.members())[0]!.id },
    }),
  );
  await assert.rejects(
    db.businessEventLink.create({
      data: {
        organizationId: b.organizationId,
        eventId: (await a.crm.detail('contacts', contact.id)).activity[0]!.id,
        recordId: contact.id,
      },
    }),
  );
});
test('concurrent changes cannot both commit the same record version', async () => {
  const t = await fixture();
  const c = await t.crm.create('contacts', { name: 'Original' });
  const results = await Promise.allSettled([
    t.crm.update('contacts', c.id, { name: 'First', expectedVersion: 1 }),
    t.crm.update('contacts', c.id, { name: 'Second', expectedVersion: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const failed = results.find((r) => r.status === 'rejected');
  assert.ok(failed?.status === 'rejected');
  assert.ok(code('record_version_conflict')(failed.reason));
  assert.equal((await t.crm.detail('contacts', c.id)).entity.record.version, 2);
});
test('opportunities belong to a contact and a matching custom pipeline/stage', async () => {
  const t = await fixture();
  const other = await fixture();
  const d = await deal(t.crm);
  const foreign = await pipeline(other.crm);
  const second = await pipeline(t.crm);
  assert.equal(d.opportunity.status, 'open');
  await assert.rejects(
    t.crm.update('opportunities', d.opportunity.id, {
      stageId: foreign.open.id,
      expectedVersion: 1,
    }),
    code('related_record_not_found'),
  );
  await assert.rejects(
    t.crm.update('opportunities', d.opportunity.id, {
      stageId: second.open.id,
      expectedVersion: 1,
    }),
    code('stage_pipeline_mismatch'),
  );
  await assert.rejects(
    db.opportunity.update({ where: { id: d.opportunity.id }, data: { stageId: second.open.id } }),
  );
  const won = await t.crm.update('opportunities', d.opportunity.id, {
    stageId: d.won.id,
    expectedVersion: 1,
  });
  assert.equal(won.status, 'won');
  assert.equal(won.record.version, 2);
  assert.equal((await t.crm.detail('contacts', d.contact.id)).opportunities[0]!.id, won.id);
  await assert.rejects(
    t.crm.update('stages', d.won.id, { outcome: 'open', expectedVersion: 1 }),
    code('stage_outcome_in_use'),
  );
  await assert.rejects(t.crm.archive('stages', d.won.id, 1), code('record_has_active_dependents'));
});
test('pipeline stage reorder is complete, scoped, deterministic and versioned', async () => {
  const t = await fixture();
  const d = await pipeline(t.crm);
  await assert.rejects(
    t.crm.reorderStages(d.p.id, { stageIds: [d.open.id], expectedVersion: 1 }),
    code('stage_order_must_include_all_active_stages'),
  );
  const ordered = await t.crm.reorderStages(d.p.id, {
    stageIds: [d.won.id, d.open.id],
    expectedVersion: 1,
  });
  assert.equal(ordered.find((s) => s.id === d.won.id)?.position, 0);
  assert.equal(ordered.find((s) => s.id === d.open.id)?.position, 1);
  assert.equal((await t.crm.detail('pipelines', d.p.id)).entity.record.version, 2);
  await assert.rejects(
    t.crm.reorderStages(d.p.id, { stageIds: [d.open.id, d.won.id], expectedVersion: 1 }),
    code('record_version_conflict'),
  );
});
test('external mappings are connection-scoped, typed, idempotent and independent of native IDs', async () => {
  const a = await fixture();
  const b = await fixture();
  const d = await deal(a.crm);
  const c1 = await a.crm.createConnection({ name: 'Jobber office one', provider: 'jobber' });
  const c2 = await a.crm.createConnection({ name: 'Jobber office two', provider: 'jobber' });
  const input = {
    connectionId: c1.id,
    externalRecordType: 'opportunity',
    externalId: '123',
    internalEntityType: 'opportunity' as const,
    internalEntityId: d.opportunity.id,
  };
  const mapping = await a.crm.mapExternal(input);
  assert.equal(mapping.id, (await a.crm.mapExternal(input)).id);
  assert.equal(mapping.provider, 'jobber');
  assert.notEqual(mapping.internalEntityId, '123');
  await assert.rejects(
    a.crm.mapExternal({ ...input, internalEntityType: 'contact', internalEntityId: d.contact.id }),
    code('external_mapping_conflict'),
  );
  assert.notEqual(mapping.id, (await a.crm.mapExternal({ ...input, connectionId: c2.id })).id);
  await assert.rejects(b.crm.mapExternal(input), code('connection_not_found'));
  await assert.rejects(
    a.crm.mapExternal({ ...input, internalEntityType: 'contact' }),
    code('related_record_not_found'),
  );
  await assert.rejects(
    db.externalRecordMapping.create({
      data: { ...input, organizationId: b.organizationId, provider: 'jobber' },
    }),
  );
  await assert.rejects(
    db.externalRecordMapping.create({
      data: { ...input, organizationId: a.organizationId, provider: 'ghl', externalId: 'bad' },
    }),
  );
  assert.deepEqual(await b.crm.mappings(), []);
  await assert.rejects(b.crm.unmapExternal(mapping.id), code('mapping_not_found'));
  await a.crm.unmapExternal(mapping.id);
  assert.equal((await a.crm.mappings()).length, 1);
});
test('custom field definitions and values are tenant/type scoped with atomic required validation', async () => {
  const a = await fixture();
  const b = await fixture();
  const field = await a.crm.createField({
    entityType: 'contact',
    key: 'service_segment',
    label: 'Service segment',
    fieldType: 'single_select',
    options: ['Residential', 'Commercial'],
    required: true,
  });
  await assert.rejects(
    a.crm.create('contacts', { name: 'Missing' }),
    code('required_custom_field'),
  );
  assert.equal(await db.contact.count({ where: { organizationId: a.organizationId } }), 0);
  const c = await a.crm.create('contacts', {
    name: 'Alex',
    customFields: { [field.id]: 'Commercial' },
  });
  assert.equal((await a.crm.detail('contacts', c.id)).customFields[0]!.value, 'Commercial');
  await assert.rejects(
    a.crm.update('contacts', c.id, { expectedVersion: 1, customFields: { [field.id]: 'Unknown' } }),
    code('invalid_custom_field_value'),
  );
  await assert.rejects(
    a.crm.update('contacts', c.id, { expectedVersion: 1, customFields: { [field.id]: null } }),
    code('required_custom_field'),
  );
  await assert.rejects(
    b.crm.create('contacts', { name: 'Wrong tenant', customFields: { [field.id]: 'Commercial' } }),
    code('custom_field_not_defined_for_record'),
  );
  const company = await a.crm.create('companies', { name: 'Company' });
  await assert.rejects(
    db.customFieldValue.create({
      data: {
        organizationId: a.organizationId,
        definitionId: field.id,
        recordId: company.id,
        entityType: 'contact',
        fieldType: 'single_select',
        value: 'Commercial',
      },
    }),
  );
  assert.equal((await a.crm.detail('contacts', c.id)).entity.record.version, 1);
  await a.crm.updateField(field.id, { archived: true });
  assert.equal((await a.crm.detail('contacts', c.id)).customFields.length, 1);
  assert.equal((await a.crm.fields()).length, 0);
});
test('tags, employees, tasks and notes use the shared scoped record identity', async () => {
  const t = await fixture();
  const b = await fixture();
  const employee = await t.crm.addMember({ name: 'Sam', role: 'member' });
  const tag = await t.crm.create('tags', { name: 'Priority' });
  const contact = await t.crm.create('contacts', {
    name: 'Alex',
    assignedMemberId: employee.id,
    tagIds: [tag.id],
  });
  assert.equal(contact.record.assignedMemberId, employee.id);
  assert.equal((await t.crm.detail('contacts', contact.id)).tags[0]!.tagId, tag.id);
  await t.crm.create('notes', { relatedRecordId: contact.id, body: 'Consultation discussed' });
  const task = await t.crm.create('tasks', {
    title: 'Prepare proposal',
    relatedRecordId: contact.id,
    assignedMemberId: employee.id,
  });
  const done = await t.crm.update('tasks', task.id, { status: 'completed', expectedVersion: 1 });
  assert.ok(done.completedAt instanceof Date);
  const activity = (await t.crm.detail('contacts', contact.id)).activity;
  assert.equal(activity.length, 5);
  assert.equal(activity.filter((e) => e.type === 'task.completed').length, 1);
  await assert.rejects(
    b.crm.updateMember(employee.id, { active: false }),
    code('member_not_found'),
  );
  const owner = (await t.crm.members()).find((m) => m.role === 'owner')!;
  await assert.rejects(
    t.crm.updateMember(owner.id, { active: false }),
    code('last_owner_required'),
  );
  await t.crm.updateMember(employee.id, { active: false });
  await assert.rejects(
    t.crm.create('tasks', { title: 'No', assignedMemberId: employee.id }),
    code('assignee_not_found'),
  );
});
test('estimates, appointments, conversations and messages enforce domain rules', async () => {
  const t = await fixture();
  const d = await deal(t.crm);
  const estimate = await t.crm.create('estimates', {
    title: 'Annual service',
    number: 'Q-1',
    opportunityId: d.opportunity.id,
    amountMinor: 125000,
    currency: 'USD',
    status: 'accepted',
  });
  assert.ok(estimate.acceptedAt instanceof Date);
  await assert.rejects(
    t.crm.create('estimates', {
      title: 'Wrong',
      number: 'Q-2',
      opportunityId: d.opportunity.id,
      amountMinor: 10,
      currency: 'EUR',
    }),
    code('estimate_currency_mismatch'),
  );
  await assert.rejects(
    t.crm.create('appointments', {
      title: 'Consultation',
      contactId: d.contact.id,
      startsAt: '2030-01-01T16:00:00Z',
      endsAt: '2030-01-01T15:00:00Z',
      timezone: 'America/New_York',
    }),
    code('appointment_date_order'),
  );
  await t.crm.create('appointments', {
    title: 'Consultation',
    contactId: d.contact.id,
    opportunityId: d.opportunity.id,
    startsAt: '2030-01-01T15:00:00Z',
    endsAt: '2030-01-01T16:00:00Z',
    timezone: 'America/New_York',
  });
  const conv = await t.crm.create('conversations', {
    contactId: d.contact.id,
    subject: 'Service question',
    channel: 'email',
  });
  const message = await t.crm.create('messages', {
    conversationId: conv.id,
    direction: 'inbound',
    body: 'Can we discuss?',
    occurredAt: new Date().toISOString(),
  });
  await assert.rejects(
    t.crm.update('messages', message.id, { body: 'Alter history', expectedVersion: 1 }),
    code('message_is_immutable'),
  );
  await assert.rejects(
    t.crm.archive('contacts', d.contact.id, 1),
    code('record_has_active_dependents'),
  );
});
test('mapped webhook updates canonical contacts without creating duplicate customers and respects native edits', async () => {
  const t = await fixture();
  const c = await t.crm.create('contacts', { name: 'Native contact' });
  const conn = await t.crm.createConnection({ name: 'Zapier', provider: 'zapier' });
  await t.crm.mapExternal({
    connectionId: conn.id,
    externalRecordType: 'customer',
    externalId: 'crm-contact-1',
    internalEntityType: 'contact',
    internalEntityId: c.id,
  });
  const event = {
    id: randomUUID(),
    version: 1 as const,
    occurredAt: new Date(Date.now() - 1000).toISOString(),
    type: 'customer.upserted' as const,
    data: { externalId: 'crm-contact-1', name: 'External name' },
  };
  await ingestEvent(db, t.organizationId, conn.id, 'test', event);
  assert.equal((await t.crm.detail('contacts', c.id)).entity.name, 'External name');
  assert.equal((await t.crm.list('contacts')).length, 1);
  await t.crm.update('contacts', c.id, { name: 'Native correction', expectedVersion: 2 });
  await ingestEvent(db, t.organizationId, conn.id, 'test', {
    ...event,
    id: randomUUID(),
    occurredAt: new Date(Date.now() - 500).toISOString(),
    data: { ...event.data, name: 'Late delivery' },
  });
  assert.equal((await t.crm.detail('contacts', c.id)).entity.name, 'Native correction');
});
test('CRM API enforces feature flags, bearer tenant context, validation, roles and bounded reads', async () => {
  const a = await fixture();
  const b = await fixture();
  const c = await a.crm.create('contacts', { name: 'Private A' });
  process.env.CRM_ENABLED = 'false';
  assert.equal((await api(a.token, '/contacts')).status, 404);
  process.env.CRM_ENABLED = 'true';
  assert.equal((await fetch(`${base}/api/workforce/crm/contacts`)).status, 401);
  assert.equal((await api(b.token, `/contacts/${c.id}`)).status, 404);
  assert.equal(
    (await api(b.token, `/contacts/${c.id}`, 'PATCH', { name: 'No', expectedVersion: 1 })).status,
    404,
  );
  assert.equal(
    (await api(b.token, '/contacts', 'POST', { name: 'No', organizationId: a.organizationId }))
      .status,
    400,
  );
  assert.equal((await api(a.token, '/contacts', 'POST', { name: 'API contact' })).status, 201);
  const viewer = new CrmService(db, { ...a.principal, role: 'viewer' });
  await assert.rejects(viewer.create('contacts', { name: 'No' }), code('forbidden'));
  const member = new CrmService(db, { ...a.principal, role: 'member' });
  await assert.rejects(member.create('pipelines', { name: 'No' }), code('admin_required'));
  await db.workforceCredential.update({
    where: { id: a.principal.credentialId },
    data: { revokedAt: new Date() },
  });
  await assert.rejects(
    a.crm.create('contacts', { name: 'Revoked principal' }),
    code('credential_changed'),
  );
});
test('admin CRM pages escape content, isolate context and require path-bound CSRF', async () => {
  const a = await fixture();
  const b = await fixture();
  const c = await a.crm.create('contacts', { name: '<script>alert(1)</script>' });
  const path = `/admin/crm/${a.organizationId}/contacts/${c.id}`;
  assert.equal((await fetch(`${base}${path}`)).status, 401);
  const response = await fetch(`${base}${path}`, { headers: { authorization: basic } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control')!, /no-store/);
  const html = await response.text();
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.equal(
    (
      await fetch(`${base}/admin/crm/${b.organizationId}/contacts/${c.id}`, {
        headers: { authorization: basic },
      })
    ).status,
    404,
  );
  const token = html.match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(token);
  const post = (csrf: string) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      redirect: 'manual',
      headers: { authorization: basic, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf, expectedVersion: '1', name: 'Safe edit' }),
    });
  assert.equal((await post('invalid')).status, 403);
  assert.equal((await post(token)).status, 303);
  assert.equal((await a.crm.detail('contacts', c.id)).entity.name, 'Safe edit');
});
