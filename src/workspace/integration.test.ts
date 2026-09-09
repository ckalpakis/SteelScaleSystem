/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import { authenticate, tokenHash, provisionOrganization } from '../workforce/tenancy/service.js';
import { randomUUID } from 'node:crypto';
import { signForm } from '../demo-engine/security.js';
import { IntegrationService } from '../integrations/service.js';
import { RecoverySimulationService } from '../recovery/simulation.js';
import { WorkspaceService } from './service.js';
import { workspaceFixture } from './test-fixtures.js';

requireDemoTestDatabase();
Object.assign(process.env, {
  WORKFORCE_ENABLED: 'true',
  CRM_ENABLED: 'true',
  BUSINESS_KNOWLEDGE_ENABLED: 'true',
  AGENT_RUNTIME_ENABLED: 'true',
  REVENUE_RECOVERY_ENABLED: 'true',
  AGENT_ALLOWED_MODELS: 'test-model',
  AGENT_MODEL_ENABLED: 'false',
  REVENUE_RECOVERY_DELIVERY_ENABLED: 'false',
  COMMUNICATION_DELIVERY_ENABLED: 'false',
  WORKFORCE_WORKER_ENABLED: 'false',
  WEBHOOK_DELIVERY_ENABLED: 'false',
  OPENAI_API_KEY: '',
  ADMIN_USERNAME: 'workspace-operator-test',
  ADMIN_PASSWORD: 'workspace-operator-password-test',
  LOG_LEVEL: 'silent',
});
let db: PrismaClient, server: Server, base: string;
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
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await db?.$disconnect();
});
const basic = (token: string) => `Basic ${Buffer.from(`member:${token}`).toString('base64')}`;
const get = (url: string, token: string) =>
  fetch(`${base}${url}`, { headers: { authorization: basic(token) } });
const post = (url: string, token: string, body: Record<string, string>, valid = true) => {
  const authorization = basic(token);
  return fetch(`${base}${url}`, {
    method: 'POST',
    redirect: 'manual',
    headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...body,
      csrf: valid ? signForm(tokenHash(authorization), authorization, url) : 'invalid',
    }),
  });
};

test('member CRM creates audited contacts/opportunities, updates stages, and rejects cross-tenant routes and CSRF', async () => {
  const a = await workspaceFixture(db),
    b = await workspaceFixture(db, 'Other organization secret');
  const foreign = await b.addCase('Foreign customer secret');
  const page = await get('/workspace/crm/contacts', a.token);
  assert.equal(page.status, 200);
  assert.doesNotMatch(
    await page.text(),
    /Foreign customer secret|Switch organization|\/admin\/crm/,
  );
  assert.equal((await get(`/workspace/crm/contacts/${foreign.contact.id}`, a.token)).status, 404);
  assert.equal((await get(`/workspace/crm/${b.organizationId}/contacts`, a.token)).status, 404);
  assert.equal(
    (await post('/workspace/crm/contacts', a.token, { name: 'Blocked' }, false)).status,
    403,
  );
  const created = await post('/workspace/crm/contacts', a.token, { name: 'Jamie Local' });
  assert.equal(created.status, 303);
  const contactId = created.headers.get('location')!.split('/').at(-1)!;
  const opp = await post('/workspace/crm/opportunities', a.token, {
    title: 'Maintenance agreement',
    customerId: contactId,
    stageSelection: `${a.pipeline.id}:${a.stage.id}`,
    amountMinor: '100000',
    currency: 'USD',
  });
  assert.equal(opp.status, 303);
  const opportunityId = opp.headers.get('location')!.split('/').at(-1)!;
  const won = await a.crm.create('stages', {
    name: 'Signed',
    pipelineId: a.pipeline.id,
    position: 1,
    outcome: 'won',
  });
  assert.equal(
    (
      await post(`/workspace/crm/opportunities/${opportunityId}`, a.token, {
        expectedVersion: '1',
        stageSelection: `${a.pipeline.id}:${won.id}`,
      })
    ).status,
    303,
  );
  assert.equal((await a.crm.detail('opportunities', opportunityId)).entity.status, 'won');
  assert.equal(
    (
      await post(`/workspace/crm/opportunities/${opportunityId}`, a.token, {
        expectedVersion: '1',
        title: 'Stale overwrite',
      })
    ).status,
    409,
  );
  assert.ok(
    await db.auditLog.count({
      where: { organizationId: a.organizationId, actor: a.principal.actor },
    }),
  );
  assert.equal((await get('/workspace?days=365', a.token)).status, 400);
  assert.equal((await get('/admin/crm', a.token)).status, 401);
});

test('viewer, revoked credentials and integration keys cannot mutate or acquire member access', async () => {
  const f = await workspaceFixture(db);
  const integration = await new IntegrationService(db, f.principal).createConnection({
    name: 'Inbound only',
    provider: 'zapier',
  });
  assert.equal((await get('/workspace', integration.token)).status, 403);
  await db.organizationMember.update({
    where: { id: f.principal.actor.slice(7) },
    data: { role: 'viewer' },
  });
  const page = await get('/workspace/crm/contacts', f.token);
  assert.equal(page.status, 200);
  assert.doesNotMatch(await page.text(), /Create contact|>Add contact</);
  assert.equal(
    (await post('/workspace/crm/contacts', f.token, { name: 'No privilege escalation' })).status,
    403,
  );
  await db.workforceCredential.update({
    where: { id: f.principal.credentialId },
    data: { revokedAt: new Date() },
  });
  assert.equal((await get('/workspace', f.token)).status, 401);
  await assert.rejects(new WorkspaceService(db, f.principal).overview(), /credential_changed/);
});

test('readiness verifies current knowledge and exact-version simulations without enabling or sending', async () => {
  const f = await workspaceFixture(db),
    workspace = new WorkspaceService(db, f.principal);
  let page = await workspace.overview();
  assert.equal(page.checks.find((c) => c.key === 'knowledge')!.complete, true);
  assert.equal(page.checks.find((c) => c.key === 'simulation')!.complete, false);
  const simulations = new RecoverySimulationService(db, f.principal);
  await simulations.run({
    scenarioKey: 'hvac-ready',
    config: { ...f.config, name: 'Different draft' },
  });
  assert.equal(
    (await workspace.overview()).checks.find((c) => c.key === 'simulation')!.complete,
    false,
  );
  await simulations.run({ scenarioKey: 'hvac-ready' });
  page = await workspace.overview();
  assert.equal(page.checks.find((c) => c.key === 'simulation')!.complete, true);
  await f.knowledge.toggle('sources', f.source.id, {
    expectedRevision: f.source.revision,
    active: false,
  });
  page = await workspace.overview();
  assert.equal(page.checks.find((c) => c.key === 'knowledge')!.complete, false);
  assert.equal(page.checks.find((c) => c.key === 'simulation')!.complete, true);
  assert.equal(page.agentEnabled, false);
  await f.knowledge.toggle('sources', f.source.id, {
    expectedRevision: f.source.revision + 1,
    active: true,
  });
  await f.recovery.configure({
    config: f.config,
    connectionId: null,
    expectedVersion: 1,
    reviewed: true,
  });
  assert.equal(
    (await workspace.overview()).checks.find((c) => c.key === 'simulation')!.complete,
    false,
  );
  assert.equal(await db.recoveryDispatch.count({ where: { organizationId: f.organizationId } }), 0);
  assert.equal(await db.agentRun.count({ where: { organizationId: f.organizationId } }), 0);
});

test('oldest-first handoff views are scoped, bounded, and use current member assignment', async () => {
  const f = await workspaceFixture(db),
    other = await workspaceFixture(db);
  const old = await f.addCase('Oldest customer'),
    recent = await f.addCase('Recent customer'),
    foreign = await other.addCase('Hidden customer');
  const now = new Date();
  for (const [organizationId, caseId, assignedMemberId, updatedAt] of [
    [
      f.organizationId,
      old.recoveryCase.id,
      f.principal.actor.slice(7),
      new Date(now.getTime() - 48 * 3600000),
    ],
    [f.organizationId, recent.recoveryCase.id, null, now],
    [other.organizationId, foreign.recoveryCase.id, null, new Date(0)],
  ] as const)
    await db.recoveryHandoff.create({
      data: {
        organizationId,
        caseId,
        assignedMemberId,
        updatedAt,
        reason: 'pricing_negotiation',
        summary: 'Fictional handoff.',
      },
    });
  const workspace = new WorkspaceService(db, f.principal);
  const all = await workspace.overview('30', 'all', now);
  assert.equal(all.queueCount, 2);
  assert.equal(all.agingCount, 1);
  assert.equal(all.handoffs[0]!.caseId, old.recoveryCase.id);
  assert.equal((await workspace.overview('30', 'mine')).handoffs[0]!.caseId, old.recoveryCase.id);
  assert.equal(
    (await workspace.overview('30', 'unassigned')).handoffs[0]!.caseId,
    recent.recoveryCase.id,
  );
  const response = await get('/workspace', f.token);
  const html = await response.text();
  assert.doesNotMatch(html, /Hidden customer/);
  assert.match(html, /48 hours/);
});

test('report windows exclude foreign, future, uncertain and unreviewed payments; currencies stay separate', async () => {
  const f = await workspaceFixture(db),
    other = await workspaceFixture(db);
  const now = new Date(),
    inWindow = new Date(now.getTime() - 86400000);
  for (const [fixture, status, currency, amountMinor, reviewed, occurredAt, payment] of [
    [f, 'AI_RECOVERED', 'USD', 120000, true, inWindow, true],
    [f, 'AI_RECOVERED', 'JPY', 24000, true, inWindow, true],
    [f, 'AI_ASSISTED', 'USD', 0, true, inWindow, true],
    [f, 'UNCERTAIN', 'USD', 0, false, inWindow, false],
    [f, 'AI_RECOVERED', 'USD', 700000, false, inWindow, true],
    [f, 'AI_RECOVERED', 'USD', 600000, true, inWindow, false],
    [f, 'AI_RECOVERED', 'USD', 500000, true, new Date(now.getTime() - 40 * 86400000), true],
    [f, 'AI_RECOVERED', 'USD', 400000, true, new Date(now.getTime() + 86400000), true],
    [other, 'AI_RECOVERED', 'USD', 999999, true, inWindow, true],
  ] as const) {
    const row = await fixture.addCase();
    await db.recoveryAttribution.create({
      data: {
        organizationId: fixture.organizationId,
        caseId: row.recoveryCase.id,
        entityId: row.opportunity.id,
        kind: 'opportunity',
        status,
        currency,
        amountMinor,
        reviewedAt: reviewed ? now : null,
        reviewedBy: reviewed ? fixture.principal.actor : null,
        occurredAt,
        paymentReference: payment ? `test-payment:${row.opportunity.id}` : null,
        evidence: { fixture: true },
      },
    });
  }
  const data = await new WorkspaceService(db, f.principal).overview('30', 'all', now);
  assert.equal(data.revenue.length, 2);
  assert.equal(data.revenue.find((r) => r.currency === 'USD')!._sum.amountMinor, 120000);
  assert.equal(data.revenue.find((r) => r.currency === 'JPY')!._sum.amountMinor, 24000);
  assert.equal(data.pendingEvidence, 2);
  assert.equal(data.evidence.length, 6);
  const wider = await new WorkspaceService(db, f.principal).overview('90', 'all', now);
  assert.equal(wider.revenue.find((r) => r.currency === 'USD')!._sum.amountMinor, 620000);
  const html = await (await get('/workspace', f.token)).text();
  assert.match(html, /not profit, incremental revenue, or a causal ROI claim/);
});

test('workspace rechecks role and feature gates on each request', async () => {
  const f = await workspaceFixture(db);
  await db.organizationMember.update({
    where: { id: f.principal.actor.slice(7) },
    data: { role: 'member' },
  });
  await assert.rejects(new WorkspaceService(db, f.principal).overview(), /credential_changed/);
  const member = await authenticate(db, `Bearer ${f.token}`);
  assert.equal((await new WorkspaceService(db, member).overview()).filters.queue, 'mine');
  process.env.CRM_ENABLED = 'false';
  try {
    assert.equal((await get('/workspace/crm/contacts', f.token)).status, 404);
  } finally {
    process.env.CRM_ENABLED = 'true';
  }
  process.env.WORKFORCE_ENABLED = 'false';
  try {
    assert.equal((await get('/workspace', f.token)).status, 404);
  } finally {
    process.env.WORKFORCE_ENABLED = 'true';
  }
});

test('delivery exceptions remain visible without exposing bodies or retrying unknown outcomes', async () => {
  const f = await workspaceFixture(db, '<script>unsafe-name</script> (test)'),
    other = await workspaceFixture(db);
  const row = await f.addCase();
  for (const status of ['unknown', 'failed', 'cancelled'])
    await db.recoveryDispatch.create({
      data: {
        organizationId: f.organizationId,
        caseId: row.recoveryCase.id,
        runtimeVersionId: f.program.runtimeVersionId,
        requestKey: `fixture:${status}`,
        body: 'Private customer body must not appear in overview',
        channel: 'sms',
        actor: f.principal.actor,
        caseRevision: 1,
        status,
      },
    });
  for (const fixture of [f, other]) {
    const endpoint = await db.webhookEndpoint.create({
      data: {
        organizationId: fixture.organizationId,
        name: 'Test destination',
        host: 'example.invalid',
        encryptedUrl: 'fixture-not-a-live-url',
        encryptedSecret: 'fixture-not-a-real-secret',
        events: ['contact.updated'],
      },
    });
    await db.outboundDelivery.create({
      data: {
        organizationId: fixture.organizationId,
        endpointId: endpoint.id,
        deduplicationKey: 'fixture:dead',
        payload: {},
        status: 'dead',
      },
    });
  }
  const data = await new WorkspaceService(db, f.principal).overview();
  assert.equal(data.uncertainDeliveries, 1);
  assert.equal(data.failedDeliveries, 1);
  assert.equal(data.outboundFailures, 1);
  const html = await (await get('/workspace', f.token)).text();
  assert.match(html, /reconcile the provider receipt first/);
  assert.match(html, /&lt;script&gt;unsafe-name/);
  assert.doesNotMatch(html, /<script>unsafe-name|Private customer body/);
  assert.equal(
    await db.recoveryDispatch.count({
      where: { organizationId: f.organizationId, status: 'unknown', transportAttempts: 0 },
    }),
    1,
  );
  assert.equal((await fetch(`${base}/workspace`)).status, 401);
});

test('a brand-new organization gets honest empty states without automatic setup or activation', async () => {
  const org = await provisionOrganization(
    db,
    { name: 'New business (test)', ownerSubject: `empty-workspace:${randomUUID()}` },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${org.token}`);
  const data = await new WorkspaceService(db, principal).overview();
  assert.equal(data.checks.filter((c) => c.complete).length, 0);
  assert.equal(data.agentEnabled, false);
  assert.equal(data.queueCount, 0);
  assert.deepEqual(data.revenue, []);
  const response = await get('/workspace', org.token);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /No open opportunities yet/);
  assert.match(html, /No verified payments/);
  assert.match(html, /\/workspace\/crm\/contacts/);
  assert.ok(!html.includes(org.token));
  assert.equal(
    await db.recoveryProgram.count({ where: { organizationId: org.organization.id } }),
    0,
  );
});
