/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import { authenticate, provisionOrganization } from '../workforce/tenancy/service.js';
import { tenantTransaction, object, WorkforceError } from '../workforce/shared.js';
import { CrmService } from '../crm/service.js';
import { IntegrationService } from '../integrations/service.js';
import { runOnce } from '../agents/runtime.js';
import { decideApproval } from '../agents/approvals.js';
import { eventRouter } from '../events/handlers.js';
import { RecoveryService } from './service.js';
import { RecoveryDeliveryService } from './delivery.js';
import { RecoveryHandoffService } from './handoffs.js';
import { RecoveryAttributionService } from './attribution.js';
import { RecoveryDashboardService } from './dashboard.js';
import { RecoverySimulationService } from './simulation.js';
import { RevenueRecoveryProvider } from './provider.js';
import { classifyFixture } from './decisions.js';
import { exampleConfig } from './contracts.js';
import { startCase, scanRecovery } from './orchestrator.js';
import { loadCase, messageGuard } from './lifecycle.js';

requireDemoTestDatabase();
Object.assign(process.env, {
  WORKFORCE_ENABLED: 'true',
  CRM_ENABLED: 'true',
  AGENT_RUNTIME_ENABLED: 'true',
  AGENT_MODEL_ENABLED: 'false',
  AGENT_ALLOWED_MODELS: 'test-model',
  REVENUE_RECOVERY_ENABLED: 'true',
  REVENUE_RECOVERY_DELIVERY_ENABLED: 'true',
  WORKFORCE_WORKER_ENABLED: 'false',
  WEBHOOK_DELIVERY_ENABLED: 'false',
  OPENAI_API_KEY: '',
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
const provider = new RevenueRecoveryProvider({
  classify: (message) => Promise.resolve(classifyFixture(message)),
});
const code = (expected: string) => (error: unknown) =>
  error instanceof WorkforceError && error.code === expected;
async function fixture(mode: 'AUTOPILOT' | 'COPILOT' | 'ADVISORY' = 'COPILOT') {
  const org = await provisionOrganization(
      db,
      { name: 'Recovery test', ownerSubject: `recovery:${randomUUID()}` },
      'test',
    ),
    organizationId = org.organization.id,
    principal = await authenticate(db, `Bearer ${org.token}`),
    crm = new CrmService(db, principal),
    service = new RecoveryService(db, principal);
  const connection = await new IntegrationService(db, principal).createConnection({
      name: 'Test delivery adapter',
      provider: 'generic_webhook',
    }),
    adapter = await authenticate(db, `Bearer ${connection.token}`);
  const config = exampleConfig();
  config.mode = mode;
  config.model = 'test-model';
  config.workingHours = { timezone: 'UTC', days: [0, 1, 2, 3, 4, 5, 6], startHour: 0, endHour: 24 };
  config.employeeQuietMinutes = 15;
  config.knowledge = config.knowledge.map((k) => ({ ...k, approved: true }));
  const program = await service.configure({
    config,
    connectionId: connection.connectionId,
    expectedVersion: 0,
    reviewed: true,
  });
  await service.enable(true);
  const contact = await crm.create('contacts', {
    name: 'Alex Morgan',
    phone: '+12025550197',
    email: 'alex@example.invalid',
  });
  const pipeline = await crm.create('pipelines', { name: 'Service work' });
  const stage = await crm.create('stages', {
    name: 'Proposal sent',
    pipelineId: pipeline.id,
    position: 0,
  });
  const opportunity = await crm.create('opportunities', {
    title: 'Service proposal',
    customerId: contact.id,
    pipelineId: pipeline.id,
    stageId: stage.id,
    amountMinor: 1850000,
    currency: 'USD',
    lastActivityAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  });
  await service.consent({
    contactId: contact.id,
    channel: 'sms',
    granted: true,
    evidence: 'Fictional explicit SMS consent for testing.',
  });
  // Backdate only synthetic setup facts so they do not masquerade as recent employee activity.
  await db.businessEvent.updateMany({
    where: { organizationId },
    data: { receivedAt: new Date(Date.now() - 8 * 86400000) },
  });
  const recovery = await service.enroll(opportunity.id);
  return {
    organizationId,
    principal,
    token: org.token,
    crm,
    service,
    config,
    program,
    contact,
    opportunity,
    recovery,
    adapter,
    connection,
    delivery: new RecoveryDeliveryService(db, adapter),
    handoffs: new RecoveryHandoffService(db, principal),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
test('ADVISORY journals a recommendation and handoff without requesting a message action', async () => {
  const f = await fixture('ADVISORY');
  await tenantTransaction(db, f.organizationId, (tx) =>
    startCase(tx, f.organizationId, f.recovery.id),
  );
  await runOnce(db, provider, f.organizationId);
  await runOnce(db, provider, f.organizationId);
  assert.equal(await db.recoveryDispatch.count({ where: { organizationId: f.organizationId } }), 0);
  assert.equal(await db.humanApproval.count({ where: { organizationId: f.organizationId } }), 0);
  const h = await db.recoveryHandoff.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  assert.equal(h.reason, 'advisory_recommendation');
});

test('a rejected proposal ends in visible human review, never another automated proposal', async () => {
  const f = await fixture(),
    p = await proposed(f);
  await decideApproval(db, f.principal, p.approval.id, 'reject', 'Do not follow up automatically.');
  await runOnce(db, provider, f.organizationId);
  await tenantTransaction(db, f.organizationId, (tx) =>
    startCase(tx, f.organizationId, f.recovery.id),
  );
  assert.equal(await db.recoveryDispatch.count({ where: { organizationId: f.organizationId } }), 0);
  assert.equal(
    (await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } })).state,
    'handoff',
  );
});
async function proposed(f: Fixture) {
  const run = await tenantTransaction(db, f.organizationId, (tx) =>
    startCase(tx, f.organizationId, f.recovery.id),
  );
  assert.ok(run, JSON.stringify(await f.service.detail(f.recovery.id)));
  await runOnce(db, provider, f.organizationId);
  await runOnce(db, provider, f.organizationId);
  const approval = await db.humanApproval.findFirst({
    where: { organizationId: f.organizationId, action: { runId: run.id } },
    include: { action: true },
  });
  assert.ok(
    approval,
    JSON.stringify(
      await db.agentRun.findUnique({ where: { id: run.id }, include: { steps: true } }),
    ),
  );
  assert.equal(approval.action.tool, 'send_recovery_message');
  return { run, approval };
}
async function queued(f: Fixture) {
  const { run, approval } = await proposed(f);
  const result = await decideApproval(
    db,
    f.principal,
    approval.id,
    'approve',
    'Reviewed exact approved recovery message.',
  );
  assert.equal(result.executed, true, JSON.stringify(result));
  const dispatch = await db.recoveryDispatch.findFirstOrThrow({
    where: {
      organizationId: f.organizationId,
      caseId: f.recovery.id,
      actionId: approval.action.id,
    },
  });
  await runOnce(db, provider, f.organizationId);
  return { run, approval, dispatch };
}
async function delivered(f: Fixture) {
  const q = await queued(f),
    claim = await f.delivery.claim(q.dispatch.id);
  assert.ok('claimToken' in claim, JSON.stringify(claim));
  const receipt = {
    claimToken: claim.claimToken,
    status: 'delivered',
    providerMessageId: randomUUID(),
    occurredAt: new Date().toISOString(),
    evidence: 'Fictional confirmed provider delivery.',
  };
  await f.delivery.receipt(q.dispatch.id, receipt);
  return { ...q, claim, receipt };
}
async function dispatchFacts(f: Fixture) {
  const rows = await db.businessEvent.findMany({
    where: { organizationId: f.organizationId },
    orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
  });
  for (const e of rows)
    await tenantTransaction(db, f.organizationId, (tx) =>
      eventRouter.dispatch(tx, f.organizationId, e.id),
    );
}
async function inbound(f: Fixture, text: string) {
  const row = await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } });
  const message = await f.crm.create('messages', {
    conversationId: row.conversationId,
    direction: 'inbound',
    body: text,
    occurredAt: new Date().toISOString(),
  });
  await dispatchFacts(f);
  return message;
}

test('scheduled follow-up uses generic steps, exact approval, idempotent claims and delivery receipts', async () => {
  const f = await fixture(),
    q = await queued(f);
  assert.equal(q.dispatch.body, f.config.knowledge[0]!.text);
  assert.equal(q.dispatch.status, 'pending');
  assert.equal(
    await db.message.count({ where: { organizationId: f.organizationId, direction: 'outbound' } }),
    process.env.COMMUNICATIONS_ENABLED === 'true' ? 1 : 0,
  );
  assert.equal(
    await db.communicationDelivery.count({
      where: { organizationId: f.organizationId, deliveredAt: { not: null } },
    }),
    0,
  );
  const claims = await Promise.allSettled([
    f.delivery.claim(q.dispatch.id),
    f.delivery.claim(q.dispatch.id),
  ]);
  assert.equal(claims.filter((c) => c.status === 'fulfilled').length, 1);
  const claim = (
    claims.find((c) => c.status === 'fulfilled') as PromiseFulfilledResult<
      Awaited<ReturnType<RecoveryDeliveryService['claim']>>
    >
  ).value;
  assert.ok('claimToken' in claim);
  const receipt = {
    claimToken: claim.claimToken,
    status: 'delivered',
    providerMessageId: 'provider-fixture',
    occurredAt: new Date().toISOString(),
    evidence: 'Confirmed fictional delivery.',
  };
  await f.delivery.receipt(q.dispatch.id, receipt);
  assert.equal((await f.delivery.receipt(q.dispatch.id, receipt)).duplicate, true);
  assert.equal(
    await db.message.count({ where: { organizationId: f.organizationId, direction: 'outbound' } }),
    1,
  );
  const row = await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } });
  assert.equal(row.attempts, 1);
  assert.ok(row.firstDeliveredAt);
  assert.ok(row.nextDueAt);
});
test('duplicate scans and canonical estimate/stage facts never create duplicate cases or pending runs', async () => {
  const f = await fixture();
  await Promise.all([scanRecovery(db, f.organizationId), scanRecovery(db, f.organizationId)]);
  assert.equal(await db.recoveryCase.count({ where: { organizationId: f.organizationId } }), 1);
  assert.equal(await db.agentRun.count({ where: { organizationId: f.organizationId } }), 1);
  await f.crm.create('estimates', {
    opportunityId: f.opportunity.id,
    number: 'Q-1',
    title: 'Service quote',
    amountMinor: 1850000,
    currency: 'USD',
    status: 'sent',
  });
  await dispatchFacts(f);
  await dispatchFacts(f);
  assert.equal(await db.recoveryCase.count({ where: { organizationId: f.organizationId } }), 1);
});
test('all recovery reads, handoffs, consent, delivery adapters and SQL links are tenant scoped', async () => {
  const a = await fixture(),
    b = await fixture();
  const q = await queued(a);
  await assert.rejects(b.service.detail(a.recovery.id), code('recovery_case_not_found'));
  await assert.rejects(
    b.service.consent({
      contactId: a.contact.id,
      channel: 'sms',
      granted: true,
      evidence: 'Invalid tenant',
    }),
    code('contact_not_found'),
  );
  await assert.rejects(b.delivery.claim(q.dispatch.id), code('recovery_dispatch_not_found'));
  await assert.rejects(
    new RecoveryDeliveryService(db, a.principal).list(),
    code('credential_changed'),
  );
  await assert.rejects(
    db.recoveryHandoff.create({
      data: {
        organizationId: b.organizationId,
        caseId: a.recovery.id,
        reason: 'No',
        summary: 'Cross tenant',
      },
    }),
  );
  await assert.rejects(
    db.recoveryDispatch.create({
      data: {
        organizationId: b.organizationId,
        caseId: b.recovery.id,
        requestKey: randomUUID(),
        body: 'No',
        channel: 'sms',
        actor: 'test',
        caseRevision: 1,
        runtimeVersionId: a.program.runtimeVersionId,
      },
    }),
  );
});
for (const scenario of [
  'disabled',
  'inactive',
  'opted_out',
  'consent',
  'won',
  'value',
  'pipeline',
  'employee',
  'hours',
  'attempts',
  'reply',
] as const)
  test(`fresh pre-dispatch guard blocks ${scenario}`, async () => {
    const f = await fixture(),
      q = await queued(f);
    if (scenario === 'disabled') await f.service.enable(false);
    if (scenario === 'inactive')
      await db.organization.update({ where: { id: f.organizationId }, data: { active: false } });
    if (scenario === 'opted_out')
      await db.contact.update({ where: { id: f.contact.id }, data: { doNotContact: true } });
    if (scenario === 'consent')
      await f.service.consent({
        contactId: f.contact.id,
        channel: 'sms',
        granted: false,
        evidence: 'Revoked test consent',
      });
    if (scenario === 'won')
      await db.opportunity.update({ where: { id: f.opportunity.id }, data: { status: 'won' } });
    if (scenario === 'value')
      await db.opportunity.update({ where: { id: f.opportunity.id }, data: { currency: 'EUR' } });
    if (scenario === 'pipeline')
      await db.crmRecord.update({
        where: { id: String(f.opportunity.pipelineId) },
        data: { archivedAt: new Date() },
      });
    if (scenario === 'employee')
      await db.recoveryCase.update({
        where: { id: f.recovery.id },
        data: { employeeActionAt: new Date() },
      });
    if (scenario === 'attempts')
      await db.recoveryCase.update({ where: { id: f.recovery.id }, data: { attempts: 3 } });
    if (scenario === 'hours') {
      const config = {
        ...f.config,
        workingHours: {
          timezone: 'UTC',
          days: [(new Date().getUTCDay() + 1) % 7],
          startHour: 0,
          endHour: 24,
        },
      };
      await db.agentVersion.update({
        where: { id: f.program.runtimeVersionId },
        data: { specialization: JSON.parse(JSON.stringify(config)) as object },
      });
    }
    if (scenario === 'reply') {
      const row = await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } });
      await f.crm.create('messages', {
        conversationId: row.conversationId,
        direction: 'inbound',
        body: 'I am interested',
        occurredAt: new Date().toISOString(),
      });
    }
    const claim = await f.delivery.claim(q.dispatch.id);
    assert.ok('blocked' in claim, JSON.stringify(claim));
    assert.equal(
      await db.message.count({
        where: { organizationId: f.organizationId, direction: 'outbound' },
      }),
      process.env.COMMUNICATIONS_ENABLED === 'true' ? 1 : 0,
    );
    assert.equal(
      await db.communicationDelivery.count({
        where: { organizationId: f.organizationId, deliveredAt: { not: null } },
      }),
      0,
    );
  });
test('opt-out cancels pending approval, persists suppression and cannot be resumed', async () => {
  const f = await fixture(),
    q = await proposed(f);
  await inbound(f, 'STOP');
  assert.equal(
    (await db.contact.findUniqueOrThrow({ where: { id: f.contact.id } })).doNotContact,
    true,
  );
  assert.equal(
    (await db.humanApproval.findUniqueOrThrow({ where: { id: q.approval.id } })).status,
    'rejected',
  );
  const handoff = await db.recoveryHandoff.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  await assert.rejects(
    f.handoffs.act(handoff.id, { action: 'return_to_ai', expectedRevision: handoff.revision }),
    code('opt_out'),
  );
});
test('pricing handoff supports takeover and response; closing does not restart AI', async () => {
  const f = await fixture();
  await inbound(f, 'Can you lower the price?');
  let h = await db.recoveryHandoff.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  assert.equal(h.reason, 'pricing_negotiation');
  await f.handoffs.act(h.id, { action: 'take_over', expectedRevision: h.revision });
  h = await db.recoveryHandoff.findUniqueOrThrow({ where: { id: h.id } });
  assert.equal(
    (await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } })).state,
    'human_owned',
  );
  const result = await f.handoffs.act(h.id, {
    action: 'respond',
    expectedRevision: h.revision,
    message: 'I can discuss the proposal with you.',
    channel: 'sms',
    requestKey: 'reply-1',
  });
  assert.ok('body' in result);
  await f.handoffs.act(h.id, { action: 'close', expectedRevision: h.revision });
  assert.equal(
    (await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } })).state,
    'closed',
  );
  assert.equal(
    (await db.recoveryDispatch.findFirstOrThrow({ where: { organizationId: f.organizationId } }))
      .status,
    'cancelled',
  );
});
test('a reply is classified by the generic runtime and creates no automatic response', async () => {
  const f = await fixture();
  await delivered(f);
  await inbound(f, 'What does this include?');
  await runOnce(db, provider, f.organizationId);
  await runOnce(db, provider, f.organizationId);
  const decision = await db.recoveryDecision.findFirstOrThrow({
    where: { organizationId: f.organizationId },
    orderBy: { createdAt: 'desc' },
  });
  assert.equal(object(decision.decision).intent, 'information_request');
  assert.equal(await db.recoveryDispatch.count({ where: { organizationId: f.organizationId } }), 1);
  assert.equal(
    (await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } })).state,
    'handoff',
  );
});
test('unknown delivery outcomes become a visible handoff and never automatically resend', async () => {
  const f = await fixture(),
    q = await queued(f);
  await f.delivery.claim(q.dispatch.id);
  await db.recoveryDispatch.update({
    where: { id: q.dispatch.id },
    data: { claimedUntil: new Date(Date.now() - 1000) },
  });
  await f.service.enable(false);
  await scanRecovery(db, f.organizationId);
  assert.equal(
    (await db.recoveryDispatch.findUniqueOrThrow({ where: { id: q.dispatch.id } })).status,
    'unknown',
  );
  await assert.rejects(f.delivery.claim(q.dispatch.id), code('recovery_dispatch_not_claimable'));
  assert.equal(await db.recoveryHandoff.count({ where: { organizationId: f.organizationId } }), 1);
});
test('delivery alone never claims revenue; reviewed response, won outcome and payment evidence are required', async () => {
  const f = await fixture();
  await delivered(f);
  await inbound(f, 'Yes, I am interested.');
  const current = await f.crm.detail('opportunities', f.opportunity.id);
  const wonStage = await f.crm.create('stages', {
    name: 'Won',
    pipelineId: f.opportunity.pipelineId,
    position: 1,
    outcome: 'won',
  });
  await f.crm.update('opportunities', f.opportunity.id, {
    stageId: wonStage.id,
    expectedVersion: current.entity.record.version,
  });
  await dispatchFacts(f);
  const attribution = await db.recoveryAttribution.findFirstOrThrow({
    where: { organizationId: f.organizationId, kind: 'opportunity' },
  });
  assert.equal(attribution.status, 'AI_ASSISTED');
  assert.equal(attribution.amountMinor, 0);
  const service = new RecoveryAttributionService(db, f.principal);
  await assert.rejects(
    service.review(attribution.id, {
      status: 'AI_RECOVERED',
      amountMinor: 1850000,
      currency: 'USD',
      paymentReference: null,
      paidAt: null,
      evidence: 'No payment proof',
    }),
    code('verified_payment_required'),
  );
  const review = {
    status: 'AI_RECOVERED',
    amountMinor: 1850000,
    currency: 'USD',
    paymentReference: 'fictional-payment-1',
    paidAt: new Date().toISOString(),
    evidence: 'Fictional verified payment and recovery contribution.',
  };
  await service.review(attribution.id, review);
  await service.review(attribution.id, review);
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: f.organizationId, type: 'opportunity.recovered' },
    }),
    1,
  );
  const dashboard = await new RecoveryDashboardService(db, f.principal).dashboard();
  assert.equal(dashboard.metrics.dealsRecovered, 1);
  assert.equal(dashboard.metrics.recoveredRevenue[0]?.amountMinor, 1850000);
  const won = await f.crm.detail('opportunities', f.opportunity.id);
  await f.crm.update('opportunities', f.opportunity.id, {
    stageId: f.opportunity.stageId,
    expectedVersion: won.entity.record.version,
  });
  await dispatchFacts(f);
  assert.equal(
    (await new RecoveryDashboardService(db, f.principal).dashboard()).metrics.dealsRecovered,
    0,
  );
});

test('cadence admits one next action and an appointment or accepted estimate blocks it before delivery', async () => {
  const f = await fixture();
  await delivered(f);
  await db.recoveryCase.update({
    where: { id: f.recovery.id },
    data: { nextDueAt: new Date(Date.now() - 1000) },
  });
  const second = await queued(f);
  assert.notEqual(second.dispatch.body, f.config.knowledge[0]!.text);
  await f.crm.create('estimates', {
    title: 'Accepted proposal',
    number: 'EST-accepted',
    opportunityId: f.opportunity.id,
    amountMinor: 1850000,
    currency: 'USD',
    status: 'accepted',
  });
  const claim = await f.delivery.claim(second.dispatch.id);
  assert.ok('blocked' in claim);
  assert.equal(
    await db.recoveryDispatch.count({
      where: { organizationId: f.organizationId, status: 'delivered' },
    }),
    1,
  );
  const g = await fixture(),
    q = await queued(g);
  await g.crm.create('appointments', {
    title: 'Proposal discussion',
    contactId: g.contact.id,
    opportunityId: g.opportunity.id,
    startsAt: new Date(Date.now() + 86400000).toISOString(),
    endsAt: new Date(Date.now() + 88200000).toISOString(),
    timezone: 'UTC',
  });
  assert.ok('blocked' in (await g.delivery.claim(q.dispatch.id)));
});
test('simulations are isolated from CRM, runs, dispatches and financial metrics', async () => {
  const f = await fixture();
  const before = await db.agentRun.count({ where: { organizationId: f.organizationId } });
  const result = await new RecoverySimulationService(db, f.principal).run({
    scenarioKey: 'insurance-negotiate',
  });
  assert.equal(object(result.result).sideEffects, false);
  assert.equal(await db.agentRun.count({ where: { organizationId: f.organizationId } }), before);
  assert.equal(await db.recoveryDispatch.count({ where: { organizationId: f.organizationId } }), 0);
  assert.equal(
    await db.recoveryAttribution.count({ where: { organizationId: f.organizationId } }),
    0,
  );
});

test('confirmed not-sent retries reuse the reserved attempt; unknown outcomes accept reconciliation but not resends', async () => {
  const f = await fixture(),
    q = await queued(f);
  await db.recoveryCase.update({
    where: { id: f.recovery.id },
    data: { attempts: f.config.maximumAttempts - 1 },
  });
  const first = await f.delivery.claim(q.dispatch.id);
  assert.ok('claimToken' in first);
  await f.delivery.receipt(q.dispatch.id, {
    claimToken: first.claimToken,
    status: 'not_sent',
    providerMessageId: null,
    occurredAt: new Date().toISOString(),
    evidence: 'Provider conclusively rejected before sending.',
  });
  await db.recoveryDispatch.update({
    where: { id: q.dispatch.id },
    data: { availableAt: new Date(0) },
  });
  const retry = await f.delivery.claim(q.dispatch.id);
  assert.ok('claimToken' in retry);
  assert.equal(
    (await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } })).attempts,
    f.config.maximumAttempts,
  );
  await f.delivery.receipt(q.dispatch.id, {
    claimToken: retry.claimToken,
    status: 'unknown',
    providerMessageId: null,
    occurredAt: new Date().toISOString(),
    evidence: 'Provider timed out after submission.',
  });
  await assert.rejects(f.delivery.claim(q.dispatch.id), code('recovery_dispatch_not_claimable'));
  await f.delivery.receipt(q.dispatch.id, {
    claimToken: retry.claimToken,
    status: 'delivered',
    providerMessageId: 'reconciled',
    occurredAt: new Date().toISOString(),
    evidence: 'Provider later confirmed delivery.',
  });
  assert.equal(
    (await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } })).state,
    'handoff',
  );
});

test('employee authority is rechecked when the adapter claims a queued human response', async () => {
  const f = await fixture();
  await inbound(f, 'Can you negotiate the price?');
  const handoff = await db.recoveryHandoff.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  const owned = await f.handoffs.act(handoff.id, {
    action: 'take_over',
    expectedRevision: handoff.revision,
  });
  assert.ok('revision' in owned);
  const response = await f.handoffs.act(handoff.id, {
    action: 'respond',
    expectedRevision: owned.revision,
    channel: 'sms',
    message: 'I can discuss the scope with you.',
    requestKey: randomUUID(),
  });
  await db.organizationMember.update({
    where: { id: f.principal.actor.slice(7) },
    data: { active: false },
  });
  assert.deepEqual(await f.delivery.claim(response.id), {
    blocked: 'recovery_human_authority_changed',
    retryable: false,
  });
});

test('an unprocessed opt-out also blocks an already queued employee response', async () => {
  const f = await fixture();
  await inbound(f, 'Can you negotiate the price?');
  const h = await db.recoveryHandoff.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  const owned = await f.handoffs.act(h.id, { action: 'take_over', expectedRevision: h.revision });
  assert.ok('revision' in owned);
  const response = await f.handoffs.act(h.id, {
    action: 'respond',
    expectedRevision: owned.revision,
    channel: 'sms',
    message: 'An employee is reviewing your question.',
    requestKey: randomUUID(),
  });
  const row = await tenantTransaction(db, f.organizationId, (tx) =>
    loadCase(tx, f.organizationId, f.recovery.id),
  );
  await f.crm.create('messages', {
    conversationId: row.conversationId,
    direction: 'inbound',
    body: 'STOP',
    occurredAt: new Date().toISOString(),
  });
  assert.deepEqual(await f.delivery.claim(response.id), {
    blocked: process.env.COMMUNICATIONS_ENABLED === 'true' ? 'opt_out' : 'unprocessed_opt_out',
    retryable: false,
  });
});

test('a shared-contact reply pauses every case without attributing engagement to every opportunity', async () => {
  const f = await fixture();
  await delivered(f);
  const second = await f.crm.create('opportunities', {
    title: 'Another proposal',
    customerId: f.contact.id,
    pipelineId: f.opportunity.pipelineId,
    stageId: f.opportunity.stageId,
    amountMinor: 300000,
    currency: 'USD',
    lastActivityAt: new Date(Date.now() - 7 * 86400000).toISOString(),
  });
  await f.service.enroll(second.id);
  await inbound(f, 'Yes, I am interested.');
  const cases = await db.recoveryCase.findMany({ where: { organizationId: f.organizationId } });
  assert.equal(cases.length, 2);
  assert.ok(cases.every((c) => c.engagedAt === null));
  assert.equal(await db.recoveryHandoff.count({ where: { organizationId: f.organizationId } }), 2);
});

test('return to AI preserves attempts, delays follow-up and rejects obsolete configuration approvals', async () => {
  const f = await fixture();
  await delivered(f);
  await inbound(f, 'I need more time.');
  const h = await db.recoveryHandoff.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  await f.handoffs.act(h.id, { action: 'return_to_ai', expectedRevision: h.revision });
  const row = await db.recoveryCase.findUniqueOrThrow({ where: { id: f.recovery.id } });
  assert.equal(row.state, 'monitoring');
  assert.equal(row.attempts, 1);
  assert.ok(row.nextDueAt && row.nextDueAt > new Date());
  const fresh = await fixture(),
    p = await proposed(fresh);
  await fresh.service.configure({
    config: fresh.config,
    connectionId: fresh.connection.connectionId,
    reviewed: true,
    expectedVersion: 1,
  });
  assert.equal(
    (await db.humanApproval.findUniqueOrThrow({ where: { id: p.approval.id } })).status,
    'rejected',
  );
  assert.equal(
    (await db.workforceAgent.findUniqueOrThrow({ where: { id: fresh.program.agentId } })).enabled,
    false,
  );
});
test('member dashboard and APIs enforce authentication, CSRF, scopes and default-off delivery', async () => {
  const f = await fixture(),
    headers = {
      authorization: `Basic ${Buffer.from(`organization:${f.token}`).toString('base64')}`,
    };
  assert.equal((await fetch(`${base}/revenue-recovery`)).status, 401);
  const page = await fetch(`${base}/revenue-recovery`, { headers });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Simulation lab/);
  assert.equal(
    (
      await fetch(`${base}/revenue-recovery/enable`, {
        method: 'POST',
        headers,
        body: new URLSearchParams({ enabled: 'true' }),
      })
    ).status,
    403,
  );
  const q = await queued(f);
  process.env.REVENUE_RECOVERY_DELIVERY_ENABLED = 'false';
  try {
    assert.throws(() => f.delivery.claim(q.dispatch.id), code('recovery_delivery_disabled'));
  } finally {
    process.env.REVENUE_RECOVERY_DELIVERY_ENABLED = 'true';
  }
  await db.workforceCredential.update({
    where: { id: f.adapter.credentialId },
    data: { revokedAt: new Date() },
  });
  await assert.rejects(f.delivery.list(), code('credential_changed'));
});
test('manual duplicate dispatches and safety status checks are enforced in PostgreSQL', async () => {
  const f = await fixture(),
    q = await queued(f);
  await assert.rejects(
    db.recoveryDispatch.create({
      data: {
        organizationId: f.organizationId,
        caseId: f.recovery.id,
        requestKey: randomUUID(),
        body: q.dispatch.body,
        channel: 'sms',
        actor: 'test',
        caseRevision: 1,
        runtimeVersionId: f.program.runtimeVersionId,
      },
    }),
  );
  const result = await tenantTransaction(db, f.organizationId, async (tx) =>
    messageGuard(tx, await loadCase(tx, f.organizationId, f.recovery.id), 'sms', new Date()),
  );
  assert.equal(result, 'duplicate_or_unresolved_dispatch');
});
