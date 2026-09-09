/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { PrismaClient } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import {
  authenticate,
  provisionOrganization,
  issueCredential,
} from '../workforce/tenancy/service.js';
import { tenantTransaction, WorkforceError, json } from '../workforce/shared.js';
import { CrmService } from '../crm/service.js';
import { AgentService } from './service.js';
import { runOnce } from './runtime.js';
import { decideApproval } from './approvals.js';
import { scheduleAgents } from './scheduler.js';
import { eventRouter } from '../events/handlers.js';
import { EventPublisher } from '../events/publisher.js';
import { definition, decision } from './test-fixtures.js';
import type { Definition } from './contracts.js';
import type { DecisionProvider } from './provider.js';
requireDemoTestDatabase();
Object.assign(process.env, {
  WORKFORCE_ENABLED: 'true',
  AGENT_RUNTIME_ENABLED: 'true',
  AGENT_MODEL_ENABLED: 'false',
  AGENT_ALLOWED_MODELS: '',
  OPENAI_API_KEY: '',
  CRM_ENABLED: 'true',
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
  base = `http://127.0.0.1:${address.port}/api/agents`;
});
after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await db?.$disconnect();
});
async function fixture(overrides: Partial<Definition> = {}) {
  const org = await provisionOrganization(
    db,
    { name: 'Agent fixture', ownerSubject: `agent-test:${randomUUID()}` },
    'test',
  );
  const organizationId = org.organization.id,
    principal = await authenticate(db, `Bearer ${org.token}`);
  const service = new AgentService(db, principal),
    crm = new CrmService(db, principal);
  const contact = await crm.create('contacts', {
    name: 'Fictional customer',
    email: 'fictional@example.invalid',
  });
  const config = definition(overrides);
  const { agent, version } = await service.create(config);
  await service.enable(agent.id, true);
  return {
    organizationId,
    principal,
    service,
    crm,
    contact,
    config,
    agent,
    version,
    token: org.token,
    start: (key: string = randomUUID(), subjectId = contact.id) =>
      service.start(agent.id, { subjectId, idempotencyKey: key }),
    step: (provider: DecisionProvider) => runOnce(db, provider, organizationId),
  };
}
const provider = (value: unknown): DecisionProvider => ({
  decide() {
    return Promise.resolve(value);
  },
});
test('agent versions are immutable API snapshots and never rewrite legacy recovery agents', async () => {
  const f = await fixture();
  const legacy = await db.workforceAgent.create({
    data: {
      organizationId: f.organizationId,
      name: 'Legacy recovery',
      description: 'Existing',
      kind: 'revenue_recovery',
      config: { version: 1 },
    },
  });
  await assert.rejects(
    f.service.version(legacy.id, f.config),
    (e: unknown) => e instanceof WorkforceError && e.code === 'agent_not_found',
  );
  const v2 = await f.service.version(f.agent.id, {
    ...f.config,
    objective: 'Review a different goal.',
  });
  assert.equal(v2.number, 2);
  assert.deepEqual(
    (await db.agentVersion.findUniqueOrThrow({ where: { id: f.version.id } })).definition,
    f.config,
  );
  assert.equal(
    (await db.workforceAgent.findUniqueOrThrow({ where: { id: f.agent.id } })).enabled,
    false,
  );
  assert.equal(await db.agentGoal.count({ where: { organizationId: f.organizationId } }), 2);
  assert.equal(await db.agentPolicy.count({ where: { organizationId: f.organizationId } }), 2);
});
test('AUTOPILOT executes only a permitted internal tool and records context, policy and receipt', async () => {
  const f = await fixture({ mode: 'AUTOPILOT' }),
    run = await f.start();
  await f.step(
    provider(decision('create_task', { targetId: f.contact.id, title: 'Review request' })),
  );
  await f.step(provider(decision(null)));
  const detail = await f.service.detail(run.id);
  assert.equal(detail.status, 'completed');
  assert.equal(detail.steps.length, 2);
  assert.equal(detail.actions.length, 1);
  assert.equal(detail.actions[0]!.status, 'completed');
  assert.equal(await db.task.count({ where: { organizationId: f.organizationId } }), 1);
  assert.equal(JSON.stringify(detail.steps).includes('fictional@example.invalid'), false);
  assert.equal(JSON.stringify(detail.result).includes('"met":true'), true);
  assert.equal(
    await db.auditLog.count({
      where: {
        organizationId: f.organizationId,
        type: 'agent.action_completed',
        subjectId: detail.actions[0]!.id,
      },
    }),
    1,
  );
});
test('COPILOT persists an exact proposal, approves once, and ADVISORY cannot execute it', async () => {
  const f = await fixture(),
    run = await f.start();
  await f.step(
    provider(decision('add_note', { targetId: f.contact.id, text: 'Proposed staff note' })),
  );
  let detail = await f.service.detail(run.id);
  assert.equal(detail.status, 'waiting_approval');
  assert.equal(await db.note.count({ where: { organizationId: f.organizationId } }), 0);
  const approval = detail.actions[0]!.approval!;
  const results = await Promise.allSettled([
    decideApproval(db, f.principal, approval.id, 'approve', 'Reviewed'),
    decideApproval(db, f.principal, approval.id, 'approve', 'Reviewed'),
  ]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(await db.note.count({ where: { organizationId: f.organizationId } }), 1);
  await f.step(provider(decision(null)));
  detail = await f.service.detail(run.id);
  assert.equal(detail.status, 'completed');
  const advisory = await fixture({ mode: 'ADVISORY' }),
    arun = await advisory.start();
  await advisory.step(
    provider(decision('create_task', { targetId: advisory.contact.id, title: 'Recommended only' })),
  );
  const adetail = await advisory.service.detail(arun.id);
  assert.equal(adetail.actions[0]!.status, 'recommended');
  assert.equal(adetail.actions[0]!.approval, null);
  assert.equal(await db.task.count({ where: { organizationId: advisory.organizationId } }), 0);
});
test('tenant and context isolation applies to API reads, tools, approvals and database relations', async () => {
  const a = await fixture(),
    b = await fixture();
  const run = await a.start();
  await a.step(
    provider(decision('create_task', { targetId: b.contact.id, title: 'Cross-tenant attempt' })),
  );
  const detail = await a.service.detail(run.id);
  assert.equal(detail.errorCode, 'tool_target_outside_context');
  assert.ok(detail.steps[0]!.decision);
  await assert.rejects(b.service.detail(run.id));
  await assert.rejects(
    a.service.start(a.agent.id, { subjectId: b.contact.id, idempotencyKey: 'wrong' }),
  );
  await assert.rejects(
    db.agentRun.create({
      data: {
        organizationId: a.organizationId,
        agentId: a.agent.id,
        versionId: a.version.id,
        subjectId: b.contact.id,
        triggerKey: 'sql-wrong',
        trigger: {},
        correlationId: randomUUID(),
        deadlineAt: new Date(),
      },
    }),
  );
  const good = await a.start();
  await a.step(
    provider(decision('add_note', { targetId: a.contact.id, text: 'Private approval' })),
  );
  const approval = (await a.service.detail(good.id)).actions[0]!.approval!;
  await assert.rejects(decideApproval(db, b.principal, approval.id, 'approve', 'Not my tenant'));
  assert.equal(
    await db.task.count({
      where: { organizationId: { in: [a.organizationId, b.organizationId] } },
    }),
    0,
  );
});
test('approval revalidates record state, suppression, agent version and credential revocation', async () => {
  for (const change of ['record', 'version', 'disabled', 'credential'] as const) {
    const f = await fixture(),
      run = await f.start();
    await f.step(provider(decision('add_note', { targetId: f.contact.id, text: 'Review me' })));
    const approval = (await f.service.detail(run.id)).actions[0]!.approval!;
    if (change === 'record')
      await f.crm.update('contacts', f.contact.id, {
        name: 'Changed',
        expectedVersion: f.contact.record.version,
      });
    if (change === 'version')
      await f.service.version(f.agent.id, { ...f.config, objective: 'A new objective' });
    if (change === 'disabled') await f.service.enable(f.agent.id, false);
    if (change === 'credential')
      await db.workforceCredential.update({
        where: { id: f.principal.credentialId },
        data: { revokedAt: new Date() },
      });
    if (change === 'credential')
      await assert.rejects(
        decideApproval(db, f.principal, approval.id, 'approve', 'Old credential'),
      );
    else
      assert.equal(
        (await decideApproval(db, f.principal, approval.id, 'approve', 'Reviewed')).executed,
        false,
      );
    assert.equal(await db.note.count({ where: { organizationId: f.organizationId } }), 0);
  }
});
test('duplicate triggers and duplicate actions cannot create duplicate task effects', async () => {
  const f = await fixture({ mode: 'AUTOPILOT' });
  const starts = await Promise.all([f.start('stable'), f.start('stable')]);
  assert.equal(starts[0].id, starts[1].id);
  const action = decision('create_task', { targetId: f.contact.id, title: 'Only once' });
  await f.step(provider(action));
  await f.step(provider(action));
  assert.equal((await f.service.detail(starts[0].id)).errorCode, 'duplicate_action');
  const other = await f.start('another');
  await f.step(provider(action));
  assert.equal((await f.service.detail(other.id)).errorCode, 'duplicate_action');
  assert.equal(await db.task.count({ where: { organizationId: f.organizationId } }), 1);
});
test('bounded loop stops repeated reads, action excess and malformed model output', async () => {
  const f = await fixture({ mode: 'AUTOPILOT', limits: { ...definition().limits, maxSteps: 2 } }),
    run = await f.start();
  for (let i = 0; i < 4; i++)
    await f.step(provider(decision('get_contact', { targetId: f.contact.id })));
  const detail = await f.service.detail(run.id);
  assert.equal(detail.stepCount, 2);
  assert.equal(detail.errorCode, 'run_limit');
  const g = await fixture({ mode: 'AUTOPILOT', limits: { ...definition().limits, maxActions: 1 } }),
    grun = await g.start();
  await g.step(provider(decision('create_task', { targetId: g.contact.id, title: 'First' })));
  await g.step(provider(decision('create_task', { targetId: g.contact.id, title: 'Second' })));
  assert.equal(await db.task.count({ where: { organizationId: g.organizationId } }), 1);
  assert.equal((await g.service.detail(grun.id)).errorCode, 'action_limit');
  const bad = await fixture(),
    badRun = await bad.start();
  await bad.step(provider({ tool: 'delete_everything', reasoning: 'private text' }));
  const failed = await bad.service.detail(badRun.id);
  assert.equal(failed.status, 'failed');
  assert.equal(JSON.stringify(failed).includes('private text'), false);
});
test('concurrent workers and expired leases retain a bounded attempt journal', async () => {
  const f = await fixture({ mode: 'AUTOPILOT' }),
    run = await f.start();
  let calls = 0;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    barrier = new Promise<void>((r) => (release = r));
  const first = f.step({
    async decide() {
      calls++;
      entered();
      await barrier;
      return decision('create_task', { targetId: f.contact.id, title: 'Concurrent claim' });
    },
  });
  await started;
  assert.equal(await f.step(provider(decision(null))), false);
  release();
  await first;
  assert.equal(calls, 1);
  await f.step(provider(decision(null)));
  assert.equal(await db.task.count({ where: { organizationId: f.organizationId } }), 1);
  const stale = await f.start();
  await db.agentRun.update({
    where: { id: stale.id },
    data: {
      status: 'running',
      stepCount: 1,
      leaseToken: randomUUID(),
      leasedUntil: new Date(Date.now() - 1000),
    },
  });
  await db.agentStep.create({
    data: {
      organizationId: f.organizationId,
      runId: stale.id,
      sequence: 1,
      context: {},
      provider: 'openai',
      model: 'test-model',
    },
  });
  await f.step(provider(decision(null)));
  const detail = await f.service.detail(stale.id);
  assert.equal(detail.steps[0]!.status, 'interrupted');
  assert.equal(detail.stepCount, 2);
  assert.equal(detail.status, 'completed');
  assert.equal((await f.service.detail(run.id)).status, 'completed');
});
test('canonical events start one run and agent-origin events do not recursively retrigger', async () => {
  const f = await fixture();
  const event = await db.businessEvent.findFirstOrThrow({
    where: { organizationId: f.organizationId, type: 'contact.created', entityId: f.contact.id },
  });
  await Promise.all([
    tenantTransaction(db, f.organizationId, (tx) =>
      eventRouter.dispatch(tx, f.organizationId, event.id),
    ),
    tenantTransaction(db, f.organizationId, (tx) =>
      eventRouter.dispatch(tx, f.organizationId, event.id),
    ),
  ]);
  assert.equal(
    await db.agentRun.count({ where: { organizationId: f.organizationId, eventId: event.id } }),
    1,
  );
  const g = await fixture({ mode: 'AUTOPILOT', triggers: ['task.created'] });
  const run = await g.start();
  await g.step(
    provider(decision('create_task', { targetId: g.contact.id, title: 'No recursive agents' })),
  );
  const generated = await db.businessEvent.findFirstOrThrow({
    where: { organizationId: g.organizationId, type: 'task.created' },
  });
  await tenantTransaction(db, g.organizationId, (tx) =>
    eventRouter.dispatch(tx, g.organizationId, generated.id),
  );
  assert.equal(await db.agentRun.count({ where: { organizationId: g.organizationId } }), 1);
  assert.equal((await g.service.detail(run.id)).actions.length, 1);
});
test('scheduled runs are durable, bounded, deduplicated and approval expiration is visible', async () => {
  const f = await fixture(),
    due = new Date(Date.now() + 60000);
  await f.service.schedule(f.agent.id, {
    subjectId: f.contact.id,
    nextRunAt: due.toISOString(),
    intervalMinutes: 15,
    remainingRuns: 2,
  });
  await Promise.all([
    scheduleAgents(db, due, f.organizationId),
    scheduleAgents(db, due, f.organizationId),
  ]);
  assert.equal(await db.agentRun.count({ where: { organizationId: f.organizationId } }), 1);
  const schedule = await db.agentSchedule.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  assert.equal(schedule.remainingRuns, 1);
  await f.service.cancelSchedule(schedule.id);
  await scheduleAgents(db, new Date(due.getTime() + 3600000), f.organizationId);
  assert.equal(await db.agentRun.count({ where: { organizationId: f.organizationId } }), 1);
  await f.step(provider(decision('add_note', { targetId: f.contact.id, text: 'Expires soon' })));
  const approval = await db.humanApproval.findFirstOrThrow({
    where: { organizationId: f.organizationId },
  });
  await scheduleAgents(db, new Date(approval.expiresAt.getTime() + 1), f.organizationId);
  assert.equal(
    (await db.humanApproval.findUniqueOrThrow({ where: { id: approval.id } })).status,
    'expired',
  );
  assert.equal(await db.note.count({ where: { organizationId: f.organizationId } }), 0);
});
test('external tools fail closed and suppressed contacts cannot schedule followups', async () => {
  const f = await fixture({ mode: 'AUTOPILOT' }),
    run = await f.start();
  await f.step(
    provider(
      decision('send_message', {
        targetId: f.contact.id,
        text: 'Should not send',
        channel: 'email',
      }),
    ),
  );
  assert.equal((await f.service.detail(run.id)).actions[0]!.status, 'blocked');
  assert.equal(await db.message.count({ where: { organizationId: f.organizationId } }), 0);
  await f.crm.update('contacts', f.contact.id, {
    doNotContact: true,
    expectedVersion: f.contact.record.version,
  });
  const suppressed = await f.start();
  await f.step(
    provider(
      decision('schedule_followup', {
        targetId: f.contact.id,
        dueAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    ),
  );
  assert.equal((await f.service.detail(suppressed.id)).errorCode, 'customer_suppressed');
  assert.equal(await db.agentSchedule.count({ where: { organizationId: f.organizationId } }), 0);
});
test('management HTTP requires active organization admin credentials and explicit scopes', async () => {
  const f = await fixture();
  assert.equal((await fetch(base)).status, 401);
  assert.equal(
    (
      await fetch(base, {
        headers: { authorization: `Bearer ${f.token}`, origin: 'https://untrusted.invalid' },
      })
    ).status,
    403,
  );
  const member = await db.organizationMember.create({
    data: { organizationId: f.organizationId, subject: randomUUID(), role: 'member' },
  });
  const key = await tenantTransaction(db, f.organizationId, (tx) =>
    issueCredential(tx, f.organizationId, { membershipId: member.id }, ['agents:write']),
  );
  assert.equal(
    (await fetch(base, { headers: { authorization: `Bearer ${key.token}` } })).status,
    403,
  );
  const response = await fetch(base, { headers: { authorization: `Bearer ${f.token}` } });
  assert.equal(response.status, 200);
  const body = (await response.json()) as unknown[];
  assert.equal(body.length, 1);
  const other = await fixture();
  assert.equal(
    (
      await fetch(`${base}/runs/${(await other.start()).id}`, {
        headers: { authorization: `Bearer ${f.token}` },
      })
    ).status,
    404,
  );
});
test('rechecking context after a model call prevents stale actions and stores a safe decision', async () => {
  const f = await fixture({ mode: 'AUTOPILOT' }),
    run = await f.start();
  await f.step({
    async decide() {
      await f.crm.update('contacts', f.contact.id, {
        name: 'Edited during model call',
        expectedVersion: f.contact.record.version,
      });
      return decision('create_task', { targetId: f.contact.id, title: 'Stale draft' });
    },
  });
  const detail = await f.service.detail(run.id);
  assert.equal(detail.errorCode, 'agent_context_changed');
  assert.ok(detail.steps[0]!.decision);
  assert.equal(await db.task.count({ where: { organizationId: f.organizationId } }), 0);
});
test('daily run limits and immutable tenant bindings apply before model calls', async () => {
  const f = await fixture({ limits: { ...definition().limits, maxRunsPerDay: 1 } });
  await f.start();
  await assert.rejects(
    f.start(),
    (e: unknown) => e instanceof WorkforceError && e.code === 'agent_daily_run_limit',
  );
  const other = await fixture();
  await assert.rejects(
    db.agentVersion.create({
      data: {
        organizationId: f.organizationId,
        agentId: other.agent.id,
        number: 7,
        definition: json(f.config),
        definitionHash: 'invalid',
        createdBy: 'test',
      },
    }),
  );
});
test('CRM tools reuse stage validation, immutable approval inputs and employee assignments', async () => {
  const f = await fixture({
    mode: 'AUTOPILOT',
    permissions: [
      ...definition().permissions,
      { tool: 'get_opportunity', automatic: true },
      { tool: 'get_estimate', automatic: true },
      { tool: 'get_conversation', automatic: true },
    ],
    limits: { ...definition().limits, maxSteps: 8, maxActions: 5 },
  });
  const pipeline = await f.crm.create('pipelines', { name: 'Service process' });
  const stage = await f.crm.create('stages', {
    name: 'New',
    pipelineId: pipeline.id,
    position: 0,
    outcome: 'open',
  });
  const next = await f.crm.create('stages', {
    name: 'Qualified',
    pipelineId: pipeline.id,
    position: 1,
    outcome: 'open',
  });
  const opportunity = await f.crm.create('opportunities', {
    title: 'Service request',
    customerId: f.contact.id,
    pipelineId: pipeline.id,
    stageId: stage.id,
    amountMinor: 1000,
    currency: 'USD',
  });
  const estimate = await f.crm.create('estimates', {
    title: 'Scope',
    number: 'E-1',
    opportunityId: opportunity.id,
    amountMinor: 1000,
    currency: 'USD',
  });
  const conversation = await f.crm.create('conversations', {
    contactId: f.contact.id,
    subject: 'Request',
    channel: 'email',
  });
  const member = await db.organizationMember.findFirstOrThrow({
    where: { organizationId: f.organizationId, active: true },
  });
  const run = await f.start();
  for (const [tool, targetId] of [
    ['get_opportunity', opportunity.id],
    ['get_estimate', estimate.id],
    ['get_conversation', conversation.id],
  ] as const)
    await f.step(provider(decision(tool, { targetId })));
  await f.step(
    provider(decision('update_opportunity', { targetId: opportunity.id, stageId: next.id })),
  );
  const detail = await f.service.detail(run.id);
  assert.equal(detail.status, 'waiting_approval');
  assert.equal(
    (await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).stageId,
    stage.id,
  );
  assert.equal(
    (
      await decideApproval(
        db,
        f.principal,
        detail.actions[0]!.approval!.id,
        'approve',
        'Stage reviewed',
      )
    ).executed,
    true,
  );
  assert.equal(
    (await db.opportunity.findUniqueOrThrow({ where: { id: opportunity.id } })).stageId,
    next.id,
  );
  await f.step(
    provider(
      decision('notify_employee', {
        targetId: f.contact.id,
        title: 'Review this request',
        memberId: member.id,
      }),
    ),
  );
  const task = await db.task.findFirstOrThrow({
    where: { organizationId: f.organizationId },
    include: { record: true },
  });
  assert.equal(task.record.assignedMemberId, member.id);
  await f.step(
    provider(
      decision('schedule_followup', {
        targetId: f.contact.id,
        dueAt: new Date(Date.now() + 3600000).toISOString(),
      }),
    ),
  );
  assert.equal(
    await db.agentSchedule.count({ where: { organizationId: f.organizationId, enabled: true } }),
    1,
  );
  await f.step(provider(decision('stop_agent_run', { text: 'Stop after these bounded steps.' })));
  assert.equal((await f.service.detail(run.id)).status, 'stopped');
  assert.equal(
    await db.businessEvent.count({
      where: { organizationId: f.organizationId, type: 'agent.action_completed' },
    }),
    3,
  );
});
test('manual escalation requires approval, while timeouts and pauses cannot execute tools', async () => {
  const f = await fixture({ mode: 'AUTOPILOT' }),
    run = await f.start();
  await f.step(
    provider(decision('request_human_approval', { text: 'Please review this unusual case.' })),
  );
  const detail = await f.service.detail(run.id);
  assert.equal(detail.status, 'waiting_approval');
  assert.ok(detail.actions[0]!.approval);
  await decideApproval(
    db,
    f.principal,
    detail.actions[0]!.approval.id,
    'reject',
    'Escalate to the team instead',
  );
  assert.equal((await f.service.detail(run.id)).status, 'stopped');
  const paused = await f.start();
  assert.equal(await runOnce(db, undefined, f.organizationId), false);
  assert.equal((await f.service.detail(paused.id)).stepCount, 0);
  await db.agentRun.update({
    where: { id: paused.id },
    data: { deadlineAt: new Date(Date.now() - 1000) },
  });
  let calls = 0;
  await f.step({
    decide() {
      calls++;
      return Promise.resolve(decision(null));
    },
  });
  assert.equal(calls, 0);
  assert.equal((await f.service.detail(paused.id)).errorCode, 'run_limit');
});
test('administrator stop fences an in-flight model result without applying its action', async () => {
  const f = await fixture({ mode: 'AUTOPILOT' }),
    run = await f.start();
  await f.step({
    async decide() {
      await f.service.stop(run.id);
      return decision('create_task', {
        targetId: f.contact.id,
        title: 'Must not execute after stop',
      });
    },
  });
  const detail = await f.service.detail(run.id);
  assert.equal(detail.status, 'stopped');
  assert.equal(detail.steps[0]!.errorCode, 'run_stopped_by_admin');
  assert.equal(await db.task.count({ where: { organizationId: f.organizationId } }), 0);
});
test('invoice observations use an existing scoped subject and give the model a bounded trigger', async () => {
  const f = await fixture({ triggers: ['invoice.overdue'], mode: 'ADVISORY' });
  const connection = await db.externalConnection.create({
    data: { organizationId: f.organizationId, name: 'Generic accounting', provider: 'generic' },
  });
  const published = await new EventPublisher(db).publish(
    {
      organizationId: f.organizationId,
      system: 'generic_webhook',
      provider: 'generic',
      actor: `integration:${connection.id}`,
      connectionId: connection.id,
    },
    {
      version: 2,
      type: 'invoice.overdue',
      entity: { type: 'invoice', id: null },
      externalEntity: { type: 'invoice', id: 'invoice-1' },
      relatedRecordIds: [f.contact.id],
      occurredAt: new Date().toISOString(),
      idempotencyKey: 'overdue-1',
      data: {
        amountMinor: 1000,
        currency: 'USD',
        dueAt: new Date(Date.now() - 86400000).toISOString(),
      },
    },
  );
  await tenantTransaction(db, f.organizationId, (tx) =>
    eventRouter.dispatch(tx, f.organizationId, published.event.id),
  );
  const run = await db.agentRun.findFirstOrThrow({ where: { organizationId: f.organizationId } });
  assert.equal(run.subjectId, f.contact.id);
  await f.step({
    decide(request) {
      assert.equal(JSON.stringify(request.trigger).includes('invoice.overdue'), true);
      assert.equal(JSON.stringify(request.trigger).includes('amountMinor'), true);
      return Promise.resolve(decision(null));
    },
  });
  assert.equal((await f.service.detail(run.id)).status, 'completed');
  assert.equal(await db.workforceRevenue.count({ where: { organizationId: f.organizationId } }), 0);
});
