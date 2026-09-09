/* eslint-disable @typescript-eslint/no-floating-promises -- node:test registration. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { Server } from 'node:http';
import type { PrismaClient, AgentBlueprintVersion } from '@prisma/client';
import { requireDemoTestDatabase } from '../demo-engine/test-database.js';
import { authenticate, provisionOrganization } from '../workforce/tenancy/service.js';
import { WorkforceError, object, hash, json } from '../workforce/shared.js';
import { AgentService } from '../agents/service.js';
import { BlueprintService } from './service.js';
import type { BlueprintExtractor } from './extractor.js';
import { parseBlueprint } from './blueprint.js';
import { compile } from './compiler.js';
import { exampleBlueprint, readyBlueprint, sourceRequest } from './test-fixtures.js';

requireDemoTestDatabase();
Object.assign(process.env, {
  WORKFORCE_ENABLED: 'true',
  AGENT_RUNTIME_ENABLED: 'true',
  AGENT_BUILDER_ENABLED: 'true',
  WORKFORCE_WORKER_ENABLED: 'false',
  AGENT_MODEL_ENABLED: 'false',
  AGENT_BUILDER_AI_ENABLED: 'false',
  WEBHOOK_DELIVERY_ENABLED: 'false',
  AGENT_ALLOWED_MODELS: 'test-model',
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
const fails = (code: string) => (e: unknown) => e instanceof WorkforceError && e.code === code;
const extractor = (extract: BlueprintExtractor['extract']): BlueprintExtractor => ({
  provider: 'test',
  model: 'test-model',
  extract,
});
async function fixture(mock?: BlueprintExtractor) {
  const org = await provisionOrganization(
    db,
    {
      name: 'Builder fixture',
      ownerSubject: `builder-test:${randomUUID()}`,
    },
    'test',
  );
  const principal = await authenticate(db, `Bearer ${org.token}`);
  return {
    organizationId: org.organization.id,
    token: org.token,
    principal,
    service: new BlueprintService(db, principal, mock),
  };
}
const review = (v: AgentBlueprintVersion, expectedAgentVersion = 0) => ({
  expectedVersion: v.number,
  specificationHash: v.specificationHash,
  expectedAgentVersion,
  reviewed: true,
});
const scenario = { entityType: 'contact', status: 'active', inactiveDays: 0, suppressed: false };
async function noExecution(organizationId: string) {
  for (const count of await Promise.all([
    db.agentRun.count({ where: { organizationId } }),
    db.agentAction.count({ where: { organizationId } }),
    db.task.count({ where: { organizationId } }),
    db.message.count({ where: { organizationId } }),
  ]))
    assert.equal(count, 0);
}

test('generation preserves the request, strips model-granted authority, and never starts work', async () => {
  let calls = 0;
  const proposed = exampleBlueprint();
  proposed.automaticActions = ['send_message'];
  proposed.runtimeModel = 'test-model';
  proposed.knowledgeRequirements = [{ name: 'Policy', content: 'Made up', approved: true }];
  const f = await fixture(
    extractor(() => {
      calls++;
      return Promise.resolve(proposed);
    }),
  );
  const input = { description: sourceRequest, requestKey: randomUUID() };
  const v = await f.service.generate(input),
    b = parseBlueprint(v.specification);
  assert.equal(v.sourceText, sourceRequest);
  assert.equal(b.delayMinutes, 2880);
  assert.equal(b.triggerConditions.find((c) => c.field === 'amount_minor')?.number, 250000);
  assert.deepEqual(b.automaticActions, []);
  assert.equal(b.runtimeModel, null);
  assert.equal(b.knowledgeRequirements[0]?.approved, false);
  assert.equal((await f.service.generate(input)).id, v.id);
  assert.equal(calls, 1);
  await assert.rejects(
    f.service.generate({ ...input, description: 'Different' }),
    fails('generation_idempotency_conflict'),
  );
  await assert.rejects(
    f.service.activate(v.blueprintId, review(v)),
    fails('blueprint_requirements_unresolved'),
  );
  assert.equal(await db.workforceAgent.count({ where: { organizationId: f.organizationId } }), 0);
  await noExecution(f.organizationId);
});

test('concurrent generation reserves once and stale generated revisions cannot overwrite edits', async () => {
  let release!: (value: unknown) => void,
    entered!: () => void,
    calls = 0;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<unknown>((resolve) => {
    release = resolve;
  });
  const f = await fixture(
    extractor(() => {
      calls++;
      entered();
      return pending;
    }),
  );
  const first = await f.service.save({ specification: readyBlueprint() });
  const input = {
    description: 'Changed request',
    requestKey: randomUUID(),
    blueprintId: first.blueprintId,
    expectedVersion: 1,
  };
  const generation = f.service.generate(input);
  await started;
  await assert.rejects(f.service.generate(input), fails('generation_in_progress'));
  await f.service.save({ specification: readyBlueprint(), expectedVersion: 1 }, first.blueprintId);
  release(readyBlueprint());
  await assert.rejects(generation, fails('blueprint_version_conflict'));
  assert.equal(calls, 1);
  assert.equal((await f.service.detail(first.blueprintId)).history.length, 2);
  assert.equal(
    (
      await db.agentBlueprintGeneration.findFirstOrThrow({
        where: { organizationId: f.organizationId },
      })
    ).status,
    'failed',
  );
});

test('revocation during a model call blocks persistence and records a redacted terminal failure', async () => {
  let release!: (value: unknown) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const f = await fixture(
    extractor(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    }),
  );
  const pending = f.service.generate({ description: 'Review contacts', requestKey: randomUUID() });
  await started;
  await db.workforceCredential.update({
    where: { id: f.principal.credentialId },
    data: { revokedAt: new Date() },
  });
  release(readyBlueprint());
  await assert.rejects(pending);
  assert.equal(await db.agentBlueprint.count({ where: { organizationId: f.organizationId } }), 0);
  assert.equal(
    (
      await db.agentBlueprintGeneration.findFirstOrThrow({
        where: { organizationId: f.organizationId },
      })
    ).status,
    'failed',
  );
});

test('failed and abandoned generations are terminal and paid attempts have an organization budget', async () => {
  const f = await fixture(extractor(() => Promise.reject(new Error('Secret provider error'))));
  const input = { description: 'Review contacts', requestKey: randomUUID() };
  await assert.rejects(f.service.generate(input), fails('blueprint_generation_failed'));
  await assert.rejects(f.service.generate(input), fails('generation_failed_start_new_request'));
  const abandoned = { description: 'Abandoned', requestKey: randomUUID() };
  await db.agentBlueprintGeneration.create({
    data: {
      organizationId: f.organizationId,
      requestKey: abandoned.requestKey,
      requestHash: hash({
        description: abandoned.description,
        id: undefined,
        expectedVersion: undefined,
      }),
      createdAt: new Date(Date.now() - 120000),
    },
  });
  await assert.rejects(f.service.generate(abandoned), fails('generation_failed_start_new_request'));
  assert.equal(
    (
      await db.agentBlueprintGeneration.findFirstOrThrow({
        where: { organizationId: f.organizationId, requestKey: abandoned.requestKey },
      })
    ).errorCode,
    'generation_abandoned',
  );
  await db.agentBlueprintGeneration.createMany({
    data: Array.from({ length: 18 }, () => ({
      organizationId: f.organizationId,
      requestKey: randomUUID(),
      requestHash: 'fixture',
      status: 'failed',
    })),
  });
  await assert.rejects(
    f.service.generate({ description: 'Next', requestKey: randomUUID() }),
    fails('blueprint_generation_daily_limit'),
  );
  assert.equal(
    JSON.stringify(
      await db.agentBlueprintGeneration.findMany({ where: { organizationId: f.organizationId } }),
    ).includes('Secret provider'),
    false,
  );
});

test('all reads and writes are tenant scoped, including version history and database relationships', async () => {
  const a = await fixture(),
    b = await fixture();
  const v = await a.service.save({ specification: readyBlueprint() });
  assert.deepEqual(await b.service.list(), []);
  await assert.rejects(b.service.detail(v.blueprintId), fails('blueprint_not_found'));
  await assert.rejects(b.service.detail(v.blueprintId, 1), fails('blueprint_not_found'));
  await assert.rejects(
    b.service.save({ specification: readyBlueprint(), expectedVersion: 1 }, v.blueprintId),
    fails('blueprint_not_found'),
  );
  await assert.rejects(
    b.service.test(v.blueprintId, { expectedVersion: 1, scenario }),
    fails('blueprint_not_found'),
  );
  await assert.rejects(b.service.activate(v.blueprintId, review(v)), fails('blueprint_not_found'));
  await assert.rejects(
    b.service.generate({
      blueprintId: v.blueprintId,
      expectedVersion: 1,
      description: 'Read contacts',
      requestKey: randomUUID(),
    }),
    fails('blueprint_not_found'),
  );
  await assert.rejects(
    db.agentBlueprintVersion.create({
      data: {
        organizationId: b.organizationId,
        blueprintId: v.blueprintId,
        number: 2,
        specification: json(readyBlueprint()),
        specificationHash: 'fixture',
        origin: 'manual',
        createdBy: 'test',
      },
    }),
  );
});

test('current membership and credential permissions, not cached principal claims, govern drafts', async () => {
  const f = await fixture();
  await db.organizationMember.updateMany({
    where: { organizationId: f.organizationId },
    data: { role: 'viewer' },
  });
  await assert.rejects(
    f.service.save({ specification: readyBlueprint() }),
    fails('credential_changed'),
  );
  await assert.rejects(f.service.list(), fails('credential_changed'));
});

test('review and matching saved test are required; activation uses existing runtime projections once', async () => {
  const f = await fixture(),
    spec = readyBlueprint();
  const v = await f.service.save({ specification: spec });
  assert.throws(
    () => f.service.activate(v.blueprintId, { ...review(v), reviewed: false }),
    fails('blueprint_review_required'),
  );
  await assert.rejects(
    f.service.activate(v.blueprintId, review(v)),
    fails('blueprint_test_required'),
  );
  await assert.rejects(
    f.service.activate(v.blueprintId, { ...review(v), specificationHash: 'changed' }),
    fails('blueprint_version_conflict'),
  );
  const tested = await f.service.test(v.blueprintId, { expectedVersion: 1, scenario });
  assert.equal(object(tested.report).sideEffects, false);
  await noExecution(f.organizationId);
  const [a, b] = await Promise.all([
    f.service.activate(v.blueprintId, review(v)),
    f.service.activate(v.blueprintId, review(v)),
  ]);
  assert.equal(a.agentId, b.agentId);
  assert.notEqual(a.duplicate, b.duplicate);
  const agent = await db.workforceAgent.findUniqueOrThrow({ where: { id: a.agentId! } });
  assert.equal(agent.enabled, true);
  assert.equal(agent.kind, 'universal');
  assert.equal(agent.configVersion, 1);
  const version = await db.agentVersion.findUniqueOrThrow({ where: { id: a.runtimeVersionId! } });
  assert.deepEqual(version.definition, compile(spec).definition);
  assert.equal(await db.agentPolicy.count({ where: { organizationId: f.organizationId } }), 1);
  assert.equal(await db.agentGoal.count({ where: { organizationId: f.organizationId } }), 1);
  await noExecution(f.organizationId);
});

test('draft revisions preserve active behavior and require a new exact-version test and review', async () => {
  const f = await fixture(),
    spec = readyBlueprint();
  const v = await f.service.save({ specification: spec });
  await f.service.test(v.blueprintId, { expectedVersion: 1, scenario });
  const active = await f.service.activate(v.blueprintId, review(v));
  const v2 = await f.service.save(
    { specification: { ...spec, objective: 'Review intake tasks.' }, expectedVersion: 1 },
    v.blueprintId,
  );
  const state = await f.service.detail(v.blueprintId);
  assert.equal(state.blueprint.agent?.enabled, true);
  assert.equal(state.blueprint.agent?.configVersion, 1);
  assert.deepEqual(state.history[0]?.changedFields, ['objective']);
  assert.deepEqual((await f.service.detail(v.blueprintId, 1)).specification, spec);
  await assert.rejects(
    f.service.activate(v.blueprintId, review(v)),
    fails('blueprint_version_conflict'),
  );
  await assert.rejects(
    f.service.test(v.blueprintId, { expectedVersion: 1, scenario }),
    fails('blueprint_version_conflict'),
  );
  await assert.rejects(
    f.service.activate(v.blueprintId, review(v2, 1)),
    fails('blueprint_test_required'),
  );
  await f.service.test(v.blueprintId, { expectedVersion: 2, scenario });
  const next = await f.service.activate(v.blueprintId, review(v2, 1));
  assert.equal(next.agentId, active.agentId);
  assert.equal((await f.service.detail(v.blueprintId)).blueprint.agent?.configVersion, 2);
});

test('runtime edits and changed operator model allowlist invalidate stale activation', async () => {
  const f = await fixture(),
    v = await f.service.save({ specification: readyBlueprint() });
  await f.service.test(v.blueprintId, { expectedVersion: 1, scenario });
  const active = await f.service.activate(v.blueprintId, review(v));
  const v2 = await f.service.save(
    { specification: readyBlueprint(), expectedVersion: 1 },
    v.blueprintId,
  );
  await f.service.test(v.blueprintId, { expectedVersion: 2, scenario });
  await new AgentService(db, f.principal).version(
    active.agentId!,
    compile(readyBlueprint()).definition!,
  );
  await assert.rejects(
    f.service.activate(v.blueprintId, review(v2, 1)),
    fails('runtime_version_conflict'),
  );
  process.env.AGENT_ALLOWED_MODELS = '';
  try {
    await assert.rejects(
      f.service.activate(v.blueprintId, review(v2, 2)),
      fails('blueprint_requirements_unresolved'),
    );
  } finally {
    process.env.AGENT_ALLOWED_MODELS = 'test-model';
  }
});

test('HTTP API enforces authentication, JSON, origin, scope, and default-off model generation', async () => {
  const f = await fixture(),
    url = `${base}/api/agent-blueprints`;
  assert.equal((await fetch(url)).status, 401);
  const headers = { authorization: `Bearer ${f.token}`, 'content-type': 'application/json' };
  assert.equal(
    (await fetch(url, { headers: { ...headers, origin: 'https://attacker.invalid' } })).status,
    403,
  );
  assert.equal(
    (
      await fetch(url, {
        method: 'POST',
        headers: { authorization: headers.authorization },
        body: 'bad',
      })
    ).status,
    415,
  );
  assert.equal(
    (
      await fetch(`${url}/generate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ description: 'Review contacts', requestKey: randomUUID() }),
      })
    ).status,
    503,
  );
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ specification: readyBlueprint() }),
  });
  assert.equal(response.status, 201);
  const v = object(await response.json());
  assert.equal((await fetch(`${url}/${String(v.blueprintId)}`, { headers })).status, 200);
});

test('member UI escapes source text and requires action-bound CSRF for draft creation', async () => {
  const f = await fixture(),
    headers = {
      authorization: `Basic ${Buffer.from(`organization:${f.token}`).toString('base64')}`,
    };
  const page = await fetch(`${base}/agent-builder`, { headers });
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  const html = await page.text();
  const csrf = html.match(
    /action="\/agent-builder\/draft"><input type="hidden" name="csrf" value="([^"]+)"/,
  )?.[1];
  assert.ok(csrf);
  assert.equal(
    (
      await fetch(`${base}/agent-builder/draft`, {
        method: 'POST',
        headers,
        body: new URLSearchParams(),
      })
    ).status,
    403,
  );
  const saved = await fetch(`${base}/agent-builder/draft`, {
    method: 'POST',
    headers,
    body: new URLSearchParams({ csrf }),
    redirect: 'manual',
  });
  assert.equal(saved.status, 303);
  const path = saved.headers.get('location');
  assert.ok(path);
  const draft = await fetch(`${base}${path}`, { headers });
  assert.match(await draft.text(), /Save Draft/);
  const mock = new BlueprintService(
    db,
    f.principal,
    extractor(() => Promise.resolve(exampleBlueprint())),
  );
  const generated = await mock.generate({
    description: '<script>alert("unsafe")</script>',
    requestKey: randomUUID(),
  });
  const detail = await fetch(`${base}/agent-builder/${generated.blueprintId}`, { headers });
  const escaped = await detail.text();
  assert.equal(escaped.includes('<script>alert('), false);
  assert.equal(escaped.includes('&lt;script&gt;'), true);
});

test('HTML Save Draft, Test Agent and reviewed activation complete the versioned workflow', async () => {
  const f = await fixture(),
    v = await f.service.save({ specification: readyBlueprint() });
  const path = `/agent-builder/${v.blueprintId}`;
  const headers = {
    authorization: `Basic ${Buffer.from(`organization:${f.token}`).toString('base64')}`,
  };
  async function submit(action: string, fields: URLSearchParams) {
    const html = await (await fetch(`${base}${path}`, { headers })).text();
    const form = html.split(`action="${path}/${action}">`)[1];
    assert.ok(form);
    const token = form.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(token);
    fields.set('csrf', token);
    return fetch(`${base}${path}/${action}`, {
      method: 'POST',
      headers,
      body: fields,
      redirect: 'manual',
    });
  }
  const fields = new URLSearchParams({
    expectedVersion: '1',
    name: 'Edited intake helper',
    objective: 'Create a staff task.',
    businessContext: 'Internal service CRM.',
    communicationStyle: 'Brief and factual.',
    eligibleEntityTypes: 'contact',
    triggerEvent: 'contact.created',
    delayMinutes: '0',
    cadenceEnabled: 'false',
    maximumAttempts: '1',
    goalKind: 'task_created',
    goalDescription: 'A committed staff task.',
    stopConditions: 'action_limit',
    timezone: 'UTC',
    startHour: '0',
    endHour: '24',
    mode: 'COPILOT',
    humanApprovalMode: 'all_mutations',
    runtimeModel: 'test-model',
  });
  for (const day of ['0', '1', '2', '3', '4', '5', '6']) fields.append('days', day);
  for (const action of ['get_contact', 'create_task', 'stop_agent_run'])
    fields.append('allowedActions', action);
  assert.equal((await submit('save', fields)).status, 303);
  const state = await f.service.detail(v.blueprintId);
  assert.equal(state.version.number, 2);
  assert.equal(state.specification.name, 'Edited intake helper');
  assert.equal(state.compilation.requirements.length, 0);
  assert.equal(
    (
      await submit(
        'test',
        new URLSearchParams({
          expectedVersion: '2',
          entityType: 'contact',
          status: 'active',
          inactiveDays: '0',
        }),
      )
    ).status,
    303,
  );
  const approval = new URLSearchParams({
    expectedVersion: '2',
    specificationHash: state.version.specificationHash,
    expectedAgentVersion: '0',
  });
  assert.equal((await submit('activate', approval)).status, 400);
  approval.set('reviewed', 'true');
  assert.equal((await submit('activate', approval)).status, 303);
  assert.equal((await f.service.detail(v.blueprintId)).blueprint.agent?.enabled, true);
  await noExecution(f.organizationId);
});
