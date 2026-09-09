/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registrations. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import test, { before, after } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import { defaultRecoveryConfig } from './agents/config.js';
import {
  authenticate,
  issueCredential,
  provisionOrganization,
  tokenHash,
  type Principal,
} from './tenancy/service.js';
import { ingestEvent } from './events/service.js';
import { claimJob, processJob, workOnce } from './jobs/queue.js';
import { scheduleRecoveryScans } from './jobs/scheduler.js';
import { decideApproval } from './approvals/service.js';
import { recordRevenue } from './revenue/service.js';
import { hash, json } from './shared.js';

// No dotenv/app import or DB operation until an explicit disposable loopback DB is verified.
requireDemoTestDatabase();
process.env.WORKFORCE_ENABLED = 'true';
process.env.ADMIN_USERNAME = 'workforce-test';
process.env.ADMIN_PASSWORD = 'workforce-test-password';
let db: PrismaClient;
let server: Server;
let base: string;
const at = new Date(Date.now() - 1000).toISOString();
const old = new Date(Date.now() - 30 * 86_400_000).toISOString();

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
      server.close((error) => (error ? reject(error) : resolve())),
    );
  if (db) await db.$disconnect();
});

async function fixture() {
  const provisioned = await provisionOrganization(
    db,
    { name: `Test ${randomUUID()}`, ownerSubject: `test:${randomUUID()}` },
    'test_operator',
  );
  const actor = await authenticate(db, `Bearer ${provisioned.token}`);
  return { ...provisioned, actor, organizationId: provisioned.organization.id };
}
async function customer(organizationId: string, source = 'internal', externalId = 'c1') {
  return ingestEvent(db, organizationId, source, 'test', {
    id: `customer:${externalId}`,
    version: 1,
    occurredAt: at,
    type: 'customer.upserted',
    data: { externalId, name: 'Fictional Customer' },
  });
}
async function opportunity(
  organizationId: string,
  externalId = 'o1',
  status: 'open' | 'won' | 'lost' | 'estimate_sent' = 'estimate_sent',
) {
  return ingestEvent(db, organizationId, 'internal', 'test', {
    id: `opportunity:${externalId}`,
    version: 1,
    occurredAt: at,
    type: 'opportunity.upserted',
    data: {
      externalId,
      customerExternalId: 'c1',
      title: 'Fictional estimate',
      status,
      amountMinor: 125000,
      currency: 'USD',
      lastActivityAt: old,
    },
  });
}
async function agent(organizationId: string) {
  return db.workforceAgent.create({
    data: {
      organizationId,
      name: 'Recovery',
      description: 'Review stale estimates',
      config: json(defaultRecoveryConfig),
      enabled: true,
    },
  });
}
async function drain() {
  for (let i = 0; i < 500; i++) {
    if (!(await workOnce(db))) return;
  }
  throw new Error('Queue did not drain');
}
async function ready() {
  const tenant = await fixture();
  await customer(tenant.organizationId);
  const opp = await opportunity(tenant.organizationId);
  const recoveryAgent = await agent(tenant.organizationId);
  await drain();
  const approval = await db.workforceApproval.findFirstOrThrow({
    where: { organizationId: tenant.organizationId },
    include: { action: true },
  });
  return { ...tenant, opp, recoveryAgent, approval };
}
async function api(path: string, token: string, method = 'GET', body?: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('flag disables the whole API; auth, JSON and browser origin fail closed', async () => {
  process.env.WORKFORCE_ENABLED = 'false';
  assert.equal((await fetch(`${base}/customers`)).status, 404);
  process.env.WORKFORCE_ENABLED = 'true';
  assert.equal((await fetch(`${base}/customers`)).status, 401);
  assert.equal((await fetch(`${base}/organizations`, { method: 'POST' })).status, 415);
  assert.equal(
    (
      await fetch(`${base}/organizations`, {
        method: 'POST',
        headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${base}/organizations`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    401,
  );
});

test('operator bootstrap creates an independent organization; tokens are hashed and expire', async () => {
  const response = await fetch(`${base}/organizations`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from('workforce-test:workforce-test-password').toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ name: 'No CRM Required', ownerSubject: `test:${randomUUID()}` }),
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as {
    token: string;
    organization: { id: string; legacyClientId: string | null };
    credentialId: string;
  };
  assert.equal(result.organization.legacyClientId, null);
  const credential = await db.workforceCredential.findUniqueOrThrow({
    where: { id: result.credentialId },
  });
  assert.equal(credential.tokenHash, tokenHash(result.token));
  assert.ok(!JSON.stringify(credential).includes(result.token));
  await assert.rejects(
    authenticate(db, `Bearer ${result.token}`, new Date(Date.now() + 91 * 86_400_000)),
  );
  assert.equal((await api('/organization', result.token)).status, 200);
});

test('CRM and audit reads are scoped; cross-tenant references fail at the database', async () => {
  const a = await fixture();
  const b = await fixture();
  const c = await customer(a.organizationId);
  const response = await api('/customers', b.token);
  assert.deepEqual(await response.json(), []);
  await assert.rejects(
    db.opportunity.create({
      data: {
        organizationId: b.organizationId,
        customerId: c.entityId!,
        source: 'internal',
        externalId: 'spoof',
        title: 'Spoof',
        status: 'open',
        amountMinor: 1,
        currency: 'USD',
        lastActivityAt: new Date(),
        sourceOccurredAt: new Date(),
      },
    }),
    /Foreign key constraint/,
  );
  const auditResponse = await api('/audit', b.token);
  const audits = (await auditResponse.json()) as Array<{ organizationId: string }>;
  assert.ok(audits.every((row) => row.organizationId === b.organizationId));
});

test('webhook credential can ingest only its own integration and cannot read CRM or grant approvals', async () => {
  const a = await fixture();
  const b = await fixture();
  const integrationResponse = await api('/integrations', a.token, 'POST', {
    name: 'Zapier',
    provider: 'zapier',
  });
  assert.equal(integrationResponse.status, 201);
  const integration = (await integrationResponse.json()) as {
    token: string;
    credentialId: string;
    integration: { id: string };
  };
  const body = {
    id: 'zap-1',
    version: 1,
    occurredAt: at,
    type: 'customer.upserted',
    data: { externalId: 'c1', name: 'Zap Customer' },
  };
  assert.equal(
    (await api(`/webhooks/${integration.integration.id}`, integration.token, 'POST', body)).status,
    202,
  );
  assert.equal(
    (await api(`/webhooks/${integration.integration.id}`, integration.token, 'POST', body)).status,
    200,
  );
  assert.equal(
    (await api(`/webhooks/${randomUUID()}`, integration.token, 'POST', body)).status,
    403,
  );
  assert.equal(
    (await api(`/webhooks/${integration.integration.id}`, b.token, 'POST', body)).status,
    403,
  );
  assert.equal((await api('/customers', integration.token)).status, 403);
  assert.equal((await api('/agents', integration.token, 'POST', {})).status, 403);
  assert.equal(
    (
      await api(`/webhooks/${integration.integration.id}`, integration.token, 'POST', {
        ...body,
        organizationId: b.organizationId,
      })
    ).status,
    400,
  );
  assert.equal(
    (await api(`/credentials/${integration.credentialId}/revoke`, a.token, 'POST', {})).status,
    204,
  );
  assert.equal(
    (await api(`/webhooks/${integration.integration.id}`, integration.token, 'POST', body)).status,
    401,
  );
});

test('concurrent delivery creates one event, CRM row and outbox job; changed replay returns conflict', async () => {
  const a = await fixture();
  const results = await Promise.all(Array.from({ length: 8 }, () => customer(a.organizationId)));
  assert.equal(results.filter((row) => !row.duplicate).length, 1);
  assert.equal(await db.contact.count({ where: { organizationId: a.organizationId } }), 1);
  assert.equal(await db.businessEvent.count({ where: { organizationId: a.organizationId } }), 1);
  assert.equal(await db.workforceJob.count({ where: { organizationId: a.organizationId } }), 1);
  await assert.rejects(
    ingestEvent(db, a.organizationId, 'internal', 'test', {
      id: 'customer:c1',
      version: 1,
      occurredAt: at,
      type: 'customer.upserted',
      data: { externalId: 'c1', name: 'Changed' },
    }),
    /event_id_reused/,
  );
});

test('missing customer rolls back the entire intake and permits a corrected retry', async () => {
  const a = await fixture();
  await assert.rejects(opportunity(a.organizationId), /customer_must_be_imported_first/);
  assert.equal(await db.businessEvent.count({ where: { organizationId: a.organizationId } }), 0);
  assert.equal(await db.workforceJob.count({ where: { organizationId: a.organizationId } }), 0);
  await customer(a.organizationId);
  await opportunity(a.organizationId);
});

test('older observations cannot overwrite newer CRM data; suppression cannot be cleared by import', async () => {
  const a = await fixture();
  await customer(a.organizationId);
  await ingestEvent(db, a.organizationId, 'internal', 'test', {
    id: 'suppress',
    version: 1,
    occurredAt: new Date().toISOString(),
    type: 'customer.upserted',
    data: { externalId: 'c1', name: 'Suppressed', doNotContact: true },
  });
  const stale = await ingestEvent(db, a.organizationId, 'internal', 'test', {
    id: 'old',
    version: 1,
    occurredAt: old,
    type: 'customer.upserted',
    data: { externalId: 'c1', name: 'Old', doNotContact: false },
  });
  assert.equal(stale.applied, false);
  await ingestEvent(db, a.organizationId, 'internal', 'test', {
    id: 'new',
    version: 1,
    occurredAt: new Date(Date.now() + 1000).toISOString(),
    type: 'customer.upserted',
    data: { externalId: 'c1', name: 'Current', doNotContact: false },
  });
  const row = await db.contact.findFirstOrThrow({
    where: { organizationId: a.organizationId },
  });
  assert.equal(row.name, 'Current');
  assert.equal(row.doNotContact, true);
});

test('worker recovery and competing claims are fenced; expired leases cannot complete another worker job', async () => {
  await drain();
  const a = await fixture();
  await customer(a.organizationId);
  const now = new Date();
  const claims = await Promise.all([claimJob(db, now), claimJob(db, now)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const original = claims.find((row) => row !== null)!;
  const reclaimed = await claimJob(db, new Date(now.getTime() + 61_000));
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseToken, original.leaseToken);
  await processJob(db, original, now);
  assert.equal(
    (await db.workforceJob.findUniqueOrThrow({ where: { id: original.id } })).status,
    'running',
  );
  await processJob(db, reclaimed, new Date(now.getTime() + 62_000));
  assert.equal(
    (await db.workforceJob.findUniqueOrThrow({ where: { id: original.id } })).status,
    'completed',
  );
});

test('evaluation failure rolls back decisions and backs off until dead-letter; exhausted crashed leases terminate', async () => {
  await drain();
  const a = await fixture();
  await customer(a.organizationId);
  await opportunity(a.organizationId);
  await db.workforceAgent.create({
    data: {
      organizationId: a.organizationId,
      name: 'Bad',
      description: 'Bad config',
      enabled: true,
      config: {},
    },
  });
  await drain();
  const retry = await db.workforceJob.findFirstOrThrow({
    where: { organizationId: a.organizationId, status: 'pending' },
  });
  assert.equal(retry.attempts, 1);
  assert.equal(retry.lastErrorCode, 'evaluation_failed');
  assert.equal(await db.workforceRun.count({ where: { organizationId: a.organizationId } }), 0);
  await db.workforceJob.update({
    where: { id: retry.id },
    data: { attempts: 5, availableAt: new Date() },
  });
  const finalClaim = await claimJob(db);
  assert.ok(finalClaim);
  await processJob(db, finalClaim);
  assert.equal(
    (await db.workforceJob.findUniqueOrThrow({ where: { id: retry.id } })).status,
    'dead',
  );
});

test('recovery proposes only one follow-up per opportunity, persists decisions, and approval creates an unsent handoff', async () => {
  const a = await ready();
  await agent(a.organizationId);
  await scheduleRecoveryScans(db);
  await scheduleRecoveryScans(db);
  await drain();
  assert.equal(await db.workforceAction.count({ where: { organizationId: a.organizationId } }), 1);
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: a.organizationId, source: 'scheduler' },
    }),
    1,
  );
  const results = await Promise.allSettled([
    decideApproval(db, a.actor, a.approval.id, 'approve', 'Reviewed'),
    decideApproval(db, a.actor, a.approval.id, 'approve', 'Reviewed'),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const action = await db.workforceAction.findUniqueOrThrow({ where: { id: a.approval.actionId } });
  assert.equal(action.status, 'completed');
  assert.equal((action.result as { deliveryStatus: string }).deliveryStatus, 'not_sent');
  assert.equal(await db.workforceRevenue.count({ where: { organizationId: a.organizationId } }), 0);
});

test('approval cannot cross tenants or bypass membership roles, expiry, suppression or changed configuration', async () => {
  const a = await ready();
  const b = await fixture();
  await assert.rejects(
    decideApproval(db, b.actor, a.approval.id, 'approve', 'Wrong tenant'),
    /approval_not_found/,
  );
  await assert.rejects(
    decideApproval(db, { ...a.actor, role: 'viewer' }, a.approval.id, 'approve', 'Viewer'),
    /forbidden/,
  );
  await db.contact.updateMany({
    where: { organizationId: a.organizationId },
    data: { doNotContact: true },
  });
  const blocked = await decideApproval(db, a.actor, a.approval.id, 'approve', 'Suppressed');
  assert.equal(blocked.executed, false);
  const c = await ready();
  const expired = await decideApproval(
    db,
    c.actor,
    c.approval.id,
    'approve',
    'Expired',
    new Date(Date.now() + 8 * 86_400_000),
  );
  assert.equal(expired.approval.status, 'expired');
  const d = await ready();
  await db.workforceAgent.update({
    where: { id: d.recoveryAgent.id },
    data: { configVersion: { increment: 1 } },
  });
  assert.equal(
    (await decideApproval(db, d.actor, d.approval.id, 'approve', 'Stale')).executed,
    false,
  );
});

test('closed, fresh and suppressed opportunities are not proposed; operator rejection is terminal', async () => {
  const a = await fixture();
  await customer(a.organizationId);
  await agent(a.organizationId);
  await opportunity(a.organizationId, 'won', 'won');
  await opportunity(a.organizationId, 'lost', 'lost');
  await opportunity(a.organizationId, 'fresh');
  await db.opportunity.updateMany({
    where: { organizationId: a.organizationId, externalId: 'fresh' },
    data: { lastActivityAt: new Date() },
  });
  await drain();
  assert.equal(await db.workforceAction.count({ where: { organizationId: a.organizationId } }), 0);
  const b = await ready();
  assert.equal(
    (await decideApproval(db, b.actor, b.approval.id, 'reject', 'Not suitable')).executed,
    false,
  );
  await assert.rejects(
    decideApproval(db, b.actor, b.approval.id, 'approve', 'Try again'),
    /already_decided/,
  );
});

test('revenue requires a completed action, won opportunity, matching currency and deduplicated payment evidence', async () => {
  const a = await ready();
  const input = {
    actionId: a.approval.actionId,
    opportunityId: a.approval.action.opportunityId,
    externalPaymentId: 'receipt-1',
    amountMinor: 25000,
    currency: 'USD',
    evidence: 'Operator verified invoice receipt',
    paidAt: new Date(),
  };
  await assert.rejects(recordRevenue(db, a.actor, input), /revenue_evidence_conflict/);
  await decideApproval(db, a.actor, a.approval.id, 'approve', 'Reviewed');
  await db.opportunity.update({
    where: { id: input.opportunityId },
    data: { status: 'won' },
  });
  input.paidAt = new Date();
  const first = await recordRevenue(db, a.actor, input);
  assert.equal((await recordRevenue(db, a.actor, input)).id, first.id);
  await assert.rejects(
    recordRevenue(db, a.actor, { ...input, amountMinor: 30000 }),
    /payment_id_reused/,
  );
  await assert.rejects(
    recordRevenue(db, a.actor, { ...input, currency: 'EUR' }),
    /revenue_evidence_conflict/,
  );
  const b = await fixture();
  await assert.rejects(recordRevenue(db, b.actor, input), /action_not_found/);
  assert.equal(await db.workforceRevenue.count({ where: { organizationId: a.organizationId } }), 1);
});

test('credential ownership constraint, role changes and rotation invalidate access', async () => {
  const a = await fixture();
  await assert.rejects(
    db.workforceCredential.create({
      data: {
        organizationId: a.organizationId,
        tokenHash: hash(randomUUID()),
        scopes: [],
        expiresAt: new Date(Date.now() + 1000),
      },
    }),
  );
  const rotated = await api(`/credentials/${a.credentialId}/rotate`, a.token, 'POST', {});
  assert.equal(rotated.status, 201);
  assert.equal((await api('/customers', a.token)).status, 401);
  const newToken = ((await rotated.json()) as { token: string }).token;
  assert.equal((await api('/customers', newToken)).status, 200);
  await db.organizationMember.updateMany({
    where: { organizationId: a.organizationId },
    data: { active: false },
  });
  assert.equal((await api('/customers', newToken)).status, 401);
  const b = await fixture();
  const member = await db.organizationMember.create({
    data: { organizationId: b.organizationId, subject: `viewer:${randomUUID()}`, role: 'viewer' },
  });
  const viewer = await db.$transaction((tx) =>
    issueCredential(tx, b.organizationId, { membershipId: member.id }, ['crm:read', 'crm:write']),
  );
  assert.equal((await api('/customers', viewer.token)).status, 200);
  assert.equal((await api('/customers', viewer.token, 'POST', {})).status, 403);
});

test('one job caps total proposals across agents and the next scan drains remaining candidates', async () => {
  const a = await fixture();
  const c = await customer(a.organizationId);
  assert.ok(c.entityId);
  await db.opportunity.createMany({
    data: Array.from({ length: 105 }, (_, i) => ({
      organizationId: a.organizationId,
      customerId: c.entityId!,
      source: 'internal',
      externalId: `batch-${i}`,
      title: `Estimate ${i}`,
      amountMinor: 100,
      currency: 'USD',
      lastActivityAt: new Date(old),
      sourceOccurredAt: new Date(at),
    })),
  });
  await agent(a.organizationId);
  await agent(a.organizationId);
  await agent(a.organizationId);
  await ingestEvent(db, a.organizationId, 'internal', 'test', {
    id: 'batch-scan-1',
    version: 1,
    occurredAt: at,
    type: 'recovery.scan.requested',
    data: {},
  });
  await drain();
  assert.equal(
    await db.workforceAction.count({ where: { organizationId: a.organizationId } }),
    100,
  );
  await ingestEvent(db, a.organizationId, 'internal', 'test', {
    id: 'batch-scan-2',
    version: 1,
    occurredAt: at,
    type: 'recovery.scan.requested',
    data: {},
  });
  await drain();
  assert.equal(
    await db.workforceAction.count({ where: { organizationId: a.organizationId } }),
    105,
  );
});

test('agent creation stays disabled and activation uses optimistic version checks', async () => {
  const a = await fixture();
  const proposed = await api('/agents/propose', a.token, 'POST', {
    description: 'Review old estimates',
  });
  assert.equal(((await proposed.json()) as { provenance: string }).provenance, 'template_defaults');
  const response = await api('/agents', a.token, 'POST', {
    name: 'Recovery',
    description: 'Review old estimates',
    config: defaultRecoveryConfig,
  });
  assert.equal(response.status, 201);
  const created = (await response.json()) as { id: string; enabled: boolean };
  assert.equal(created.enabled, false);
  assert.equal(
    (await api(`/agents/${created.id}`, a.token, 'PATCH', { enabled: true, expectedVersion: 1 }))
      .status,
    200,
  );
  assert.equal(
    (await api(`/agents/${created.id}`, a.token, 'PATCH', { enabled: true, expectedVersion: 1 }))
      .status,
    409,
  );
  const fake: Principal = { ...a.actor, scopes: [] };
  await assert.rejects(decideApproval(db, fake, randomUUID(), 'approve', 'No scope'), /forbidden/);
});
